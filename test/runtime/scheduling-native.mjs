import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { foldSurface } from '@deepseek-ai/dsh-session/surface';
import { defineTool, ToolArgsError } from '@deepseek-ai/dsh-tools';
import { RecallPreparationService, HistoryRecordCache, classifyHistoryRange } from '../../lib/index.js';
import { appendTurn, createHistoryFixture } from '../../support/fixtures/history.mjs';
import { rangeFixture } from '../../support/fixtures/range.mjs';

const deferred = () => Promise.withResolvers();
const immediate = () => new Promise(resolve => setImmediate(resolve));
function replace(object, method, value) {
  const descriptor = Object.getOwnPropertyDescriptor(object, method);
  Object.defineProperty(object, method, { configurable: true, value });
  return () => descriptor ? Object.defineProperty(object, method, descriptor) : Reflect.deleteProperty(object, method);
}
async function until(predicate, label, timeout = 20_000) {
  const end = performance.now() + timeout;
  while (performance.now() < end) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  throw new Error(`Timed out: ${label}`);
}

export async function verifyScheduling(ctx) {
  const evidence = { node: process.version, dsh: '0.2.1-rc.4', cases: [], traces: {}, performance: {}, leases: 0, maxConcurrentLeases: 0 };
  const check = async (name, run) => { await run(); evidence.cases.push(name); console.log(`PASS: ${name}`); };
  const fiber = [...ctx.registry.get(RecallPreparationService).fibers][0];
  const configure = async config => {
    const previous = ctx.recallPreparation;
    fiber.update(config, true);
    await until(() => ctx.recallPreparation && ctx.recallPreparation !== previous, 'preparation configuration');
    await fiber.await();
  };
  await configure({ batch: { maxRecords: 1 } });
  const fixtures = [], gates = [], trace = [], leases = [];
  const fixture = async (name, count = 3, body = i => `original ${i}`) => {
    const item = await createHistoryFixture(ctx, `schedule-${name}`, Array.from({ length: count }, (_, i) => body(i)));
    rangeFixture(item.session).summary([...item.session.surface.nodes]);
    await item.flush(); fixtures.push(item); return item;
  };
  const hold = id => {
    const gate = { id, entered: deferred(), release: deferred(), used: false };
    gates.push(gate); return gate;
  };
  const rawObserve = ctx.sessionQuery.observeSession.bind(ctx.sessionQuery);
  let activeLeases = 0, acquiredHook;
  const restore = replace(ctx.sessionQuery, 'observeSession', async (id, options) => {
    const start = performance.now();
    const lease = await rawObserve(id, options);
    if (!id.startsWith('schedule-')) return lease;
    leases.push(lease); activeLeases++; evidence.leases++;
    evidence.maxConcurrentLeases = Math.max(evidence.maxConcurrentLeases, activeLeases);
    trace.push({ id, at: performance.now(), acquisitionMs: performance.now() - start, source: lease.source });
    acquiredHook?.(id);
    const gate = gates.find(gate => gate.id === id && !gate.used);
    if (gate) { gate.used = true; gate.entered.resolve(); await gate.release.promise; }
    let released = false;
    return {
      source: lease.source, header: lease.header, cursor: lease.cursor, inheritedEventCount: lease.inheritedEventCount,
      get events() { return lease.events; }, ...(lease.revision === undefined ? {} : { revision: lease.revision }),
      [Symbol.dispose]() { assert.equal(released, false); released = true; activeLeases--; lease[Symbol.dispose](); },
    };
  });
  const warm = item => ctx.recallPreparation.warm(item.session.id);
  const wait = (item, signal) => ctx.recallPreparation.wait(item.session.id, signal);
  const status = item => ctx.recallPreparation.status(item.session.id);
  const ready = (...items) => until(() => items.every(item => status(item)?.state === 'ready'), 'all targets complete');
  const sequence = start => trace.slice(start).map(row => row.id.replace('schedule-', ''));
  let pageNumber = 0;
  const pages = [];
  const page = initial => {
    const pageId = `scheduling-page-${++pageNumber}`, signal = new AbortController().signal;
    const registration = ctx.recallHost.openPage({ protocolVersion: 1, pageId, registrationSequence: 1, sessionId: initial.session.id }, signal);
    let seq = 0, activation = 0, before;
    const report = (item = initial, patch = {}) => {
      const view = { sessionId: item.session.id, selection: 'selected', conversationVisible: true, visible: true, focused: true, closed: false, ...patch };
      if (!view.closed && view.visible && view.focused && view.conversationVisible
        && (!before?.focused || !before.visible || !before.conversationVisible || before.sessionId !== view.sessionId)) activation++;
      before = view;
      return ctx.recallHost.reportView({ protocolVersion: 1, pageId, ...registration, sequence: ++seq, activationSequence: activation, view }, signal);
    };
    const close = () => { if (!before?.closed) report(initial, { closed: true }); };
    pages.push(close);
    return { report, close };
  };

  try {
    await check('background FIFO completes each fixed target without round robin', async () => {
      const a = await fixture('fifo-a'), b = await fixture('fifo-b', 2), gate = hold(a.session.id), start = trace.length;
      warm(a); await gate.entered.promise;
      warm(b); const order = status(a).queueOrder;
      gate.release.resolve(); await ready(a, b);
      assert.deepEqual(sequence(start), ['fifo-a', 'fifo-a', 'fifo-a', 'fifo-b', 'fifo-b']);
      assert.ok(order > 0); assert.equal(status(a).preemptions, 0);
      evidence.traces.fifo = sequence(start);
    });

    await check('real Host waiters outrank preheat at the next batch; interrupted work preserves FIFO and records', async () => {
      const a = await fixture('wait-a'), b = await fixture('wait-b', 2), c = await fixture('wait-c', 2);
      const gate = hold(a.session.id), enteredC = hold(c.session.id), start = trace.length;
      warm(a); await gate.entered.promise; warm(b);
      const originalOrder = status(a).queueOrder, one = wait(c), two = wait(c);
      assert.equal(status(c).waiters, 2); gate.release.resolve(); await enteredC.entered.promise;
      assert.equal(status(a).records, 1); assert.equal(status(a).queueOrder, originalOrder);
      assert.equal(status(a).preemptions, 1); assert.equal(status(c).priority, 'waiting');
      enteredC.release.resolve();
      const [first, second] = await Promise.all([one, two]); assert.equal(first, second);
      await ready(a, b, c);
      assert.deepEqual(sequence(start), ['wait-a', 'wait-c', 'wait-c', 'wait-a', 'wait-a', 'wait-b', 'wait-b']);
      assert.equal(status(a).records, 3);
      evidence.traces.waiting = sequence(start);
    });

    await check('accepted A to B to A activation preempts at boundaries and resumes the original fixed targets', async () => {
      const a = await fixture('focus-a'), b = await fixture('focus-b', 2), first = hold(a.session.id), second = hold(b.session.id);
      const ui = page(a), start = trace.length;
      try {
        ui.report(); await first.entered.promise; const order = status(a).queueOrder;
        ui.report(b); assert.equal(status(b).priority, 'current');
        first.release.resolve(); await second.entered.promise;
        const target = status(a).targetCursor;
        assert.equal(status(a).records, 1); assert.equal(status(a).priority, 'background');
        ui.report(a); assert.equal(status(a).priority, 'current');
        assert.equal(status(a).queueOrder, order);
        second.release.resolve(); await ready(a, b);
        assert.deepEqual(sequence(start), ['focus-a', 'focus-b', 'focus-a', 'focus-a', 'focus-b']);
        assert.equal(status(a).preparedCursor, target);
        assert.deepEqual([status(a).preemptions, status(b).preemptions], [1, 1]);
        evidence.traces.focus = sequence(start);
      } finally { first.release.resolve(); second.release.resolve(); ui.close(); }
    });

    await check('newer page activation survives blur and close; older active-page heartbeats do not take over', async () => {
      const a = await fixture('pages-a', 2), b = await fixture('pages-b', 2), gate = hold(a.session.id);
      const first = page(a), second = page(b), start = trace.length;
      try {
        first.report(); await gate.entered.promise;
        second.report(); second.report(b, { focused: false }); second.close();
        first.report(); assert.equal(status(b).priority, 'current');
        gate.release.resolve(); await ready(a, b);
        assert.deepEqual(sequence(start), ['pages-a', 'pages-b', 'pages-b', 'pages-a']);
        evidence.traces.pages = sequence(start);
      } finally { gate.release.resolve(); first.close(); second.close(); }
    });

    await check('a real waiter deadline changes priority without cancelling shared preparation', async () => {
      const a = await fixture('timeout-a'), b = await fixture('timeout-b'), c = await fixture('timeout-c', 1);
      const first = hold(a.session.id), second = hold(b.session.id), start = trace.length;
      warm(a); await first.entered.promise;
      const deadline = AbortSignal.timeout(150);
      const rejected = assert.rejects(wait(b, deadline), { name: 'TimeoutError' });
      const waitingC = wait(c); first.release.resolve(); await second.entered.promise;
      await rejected; assert.equal(status(b).waiters, 0); assert.equal(status(b).priority, 'background');
      second.release.resolve(); await waitingC; await ready(a, b, c);
      assert.deepEqual(sequence(start), ['timeout-a', 'timeout-b', 'timeout-c', 'timeout-a', 'timeout-a', 'timeout-b', 'timeout-b']);
      assert.equal(status(b).records, 3);
      evidence.traces.timeout = sequence(start);
    });

    await check('native tool execution joins its actual session and native timeout removes only its waiter', async () => {
      const a = await fixture('native-tool-background'), first = hold(a.session.id);
      const id = 'schedule-native-tool';
      await ctx.sessionController.create({ sessionId: id, cwd: process.cwd() });
      const agent = ctx.agents.get(id), item = { session: agent.session };
      appendTurn(item.session, 1, 'executing native agent original');
      rangeFixture(item.session).summary([...item.session.surface.nodes]);
      item.session.append('turn/start', { turn: 2 }); item.session.append('step/start', { turn: 2, step: 1 });
      const name = 'recall_scheduling_fixture';
      item.session.append('tool/call', { turn: 2, step: 1, callId: 'native-prepare-wait', name, arguments: '{}' });
      await ctx.sessions.flush(item.session);
      const second = hold(id);
      const unregister = ctx.tools.register(defineTool({
        name, description: 'Isolated scheduler integration fixture; no model invocation.', parameters: {}, timeoutMs: 200,
        isConcurrencySafe: () => true,
        output: { schema: { type: 'object', additionalProperties: false, properties: { sessionId: { type: 'string', required: true } } },
          render: (_, value) => [{ type: 'text', text: JSON.stringify(value) }] },
        presentCall: () => ({ card: 'generic', kind: 'read', title: 'Scheduling fixture' }),
        execute: async (args, exec) => {
          if (Object.keys(args).length) throw new ToolArgsError(['Fixture takes no arguments']);
          assert.equal(exec.agent, agent);
          const result = await ctx.recallPreparation.wait(exec.agent.session.id, exec.signal);
          return { sessionId: result.sessionId };
        },
      }));
      try {
        warm(a); await first.entered.promise;
        const call = ctx.tools.execute({ name, callId: 'native-prepare-wait', arguments: {}, agent, signal: new AbortController().signal });
        await until(() => status(item)?.waiters === 1, 'native execution waiter registered');
        assert.equal(status(item).priority, 'waiting');
        first.release.resolve(); await second.entered.promise;
        const result = await call;
        assert.equal(result.isError, true); assert.equal(result.error.info.code, 'TOOL_TIMEOUT');
        assert.equal(status(item).waiters, 0); assert.equal(status(item).priority, 'background');
        assert.equal(status(item).state, 'preparing', 'manager still owns the running batch');
        second.release.resolve(); await ready(a, item);
        assert.equal(status(item).records, 1);
      } finally {
        first.release.resolve(); second.release.resolve(); unregister();
        item.session.append('step/end', { turn: 2, step: 1 }); item.session.append('turn/end', { turn: 2, reason: { kind: 'completed' } });
      }
    });

    await check('completion releases inactive current privilege; appended demand receives a new FIFO order', async () => {
      const a = await fixture('fixed-a', 2), b = await fixture('fixed-b', 2), first = hold(a.session.id), second = hold(b.session.id);
      const ui = page(a), start = trace.length;
      try {
        ui.report(); const oldWait = wait(a); await first.entered.promise;
        const originalOrder = status(a).queueOrder, oldCursor = a.session.seq - 1;
        appendTurn(a.session, 3, 'new demand after captured cut');
        const source = a.session.snapshotEvents().find(event => event.type === 'user/message' && event.data.content[0]?.text === 'new demand after captured cut');
        rangeFixture(a.session).summary([source.seq]);
        const bWait = wait(b); ui.close();
        assert.equal(status(a).priority, 'current'); first.release.resolve();
        const old = await oldWait; assert.equal(old.cursor, oldCursor);
        await second.entered.promise;
        assert.ok(status(a).queueOrder > originalOrder); assert.ok(status(a).queueOrder > status(b).queueOrder);
        assert.equal(status(a).priority, 'background'); second.release.resolve(); await bWait; await ready(a, b);
        assert.deepEqual(sequence(start), ['fixed-a', 'fixed-a', 'fixed-b', 'fixed-b', 'fixed-a']);
        assert.equal(status(a).records, 3);
        evidence.traces.fixed = sequence(start);
      } finally { first.release.resolve(); second.release.resolve(); ui.close(); }
    });

    await check('unload drains the running batch and invalidates both current and preempted work', async () => {
      const a = await fixture('unload-a'), b = await fixture('unload-b'), first = hold(a.session.id), second = hold(b.session.id);
      const service = ctx.recallPreparation, ui = page(b);
      const aWait = service.wait(a.session.id), rejectedA = assert.rejects(aWait, { code: 'recall/preparation-unloaded' });
      await first.entered.promise;
      ui.report(); const bWait = service.wait(b.session.id), rejectedB = assert.rejects(bWait, { code: 'recall/preparation-unloaded' });
      first.release.resolve(); await second.entered.promise; assert.equal(status(a).records, 1);
      let done = false;
      const restart = fiber.restart().then(() => { done = true; });
      await Promise.all([rejectedA, rejectedB]); await immediate(); assert.equal(done, false);
      second.release.resolve(); await restart;
      assert.deepEqual(service.snapshot(), []); await ready(b); ui.close();
      assert.equal(ctx.recallPreparation.status(a.session.id), undefined, 'unselected old task was released');
    });

    await check('record-time allowance stops at a complete record without splitting its identity', async () => {
      const item = await fixture('time-budget', 2, i => i ? 'next whole record' : 'long record\n'.repeat(50_000));
      const cache = new HistoryRecordCache();
      try {
        const first = await ctx.recallHistory.withSnapshot(item.session.id, async (cut, signal) => {
          const pending = cache.prepareBatch(cut, ctx.sessions.messageProjections,
            { maxRecords: 64, maxTextChars: 10_000_000, maxBatchMs: 1 }, signal);
          // Force a known elapsed slice while the first record yields. This
          // avoids assuming a particular machine/JIT needs >1ms for its body.
          const delay = setImmediate(() => { const end = performance.now() + 5; while (performance.now() < end) {} });
          try { return await pending; } finally { clearImmediate(delay); }
        });
        assert.equal(first.status, 'incomplete'); assert.equal(first.preparedInBatch, 1);
        assert.ok(cache.timings().extractionMs >= 1);
        const next = await ctx.recallHistory.withSnapshot(item.session.id, (cut, signal) => cache.prepareBatch(cut, ctx.sessions.messageProjections, {}, signal));
        assert.equal(cache.records(next).length, 2); assert.equal(next.reusedRecords, 1);
      } finally { cache.dispose(); }
    });

    await check('cold read, fold, classification, extraction, selection latency and memory are measured on a bounded native workload', async () => {
      await configure({});
      const large = await fixture('measure-cold', 384, i => `${i}: ` + 'native history text '.repeat(100));
      const current = await fixture('measure-current', 1); await large.close();
      const ui = page(current), before = process.memoryUsage(), start = trace.length;
      let peakHeap = before.heapUsed, peakRss = before.rss, maxTimerDelayMs = 0, lastTick = performance.now();
      const timer = setInterval(() => {
        const now = performance.now(), memory = process.memoryUsage();
        maxTimerDelayMs = Math.max(maxTimerDelayMs, now - lastTick - 5); lastTick = now;
        peakHeap = Math.max(peakHeap, memory.heapUsed); peakRss = Math.max(peakRss, memory.rss);
      }, 5);
      const selected = deferred(); let receiptMs, reportedAt;
      acquiredHook = id => {
        if (id !== large.session.id) return;
        acquiredHook = undefined;
        setImmediate(() => {
          const now = performance.now(); ui.report(); reportedAt = performance.now(); receiptMs = reportedAt - now; selected.resolve();
        });
      };
      const began = performance.now();
      try {
        warm(large); await selected.promise; await ready(large, current);
        const elapsedMs = performance.now() - began, after = process.memoryUsage();
        const first = trace[start], next = trace.slice(start).find(row => row.id === current.session.id);
        assert.equal(first.source, 'prepared'); assert.equal(trace[start + 1].id, current.session.id);
        assert.equal(status(large).records, 384); assert.equal(status(large).preemptions, 1);
        let foldMs, classificationMs, eventCount;
        await ctx.recallHistory.withSnapshot(large.session.id, snapshot => {
          const events = snapshot.events; eventCount = events.length;
          let now = performance.now(); foldSurface(events, ctx.sessions.messageProjections); foldMs = performance.now() - now;
          now = performance.now(); classifyHistoryRange(snapshot, ctx.sessions.messageProjections); classificationMs = performance.now() - now;
        });
        evidence.performance = { records: 384, eventCount, storedBytes: (await ctx.sessionPersistence.stat(large.session.id)).sizeBytes,
          coldAcquisitionMs: first.acquisitionMs, standaloneFoldMs: foldMs, standaloneClassificationMs: classificationMs,
          receiptMs, selectionToNextBatchMs: next.at - reportedAt, maxTimerDelayMs, elapsedMs,
          before, after, sampledPeak: { heapUsed: peakHeap, rss: peakRss }, preparation: status(large) };
        assert.ok(Object.values(evidence.performance).filter(value => typeof value === 'number').every(value => Number.isFinite(value) && value >= 0));
      } finally { acquiredHook = undefined; clearInterval(timer); ui.close(); }
    });

    await until(() => activeLeases === 0, 'all scheduling leases released');
    leases.forEach(lease => assert.throws(() => lease.retain(), /disposed/));
    assert.equal(evidence.maxConcurrentLeases, 1);
    const output = join(process.env.DSH_HOME, '..', 'scheduling-evidence.json');
    await writeFile(output, JSON.stringify(evidence, null, 2));
    console.log(`Scheduling evidence: ${output}`);
  } finally {
    acquiredHook = undefined; gates.forEach(gate => gate.release.resolve()); pages.forEach(close => close()); restore();
    for (const item of fixtures) if (ctx.sessions.get(item.session.id)) await item.close(false);
  }
}
