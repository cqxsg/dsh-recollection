import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Session, buildForkSeed } from '@deepseek-ai/dsh-session';
import { formatSpillNotice } from '@deepseek-ai/dsh-spill-policy/notice';
import { foldSurface } from '@deepseek-ai/dsh-session/surface';
import { classifyHistoryRange, DIAGNOSTIC_TOOL_NAME } from '../../lib/index.js';
import { createHistoryFixture } from '../../support/fixtures/history.mjs';
import { rangeFixture, sessionCut, text, image, file } from '../../support/fixtures/range.mjs';

const seqs = range => range.sources.map(source => source.seq);
const sourceAt = (range, event) => range.sources.find(source => source.seq === event.seq);

export async function verifyRange(ctx) {
  const projections = ctx.sessions.messageProjections;
  assert.ok(projections.some(projection => projection.type === 'image/offload'), 'real Web profile owns the image interpreter');
  const evidence = { dsh: '0.2.1-rc.4', node: process.version, cases: [], samples: {} };
  const check = async (label, task) => { await task(); evidence.cases.push(label); console.log(`PASS: ${label}`); };
  let next = 0;
  const detached = () => Session.create(`range-unit-${next++}`, undefined, undefined, 0, projections);
  const classify = session => classifyHistoryRange(sessionCut(session), projections);

  await check('empty and fully retained histories classify as empty without preparing body content', () => {
    const session = detached(), f = rangeFixture(session);
    assert.deepEqual(seqs(classify(session)), []);
    f.user([text('still current'), file, image('current')]);
    f.assistant([text('still visible')]);
    const range = classify(session);
    assert.deepEqual(seqs(range), []);
    assert.equal(range.status, 'classified');
    assert.deepEqual(range.surfaceSeqs, [0, 1]);
    assert.equal(ctx.recallPages.status.recallAvailable, true);
    for (const name of ['recall_search', 'recall_read']) assert.ok(ctx.tools.get(name));
    assert.equal(ctx.tools.get(DIAGNOSTIC_TOOL_NAME), undefined);
  });

  await check('ordinary and recursive compression use actual surface positions, not numeric seq intervals or extra citations', () => {
    const session = detached(), f = rangeFixture(session);
    const a = f.user([text('original alpha')]);
    const b = f.assistant([text('original beta')]);
    const c = f.user([text('older seq exits later')]);
    const d = f.user([text('cited but retained')]);
    const first = f.summary([a.seq, b.seq], [d.seq]);
    const before = classify(session);
    assert.deepEqual(seqs(before), [a.seq, b.seq]);
    const second = f.summary([first.seq, c.seq]);
    assert.ok(first.seq > c.seq, 'fixture must exercise reverse numeric boundaries');
    const range = classify(session);
    assert.deepEqual(seqs(range), [a.seq, b.seq, c.seq]);
    assert.deepEqual(range.surfaceSeqs, [second.seq, d.seq]);
    assert.deepEqual(sourceAt(range, c).reasons, [{ kind: 'replacement', eventSeq: second.seq }]);
    assert.deepEqual(seqs(before), [a.seq, b.seq], 'old cut stays fixed');
    assert.ok(Object.isFrozen(range.sources) && Object.isFrozen(range.sources[0].blocks[0]));
    assert.throws(() => range.sources[0].blocks.push({}), TypeError);
    assert.equal(JSON.stringify(range).includes('original alpha'), false, 'no copied history text');
    evidence.samples.recursive = range;
  });

  await check('tool prune retains original output once; assistant and log-only call share one source', () => {
    const session = detached(), f = rangeFixture(session);
    const block = f.callBlock('read-file');
    const a = f.assistant([{ type: 'reasoning', text: 'private trace' }, text('reasoning is an ordinary topic'), block]);
    const call = f.callLog(block);
    const result = f.result(block, call, [text('original tool body'), image('screenshot'), file]);
    const pruned = f.prune(result);
    let range = classify(session);
    assert.deepEqual(seqs(range), [result.seq]);
    assert.deepEqual(sourceAt(range, result).reasons, [{ kind: 'tool_prune', eventSeq: pruned.seq }]);
    f.summary([a.seq, pruned.seq]);
    range = classify(session);
    assert.deepEqual(seqs(range), [a.seq, result.seq]);
    assert.deepEqual(sourceAt(range, a).blocks.map(b => [b.index, b.kind]), [[1, 'message'], [2, 'tool_call']]);
    assert.deepEqual(sourceAt(range, result).blocks.map(b => b.type), ['text', 'image', 'file']);
    assert.equal(range.sources.flatMap(s => s.blocks).filter(b => b.kind === 'tool_call').length, 1);
    assert.equal(sourceAt(range, call), undefined);
    assert.equal(sourceAt(range, pruned), undefined);
    evidence.samples.prune = range;
  });

  await check('partial image offload selects the whole original message and preserves occurrence indexes across decisions', () => {
    const session = detached(), f = rangeFixture(session);
    const original = f.user([text('retained caption'), image('first'), file, text('between'), image('second')]);
    const first = f.offload(original, [1]);
    const before = classify(session);
    assert.deepEqual(seqs(before), [original.seq]);
    assert.equal(sourceAt(before, original).retention, 'partial');
    assert.deepEqual(sourceAt(before, original).blocks.map(b => b.index), [0, 1, 2, 3, 4]);
    assert.deepEqual(sourceAt(before, original).reasons, [{ kind: 'image_offload', eventSeq: first.seq, imageIndexes: [1] }]);
    const projected = foldSurface(session.snapshotEvents(), projections).projectedMessages.get(original.seq);
    assert.equal(projected.content[4].offloaded, true);
    assert.equal(projected.content[1].offloaded, undefined);
    assert.equal(original.data.content[4].offloaded, undefined, 'native original stays unchanged');
    const second = f.offload(original, [0]);
    const after = classify(session);
    assert.deepEqual(sourceAt(after, original).reasons.map(r => [r.eventSeq, r.imageIndexes]), [[first.seq, [1]], [second.seq, [0]]]);
    f.summary([original.seq]);
    const removed = classify(session);
    assert.equal(sourceAt(removed, original).retention, 'removed');
    assert.deepEqual(sourceAt(removed, original).reasons.map(r => r.kind), ['image_offload', 'image_offload', 'replacement']);
    evidence.samples.offload = before;
  });

  await check('failed or interrupted compaction alone adds nothing; committed offload and replacement survive failure markers', () => {
    for (const failed of [false, true]) {
      const session = detached(), f = rangeFixture(session);
      const original = f.user([text('caption'), image('failed-summary')]);
      f.append('compaction/start', { compactionId: 'failed-attempt', turn: null });
      if (failed) f.append('compaction/end', { compactionId: 'failed-attempt', turn: null, error: 'fixture failure' });
      assert.deepEqual(seqs(classify(session)), []);
      const changed = detached(), cf = rangeFixture(changed);
      const target = cf.user([text('offload before failed summary'), image('committed-before-failure')]);
      cf.append('compaction/start', { compactionId: 'changed-attempt', turn: null });
      cf.offload(target, [0]);
      if (failed) cf.append('compaction/end', { compactionId: 'changed-attempt', turn: null, error: 'summary failed after offload' });
      assert.deepEqual(seqs(classify(changed)), [target.seq]);
    }
    const session = detached(), f = rangeFixture(session);
    const original = f.user([text('committed before missing end')]);
    const replacement = f.summary([original.seq]);
    const cut = sessionCut(session);
    const interrupted = { ...cut, events: cut.events.slice(0, -1), cursor: cut.cursor - 1 };
    assert.deepEqual(seqs(classifyHistoryRange(interrupted, projections)), [original.seq]);
    const failed = structuredClone(cut);
    failed.events.at(-1).data.error = 'close failure after commit';
    assert.deepEqual(sourceAt(classifyHistoryRange(failed, projections), original).reasons, [{ kind: 'replacement', eventSeq: replacement.seq }]);
  });

  await check('summary, system/developer, reasoning and exact recall tool copies are excluded while mixed ordinary blocks survive', () => {
    const session = detached(), f = rangeFixture(session);
    const user = f.user([text('user literally mentions recall_search and 推理')]);
    const system = f.append('system/message', { turn: 1, step: 1, message: { id: 'old-system', role: 'system', source: { kind: 'system-prompt' }, content: [text('old instructions')] } }, { surfaceOp: 'append' });
    const developer = f.append('developer/message', { turn: 1, step: 1, message: { id: 'old-developer', role: 'developer', source: { kind: 'user' }, content: [] } }, { surfaceOp: 'append' });
    const summaryCopy = f.user([text('imported checkpoint')], { kind: 'compact-checkpoint', compactionId: 'imported' });
    const onlyReasoning = f.assistant([{ type: 'reasoning', text: 'excluded trace' }]);
    const blocks = ['recall_search', 'recall_read', DIAGNOSTIC_TOOL_NAME, 'recall_search_notes'].map((name, i) => f.callBlock(`mixed-${i}`, name));
    const mixed = f.assistant([text('ordinary answer'), ...blocks]);
    const results = blocks.map(block => {
      const spill = formatSpillNotice({ kind: 'exact', count: 80 }, { locator: `/spill/${block.name}.txt`, retrievalHint: 'Use read.' });
      return f.result(block, f.callLog(block), [text(`saved preview\n\n${spill}`)]);
    });
    const nodes = [user, system, developer, summaryCopy, onlyReasoning, mixed, ...results].map(e => e.seq);
    f.summary(nodes);
    const range = classify(session);
    assert.deepEqual(seqs(range), [user.seq, mixed.seq, results[3].seq]);
    assert.deepEqual(sourceAt(range, mixed).blocks.map(b => b.index), [0, 4]);
    assert.equal(sourceAt(range, results[3]).blocks[0].toolName, 'recall_search_notes', 'names are not prefix-filtered');
    evidence.samples.exclusions = range;
  });

  await check('call provenance uses turn/step and explicit sources; missing, conflicting and ambiguous calls fail closed', () => {
    const session = detached(), f = rangeFixture(session);
    const recall = f.callBlock('reused-provider-id', 'recall_read');
    const a = f.assistant([recall], 1, 1);
    const r1 = f.result(recall, f.callLog(recall, 1, 1), [text('copied recall')], 1, 1);
    const ordinary = f.callBlock(recall.id, 'read');
    const b = f.assistant([ordinary], 2, 1);
    const log = f.callLog(ordinary, 2, 1);
    const r2 = f.result(ordinary, log, [text('original file output')], 2, 1);
    f.summary([a.seq, r1.seq, b.seq, r2.seq]);
    assert.deepEqual(seqs(classify(session)), [b.seq, r2.seq]);
    const mutate = fn => { const cut = structuredClone(sessionCut(session)); fn(cut); return cut; };
    const invalid = cut => assert.throws(() => classifyHistoryRange(cut, projections), { code: 'recall/range-source-unverified' });
    invalid(mutate(cut => { cut.events[log.seq].data.name = 'recall_read'; }));
    invalid(mutate(cut => { cut.events[r2.seq].data.message.toolCallId = 'missing'; cut.events[r2.seq].data.message.source.callId = 'missing'; }));
    invalid(mutate(cut => { cut.events[r2.seq].sourceEventSeqs = [a.seq]; }));
    invalid(mutate(cut => { cut.events[b.seq].data.message.content.push(ordinary); }));
  });

  await check('fork range includes only inherited prefix and own removals, with no parent suffix lookup', () => {
    const parent = detached(), f = rangeFixture(parent);
    const original = f.user([text('inherited original')]);
    f.summary([original.seq]);
    const inherited = parent.seq;
    const child = Session.create('range-fork-unit', buildForkSeed(parent.snapshotEvents(), parent.seq - 1), {
      ...parent.header, id: 'range-fork-unit', parentSession: parent.id, isSeeded: true,
    }, inherited, projections);
    const cf = rangeFixture(child), own = cf.user([text('child original')]);
    cf.summary([own.seq]);
    const parentLater = f.user([text('parent after fork')]);
    f.summary([parentLater.seq]);
    const range = classify(child);
    assert.deepEqual(seqs(range), [original.seq, own.seq]);
    assert.deepEqual(range.sources.map(s => s.inherited), [true, false]);
    assert.equal(range.parentSession, parent.id);
    assert.equal(range.inheritedEventCount, inherited);
    evidence.samples.fork = range;
  });

  await check('missing interpreter, invalid offload or replacement, sequence gaps and unsupported native formats remain explicit errors', () => {
    const session = detached(), f = rangeFixture(session);
    const original = f.user([image('invalid')]);
    const offload = f.offload(original, [0]);
    const cut = sessionCut(session);
    assert.throws(() => classifyHistoryRange(cut, []), /requires a message projection/);
    for (const mutate of [
      c => { c.events[offload.seq].data.targets[0].imageIndexes = [5]; },
      c => { c.events[offload.seq].data.targets[0].seq = 99; },
      c => { c.events[0].seq = 2; },
      c => { c.cursor++; },
      c => { c.inheritedEventCount = 99; },
    ]) {
      const broken = structuredClone(cut); mutate(broken);
      assert.throws(() => classifyHistoryRange(broken, projections), { code: 'recall/range-invalid' });
    }
    const version = structuredClone(cut); version.header.version++;
    assert.throws(() => classifyHistoryRange(version, projections), { code: 'recall/range-unsupported' });
    const future = structuredClone(cut);
    future.events.push({ seq: ++future.cursor, time: 0, type: 'future/required', data: {} });
    assert.throws(() => classifyHistoryRange(future, projections), { code: 'recall/range-unsupported' });
    future.events.at(-1).ignorable = true;
    assert.deepEqual(seqs(classifyHistoryRange(future, projections)), [original.seq]);
    const duplicate = structuredClone(cut); duplicate.events.push({ ...structuredClone(cut.events.at(-1)), seq: ++duplicate.cursor });
    assert.throws(() => classifyHistoryRange(duplicate, projections), /already offloaded/);
    f.summary([original.seq]);
    const brokenSource = structuredClone(sessionCut(session));
    brokenSource.events.find(e => typeof e.surfaceOp === 'object').sourceEventSeqs = [offload.seq];
    assert.throws(() => classifyHistoryRange(brokenSource, projections), /must include every shadowed/);
    const controller = new AbortController(); controller.abort(new Error('cancelled classification'));
    assert.throws(() => classifyHistoryRange(cut, projections, controller.signal), /cancelled classification/);
  });

  await check('real live and persisted cold snapshots produce identical range metadata and release their observation leases', async () => {
    const fixture = await createHistoryFixture(ctx, 'range-live-cold', []);
    const f = rangeFixture(fixture.session);
    f.append('turn/start', { turn: 1 });
    f.append('step/start', { turn: 1, step: 1 });
    const original = f.user([text('live and cold original'), file]);
    const block = f.callBlock('native-range-read');
    const assistant = f.assistant([block]);
    const result = f.result(block, f.callLog(block), [text('saved tool output'), image('native-result')]);
    f.offload(result, [0]);
    const pruned = f.prune(result);
    f.append('step/end', { turn: 1, step: 1 });
    f.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
    f.summary([original.seq, assistant.seq, pruned.seq]);
    f.append('turn/start', { turn: 2 });
    f.append('step/start', { turn: 2, step: 1 });
    const partial = f.user([text('partial live caption'), image('native-partial')]);
    f.append('step/end', { turn: 2, step: 1 });
    f.append('turn/end', { turn: 2, reason: { kind: 'completed' } });
    f.offload(partial, [0]);
    await fixture.flush();
    const raw = ctx.sessionQuery.observeSession.bind(ctx.sessionQuery);
    const leases = [];
    const property = Object.getOwnPropertyDescriptor(ctx.sessionQuery, 'observeSession');
    Object.defineProperty(ctx.sessionQuery, 'observeSession', { configurable: true, value: async (...args) => {
      const lease = await raw(...args); leases.push(lease); return lease;
    } });
    let closed = false;
    try {
      const read = id => ctx.recallHistory.withSnapshot(id, (cut, signal) => classifyHistoryRange(cut, projections, signal));
      const live = await read(fixture.session.id);
      assert.deepEqual(seqs(live), [original.seq, assistant.seq, result.seq, partial.seq]);
      assert.deepEqual(live.sources.map(s => s.retention), ['removed', 'removed', 'removed', 'partial']);
      await assert.rejects(ctx.recallHistory.withSnapshot(fixture.session.id, cut => classifyHistoryRange(cut, [])), /requires a message projection/);
      await fixture.close(); closed = true;
      const cold = await read(fixture.session.id);
      assert.deepEqual(cold, live);
      assert.equal(leases[0].source, 'live');
      assert.equal(leases.at(-1).source, 'prepared');
      leases.forEach(lease => assert.throws(() => lease.retain(), /disposed/));
      evidence.samples.liveCold = cold;
      evidence.leases = leases.length;
    } finally {
      if (property) Object.defineProperty(ctx.sessionQuery, 'observeSession', property);
      else Reflect.deleteProperty(ctx.sessionQuery, 'observeSession');
      if (!closed) await fixture.close(false);
    }
  });

  const path = join(process.env.DSH_HOME, '..', 'range-evidence.json');
  await writeFile(path, JSON.stringify(evidence, null, 2));
  console.log(`Range evidence: ${path}`);
}
