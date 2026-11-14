import assert from 'node:assert/strict';
import { readdir, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { Peer } from '@deepseek-ai/dsh-client-connection';
import { RecallHistoryService } from '../../lib/index.js';
import { appendTurn, createHistoryFixture } from '../../support/fixtures/history.mjs';

const deferred = () => Promise.withResolvers();
const immediate = () => new Promise(resolve => setImmediate(resolve));
const view = sessionId => ({ sessionId, selection: 'selected', conversationVisible: true, visible: true, focused: true, closed: false });

function replace(object, method, value) {
  const original = Object.getOwnPropertyDescriptor(object, method);
  Object.defineProperty(object, method, { configurable: true, value });
  return () => original ? Object.defineProperty(object, method, original) : Reflect.deleteProperty(object, method);
}

/** Extract test assertions within the scope; never return a native lease. */
const describe = snapshot => ({
  source: snapshot.source, header: snapshot.header, cursor: snapshot.cursor,
  inheritedEventCount: snapshot.inheritedEventCount, events: snapshot.events,
  ...(snapshot.revision === undefined ? {} : { revision: snapshot.revision }),
});
const sameCut = (left, right) => {
  for (const field of ['header', 'cursor', 'inheritedEventCount', 'events']) assert.deepEqual(left[field], right[field], field);
};

export async function verifyHistory(ctx) {
  const evidence = { node: process.version, dsh: '0.2.1-rc.4', cases: [], observations: [], timings: {} };
  const check = async (name, run) => {
    await run();
    evidence.cases.push(name);
    console.log(`PASS: ${name}`);
  };
  const fixture = (id, texts, parent) => createHistoryFixture(ctx, id, texts, parent);
  const a = await fixture('history-a', ['Alpha: native first turn', 'Alpha: second turn']);
  const b = await fixture('history-b', ['Beta: distinct history']);
  const child = await fixture('history-child', ['Child-only turn'], a.session);
  const empty = await fixture('history-empty', []);
  const rawObserve = ctx.sessionQuery.observeSession.bind(ctx.sessionQuery);
  const leases = [];
  const requests = [];
  const tracedObserve = async (id, options) => {
    requests.push({ id, options });
    assert.equal(options.projectionMode, 'none');
    assert.ok(options.signal instanceof AbortSignal);
    const lease = await rawObserve(id, options);
    assert.equal(lease.projections, undefined, 'no projection snapshot requested');
    leases.push(lease);
    return lease;
  };
  const restoreTrace = replace(ctx.sessionQuery, 'observeSession', tracedObserve);
  const read = id => ctx.recallHistory.withSnapshot(id, describe);
  const disposed = lease => assert.throws(() => lease.retain(), /disposed/, 'native lease released');
  let liveA, liveB, liveChild;
  try {
    await check('native live identities, ordered events, fork prefix and empty history', async () => {
      liveA = await read(a.session.id); liveB = await read(b.session.id); liveChild = await read(child.session.id);
      assert.equal(liveA.source, 'live'); assert.equal(liveB.source, 'live');
      assert.equal(liveA.header.id, 'history-a'); assert.equal(liveB.header.id, 'history-b');
      assert.deepEqual(liveA.events.map(e => e.type), ['turn/start', 'user/message', 'turn/end', 'turn/start', 'user/message', 'turn/end']);
      assert.equal(liveA.events[1].data.content[0].text, 'Alpha: native first turn');
      assert.equal(liveB.events[1].data.content[0].text, 'Beta: distinct history');
      assert.deepEqual(liveA.events.map(e => e.seq), [0, 1, 2, 3, 4, 5]);
      assert.equal(liveA.cursor, 5); assert.equal(liveB.cursor, 2);
      assert.equal(liveA.inheritedEventCount, 0);
      assert.equal(liveChild.header.parentSession, a.session.id);
      assert.equal(liveChild.inheritedEventCount, 6);
      assert.deepEqual(liveChild.events.slice(0, 6), liveA.events);
      assert.equal(Object.isFrozen(liveA.events), true);
      assert.equal(Object.isFrozen(liveA.events[1].data), true);
      const blank = await read(empty.session.id);
      assert.equal(blank.cursor, -1); assert.deepEqual(blank.events, []);
      leases.forEach(disposed);
    });

    await check('live lazy cut excludes concurrent appends; pre-observation subscription bridges cursor', async () => {
      const buffered = [];
      const off = ctx.on('session/event', (session, event) => { if (session === a.session) buffered.push(event); });
      try {
        const before = await ctx.recallHistory.withSnapshot(a.session.id, snapshot => {
          assert.equal(snapshot.cursor, 5);
          a.session.append('turn/start', { turn: 3 });
          a.session.append('turn/end', { turn: 3, reason: { kind: 'completed' } });
          assert.equal(snapshot.events.length, 6, 'first lazy read is still the captured cut');
          return describe(snapshot);
        });
        sameCut(before, liveA);
        assert.deepEqual(buffered.filter(e => e.seq > before.cursor).map(e => e.seq), [6, 7]);
        const after = await read(a.session.id);
        assert.equal(after.cursor, 7);
        assert.deepEqual(after.events, [...before.events, ...buffered]);
        sameCut(await read(child.session.id), liveChild);
        liveA = after;
      } finally { await off(); }
      await a.flush();
    });

    await check('native persisted cold A/B/fork/empty cuts equal their closed live cuts', async () => {
      for (const item of [a, b, child, empty]) await item.close();
      for (const expected of [liveA, liveB, liveChild]) {
        const started = performance.now();
        const cold = await read(expected.header.id);
        evidence.timings[`${expected.header.id}ColdMs`] = performance.now() - started;
        assert.equal(cold.source, 'prepared'); assert.ok(cold.revision);
        sameCut(cold, expected);
        evidence.observations.push({ id: cold.header.id, source: cold.source, cursor: cold.cursor, inheritedEventCount: cold.inheritedEventCount, parentSession: cold.header.parentSession, revision: cold.revision });
      }
      const blank = await read(empty.session.id);
      assert.equal(blank.source, 'prepared'); assert.equal(blank.cursor, -1);
      leases.forEach(disposed);
    });

    await check('snapshot scope closes on success, callback exception and caller cancellation', async () => {
      let escaped;
      await ctx.recallHistory.withSnapshot(a.session.id, snapshot => { escaped = snapshot; });
      assert.throws(() => escaped.events, { code: 'recall/history-scope-closed' });
      assert.throws(() => escaped.revision, { code: 'recall/history-scope-closed' });
      const fault = new Error('consumer failure');
      await assert.rejects(ctx.recallHistory.withSnapshot(a.session.id, () => { throw fault; }), error => error === fault);
      const controller = new AbortController();
      const entered = deferred(); const consumer = deferred();
      let operationSignal;
      const pending = ctx.recallHistory.withSnapshot(b.session.id, (snapshot, signal) => {
        escaped = snapshot; operationSignal = signal; entered.resolve(); return consumer.promise;
      }, controller.signal);
      const rejected = assert.rejects(pending, error => error === fault);
      await entered.promise;
      controller.abort(fault);
      await rejected;
      assert.equal(operationSignal.aborted, true);
      assert.throws(() => escaped.events, { code: 'recall/history-scope-closed' });
      disposed(leases.at(-1));
      consumer.reject(new Error('late callback rejection is observed'));
      await immediate();
      const before = requests.length;
      await assert.rejects(ctx.recallHistory.withSnapshot(a.session.id, () => assert.fail('must not enter'), controller.signal), error => error === fault);
      assert.equal(requests.length, before, 'already-cancelled calls never acquire');
      leases.forEach(disposed);
    });

    await check('late native observation after acquisition cancellation is disposed', async () => {
      const acquired = deferred(); const deliver = deferred(); const delivered = deferred();
      const restore = replace(ctx.sessionQuery, 'observeSession', async (id, options) => {
        const lease = await tracedObserve(id, options);
        acquired.resolve(lease); await deliver.promise; delivered.resolve(); return lease;
      });
      const controller = new AbortController();
      try {
        const pending = ctx.recallHistory.withSnapshot(a.session.id, () => assert.fail('cancelled consumer entered'), controller.signal);
        const rejected = assert.rejects(pending, { name: 'AbortError' });
        const lease = await acquired.promise;
        controller.abort(); await rejected;
        deliver.resolve(); await delivered.promise; await immediate();
        disposed(lease);
      } finally { deliver.resolve(); restore(); }
    });

    await check('cancellation reaches native pending persistence; no late observation is acquired', async () => {
      const entered = deferred(); const release = deferred(); const settled = deferred();
      const original = ctx.sessionPersistence.stat.bind(ctx.sessionPersistence);
      let nativeSignal;
      const restore = replace(ctx.sessionPersistence, 'stat', async (id, options) => {
        nativeSignal = options.signal; entered.resolve(); await release.promise;
        try { return await original(id, options); } finally { settled.resolve(); }
      });
      const controller = new AbortController();
      const before = leases.length;
      try {
        const pending = ctx.recallHistory.withSnapshot(a.session.id, () => assert.fail('cancelled source entered'), controller.signal);
        const rejected = assert.rejects(pending, { name: 'AbortError' });
        await entered.promise;
        controller.abort(); await rejected;
        assert.equal(nativeSignal.aborted, true);
        release.resolve(); await settled.promise; await immediate();
        assert.equal(leases.length, before);
      } finally { release.resolve(); restore(); }
    });

    await check('native missing/corrupt/read failures remain explicit; wrong identity is rejected', async () => {
      await assert.rejects(read('history-missing'), { code: 'SESSION_QUERY_SESSION_NOT_FOUND' });
      await assert.rejects(read(''), { code: 'recall/history-invalid-id' });
      const mismatch = replace(ctx.sessionQuery, 'observeSession', (_, options) => tracedObserve(b.session.id, options));
      try { await assert.rejects(read(a.session.id), { code: 'recall/history-inconsistent' }); }
      finally { mismatch(); }
      disposed(leases.at(-1));
      const io = new Error('fixture I/O failure');
      const restoreStat = replace(ctx.sessionPersistence, 'stat', async () => { throw io; });
      try { await assert.rejects(read(a.session.id), error => error.code === 'SESSION_QUERY_PERSISTENCE_FAILED' && error.cause === io); }
      finally { restoreStat(); }

      // Fault injection only: locate the artifact CREATED by the native fixture.
      // Production history code neither knows a JSONL path nor decodes its bytes.
      const broken = await fixture('history-corrupt', ['Corrupt this isolated fixture only']);
      await broken.close();
      const root = resolve(process.env.DSH_HOME, 'sessions');
      assert.ok(relative(resolve(process.env.DSH_HOME), root) === 'sessions');
      const files = await readdir(root, { recursive: true, withFileTypes: true });
      const artifact = files.filter(entry => entry.isFile() && /\.jsonl(?:\.zstd)?$/.test(entry.name)
        && entry.parentPath.split(/[\\/]/).at(-1) === broken.session.id);
      assert.equal(artifact.length, 1);
      const path = resolve(artifact[0].parentPath, artifact[0].name);
      assert.ok(!relative(root, path).startsWith('..'));
      await writeFile(path, 'intentionally invalid isolated native log\n');
      await assert.rejects(read(broken.session.id), { code: 'SESSION_QUERY_CORRUPT_SESSION' });
    });

    await check('prepared cut survives durable append; re-observation follows the new revision', async () => {
      const native = ctx.sessions.prepare(b.session.id, { seed: liveB.events, meta: liveB.header, inheritedEventCount: liveB.inheritedEventCount });
      appendTurn(native, 2, 'Beta durable append');
      await ctx.recallHistory.withSnapshot(b.session.id, async old => {
        const writer = await ctx.sessionPersistence.open(b.session.id, 'write');
        try {
          await writer.append(native.snapshotEvents(3)); await writer.flush();
        } finally { await writer.close(); }
        assert.equal(old.cursor, 2); assert.equal(old.events.length, 3);
        const newer = await read(b.session.id);
        assert.equal(newer.source, 'prepared'); assert.equal(newer.cursor, native.seq - 1);
        assert.equal(newer.events[3].type, 'session/end-seed');
        assert.notEqual(newer.revision, old.revision);
        assert.deepEqual(newer.events.slice(0, 3), old.events);
      });
    });

    await check('Gateway report provides the SessionId; receipt stays independent of pending history', async () => {
      const peer = new Peer(ctx, { principal: { kind: 'recall-history-test', id: 'reader' } });
      const unregister = ctx.remoteAccess.registerPolicy('recall-history-test', {
        bindings: () => [{ resource: { kind: 'session', id: a.session.id }, role: { name: 'history-report', resource: 'session', actions: ['recall/openPage', 'recall/reportView'] } }],
      });
      const invoke = (method, value) => ctx.typertGateway.invoke({ namespace: 'recall', method, args: { [method === 'openPage' ? 'request' : 'report']: value }, peer });
      const gate = deferred(); const waiting = deferred();
      let restore;
      try {
        const registration = await invoke('openPage', { protocolVersion: 1, pageId: 'history-page', registrationSequence: 1, sessionId: a.session.id });
        const report = { protocolVersion: 1, pageId: 'history-page', ...registration, sequence: 1, activationSequence: 1, view: view(a.session.id) };
        const before = requests.length;
        await invoke('reportView', report);
        assert.equal(requests.length, before, 'receipt never observes history');
        const selectedId = ctx.recallPages.snapshot().find(row => row.pageId === 'history-page').view.sessionId;
        assert.equal(selectedId, a.session.id);
        restore = replace(ctx.sessionQuery, 'observeSession', async (id, options) => {
          waiting.resolve(); await gate.promise; return tracedObserve(id, options);
        });
        const pending = read(selectedId);
        await waiting.promise;
        const samples = [];
        for (let sequence = 2; sequence <= 11; sequence++) {
          const start = performance.now();
          assert.equal((await invoke('reportView', { ...report, sequence })).accepted, true);
          samples.push(performance.now() - start);
        }
        assert.equal(requests.length, before, 'receipts completed before history gate opened');
        evidence.timings.receiptMsWhileHistoryWaiting = samples;
        gate.resolve();
        assert.equal((await pending).header.id, selectedId);
        await assert.rejects(invoke('withSnapshot', {}), error => error.code?.startsWith('gateway/'));
      } finally { gate.resolve(); restore?.(); unregister(); await peer.dispose(); }
    });

    await check('independent cold sample latency and native prepared-cache reuse', async () => {
      const large = await fixture('history-timing', Array.from({ length: 750 }, (_, i) => `Native timing fixture turn ${i}: ` + 'history '.repeat(40)));
      await large.close();
      const start = performance.now();
      const cold = await read(large.session.id);
      const coldMs = performance.now() - start;
      const warm = performance.now();
      sameCut(await read(large.session.id), cold);
      evidence.timings.large = { events: cold.events.length, coldMs, cachedMs: performance.now() - warm, storedBytes: (await ctx.sessionPersistence.stat(large.session.id)).sizeBytes };
      assert.equal(cold.events.length, 2250);
    });

    await check('plugin unload cancels acquired and acquiring scopes; reload can read again', async () => {
      const service = ctx.recallHistory;
      const entered = deferred(); const consumer = deferred();
      const pending = service.withSnapshot(a.session.id, () => { entered.resolve(); return consumer.promise; });
      const rejected = assert.rejects(pending, { name: 'AbortError' });
      await entered.promise;
      const activeLease = leases.at(-1);
      const acquired = deferred(); const deliver = deferred();
      const restore = replace(ctx.sessionQuery, 'observeSession', async (id, options) => {
        const lease = await tracedObserve(id, options); acquired.resolve(lease); await deliver.promise; return lease;
      });
      try {
        const late = service.withSnapshot(b.session.id, () => assert.fail('unloaded consumer entered'));
        const lateRejected = assert.rejects(late, { name: 'AbortError' });
        const lateLease = await acquired.promise;
        const fiber = [...ctx.registry.get(RecallHistoryService).fibers][0];
        await fiber.restart();
        await Promise.all([rejected, lateRejected]);
        disposed(activeLease);
        deliver.resolve(); consumer.resolve(); await immediate();
        disposed(lateLease);
        assert.notEqual(ctx.recallHistory, service);
        await assert.rejects(service.withSnapshot(a.session.id, describe), { name: 'AbortError' });
      } finally { deliver.resolve(); consumer.resolve(); restore(); }
      assert.equal((await read(a.session.id)).header.id, a.session.id);
      // Restart also remounts preparation, which may observe the reported page.
      // Its new lease is live work, so drain that preparation before checking all
      // leases; the old active and late leases were checked above independently.
      await ctx.recallPreparation.wait(a.session.id);
      leases.forEach(disposed);
    });
    evidence.leaseCount = leases.length;
    evidence.querySearchMode = ctx.sessionQuery.config.openAt;
    assert.equal(evidence.querySearchMode, 'never');
    const output = join(process.env.DSH_HOME, '..', 'history-evidence.json');
    await writeFile(output, JSON.stringify(evidence, null, 2));
    console.log(`History evidence: ${output}`);
  } finally {
    restoreTrace();
    for (const item of [a, b, child, empty]) if (ctx.sessions.get(item.session.id)) await item.close(false);
  }
}
