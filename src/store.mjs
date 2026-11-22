import { existsSync } from 'node:fs';
import { atomicWriteJson, readJson, fail } from './util.mjs';

const VERSION = 1;

export function emptyState() {
  return {
    version: VERSION,
    createdAt: new Date().toISOString(),
    updatedAt: null,
    scans: [],
    register: { byId: {}, pages: 0 },
    catalogue: { invoices: {}, quotes: {}, voids: {} },
    documents: {},
    confirmations: [],
    reversals: [],
    budgets: {},
    closing: {},
    counters: { scan: 0, receipt: 0, confirmation: 0, reversal: 0, audit: 0 },
    receipts: [],
    audit: [],
    source: null,
  };
}

/**
 * A file-backed desk state. Every mutation goes through `save()`; writes are
 * atomic so an interrupted run leaves the previous snapshot intact.
 */
export function openStore(path) {
  let state;
  if (path && existsSync(path)) {
    state = readJson(path);
    if (state.version !== VERSION) fail('STATE_VERSION', '账本版本不认识', { version: state.version });
    state.catalogue ??= { invoices: {}, quotes: {}, voids: {} };
    state.register ??= { byId: {}, pages: 0 };
    state.documents ??= {};
    state.confirmations ??= [];
    state.reversals ??= [];
    state.budgets ??= {};
    state.closing ??= {};
    state.counters ??= { scan: 0, receipt: 0, confirmation: 0, reversal: 0, audit: 0 };
    state.receipts ??= [];
    state.audit ??= [];
    state.scans ??= [];
  } else {
    state = emptyState();
  }
  let dirty = false;
  function save() {
    if (!path) return;
    state.updatedAt = new Date().toISOString();
    atomicWriteJson(path, state);
    dirty = false;
  }
  return {
    state,
    get dirty() { return dirty; },
    touch() { dirty = true; },
    save,
    next(kind) {
      state.counters[kind] = (state.counters[kind] ?? 0) + 1;
      return state.counters[kind];
    },
    receipt(entry) {
      const id = 'R' + String(this.next('receipt')).padStart(5, '0');
      const record = { id, at: new Date().toISOString(), ...entry };
      state.receipts.push(record);
      return record;
    },
    audit(entry) {
      const seq = this.next('audit');
      const record = { seq, at: new Date().toISOString(), ...entry };
      state.audit.push(record);
      return record;
    },
  };
}
