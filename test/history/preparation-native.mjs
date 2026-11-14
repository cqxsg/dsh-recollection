import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { Peer } from '@deepseek-ai/dsh-client-connection';
import { Session } from '@deepseek-ai/dsh-session';
import { RecallPreparationService, startPerformanceCapture } from '../../lib/index.js';
import { appendTurn, createHistoryFixture } from '../../support/fixtures/history.mjs';
import { rangeFixture, text, image } from '../../support/fixtures/range.mjs';

const immediate = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => Promise.withResolvers();
const view = sessionId => ({ sessionId, selection: 'selected', conversationVisible: true, visible: true, focused: true, closed: false });
function replace(object, method, value) {
  const descriptor = Object.getOwnPropertyDescriptor(object, method);
  Object.defineProperty(object, method, { configurable: true, value });
  return () => descriptor ? Object.defineProperty(object, method, descriptor) : Reflect.deleteProperty(object, method);
}
async function until(predicate, label, timeout = 10_000) {
  const end = performance.now() + timeout;
  while (performance.now() < end) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  throw new Error(`Timed out: ${label}`);
}

export async function verifyPreparation(ctx) {
  const evidence = { node: process.version, dsh: '0.2.1-rc.4', cases: [], samples: {}, leases: 0, maxConcurrentLeases: 0 };
  const check = async (name, action) => { await action(); evidence.cases.push(name); console.log(`PASS: ${name}`); };
  const fiber = [...ctx.registry.get(RecallPreparationService).fibers][0];
  const previous = ctx.recallPreparation;
  fiber.update({ maxBufferedEvents: 4, batch: { maxRecords: 1, maxTextChars: 64 } }, true);
  await until(() => ctx.recallPreparation && ctx.recallPreparation !== previous, 'small-batch test configuration');
  await fiber.await();
  const fixtures = [];
  const fixture = async (name, texts = ['original'], compact = true, parent) => {
    const item = await createHistoryFixture(ctx, `preparation-${name}`, texts, parent);
    if (compact && item.session.surface.nodes.length) rangeFixture(item.session).summary([...item.session.surface.nodes]);
    await item.flush(); fixtures.push(item); return item;
  };
  const rawObserve = ctx.sessionQuery.observeSession.bind(ctx.sessionQuery);
  let activeLeases = 0;
  const leases = [];
  const observed = async (id, options) => {
    const lease = await rawObserve(id, options);
    leases.push(lease); activeLeases++; evidence.leases++;
    evidence.maxConcurrentLeases = Math.max(evidence.maxConcurrentLeases, activeLeases);
    let released = false;
    return {
      source: lease.source, header: lease.header, cursor: lease.cursor, inheritedEventCount: lease.inheritedEventCount,
      get events() { return lease.events; }, ...(lease.revision === undefined ? {} : { revision: lease.revision }),
      [Symbol.dispose]() { assert.equal(released, false); released = true; activeLeases--; lease[Symbol.dispose](); },
    };
  };
  const restoreTrace = replace(ctx.sessionQuery, 'observeSession', observed);
  const prepared = id => ctx.recallPreparation.wait(id);
  const records = handle => ctx.recallPreparation.records(handle);
  const ready = id => until(() => ctx.recallPreparation.status(id)?.state === 'ready', `ready ${id}`);
  const capture = startPerformanceCapture({ maxEvents: 128 });
  try {
    await check('authorized old-session page receipt queues cold preheat without awaiting a native read', async () => {
      const item = await fixture('page'); await item.close();
      const id = item.session.id, peer = new Peer(ctx, { principal: { kind: 'preparation-test' } });
      const unregister = ctx.remoteAccess.registerPolicy('preparation-test', { bindings: () => [
        { resource: { kind: 'session', id }, role: { name: 'preheat', resource: 'session', actions: ['recall/openPage', 'recall/reportView'] } },
      ] });
      const invoke = (method, value) => ctx.typertGateway.invoke({ namespace: 'recall', method, args: { [method === 'openPage' ? 'request' : 'report']: value }, peer });
      const gate = deferred(), entered = deferred(); let calls = 0;
      const restore = replace(ctx.sessionQuery, 'observeSession', async (sessionId, options) => {
        if (sessionId === id) { calls++; entered.resolve(); await gate.promise; }
        return observed(sessionId, options);
      });
      try {
        const registration = await invoke('openPage', { protocolVersion: 1, pageId: 'preparation-page', registrationSequence: 1, sessionId: id });
        const report = { protocolVersion: 1, pageId: 'preparation-page', ...registration, sequence: 1, activationSequence: 1, view: view(id) };
        const start = performance.now();
        assert.equal((await invoke('reportView', report)).accepted, true);
        evidence.samples.receiptMs = performance.now() - start;
        assert.equal(calls, 0, 'receipt did not start observation');
        await entered.promise;
        assert.equal((await invoke('reportView', { ...report, sequence: 2 })).accepted, true, 'receipt while native reader is blocked');
        assert.equal(calls, 1, 'heartbeats merge into one task');
        await assert.rejects(invoke('reportView', { ...report, sequence: 3, view: view('preparation-denied') }), { code: 'remote-access/denied' });
        assert.equal(ctx.recallPreparation.status('preparation-denied'), undefined);
        for (const method of ['wait', 'records', 'warm']) await assert.rejects(invoke(method, {}), error => error.code?.startsWith('gateway/'));
        gate.resolve(); await ready(id);
        assert.equal(ctx.recallPreparation.status(id).records, 1);
        assert.equal(records(await prepared(id))[0].blocks[0].content.text, 'original');
        await invoke('reportView', { ...report, sequence: 3, view: { ...view(id), closed: true } });
        evidence.samples.coldPage = ctx.recallPreparation.status(id);
      } finally { gate.resolve(); restore(); unregister(); await peer.dispose(); }
    });

    await check('reselecting a cached cold session checks unseen persisted changes; heartbeats do not poll history', async () => {
      const item = await fixture('reselect'), id = item.session.id; await item.close();
      const old = await prepared(id), signal = new AbortController().signal;
      const registration = ctx.recallHost.openPage({ protocolVersion: 1, pageId: 'reselect-page', registrationSequence: 1, sessionId: id }, signal);
      const report = { protocolVersion: 1, pageId: 'reselect-page', ...registration, sequence: 1, activationSequence: 1, view: view(id) };
      ctx.recallHost.reportView(report, signal); await ready(id);
      const before = ctx.recallPreparation.status(id).observations;
      ctx.recallHost.reportView({ ...report, sequence: 2 }, signal);
      await immediate(); await immediate();
      assert.equal(ctx.recallPreparation.status(id).observations, before);
      ctx.recallHost.reportView({ ...report, sequence: 3, view: { ...view(null), selection: 'none' } }, signal);
      const detached = Session.create(id, item.session.snapshotEvents(), item.session.header, 0, ctx.sessions.messageProjections);
      appendTurn(detached, 2, 'stored elsewhere while page was away');
      rangeFixture(detached).summary([...detached.surface.nodes]);
      const writer = await ctx.sessionPersistence.open(id, 'write');
      try { await writer.append(detached.snapshotEvents().slice(item.session.seq)); await writer.flush(); } finally { await writer.close(); }
      ctx.recallHost.reportView({ ...report, sequence: 4, activationSequence: 2 }, signal);
      await ready(id);
      assert.equal(ctx.recallPreparation.status(id).records, 2);
      assert.ok(ctx.recallPreparation.status(id).preparedCursor > old.cursor);
      ctx.recallHost.reportView({ ...report, sequence: 5, activationSequence: 2, view: { ...view(id), closed: true } }, signal);
    });

    await check('one fixed target completes while concurrent demand requeues; cancelling one waiter preserves shared work', async () => {
      const item = await fixture('bridge', ['first', 'second', 'third']), id = item.session.id;
      const cut = item.session.seq - 1, gate = deferred(), entered = deferred(); let calls = 0;
      const restore = replace(ctx.sessionQuery, 'observeSession', async (sessionId, options) => {
        const lease = await observed(sessionId, options);
        if (sessionId === id && ++calls === 1) { entered.resolve(); await gate.promise; }
        return lease;
      });
      try {
        const cancelled = new AbortController();
        const first = prepared(id), stopped = ctx.recallPreparation.wait(id, cancelled.signal);
        const stoppedCheck = assert.rejects(stopped, /one caller stopped/);
        await entered.promise;
        appendTurn(item.session, 4, 'appended during snapshot acquisition');
        rangeFixture(item.session).summary([cut + 2]);
        const next = prepared(id);
        cancelled.abort(new Error('one caller stopped')); await stoppedCheck;
        assert.equal(ctx.recallPreparation.status(id).waiters, 2);
        gate.resolve();
        const before = await first;
        assert.equal(before.cursor, cut);
        assert.deepEqual(records(before).map(r => r.blocks[0].content.text), ['first', 'second', 'third']);
        const after = await next; await ready(id);
        assert.ok(after.cursor > before.cursor);
        const bodies = records(after);
        assert.equal(bodies.length, 4); assert.equal(new Set(bodies.map(r => r.id)).size, 4);
        assert.equal(ctx.recallPreparation.status(id).records, 4);
        assert.ok(calls >= 4, 'one-record batches acquired separate native cuts');
        evidence.samples.fixedTargets = { before: before.cursor, after: after.cursor, status: ctx.recallPreparation.status(id) };
      } finally { gate.resolve(); restore(); }
    });

    await check('ordinary appends stay lightweight; a late exit of old content schedules and reuses complete records', async () => {
      const item = await fixture('append'), id = item.session.id, service = ctx.recallPreparation;
      await prepared(id);
      const before = service.status(id);
      appendTurn(item.session, 2, 'ordinary tail');
      await immediate(); await immediate();
      assert.equal(service.status(id).observations, before.observations);
      assert.equal(service.status(id).batches, before.batches);
      assert.equal(service.status(id).cursor, item.session.seq - 1);
      const tail = item.session.snapshotEvents().find(event => event.type === 'user/message' && event.data.content[0]?.text === 'ordinary tail');
      rangeFixture(item.session).summary([tail.seq]);
      await ready(id);
      const result = await prepared(id);
      assert.deepEqual(records(result).map(r => r.blocks[0].content.text), ['original', 'ordinary tail']);
      assert.equal(result.batch.reusedRecords, 2);
    });

    await check('image offload and tool-result replacement trigger preparation without relying on compaction-end hints', async () => {
      const item = await fixture('changes', [], false), id = item.session.id, f = rangeFixture(item.session);
      const picture = f.user([text('caption'), image('preparation')]);
      await prepared(id); const before = ctx.recallPreparation.status(id).observations;
      f.offload(picture, [0]); await ready(id);
      assert.ok(ctx.recallPreparation.status(id).observations > before);
      f.append('turn/start', { turn: 1 }); f.append('step/start', { turn: 1, step: 1 });
      const block = f.callBlock('preparation-tool'); f.assistant([block]);
      const output = f.result(block, f.callLog(block), [text('unpruned result')]);
      f.prune(output);
      f.append('step/end', { turn: 1, step: 1 }); f.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
      await ready(id);
      const result = await prepared(id);
      assert.deepEqual(records(result).map(r => r.origin.seq), [picture.seq, output.seq]);
      assert.equal(records(result)[0].blocks[1].attachmentBytes, 'not_loaded');
    });

    await check('bounded notification overflow forces a fresh cut and retains no event bodies', async () => {
      const item = await fixture('overflow'), id = item.session.id, gate = deferred(), entered = deferred(); let first = true;
      const restore = replace(ctx.sessionQuery, 'observeSession', async (sessionId, options) => {
        const lease = await observed(sessionId, options);
        if (sessionId === id && first) { first = false; entered.resolve(); await gate.promise; }
        return lease;
      });
      try {
        const pending = prepared(id); await entered.promise;
        for (let turn = 2; turn < 12; turn++) appendTurn(item.session, turn, `ordinary ${turn}`);
        assert.ok(ctx.recallPreparation.status(id).bufferedEvents <= 4);
        const latest = prepared(id); gate.resolve(); await pending; const completed = await latest; await ready(id);
        assert.equal(completed.cursor, item.session.seq - 1);
        assert.equal(records(completed).length, 1, 'ordinary tail does not expand E(C)');
        assert.equal(ctx.recallPreparation.status(id).bufferedEvents, 0);
      } finally { gate.resolve(); restore(); }
    });

    await check('a dropped notification gap is repaired from native persisted history; duplicate delivery is idempotent', async () => {
      const item = await fixture('gap'), id = item.session.id; await item.close();
      const old = await prepared(id);
      const detached = Session.create(id, item.session.snapshotEvents(), item.session.header, item.session.inheritedEventCount, ctx.sessions.messageProjections);
      const from = item.session.seq;
      appendTurn(detached, 2, 'durable tail with lost notifications');
      const original = detached.snapshotEvents().find(event => event.type === 'user/message' && event.data.content[0]?.text === 'durable tail with lost notifications');
      rangeFixture(detached).summary([original.seq]);
      const writer = await ctx.sessionPersistence.open(id, 'write');
      try { await writer.append(detached.snapshotEvents().slice(from)); await writer.flush(); } finally { await writer.close(); }
      // Fault injection: only the final real committed event reaches the feed.
      const tail = detached.snapshotEvents().at(-1);
      ctx.emit('session/event', detached, tail); ctx.emit('session/event', detached, tail);
      await ready(id);
      const after = await prepared(id);
      assert.ok(after.cursor > old.cursor);
      assert.deepEqual(records(after).map(r => r.blocks[0].content.text), ['original', 'durable tail with lost notifications']);
    });

    await check('fork preparation observes only its inherited prefix and own suffix', async () => {
      const parent = await fixture('parent', ['inherited original']);
      const child = await fixture('child', ['child original'], true, parent.session);
      appendTurn(parent.session, 2, 'parent after fork');
      rangeFixture(parent.session).summary([...parent.session.surface.nodes]);
      const result = await prepared(child.session.id);
      const body = records(result);
      assert.deepEqual(body.map(r => r.blocks[0].content.text), ['inherited original', 'child original']);
      assert.deepEqual(body.map(r => r.origin.inherited), [true, false]);
      assert.equal(body.some(r => r.blocks[0].content.text === 'parent after fork'), false);
    });

    await check('changed uncached content between batches fails explicitly and clears prior coverage', async () => {
      const item = await fixture('rewrite', ['cached first', 'uncached second']), id = item.session.id; let calls = 0;
      const restore = replace(ctx.sessionQuery, 'observeSession', async (sessionId, options) => {
        const lease = await observed(sessionId, options);
        if (sessionId !== id || ++calls !== 2) return lease;
        const events = structuredClone(lease.events);
        events[4].data.content[0].text = 'rewritten uncached source';
        return { ...lease, events };
      });
      try {
        await assert.rejects(prepared(id), { code: 'recall/preparation-source-changed' });
        assert.equal(calls, 2);
        assert.equal(ctx.recallPreparation.status(id).state, 'failed');
        assert.equal(ctx.recallPreparation.status(id).records, 0);
        assert.equal(ctx.recallPreparation.status(id).preparedCursor, null);
      } finally { restore(); }
      assert.equal(records(await prepared(id)).length, 2, 'explicit retry can recover a valid source');
    });

    await check('missing, truncated and unavailable sources fail explicitly while other sessions continue', async () => {
      await assert.rejects(prepared('preparation-does-not-exist'));
      assert.equal(ctx.recallPreparation.status('preparation-does-not-exist').state, 'failed');
      const item = await fixture('truncate'), id = item.session.id, previous = await prepared(id);
      const restore = replace(ctx.sessionQuery, 'observeSession', async (sessionId, options) => {
        const lease = await observed(sessionId, options);
        return sessionId === id ? { ...lease, events: [], cursor: -1, inheritedEventCount: 0 } : lease;
      });
      try {
        await assert.rejects(prepared(id), { code: 'recall/preparation-source-changed' });
        assert.equal(ctx.recallPreparation.status(id).records, 0);
        assert.throws(() => records(previous), { code: 'recall/preparation-expired' });
      } finally { restore(); }
      const get = ctx.sessions.get.bind(ctx.sessions);
      const restoreGet = replace(ctx.sessions, 'get', sessionId => {
        if (sessionId === 'preparation-get-unavailable') throw new Error('native registry temporarily unavailable');
        return get(sessionId);
      });
      try {
        const unavailable = assert.rejects(prepared('preparation-get-unavailable'), /registry temporarily unavailable/);
        const healthy = prepared(id);
        await unavailable;
        assert.equal(records(await healthy).length, 1, 'one failing session cannot stop the preparation queue');
      } finally { restoreGet(); }
    });

    await check('live disposal and replacement invalidate old handles and re-observe the native instance', async () => {
      const item = await fixture('instance'), id = item.session.id;
      ctx.sessions.announce(item.session);
      const handle = await prepared(id);
      await item.close();
      assert.throws(() => records(handle), { code: 'recall/preparation-expired' });
      assert.equal(ctx.recallPreparation.status(id), undefined, 'idle closed history is released rather than automatically re-warmed');
      const cold = await prepared(id); let fresh;
      const replacement = ctx.plugin({ name: 'preparation-replacement', inject: ['sessions'], apply(scope) {
        fresh = scope.sessions.prepare(id, { meta: { cwd: process.cwd(), delegationDepth: 0 } });
        appendTurn(fresh, 1, 'replacement native instance');
        rangeFixture(fresh).summary([...fresh.surface.nodes]);
        scope.effect(() => scope.sessions.enter(fresh));
        scope.sessions.announce(fresh);
      } });
      try {
        await replacement.await();
        assert.throws(() => records(cold), { code: 'recall/preparation-expired' });
        await ready(id);
        assert.equal(records(await prepared(id))[0].blocks[0].content.text, 'replacement native instance');
      } finally { await replacement.dispose(); }
      assert.equal(ctx.recallPreparation.status(id), undefined);
      await prepared(id); // Explicit demand re-observes the stored source.
    });

    await check('unload drains late acquisition, releases leases/cache/listeners and reload accepts new demand', async () => {
      const item = await fixture('unload'), id = item.session.id, service = ctx.recallPreparation, memory = ctx.recallMemory.budget;
      const gate = deferred(), entered = deferred(); let first = true;
      const restore = replace(ctx.sessionQuery, 'observeSession', async (sessionId, options) => {
        const lease = await observed(sessionId, options);
        if (sessionId === id && first) { first = false; entered.resolve(lease); await gate.promise; }
        return lease;
      });
      try {
        const pending = service.wait(id);
        const rejected = assert.rejects(pending, { code: 'recall/preparation-unloaded' });
        await entered.promise;
        let restarted = false;
        const restart = fiber.restart().then(() => { restarted = true; });
        await rejected; await immediate();
        assert.equal(restarted, false, 'unload drains the held native provider');
        gate.resolve(); await restart;
        assert.equal(activeLeases, 0);
        assert.deepEqual(service.snapshot(), []);
        assert.equal(memory.stats().usedBytes, 0); assert.equal(memory.stats().pins, 0);
        assert.notEqual(ctx.recallPreparation, service);
        appendTurn(item.session, 2, 'new feed after reload');
        assert.deepEqual(service.snapshot(), [], 'disposed listener does not receive new events');
        assert.equal(records(await prepared(id)).length, 1);
      } finally { gate.resolve(); restore(); }
    });

    await until(() => activeLeases === 0, 'all observations released');
    assert.equal(evidence.maxConcurrentLeases, 1, 'one serial native batch at a time');
    leases.forEach(lease => assert.throws(() => lease.retain(), /disposed/));
    evidence.samples.final = ctx.recallPreparation.snapshot();
    evidence.diagnostics = capture.snapshot();
    assert.equal(evidence.diagnostics.active, 0, 'all diagnostic spans drain with their native operations');
    assert.ok(evidence.diagnostics.droppedEvents > 0, 'bounded event storage exercises aggregate-only overflow');
    assert.ok(evidence.diagnostics.aggregates['preparation.batch'].failed > 0, 'source changes/cancellation remain failures');
    const output = join(process.env.DSH_HOME, '..', 'preparation-evidence.json');
    await writeFile(output, JSON.stringify(evidence, null, 2));
    console.log(`Preparation evidence: ${output}`);
  } finally {
    capture.stop();
    restoreTrace();
    for (const item of fixtures) if (ctx.sessions.get(item.session.id)) await item.close(false);
  }
}
