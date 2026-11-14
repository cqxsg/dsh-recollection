import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RecallMemoryBudget, retainedBytes, loadRecallConfig, RECALL_MEMORY_LIMITS } from '../../lib/index.js';

const record = text => Object.freeze({ id: text.slice(0, 10), blocks: [{ content: { type: 'text', text } }] });
const failure = fn => assert.throws(fn, error => error.code === 'cache_resource_limit' && !error.invalid);

test('Host cache configuration has a bounded default and rejects invalid sizes', () => {
  assert.equal(loadRecallConfig().cacheMiB, 512);
  assert.equal(new RecallMemoryBudget().limitBytes, RECALL_MEMORY_LIMITS.bytes);
  assert.equal(RECALL_MEMORY_LIMITS.bytes, 512 * 1024 ** 2);
  assert.equal(loadRecallConfig({ cacheMiB: 256 }).cacheMiB, 256);
  assert.equal(loadRecallConfig({ cacheMiB: 384 }).cacheMiB, 384);
  for (const cacheMiB of [0, -1, 1.5, 1025, Infinity, '512']) assert.throws(() => loadRecallConfig({ cacheMiB }));
});

test('shared canonical body remains charged until every independent holder releases it', () => {
  const b = new RecallMemoryBudget(), body = record('a'.repeat(10000));
  const prep = b.hold('a', 'preparation', () => {}), query = b.hold('a', 'query', () => {}), read = b.hold('a', 'read.files', () => {});
  prep.add(40, [body]); const bodyBytes = b.stats().recordBytes;
  query.add(80, [body, body]); read.add(40, [body]);
  assert.equal(b.stats().recordBytes, bodyBytes); assert.equal(b.stats().recordReferences, 3);
  prep.clear(); query.dispose(); assert.equal(b.stats().uniqueRecords, 1); assert.equal(b.stats().recordReferences, 1);
  read.add(0, [record('a'.repeat(10000))]); assert.equal(b.stats().uniqueRecords, 2, 'a distinct copy is separately charged');
  read.dispose(); prep.dispose(); assert.equal(b.stats().usedBytes, 0); assert.equal(b.stats().sessions, 0);
});
test('capacity uses LRU across whole sessions, current page is preferred but not permanently pinned', () => {
  const removed = [], b = new RecallMemoryBudget({ limitBytes: 6000, isCurrent: id => id === 'current' });
  const add = id => { const h = b.hold(id, 'cache', () => removed.push(id)); h.add(1500); return h; };
  add('current'); add('old'); add('new');
  assert.deepEqual(removed, []);
  const pin = b.pin('new'); add('fourth'); assert.deepEqual(removed, ['old']);
  const pin2 = b.pin('fourth'); const h = b.hold('fifth', 'cache', () => removed.push('fifth')); h.add(1500);
  assert.deepEqual(removed, ['old', 'current']);
  pin(); pin2(); b.close(); assert.equal(b.stats().usedBytes, 0); assert.equal(b.stats().pins, 0);
});
test('all pinned and oversized admissions are atomic; cancellation unpins for later work', () => {
  const b = new RecallMemoryBudget({ limitBytes: 3000 });
  const a = b.hold('a', 'cache', () => {}), c = b.hold('c', 'cache', () => {}), unpin = b.pin('a'), release = b.pin('c');
  a.add(1000); const before = b.stats().usedBytes;
  failure(() => c.add(0, [record('x'.repeat(2000))]));
  assert.equal(b.stats().usedBytes, before); assert.equal(c.records.size, 0);
  failure(() => c.add(2000)); assert.equal(c.bytes, 0);
  unpin(); c.add(1500); assert.equal(a.disposed, true); assert.ok(b.stats().usedBytes <= b.limitBytes);
  release(); release(); b.close(); assert.equal(b.stats().usedBytes, 0);
});
test('empty registrations are bounded and failed eviction callbacks are not credited as released', () => {
  const b = new RecallMemoryBudget({ maxSessions: 2 }); let actual = true;
  const a = b.hold('a', 'cache', () => { throw new Error('owner did not release'); }); a.add(123);
  const c = b.hold('c', 'cache', () => { actual = false; });
  const before = b.stats().usedBytes;
  assert.throws(() => b.hold('d', 'cache', () => {}), /owner did not release/);
  assert.equal(b.stats().usedBytes, before); assert.equal(a.disposed, false); assert.equal(actual, true);
  a.dispose(); c.dispose(); assert.equal(b.stats().usedBytes, 0);
  for (let n = 0; n < 100; n++) b.hold(String(n), 'empty', () => {});
  assert.equal(b.stats().sessions, 2); b.close(); assert.equal(b.stats().usedBytes, 0);
});
test('shutdown drains pinned owners and expires registrations only after active work releases', () => {
  const b = new RecallMemoryBudget(), released = [];
  b.hold('idle', 'cache', () => released.push('idle')).add(100);
  b.hold('active', 'query', () => released.push('active')).add(100);
  const done = b.pin('active'); b.close(); assert.deepEqual(released, ['idle']);
  failure(() => b.hold('new', 'cache', () => {})); done(); assert.deepEqual(released, ['idle', 'active']);
  assert.equal(b.stats().usedBytes, 0); assert.equal(b.stats().holders, 0);
});
test('a full pinned session is reclaimed only after its last call drains, so retries can rebuild', () => {
  const b = new RecallMemoryBudget({ limitBytes: 3000 }); let released = false;
  const h = b.hold('a', 'cache', () => { released = true; }); h.add(2000);
  const one = b.pin('a'), two = b.pin('a'); failure(() => h.add(1000));
  one(); assert.equal(released, false); assert.equal(h.disposed, false);
  two(); assert.equal(released, true); assert.equal(b.stats().usedBytes, 0); assert.equal(b.stats().reclaimOnIdle, 0);
  b.hold('a', 'retry', () => {}).add(2000); b.close(); assert.equal(b.stats().usedBytes, 0);
});
test('logical UTF-16 accounting handles shared/cyclic metadata without traversing excluded bodies', () => {
  const body = record('😀'.repeat(10000)), root = { body, duplicate: body }; root.self = root;
  const excluded = retainedBytes(root, new Set([body]));
  assert.ok(excluded < 200); assert.ok(retainedBytes(root) - excluded >= 40000);
});
