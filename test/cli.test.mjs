import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openOrigin } from '../origin/test-origin.mjs';
import { main } from '../src/cli.mjs';

const requests = JSON.parse(readFileSync(new URL('../sources/requests.json', import.meta.url))).claims;

function harness() {
  const state = join(tmpdir(), 'cli-' + process.pid + '-' + Math.random().toString(16).slice(2) + '.json');
  const out = [];
  const err = [];
  async function run(args) {
    await main(['--state', state, '--claims', new URL('../sources/requests.json', import.meta.url).pathname, ...args], {
      out: value => out.push(String(value)),
      err: value => err.push(String(value)),
    });
    return out.at(-1);
  }
  async function runJson(args) {
    return JSON.parse(await run(['--json', ...args]));
  }
  return { state, run, runJson, out, err, cleanup: () => rmSync(state, { force: true }) };
}

async function switchRelease(base, name) {
  const response = await fetch(base + '/_desk/releases/' + encodeURIComponent(name), { method: 'POST' });
  assert.equal(response.status, 200);
}

test('命令行按发布切换走完收件、核销与撤回', async t => {
  const base = await openOrigin(t);
  const desk = harness();
  t.after(desk.cleanup);

  await switchRelease(base, '首发');
  const scan = await desk.runJson(['--source', base, 'scan']);
  assert.equal(scan.lines, 3);
  assert.equal(scan.changed, 3);

  const report = await desk.runJson(['--source', base, 'report']);
  assert.equal(report.confirmable.length, 3);
  assert.equal(report.disputed.length, 0);

  // Catalogue listing is one call; the original is another.
  const catalogue = await desk.runJson(['--source', base, 'catalogue', '--village', '蓝湾']);
  const t77 = catalogue.find(entry => entry.id === 'T77');
  assert.equal(t77.basis, 'invoice');
  assert.ok(t77.quote);

  const original = await desk.runJson(['--source', base, 'document', '--invoice', 'T77', '--village', '蓝湾']);
  assert.equal(original.paymentGrade, true);
  assert.match(original.text, /泵体应急修复/);

  // A full-invoice claim is refused unless the village confirms only its share.
  await assert.rejects(
    desk.run(['--source', base, 'confirm', '--ref', '村请A']),
    error => error.code === 'CLAIM_EXCEEDS_ENTITLEMENT',
  );
  const confirmed = await desk.runJson(['--source', base, 'confirm', '--ref', '村请A', '--split']);
  assert.equal(confirmed.confirmation.fen, 26400);
  const paid = await desk.runJson(['--source', base, 'pay', '--confirmation', confirmed.confirmation.id, '--ref', '付-1']);
  assert.equal(paid.confirmation.status, 'paid');

  const usage = await desk.runJson(['--source', base, 'usage', '--invoice', 'T77', '--line', '1']);
  assert.equal(usage[0].netPaidFen, 26400);
  assert.equal(usage[0].remainingByVillageFen['蓝湾'], 0);
  assert.equal(usage[0].remainingByVillageFen['橙湾'], 17600);

  // Next release: a partial withdrawal and an insurance correction arrive.
  await switchRelease(base, '复核来件');
  const rescanned = await desk.runJson(['--source', base, 'scan']);
  assert.equal(rescanned.reversalsOpened, 1);
  const reversals = await desk.runJson(['--source', base, 'reversals', '--village', '蓝湾']);
  assert.equal(reversals.length, 1);
  assert.equal(reversals[0].fen, 26400 - 6000); // 42000 - 7000 insurance = 35000; 60% = 21000
  assert.equal(reversals[0].originalResponsibleParty, '蓝湾');
  assert.ok(reversals[0].originalBasis.length > 0);

  const progress = await desk.runJson(['--source', base, 'progress']);
  const waiting = progress.find(entry => entry.claim === '村请C');
  assert.equal(waiting.phase, 'ready-to-confirm');
  const replacement = await desk.runJson(['--source', base, 'line', '--invoice', 'T79', '--line', '1']);
  assert.equal(replacement[0].status, 'awaiting-material');
  assert.equal(replacement[0].waitingFor, 'town-acceptance');
  const afterWithdrawal = await desk.runJson(['--source', base, 'claims', '--village', '橙湾']);
  assert.equal(afterWithdrawal.find(entry => entry.claim === '村请B').confirmableFen, 4000);

  // Void release: T77 becomes unpayable again and stays void across rescans.
  await switchRelease(base, '票据作废');
  await desk.runJson(['--source', base, 'scan']);
  const line = await desk.runJson(['--source', base, 'line', '--invoice', 'T77', '--line', '1']);
  assert.equal(line[0].status, 'invalid');
  const voids = await desk.runJson(['--source', base, 'report']);
  assert.equal(voids.catalogue.voids, 1);
  await assert.rejects(
    desk.run(['--source', base, 'document', '--invoice', 'T77', '--village', '蓝湾']),
    error => error.code === 'INVOICE_VOID',
  );
});

test('命令行拒绝越席与无凭据的领取', async t => {
  const base = await openOrigin(t);
  const desk = harness();
  t.after(desk.cleanup);
  await switchRelease(base, '首发');
  await desk.runJson(['--source', base, 'scan']);
  await assert.rejects(
    desk.run(['--source', base, 'document', '--invoice', 'T77', '--village', '外村']),
    error => error.code === 'NO_ENTITLEMENT',
  );
  await assert.rejects(
    desk.run(['--source', base, 'document', '--invoice', 'T78', '--village', '蓝湾']),
    error => error.code === 'NO_ENTITLEMENT',
  );
  const rows = await desk.runJson(['--source', base, 'claims']);
  assert.equal(rows.length, requests.length);
});
