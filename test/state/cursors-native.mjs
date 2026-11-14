import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy';
import { cursorRecord, cursorPageId, cursorPlaceholder, currentInteraction } from '../../lib/index.js';
import { recallHarness } from '../../support/fixtures/recall-harness.mjs';
import { human, recovery } from '../../support/fixtures/scripted-model.mjs';
import { replace, deferred } from '../../support/fixtures/control.mjs';
import { bounded, verifyMappingWaits } from '../fixtures/mapping-waits.mjs';

export async function verifyCursors(ctx) {
  const h = recallHarness(ctx), cases = [], evidence = { cases };
  const check = async (label, run) => { await run(); cases.push(label); console.log(`PASS: ${label}`); };
  const signal = new AbortController().signal;
  const state = agent => ctx.recallBudget.state(currentInteraction(agent.session));
  const rows = session => ctx.recallCursors.records().filter(r => r.sessionId === session);
  const readNext = async (agent, cursor, final = true) => (await h.drive(agent, [{ name: 'recall_read', args: { action: 'next', cursor } }], recovery(), final))[0];
  const reload = () => [...ctx.loader.entries()].find(e => e.options.id === 'recall').fiber.restart();
  const anchor = async sessionId => (await ctx.recallReferences.issue({ sessionId, formatVersion: 1, historyId: 'a'.repeat(64), seq: 3, recordId: 'b'.repeat(64), fingerprint: 'c'.repeat(64) }, signal)).handle;
  let retained;
  try {
    await check('typed 26-character handles persist one stable mapping under concurrent issuance and reject unknown/session/type damage', async () => {
      const sessionId = 'cursor-shape';
      const targets = [
        { sessionId, kind: 'search', locator: { queryId: 'a'.repeat(64), order: 'oldest', index: 2 } },
        { sessionId, kind: 'read', locator: { anchorRef: await anchor(sessionId), readStateId: 'b'.repeat(64), index: 1, charOffset: 30 } },
        { sessionId, kind: 'files', locator: { anchorRef: await anchor(sessionId), readStateId: 'c'.repeat(64), index: 0, charOffset: 0, fileIndex: 2 } },
      ];
      for (const target of targets) {
        const before = ctx.recallCursors.stats().records;
        const issued = await Promise.all(Array.from({ length: 8 }, () => ctx.recallCursors.issue(target, signal)));
        assert.equal(new Set(issued.map(r => r.handle)).size, 1); assert.equal(ctx.recallCursors.stats().records, before + 1);
        const row = issued[0], tool = target.kind === 'search' ? 'search' : 'read';
        assert.equal(row.handle.length, 26); assert.equal(row.handle.slice(0, 4), cursorPlaceholder(target.kind).slice(0, 4));
        assert.deepEqual(ctx.recallCursors.resolve(row.handle, sessionId, tool), row);
        assert.equal(cursorPageId({ ...target, locator: Object.fromEntries(Object.entries(target.locator).reverse()) }), row.pageId);
        assert.notEqual(cursorPageId({ ...target, locator: { ...target.locator, index: target.locator.index + 1 } }), row.pageId);
        for (const [handle, session, kind] of [[row.handle.slice(1), sessionId, tool], [row.handle, 'other', tool], [row.handle, sessionId, tool === 'search' ? 'read' : 'search'], ['rs1.unsupported', sessionId, tool], ['rd1.unsupported', sessionId, tool], ['rf1.unsupported', sessionId, tool], [cursorPlaceholder(target.kind), sessionId, tool]]) {
          assert.throws(() => ctx.recallCursors.resolve(handle, session, kind), e => e.code === 'stale_reference');
        }
        assert.equal(cursorRecord.safeParse({ ...row, locator: { ...row.locator, index: 999 } }).success, false);
        assert.equal(cursorRecord.safeParse({ ...row, handle: 'bad' }).success, false);
      }
      evidence.formats = rows(sessionId).map(r => ({ kind: r.kind, handle: r.handle, pageId: r.pageId }));
    });

    await check('durable cursors bypass blocked writes; queued cancellation, nested input capture and failed-owner retry remain isolated', async () => {
      await verifyMappingWaits(ctx.recallCursors, {
        target: name => ({ sessionId: `cursor-waits-${name}`, kind: 'search', locator: { queryId: 'a'.repeat(64), order: 'oldest', index: 1 } }),
        key: cursorPageId, mutate: target => { target.locator.index = 999; target.locator.order = 'newest'; target.sessionId = 'mutated'; }, writeError: 'cursor_write_failed',
      });
    });
    await check('fast cursor reuse still verifies its session anchor', async () => {
      const sessionId = 'cursor-fast-anchor', anchorRef = await anchor(sessionId);
      const target = { sessionId, kind: 'read', locator: { anchorRef, readStateId: 'b'.repeat(64), index: 0, charOffset: 0 } };
      await ctx.recallCursors.issue(target, signal);
      const row = ctx.recallReferences.resolve(anchorRef, sessionId), table = ctx.recallReferences.table;
      await table.delete(row.recordKey); ctx.recallReferences.rebuildIndex();
      try { await assert.rejects(ctx.recallCursors.issue(target, signal), e => e.code === 'stale_reference'); }
      finally { await table.put(row.recordKey, row); ctx.recallReferences.rebuildIndex(); }
    });
    await check('cursor unload cancels queued work and fast reuse while draining its active native write', async () => {
      const old = ctx.recallCursors, table = old.table, put = table.put.bind(table), entered = deferred(), release = deferred();
      const target = { sessionId: 'cursor-unload', kind: 'search', locator: { queryId: 'a'.repeat(64), order: 'oldest', index: 1 } };
      const saved = await old.issue(target, signal), blocked = { ...target, locator: { ...target.locator, index: 2 } };
      const queuedTarget = { ...target, locator: { ...target.locator, index: 3 } };
      const undo = replace(table, 'put', async (...args) => { entered.resolve(); await release.promise; return put(...args); });
      const tasks = [];
      try {
        const rejected = assert.rejects(old.issue(blocked, signal), e => e.code === 'recall_unloaded'); tasks.push(rejected);
        await bounded(entered.promise);
        const queued = assert.rejects(old.issue(queuedTarget, signal), e => e.code === 'recall_unloaded'); tasks.push(queued);
        let reloaded = false;
        const reloading = reload().then(() => { reloaded = true; }); tasks.push(reloading);
        await bounded(queued);
        await assert.rejects(old.issue(target, signal), e => e.code === 'recall_unloaded');
        assert.equal(reloaded, false); assert.equal(old.stats().pendingWrites, 1);
        release.resolve(); await rejected; await reloading; await h.ready();
        assert.deepEqual(await ctx.recallCursors.issue(target, signal), saved);
        assert.ok(ctx.recallCursors.records().some(row => row.pageId === cursorPageId(blocked)));
        assert.equal(ctx.recallCursors.records().some(row => row.pageId === cursorPageId(queuedTarget)), false);
        assert.equal(old.stats().pendingWrites, 0); assert.equal(old.stats().indexEntries, 0);
      } finally { release.resolve(); await Promise.allSettled(tasks); undo(); }
    });
    await check('real search sizes without candidate writes and records stable page identity separately from submitted arguments', async () => {
      const { agent } = await h.seed('cursor-search', Array.from({ length: 9 }, (_, i) => `needle ${i} ` + '中文😀'.repeat(170)));
      const first = (await h.search(agent)).value;
      assert.equal(first.status, 'ok'); assert.match(first.nextCursor, /^rs3_[\w-]{22}$/); assert.equal(rows(agent.id).length, 1);
      const cursor = ctx.recallCursors.resolve(first.nextCursor, agent.id, 'search');
      ctx.recallCursors.byHandle.clear(); ctx.recallCursors.rebuildIndex();
      const page = (await h.next(agent, first.nextCursor)).value;
      assert.equal(page.status, 'ok'); assert.equal(page.start, first.end);
      const call = state(agent).calls.at(-1);
      assert.equal(call.page, cursor.pageId); assert.equal(call.charge, 'free');
      assert.equal(call.argsHash, createHash('sha256').update(JSON.stringify({ action: 'next', cursor: first.nextCursor })).digest('hex'));
      assert.equal(rows(agent.id).length, page.nextCursor ? 2 : 1);
      assert.equal((await h.next(agent, first.nextCursor)).value.code, 'duplicate_page');
      evidence.search = { handleLength: first.nextCursor.length, pageId: call.page, submittedArgsHash: call.argsHash };
    });

    await check('read delivery failure retries the same source position and reuses the persisted output handle', async () => {
      const body = 'needle ' + '原文😀 line\n'.repeat(6000), { agent } = await h.seed('cursor-delivery', [body]);
      const ref = (await h.search(agent)).value.items[0].ref, first = (await h.read(agent, ref)).value;
      assert.match(first.nextCursor, /^rd3_[\w-]{22}$/); assert.equal(rows(agent.id).length, 1);
      const input = ctx.recallCursors.resolve(first.nextCursor, agent.id, 'read');
      let blockedHandle;
      const stop = ctx.on('tools/post-execute', async (exec, result, next) => {
        const decision = await next();
        if (exec.agent?.id !== agent.id || exec.name !== 'recall_read') return decision;
        blockedHandle = result.value.nextCursor;
        return { kind: 'block', feedback: [{ type: 'text', text: 'injected cursor delivery rejection' }] };
      });
      try { assert.equal((await readNext(agent, first.nextCursor)).data.message.isError, true); } finally { await stop(); }
      assert.ok(blockedHandle); const count = rows(agent.id).length, shared = state(agent).shared;
      const retried = (await readNext(agent, first.nextCursor)).value;
      assert.equal(retried.status, 'ok'); assert.equal(retried.items[0].start, input.locator.charOffset);
      assert.equal(retried.items[0].content, body.slice(retried.items[0].start, retried.items[0].end));
      assert.equal(retried.nextCursor, blockedHandle); assert.equal(rows(agent.id).length, count); assert.equal(state(agent).shared, shared - 1);
      assert.equal(state(agent).calls.at(-1).page, input.pageId);
      assert.equal((await readNext(agent, first.nextCursor)).value.code, 'duplicate_page');
      retained = { sessionId: agent.id, ref, handle: retried.nextCursor, row: ctx.recallCursors.resolve(retried.nextCursor, agent.id, 'read') };
    });

    await check('native PTC continues a short read handle and keeps its subcall identity and stable page charge', async () => {
      const { agent } = await h.seed('cursor-ptc', ['needle ' + '中文😀'.repeat(10000)]);
      const ref = (await h.search(agent)).value.items[0].ref, first = (await h.read(agent, ref)).value;
      const input = ctx.recallCursors.resolve(first.nextCursor, agent.id, 'read'), before = state(agent).shared;
      setSandboxMode(agent.session, 'read-only');
      const native = agent.ctx.tools.presentAs('ptc');
      try {
        const [result] = await h.drive(agent, [{ name: 'run_code', args: { code: `return await tools.recall_read(${JSON.stringify({ action: 'next', cursor: first.nextCursor })});`, description: 'Continue a verified historical read page' } }]);
        assert.equal(result.data.message.isError, false);
        const row = state(agent), call = row.calls.at(-1);
        assert.equal(call.kind, 'ptc'); assert.equal(call.page, input.pageId); assert.equal(row.shared, before - 1);
        const dispatch = agent.session.snapshotEvents().findLast(e => e.type === 'tool/ptc-dispatch' && e.data.name === 'recall_read');
        const page = JSON.parse(dispatch.data.content[0].text);
        assert.equal(page.status, 'ok'); assert.equal(page.items[0].start, input.locator.charOffset);
        if (page.nextCursor) assert.match(page.nextCursor, /^rd3_[\w-]{22}$/);
      } finally { native(); }
    });

    await check('mapping write failure returns no continuation, retains the charge and allows the original input page to retry', async () => {
      const { agent } = await h.seed('cursor-write-failure', ['needle ' + 'x😀'.repeat(24000)]);
      const ref = (await h.search(agent)).value.items[0].ref, first = (await h.read(agent, ref)).value;
      const input = ctx.recallCursors.resolve(first.nextCursor, agent.id, 'read'), table = ctx.recallCursors.table;
      const put = table.put.bind(table), before = state(agent).shared, count = rows(agent.id).length;
      const undo = replace(table, 'put', (key, value) => value.sessionId === agent.id ? Promise.reject(new Error('injected EIO')) : put(key, value));
      try {
        const failed = (await readNext(agent, first.nextCursor)).value;
        assert.equal(failed.code, 'cursor_write_failed'); assert.equal(failed.nextCursor, undefined);
        assert.equal(rows(agent.id).length, count); assert.equal(state(agent).shared, before - 1); assert.equal(state(agent).closed, false);
      } finally { undo(); }
      const retried = (await readNext(agent, first.nextCursor)).value;
      assert.equal(retried.status, 'ok'); assert.equal(retried.items[0].start, input.locator.charOffset);
      assert.equal(state(agent).shared, before - 2); assert.equal(rows(agent.id).length, count + 1);
    });

    await check('cancellation during a mapping write drains publication without publishing a tool continuation or advancing the input', async () => {
      const { agent } = await h.seed('cursor-write-cancel', ['needle ' + 'x😀'.repeat(24000)]);
      const ref = (await h.search(agent)).value.items[0].ref, first = (await h.read(agent, ref)).value;
      const input = ctx.recallCursors.resolve(first.nextCursor, agent.id, 'read'), table = ctx.recallCursors.table;
      const entered = deferred(), release = deferred(), put = table.put.bind(table), before = state(agent).shared;
      const undo = replace(table, 'put', async (key, value) => {
        if (value.sessionId === agent.id) { entered.resolve(); await release.promise; }
        return put(key, value);
      });
      try {
        const pending = readNext(agent, first.nextCursor, false); await entered.promise;
        agent.cancel({ kind: 'user' }); let settled = false; void pending.then(() => { settled = true; });
        await new Promise(resolve => setImmediate(resolve)); assert.equal(settled, false);
        release.resolve(); const cancelled = await pending;
        assert.equal(cancelled.data.message.isError, true); assert.equal(state(agent).shared, before - 1);
        assert.equal(ctx.recallCursors.stats().pendingWrites, 0);
      } finally { release.resolve(); undo(); }
      const count = rows(agent.id).length, retried = (await readNext(agent, first.nextCursor)).value;
      assert.equal(retried.status, 'ok'); assert.equal(retried.items[0].start, input.locator.charOffset);
      assert.equal(rows(agent.id).length, count); assert.equal(state(agent).shared, before - 2);
    });

    await check('persistent metadata cost is measured for 1000 read locations without storing any original body', async () => {
      const sessionId = 'cursor-capacity', before = ctx.recallCursors.stats(), started = performance.now();
      for (let i = 0; i < 1000; i++) await ctx.recallCursors.issue({ sessionId, kind: 'read', locator: { anchorRef: await anchor(sessionId), readStateId: 'd'.repeat(64), index: i, charOffset: 0 } }, signal);
      const after = ctx.recallCursors.stats(), sample = rows(sessionId);
      assert.equal(sample.length, 1000); assert.equal(after.records - before.records, 1000);
      assert.ok(sample.every(row => Object.keys(row).sort().join() === 'handle,kind,locator,pageId,sessionId,version'));
      evidence.capacity = { count: 1000, writeMs: performance.now() - started, logicalBytes: after.logicalBytes - before.logicalBytes,
        indexBytes: after.indexBytes - before.indexBytes, retainedRecordBytes: after.retainedRecordBytes - before.retainedRecordBytes };
    });

    await check('native reload preserves mappings, releases the old index and rejects malformed, wrong-version and schema-invalid records', async () => {
      const faults = [];
      for (let i = 0; i < 3; i++) faults.push(await ctx.recallCursors.issue({ sessionId: 'cursor-damaged', kind: 'search', locator: { queryId: 'f'.repeat(64), order: 'oldest', index: i } }, signal));
      const paths = await readdir(process.env.DSH_HOME, { recursive: true });
      const pathFor = row => join(process.env.DSH_HOME, paths.find(path => path.endsWith(`${row.pageId}.json`)));
      const firstPath = pathFor(faults[0]), secondPath = pathFor(faults[1]), thirdPath = pathFor(faults[2]);
      await writeFile(firstPath, '{bad');
      const second = JSON.parse(await readFile(secondPath, 'utf8')); second.version = 999; await writeFile(secondPath, JSON.stringify(second));
      const third = JSON.parse(await readFile(thirdPath, 'utf8')); third.record.locator.index++; await writeFile(thirdPath, JSON.stringify(third));
      const capacityRows = rows('cursor-capacity');
      evidence.capacity.documentBytes = (await Promise.all(capacityRows.map(async row => (await stat(pathFor(row))).size))).reduce((a, b) => a + b, 0);
      const old = ctx.recallCursors, started = performance.now(); await reload();
      evidence.capacity.reloadMs = performance.now() - started;
      assert.equal(old.stats().closed, true); assert.equal(old.stats().indexEntries, 0); assert.equal(old.stats().records, 0);
      assert.deepEqual(ctx.recallCursors.resolve(retained.handle, retained.sessionId, 'read'), retained.row);
      assert.equal(rows('cursor-capacity').length, 1000);
      for (const row of faults) assert.throws(() => ctx.recallCursors.resolve(row.handle, row.sessionId, 'search'), e => e.code === 'stale_reference');
      const agent = h.agents.find(h => h.agent.id === retained.sessionId).agent;
      const before = state(agent).shared, expired = (await readNext(agent, retained.handle)).value;
      assert.equal(expired.code, 'stale_reference'); assert.ok(expired.recovery.includes(retained.ref)); assert.equal(state(agent).shared, before - 1);
      const fresh = (await h.read(agent, retained.ref, human('read verified source again'))).value;
      assert.equal(fresh.status, 'ok'); assert.equal(fresh.items[0].start, 0); assert.equal(fresh.budget.shared_remaining, 11);
    });
  } finally { await h.dispose(); }
  const path = join(process.env.DSH_HOME, '..', 'cursor-evidence.json');
  await writeFile(path, JSON.stringify(evidence, null, 2)); console.log(`Cursor evidence: ${path}`);
}
