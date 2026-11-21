import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

import { openOrigin } from './test-origin.mjs';

const { releases } = JSON.parse(readFileSync(new URL('../sources/exchange.json', import.meta.url)));
const requests = JSON.parse(readFileSync(new URL('../sources/requests.json', import.meta.url)));


test('资料站的发布切换、目录和原件', async t => {
  const base = await openOrigin(t);
  assert.ok(Object.keys(requests).length);
  const overview = await fetch(base + '/_desk/releases').then(r => r.json());
  assert.deepEqual(overview.available, releases.map(x => x.name));

  for (const { name, routes } of releases) {
    const release = await fetch(base + '/_desk/releases/' + encodeURIComponent(name), { method: 'POST' });
    assert.equal(release.status, 200);
    const routeFailure = await fetch(base + '/not-listed-source');
    assert.equal(routeFailure.status, 404);
    for (const [path, spec] of Object.entries(routes)) {
      const response = await fetch(base + path);
      assert.equal(response.status, spec.status ?? 200, path);
      if (spec.layout) {
        assert.match(response.headers.get('content-type'), /^text\/html/);
        assert.ok((await response.text()).includes('<h1>'));
      } else if (spec.mime) {
        assert.equal(response.headers.get('content-type'), spec.mime);
        assert.equal(await response.text(), spec.text);
      } else {
        assert.deepEqual(await response.json(), spec, path);
      }
    }

    for (const route of Object.values(routes)) {
      const checksums = [];
      if (route.reports) checksums.push(...route.reports.map(x => [x.file, x.sha256]));
      if (route.images) checksums.push(...route.images.map(x => [x.ref, x.sha256]));
      if (route.files) checksums.push(...route.files.map(x => [x.ref, x.sha256]));
      if (route.downloads) checksums.push(...route.downloads.map(x => [x.href, x.sha]));
      if (route.rows) checksums.push(...route.rows.filter(x => x.sha256).map(x => [x.loc, x.sha256]));
      for (const [ref, digest] of checksums) {
        assert.ok(routes[ref], ref);
        if ((routes[ref].status ?? 200) !== 200) continue;
        assert.match(digest, /^[0-9a-f]{64}$/);
        const body = await fetch(base + ref).then(r => r.arrayBuffer());
        assert.equal(createHash('sha256').update(Buffer.from(body)).digest('hex'), digest, ref);
      }
    }
  }
});

test('来源的关键记录可实际领取', async t => {
  const base = await openOrigin(t);
  {
    const release = await fetch(base + '/_desk/releases/' + encodeURIComponent("首发"), { method: 'POST' });
    assert.equal(release.status, 200);
    const r = await fetch(base + "/billing/register?cursor=b");
    assert.equal((await r.json()).rows[0].kind, 'quote');
  }
  {
    const release = await fetch(base + '/_desk/releases/' + encodeURIComponent("复核来件"), { method: 'POST' });
    assert.equal(release.status, 200);
    const r = await fetch(base + "/town/acceptance");
    assert.equal((await r.json()).replacement[0].includesInvoice, 'T77');
  }
  {
    const release = await fetch(base + '/_desk/releases/' + encodeURIComponent("复核来件"), { method: 'POST' });
    assert.equal(release.status, 200);
    const r = await fetch(base + "/management/packs");
    assert.ok((await r.json()).updates[0].fromDate > '2026-11-18');
  }
  {
    const release = await fetch(base + '/_desk/releases/' + encodeURIComponent("票据作废"), { method: 'POST' });
    assert.equal(release.status, 200);
    const r = await fetch(base + "/billing/register?cursor=b");
    assert.equal((await r.json()).rows.find(x => x.kind === 'void').voids, 'T77');
  }
});
