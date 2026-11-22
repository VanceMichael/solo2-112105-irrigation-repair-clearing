import { asArray, fail, fen, compareText } from './util.mjs';

/**
 * A programme source is anything that exposes the synthetic HTTP surface the
 * desk reads: /management/packs, /town/acceptance, /insurer/awards and the
 * paged /billing/register. `client` only ever performs GETs.
 */
export function httpSource(base) {
  const root = String(base).replace(/\/+$/, '');
  async function get(path) {
    const response = await fetch(root + path);
    if (response.status === 404) return null;
    if (!response.ok) fail('SOURCE_FAILED', '来源读取失败', { path, status: response.status });
    return response;
  }
  return {
    base: root,
    async packs() {
      const response = await get('/management/packs');
      return response ? response.json() : null;
    },
    async acceptance() {
      const response = await get('/town/acceptance');
      return response ? response.json() : null;
    },
    async awards() {
      const response = await get('/insurer/awards');
      return response ? response.json() : null;
    },
    async register() {
      const rows = [];
      const cursors = new Set();
      let cursor = null;
      for (;;) {
        const path = '/billing/register' + (cursor == null ? '' : '?cursor=' + encodeURIComponent(cursor));
        const response = await get(path);
        if (!response) fail('REGISTER_BROKEN', '目录缺少这一页', { cursor });
        const page = await response.json();
        rows.push(...asArray(page.rows));
        const next = page.next;
        if (next == null) break;
        if (cursors.has(next)) fail('REGISTER_LOOP', '目录分页重复', { cursor: next });
        cursors.add(next);
        cursor = next;
      }
      return rows;
    },
    /** Original document bytes, or null when the register has no loc. */
    async document(loc) {
      if (!loc) return null;
      const response = await get(loc);
      if (!response) return null;
      return {
        loc,
        contentType: response.headers.get('content-type') ?? '',
        body: Buffer.from(await response.arrayBuffer()),
      };
    },
  };
}

/**
 * Deterministic in-process source over one release from exchange.json. Used by
 * the tests and by `npm run desk -- --sample`.
 */
export function fixtureSource(release) {
  const routes = release.routes;
  const pick = path => (routes[path] && !routes[path].mime ? structuredClone(routes[path]) : null);
  return {
    base: 'fixture:' + release.name,
    name: release.name,
    async packs() { return pick('/management/packs'); },
    async acceptance() { return pick('/town/acceptance'); },
    async awards() { return pick('/insurer/awards'); },
    async register() {
      const rows = asArray(pick('/billing/register')?.rows);
      let next = pick('/billing/register')?.next ?? null;
      const seen = new Set();
      while (next != null && !seen.has(next)) {
        seen.add(next);
        const page = pick('/billing/register?cursor=' + encodeURIComponent(next));
        rows.push(...asArray(page?.rows));
        next = page?.next ?? null;
      }
      return rows;
    },
    async document(loc) {
      const spec = loc ? routes[loc] : null;
      if (!spec || !spec.mime) return null;
      return { loc, contentType: spec.mime, body: Buffer.from(spec.text, 'utf8') };
    },
  };
}

/** Shapes the three raw payloads into one card the rest of the desk reads. */
export async function collect(source) {
  const [packs, acceptance, awards, register] = await Promise.all([
    source.packs(),
    source.acceptance(),
    source.awards(),
    source.register(),
  ]);
  return {
    packs: asArray(packs?.packs),
    updates: asArray(packs?.updates),
    events: asArray(acceptance?.events),
    withdrawn: asArray(acceptance?.withdrawn),
    replacement: asArray(acceptance?.replacement),
    objections: asArray(acceptance?.objections),
    awards: asArray(awards?.awards),
    register: asArray(register),
  };
}

export function packKey(issuer, id) {
  return String(issuer) + '/' + String(id);
}

export function splitPackKey(value) {
  const text = String(value ?? '');
  const at = text.indexOf('/');
  if (at <= 0 || at === text.length - 1) return null;
  return { issuer: text.slice(0, at), id: text.slice(at + 1) };
}

export function normalisePacks(packs) {
  const seen = new Map();
  const out = [];
  for (const pack of asArray(packs)) {
    if (!pack || typeof pack.issuer !== 'string' || typeof pack.id !== 'string') {
      fail('PACK_MALFORMED', '工作包缺少签发方或编号', { pack });
    }
    const key = packKey(pack.issuer, pack.id);
    if (seen.has(key)) fail('PACK_DUPLICATE', '同一签发方的工作包编号重复', { pack: key });
    const shares = asArray(pack.shares).map(share => ({
      village: share.village,
      bp: fen(share.bp),
    }));
    if (shares.some(share => !share.village || share.bp == null || share.bp < 0)) {
      fail('SHARE_MALFORMED', '管护份额无效', { pack: key });
    }
    const normal = {
      key,
      issuer: pack.issuer,
      id: pack.id,
      device: pack.device ?? '',
      date: pack.date ?? null,
      reach: pack.reach ?? null,
      shares,
    };
    seen.set(key, normal);
    out.push(normal);
  }
  return out;
}

/**
 * Shares effective for a repair date. An update takes effect from `fromDate`
 * inclusive and only for the reach it names; the latest applicable update wins.
 * A village absent from a later update has a zero share from then on.
 */
export function sharesAt(pack, updates, date = pack.date) {
  let shares = pack.shares;
  let chosen = null;
  for (const update of asArray(updates)) {
    if (!update || update.reach !== pack.reach) continue;
    const from = String(update.fromDate ?? '');
    if (!from || from > String(date ?? '')) continue;
    if (chosen == null || from > String(chosen.fromDate)) chosen = update;
  }
  if (chosen) {
    shares = asArray(chosen.shares);
  }
  const list = asArray(shares)
    .map(share => ({ village: share.village, bp: fen(share.bp) ?? 0 }))
    .filter(share => share.village && share.bp > 0);
  const total = list.reduce((sum, share) => sum + share.bp, 0);
  return { shares: list, totalBp: total, update: chosen?.fromDate ?? null };
}

/**
 * Allocates an integer number of fen across weighted parties so the sum is
 * exact. Any remainder fen go to the largest share first; equal shares are
 * decided by village identifier order.
 */
export function allocate(totalFen, weights) {
  const items = weights.filter(item => item.bp > 0);
  const sumBp = items.reduce((sum, item) => sum + item.bp, 0);
  const result = new Map();
  if (totalFen <= 0 || sumBp <= 0) {
    for (const item of items) result.set(item.village, 0);
    return result;
  }
  const base = items.map(item => ({
    village: item.village,
    bp: item.bp,
    part: Math.floor((totalFen * item.bp) / sumBp),
  }));
  let left = totalFen - base.reduce((sum, item) => sum + item.part, 0);
  const ordered = [...base].sort((a, b) => b.bp - a.bp || compareText(a.village, b.village));
  for (const item of ordered) {
    if (left <= 0) break;
    item.part += 1;
    left -= 1;
  }
  for (const item of base) result.set(item.village, item.part);
  return result;
}
