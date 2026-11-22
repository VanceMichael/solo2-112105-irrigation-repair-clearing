import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export class DeskError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'DeskError';
    this.code = code;
    this.details = details;
  }
}

export function fail(code, message, details) {
  throw new DeskError(code, message, details);
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map(key => JSON.stringify(key) + ':' + stableStringify(value[key])).join(',') + '}';
}

export function digest(value) {
  return sha256(stableStringify(value));
}

/**
 * Village and invoice identifiers sort naturally: digit runs compare as
 * numbers, then a stable Chinese collation, then raw code points. The same
 * order is used for ties in remainder allocation.
 */
const collator = (() => {
  try {
    return new Intl.Collator('zh-Hans-CN', { numeric: true, sensitivity: 'variant' });
  } catch {
    return null;
  }
})();

function chunk(text) {
  return String(text).match(/\d+|\D+/g) ?? [''];
}

export function compareText(a, b) {
  const left = String(a);
  const right = String(b);
  const aa = chunk(left);
  const bb = chunk(right);
  for (let i = 0; i < Math.min(aa.length, bb.length); i += 1) {
    const x = aa[i];
    const y = bb[i];
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) {
      const diff = Number(x) - Number(y);
      if (diff !== 0) return diff < 0 ? -1 : 1;
    } else {
      const order = collator ? collator.compare(x, y) : (x < y ? -1 : x > y ? 1 : 0);
      if (order !== 0) return order < 0 ? -1 : 1;
    }
  }
  if (aa.length !== bb.length) return aa.length < bb.length ? -1 : 1;
  return left < right ? -1 : left > right ? 1 : 0;
}

export function fen(value) {
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : null;
}

export function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function atomicWriteJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = path + '.' + process.pid + '.tmp';
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
  renameSync(tmp, path);
}

export function asArray(value) {
  return Array.isArray(value) ? value : [];
}
