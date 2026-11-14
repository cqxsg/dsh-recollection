import assert from 'node:assert/strict';
import { verifyRecordProof } from './record-proof-native.mjs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Session, buildForkSeed } from '@deepseek-ai/dsh-session';
import { HistoryRecordCache } from '../../lib/index.js';
import { rangeFixture, sessionCut, text, image, file } from '../../support/fixtures/range.mjs';
import { createHistoryFixture } from '../../support/fixtures/history.mjs';

const immediate = () => new Promise(resolve => setImmediate(resolve));
const contents = records => records.flatMap(record => record.blocks.map(block => block.content));
const eventsSelection = (events, includeToolPairs = false) => ({ kind: 'events', eventSeqs: events.map(event => event.seq), includeToolPairs });

export async function verifyRecords(ctx) {
  const projections = ctx.sessions.messageProjections;
  const evidence = { node: process.version, dsh: '0.2.1-rc.4', cases: [], samples: {} };
  const check = async (label, task) => { await task(); evidence.cases.push(label); console.log(`PASS: ${label}`); };
  await verifyRecordProof(ctx, check);
  let next = 0;
  const detached = () => Session.create(`records-unit-${next++}`, undefined, undefined, 0, projections);
  const prepare = (cache, session, options, signal) => cache.prepareBatch(sessionCut(session), projections, options, signal);
  const allSurface = session => [...session.surface.nodes];

  await check('canonical message, call and result units retain exact native text, metadata, block paths and attachment references', async () => {
    const session = detached(), f = rangeFixture(session), cache = new HistoryRecordCache();
    f.append('turn/start', { turn: 7 }); f.append('step/start', { turn: 7, step: 1 });
    const body = ' 甲\r\n乙🙂\n尾\t ';
    const user = f.user([text(body), text(''), image('input'), file]);
    const x = f.callBlock('x', 'read', ' { "path": "x",\n "n": 1 } '), y = f.callBlock('y', 'read_image');
    const a = f.assistant([{ type: 'reasoning', text: 'never copy this' }, text('before'), x, text('after'), y], 7, 1);
    const xlog = f.callLog(x, 7, 1), ylog = f.callLog(y, 7, 1);
    const ry = f.result(y, ylog, [image('output'), text('screenshot caption')], 7, 1);
    const notice = f.user([text('synthetic context')], { kind: 'future-injection' });
    const rx = f.result(x, xlog, [text('line 1\nline 2\r\n'), file], 7, 1);
    f.append('step/end', { turn: 7, step: 1 }); f.append('turn/end', { turn: 7, reason: { kind: 'completed' } });
    f.summary(allSurface(session));
    const batch = await prepare(cache, session);
    const records = cache.records(batch);
    assert.deepEqual(records.map(r => [r.origin.seq, r.kind]), [[user.seq, 'message'], [a.seq, 'message'], [a.seq, 'tool_call'], [a.seq, 'message'], [a.seq, 'tool_call'], [ry.seq, 'tool_result'], [notice.seq, 'message'], [rx.seq, 'tool_result']]);
    assert.deepEqual(records[0].blocks.map(b => b.content), user.data.content);
    assert.equal(records[0].blocks[0].content.text, body);
    assert.deepEqual([records[0].origin.turn, records[0].origin.step], [7, 1]);
    assert.equal(records[0].origin.time, user.time);
    assert.equal(records[0].origin.messageId, user.data.id);
    assert.equal(records[0].origin.authorship, 'human');
    assert.equal(records.find(r => r.origin.seq === notice.seq).origin.authorship, 'injected');
    assert.equal(records.find(r => r.origin.seq === notice.seq).origin.sourceKind, 'future-injection');
    assert.equal(records[2].blocks[0].content.arguments, x.arguments);
    assert.equal(records[2].blocks[0].path, 'data.message.content[2]');
    assert.equal(records[2].origin.provider, 'fixture');
    assert.equal(records.at(-1).origin.isError, false);
    assert.equal(contents(records).some(block => block.type === 'reasoning'), false);
    assert.equal(batch.pairs.length, 2);
    assert.ok(batch.pairs.every(pair => pair.status === 'paired'));
    assert.deepEqual(batch.pairs.find(pair => pair.callId === 'x').resultRecordIds, [records.at(-1).id]);
    assert.ok(cache.coverage(batch).filter(c => c.attachmentBytes === 'not_loaded').length === 4);
    assert.ok(records.every(record => /^[a-f0-9]{64}$/.test(record.fingerprint) && Object.isFrozen(record.blocks)));
    assert.throws(() => { records[0].blocks[2].content.attachment.name = 'changed'; }, TypeError);
    assert.equal(user.data.content[2].attachment.name, 'input.png');
    evidence.samples.canonical = records;
  });

  await check('explicit context applies the same exclusions and does not expand the default recall range', async () => {
    const session = detached(), f = rangeFixture(session), cache = new HistoryRecordCache();
    const user = f.user([text('ordinary reasoning and recall_read words')]);
    const recall = f.callBlock('own-copy', 'recall_read'), ordinary = f.callBlock('read-again', 'read');
    const assistant = f.assistant([text('before copy'), recall, { type: 'reasoning', text: 'secret' }, text('after copy'), ordinary]);
    const copied = f.result(recall, f.callLog(recall), [text('copied original')]);
    const result = f.result(ordinary, f.callLog(ordinary), [text('copied original')]);
    const checkpoint = f.user([text('checkpoint body')], { kind: 'compact-checkpoint', compactionId: 'fixture' });
    assert.deepEqual(cache.records(await prepare(cache, session)), []);
    const context = await prepare(cache, session, { selection: eventsSelection([user, assistant, copied, result, checkpoint]) });
    const records = cache.records(context);
    assert.deepEqual(records.map(r => [r.origin.seq, r.kind]), [[user.seq, 'message'], [assistant.seq, 'message'], [assistant.seq, 'message'], [assistant.seq, 'tool_call'], [result.seq, 'tool_result']]);
    assert.ok(context.sources.every(source => source.retention === 'retained'));
    assert.equal(contents(records).filter(block => block.type === 'text' && block.text === 'copied original').length, 1, 'other tools keep independently produced history');
    const defaultAgain = await prepare(cache, session);
    assert.deepEqual(defaultAgain.recordIds, [], 'context-cached bodies cannot leak into E(C)');
    assert.ok(cache.stats().records > 0);
  });

  await check('tool pair expansion uses identity rather than adjacency and reports missing or ambiguous counterparts', async () => {
    const session = detached(), f = rangeFixture(session), cache = new HistoryRecordCache();
    const a = f.callBlock('pair'), b = f.callBlock('pair', 'read_image');
    const ca = f.assistant([a], 1, 1), la = f.callLog(a, 1, 1);
    const cb = f.assistant([b], 2, 1), lb = f.callLog(b, 2, 1);
    f.user([text('unrelated between calls and results')]);
    const rb = f.result(b, lb, [image('paired')], 2, 1);
    const ra = f.result(a, la, [text('first pair result')], 1, 1);
    const batch = await prepare(cache, session, { selection: eventsSelection([ra], true) });
    assert.deepEqual(cache.records(batch).map(r => r.origin.seq), [ca.seq, ra.seq]);
    const other = await prepare(cache, session, { selection: eventsSelection([rb], true) });
    assert.deepEqual(cache.records(other).map(r => r.origin.seq), [cb.seq, rb.seq]);
    assert.notEqual(other.pairs[0].id, batch.pairs[0].id);
    const missing = f.callBlock('unfinished'); const only = f.assistant([missing], 3, 1); f.callLog(missing, 3, 1);
    assert.equal((await prepare(cache, session, { selection: eventsSelection([only], true) })).pairs[0].status, 'result_missing');
    const logOnly = f.callBlock('log-only'); const log = f.callLog(logOnly, 4, 1); const orphan = f.result(logOnly, log, [text('native result')], 4, 1);
    const orphanBatch = await prepare(cache, session, { selection: eventsSelection([orphan], true) });
    assert.equal(orphanBatch.pairs[0].status, 'call_record_missing');
    assert.deepEqual(orphanBatch.pairs[0].nativeCallSeqs, [log.seq]);
    f.result(a, la, [text('second append result')], 1, 1);
    const ambiguous = await prepare(cache, session, { selection: eventsSelection([ra], true) });
    assert.equal(ambiguous.pairs[0].status, 'ambiguous');
    assert.deepEqual(cache.records(ambiguous).map(r => r.origin.seq), [ra.seq], 'no guessed pair expansion');
  });

  await check('source coverage catches older content leaving later, reuses identical records, and keeps old cut selection fixed', async () => {
    const session = detached(), f = rangeFixture(session), cache = new HistoryRecordCache();
    const earlier = f.user([text('same text')]), later = f.user([text('same text')]);
    f.summary([later.seq]);
    const cut = sessionCut(session);
    const before = await cache.prepareBatch(cut, projections);
    const old = cache.records(before)[0];
    assert.equal(old.origin.seq, later.seq);
    f.summary([earlier.seq]);
    const after = await prepare(cache, session);
    assert.deepEqual(cache.records(after).map(r => r.origin.seq), [earlier.seq, later.seq]);
    assert.equal(after.preparedInBatch, 1);
    assert.strictEqual(cache.records(after)[1], old);
    assert.notEqual(cache.records(after)[0].id, old.id, 'no text-based deduplication across sources');
    assert.deepEqual(cache.records(before), [old]);
    const oldAgain = await cache.prepareBatch(cut, projections);
    assert.deepEqual(oldAgain.recordIds, before.recordIds);
    assert.equal(oldAgain.preparedInBatch, 0);
  });

  await check('offload and later replacement change snapshot reasons without duplicating the canonical original', async () => {
    const session = detached(), f = rangeFixture(session), cache = new HistoryRecordCache();
    const source = f.user([text('caption stays intact'), image('offloaded')]);
    f.offload(source, [0]);
    const partial = await prepare(cache, session), record = cache.records(partial)[0];
    assert.equal(partial.sources[0].retention, 'partial');
    assert.equal(record.blocks[1].content.offloaded, undefined);
    assert.equal(record.blocks[1].attachmentBytes, 'not_loaded');
    f.summary([source.seq]);
    const removed = await prepare(cache, session);
    assert.equal(removed.sources[0].retention, 'removed');
    assert.equal(partial.sources[0].retention, 'partial');
    assert.strictEqual(cache.records(removed)[0], record);
    assert.equal(removed.preparedInBatch, 0);
    assert.deepEqual(cache.stats(), { records: 1, sourceBlocks: 2 });
  });

  await check('record and character batch limits yield to the event loop and never split or skip oversized records', async () => {
    const session = detached(), f = rangeFixture(session), cache = new HistoryRecordCache();
    const small = f.user([text('a')]), large = f.user([text('x🙂\n'.repeat(20_000)), text('last native block')]), last = f.user([text('z')]);
    f.summary([small.seq, large.seq, last.seq]);
    const first = await prepare(cache, session, { maxRecords: 1 });
    assert.equal(first.status, 'incomplete'); assert.equal(first.preparedInBatch, 1);
    assert.throws(() => cache.records(first), { code: 'recall/records-incomplete' });
    assert.equal(cache.coverage(first).length, 1);
    let yielded = false; setImmediate(() => { yielded = true; });
    const second = await prepare(cache, session, { maxTextChars: 1, chunkChars: 127 });
    assert.equal(yielded, true); assert.equal(second.preparedInBatch, 1);
    assert.equal(second.pendingRecordIds.length, 1);
    assert.equal(cache.coverage(second).length, 3, 'the long message still has its two original blocks');
    const complete = await prepare(cache, session, { maxRecords: 1 });
    assert.equal(complete.status, 'complete');
    assert.deepEqual(cache.records(complete).map(r => r.origin.seq), [small.seq, large.seq, last.seq]);
    assert.equal(cache.records(complete)[1].blocks[0].content.text, large.data.content[0].text);
    const reference = new HistoryRecordCache();
    const referenceBatch = await prepare(reference, session, { maxTextChars: 1_000_000, chunkChars: 4096 });
    assert.deepEqual(cache.records(complete).map(r => r.fingerprint), reference.records(referenceBatch).map(r => r.fingerprint), 'fingerprints do not depend on work chunk boundaries');
  });

  await check('cancellation during a long record retains only completed coverage and retries with the same whole-record identity', async () => {
    const session = detached(), f = rangeFixture(session), cache = new HistoryRecordCache();
    const short = f.user([text('completed')]);
    const long = f.user([text('first block'), text('🙂\ud800\n'.repeat(30_000))]);
    f.summary([short.seq, long.seq]);
    const initial = await prepare(cache, session, { maxRecords: 1 });
    const controller = new AbortController();
    setImmediate(() => controller.abort(new Error('stop during fingerprint')));
    await assert.rejects(prepare(cache, session, { chunkChars: 64 }, controller.signal), /stop during fingerprint/);
    assert.deepEqual(cache.stats(), { records: 1, sourceBlocks: 1 });
    assert.equal(cache.coverage(initial).length, 1, 'no partial long record is published');
    const retry = await prepare(cache, session, { chunkChars: 513 });
    assert.equal(retry.preparedInBatch, 1);
    assert.deepEqual(retry.recordIds, initial.recordIds);
    assert.equal(cache.records(retry)[1].blocks[1].content.text, long.data.content[1].text);
    const other = new HistoryRecordCache(), checkBatch = await prepare(other, session, { maxTextChars: 1_000_000, chunkChars: 4096 });
    assert.equal(cache.records(retry)[1].fingerprint, other.records(checkBatch)[1].fingerprint);
  });

  await check('native content or provenance changes invalidate cached selections instead of silently replacing their body', async () => {
    for (const mutate of [
      cut => { cut.events[0].data.content[0].text = 'replacement under the same header'; },
      cut => { cut.events[0].data.id = 'different-message'; },
      cut => { cut.events[0].time++; },
      cut => { cut.events[0].data.content[1].attachment.name = 'changed attachment metadata'; },
      cut => { cut.header.createdAt++; },
    ]) {
      const session = detached(), f = rangeFixture(session), cache = new HistoryRecordCache();
      const source = f.user([text('original'), file]); f.summary([source.seq]);
      const before = await prepare(cache, session);
      const broken = structuredClone(sessionCut(session)); mutate(broken);
      await assert.rejects(cache.prepareBatch(broken, projections), { code: 'recall/records-source-changed' });
      assert.deepEqual(cache.stats(), { records: 0, sourceBlocks: 0 });
      assert.throws(() => cache.records(before), { code: 'recall/records-closed' });
    }
    const session = detached(), f = rangeFixture(session), cache = new HistoryRecordCache();
    const retained = f.user([text('context only')]);
    await prepare(cache, session, { selection: eventsSelection([retained]) });
    const broken = structuredClone(sessionCut(session)); broken.events[retained.seq].data.content[0].text = 'changed retained body';
    await assert.rejects(cache.prepareBatch(broken, projections), { code: 'recall/records-source-changed' });
  });

  await check('per-session isolation, forged selections, invalid inputs, concurrent preparation and disposal fail explicitly', async () => {
    const session = detached(), f = rangeFixture(session), cache = new HistoryRecordCache();
    const source = f.user([text('separate session')]); f.summary([source.seq]);
    const batch = await prepare(cache, session);
    await assert.rejects(prepare(cache, detached()), { code: 'recall/records-scope' });
    assert.equal(cache.records(batch).length, 1);
    assert.throws(() => cache.records({ ...batch }), { code: 'recall/records-closed' });
    for (const options of [{ maxRecords: 0 }, { chunkChars: -1 }, { selection: { kind: 'events', eventSeqs: [999] } }]) {
      await assert.rejects(prepare(cache, session, options), { code: 'recall/records-invalid' });
    }
    cache.clear();
    const pending = prepare(cache, session, { chunkChars: 1 });
    await assert.rejects(prepare(cache, session), { code: 'recall/records-busy' });
    cache.dispose();
    await assert.rejects(pending, { code: 'recall/records-closed' });
    assert.deepEqual(cache.stats(), { records: 0, sourceBlocks: 0 });
    await assert.rejects(prepare(cache, session), { code: 'recall/records-closed' });
  });

  await check('fork origins preserve inherited turn/step while keeping parent and child record identities distinct', async () => {
    const parent = detached(), f = rangeFixture(parent), parentCache = new HistoryRecordCache();
    f.append('turn/start', { turn: 3 }); f.append('step/start', { turn: 3, step: 2 });
    const original = f.user([text('inherited body')]);
    f.append('step/end', { turn: 3, step: 2 }); f.append('turn/end', { turn: 3, reason: { kind: 'completed' } });
    f.summary([original.seq]);
    const inherited = parent.seq;
    const child = Session.create('records-fork', buildForkSeed(parent.snapshotEvents(), parent.seq - 1), {
      ...parent.header, id: 'records-fork', parentSession: parent.id, isSeeded: true,
    }, inherited, projections);
    const cf = rangeFixture(child), own = cf.user([text('child body without a known turn')]); cf.summary([own.seq]);
    const parentBatch = await prepare(parentCache, parent), childCache = new HistoryRecordCache(), childBatch = await prepare(childCache, child);
    const [fromParent, fromChild] = [parentCache.records(parentBatch)[0], childCache.records(childBatch)[0]];
    assert.notEqual(fromParent.id, fromChild.id);
    assert.equal(fromChild.origin.inherited, true);
    assert.deepEqual([fromChild.origin.turn, fromChild.origin.step], [3, 2]);
    const childOwn = childCache.records(childBatch)[1];
    assert.equal(childOwn.origin.inherited, false); assert.equal(childOwn.origin.turn, null); assert.equal(childOwn.origin.step, null);
  });

  await check('real live batches release each native lease; cold rebuild and reuse match without a persistent plugin history copy', async () => {
    const fixture = await createHistoryFixture(ctx, 'records-live-cold', []);
    const f = rangeFixture(fixture.session), cache = new HistoryRecordCache();
    f.append('turn/start', { turn: 1 }); f.append('step/start', { turn: 1, step: 1 });
    const user = f.user([text('native original\r\nline 2'), file]);
    const call = f.callBlock('records-native'); const assistant = f.assistant([text('native reply'), call]);
    const result = f.result(call, f.callLog(call), [text('saved output'), image('native')]);
    f.offload(result, [0]); const pruned = f.prune(result);
    f.append('step/end', { turn: 1, step: 1 }); f.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
    f.summary([user.seq, assistant.seq, pruned.seq]);
    await fixture.flush();
    const raw = ctx.sessionQuery.observeSession.bind(ctx.sessionQuery);
    const descriptor = Object.getOwnPropertyDescriptor(ctx.sessionQuery, 'observeSession');
    const leases = [];
    Object.defineProperty(ctx.sessionQuery, 'observeSession', { configurable: true, value: async (...args) => {
      const lease = await raw(...args); leases.push(lease); return lease;
    } });
    let closed = false;
    try {
      const read = (target, options = {}) => ctx.recallHistory.withSnapshot(fixture.session.id,
        (cut, signal) => target.prepareBatch(cut, projections, options, signal), undefined, { waitForQuiescence: true });
      let batch;
      do {
        batch = await read(cache, { maxRecords: 1 });
        assert.throws(() => leases.at(-1).retain(), /disposed/);
      } while (batch.status !== 'complete');
      const live = cache.records(batch);
      assert.equal(live.length, 4); assert.equal(leases.length, 4);
      await fixture.close(); closed = true;
      const reused = await read(cache);
      assert.equal(reused.preparedInBatch, 0);
      assert.strictEqual(cache.records(reused)[0], live[0]);
      const restarted = new HistoryRecordCache(), rebuilt = await read(restarted);
      assert.deepEqual(restarted.records(rebuilt), live);
      assert.equal(leases.at(-1).source, 'prepared');
      leases.forEach(lease => assert.throws(() => lease.retain(), /disposed/));
      evidence.samples.liveCold = live;
      evidence.leases = leases.length;
    } finally {
      if (descriptor) Object.defineProperty(ctx.sessionQuery, 'observeSession', descriptor);
      else Reflect.deleteProperty(ctx.sessionQuery, 'observeSession');
      cache.dispose();
      if (!closed) await fixture.close(false);
    }
  });

  await check('a fixed native observation excludes concurrent appends and drains cooperative cancellation before releasing its lease', async () => {
    const fixture = await createHistoryFixture(ctx, 'records-cut-cancel', []);
    const f = rangeFixture(fixture.session), cache = new HistoryRecordCache();
    const original = f.user([text('large body\n'.repeat(20_000))]); f.summary([original.seq]);
    try {
      let appended;
      const cutBatch = await ctx.recallHistory.withSnapshot(fixture.session.id, async (cut, signal) => {
        const pending = cache.prepareBatch(cut, projections, { chunkChars: 127 }, signal);
        appended = f.user([text('new after cut')]); f.summary([appended.seq]);
        const batch = await pending;
        assert.ok(batch.cursor < appended.seq);
        return batch;
      });
      assert.deepEqual(cache.records(cutBatch).map(r => r.origin.seq), [original.seq]);
      const next = await ctx.recallHistory.withSnapshot(fixture.session.id, (cut, signal) => cache.prepareBatch(cut, projections, {}, signal));
      assert.deepEqual(cache.records(next).map(r => r.origin.seq), [original.seq, appended.seq]);
      const cancelledCache = new HistoryRecordCache(), controller = new AbortController();
      const pending = ctx.recallHistory.withSnapshot(fixture.session.id, (cut, signal) => cancelledCache.prepareBatch(cut, projections, { chunkChars: 64 }, signal), controller.signal, { waitForQuiescence: true });
      await immediate(); controller.abort(new Error('caller stop'));
      await assert.rejects(pending, /caller stop/);
      assert.deepEqual(cancelledCache.stats(), { records: 0, sourceBlocks: 0 });
    } finally { cache.dispose(); await fixture.close(); }
  });

  const path = join(process.env.DSH_HOME, '..', 'records-evidence.json');
  await writeFile(path, JSON.stringify(evidence, null, 2));
  console.log(`Record evidence: ${path}`);
}
