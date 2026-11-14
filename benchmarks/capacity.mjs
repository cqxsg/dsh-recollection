import assert from 'node:assert/strict';
import { PerformanceObserver, constants } from 'node:perf_hooks';
import { writeHeapSnapshot } from 'node:v8';
import { loadRecallConfig, currentInteraction } from '../lib/index.js';
import { seedMatrixHistory } from './matrix.mjs';
import { makeCorpus, QUERIES, expectedIndexes, queryArgs } from './corpus.mjs';
import { recallHarness } from '../support/fixtures/recall-harness.mjs';
import { human, recovery } from '../support/fixtures/scripted-model.mjs';
import { replace } from '../support/fixtures/control.mjs';

/** Real native work only: bounded summaries never keep agents, events, results,
 * bodies or model request objects after their owning rotation has ended. */
export async function capacityTrial(ctx, spec, progress) {
  assert.equal(typeof global.gc === 'function', spec.gcDiagnostic, 'normal workload must not expose forced GC');
  const corpus = makeCorpus('mixed', spec.records), { records, ...manifest } = corpus, h = recallHarness(ctx), config = loadRecallConfig(spec.recall);
  const cacheLimitBytes = config.cacheMiB * 1024 ** 2;
  assert.equal(ctx.recallMemory.budget.limitBytes, cacheLimitBytes);
  const ids = Array.from({ length: spec.histories }, (_, i) => `capacity-history-${i}`), currentId = 'capacity-current';
  const windows = [], operations = [], generations = [], samples = [], gc = { count: 0, major: 0, durationMs: 0, windowMinPostCallbackHeap: null };
  const counters = { rounds: 0, groups: 0, searches: 0, reads: 0, preparations: 0, cancels: 0, reopened: 0, closed: 0, reloads: 0,
    matchedRecords: 0, maxNativeCalls: 0, maxWorkers: 0, maxQueued: 0, maxQueuedBytes: 0, maxLiveAgents: 0, maxNativeCold: 0,
    logicalPeakBytes: 0, memoryRejects: 0, evictions: 0, failedCalls: 0, discardedSamples: 0 };
  const failures = [], seen = new Set(), refs = new Map(), cleanup = {}, heapSnapshots = [];
  let large = [], small, active = 0, started = 0, ended = 0, round = 0, sequence = 0, registration, generation = 0;
  let stage = 'fixture', restoreMatch = () => {}, trackedMatcher, lastMemory, interval, heartbeat, offTools, registrationSerial = 0, reloading = false;
  let previousEvictions = 0, previousRejects = 0;
  const nativeCache = () => ({ size: ctx.sessionQuery._observations.cache.size, capacity: ctx.sessionQuery._observations.cacheCapacity,
    pinned: [...ctx.sessionQuery._observations.cache.values()].filter(row => row.refs).length });
  const memory = () => ctx.recallMemory.budget.stats();
  const update = () => {
    const m = memory(), p = ctx.recallTools.search.matcher.stats(), cold = nativeCache();
    counters.logicalPeakBytes = Math.max(counters.logicalPeakBytes, m.peakBytes);
    counters.evictions = previousEvictions + m.evictions; counters.memoryRejects = previousRejects + m.rejected;
    counters.maxWorkers = Math.max(counters.maxWorkers, p.live); counters.maxQueued = Math.max(counters.maxQueued, p.queued);
    counters.maxQueuedBytes = Math.max(counters.maxQueuedBytes, p.queuedBytes); counters.maxNativeCold = Math.max(counters.maxNativeCold, cold.size);
    counters.maxLiveAgents = Math.max(counters.maxLiveAgents, h.agents.length);
    assert.ok(m.usedBytes <= m.limitBytes); assert.ok(p.live <= 2 && p.queued <= 32 && p.queuedBytes <= 64 * 1024 ** 2);
    assert.ok(cold.size <= cold.capacity + cold.pinned);
    return { derived: m, pool: p, nativeCold: cold, holders: [...ctx.recallMemory.budget.owners.values()].map(owner => ({ id: owner.id,
      holders: [...owner.holders].map(holder => ({ label: holder.label, metadataBytes: holder.bytes, recordReferences: holder.records.size })) })) };
  };
  const snapshot = () => ({ mode: 'performance', suite: 'capacity', records: spec.records, histories: spec.histories, sourceDigest: corpus.sourceDigest, manifest,
    gcDiagnostic: spec.gcDiagnostic, cacheMiB: config.cacheMiB, cacheLimitBytes, durationTargetMs: spec.durationMs, workloadMs: started ? (ended || performance.now()) - started : 0,
    stage, counters, failures, windows, generations, samples, operations, gc: { ...gc }, finalState: lastMemory, cleanup, heapSnapshots,
    ownershipDefinition: 'Canonical object identity counted once across plugin holders; native observation LRU and live agents separately observed. No GC in normal run.',
    workloadDefinition: '20 fixed histories rotate through three large agents plus a small current agent; one incoming agent overlaps disposal of an outgoing agent. All queries scan complete frozen ranges. No idle padding.' });
  const bindMatch = () => {
    const matcher = ctx.recallTools.search.matcher;
    if (matcher === trackedMatcher) return;
    restoreMatch(); trackedMatcher = matcher;
    const original = matcher.match;
    matcher.match = async (...args) => { try { return await original.apply(matcher, args); } finally { counters.matchedRecords++; } };
    restoreMatch = () => { matcher.match = original; };
  };
  const phase = async name => { stage = name; bindMatch(); await progress(name, snapshot); };
  const view = closed => ctx.recallHost.reportView({ protocolVersion: 1, pageId: 'capacity-page', ...registration, sequence: ++sequence, activationSequence: 1,
    view: { sessionId: currentId, selection: 'selected', conversationVisible: !closed, visible: !closed, focused: !closed, closed } }, new AbortController().signal);
  const openPage = () => {
    sequence = 0; registration = ctx.recallHost.openPage({ protocolVersion: 1, pageId: 'capacity-page', registrationSequence: ++registrationSerial, sessionId: currentId }, new AbortController().signal);
    assert.ok(view(false).accepted);
  };
  const row = value => { if (operations.length < 10000) operations.push(value); else counters.discardedSamples++; };
  const failed = (kind, id, value) => {
    counters.failedCalls++;
    if (failures.length < 128) failures.push({ kind, id, round, status: value?.status, code: value?.code });
  };
  const resume = async id => {
    const handle = await ctx.agents.resume({ resumeSessionId: id, agentOptions: h.model.options }); h.agents.push(handle);
    if (seen.has(id)) counters.reopened++; seen.add(id); update(); return handle;
  };
  const close = async handle => {
    const id = handle.agent.id; await handle.dispose(); h.agents.splice(h.agents.indexOf(handle), 1); counters.closed++;
    // Exercise the native cold reader's own bounded LRU, without retaining a lease.
    await ctx.recallHistory.withSnapshot(id, snapshot => assert.equal(snapshot.header.id, id)); update();
  };
  const prepare = async id => {
    const at = performance.now();
    try {
      const handle = await ctx.recallPreparation.wait(id, AbortSignal.timeout(config.prepareMs));
      assert.equal(ctx.recallPreparation.records(handle).length, id === currentId ? 1 : spec.records);
      counters.preparations++; row({ kind: 'prepare', id, round, elapsedMs: performance.now() - at, status: 'ok' }); update();
    } catch (error) { failed('prepare', id, { code: error.code ?? error.name }); row({ kind: 'prepare', id, round, elapsedMs: performance.now() - at, code: error.code ?? error.name }); throw error; }
  };
  const search = async (agent, query, nonce) => {
    const at = performance.now(), args = query ? queryArgs(query) : { action: 'search', mode: 'literal', patterns: ['capacity-small-never-hit'] };
    args.patterns = [...args.patterns, `__capacity_unmatched_${nonce}__`];
    const [native] = await h.drive(agent, [{ name: 'recall_search', args }], human(`Capacity rotation ${nonce}`));
    const value = native.value; counters.searches++;
    row({ kind: 'search', id: agent.id, round, query: query?.id ?? 'small', elapsedMs: performance.now() - at, status: value?.status ?? 'native_error', code: value?.code ?? native.data.error?.code });
    if (value?.status !== 'ok') { failed('search', agent.id, value ?? native.data.error); return; }
    assert.equal(value.scanComplete, true); assert.equal(value.scannedRecords, query ? spec.records : 1);
    assert.equal(value.totalHits, query ? expectedIndexes(query, spec.records).length : 0);
    assert.equal(value.budget.search_remaining, 5); assert.equal(value.budget.shared_remaining, 11);
    if (value.items[0]) refs.set(agent.id, value.items[0].ref);
  };
  const read = async agent => {
    const ref = refs.get(agent.id); if (!ref) return;
    const at = performance.now(), result = await h.read(agent, ref, recovery()); counters.reads++;
    row({ kind: 'read', id: agent.id, round, elapsedMs: performance.now() - at, status: result.value?.status ?? 'native_error', code: result.value?.code });
    if (result.value?.status !== 'ok') failed('read', agent.id, result.value);
    else assert.ok(result.value.items.every(item => item.ref === ref));
  };
  const cancel = async agent => {
    const matcher = ctx.recallTools.search.matcher, match = matcher.match.bind(matcher); let units = 0, cancelled = false;
    const undo = replace(matcher, 'match', (...args) => {
      if (args[2].operation?.sessionId === agent.id && ++units === 4) setImmediate(() => { cancelled = true; agent.cancel({ kind: 'user' }); });
      return match(...args);
    });
    try {
      const at = performance.now(), [native] = await h.drive(agent, [{ name: 'recall_search', args: { action: 'search', mode: 'literal', patterns: [`__capacity_cancel_${round}__`] } }], human('Cancel real capacity scan'), false);
      assert.ok(cancelled); assert.equal(native.data.error?.code ?? native.value?.code, 'ABORTED');
      assert.equal(ctx.recallBudget.state(currentInteraction(agent.session)).shared, 11);
      counters.cancels++; row({ kind: 'cancel', id: agent.id, round, elapsedMs: performance.now() - at, units });
      assert.equal(ctx.recallMemory.budget.pinned(agent.id), false);
    } finally { undo(); }
  };
  const reload = async () => {
    reloading = true;
    view(true); const oldMemory = ctx.recallMemory.budget, oldMatcher = ctx.recallTools.search.matcher;
    const before = oldMemory.stats(); restoreMatch(); trackedMatcher = undefined;
    await [...ctx.loader.entries()].find(entry => entry.options.id === 'recall').fiber.restart();
    assert.equal(oldMemory.stats().usedBytes, 0); assert.equal(oldMemory.stats().pins, 0); assert.equal(oldMatcher.stats().live, 0);
    generations.push({ generation: generation++, before, after: oldMemory.stats() }); previousEvictions += before.evictions; previousRejects += before.rejected;
    counters.reloads++; openPage(); reloading = false; await phase('reload'); await prepare(currentId);
    await search(small.agent, undefined, `reload_${generation}`);
  };
  const observer = new PerformanceObserver(list => {
    for (const event of list.getEntries()) {
      gc.count++; gc.durationMs += event.duration;
      if (event.detail.kind === constants.NODE_PERFORMANCE_GC_MAJOR) {
        gc.major++; const heap = process.memoryUsage().heapUsed;
        gc.windowMinPostCallbackHeap = Math.min(gc.windowMinPostCallbackHeap ?? Infinity, heap);
      }
    }
  });
  try {
    observer.observe({ entryTypes: ['gc'] });
    await phase('fixture');
    for (const id of ids) await seedMatrixHistory(ctx, id, records);
    await seedMatrixHistory(ctx, currentId, [{ index: 0, parts: ['current small history'] }]);
    small = await resume(currentId); openPage(); await prepare(currentId);
    heartbeat = setInterval(() => { if (!reloading) view(false); }, 10000);
    offTools = ctx.on('tools/execute', async (exec, next) => {
      if (!['recall_search', 'recall_read'].includes(exec.name)) return next();
      active++; counters.maxNativeCalls = Math.max(counters.maxNativeCalls, active);
      try { return await next(); } finally { active--; }
    }, { prepend: true });
    started = performance.now();
    interval = setInterval(() => {
      if (samples.length < 12000) samples.push({ elapsedMs: performance.now() - started, stage, ...process.memoryUsage() }); else counters.discardedSamples++;
    }, 1000);
    do {
      round++;
      for (let start = 0, group = 0; start < ids.length; start += 3, group++) {
        await phase('rotate'); const previous = large; large = [];
        for (const id of ids.slice(start, start + 3)) {
          await phase('resume'); const handle = await resume(id); large.push(handle);
          await phase('prepare'); await prepare(id);
          if (previous.length) await close(previous.shift());
        }
        for (const handle of previous) await close(handle);
        await phase('query');
        await Promise.all([...large.map((handle, i) => search(handle.agent, QUERIES[(round + group * 3 + i) % QUERIES.length], `${round}_${group}_${i}`)),
          search(small.agent, undefined, `${round}_${group}_small`)]);
        await phase('read'); await read(large[0].agent);
        if (group === 0) { await phase('cancel'); await cancel(large[0].agent); }
        counters.groups++; update(); h.model.requests.length = 0;
        const midpoint = spec.durationMs ? performance.now() - started >= spec.durationMs / 2 : group >= Math.floor(Math.ceil(ids.length / 3) / 2);
        if (!spec.gcDiagnostic && !counters.reloads && midpoint) await reload();
        await phase('rotate');
      }
      counters.rounds = round;
      await phase('window');
      if (spec.gcDiagnostic && round > 1) { global.gc(); await new Promise(resolve => setImmediate(resolve)); }
      windows.push({ round, generation, elapsedMs: performance.now() - started, gcDiagnostic: spec.gcDiagnostic && round > 1,
        memory: process.memoryUsage(), majorGcMinPostCallbackHeap: gc.windowMinPostCallbackHeap, ...update(),
        liveAgents: h.agents.length, retainedModelRequests: h.model.requests.length });
      if (spec.heapSnapshots && (round === 2 || round === spec.rounds)) {
        heapSnapshots.push({ round, path: writeHeapSnapshot(`${spec.output}.round-${round}.heapsnapshot`) });
      }
      gc.windowMinPostCallbackHeap = null;
      console.log(JSON.stringify({ capacityWindow: windows.at(-1), counters }));
    } while (performance.now() - started < spec.durationMs || round < spec.rounds);
    ended = performance.now(); lastMemory = update();
    const diagnostic = windows.filter(w => w.gcDiagnostic).slice(-3).map(w => w.memory.heapUsed), noise = Math.max(1024 ** 2, (diagnostic[0] ?? 0) * 0.02);
    const heapStable = diagnostic.length === 3 && diagnostic[2] - diagnostic[0] <= Math.max(16 * 1024 ** 2, diagnostic[0] * 0.1)
      && !(diagnostic[1] - diagnostic[0] > noise && diagnostic[2] - diagnostic[1] > noise);
    const acceptance = { correct: counters.failedCalls === 0 && counters.maxNativeCalls === 4 && counters.maxWorkers <= 2 && counters.cancels >= round
        && counters.reopened >= (round > 1 ? spec.histories : 0) && counters.logicalPeakBytes <= cacheLimitBytes && !counters.discardedSamples,
      forcedGcHeapStable: spec.gcDiagnostic ? heapStable : null, diagnosticNoiseBytes: spec.gcDiagnostic ? noise : null };
    await phase('complete'); return { ...snapshot(), acceptance };
  } finally {
    clearInterval(interval); clearInterval(heartbeat); offTools?.(); observer.disconnect(); restoreMatch();
    if (registration) { try { view(true); } catch (error) { cleanup.pageCloseError = error.code ?? error.message; } }
    await h.dispose();
    Object.assign(cleanup, { derived: memory(), nativeCold: nativeCache(), pool: ctx.recallTools.search.matcher.stats() });
    assert.equal(cleanup.derived.usedBytes, 0); assert.equal(cleanup.derived.pins, 0); assert.equal(cleanup.nativeCold.pinned, 0);
  }
}
