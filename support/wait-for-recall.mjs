import { deferred, immediate } from './fixtures/control.mjs';

/** Adapter registration may remount dependent services; wait for the product entry. */
export async function waitForRecall(ctx) {
  await immediate();
  const reached = deferred();
  const ready = ctx.inject(['recallTools'], () => { reached.resolve(); });
  try { await reached.promise; } finally { await ready.dispose(); }
}
