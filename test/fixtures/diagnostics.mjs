import assert from 'node:assert/strict';
import { deferred, replace } from '../../support/fixtures/control.mjs';

export function failed(result, code) {
  assert.equal(result.isError, true, JSON.stringify(result));
  assert.equal(result.error.info?.code, code, JSON.stringify(result));
}

/** A pending optional fiber is not the same as a ready injected service. */
export async function waitForDiagnostics(ctx) {
  const reached = deferred();
  const ready = ctx.inject(['recallDiagnostics'], () => { reached.resolve(); });
  try { await reached.promise; } finally { await ready.dispose(); }
}

/** Reload onto a wrapped *real* JSON unit; all non-faulted writes still fsync. */
export async function interceptLedgerWrites(ctx, intercept) {
  const backend = ctx.storage.backend.get('json');
  const open = backend.kv.open.bind(backend.kv);
  const restore = replace(backend.kv, 'open', async descriptor => {
    const unit = await open(descriptor);
    if (descriptor.name === 'dsh_recall_diagnostics') {
      const put = unit.putRecord.bind(unit);
      replace(unit, 'putRecord', (table, key, value) => intercept(value, () => put(table, key, value)));
    }
    return unit;
  });
  try { await [...ctx.loader.entries()].find(e => e.options.id === 'recall').fiber.restart(); await waitForDiagnostics(ctx); }
  finally { restore(); }
}
