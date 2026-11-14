import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { recallHarness } from '../../support/fixtures/recall-harness.mjs';
import { deferred, replace } from '../../support/fixtures/control.mjs';
import { human } from '../../support/fixtures/scripted-model.mjs';

/** Real 15/55/60-second wall-clock evidence, with isolated long-running probes. */
export async function verifyRecallDeadlines(ctx) {
  assert.deepEqual([ctx.recallTools.config.prepareMs, ctx.recallTools.config.businessMs, ctx.recallTools.config.outerMs], [15000, 55000, 60000]);
  const h = recallHarness(ctx), evidence = {};
  const prep = (await h.seed('deadline-preparation')).agent, business = (await h.seed('deadline-business')).agent, outer = (await h.seed('deadline-native-outer')).agent;
  const outerRef = (await h.search(outer)).value.items[0].ref;
  const entered = deferred(), release = deferred(), businessEntered = deferred(), outerEntered = deferred();
  const observe = ctx.recallHistory.withSnapshot.bind(ctx.recallHistory), match = ctx.recallTools.search.matcher.match.bind(ctx.recallTools.search.matcher), read = ctx.recallTools.read.run.bind(ctx.recallTools.read);
  const undos = [
    replace(ctx.recallHistory, 'withSnapshot', async (id, ...args) => { if (id === prep.id) { entered.resolve(); await release.promise; } return observe(id, ...args); }),
    replace(ctx.recallTools.search.matcher, 'match', async (...args) => {
      if (args[0].origin.sessionId !== business.id) return match(...args);
      const timeline = args[2];
      businessEntered.resolve();
      await new Promise(resolve => timeline.signal.addEventListener('abort', resolve, { once: true }));
      evidence.business = { elapsedMs: timeline.elapsed(), started: timeline.started, reason: timeline.signal.reason.code };
      timeline.check();
    }),
    replace(ctx.recallTools.read, 'run', async (request, exec, reservation, timeline) => {
      if (exec.agent.id !== outer.id) return read(request, exec, reservation, timeline);
      outerEntered.resolve();
      timeline.signal.addEventListener('abort', () => { evidence.outerBusinessStop = { elapsedMs: timeline.elapsed(), nativeSignalAborted: exec.signal.aborted }; }, { once: true });
      // Deliberately uncooperative test-only body, so native 60s replacement can be observed.
      await new Promise(resolve => exec.signal.addEventListener('abort', resolve, { once: true }));
      evidence.outerNativeStop = { elapsedMs: timeline.elapsed(), code: exec.signal.reason.code };
      timeline.check();
    }),
  ];
  try {
    // Start both long bodies before holding the shared preparation worker.
    // Otherwise the 15s probe can legitimately time out the unrelated search's preparation too.
    const work = h.search(business).then(result => { assert.equal(result.value.code, 'business_deadline'); assert.equal(result.value.status, 'incomplete'); assert.deepEqual(result.value.items, []); evidence.business.budget = result.value.budget; console.log('PASS: default 55s monotonic business deadline returns incomplete with retained charge'); });
    await businessEntered.promise;
    const native = h.read(outer, outerRef, human('native outer probe')).then(result => { assert.equal(result.data.message.isError, true); assert.equal(result.data.error.code, 'TOOL_TIMEOUT'); evidence.outerCode = result.data.error.code; console.log('PASS: default native 60s wrapper aborts/drains the body and replaces the component result'); });
    await outerEntered.promise;
    const start = performance.now();
    const preparation = h.search(prep).then(async result => {
      assert.equal(result.value.code, 'preparation_timeout'); assert.equal(result.value.scanComplete, false);
      const status = ctx.recallPreparation.status(prep.id); assert.equal(status.waiters, 0); assert.equal(status.state, 'preparing');
      evidence.preparation = { elapsedMs: performance.now() - start, budget: result.value.budget, sharedPreparationRetained: true };
      release.resolve(); await ctx.recallPreparation.wait(prep.id, AbortSignal.timeout(5000));
      console.log('PASS: default 15s preparation wait ends without cancelling shared preparation');
    });
    await entered.promise;
    await Promise.all([preparation, work, native]);
    assert.ok(evidence.preparation.elapsedMs >= 14900 && evidence.preparation.elapsedMs < 20000);
    assert.ok(evidence.business.elapsedMs >= 54900 && evidence.business.elapsedMs < 59000);
    assert.equal(evidence.outerBusinessStop.nativeSignalAborted, false);
    assert.ok(evidence.outerNativeStop.elapsedMs >= 59900 && evidence.outerNativeStop.elapsedMs < 65000);
    evidence.cleanupMarginMs = evidence.outerNativeStop.elapsedMs - evidence.outerBusinessStop.elapsedMs;
    assert.equal(ctx.recallTools.search.matcher.stats().active, 0); assert.ok(ctx.recallTools.search.matcher.children.size <= 2);
  } finally { release.resolve(); undos.reverse().forEach(undo => undo()); await h.dispose(); }
  const output = join(process.env.DSH_HOME, '..', 'deadline-evidence.json'); await writeFile(output, JSON.stringify(evidence, null, 2)); console.log(`Default deadline evidence: ${output}`);
}
