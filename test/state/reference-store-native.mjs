import { referenceFixture } from '../../support/fixtures/reference.mjs';
import assert from 'node:assert/strict';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { RecallReferenceStore, recordKey, referenceRecord, referencePlaceholder } from '../../lib/index.js';
import { deferred, replace } from '../../support/fixtures/control.mjs';
import { bounded, verifyMappingWaits } from '../fixtures/mapping-waits.mjs';

export async function verifyReferenceStore(ctx) {
  const cases = [], signal = new AbortController().signal;
  const check = async (label, run) => { await run(); cases.push(label); console.log(`PASS: ${label}`); };
  let mount = await ctx.plugin(RecallReferenceStore), retained;
  const store = () => ctx.recallReferences;
  const reload = async () => { await mount.dispose(); mount = await ctx.plugin(RecallReferenceStore); };
  try {
    await check('concurrent issuance preserves one stable 26-character handle and rejects unknown, type and session damage', async () => {
      const locator = referenceFixture(), rows = await Promise.all(Array.from({ length: 12 }, () => store().issue(locator, signal)));
      retained = rows[0]; assert.equal(store().stats().records, 1); assert.equal(new Set(rows.map(r => r.handle)).size, 1);
      assert.match(retained.handle, /^rr2_[\w-]{22}$/); assert.equal(retained.handle.length, 26);
      assert.deepEqual(store().resolve(retained.handle, locator.sessionId), retained);
      assert.equal(recordKey(Object.fromEntries(Object.entries(locator).reverse())), retained.recordKey);
      for (const [handle, session] of [[retained.handle, 'other'], [retained.handle + 'x', locator.sessionId],
        [referencePlaceholder, locator.sessionId], ['rs3_' + 'A'.repeat(22), locator.sessionId], ['rr1.unsupported', locator.sessionId]]) {
        assert.throws(() => store().resolve(handle, session), e => e.code === 'stale_reference');
      }
      rows[0].seq++; assert.equal(store().resolve(retained.handle, locator.sessionId).seq, locator.seq);
      retained = store().resolve(retained.handle, locator.sessionId);
      for (const changes of [{ seq: 2 }, { sessionId: 'other' }, { fingerprint: 'd'.repeat(64) }, { historyId: 'e'.repeat(64) }]) {
        const other = await store().issue({ ...locator, ...changes }, signal); assert.notEqual(other.handle, retained.handle);
      }
    });
    await check('durable refs bypass blocked writes; queued cancellation, captured inputs, serial uniqueness and failed-owner retry remain isolated', async () => {
      await verifyMappingWaits(store(), { target: name => referenceFixture(`ref-waits-${name}`), key: recordKey,
        mutate: locator => { locator.seq = 999; locator.sessionId = 'mutated'; }, writeError: 'reference_write_failed' });
    });
    await check('collision retry is bounded and never binds an existing handle to another record', async () => {
      const original = store().newHandle.bind(store()); let calls = 0;
      let undo = replace(store(), 'newHandle', () => ++calls <= 2 ? retained.handle : original());
      try { assert.notEqual((await store().issue(referenceFixture('collision'), signal)).handle, retained.handle); assert.equal(calls, 3); }
      finally { undo(); }
      undo = replace(store(), 'newHandle', () => retained.handle);
      try { await assert.rejects(store().issue(referenceFixture('collision-exhausted'), signal), e => e.code === 'reference_allocation_failed'); }
      finally { undo(); }
      assert.deepEqual(store().resolve(retained.handle, retained.sessionId), retained);
    });
    await check('write failure publishes no mapping and retry persists the captured source', async () => {
      const before = store().stats().records, table = store().table, put = table.put.bind(table);
      const undo = replace(table, 'put', () => Promise.reject(new Error('injected EIO')));
      try { await assert.rejects(store().issue(referenceFixture('write-failed'), signal), e => e.code === 'reference_write_failed'); }
      finally { undo(); }
      assert.equal(store().stats().records, before);
      const row = await store().issue(referenceFixture('write-failed'), signal);
      assert.deepEqual(store().resolve(row.handle, row.sessionId), row);
      const entered = deferred(), release = deferred();
      const restore = replace(table, 'put', async (...args) => { entered.resolve(); await release.promise; return put(...args); });
      try {
        const first = store().issue(referenceFixture('queued-first'), signal); await entered.promise;
        const locator = referenceFixture('queued-second'), queued = store().issue(locator, signal); locator.seq = 999;
        release.resolve(); await first; assert.equal((await queued).seq, 1);
      } finally { release.resolve(); restore(); }
    });
    await check('cancellation drains a started native write, rejects publication and reuses the durable mapping on retry', async () => {
      const controller = new AbortController(), entered = deferred(), release = deferred(), table = store().table, put = table.put.bind(table);
      const locator = referenceFixture('cancelled'), before = store().stats().records;
      const undo = replace(table, 'put', async (...args) => { entered.resolve(); await release.promise; return put(...args); });
      try {
        const pending = store().issue(locator, controller.signal), rejected = assert.rejects(pending, /cancel reference write/);
        await entered.promise; controller.abort(new Error('cancel reference write'));
        assert.equal(store().stats().pendingWrites, 1); release.resolve(); await rejected;
      } finally { release.resolve(); undo(); }
      assert.equal(store().stats().pendingWrites, 0); assert.equal(store().stats().records, before + 1);
      const saved = store().records().find(r => r.sessionId === locator.sessionId);
      assert.deepEqual(await store().issue(locator, signal), saved);
      const cancelled = AbortSignal.abort(new Error('before start'));
      await assert.rejects(store().issue(referenceFixture('never-written'), cancelled), /before start/);
      assert.equal(store().stats().records, before + 1);
    });
    await check('index conflicts cannot select an arbitrary source and schema rejects altered identity', async () => {
      const table = store().table;
      const conflict = await store().issue(referenceFixture('conflict'), signal);
      assert.equal(referenceRecord.safeParse({ ...conflict, seq: 99 }).success, false);
      await table.put(conflict.recordKey, { ...conflict, handle: retained.handle });
      try { assert.throws(() => store().rebuildIndex(), e => e.code === 'reference_store_invalid'); }
      finally { await table.put(conflict.recordKey, conflict); store().rebuildIndex(); }
      const wrongKey = conflict.recordKey.slice(0, 2) + 'wrong-key';
      await table.put(wrongKey, conflict);
      try { assert.throws(() => store().rebuildIndex(), e => e.code === 'reference_store_invalid'); }
      finally { await table.delete(wrongKey); store().rebuildIndex(); }
      const otherShard = conflict.recordKey.startsWith('00') ? '01' : '00', otherTable = store().tables.get(otherShard);
      await otherTable.put(conflict.recordKey, conflict);
      try { assert.throws(() => store().rebuildIndex(), e => e.code === 'reference_store_invalid'); }
      finally { await otherTable.delete(conflict.recordKey); store().rebuildIndex(); }
    });
    await check('unload drains pending writes, releases the old index and reload restores the identical handle', async () => {
      const old = store(), entered = deferred(), release = deferred(), table = old.table, put = table.put.bind(table);
      const undo = replace(table, 'put', async (...args) => { entered.resolve(); await release.promise; return put(...args); });
      try {
        const pending = old.issue(referenceFixture('unloading'), signal), rejected = assert.rejects(pending, e => e.code === 'recall_unloaded');
        await entered.promise; let disposed = false;
        const queued = assert.rejects(old.issue(referenceFixture('unloading-queued'), signal), e => e.code === 'recall_unloaded');
        const disposing = mount.dispose().then(() => { disposed = true; });
        await bounded(queued);
        await assert.rejects(old.issue(referenceFixture(), signal), e => e.code === 'recall_unloaded');
        assert.equal(old.stats().pendingWrites, 1);
        await new Promise(resolve => setImmediate(resolve)); assert.equal(disposed, false);
        release.resolve(); await rejected; await disposing;
      } finally { release.resolve(); undo(); }
      assert.equal(old.stats().closed, true); assert.equal(old.stats().indexEntries, 0); assert.equal(old.stats().pendingWrites, 0);
      mount = await ctx.plugin(RecallReferenceStore);
      assert.deepEqual(store().resolve(retained.handle, retained.sessionId), retained);
      assert.equal(store().records().filter(r => r.sessionId === 'unloading').length, 1);
      assert.equal(store().records().filter(r => r.sessionId === 'unloading-queued').length, 0);
    });
    await check('malformed, wrong-version and invalid-identity documents are unavailable without dropping healthy records', async () => {
      const faults = await Promise.all(Array.from({ length: 3 }, (_, seq) => store().issue(referenceFixture('damaged', seq), signal)));
      const paths = await readdir(process.env.DSH_HOME, { recursive: true });
      const pathFor = row => join(process.env.DSH_HOME, paths.find(p => p.endsWith(`${row.recordKey}.json`)));
      await writeFile(pathFor(faults[0]), '{bad');
      const wrongVersion = JSON.parse(await readFile(pathFor(faults[1]), 'utf8')); wrongVersion.version = 999;
      await writeFile(pathFor(faults[1]), JSON.stringify(wrongVersion));
      const damaged = JSON.parse(await readFile(pathFor(faults[2]), 'utf8')); damaged.record.seq++;
      await writeFile(pathFor(faults[2]), JSON.stringify(damaged));
      await reload();
      for (const row of faults) assert.throws(() => store().resolve(row.handle, row.sessionId), e => e.code === 'stale_reference');
      assert.deepEqual(store().resolve(retained.handle, retained.sessionId), retained);
    });
    await check('partial shard initialization closes every opened domain and a later mount recovers healthy handles', async () => {
      await mount.dispose();
      const open = ctx.storageDomain.open.bind(ctx.storageDomain);
      const restore = replace(ctx.storageDomain, 'open', spec => {
        if (spec.name === 'dsh_recall_references_80') throw new Error('injected shard open failure');
        return open(spec);
      });
      const failed = ctx.plugin(RecallReferenceStore);
      try { await assert.rejects(Promise.resolve(failed), /injected shard open failure/); }
      finally { restore(); await failed.dispose(); }
      for (let shard = 0; shard < 256; shard++) assert.equal(ctx.storageDomain.get(`dsh_recall_references_${shard.toString(16).padStart(2, '0')}`), undefined);
      mount = await ctx.plugin(RecallReferenceStore); assert.deepEqual(store().resolve(retained.handle, retained.sessionId), retained);
    });
    await writeFile(join(process.env.DSH_HOME, '..', 'reference-store-evidence.json'), JSON.stringify({ cases, stats: store().stats() }, null, 2));
  } finally { await mount.dispose(); }
}
