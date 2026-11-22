import { asArray, compareText, fen, stableStringify, digest } from './util.mjs';
import { allocate, normalisePacks, sharesAt } from './source.mjs';

export const HARD_FLAGS = new Set([
  'pack-ambiguous',
  'award-conflict',
  'award-reach-mismatch',
  'replacement-invalid',
  'replacement-overlap',
  'line-not-on-invoice',
  'acceptance-exceeds-face',
  'shares-conflict',
  'objection-filed',
]);

function lineKey(invoice, line) {
  return String(invoice) + '#' + String(line);
}

function addFlag(flags, code, detail) {
  if (!flags.some(flag => flag.code === code)) flags.push({ code, ...detail });
}

function activeAwards(awards) {
  const replaced = new Set();
  for (const award of awards) {
    if (award && award.replaces != null) replaced.add(String(award.replaces));
  }
  return awards.filter(award => award && !replaced.has(String(award.id)));
}

/**
 * Turns the four source payloads into one line-by-line ledger.
 *
 * A line's money is: accepted by the town (minus any withdrawn part of that
 * acceptance line), minus money a later replacement invoice explicitly says it
 * includes, minus the insurer's actual payment (coverage less deductible).
 * What remains is split by the shares effective on the repair date.
 */
export function buildLines({ snapshot, registry, voids, quotes }) {
  const packs = normalisePacks(snapshot?.packs);
  const packByKey = new Map(packs.map(pack => [pack.key, pack]));
  const updates = asArray(snapshot?.updates);
  const events = asArray(snapshot?.events);
  const replacements = asArray(snapshot?.replacement);
  const objections = asArray(snapshot?.objections);
  const awards = asArray(snapshot?.awards);
  const active = activeAwards(awards);
  const voidMap = voids ?? {};
  const quoteMap = quotes ?? {};
  const invoiceRows = registry ?? {};

  const withdrawnBy = new Map();
  const unappliedWithdrawals = [];
  for (const withdrawal of asArray(snapshot?.withdrawn)) {
    const line = fen(withdrawal?.line);
    const amount = fen(withdrawal?.fen);
    if (!withdrawal || withdrawal.acceptance == null || line == null || amount == null || amount < 0) {
      unappliedWithdrawals.push({ ref: withdrawal?.acceptance ?? null, line: withdrawal?.line ?? null,
        reason: 'malformed-withdrawal' });
      continue;
    }
    const key = String(withdrawal.acceptance) + '#' + line;
    withdrawnBy.set(key, (withdrawnBy.get(key) ?? 0) + amount);
  }

  const contributions = new Map();
  const orphans = [];
  const withdrawalApplied = new Set();
  const acceptanceLines = new Set();
  for (const event of events) {
    const rows = asArray(event?.accepted);
    if (!event || event.id == null || event.invoice == null) {
      orphans.push({ kind: 'acceptance', ref: event?.id ?? null, reason: 'malformed-acceptance' });
      continue;
    }
    for (const row of rows) {
      const line = fen(row?.line);
      const amount = fen(row?.fen);
      if (line == null || amount == null || amount < 0) {
        orphans.push({ kind: 'acceptance', ref: event.id, reason: 'malformed-line', line: row?.line });
        continue;
      }
      acceptanceLines.add(String(event.id) + '#' + line);
      const taken = withdrawnBy.get(String(event.id) + '#' + line) ?? 0;
      if (taken > 0) withdrawalApplied.add(String(event.id) + '#' + line);
      const key = lineKey(event.invoice, line);
      if (!contributions.has(key)) contributions.set(key, []);
      contributions.get(key).push({
        acceptance: event.id,
        pack: event.pack,
        invoice: event.invoice,
        line,
        acceptedFen: amount,
        withdrawnFen: Math.min(taken, amount),
        netFen: Math.max(0, amount - taken),
      });
    }
  }
  for (const [ref, amount] of withdrawnBy) {
    if (!withdrawalApplied.has(ref)) {
      const at = ref.lastIndexOf('#');
      unappliedWithdrawals.push({
        ref: ref.slice(0, at), line: Number(ref.slice(at + 1)), fen: amount,
        reason: 'withdrawal-without-acceptance-line',
      });
    }
  }

  // Objections are raised by a party against a concrete invoice line or a
  // whole acceptance. They do not change amounts; they hold the line from
  // confirmation until responsibility is settled.
  const objectionsByLine = new Map();
  const unappliedObjections = [];
  for (const objection of objections) {
    if (!objection || objection.invoice == null) continue;
    const line = fen(objection.line);
    const key = line == null ? null : lineKey(objection.invoice, line);
    if (key == null && objection.acceptance == null) {
      unappliedObjections.push({ id: objection.id ?? null, reason: 'objection-without-target' });
      continue;
    }
    if (key == null && ![...acceptanceLines].some(entry => entry.startsWith(String(objection.acceptance) + '#'))) {
      unappliedObjections.push({ id: objection.id ?? null, reason: 'objection-without-acceptance' });
      continue;
    }
    const record = {
      id: objection.id ?? null,
      invoice: objection.invoice ?? null,
      line,
      acceptance: objection.acceptance ?? null,
      by: objection.by ?? objection.village ?? null,
      fen: fen(objection.fen),
      reason: objection.reason ?? null,
    };
    const target = key ?? String(objection.acceptance) + '#*';
    if (!objectionsByLine.has(target)) objectionsByLine.set(target, []);
    objectionsByLine.get(target).push(record);
  }

  const replacementByOld = new Map();
  const hints = new Map();
  const seenReplacements = new Set();
  const duplicateReplacements = [];
  for (const replacement of replacements) {
    if (!replacement) continue;
    const oldLine = fen(replacement.includesLine);
    const newLine = fen(replacement.line);
    const amount = fen(replacement.includesFen);
    if (replacement.includesInvoice == null || oldLine == null || replacement.invoice == null || newLine == null || amount == null || amount < 0) {
      orphans.push({ kind: 'replacement', ref: replacement.invoice ?? null, reason: 'malformed-replacement' });
      continue;
    }
    const fingerprint = [replacement.invoice, newLine, replacement.includesInvoice, oldLine, amount].join('|');
    if (seenReplacements.has(fingerprint)) {
      duplicateReplacements.push({
        invoice: replacement.invoice,
        line: newLine,
        includesInvoice: replacement.includesInvoice,
        includesLine: oldLine,
        includesFen: amount,
      });
      continue;
    }
    seenReplacements.add(fingerprint);
    const targetNew = invoiceRows[replacement.invoice]?.lines?.find(row => Number(row.no) === newLine);
    const targetOld = invoiceRows[replacement.includesInvoice]?.lines?.find(row => Number(row.no) === oldLine);
    const record = {
      invoice: replacement.invoice,
      line: newLine,
      includesInvoice: replacement.includesInvoice,
      includesLine: oldLine,
      includesFen: amount,
      pack: replacement.pack ?? null,
      // A line may not claim to include itself.
      valid: Boolean(targetNew && targetOld)
        && !(String(replacement.invoice) === String(replacement.includesInvoice) && newLine === oldLine),
    };
    const key = lineKey(replacement.includesInvoice, oldLine);
    if (!replacementByOld.has(key)) replacementByOld.set(key, []);
    replacementByOld.get(key).push(record);
    if (replacement.pack) hints.set(lineKey(replacement.invoice, newLine), replacement.pack);
  }
  for (const [key, list] of replacementByOld) {
    for (const record of list) {
      if (!record.valid) {
        orphans.push({
          kind: 'replacement',
          ref: record.invoice + '#' + record.line,
          reason: 'replacement-line-unknown',
          includesInvoice: record.includesInvoice,
          includesLine: record.includesLine,
        });
      }
    }
  }

  const keys = new Set();
  for (const [id, row] of Object.entries(invoiceRows)) {
    if (!row || row.kind !== 'invoice') continue;
    for (const line of asArray(row.lines)) {
      if (fen(line?.no) != null) keys.add(lineKey(id, line.no));
    }
  }
  for (const key of contributions.keys()) keys.add(key);
  for (const key of hints.keys()) keys.add(key);
  for (const key of replacementByOld.keys()) keys.add(key);

  const lines = [];
  for (const key of [...keys].sort()) {
    const at = key.lastIndexOf('#');
    const invoice = key.slice(0, at);
    const lineNo = Number(key.slice(at + 1));
    const row = invoiceRows[invoice];
    const faceRow = asArray(row?.lines).find(entry => Number(entry.no) === lineNo);
    const faceFen = faceRow ? (fen(faceRow.fen) ?? 0) : null;
    const list = contributions.get(key) ?? [];
    const flags = [];
    if (row != null && faceFen == null) {
      addFlag(flags, 'line-not-on-invoice', { invoice, line: lineNo });
    }
    let netAcceptedFen = list.reduce((sum, entry) => sum + entry.netFen, 0);
    if (faceFen != null && netAcceptedFen > faceFen) {
      addFlag(flags, 'acceptance-exceeds-face', { acceptedFen: netAcceptedFen, faceFen });
      netAcceptedFen = faceFen;
    }

    const contributorPacks = [...new Set(list.map(entry => entry.pack).filter(Boolean))];
    let packKey = contributorPacks.length === 1 ? contributorPacks[0] : null;
    if (contributorPacks.length > 1) {
      addFlag(flags, 'pack-ambiguous', { packs: contributorPacks.sort(compareText) });
    } else if (contributorPacks.length === 0 && hints.has(key)) {
      packKey = hints.get(key);
    }
    const pack = packKey ? packByKey.get(packKey) : null;
    if (packKey && !pack) {
      addFlag(flags, 'pack-unknown', { pack: packKey });
    }

    const replacementRecords = replacementByOld.get(key) ?? [];
    const validReplacements = replacementRecords.filter(record => record.valid);
    const invalidReplacements = replacementRecords.filter(record => !record.valid);
    if (invalidReplacements.length) {
      addFlag(flags, 'replacement-invalid', {
        records: invalidReplacements.map(record => record.invoice + '#' + record.line),
      });
    }
    // Two different later lines may not both claim to include the same old
    // line: that would net the same expense twice.
    const targets = [...new Set(validReplacements.map(record => lineKey(record.invoice, record.line)))];
    if (targets.length > 1) {
      addFlag(flags, 'replacement-overlap', { targets: targets.sort(compareText) });
    }
    const replacementOffsetFen = Math.min(
      netAcceptedFen,
      validReplacements.reduce((sum, record) => sum + record.includesFen, 0),
    );
    const poolFen = Math.max(0, netAcceptedFen - replacementOffsetFen);

    const lineAwards = active.filter(award =>
      award && award.invoice === invoice && fen(award.line) === lineNo);
    let insuranceFen = 0;
    let award = null;
    if (lineAwards.length > 1) {
      addFlag(flags, 'award-conflict', { awards: lineAwards.map(entry => entry.id) });
    } else if (lineAwards.length === 1) {
      const candidate = lineAwards[0];
      const covered = Math.max(0, fen(candidate.coveredBeforeDeductibleFen) ?? 0);
      const deductible = Math.max(0, fen(candidate.deductibleFen) ?? 0);
      if (pack && candidate.reach != null && candidate.reach !== pack.reach) {
        addFlag(flags, 'award-reach-mismatch', {
          award: candidate.id,
          awardReach: candidate.reach,
          packReach: pack.reach,
        });
      } else {
        award = candidate;
        // Insurance pays coverage less deductible, never below zero and never
        // above the amount still claimable after any replacement offset.
        insuranceFen = Math.min(Math.max(0, covered - deductible), poolFen);
      }
    }

    const paymentBasis = voidMap[invoice]
      ? 'void'
      : row != null
        ? 'invoice'
        : quoteMap[invoice]
          ? 'quote'
          : 'missing';

    const shareInfo = pack ? sharesAt(pack, updates, pack.date) : { shares: [], totalBp: 0, update: null };
    if (pack && shareInfo.totalBp === 0) {
      addFlag(flags, 'shares-missing', { pack: pack.key });
    }
    if (shareInfo.totalBp > 0 && shareInfo.totalBp !== 10000) {
      addFlag(flags, 'shares-conflict', { totalBp: shareInfo.totalBp });
    }
    const villagePoolFen = Math.max(0, poolFen - insuranceFen);
    // Only a valid invoice with a complete share total confers a payable
    // share. A void, missing or quote-only basis, or shares that do not add up
    // to 10000 bp, report zero entitlement so nothing can be confirmed.
    const payable = paymentBasis === 'invoice'
      && shareInfo.totalBp === 10000
      && !flags.some(flag => flag.code === 'shares-conflict');
    const shareOf = shareInfo.totalBp > 0 && payable
      ? allocate(villagePoolFen, shareInfo.shares)
      : new Map();
    if (!payable) {
      for (const share of shareInfo.shares) shareOf.set(share.village, 0);
    }

    if (paymentBasis === 'void') {
      addFlag(flags, 'void', { voidId: voidMap[invoice]?.voidId ?? null });
    }
    if (paymentBasis === 'quote') {
      addFlag(flags, 'quote-only', {});
    }
    if (paymentBasis === 'missing') {
      addFlag(flags, 'invoice-missing', {});
    }
    if (paymentBasis === 'invoice' && !row.loc) {
      addFlag(flags, 'original-missing', {});
    }
    if (list.length === 0) {
      addFlag(flags, 'acceptance-missing', {});
    }
    const objectionsHere = [
      ...(objectionsByLine.get(key) ?? []),
      ...list.flatMap(entry => objectionsByLine.get(String(entry.acceptance) + '#*') ?? []),
    ];
    if (objectionsHere.length) {
      addFlag(flags, 'objection-filed', {
        objections: objectionsHere.map(entry => entry.id ?? entry.reason).filter(Boolean),
        by: [...new Set(objectionsHere.map(entry => entry.by).filter(Boolean))],
      });
    }
    if (poolFen === 0 && netAcceptedFen > 0) {
      addFlag(flags, 'fully-offset', { netAcceptedFen, replacementOffsetFen });
    }

    const hard = flags.some(flag => HARD_FLAGS.has(flag.code));
    let status = 'ready';
    // A voided or missing payment basis makes the line unpayable outright; it
    // is reported as invalid even if other evidence is also contradictory.
    if (paymentBasis === 'void' || paymentBasis === 'missing') status = 'invalid';
    else if (hard) status = 'disputed';
    else if (paymentBasis === 'quote') status = 'awaiting-material';
    else if (paymentBasis === 'invoice' && !row.loc) status = 'awaiting-material';
    else if (list.length === 0) status = 'awaiting-material';
    else if (poolFen === 0) status = 'no-claimable';
    else if (shareInfo.totalBp === 0) status = 'awaiting-material';

    let waitingFor = null;
    if (status === 'awaiting-material') {
      if (paymentBasis === 'quote' || paymentBasis === 'missing' || !row?.loc) {
        waitingFor = 'issuer-original';
      } else if (list.length === 0) waitingFor = 'town-acceptance';
      else if (shareInfo.totalBp === 0) waitingFor = 'management-shares';
    }
    if (status === 'disputed') waitingFor = 'responsibility-review';

    lines.push({
      key,
      invoice,
      line: lineNo,
      faceFen,
      issuer: row?.issuer ?? null,
      loc: row?.loc ?? null,
      sha256: row?.sha256 ?? null,
      paymentBasis,
      netAcceptedFen,
      replacementOffsetFen,
      poolFen,
      insuranceFen,
      villagePoolFen,
      award: award?.id ?? null,
      awardReach: award?.reach ?? null,
      packKey,
      pack: pack
        ? { key: pack.key, issuer: pack.issuer, id: pack.id, device: pack.device, date: pack.date, reach: pack.reach }
        : null,
      shares: shareInfo.shares,
      shareTotalBp: shareInfo.totalBp,
      shareFrom: shareInfo.update,
      entitlements: Object.fromEntries([...shareOf.entries()].sort(([a], [b]) => compareText(a, b))),
      contributions: list,
      replacements: validReplacements,
      flags,
      status,
      waitingFor,
      basisKey: digest({
        invoice,
        line: lineNo,
        acceptance: list.map(entry => [entry.acceptance, entry.netFen]),
        replacements: validReplacements.map(entry => [entry.invoice, entry.line, entry.includesFen]),
        award: award ? [award.id, award.coveredBeforeDeductibleFen, award.deductibleFen] : null,
        shares: shareInfo.shares,
      }),
    });
  }
  return {
    lines,
    orphans,
    unappliedWithdrawals,
    unappliedObjections,
    packs,
    activeAwards: active,
    duplicateReplacements,
  };
}

export function lineByRef(lines, invoice, line) {
  return lines.find(entry => entry.invoice === String(invoice) && entry.line === Number(line)) ?? null;
}

export function evidenceBasis(line) {
  const basis = [];
  for (const contribution of line.contributions) {
    basis.push({
      kind: 'acceptance',
      ref: contribution.acceptance,
      invoice: line.invoice,
      line: line.line,
      acceptedFen: contribution.acceptedFen,
      withdrawnFen: contribution.withdrawnFen,
      netFen: contribution.netFen,
    });
  }
  for (const replacement of line.replacements) {
    basis.push({
      kind: 'replacement',
      ref: replacement.invoice + '#' + replacement.line,
      includesInvoice: replacement.includesInvoice,
      includesLine: replacement.includesLine,
      includesFen: replacement.includesFen,
    });
  }
  if (line.award) {
    basis.push({ kind: 'insurance', ref: line.award, reach: line.awardReach, paidFen: line.insuranceFen });
  }
  if (line.pack) {
    basis.push({
      kind: 'pack',
      ref: line.pack.key,
      reach: line.pack.reach,
      date: line.pack.date,
      shares: line.shares,
      shareFrom: line.shareFrom,
    });
  }
  for (const flag of line.flags) {
    if (flag.code === 'void') basis.push({ kind: 'void', ref: flag.voidId });
  }
  return basis;
}

export function evidenceSummary(line) {
  return stableStringify({
    poolFen: line.poolFen,
    insuranceFen: line.insuranceFen,
    entitlements: line.entitlements,
    flags: line.flags.map(flag => flag.code).sort(),
  });
}

/** Confirmed (unpaid) and paid amounts, net of settled reversals. */
export function lockedAmounts({ village, invoice, line, confirmations, reversals }) {
  let paid = 0;
  let unpaid = 0;
  for (const confirmation of confirmations) {
    if (confirmation.village !== village || confirmation.invoice !== invoice || Number(confirmation.line) !== Number(line)) continue;
    if (confirmation.status === 'paid') paid += confirmation.fen;
    else if (confirmation.status === 'confirmed') unpaid += confirmation.fen;
  }
  let settled = 0;
  for (const reversal of reversals) {
    if (reversal.village !== village || reversal.invoice !== invoice || Number(reversal.line) !== Number(line)) continue;
    if (reversal.status === 'settled') settled += reversal.fen;
  }
  const netPaid = Math.max(0, paid - settled);
  return { paid, unpaid, settled, netPaid, locked: netPaid + unpaid };
}

/**
 * Claim adjudication. Two villages may each request the whole invoice line;
 * that is normal, but neither request can be confirmed beyond its own share.
 * A request larger than what the claimant can still be paid is marked
 * `requiresSplit` rather than silently trimmed, and a line whose evidence is
 * contradictory stays disputed so no amount is confirmed.
 */
export function evaluateClaims({ claims, lines, confirmations, reversals }) {
  const siblings = new Map();
  for (const claim of claims) {
    const key = String(claim.invoice) + '#' + Number(claim.line);
    if (!siblings.has(key)) siblings.set(key, []);
    siblings.get(key).push(claim);
  }
  const out = [];
  for (const claim of claims) {
    const line = lineByRef(lines, claim.invoice, claim.line);
    const claimFen = fen(claim.fen) ?? 0;
    if (!line) {
      out.push({ claim, line: null, entitlementFen: 0, capacityFen: 0, confirmedFen: 0,
        remainingClaimFen: claimFen, requiresSplit: false, status: 'awaiting-material',
        waitingFor: 'line-record', confirmableFen: 0, reasons: [{ code: 'line-missing' }] });
      continue;
    }
    const entitlementFen = line.entitlements[claim.village] ?? 0;
    const locked = lockedAmounts({
      village: claim.village,
      invoice: claim.invoice,
      line: claim.line,
      confirmations,
      reversals,
    });
    const capacityFen = Math.max(0, entitlementFen - locked.locked);
    const confirmedFen = confirmations
      .filter(entry => entry.claimRef === claim.ref && entry.status !== 'held')
      .reduce((sum, entry) => sum + entry.fen, 0);
    const remainingClaimFen = Math.max(0, claimFen - confirmedFen);
    const others = (siblings.get(String(claim.invoice) + '#' + Number(claim.line)) ?? [])
      .filter(entry => entry !== claim && entry.village !== claim.village);
    const othersOnLine = confirmations.filter(entry =>
      entry.invoice === claim.invoice
      && Number(entry.line) === Number(claim.line)
      && entry.village !== claim.village
      && entry.status !== 'held').length;
    const reasons = [];
    const notes = [];

    if (line.status === 'invalid') reasons.push({ code: 'payment-basis-invalid', basis: line.paymentBasis });
    if (line.status === 'disputed') {
      reasons.push({ code: 'line-disputed', flags: line.flags.map(flag => flag.code) });
    }
    if (line.status === 'awaiting-material') {
      reasons.push({ code: 'line-awaiting-material', waitingFor: line.waitingFor });
    }
    if (line.status === 'no-claimable') reasons.push({ code: 'no-claimable-amount' });
    if (line.status === 'ready' && entitlementFen === 0) {
      reasons.push({ code: 'no-entitlement', village: claim.village });
    }
    if (others.length && !othersOnLine) {
      notes.push({
        code: 'other-village-requested-same-line',
        otherVillages: [...new Set(others.map(entry => entry.village))].sort(compareText),
      });
    }
    if (claimFen + others.reduce((sum, entry) => sum + (fen(entry.fen) ?? 0), 0) > line.villagePoolFen) {
      notes.push({ code: 'village-pool-shared', villagePoolFen: line.villagePoolFen });
    }
    const requiresSplit = remainingClaimFen > capacityFen;
    if (requiresSplit) {
      notes.push({
        code: 'claim-exceeds-capacity', claimFen: remainingClaimFen, capacityFen,
      });
    }

    let status = 'ready';
    if (reasons.some(reason => reason.code === 'payment-basis-invalid')) status = 'invalid';
    else if (!line) status = 'awaiting-material';
    else if (reasons.some(reason => reason.code === 'no-claimable-amount')) status = 'no-claimable';
    else if (remainingClaimFen === 0) status = 'completed';
    else if (reasons.some(reason => reason.code === 'line-disputed' || reason.code === 'no-entitlement')) {
      status = 'disputed';
    } else if (reasons.some(reason => reason.code === 'line-awaiting-material')) status = 'awaiting-material';
    else if (capacityFen === 0) status = 'exhausted';
    else if (reasons.length) status = 'awaiting-material';

    out.push({
      claim,
      line,
      entitlementFen,
      lockedFen: locked.locked,
      capacityFen,
      confirmedFen,
      remainingClaimFen,
      requiresSplit,
      status,
      waitingFor: status === 'disputed'
        ? 'responsibility-review'
        : status === 'awaiting-material'
          ? line.waitingFor ?? 'material'
          : null,
      reasons,
      notes,
      confirmableFen: status === 'ready' ? Math.min(remainingClaimFen, capacityFen) : 0,
    });
  }
  return out;
}
