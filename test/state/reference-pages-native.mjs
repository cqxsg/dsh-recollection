import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadRecallConfig, currentInteraction, referencePlaceholder } from '../../lib/index.js';
import { recallHarness } from '../../support/fixtures/recall-harness.mjs';
import { human, recovery } from '../../support/fixtures/scripted-model.mjs';
import { replace, deferred } from '../../support/fixtures/control.mjs';
import { bounded } from '../fixtures/mapping-waits.mjs';

export async function verifyReferencePages(ctx) {
  const h = recallHarness(ctx), cases = [], evidence = { cases };
  const check = async (label, run) => { await run(); cases.push(label); console.log(`PASS: ${label}`); };
  const rows = id => ctx.recallReferences.records().filter(r => r.sessionId === id);
  const state = agent => ctx.recallBudget.state(currentInteraction(agent.session));
  const args = { action: 'search', mode: 'literal', patterns: ['needle'], order: 'oldest' };
  const search = async (agent, input = human('find'), final = true) => (await h.drive(agent, [{ name: 'recall_search', args }], input, final))[0];
  const bodies = () => Array.from({ length: 12 }, (_, i) => `needle ${i} ` + '原始记录😀'.repeat(180));
  let retained;
  try {
    await check('only final displayed records acquire stable short references across queries, scopes and fragments', async () => {
      const { agent } = await h.seed('ref-page-stable', bodies());
      const first = (await search(agent)).value;
      assert.equal(first.status, 'ok'); assert.ok(first.nextCursor); assert.ok(first.items.length < 12);
      assert.equal(rows(agent.id).length, first.items.length);
      for (const item of first.items) {
        assert.match(item.ref, /^rr2_[\w-]{22}$/); assert.notEqual(item.ref, referencePlaceholder);
        assert.equal(ctx.recallReferences.resolve(item.ref, agent.id).seq, item.source.seq);
        for (const attachment of item.attachments) assert.ok(attachment.ref.startsWith(item.ref + ':'));
      }
      const again = (await search(agent, human('find again'))).value;
      assert.deepEqual(again.items.map(i => i.ref), first.items.map(i => i.ref)); assert.equal(rows(agent.id).length, first.items.length);
      const ref = first.items[0].ref, read = (await h.read(agent, ref)).value;
      assert.equal(read.status, 'ok'); assert.equal(read.items[0].ref, ref);
      const [context] = await h.drive(agent, [{ name: 'recall_read', args: { action: 'read', ref, scope: 'context' } }]);
      assert.equal(context.value.status, 'ok'); assert.equal(context.value.items.find(i => i.source.seq === first.items[0].source.seq).ref, ref);
      retained = { agent, ref };
      evidence.stable = { initialItems: first.items.length, initialRefLength: ref.length, finalUniqueMappings: rows(agent.id).length };
    });
    await check('a native read reuses its durable ref before another session source write is released', async () => {
      const { agent: a } = await h.seed('ref-wait-native-a', ['needle source A']);
      const { agent: b } = await h.seed('ref-wait-native-b', ['needle source B']);
      const ref = (await search(b)).value.items[0].ref, before = state(b), entered = deferred(), release = deferred();
      const table = ctx.recallReferences.table, put = table.put.bind(table), order = [], writes = [];
      const restore = replace(table, 'put', async (key, row) => {
        writes.push({ key, sessionId: row.sessionId });
        if (row.sessionId === a.id) { order.push('A write entered'); entered.resolve(); await release.promise; }
        return put(key, row);
      });
      let pending;
      try {
        pending = search(a); await bounded(entered.promise);
        const read = await bounded(h.read(b, ref)); order.push('B read completed');
        assert.equal(read.value.status, 'ok'); assert.equal(read.value.items[0].ref, ref);
        assert.equal(read.value.items[0].content, 'needle source B');
        assert.equal(state(b).shared, before.shared - 1); assert.equal(state(b).searches, before.searches);
        assert.equal(state(b).queries[0].free, before.queries[0].free);
        assert.equal(state(b).closed, false); assert.equal(state(b).calls.length, before.calls.length + 1);
        const completed = state(b);
        const replay = await ctx.tools.execute({ name: 'recall_read', callId: read.data.message.toolCallId,
          arguments: { action: 'read', ref }, agent: b, signal: new AbortController().signal });
        assert.equal(replay.error.info.code, 'call_replay'); assert.deepEqual(state(b), completed);
        assert.deepEqual(writes.map(row => row.sessionId), [a.id]);
        order.push('A write released'); release.resolve(); assert.equal((await pending).value.status, 'ok');
        evidence.waitIsolation = { order, writes, ref, before: before.shared, after: state(b).shared };
      } finally { release.resolve(); if (pending) await pending; restore(); }
    });
    await check('a native search cancelled while its source creation is queued finishes before the unrelated writer and never writes late', async () => {
      const { agent: a } = await h.seed('ref-queued-native-a', ['needle queued A']);
      const { agent: b } = await h.seed('ref-queued-native-b', ['needle queued B']);
      const entered = deferred(), queued = deferred(), release = deferred(), store = ctx.recallReferences;
      const table = store.table, put = table.put.bind(table), run = store.writes.run.bind(store.writes), writes = [], tasks = [];
      const restore = replace(table, 'put', async (key, row) => {
        writes.push(row.sessionId); if (row.sessionId === a.id) { entered.resolve(); await release.promise; } return put(key, row);
      });
      const restoreRun = replace(store.writes, 'run', (...args) => { const task = run(...args); if (store.stats().pendingWrites === 2) queued.resolve(); return task; });
      try {
        const first = search(a); tasks.push(first); await bounded(entered.promise);
        const second = search(b, human('cancel queued source creation'), false); tasks.push(second); await bounded(queued.promise);
        b.cancel({ kind: 'user' }); const cancelled = await bounded(second);
        assert.equal(cancelled.data.message.isError, true); assert.deepEqual(writes, [a.id]);
        assert.equal(rows(b.id).length, 0); assert.equal(store.stats().pendingWrites, 1);
        assert.equal(state(b).shared, 11); assert.equal(state(b).searches, 5); assert.equal(state(b).actualCalls, 1);
        assert.equal(state(b).queries[0].free, 0); assert.equal(state(b).queries[0].granted, false); assert.equal(state(b).closed, false);
        release.resolve(); assert.equal((await first).value.status, 'ok');
        await store.writes.drain(); assert.equal(rows(b.id).length, 0); assert.deepEqual(writes, [a.id]);
        assert.equal((await search(b, recovery())).value.status, 'ok');
        assert.equal(state(b).shared, 10); assert.equal(state(b).queries[0].free, 0);
        evidence.queuedCancellation = { writes, calls: state(b).actualCalls, shared: state(b).shared, searches: state(b).searches };
      } finally { release.resolve(); await Promise.allSettled(tasks); restoreRun(); restore(); }
    });
    await check('an unrenderable page creates no source mappings or cursors', async () => {
      const { agent } = await h.seed('ref-page-too-small', bodies());
      const restore = replace(ctx.recallTools.search, 'config', loadRecallConfig({ searchPageTokens: 100 }));
      try {
        const failed = (await search(agent)).value;
        assert.equal(failed.code, 'output_budget_too_small'); assert.deepEqual(failed.items, []);
        assert.equal(rows(agent.id).length, 0); assert.equal(ctx.recallCursors.records().filter(r => r.sessionId === agent.id).length, 0);
      } finally { restore(); }
    });
    await check('partial multi-record publication returns no page and retry reuses saved mappings without a new free-page grant', async () => {
      const { agent } = await h.seed('ref-page-partial', bodies()), table = ctx.recallReferences.table, put = table.put.bind(table);
      let writes = 0;
      const restore = replace(table, 'put', async (key, row) => {
        if (row.sessionId === agent.id && ++writes === 2) throw new Error('injected second reference failure');
        return put(key, row);
      });
      try {
        const failed = (await search(agent)).value;
        assert.equal(failed.code, 'reference_write_failed'); assert.deepEqual(failed.items, []); assert.equal(failed.nextCursor, undefined);
      } finally { restore(); }
      assert.equal(rows(agent.id).length, 1); const saved = rows(agent.id)[0], before = state(agent);
      const retried = (await search(agent, recovery())).value;
      assert.equal(retried.status, 'ok'); assert.equal(retried.items.find(i => i.source.seq === saved.seq).ref, saved.handle);
      assert.equal(rows(agent.id).length, retried.items.length); assert.equal(state(agent).shared, before.shared - 1);
      assert.equal(state(agent).queries.length, 1); assert.equal(retried.budget.query_pages_remaining, 2);
      evidence.partial = { persistedBeforeRetry: 1, returnedRecords: retried.items.length, before: before.shared, after: state(agent).shared };
    });
    await check('blocked native delivery reuses all source mappings and the same output cursor on a legal retry', async () => {
      const { agent } = await h.seed('ref-page-blocked', bodies()); let blocked;
      const stop = ctx.on('tools/post-execute', async (exec, result, next) => {
        const decision = await next(); if (exec.agent?.id !== agent.id || exec.name !== 'recall_search') return decision;
        blocked = structuredClone(result.value); return { kind: 'block', feedback: [{ type: 'text', text: 'injected reference delivery rejection' }] };
      });
      try { assert.equal((await search(agent)).data.message.isError, true); } finally { await stop(); }
      assert.ok(blocked.nextCursor); const count = rows(agent.id).length;
      const retried = (await search(agent, recovery())).value;
      assert.equal(retried.status, 'ok'); assert.deepEqual(retried.items.map(i => i.ref), blocked.items.map(i => i.ref));
      assert.equal(retried.nextCursor, blocked.nextCursor); assert.equal(rows(agent.id).length, count);
    });
    await check('cancelled native source publication retains the charge and resumes from a complete new result page', async () => {
      const { agent } = await h.seed('ref-page-cancel', bodies()), entered = deferred(), release = deferred();
      const table = ctx.recallReferences.table, put = table.put.bind(table);
      const restore = replace(table, 'put', async (key, row) => { if (row.sessionId === agent.id) { entered.resolve(); await release.promise; } return put(key, row); });
      try {
        const pending = search(agent, human('cancel search during reference publication'), false); await entered.promise;
        agent.cancel({ kind: 'user' }); release.resolve(); assert.equal((await pending).data.message.isError, true);
      } finally { release.resolve(); restore(); }
      assert.equal(ctx.recallReferences.stats().pendingWrites, 0); assert.equal(rows(agent.id).length, 1);
      const saved = rows(agent.id)[0], before = state(agent).shared;
      const retried = (await search(agent, recovery())).value;
      assert.equal(retried.status, 'ok'); assert.equal(retried.items[0].ref, saved.handle); assert.equal(retried.start, 0);
      assert.equal(state(agent).shared, before - 1);
    });
    await check('missing anchor mappings reject even live cursors without inventing recovery references', async () => {
      const { agent } = await h.seed('ref-missing-anchor', ['needle ' + '正文😀'.repeat(10000)]);
      const ref = (await search(agent)).value.items[0].ref, first = (await h.read(agent, ref)).value;
      assert.ok(first.nextCursor);
      const mapping = ctx.recallReferences.resolve(ref, agent.id), table = ctx.recallReferences.table;
      await table.delete(mapping.recordKey); ctx.recallReferences.rebuildIndex();
      try {
        const [failed] = await h.drive(agent, [{ name: 'recall_read', args: { action: 'next', cursor: first.nextCursor } }]);
        assert.equal(failed.value.code, 'stale_reference'); assert.doesNotMatch(failed.value.recovery, /source remains verified/);
      } finally { await table.put(mapping.recordKey, mapping); ctx.recallReferences.rebuildIndex(); }
    });
    await check('product reload retains identical refs and the original source while unsupported prior handles are rejected', async () => {
      const before = ctx.recallReferences.resolve(retained.ref, retained.agent.id);
      await [...ctx.loader.entries()].find(e => e.options.id === 'recall').fiber.restart();
      assert.deepEqual(ctx.recallReferences.resolve(retained.ref, retained.agent.id), before);
      const page = (await h.read(retained.agent, retained.ref, human('read after reload'))).value;
      assert.equal(page.status, 'ok'); assert.equal(page.items[0].ref, retained.ref);
      assert.equal((await h.read(retained.agent, 'rr1.unsupported', human('old reference'))).value.code, 'stale_reference');
      assert.equal((await h.next(retained.agent, 'rs2_' + 'Z'.repeat(22))).value.code, 'stale_reference');
    });
  } finally { await h.dispose(); }
  const path = join(process.env.DSH_HOME, '..', 'reference-pages-evidence.json');
  await writeFile(path, JSON.stringify(evidence, null, 2)); console.log(`Reference page evidence: ${path}`);
}
