import {
  allocate, collect, sharesAt,
} from './source.mjs';
import {
  buildLines, evaluateClaims, evidenceBasis, lineByRef, lockedAmounts, HARD_FLAGS,
} from './assess.mjs';
import {
  asArray, compareText, digest, fail, fen, sha256, stableStringify,
} from './util.mjs';

function invoiceLineKey(invoice, line) { return String(invoice) + '#' + Number(line); }

function lineSummary(line) {
  return {
    key: line.key,
    status: line.status,
    paymentBasis: line.paymentBasis,
    faceFen: line.faceFen,
    netAcceptedFen: line.netAcceptedFen,
    replacementOffsetFen: line.replacementOffsetFen,
    poolFen: line.poolFen,
    insuranceFen: line.insuranceFen,
    villagePoolFen: line.villagePoolFen,
    award: line.award,
    entitlements: line.entitlements,
    shares: line.shares,
    shareFrom: line.shareFrom,
    packKey: line.packKey,
    flags: line.flags.map(flag => flag.code).sort(),
    waitingFor: line.waitingFor ?? null,
    originalSha: line.sha256 ?? null,
    loc: line.loc ?? null,
  };
}

function diffLines(before, after) {
  const oldByKey = new Map(before.lines.map(line => [line.key, lineSummary(line)]));
  const newByKey = new Map(after.lines.map(line => [line.key, lineSummary(line)]));
  const changes = new Map();
  for (const key of new Set([...oldByKey.keys(), ...newByKey.keys()])) {
    const oldLine = oldByKey.get(key);
    const newLine = newByKey.get(key);
    if (!oldLine) { changes.set(key, { kind: 'added', before: null, after: newLine, reasons: [{ code: 'line-added' }] }); continue; }
    if (!newLine) { changes.set(key, { kind: 'removed', before: oldLine, after: null, reasons: [{ code: 'line-removed' }] }); continue; }
    if (stableStringify(oldLine) === stableStringify(newLine)) continue;
    const reasons = [];
    if (oldLine.faceFen !== newLine.faceFen || oldLine.originalSha !== newLine.originalSha) {
      reasons.push({ code: 'invoice-original-changed' });
    }
    if (oldLine.netAcceptedFen !== newLine.netAcceptedFen) reasons.push({ code: 'acceptance-changed' });
    if (oldLine.replacementOffsetFen !== newLine.replacementOffsetFen) reasons.push({ code: 'replacement-changed' });
    if (oldLine.insuranceFen !== newLine.insuranceFen || oldLine.award !== newLine.award) {
      reasons.push({ code: 'insurance-corrected' });
    }
    if (stableStringify(oldLine.entitlements) !== stableStringify(newLine.entitlements)) {
      reasons.push({ code: 'management-share-changed' });
    }
    if (oldLine.packKey !== newLine.packKey) reasons.push({ code: 'management-pack-changed' });
    if (oldLine.status !== newLine.status) reasons.push({ code: 'line-status-changed' });
    if (stableStringify(oldLine.flags) !== stableStringify(newLine.flags)) {
      reasons.push({ code: 'evidence-flags-changed' });
    }
    if (reasons.length === 0) reasons.push({ code: 'line-reassessed' });
    changes.set(key, { kind: 'changed', before: oldLine, after: newLine, reasons });
  }
  return changes;
}

function nowIso() { return new Date().toISOString(); }

/**
 * Builds the clearing desk over one programme source and one local ledger.
 *
 * Reads only: the desk never posts anything upstream. Every local decision is
 * written to the store so a later scan can tell which decisions a withdrawn
 * acceptance or a corrected insurance award actually disturbs.
 */
export function createDesk({ source, store, claims = [], actorVillage = null, paymentWindowDays = 15 }) {
  const state = store.state;

  function ledger() {
    return buildLines({
      snapshot: state.snapshot,
      registry: state.catalogue.invoices,
      voids: state.catalogue.voids,
      quotes: state.catalogue.quotes,
    });
  }

  function ledgerOf(snapshot, catalogue) {
    return buildLines({
      snapshot,
      registry: catalogue.invoices,
      voids: catalogue.voids,
      quotes: catalogue.quotes,
    });
  }

  function assertVillageScope(village) {
    if (actorVillage != null && village !== actorVillage) {
      fail('OUT_OF_SCOPE', '这个经办席只能办理本村事项', { actorVillage, village });
    }
  }

  function applyRegister(rows, at) {
    const cat = state.catalogue;
    const register = state.register ?? (state.register = { byId: {}, pages: 0 });
    const seen = new Set();
    const fresh = [];
    for (const raw of asArray(rows)) {
      if (!raw || raw.id == null) continue;
      const id = String(raw.id);
      const mark = id + ':' + (raw.kind ?? '');
      if (seen.has(mark)) continue;
      seen.add(mark);
      register.byId[id] = { ...raw };
      fresh.push({ raw, id });
    }

    // Voids are read before invoices in the same pass so a number listed as an
    // invoice further down the register cannot reopen in that very scan.
    const voidedNow = new Set();
    for (const { raw, id } of fresh) {
      if (raw.kind !== 'void') continue;
      const target = raw.voids == null ? null : String(raw.voids);
      if (!target) continue;
      voidedNow.add(target);
      if (!cat.voids[target]) {
        cat.voids[target] = { voidId: id, firstSeen: at };
        store.audit({ at, action: 'catalogue.void', invoice: target, voidId: id });
      }
    }
    for (const { raw, id } of fresh) {
      if (raw.kind !== 'quote') continue;
      const copyOf = raw.copyOf == null ? null : String(raw.copyOf);
      if (!copyOf) continue;
      if (!cat.quotes[copyOf]) {
        cat.quotes[copyOf] = {
          id, copyOf, issuer: raw.issuer ?? null, loc: raw.loc ?? null, firstSeen: at,
        };
      } else if (cat.quotes[copyOf].id !== id) {
        cat.quoteDuplicates ??= [];
        if (!cat.quoteDuplicates.some(entry => entry.id === id && entry.copyOf === copyOf)) {
          cat.quoteDuplicates.push({ id, copyOf, at });
        }
      }
    }
    for (const { raw, id } of fresh) {
      if (raw.kind !== 'invoice') continue;
      if (cat.voids[id]) {
        // Void wins even if the invoice row was seen in an earlier scan.
        delete cat.invoices[id];
        cat.reopenAttempts ??= [];
        const prior = cat.reopenAttempts.find(entry => entry.id === id);
        if (prior) {
          prior.lastSeen = at;
          prior.times += 1;
        } else {
          cat.reopenAttempts.push({ id, at, lastSeen: at, times: 1, loc: raw.loc ?? null });
        }
        store.audit({ at, action: 'catalogue.reopen-blocked', invoice: id });
        continue;
      }
      cat.invoices[id] = {
        id,
        kind: 'invoice',
        issuer: raw.issuer ?? null,
        loc: raw.loc ?? null,
        sha256: raw.sha256 ?? null,
        lines: asArray(raw.lines).map(line => ({ no: fen(line?.no), fen: fen(line?.fen) }))
          .filter(line => line.no != null && line.fen != null),
        firstSeen: cat.invoices[id]?.firstSeen ?? at,
        lastSeen: at,
      };
    }
    for (const id of voidedNow) delete cat.invoices[id];
    register.pages = fresh.length;
  }

  async function scan() {
    const snapshot = await collect(source);
    const at = nowIso();
    const beforeSnapshot = state.snapshot;
    const beforeCatalogue = beforeSnapshot ? structuredClone(state.catalogue) : null;
    const before = beforeSnapshot ? ledgerOf(beforeSnapshot, beforeCatalogue) : { lines: [], orphans: [] };

    // Catalogue changes first so the new ledger sees the current evidence.
    applyRegister(snapshot.register, at);
    state.snapshot = snapshot;
    state.source = { label: source.base ?? null, name: source.name ?? null, scannedAt: at };
    const after = ledger();
    const changes = diffLines(before, after);
    const reconciled = reconcile(changes, after, at);

    const summary = {
      at,
      source: state.source,
      lines: after.lines.length,
      changed: changes.size,
      added: [...changes.values()].filter(entry => entry.kind === 'added').length,
      removed: [...changes.values()].filter(entry => entry.kind === 'removed').length,
      adjustments: reconciled.adjustments.length,
      reversalsOpened: reconciled.opened.length,
      reversalsCancelled: reconciled.cancelled.length,
      voids: Object.keys(state.catalogue.voids).sort(),
      quoteDuplicates: asArray(state.catalogue.quoteDuplicates).length,
      reopenAttempts: asArray(state.catalogue.reopenAttempts)
        .reduce((sum, attempt) => sum + (attempt.times ?? 1), 0),
      orphans: after.orphans,
      duplicateReplacements: after.duplicateReplacements ?? [],
      unappliedWithdrawals: after.unappliedWithdrawals ?? [],
      unappliedObjections: after.unappliedObjections ?? [],
    };
    state.scans.push(summary);
    const receipt = store.receipt({ action: 'scan', summary });
    store.audit({ at, action: 'scan', receipt: receipt.id, changed: changes.size });
    store.save();
    return { ...summary, receipt: receipt.id };
  }

  /**
   * Applies a fresh scan to existing decisions.
   *
   * Unpaid confirmations are clamped to the new entitlement and the released
   * amount is recorded. Paid confirmations that are no longer covered open a
   * reversal todo naming the original responsible village and the evidence
   * that changed; unrelated lines are left untouched.
   */
  function reconcile(changes, after, at) {
    const adjustments = [];
    const opened = [];
    const cancelled = [];
    const byKey = new Map(after.lines.map(line => [line.key, line]));
    const touched = [...changes.keys()];

    for (const confirmation of state.confirmations) {
      const key = invoiceLineKey(confirmation.invoice, confirmation.line);
      if (!touched.includes(key)) continue;
      if (!['confirmed', 'paid', 'held'].includes(confirmation.status)) continue;
      const change = changes.get(key);
      const line = byKey.get(key) ?? null;
      // A line that loses its payment basis (voided or no longer in the
      // register) covers nothing, even if its shares are unchanged.
      const basisLost = line == null || line.paymentBasis === 'void' || line.paymentBasis === 'missing';
      const entitlement = basisLost ? 0 : (line.entitlements[confirmation.village] ?? 0);
      const reasonCodes = change.reasons.map(reason => reason.code);
      if (basisLost && !reasonCodes.includes('payment-basis-invalid')) {
        reasonCodes.unshift('payment-basis-invalid');
      }

      if (confirmation.status === 'paid') {
        const settled = state.reversals
          .filter(entry => entry.confirmationId === confirmation.id && entry.status === 'settled')
          .reduce((sum, entry) => sum + entry.fen, 0);
        const paidNet = Math.max(0, confirmation.fen - settled);
        const excess = Math.max(0, paidNet - entitlement);
        const open = state.reversals.find(entry =>
          entry.confirmationId === confirmation.id && entry.status === 'open');
        if (excess > 0) {
          if (open) {
            if (open.fen !== excess || stableStringify(open.reasons) !== stableStringify(reasonCodes)) {
              const from = open.fen;
              const priorReasons = open.reasons;
              open.fen = excess;
              open.reasons = reasonCodes;
              open.reason = reasonCodes[0] ?? 'reassessment';
              open.currentBasis = line ? evidenceBasis(line) : [];
              open.entitlementFen = entitlement;
              open.history.push({ at, from, to: excess, reasons: reasonCodes, priorReasons });
              adjustments.push({
                kind: 'reversal-updated', confirmation: confirmation.id, village: confirmation.village,
                invoice: confirmation.invoice, line: confirmation.line, from, to: excess,
                at, reasons: reasonCodes,
              });
            }
          } else {
            const reversal = {
              id: 'RV' + String(store.next('reversal')).padStart(5, '0'),
              confirmationId: confirmation.id,
              village: confirmation.village,
              originalResponsibleParty: confirmation.village,
              invoice: confirmation.invoice,
              line: confirmation.line,
              fen: excess,
              reason: reasonCodes[0] ?? 'reassessment',
              reasons: reasonCodes,
              originalBasis: confirmation.basis,
              currentBasis: line ? evidenceBasis(line) : [],
              paidFen: confirmation.fen,
              entitlementFen: entitlement,
              status: 'open',
              openedAt: at,
              history: [{ at, to: excess, reasons: reasonCodes }],
            };
            state.reversals.push(reversal);
            opened.push(reversal);
            store.audit({
              at, action: 'reversal.open', village: reversal.village,
              invoice: reversal.invoice, line: reversal.line, fen: reversal.fen, reasons: reasonCodes,
            });
          }
        } else if (open) {
          open.status = 'cancelled';
          open.closedAt = at;
          open.history.push({ at, to: 0, reasons: reasonCodes });
          cancelled.push(open);
          store.audit({ at, action: 'reversal.cancel', reversal: open.id });
        }
        continue;
      }

      // Unpaid confirmation: re-determine only the affected unpaid scope.
      // It falls when the evidence behind that line shrinks and recovers only
      // if the same evidence is restored. A scan never creates new spending.
      const otherLocked = lockedAmounts({
        village: confirmation.village,
        invoice: confirmation.invoice,
        line: confirmation.line,
        confirmations: state.confirmations.filter(entry => entry.id !== confirmation.id),
        reversals: state.reversals,
      }).locked;
      const allowed = basisLost ? 0 : Math.max(0, entitlement - otherLocked);
      // `capFen` is the most this decision ever covered; a scan may restore an
      // unpaid confirmation up to that cap but never invent new spending.
      const cap = fen(confirmation.capFen) ?? confirmation.fen;
      const nextFen = Math.min(cap, allowed);
      if (nextFen === confirmation.fen) continue;
      const from = confirmation.fen;
      confirmation.fen = nextFen;
      confirmation.basis = line ? evidenceBasis(line) : [];
      confirmation.status = nextFen === 0 ? 'held' : 'confirmed';
      confirmation.history ??= [];
      confirmation.history.push({ at, from, to: nextFen, reasons: reasonCodes, status: confirmation.status });
      adjustments.push({
        kind: nextFen > from ? 'confirmation-restored' : 'confirmation-adjusted',
        confirmation: confirmation.id, village: confirmation.village,
        invoice: confirmation.invoice, line: confirmation.line, from, to: nextFen,
        status: confirmation.status, at, reasons: reasonCodes,
      });
      store.audit({
        at, action: 'confirmation.adjust', confirmation: confirmation.id, from, to: nextFen,
        status: confirmation.status, reasons: reasonCodes,
      });
    }
    return { adjustments, opened, cancelled };
  }

  function claimResults(village = null) {
    const lines = ledger().lines;
    const results = evaluateClaims({
      claims, lines, confirmations: state.confirmations, reversals: state.reversals,
    });
    return village == null ? results : results.filter(entry => entry.claim.village === village);
  }

  function findClaim(ref) {
    const claim = claims.find(entry => entry.ref === ref);
    if (!claim) fail('CLAIM_UNKNOWN', '没有这张付款申请', { ref });
    assertVillageScope(claim.village);
    return claim;
  }

  function budgetFor(village) {
    const budget = state.budgets[village];
    if (!budget) return { limitFen: null, usedFen: 0, remainingFen: null };
    let used = 0;
    for (const confirmation of state.confirmations) {
      if (confirmation.village !== village || confirmation.status === 'held') continue;
      used += confirmation.fen;
      const settled = state.reversals
        .filter(entry => entry.confirmationId === confirmation.id && entry.status === 'settled')
        .reduce((sum, entry) => sum + entry.fen, 0);
      used -= settled;
    }
    return { limitFen: budget.limitFen, usedFen: used,
      remainingFen: Math.max(0, budget.limitFen - used) };
  }

  function setBudget(village, limitFen) {
    const amount = fen(limitFen);
    if (amount == null || amount < 0) fail('BUDGET_INVALID', '预算须为非负整数分', { limitFen });
    state.budgets[village] = { limitFen: amount, setAt: nowIso() };
    store.save();
    return budgetFor(village);
  }

  /**
   * Confirms a claim. `split` lets a village confirm its own share of a claim
   * that asked for the whole invoice line; without it an oversized claim is
   * refused so two villages can never both be confirmed for the same money.
   */
  function confirm(ref, { fen: requested, split = false, actor = 'desk' } = {}) {
    const claim = findClaim(ref);
    const evaluation = claimResults(claim.village).find(entry => entry.claim.ref === ref);
    if (!evaluation) fail('CLAIM_UNKNOWN', '没有这张付款申请', { ref });

    if (evaluation.status === 'completed') fail('CLAIM_COMPLETED', '这张申请已结清', { ref });
    if (evaluation.status === 'no-claimable') {
      fail('CLAIM_NO_CLAIMABLE', '这项费用已无可结余额，不能再结', {
        ref,
        replacementOffsetFen: evaluation.line?.replacementOffsetFen ?? 0,
        insuranceFen: evaluation.line?.insuranceFen ?? 0,
      });
    }
    if (evaluation.status === 'exhausted') {
      fail('CLAIM_CAPACITY_EXHAUSTED', '本村在这张票据行的可报份额已用尽', {
        ref, entitlementFen: evaluation.entitlementFen, lockedFen: evaluation.lockedFen,
      });
    }
    if (evaluation.status === 'invalid') {
      fail('CLAIM_INVALID', '付款依据无效', { ref, reasons: evaluation.reasons });
    }
    if (evaluation.status === 'disputed') {
      fail('CLAIM_NOT_READY', '申请还不能确认', { ref, status: evaluation.status, reasons: evaluation.reasons });
    }
    if (evaluation.requiresSplit && !split) {
      fail('CLAIM_EXCEEDS_ENTITLEMENT', '申请金额超出本村可报份额，需按份额确认', {
        ref,
        claimFen: evaluation.claim.fen,
        entitlementFen: evaluation.entitlementFen,
        confirmableFen: evaluation.confirmableFen,
      });
    }
    const amount = requested == null ? evaluation.confirmableFen : fen(requested);
    if (amount == null || amount <= 0) fail('AMOUNT_INVALID', '确认金额须为正整数分', { amount: requested });
    if (amount > evaluation.remainingClaimFen) {
      fail('AMOUNT_EXCEEDS_CLAIM', '确认金额超过这张申请尚未结的金额', {
        amount, remainingClaimFen: evaluation.remainingClaimFen, ref,
      });
    }
    if (amount > evaluation.confirmableFen) {
      fail('AMOUNT_EXCEEDS_CAPACITY', '确认金额超过当前可报额度', {
        amount, capacityFen: evaluation.confirmableFen,
      });
    }
    const budget = budgetFor(claim.village);
    if (budget.remainingFen != null && amount > budget.remainingFen) {
      fail('BUDGET_EXHAUSTED', '本村预算不足，需分期安排', {
        amount, remainingFen: budget.remainingFen, village: claim.village,
      });
    }

    const line = evaluation.line;
    const at = nowIso();
    const confirmation = {
      id: 'C' + String(store.next('confirmation')).padStart(5, '0'),
      claimRef: claim.ref,
      village: claim.village,
      invoice: claim.invoice,
      line: Number(claim.line),
      fen: amount,
      capFen: amount,
      requestedFen: claim.fen,
      split,
      status: 'confirmed',
      actor,
      packKey: line?.packKey ?? null,
      basisKey: line?.basisKey ?? null,
      basis: line ? evidenceBasis(line) : [],
      confirmedAt: at,
      paidAt: null,
      paymentRef: null,
      history: [],
    };
    state.confirmations.push(confirmation);
    const receipt = store.receipt({
      action: 'confirm', claim: claim.ref, village: claim.village,
      invoice: confirmation.invoice, line: confirmation.line, fen: amount,
      split, confirmation: confirmation.id,
    });
    store.audit({
      at, action: 'confirmation.confirm', confirmation: confirmation.id,
      claim: claim.ref, village: claim.village, fen: amount,
    });
    store.save();
    return { confirmation, receipt: receipt.id, capacityAfterFen: evaluation.capacityFen - amount };
  }

  function pay(confirmationId, { ref = null, actor = 'desk' } = {}) {
    const confirmation = state.confirmations.find(entry => entry.id === confirmationId);
    if (!confirmation) fail('CONFIRMATION_UNKNOWN', '没有这笔确认', { confirmationId });
    assertVillageScope(confirmation.village);
    if (confirmation.status === 'paid') fail('ALREADY_PAID', '这笔已经划款', { confirmationId });
    if (confirmation.status !== 'confirmed') {
      fail('NOT_PAYABLE', '这笔不在可划款状态', { confirmationId, status: confirmation.status });
    }
    const at = nowIso();
    confirmation.status = 'paid';
    confirmation.paidAt = at;
    confirmation.paymentRef = ref ?? ('P' + confirmation.id);
    const receipt = store.receipt({
      action: 'pay', confirmation: confirmation.id, village: confirmation.village,
      invoice: confirmation.invoice, line: confirmation.line, fen: confirmation.fen,
      paymentRef: confirmation.paymentRef,
    });
    store.audit({
      at, action: 'confirmation.pay', confirmation: confirmation.id,
      village: confirmation.village, fen: confirmation.fen, paymentRef: confirmation.paymentRef,
    });
    store.save();
    return { confirmation, receipt: receipt.id };
  }

  function settleReversal(id, { ref = null, actor = 'desk' } = {}) {
    const reversal = state.reversals.find(entry => entry.id === id);
    if (!reversal) fail('REVERSAL_UNKNOWN', '没有这张反向核销待办', { id });
    assertVillageScope(reversal.village);
    if (reversal.status !== 'open') fail('REVERSAL_NOT_OPEN', '待办不在可核销状态', { id, status: reversal.status });
    const at = nowIso();
    reversal.status = 'settled';
    reversal.settledAt = at;
    reversal.settledRef = ref ?? ('RV-P' + reversal.id);
    const receipt = store.receipt({
      action: 'reversal.settle', reversal: reversal.id, village: reversal.village,
      invoice: reversal.invoice, line: reversal.line, fen: reversal.fen,
      originalResponsibleParty: reversal.originalResponsibleParty,
    });
    store.audit({
      at, action: 'reversal.settle', reversal: reversal.id, village: reversal.village, fen: reversal.fen,
    });
    store.save();
    return { reversal, receipt: receipt.id };
  }

  function confirmationsFor(village = null) {
    const list = village == null
      ? state.confirmations
      : state.confirmations.filter(entry => entry.village === village);
    return list.map(entry => ({
      ...entry,
      reversals: state.reversals.filter(reversal => reversal.confirmationId === entry.id),
    }));
  }

  function reversalsFor(village = null) {
    return village == null
      ? state.reversals
      : state.reversals.filter(entry => entry.village === village);
  }

  /**
   * Where one repair (pack) or one invoice line has been used: payments out,
   * reversals raised, and what is still open. Rows are found through the
   * evidence trail, not through the device name.
   */
  function usage({ invoice = null, line = null, pack = null } = {}) {
    const current = ledger();
    let lines;
    if (invoice != null) {
      const target = line == null ? null : Number(line);
      lines = current.lines.filter(entry =>
        entry.invoice === String(invoice) && (target == null || entry.line === target));
    } else if (pack != null) {
      lines = current.lines.filter(entry => entry.packKey === String(pack));
    } else {
      fail('USAGE_TARGET', '需要票据行或工作包', {});
    }
    if (lines.length === 0) fail('USAGE_NOT_FOUND', '没有找到这项抢修或票据行', { invoice, line, pack });
    return lines.map(entry => {
      const confirmations = state.confirmations
        .filter(item => item.invoice === entry.invoice && item.line === entry.line)
        .map(item => ({
          id: item.id,
          village: item.village,
          claimRef: item.claimRef,
          fen: item.fen,
          status: item.status,
          split: item.split,
          confirmedAt: item.confirmedAt,
          paidAt: item.paidAt,
          paymentRef: item.paymentRef,
        }));
      const reversals = state.reversals
        .filter(item => item.invoice === entry.invoice && item.line === entry.line)
        .map(item => ({
          id: item.id,
          confirmationId: item.confirmationId,
          village: item.village,
          fen: item.fen,
          status: item.status,
          reason: item.reason,
          reasons: item.reasons,
          originalResponsibleParty: item.originalResponsibleParty,
          openedAt: item.openedAt,
          settledAt: item.settledAt ?? null,
          settledRef: item.settledRef ?? null,
        }));
      const paidFen = confirmations.filter(item => item.status === 'paid')
        .reduce((sum, item) => sum + item.fen, 0);
      const settledFen = reversals.filter(item => item.status === 'settled')
        .reduce((sum, item) => sum + item.fen, 0);
      const confirmedFen = confirmations.filter(item => item.status === 'confirmed')
        .reduce((sum, item) => sum + item.fen, 0);
      const heldFen = confirmations.filter(item => item.status === 'held')
        .reduce((sum, item) => sum + item.fen, 0);
      const openReversals = reversals.filter(item => item.status === 'open');
      return {
        invoice: entry.invoice,
        line: entry.line,
        pack: entry.pack ? { key: entry.pack.key, device: entry.pack.device, reach: entry.pack.reach, date: entry.pack.date } : null,
        status: entry.status,
        poolFen: entry.poolFen,
        insuranceFen: entry.insuranceFen,
        entitlements: entry.entitlements,
        confirmations,
        reversals,
        paidFen,
        settledFen,
        confirmedFen,
        heldFen,
        netPaidFen: paidFen - settledFen,
        openReversalFen: openReversals.reduce((sum, item) => sum + item.fen, 0),
        remainingByVillageFen: Object.fromEntries(
          Object.entries(entry.entitlements).map(([village, entitlementFen]) => {
            const mine = confirmations.filter(item => item.village === village && item.status !== 'held');
            const paid = mine.filter(item => item.status === 'paid').reduce((sum, item) => sum + item.fen, 0);
            const unpaid = mine.filter(item => item.status === 'confirmed').reduce((sum, item) => sum + item.fen, 0);
            const settled = reversals
              .filter(item => item.village === village && item.status === 'settled')
              .reduce((sum, item) => sum + item.fen, 0);
            const netPaid = Math.max(0, paid - settled);
            return [village, Math.max(0, entitlementFen - netPaid - unpaid)];
          }),
        ),
        flags: entry.flags,
      };
    });
  }

  /** Catalogue rows a village can inspect; the original is fetched separately. */
  function catalogue(village = null) {
    const current = ledger();
    const byInvoice = new Map();
    for (const line of current.lines) {
      const entry = byInvoice.get(line.invoice) ?? {
        id: line.invoice, issuer: line.issuer, basis: line.paymentBasis,
        lines: [], documents: null,
      };
      entry.lines.push({
        line: line.line,
        status: line.status,
        faceFen: line.faceFen,
        poolFen: line.poolFen,
        claimableFen: line.status === 'ready' ? line.poolFen : 0,
        entitlementFen: village == null ? null : (line.entitlements[village] ?? 0),
        flags: line.flags.map(flag => flag.code),
      });
      byInvoice.set(line.invoice, entry);
    }
    const entries = new Set([
      ...Object.keys(state.catalogue.invoices),
      ...Object.keys(state.catalogue.voids),
      ...Object.keys(state.catalogue.quotes),
    ]);
    for (const invoice of entries) {
      const row = state.catalogue.invoices[invoice];
      const seenRaw = state.register?.byId?.[invoice] ?? null;
      const entry = byInvoice.get(invoice) ?? {
        id: invoice,
        issuer: seenRaw?.issuer ?? null,
        basis: state.catalogue.voids[invoice] ? 'void' : 'quote',
        lines: [],
        documents: null,
      };
      entry.issuer = entry.issuer ?? row?.issuer ?? seenRaw?.issuer ?? null;
      if (row) {
        entry.loc = row.loc;
        entry.sha256 = row.sha256 ?? null;
      }
      if (state.catalogue.voids[invoice]) {
        entry.void = state.catalogue.voids[invoice];
        entry.basis = 'void';
      }
      if (state.catalogue.quotes[invoice]) entry.quote = state.catalogue.quotes[invoice];
      const attempts = asArray(state.catalogue.reopenAttempts).filter(attempt => attempt.id === invoice);
      entry.reopenAttempts = attempts.reduce((sum, attempt) => sum + (attempt.times ?? 1), 0);
      if (attempts.length) entry.reopenLastSeen = attempts.at(-1).lastSeen;
      byInvoice.set(invoice, entry);
    }
    return [...byInvoice.values()].sort((a, b) => compareText(a.id, b.id));
  }

  function eligibilityForDocument(invoice, village) {
    const current = ledger();
    const lines = current.lines.filter(entry => entry.invoice === invoice);
    if (lines.length === 0) fail('INVOICE_UNKNOWN', '目录里没有这张票据', { invoice });
    if (state.catalogue.voids[invoice]) {
      fail('INVOICE_VOID', '这张票号已作废，不能再提供原件', {
        invoice, voidId: state.catalogue.voids[invoice].voidId,
      });
    }
    const row = state.catalogue.invoices[invoice];
    if (!row) fail('NO_ORIGINAL', '目录没有可领取的原件', { invoice });
    const entitled = lines.some(entry => (entry.entitlements[village] ?? 0) > 0);
    if (!entitled) fail('NO_ENTITLEMENT', '本村在这张票上没有可报份额', { invoice, village });
    const unpaid = state.confirmations.some(entry =>
      entry.village === village && entry.invoice === invoice && entry.status === 'confirmed');
    const readyClaim = claimResults(village).some(entry =>
      entry.claim.invoice === invoice && entry.status === 'ready');
    const turn = unpaid || readyClaim;
    return { row, lines, turn };
  }

  /**
   * Fetches the current valid original for a village. Catalogue listing and
   * original retrieval are separate; a quote row is never served as an original.
   */
  async function document(invoice, { village, review = false } = {}) {
    assertVillageScope(village);
    const { row, turn } = eligibilityForDocument(invoice, village);
    if (!turn && !review) {
      fail('NOT_YOUR_TURN', '还没有轮到本村审核这张票据；如属核查可显式要求复核', { invoice, village });
    }
    const existing = state.documents[invoice];
    const fetched = await source.document(row.loc);
    if (!fetched) fail('ORIGINAL_UNAVAILABLE', '来源没有返回原件', { invoice, loc: row.loc });
    const actualSha = sha256(fetched.body);
    if (row.sha256 && actualSha !== row.sha256) {
      fail('ORIGINAL_HASH_MISMATCH', '原件校验不一致，不能作为付款依据', {
        invoice, expected: row.sha256, actual: actualSha,
      });
    }
    const at = nowIso();
    const record = existing ?? {
      invoice,
      sha256: actualSha,
      contentType: fetched.contentType,
      fetchedAt: at,
      issuedTo: [],
      bytes: fetched.body.toString('base64'),
      reviewOnly: [],
    };
    if (existing && existing.sha256 !== actualSha) {
      record.previous = asArray(record.previous);
      record.previous.push({ sha256: record.sha256, fetchedAt: record.fetchedAt });
      record.sha256 = actualSha;
      record.contentType = fetched.contentType;
      record.bytes = fetched.body.toString('base64');
      record.fetchedAt = at;
    }
    if (review && !turn) {
      if (!record.reviewOnly.includes(village)) record.reviewOnly.push(village);
    } else if (!record.issuedTo.includes(village)) {
      record.issuedTo.push(village);
    }
    state.documents[invoice] = record;
    const receipt = store.receipt({
      action: 'document', invoice, village, sha256: actualSha, review: !turn,
    });
    store.audit({
      at, action: 'document.fetch', invoice, village, sha256: actualSha, review: !turn,
    });
    store.save();
    return {
      invoice,
      village,
      sha256: actualSha,
      contentType: fetched.contentType,
      fetchedAt: record.fetchedAt,
      text: fetched.contentType.startsWith('text/') ? fetched.body.toString('utf8') : null,
      paymentGrade: turn && !state.catalogue.voids[invoice] && Boolean(state.catalogue.invoices[invoice]),
      review: !turn,
      receipt: receipt.id,
    };
  }

  /**
   * Intake progress per claim: a missing document is either still with the
   * counterparty or already a responsibility dispute. The two are never
   * collapsed into one "pending" bucket.
   */
  function progress(village = null) {
    const results = claimResults(village);
    const now = Date.now();
    return results.map(entry => {
      let phase;
      if (entry.status === 'ready') phase = 'ready-to-confirm';
      if (entry.status === 'ready') phase = 'ready-to-confirm';
      else if (entry.status === 'no-claimable') {
        phase = entry.line?.replacementOffsetFen > 0 ? 'offset-by-replacement' : 'covered-by-insurance';
      }
      else if (entry.status === 'exhausted') phase = 'entitlement-exhausted';
      else if (entry.status === 'completed') phase = 'closed';
      else if (entry.status === 'invalid') phase = 'invalid-basis';
      else if (entry.status === 'disputed') phase = 'responsibility-dispute';
      else if (entry.waitingFor === 'town-acceptance' || entry.waitingFor === 'issuer-original') {
        phase = 'waiting-for-counterparty-material';
      } else if (entry.waitingFor === 'management-shares') phase = 'waiting-for-management-shares';
      else if (entry.waitingFor === 'line-record') phase = 'waiting-for-counterparty-material';
      else phase = 'waiting-for-material';
      const ageDays = entry.line?.pack?.date
        ? Math.max(0, Math.floor((now - Date.parse(entry.line.pack.date)) / 86400000))
        : null;
      return {
        claim: entry.claim.ref,
        village: entry.claim.village,
        invoice: entry.claim.invoice,
        line: entry.claim.line,
        phase,
        waitingFor: entry.waitingFor,
        status: entry.status,
        entitlementFen: entry.entitlementFen,
        capacityFen: entry.capacityFen,
        confirmableFen: entry.confirmableFen,
        confirmedFen: entry.confirmedFen,
        remainingClaimFen: entry.remainingClaimFen,
        reasons: entry.reasons,
        ageDays,
        overdue: ageDays != null && ageDays > paymentWindowDays
          && !['completed', 'no-claimable', 'invalid'].includes(entry.status),
      };
    });
  }

  function budgetReport() {
    const villages = new Set([
      ...Object.keys(state.budgets),
      ...claims.map(claim => claim.village),
      ...state.confirmations.map(confirmation => confirmation.village),
    ]);
    return [...villages].sort(compareText).map(village => ({ village, ...budgetFor(village) }));
  }

  /** One compact view for the desk operator. */
  function report() {
    const current = ledger();
    const results = claimResults();
    const byStatus = {};
    for (const line of current.lines) byStatus[line.status] = (byStatus[line.status] ?? 0) + 1;
    const phases = {};
    for (const entry of progress()) phases[entry.phase] = (phases[entry.phase] ?? 0) + 1;

    const confirmable = [];
    const disputed = [];
    const missing = [];
    for (const line of current.lines) {
      const row = {
        key: line.key,
        status: line.status,
        poolFen: line.poolFen,
        insuranceFen: line.insuranceFen,
        entitlements: line.entitlements,
        flags: line.flags.map(flag => flag.code),
      };
      if (line.status === 'ready') confirmable.push(row);
      else if (line.status === 'disputed') disputed.push(row);
      else if (line.status === 'awaiting-material') {
        missing.push({ ...row, waitingFor: line.waitingFor });
      }
    }

    return {
      source: state.source,
      scannedAt: state.source?.scannedAt ?? null,
      lastScan: state.scans.at(-1) ?? null,
      lineCount: current.lines.length,
      linesByStatus: byStatus,
      claimPhases: phases,
      // What has acceptance, a valid payment basis and a responsible share.
      confirmable,
      // What is held for a responsibility question; listed apart, never pooled.
      disputed,
      // What is short of material, with who it is waiting on.
      missing,
      orphans: current.orphans,
      orphans: current.orphans,
      duplicateReplacements: current.duplicateReplacements ?? [],
      unappliedWithdrawals: current.unappliedWithdrawals ?? [],
      unappliedObjections: current.unappliedObjections ?? [],
      openReversals: state.reversals
        .filter(entry => entry.status === 'open')
        .map(entry => ({
          id: entry.id, village: entry.village, invoice: entry.invoice, line: entry.line,
          fen: entry.fen, reasons: entry.reasons, openedAt: entry.openedAt,
        })),
      adjustments: state.scans.flatMap(scan => scan.adjustments ?? []).slice(-20),
      catalogue: {
        invoices: Object.keys(state.catalogue.invoices).length,
        quotes: Object.keys(state.catalogue.quotes).length,
        voids: Object.keys(state.catalogue.voids).length,
        reopenAttempts: asArray(state.catalogue.reopenAttempts)
        .reduce((sum, attempt) => sum + (attempt.times ?? 1), 0),
        quoteDuplicates: asArray(state.catalogue.quoteDuplicates).length,
      },
      budgets: budgetReport(),
      dividends: results.map(entry => ({
        claim: entry.claim.ref, village: entry.claim.village, status: entry.status,
        confirmableFen: entry.confirmableFen,
      })),
    };
  }

  function lineLookup(invoice, line) {
    return lineByRef(ledger().lines, invoice, line);
  }

  function currentShares(packKey, date = null) {
    const current = ledger();
    const pack = current.packs.find(entry => entry.key === packKey);
    if (!pack) fail('PACK_UNKNOWN', '没有这个工作包', { pack: packKey });
    if (date == null) return { shares: pack.shares, totalBp: pack.shares.reduce((sum, share) => sum + share.bp, 0), update: null };
    return sharesAt(pack, state.snapshot?.updates ?? [], date);
  }

  return {
    state,
    scan,
    report,
    ledger: () => ledger(),
    catalogue,
    document,
    claims: claimResults,
    progress,
    confirm,
    pay,
    settleReversal,
    confirmations: confirmationsFor,
    reversals: reversalsFor,
    usage,
    setBudget,
    budget: budgetFor,
    budgets: budgetReport,
    currentShares,
    line: lineLookup,
    evidenceBasis,
    allocate,
    digest,
    sha256,
    HARD_FLAGS,
  };
}
