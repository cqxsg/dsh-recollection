import assert from 'node:assert/strict';
import { currentInteraction } from '../../lib/index.js';
import { human, recovery } from '../../support/fixtures/scripted-model.mjs';
import { deferred, replace } from '../../support/fixtures/control.mjs';

export async function verifyRecallMemory(ctx, h, check) {
  const state = agent => ctx.recallBudget.state(currentInteraction(agent.session));
  await check('session eviction releases all cache/query/read/cursor owners while durable grants and source refs survive', async () => {
    const { agent } = await h.seed('memory-cursors', Array.from({ length: 9 }, (_, i) => `needle ${i} ` + '正文😀'.repeat(6000)));
    const memory = ctx.recallMemory.budget, search = ctx.recallTools.search, read = ctx.recallTools.read;
    const first = (await h.search(agent)).value; assert.equal(first.status, 'ok'); assert.ok(first.nextCursor);
    const next = (await h.next(agent, first.nextCursor)).value; assert.equal(next.status, 'ok'); assert.ok(next.nextCursor);
    assert.equal(state(agent).queries[0].free, 1);
    const body = (await h.read(agent, first.items[0].ref)).value; assert.equal(body.status, 'ok'); assert.ok(body.nextCursor);
    const prepared = ctx.recallPreparation.entries.get(agent.id), refs = memory.stats().recordReferences, bytes = memory.stats().recordBytes;
    prepared.cache.clear();
    assert.equal(memory.stats().recordBytes, bytes, 'queries still own every prepared body');
    assert.equal(memory.stats().recordReferences, refs - 9);
    const ledger = structuredClone(state(agent));
    assert.equal(memory.evict(agent.id), true);
    assert.equal(ctx.recallPreparation.status(agent.id), undefined);
    assert.equal(search.stats().some(q => q.sessionId === agent.id), false);
    assert.equal([...search.incomplete.values()].some(q => q.sessionId === agent.id), false);
    assert.equal([...read.states.values()].some(s => s.sessionId === agent.id), false);
    assert.equal([...read.issued.values()].includes(agent.id), false);
    assert.equal(read.caches.has(agent.id), false); assert.equal(memory.owners.has(agent.id), false);
    assert.deepEqual(state(agent), ledger, 'eviction never writes authoritative accounting');
    const lost = (await h.next(agent, next.nextCursor)).value; assert.equal(lost.code, 'stale_reference');
    assert.equal(state(agent).queries[0].free, 1);
    const rebuilt = (await h.search(agent, recovery())).value;
    assert.equal(rebuilt.status, 'ok'); assert.equal(state(agent).calls.at(-1).query, ledger.queries[0].id); assert.equal(rebuilt.budget.query_pages_remaining, 1);
    const restored = (await h.read(agent, first.items[0].ref)).value; assert.equal(restored.status, 'ok');
    assert.equal(state(agent).queries.length, 1);
  });
  await check('read.files retains its canonical body after the read cache is cleared and releases it on session eviction', async () => {
    const { agent } = await h.seed('memory-files', ['needle @memory-missing.txt']);
    const first = (await h.search(agent)).value, item = first.items[0]; assert.equal(item.attachments.length, 1);
    const [native] = await h.drive(agent, [{ name: 'recall_read', args: { action: 'read', ref: item.ref, target: 'attachments', attachments: [item.attachments[0].ref] } }]);
    assert.equal(native.value.status, 'ok');
    const memory = ctx.recallMemory.budget, read = ctx.recallTools.read;
    const owned = [...read.states.values()].find(s => s.sessionId === agent.id); assert.equal(owned.files.length, 1);
    const before = memory.stats(); read.caches.get(agent.id).clear();
    assert.equal(memory.stats().recordBytes, before.recordBytes); assert.equal(memory.stats().recordReferences, before.recordReferences - 1);
    assert.equal(memory.evict(agent.id), true); assert.equal(owned.files, undefined); assert.equal(memory.owners.has(agent.id), false);
  });
  await check('continuation is pinned before cursor inspection and throughout asynchronous durable admission', async () => {
    const { agent } = await h.seed('memory-admission', Array.from({ length: 7 }, (_, i) => `needle ${i} ` + 'long body '.repeat(250)));
    const first = (await h.search(agent)).value; assert.ok(first.nextCursor);
    const memory = ctx.recallMemory.budget, gate = deferred(), entered = deferred();
    const inspect = ctx.recallTools.search.inspectNext.bind(ctx.recallTools.search), reserve = ctx.recallBudget.reserve.bind(ctx.recallBudget);
    const undoInspect = replace(ctx.recallTools.search, 'inspectNext', (...args) => { assert.equal(memory.pinned(agent.id), true); return inspect(...args); });
    const undoReserve = replace(ctx.recallBudget, 'reserve', async (...args) => { entered.resolve(); await gate.promise; return reserve(...args); });
    let pending;
    try {
      pending = h.next(agent, first.nextCursor); await entered.promise;
      assert.equal(memory.evict(agent.id), false); assert.equal(memory.pinned(agent.id), true);
      gate.resolve(); assert.equal((await pending).value.status, 'ok'); assert.equal(memory.pinned(agent.id), false);
    } finally { gate.resolve(); await pending; undoReserve(); undoInspect(); }
  });
  await check('matching capacity failure publishes neither half a batch nor a completed page, and retries the unconfirmed records', async () => {
    const { agent } = await h.seed('memory-match-refused', ['needle first', 'needle second', 'needle third']);
    const memory = ctx.recallMemory.budget, matcher = ctx.recallTools.search.matcher, original = matcher.match.bind(matcher), limit = memory.limitBytes;
    let hits = 0, discarded;
    const drop = ctx.recallTools.search.drop.bind(ctx.recallTools.search);
    const undoDrop = replace(ctx.recallTools.search, 'drop', query => {
      if (query.sessionId === agent.id) discarded = { scanned: query.scanned, matches: query.matches.length, complete: query.complete };
      return drop(query);
    });
    const undo = replace(matcher, 'match', async (...args) => { const hit = await original(...args); hits++; memory.limitBytes = 1; return hit; });
    try {
      const result = (await h.search(agent)).value; assert.equal(result.code, 'cache_resource_limit'); assert.equal(result.scanComplete, false);
      assert.deepEqual(result.items, []); assert.equal(hits, 2, 'both started members drained');
      assert.deepEqual(discarded, { scanned: 0, matches: 0, complete: false });
      assert.equal(memory.owners.has(agent.id), false, 'failed full owner is released only after the call drains');
    } finally { memory.limitBytes = limit; undo(); undoDrop(); }
    const retry = (await h.search(agent, recovery())).value; assert.equal(retry.status, 'ok'); assert.equal(retry.totalHits, 3);
    assert.equal(retry.budget.search_remaining, 4); assert.equal(retry.budget.shared_remaining, 10);
  });
  await check('resource refusal charges the native attempt, publishes no partial query and retries without granting fresh budgets', async () => {
    const { agent } = await h.seed('memory-refused', ['needle ' + 'x'.repeat(20000)]);
    const memory = ctx.recallMemory.budget, restore = replace(memory, 'limitBytes', 1024);
    try {
      const result = (await h.search(agent)).value;
      assert.equal(result.code, 'cache_resource_limit'); assert.equal(result.scanComplete, false); assert.deepEqual(result.items, []);
      assert.equal(state(agent).searches, 5); assert.equal(state(agent).shared, 11); assert.equal(state(agent).invalid.length, 0);
      assert.equal(ctx.recallTools.search.stats().some(q => q.sessionId === agent.id), false); assert.equal(memory.pinned(agent.id), false);
    } finally { restore(); }
    const retry = (await h.search(agent, recovery())).value; assert.equal(retry.status, 'ok');
    assert.equal(retry.budget.search_remaining, 4); assert.equal(retry.budget.shared_remaining, 10);
  });
  await check('invalid feedback remains authoritative after all derived state is evicted', async () => {
    const { agent } = await h.seed('memory-feedback'); await ctx.recallPreparation.wait(agent.id);
    const args = { action: 'search', mode: 'regex', patterns: ['['] };
    const first = (await h.drive(agent, [{ name: 'recall_search', args }], human('invalid condition')))[0].value;
    assert.equal(first.code, 'invalid_pattern'); assert.equal(first.budget.closed, false);
    assert.equal(ctx.recallMemory.budget.evict(agent.id), true);
    const second = (await h.drive(agent, [{ name: 'recall_search', args }]))[0].value;
    assert.equal(second.code, 'invalid_pattern'); assert.equal(second.budget.closed, true); assert.equal(state(agent).shared, 10);
  });
  await check('Host cache size changes on reload without changing durable grants or invalidating source refs', async () => {
    const entry = [...ctx.loader.entries()].find(entry => entry.options.id === 'recall'), original = structuredClone(entry.fiber.config);
    const apply = async config => {
      const old = ctx.recallMemory.budget, until = performance.now() + 15000;
      entry.fiber.update(config, true);
      while (!ctx.get('recallMemory') || ctx.recallMemory.budget === old) {
        assert.ok(performance.now() < until, 'configuration reload must settle');
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      await entry.fiber.await(); assert.equal(old.stats().usedBytes, 0); assert.equal(old.stats().pins, 0);
    };
    const { agent } = await h.seed('memory-config', ['needle configured cache']);
    const first = (await h.search(agent)).value; assert.equal(first.status, 'ok');
    const ledger = structuredClone(state(agent));
    try {
      await apply({ ...original, recall: { ...original.recall, cacheMiB: 64 } });
      assert.equal(ctx.recallMemory.budget.limitBytes, 64 * 1024 ** 2); assert.deepEqual(state(agent), ledger);
      assert.equal((await h.read(agent, first.items[0].ref)).value.status, 'ok');
      assert.ok(ctx.recallMemory.budget.stats().usedBytes > 0);
    } finally { await apply(original); }
    assert.equal(ctx.recallMemory.budget.limitBytes, 512 * 1024 ** 2);
  });
  await check('reload binds preparation to the new memory service and closing a read-only owner releases every reference', async () => {
    await [...ctx.loader.entries()].find(entry => entry.options.id === 'recall').fiber.restart();
    const { agent } = await h.seed('memory-reload-binding', ['needle verified after reload']);
    const prepared = await ctx.recallPreparation.wait(agent.id);
    assert.equal(ctx.recallPreparation.records(prepared).length, 1);
    assert.equal(ctx.recallPreparation.entries.get(agent.id).cache.metadata, undefined, 'terminal preparation releases reusable indices');
    assert.equal(ctx.recallMemory.budget.stats().uniqueRecords, 1, 'new preparation must participate in the current budget');
    const first = (await h.search(agent)).value; assert.equal(first.status, 'ok');
    await [...ctx.loader.entries()].find(entry => entry.options.id === 'recall').fiber.restart();
    assert.equal(ctx.recallPreparation.status(agent.id), undefined);
    const read = (await h.read(agent, first.items[0].ref)).value; assert.equal(read.status, 'ok');
    assert.equal(ctx.recallTools.read.caches.get(agent.id).metadata, undefined, 'completed read releases reusable indices');
    assert.equal(ctx.recallMemory.budget.stats().uniqueRecords, 1);
    assert.equal(ctx.recallPreparation.status(agent.id), undefined, 'direct old ref read need not create a preparation entry');
    const handle = h.agents.find(handle => handle.agent === agent); await handle.dispose(); h.agents.splice(h.agents.indexOf(handle), 1);
    assert.equal(ctx.recallMemory.budget.stats().usedBytes, 0); assert.equal(ctx.recallMemory.budget.stats().pins, 0);
  });
}
