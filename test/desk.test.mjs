import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createDesk } from '../src/desk.mjs';
import { fixtureSource, collect, allocate, sharesAt } from '../src/source.mjs';
import { buildLines } from '../src/assess.mjs';
import { openStore } from '../src/store.mjs';
import { DeskError } from '../src/util.mjs';

const exchange = JSON.parse(readFileSync(new URL('../sources/exchange.json', import.meta.url)));
const requests = JSON.parse(readFileSync(new URL('../sources/requests.json', import.meta.url))).claims;

function release(name) {
  const found = exchange.releases.find(entry => entry.name === name);
  assert.ok(found, name);
  return found;
}

/** A source whose payloads a test can swap between calls. */
function mutableSource(routes) {
  let current = structuredClone(routes);
  let source = fixtureSource({ name: 'test', routes: current });
  return {
    source: {
      base: 'test',
      packs: async () => structuredClone(current['/management/packs']),
      acceptance: async () => structuredClone(current['/town/acceptance']),
      awards: async () => structuredClone(current['/insurer/awards']),
      register: () => source.register(),
      document: loc => source.document(loc),
    },
    set(next) {
      current = structuredClone(next);
      source = fixtureSource({ name: 'test', routes: current });
    },
  };
}

function tempStore(name) {
  return openStore(join(tmpdir(), 'desk-' + name + '-' + process.pid + '-' + Math.random().toString(16).slice(2) + '.json'));
}

async function deskFor(name, extra = {}) {
  const store = tempStore(name);
  const desk = createDesk({
    source: fixtureSource(release(name)),
    store,
    claims: requests,
    ...extra,
  });
  await desk.scan();
  return desk;
}

async function expectFail(promise, code) {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof DeskError, 'expected DeskError, got ' + error);
    assert.equal(error.code, code, error.message);
    return error;
  }
  assert.fail('expected failure ' + code);
}

test('份额按修复日生效，迁管后的更新只影响其后日期', () => {
  const snapshot = { packs: release('复核来件').routes['/management/packs'].packs };
  const atRepair = sharesAt(snapshot.packs[0], snapshot.packs.updates ?? [], '2026-11-18');
  assert.deepEqual(atRepair.shares, [{ village: '蓝湾', bp: 6000 }, { village: '橙湾', bp: 4000 }]);
  const updates = release('复核来件').routes['/management/packs'].updates;
  const later = sharesAt(snapshot.packs[0], updates, '2026-11-18');
  assert.deepEqual(later.shares.map(share => share.bp), [6000, 4000]);
  const afterUpdate = sharesAt(snapshot.packs[0], updates, '2026-11-21');
  assert.deepEqual(afterUpdate.shares, [{ village: '蓝湾', bp: 2000 }, { village: '橙湾', bp: 8000 }]);
  // An update for another reach never applies.
  const otherReach = sharesAt(snapshot.packs[1], updates, '2026-11-21');
  assert.deepEqual(otherReach.shares, [{ village: '橙湾', bp: 10000 }]);
});

test('尾差由份额大者承担，等份按村编号顺序', () => {
  const uneven = allocate(101, [{ village: '蓝湾', bp: 6000 }, { village: '橙湾', bp: 4000 }]);
  assert.equal(uneven.get('蓝湾'), 61);
  assert.equal(uneven.get('橙湾'), 40);
  const tie = allocate(101, [{ village: '乙', bp: 5000 }, { village: '甲', bp: 5000 }]);
  assert.equal(tie.get('甲'), 51);
  assert.equal(tie.get('乙'), 50);
  const zero = allocate(0, [{ village: '甲', bp: 5000 }]);
  assert.equal(zero.get('甲'), 0);
});

test('首发：验收、保险免赔与共管份额分摊到行', async () => {
  const desk = await deskFor('首发');
  const line = desk.line('T77', 1);
  assert.equal(line.netAcceptedFen, 64000);
  assert.equal(line.insuranceFen, 20000); // 25000 覆盖 - 5000 免赔
  assert.equal(line.villagePoolFen, 44000);
  assert.deepEqual(line.entitlements, { 蓝湾: 26400, 橙湾: 17600 });
  assert.equal(line.status, 'ready');
  const second = desk.line('T77', 2);
  assert.deepEqual(second.entitlements, { 蓝湾: 9600, 橙湾: 6400 });
});

test('同名设备跨村复用，工作包只按签发方加编号区分', async () => {
  const desk = await deskFor('首发');
  const lines = desk.ledger().lines;
  const east = lines.find(entry => entry.invoice === 'T77');
  const west = lines.find(entry => entry.invoice === 'T78');
  assert.equal(east.pack.key, '渠东站/X7');
  assert.equal(west.pack.key, '渠西站/X7');
  assert.equal(east.pack.device, west.pack.device);
  assert.equal(west.entitlements['橙湾'], 24000);
});

test('两村对同一票据全额申请：谁也不能吞掉对方份额', async () => {
  const desk = await deskFor('首发');
  const blue = desk.claims('蓝湾')[0];
  const orange = desk.claims('橙湾').find(entry => entry.claim.ref === '村请B');
  assert.equal(blue.status, 'ready');
  assert.equal(blue.confirmableFen, 26400);
  assert.equal(orange.status, 'ready');
  assert.equal(orange.confirmableFen, 17600);
  // Requesting 64000 when entitled to 26400 is refused without --split.
  await expectFail(Promise.resolve().then(() => desk.confirm('村请A')), 'CLAIM_EXCEEDS_ENTITLEMENT');
  const first = desk.confirm('村请A', { split: true });
  assert.equal(first.confirmation.fen, 26400);
  // The other village's capacity is untouched by the first village's payment.
  const after = desk.claims('橙湾').find(entry => entry.claim.ref === '村请B');
  assert.equal(after.confirmableFen, 17600);
  const second = desk.confirm('村请B', { split: true });
  assert.equal(second.confirmation.fen, 17600);
  assert.equal(desk.ledger().lines.find(entry => entry.key === 'T77#1').entitlements['蓝湾'], 26400);
});

test('无争议的另一张票不因一张票的争议停付', async () => {
  const desk = await deskFor('首发');
  await expectFail(Promise.resolve().then(() => desk.confirm('村请A')), 'CLAIM_EXCEEDS_ENTITLEMENT');
  const other = desk.claims('橙湾').find(entry => entry.claim.ref === '村请C');
  assert.equal(other.status, 'ready');
  const result = desk.confirm('村请C');
  assert.equal(result.confirmation.fen, 24000);
  assert.equal(desk.line('T78', 1).status, 'ready');
});

test('目录与原件分别领取，转载报价不是付款依据', async () => {
  const desk = await deskFor('首发');
  const quoted = desk.catalogue().find(entry => entry.id === 'T77');
  assert.equal(quoted.basis, 'invoice');
  assert.ok(quoted.quote, '转载报价挂在目录上');
  const fetched = await desk.document('T77', { village: '蓝湾', review: true });
  assert.equal(fetched.paymentGrade, true);
  assert.match(fetched.text, /泵体应急修复/);
  assert.equal(fetched.sha256.length, 64);
  // A quote-only invoice has no original to serve.
  const quoteDesk = await deskFor('首发');
  quoteDesk.state.catalogue.invoices = {};
  await expectFail(quoteDesk.document('T77', { village: '蓝湾', review: true }), 'NO_ORIGINAL');
});

test('作废票号不能再扫描重开，已领原件不能作为付款依据', async () => {
  const desk = await deskFor('票据作废');
  const line = desk.line('T77', 1);
  assert.equal(line.status, 'invalid');
  assert.ok(line.flags.some(flag => flag.code === 'void'));
  const claim = desk.claims('蓝湾').find(entry => entry.claim.ref === '村请A');
  assert.equal(claim.status, 'invalid');
  await expectFail(Promise.resolve().then(() => desk.confirm('村请A', { split: true })), 'CLAIM_INVALID');
  await expectFail(desk.document('T77', { village: '蓝湾', review: true }), 'INVOICE_VOID');
  // Re-scanning does not reopen the void number.
  await desk.scan();
  assert.equal(desk.line('T77', 1).status, 'invalid');
  assert.ok(desk.state.catalogue.voids.T77, '作废记录仍在');
  assert.equal(desk.line('T78', 1).status, 'ready');
});

test('后续成套更换只在明确包含的行额度内抵销原维修', async () => {
  const desk = await deskFor('复核来件');
  const old = desk.line('T77', 1);
  assert.equal(old.replacementOffsetFen, 25000);
  assert.equal(old.netAcceptedFen, 42000); // 64000 验收 - 22000 撤回
  assert.equal(old.insuranceFen, 7000); // Q2 覆盖 12000 - 免赔 5000
  assert.equal(old.villagePoolFen, 10000);
  assert.deepEqual(old.entitlements, { 蓝湾: 6000, 橙湾: 4000 });
  const replacement = desk.line('T79', 1);
  assert.equal(replacement.status, 'awaiting-material');
  assert.equal(replacement.waitingFor, 'town-acceptance');
  assert.equal(replacement.poolFen, 0);
  // Untouched line keeps its full amount.
  assert.equal(desk.line('T77', 2).poolFen, 16000);
});

test('缺资料时分清等对方补料与已进入责任争议', async () => {
  const base = structuredClone(release('首发').routes);
  // T78's invoice exists but the town has not sent any accepted amount for it;
  // T77#1 is claimed by two different work packs, which is a responsibility
  // question rather than a missing document.
  base['/town/acceptance'].events = [
    { id: 'K1', pack: '渠东站/X7', invoice: 'T77', accepted: [{ line: 1, fen: 64000 }] },
    { id: 'K2', pack: '渠西站/X7', invoice: 'T77', accepted: [{ line: 1, fen: 24000 }] },
    { id: 'K3', pack: '渠西站/X7', invoice: 'T78', accepted: [] },
  ];
  const desk = createDesk({
    source: fixtureSource({ name: 'progress', routes: base }),
    store: tempStore('progress'),
    claims: requests,
  });
  await desk.scan();
  const progress = desk.progress();
  const waiting = progress.find(entry => entry.claim === '村请C');
  assert.equal(waiting.phase, 'waiting-for-counterparty-material');
  assert.equal(waiting.waitingFor, 'town-acceptance');
  const disputed = progress.find(entry => entry.claim === '村请A');
  assert.equal(disputed.phase, 'responsibility-dispute');
  assert.equal(disputed.waitingFor, 'responsibility-review');
  assert.equal(disputed.confirmableFen, 0);
});

test('共管双方按各自预算分期确认，锁住票据行可报部分', async () => {
  const desk = await deskFor('首发');
  desk.setBudget('蓝湾', 10000);
  await expectFail(Promise.resolve().then(() => desk.confirm('村请A', { split: true })), 'BUDGET_EXHAUSTED');
  const first = desk.confirm('村请A', { fen: 10000, split: true });
  assert.equal(first.confirmation.fen, 10000);
  assert.equal(first.capacityAfterFen, 16400);
  // The first instalment exhausts the budget; nothing more may be confirmed yet.
  await expectFail(Promise.resolve().then(() => desk.confirm('村请A', { split: true })), 'BUDGET_EXHAUSTED');
  // Next instalment raises the budget; the remaining line capacity is still locked.
  desk.setBudget('蓝湾', 30000);
  const again = desk.confirm('村请A', { split: true });
  assert.equal(again.confirmation.fen, 16400);
  const usage = desk.usage({ invoice: 'T77', line: 1 })[0];
  assert.equal(usage.entitlements['蓝湾'], 26400);
  assert.equal(usage.remainingByVillageFen['蓝湾'], 0);
  assert.equal(usage.remainingByVillageFen['橙湾'], 17600);
});

test('撤回局部验收只重算受影响的未付款确认', async () => {
  const store = tempStore('withdraw');
  const base = release('首发').routes;
  const source = mutableSource(base);
  const desk = createDesk({ source: source.source, store, claims: requests });
  await desk.scan();
  const blue = desk.confirm('村请A', { split: true });
  const orange = desk.confirm('村请B', { split: true });
  const other = desk.confirm('村请C');
  assert.equal(blue.confirmation.fen, 26400);

  // K1 line 1 loses 22000; K2 (other invoice) is unaffected.
  const next = structuredClone(base);
  next['/town/acceptance'].withdrawn = [{ acceptance: 'K1', line: 1, fen: 22000 }];
  source.set(next);
  const result = await desk.scan();
  assert.ok(result.adjustments >= 1);
  const adjusted = store.state.confirmations.find(entry => entry.id === blue.confirmation.id);
  // 42000 accepted - 20000 insurance = 22000; blue 60% = 13200
  assert.equal(adjusted.fen, 13200);
  assert.equal(adjusted.status, 'confirmed');
  const untouched = store.state.confirmations.find(entry => entry.id === other.confirmation.id);
  assert.equal(untouched.fen, 24000, '另一张票不动');
  const orangeEntry = store.state.confirmations.find(entry => entry.id === orange.confirmation.id);
  assert.equal(orangeEntry.fen, 8800);
});

test('已划款后补到撤回：只对受影响未付范围重算并生成反向核销', async () => {
  const store = tempStore('paid');
  const base = release('首发').routes;
  const source = mutableSource(base);
  const desk = createDesk({ source: source.source, store, claims: requests });
  await desk.scan();
  const blue = desk.confirm('村请A', { split: true });
  desk.pay(blue.confirmation.id, { ref: '付-1' });
  const untouched = desk.confirm('村请C');
  desk.pay(untouched.confirmation.id, { ref: '付-2' });

  const next = structuredClone(base);
  next['/town/acceptance'].withdrawn = [{ acceptance: 'K1', line: 1, fen: 22000 }];
  source.set(next);
  const result = await desk.scan();
  assert.equal(result.reversalsOpened, 1);
  const reversal = desk.reversals('蓝湾')[0];
  assert.equal(reversal.fen, 26400 - 13200);
  assert.equal(reversal.originalResponsibleParty, '蓝湾');
  assert.ok(reversal.originalBasis.length > 0);
  assert.ok(reversal.currentBasis.length > 0);
  assert.equal(desk.reversals('橙湾').length, 0);
  const usage = desk.usage({ invoice: 'T77', line: 1 })[0];
  assert.equal(usage.netPaidFen, 26400);
  assert.equal(usage.openReversalFen, 13200);
  assert.equal(usage.remainingByVillageFen['蓝湾'], 0);
  desk.settleReversal(reversal.id, { ref: '退-1' });
  const after = desk.usage({ invoice: 'T77', line: 1 })[0];
  assert.equal(after.settledFen, 13200);
  assert.equal(after.netPaidFen, 13200);
  assert.equal(after.openReversalFen, 0);
});

test('保险覆盖更正只重算受影响的行', async () => {
  const store = tempStore('insurance');
  const base = release('首发').routes;
  const source = mutableSource(base);
  const desk = createDesk({ source: source.source, store, claims: requests });
  await desk.scan();
  const blue = desk.confirm('村请A', { split: true });
  desk.pay(blue.confirmation.id);

  const next = structuredClone(base);
  next['/insurer/awards'].awards = [{
    id: 'Q9', reach: 'C91', invoice: 'T77', line: 1,
    coveredBeforeDeductibleFen: 5000, deductibleFen: 5000,
  }];
  source.set(next);
  const result = await desk.scan();
  // Insurance paid drops from 20000 to 0, so blue's entitlement rises; no excess.
  assert.equal(result.reversalsOpened, 0);
  assert.equal(desk.reversals('蓝湾').length, 0);
  const adjusted = store.state.confirmations.find(entry => entry.id === blue.confirmation.id);
  assert.equal(adjusted.status, 'paid');
  assert.equal(desk.line('T77', 1).entitlements['蓝湾'], 38400);

  const lower = structuredClone(base);
  lower['/insurer/awards'].awards = [{
    id: 'Q8', reach: 'C91', invoice: 'T77', line: 1,
    coveredBeforeDeductibleFen: 64000, deductibleFen: 0,
  }];
  source.set(lower);
  const second = await desk.scan();
  assert.equal(second.reversalsOpened, 1);
  const excess = desk.reversals('蓝湾').find(entry => entry.status === 'open');
  assert.equal(excess.fen, 26400); // insurance covers everything, nothing for the village
  assert.ok(excess.reasons.includes('insurance-corrected'));
});

test('保险核定渠段不符或重复核定时行进入争议，不出可确认金额', async () => {
  const store = tempStore('award-conflict');
  const base = structuredClone(release('首发').routes);
  base['/insurer/awards'].awards = [{
    id: 'Q1', reach: 'C99', invoice: 'T77', line: 1,
    coveredBeforeDeductibleFen: 25000, deductibleFen: 5000,
  }];
  const desk = createDesk({ source: fixtureSource({ name: 'x', routes: base }), store, claims: requests });
  await desk.scan();
  const line = desk.line('T77', 1);
  assert.equal(line.status, 'disputed');
  assert.equal(line.insuranceFen, 0);
  assert.ok(line.flags.some(flag => flag.code === 'award-reach-mismatch'));
  const claim = desk.claims('蓝湾')[0];
  assert.equal(claim.status, 'disputed');
  assert.equal(claim.confirmableFen, 0);
});

test('工作包跨两份验收时争议，不猜测归属', () => {
  const snapshot = {
    packs: [{ issuer: '渠东站', id: 'X7', device: '泵一', date: '2026-11-18', reach: 'C91', shares: [{ village: '蓝湾', bp: 10000 }] }],
    events: [
      { id: 'K1', pack: '渠东站/X7', invoice: 'T77', accepted: [{ line: 1, fen: 1000 }] },
      { id: 'K2', pack: '渠西站/X7', invoice: 'T77', accepted: [{ line: 1, fen: 2000 }] },
    ],
    withdrawn: [],
    replacement: [],
    awards: [],
  };
  const out = buildLines({
    snapshot,
    registry: { T77: { id: 'T77', kind: 'invoice', loc: '/billing/T77', lines: [{ no: 1, fen: 3000 }] } },
    voids: {},
    quotes: {},
  });
  const line = out.lines[0];
  assert.ok(line.flags.some(flag => flag.code === 'pack-ambiguous'));
  assert.equal(line.status, 'disputed');
  assert.equal(line.packKey, null);
});

test('原件校验不一致时拒绝作为付款依据', async () => {
  const base = structuredClone(release('首发').routes);
  base['/billing/register'].rows[0].sha256 = '0'.repeat(64);
  const desk = createDesk({
    source: fixtureSource({ name: 'tampered', routes: base }),
    store: tempStore('tampered'),
    claims: requests,
  });
  await desk.scan();
  await expectFail(desk.document('T77', { village: '蓝湾', review: true }), 'ORIGINAL_HASH_MISMATCH');
  const line = desk.line('T77', 1);
  assert.equal(line.status, 'ready');
});

test('村级经办人只在轮到时领原件，另一村可继续用不共享资料', async () => {
  const desk = await deskFor('首发');
  // 蓝湾 has a ready claim on T77, so it is its turn.
  const fetched = await desk.document('T77', { village: '蓝湾' });
  assert.equal(fetched.paymentGrade, true);
  // 橙湾 has no confirmation on T77#2-only work; T77 has an orange entitlement,
  // so a claim on T77 (村请B) still makes it their turn.
  const orange = await desk.document('T77', { village: '橙湾' });
  assert.equal(orange.paymentGrade, true);
  const villageDesk = await deskFor('首发', { actorVillage: '蓝湾' });
  await expectFail(villageDesk.document('T77', { village: '橙湾' }), 'OUT_OF_SCOPE');
});

test('查一项抢修用在几笔付款或退回里', async () => {
  const desk = await deskFor('首发');
  const blue = desk.confirm('村请A', { split: true });
  desk.pay(blue.confirmation.id);
  const rows = desk.usage({ pack: '渠东站/X7' });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].confirmations.length, 1);
  assert.equal(rows[0].netPaidFen, 26400);
  assert.equal(rows[1].netPaidFen, 0);
  // The same device name on the west station is a different pack.
  const west = desk.usage({ pack: '渠西站/X7' });
  assert.equal(west.length, 1);
  assert.equal(west[0].invoice, 'T78');
});

test('重复转载报价不抬价，也不生成第二份可付金额', async () => {
  const desk = await deskFor('首发');
  await desk.scan();
  assert.equal(Object.keys(desk.state.catalogue.quotes).length, 1);
  const t77 = desk.catalogue().find(entry => entry.id === 'T77');
  assert.equal(t77.poolFen, undefined);
  assert.equal(t77.lines[0].poolFen, 64000);
  assert.equal(desk.state.catalogue.quoteDuplicates?.length ?? 0, 0);
});

test('作废票号在同一目录里重开仍按作废处理并留下次数', async () => {
  const base = structuredClone(release('票据作废').routes);
  // The issuer accidentally lists T77 as an invoice again alongside the void row.
  base['/billing/register?cursor=b'].rows = [
    ...base['/billing/register?cursor=b'].rows,
    {
      id: 'T77', issuer: '维修站', loc: '/billing/T77', kind: 'invoice',
      lines: [{ no: 1, fen: 64000 }, { no: 2, fen: 16000 }],
    },
  ];
  const desk = createDesk({
    source: fixtureSource({ name: 'reopen', routes: base }),
    store: tempStore('reopen'),
    claims: requests,
  });
  await desk.scan();
  assert.equal(desk.line('T77', 1).status, 'invalid');
  assert.equal(desk.state.catalogue.reopenAttempts[0].id, 'T77');
  await desk.scan();
  assert.equal(desk.state.catalogue.reopenAttempts[0].times, 2);
  assert.equal(desk.line('T77', 1).status, 'invalid');
  assert.equal(desk.state.catalogue.invoices.T77, undefined);
});

test('同一笔旧维修被两张新票同时声称包含时进入争议，不重复抵销', () => {
  const base = structuredClone(release('复核来件').routes);
  base['/town/acceptance'].replacement = [
    ...base['/town/acceptance'].replacement,
    {
      pack: '渠东站/X7', invoice: 'T79', line: 1,
      includesInvoice: 'T77', includesLine: 1, includesFen: 25000,
    },
    { pack: '渠东站/X7', invoice: 'T77', line: 2, includesInvoice: 'T77', includesLine: 1, includesFen: 5000 },
  ];
  // T77#2 must also exist as a face line; it does (16000).
  const snapshot = {
    packs: base['/management/packs'].packs,
    updates: base['/management/packs'].updates,
    events: base['/town/acceptance'].events,
    withdrawn: base['/town/acceptance'].withdrawn,
    replacement: base['/town/acceptance'].replacement,
    awards: base['/insurer/awards'].awards,
  };
  const registry = {};
  for (const row of [...base['/billing/register'].rows, ...base['/billing/register?cursor=b'].rows]) {
    if (row.kind === 'invoice') registry[row.id] = row;
  }
  const out = buildLines({ snapshot, registry, voids: {}, quotes: {} });
  const old = out.lines.find(line => line.key === 'T77#1');
  assert.ok(old.flags.some(flag => flag.code === 'replacement-overlap'));
  assert.equal(old.status, 'disputed');
});

test('验收指向票面没有的行时争议，不能凭空结款', () => {
  const base = structuredClone(release('首发').routes);
  base['/town/acceptance'].events[0].accepted.push({ line: 9, fen: 1000 });
  const desk = createDesk({
    source: fixtureSource({ name: 'ghost', routes: base }),
    store: tempStore('ghost'),
    claims: requests,
  });
  return desk.scan().then(() => {
    const line = desk.line('T77', 9);
    assert.ok(line);
    assert.ok(line.flags.some(flag => flag.code === 'line-not-on-invoice'));
    assert.equal(line.status, 'disputed');
  });
});

test('重复扫描不改变已确认金额，账本可重开', async () => {
  const path = join(tmpdir(), 'desk-idempotent-' + process.pid + '-' + Math.random().toString(16).slice(2) + '.json');
  const store = openStore(path);
  const desk = createDesk({ source: fixtureSource(release('首发')), store, claims: requests });
  await desk.scan();
  const confirmed = desk.confirm('村请A', { split: true });
  const before = structuredClone(store.state.confirmations);
  await desk.scan();
  await desk.scan();
  assert.deepEqual(store.state.confirmations, before);
  assert.equal(confirmed.confirmation.fen, 26400);

  // Reopen the same file and keep working: counters and confirmations persist.
  const reopened = createDesk({
    source: fixtureSource(release('首发')),
    store: openStore(path),
    claims: requests,
  });
  assert.equal(reopened.confirmations().length, 1);
  assert.equal(reopened.confirmations()[0].fen, 26400);
  rmSync(path, { force: true });
});

test('异议记录暂时压住对应票据行，解决后恢复', async () => {
  const base = structuredClone(release('首发').routes);
  base['/town/acceptance'].objections = [
    { id: 'O1', invoice: 'T77', line: 1, by: '橙湾', reason: '擅自扩大抢修范围' },
  ];
  const source = mutableSource(base);
  const desk = createDesk({ source: source.source, store: tempStore('objection'), claims: requests });
  await desk.scan();
  const line = desk.line('T77', 1);
  assert.equal(line.status, 'disputed');
  assert.ok(line.flags.some(flag => flag.code === 'objection-filed'));
  const claim = desk.claims('蓝湾').find(entry => entry.claim.ref === '村请A');
  assert.equal(claim.status, 'disputed');
  assert.equal(claim.confirmableFen, 0);
  // 橙湾's other invoice is not held by this objection.
  const other = desk.claims('橙湾').find(entry => entry.claim.ref === '村请C');
  assert.equal(other.status, 'ready');

  const cleared = structuredClone(base);
  delete cleared['/town/acceptance'].objections;
  source.set(cleared);
  const result = await desk.scan();
  assert.ok(result.changed >= 1);
  assert.equal(desk.line('T77', 1).status, 'ready');
  assert.equal(desk.confirm('村请A', { split: true }).confirmation.fen, 26400);
});

test('撤回指向不存在的验收行时不静默吞掉', () => {
  const base = structuredClone(release('复核来件').routes);
  base['/town/acceptance'].withdrawn.push({ acceptance: 'K9', line: 1, fen: 1000 });
  const snapshot = {
    packs: base['/management/packs'].packs,
    updates: base['/management/packs'].updates,
    events: base['/town/acceptance'].events,
    withdrawn: base['/town/acceptance'].withdrawn,
    replacement: base['/town/acceptance'].replacement,
    awards: base['/insurer/awards'].awards,
  };
  const registry = {};
  for (const row of [...base['/billing/register'].rows, ...base['/billing/register?cursor=b'].rows]) {
    if (row.kind === 'invoice') registry[row.id] = row;
  }
  const out = buildLines({ snapshot, registry, voids: {}, quotes: {} });
  assert.ok(out.unappliedWithdrawals.some(entry => entry.ref === 'K9'));
  // Applied withdrawals are not double-listed.
  assert.ok(!out.unappliedWithdrawals.some(entry => entry.ref === 'K1'));
});

test('后续换件已全额抵销时申请标为抵销，不能再结', async () => {
  const store = tempStore('offset');
  const base = structuredClone(release('首发').routes);
  const desk = createDesk({ source: fixtureSource({ name: 'o', routes: base }), store, claims: requests });
  await desk.scan();

  const next = structuredClone(base);
  next['/town/acceptance'].replacement = [{
    pack: '渠东站/X7', invoice: 'T79', line: 1,
    includesInvoice: 'T77', includesLine: 1, includesFen: 64000,
  }];
  next['/billing/register?cursor=b'].rows = [{
    id: 'T79', issuer: '维修站', loc: '/billing/T79', kind: 'invoice',
    lines: [{ no: 1, fen: 90000 }],
  }];
  const source = mutableSource(next);
  const desk2 = createDesk({ source: source.source, store, claims: requests });
  await desk2.scan();
  const line = desk2.line('T77', 1);
  assert.equal(line.status, 'no-claimable');
  const claim = desk2.claims('蓝湾').find(entry => entry.claim.ref === '村请A');
  assert.equal(claim.status, 'no-claimable');
  await expectFail(Promise.resolve().then(() => desk2.confirm('村请A', { split: true })), 'CLAIM_NO_CLAIMABLE');
  const progress = desk2.progress('蓝湾');
  assert.equal(progress.find(entry => entry.claim === '村请A').phase, 'offset-by-replacement');
});

test('本村份额用尽后申请标为额度用尽，不再生成可确认额', async () => {
  const desk = await deskFor('首发');
  desk.confirm('村请A', { split: true });
  const claim = desk.claims('蓝湾').find(entry => entry.claim.ref === '村请A');
  assert.equal(claim.status, 'exhausted');
  assert.equal(claim.confirmableFen, 0);
  const progress = desk.progress('蓝湾');
  assert.equal(progress[0].phase, 'entitlement-exhausted');
});

test('公开地址来源完成同样的收件与核销', async t => {
  const { openOrigin } = await import('../origin/test-origin.mjs');
  const { httpSource } = await import('../src/source.mjs');
  const base = await openOrigin(t);
  await fetch(base + '/_desk/releases/' + encodeURIComponent('首发'), { method: 'POST' });
  const desk = createDesk({ source: httpSource(base), store: tempStore('http'), claims: requests });
  const scan = await desk.scan();
  assert.equal(scan.lines, 3);
  assert.equal(desk.line('T77', 1).entitlements['蓝湾'], 26400);
  const document = await desk.document('T77', { village: '蓝湾', review: true });
  assert.match(document.text, /泵体应急修复/);
  assert.equal(document.paymentGrade, true);
  // A source that disappears (404) surfaces as a source failure rather than
  // silently producing an empty ledger.
  await fetch(base + '/_desk/releases/' + encodeURIComponent('票据作废'), { method: 'POST' });
  await desk.scan();
  assert.equal(desk.line('T77', 1).status, 'invalid');
});

test('已确认未付款的票被作废时扣回并留痕，其他票不受影响', async () => {
  const store = tempStore('void-adjust');
  const base = release('首发').routes;
  const source = mutableSource(base);
  const desk = createDesk({ source: source.source, store, claims: requests });
  await desk.scan();
  const blue = desk.confirm('村请A', { split: true });
  const other = desk.confirm('村请C');
  assert.equal(blue.confirmation.fen, 26400);

  const voided = structuredClone(release('票据作废').routes);
  source.set(voided);
  const result = await desk.scan();
  assert.ok(result.adjustments >= 1);
  const adjusted = store.state.confirmations.find(entry => entry.id === blue.confirmation.id);
  assert.equal(adjusted.fen, 0);
  assert.equal(adjusted.status, 'held');
  assert.ok(adjusted.history.at(-1).reasons.includes('payment-basis-invalid'));
  const untouched = store.state.confirmations.find(entry => entry.id === other.confirmation.id);
  assert.equal(untouched.fen, 24000);
  assert.equal(untouched.status, 'confirmed');
});

test('已划款的票被作废时生成全额反向核销，原责任方与依据齐全', async () => {
  const store = tempStore('void-reverse');
  const base = release('首发').routes;
  const source = mutableSource(base);
  const desk = createDesk({ source: source.source, store, claims: requests });
  await desk.scan();
  const blue = desk.confirm('村请A', { split: true });
  desk.pay(blue.confirmation.id);
  const other = desk.confirm('村请C');
  desk.pay(other.confirmation.id);

  source.set(structuredClone(release('票据作废').routes));
  const result = await desk.scan();
  assert.equal(result.reversalsOpened, 1);
  const reversal = desk.reversals().find(entry => entry.status === 'open');
  assert.equal(reversal.fen, 26400);
  assert.equal(reversal.originalResponsibleParty, '蓝湾');
  assert.equal(reversal.village, '蓝湾');
  assert.ok(reversal.reasons.includes('payment-basis-invalid'));
  assert.ok(reversal.originalBasis.length > 0);
  assert.ok(reversal.currentBasis.some(item => item.kind === 'void'));
  // The untouched invoice's payment is not reversed.
  assert.equal(desk.reversals('橙湾').length, 0);
  const usage = desk.usage({ invoice: 'T77', line: 1 })[0];
  assert.equal(usage.openReversalFen, 26400);
});

test('目录有票但缺原件位置时等签发方补原件，不当作可结', async () => {
  const base = structuredClone(release('首发').routes);
  delete base['/billing/register'].rows[0].loc;
  const desk = createDesk({
    source: fixtureSource({ name: 'no-loc', routes: base }),
    store: tempStore('no-loc'),
    claims: requests,
  });
  await desk.scan();
  const line = desk.line('T77', 1);
  assert.equal(line.status, 'awaiting-material');
  assert.equal(line.waitingFor, 'issuer-original');
  assert.ok(line.flags.some(flag => flag.code === 'original-missing'));
  const claim = desk.claims('蓝湾').find(entry => entry.claim.ref === '村请A');
  assert.equal(claim.status, 'awaiting-material');
  assert.equal(claim.confirmableFen, 0);
});

test('份额合计不等于万分时进入争议，不出可确认额', () => {
  const base = structuredClone(release('首发').routes);
  base['/management/packs'].packs[0].shares = [
    { village: '蓝湾', bp: 6000 },
    { village: '橙湾', bp: 3000 },
  ];
  const snapshot = {
    packs: base['/management/packs'].packs,
    updates: base['/management/packs'].updates ?? [],
    events: base['/town/acceptance'].events,
    withdrawn: base['/town/acceptance'].withdrawn ?? [],
    replacement: base['/town/acceptance'].replacement ?? [],
    awards: base['/insurer/awards'].awards,
  };
  const registry = {};
  for (const row of [...base['/billing/register'].rows, ...base['/billing/register?cursor=b'].rows]) {
    if (row.kind === 'invoice') registry[row.id] = row;
  }
  const out = buildLines({ snapshot, registry, voids: {}, quotes: {} });
  const line = out.lines.find(entry => entry.key === 'T77#1');
  assert.ok(line.flags.some(flag => flag.code === 'shares-conflict'));
  assert.equal(line.status, 'disputed');
  assert.deepEqual(line.entitlements, { 橙湾: 0, 蓝湾: 0 });
});
