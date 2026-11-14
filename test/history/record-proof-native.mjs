import assert from 'node:assert/strict';
import { Session } from '@deepseek-ai/dsh-session';
import { HistoryRecordCache, fingerprintHistory, recordLocator, startPerformanceCapture } from '../../lib/index.js';
import { HistoryRecordCache as OldCache, fingerprintHistory as oldProof } from '../../.local/records-reference.mjs';
import { createHistoryFixture } from '../../support/fixtures/history.mjs';
import { rangeFixture, sessionCut, text, file, image } from '../../support/fixtures/range.mjs';

export async function verifyRecordProof(ctx, check) {
  const signal = new AbortController().signal, projections = ctx.sessions.messageProjections;
  await check('bounded hashing retains independent old history/block/record/reference fingerprints including split UTF-16 and metadata', async () => {
    for (let i = 0; i < 24; i++) {
      const session = Session.create(`proof-reference-${i}`, undefined, undefined, 0, projections), f = rangeFixture(session);
      const call = f.callBlock('test', 'read', ' {"path":"a","n":-0,"array":[null,true,false,1.25,1e100]} ');
      f.user([text('前😀e\u0301\r\n\0\uFEFF' + 'x'.repeat(i * 1025) + '\ud800'),
        { ...file, attachment: { ...file.attachment, future: { z: [null, true, false, 0, 1.25, 1e100], a: { '😀': '\ud800', empty: '' } } } }, image('proof')]);
      f.assistant([text('left'), call, text('right\udc00')]); f.result(call, f.callLog(call), [text('body')]);
      f.summary([...session.surface.nodes]); const snapshot = sessionCut(session), actual = new HistoryRecordCache(), expected = new OldCache();
      try {
        assert.equal(await fingerprintHistory(snapshot, signal), await oldProof(snapshot, signal));
        const options = { maxTextChars: 1024 * 1024, maxBatchMs: 1000, chunkChars: [1, 13, 16384, 32768][i % 4] };
        const a = await actual.prepareBatch(snapshot, projections, options, signal), b = await expected.prepareBatch(snapshot, projections, options, signal);
        assert.deepEqual(a, b); assert.deepEqual(actual.records(a), expected.records(b));
        assert.deepEqual(actual.records(a).map(recordLocator), expected.records(b).map(recordLocator));
        assert.equal(actual.metadata, undefined, 'an arbitrary caller object never enables proof reuse');
      } finally { actual.dispose(); expected.dispose(); }
    }
  });
  await check('each new native lease proves all content; same-lease proof and detached metadata reuse expire with their scope', async () => {
    const fixture = await createHistoryFixture(ctx, 'proof-native', ['alpha\r\n\0😀', 'beta', 'gamma']), cache = new HistoryRecordCache(), old = new OldCache();
    rangeFixture(fixture.session).summary([...fixture.session.surface.nodes]); await fixture.flush();
    const capture = startPerformanceCapture(); let expired, batch, oldBatch, firstProof;
    try {
      for (let i = 0; i < 3; i++) await ctx.recallHistory.withSnapshot(fixture.session.id, async (snapshot, scoped) => {
        expired = snapshot;
        const proof = await fingerprintHistory(snapshot, scoped); firstProof ??= proof; assert.equal(proof, firstProof);
        assert.equal(await fingerprintHistory(snapshot, scoped), proof); assert.equal(await oldProof(snapshot, scoped), proof);
        batch = await cache.prepareBatch(snapshot, projections, { maxRecords: 1 }, scoped);
        oldBatch = await old.prepareBatch(snapshot, projections, { maxRecords: 1 }, scoped); assert.deepEqual(batch, oldBatch);
        const objects = (root, seen = new Set()) => {
          if (!root || typeof root !== 'object' || seen.has(root)) return seen;
          seen.add(root);
          for (const child of root instanceof Map ? [...root].flat() : Object.values(root)) objects(child, seen);
          return seen;
        };
        const borrowed = objects({ header: snapshot.header, events: snapshot.events });
        for (const owned of objects(cache.metadata)) assert.equal(borrowed.has(owned), false, 'metadata must not retain any borrowed native object');
      });
      assert.deepEqual(cache.records(batch), old.records(oldBatch));
      const stats = capture.snapshot();
      assert.equal(stats.aggregates['preparation.fingerprint'].counters.fullProofs, 3);
      assert.equal(stats.aggregates['records.descriptors'].counters.metadataReuses, 2);
      assert.equal(cache.metadata.proof, firstProof); assert.equal(JSON.stringify(cache.metadata).includes('alpha'), false);
      const ownedRecords = cache.records(batch);
      cache.releaseMetadata(); assert.equal(cache.metadata, undefined);
      assert.deepEqual(cache.records(batch), ownedRecords, 'dropping temporary indices preserves completed handles and bodies');
      await assert.rejects(fingerprintHistory(expired, signal), e => e.code === 'recall/history-scope-closed');
      await assert.rejects(cache.prepareBatch(expired, projections, {}, signal), e => e.code === 'recall/history-scope-closed');
      const changed = structuredClone(sessionCut(fixture.session)); changed.events.find(e => e.type === 'user/message').data.content[0].text = 'rewrite';
      assert.notEqual(await fingerprintHistory(changed, signal), firstProof);
      await assert.rejects(cache.prepareBatch(changed, projections, {}, signal), e => e.code === 'recall/records-source-changed');
    } finally { capture.stop(); cache.dispose(); old.dispose(); await fixture.close(); }
  });
  await check('unbranded mutable snapshots cannot reuse a prior strong proof or suppress header/layout checks', async () => {
    const session = Session.create('proof-mutable', undefined, undefined, 0, projections), f = rangeFixture(session); f.user([text('first')]); f.summary([...session.surface.nodes]);
    for (const change of [s => { s.header.createdAt++; }, s => { s.events.find(e => e.type === 'user/message').data.content.push(text('extra block')); }, s => { s.events.find(e => e.type === 'user/message').data.content[0].text = 'second'; }]) {
      const snapshot = structuredClone(sessionCut(session)), cache = new HistoryRecordCache();
      try {
        const proof = await fingerprintHistory(snapshot, signal); await cache.prepareBatch(snapshot, projections, {}, signal);
        change(snapshot); assert.notEqual(await fingerprintHistory(snapshot, signal), proof);
        await assert.rejects(cache.prepareBatch(snapshot, projections, {}, signal), e => e.code === 'recall/records-source-changed');
      } finally { cache.dispose(); }
    }
  });
  await check('same projection array/function identity never suppresses fresh classification or its failure', async () => {
    const fixture = await createHistoryFixture(ctx, 'proof-projection', []), f = rangeFixture(fixture.session), cache = new HistoryRecordCache();
    const original = f.user([image('projection')]); f.offload(original, [0]); await fixture.flush();
    let changed = false, invoked = 0;
    const delegated = projections.map(p => ({ ...p, project(...args) { invoked++; if (changed) throw new Error('changed projection behavior'); return p.project(...args); } }));
    const prepare = custom => ctx.recallHistory.withSnapshot(fixture.session.id, async (snapshot, signal) => {
      await fingerprintHistory(snapshot, signal); return cache.prepareBatch(snapshot, custom, {}, signal);
    });
    try {
      await prepare(delegated); const before = invoked; assert.ok(cache.metadata);
      changed = true;
      await assert.rejects(prepare(delegated), /changed projection behavior/); assert.ok(invoked > before);
      await assert.rejects(prepare([]), /requires a message projection/);
    } finally { cache.dispose(); await fixture.close(); }
  });
}
