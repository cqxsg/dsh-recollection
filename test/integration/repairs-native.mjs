import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { currentInteraction, renderedTokens, recordAttachments, HistoryRecordCache, hashKey, RecallAttachmentService } from '../../lib/index.js';
import { recallHarness } from '../../support/fixtures/recall-harness.mjs';
import { repairHistoryFixture } from '../../support/fixtures/repair-history.mjs';
import { human, recovery } from '../../support/fixtures/scripted-model.mjs';
import { rangeFixture } from '../../support/fixtures/range.mjs';
import { fixturePng } from '../fixtures/image.mjs';
import * as fileTools from '@deepseek-ai/dsh-tool-fs';
import * as searchTools from '@deepseek-ai/dsh-tool-fs-search';

const until = async predicate => { const end = performance.now() + 15000; while (!predicate()) { assert.ok(performance.now() < end, 'repair probe timed out'); await new Promise(r => setTimeout(r, 5)); } };
export async function verifyRepairs(ctx) {
  const fixtures = [];
  if (!ctx.tools.get('read')) fixtures.push(await ctx.plugin(fileTools));
  if (!ctx.tools.get('grep')) fixtures.push(await ctx.plugin(searchTools, { sampleOverCapGlobResults: false, globMaxResults: 2, grepMaxMatches: 2 }));
  const fixed = new Set((process.argv.find(a => a.startsWith('--fixed='))?.slice(8) ?? 'F01,F02,F03,F04').split(','));
  const selected = process.argv.find(a => a.startsWith('--cases='))?.slice(8).split(',');
  const cases = [], h = recallHarness(ctx, { inputModalities: ['text', 'image'] }, repairHistoryFixture);
  const check = async (id, run) => { if (selected && !selected.includes(id)) return; const evidence = await run(fixed.has(id)); cases.push({ id, fixed: fixed.has(id), ...evidence }); console.log(`PASS: ${id} ${fixed.has(id) ? 'fixed behavior' : 'baseline defect'} ${JSON.stringify(evidence)}`); };
  const compact = async agent => {
    const groups = [[]];
    for (const seq of agent.session.surface.nodes) {
      if (agent.session.snapshotEvents()[seq].type === 'system/message') groups.push([]); else groups.at(-1).push(seq);
    }
    for (const group of groups) if (group.length) rangeFixture(agent.session).summary(group);
    await ctx.sessions.flush(agent.session);
  };
  const records = async agent => {
    const cache = new HistoryRecordCache();
    try { return await ctx.recallHistory.withSnapshot(agent.id, async (snapshot, signal) => {
      let batch;
      do { batch = await cache.prepareBatch(snapshot, ctx.sessions.messageProjections, {}, signal); } while (batch.status !== 'complete');
      return cache.records(batch);
    }); } finally { cache.dispose(); }
  };
  try {
    await check('F02', async fixed => {
      const b = join(process.cwd(), 'changed'), c = join(process.cwd(), 'later');
      await Promise.all([b, c].map(p => mkdir(p, { recursive: true })));
      await Promise.all([[process.cwd(), 'A'], [b, 'B'], [c, 'C']].map(([p, value]) => writeFile(join(p, 'note.txt'), value)));
      const { agent } = await h.seed('repair-directory');
      const [change] = await h.drive(agent, [{ name: 'working_directory', args: { cd: b } }], human('change directory'));
      assert.equal(change.data.message.isError, false);
      const release = ctx.recallPreparation.holdOperation(agent.id);
      try {
        await h.drive(agent, [], human('needle directory-reference @note.txt'), false);
        await ctx.recallAttachments.idleAdmissions();
        await h.drive(agent, [{ name: 'working_directory', args: { cd: c } }], human('change again before sampling'));
      } finally { release(); }
      await until(() => ctx.recallHashes.records().some(r => r.source.sessionId === agent.id && r.state === 'saved'));
      const baseline = ctx.recallHashes.records().find(r => r.source.sessionId === agent.id);
      await compact(agent);
      const item = (await h.search(agent, human('find prior reference'), ['directory-reference'])).value.items[0];
      assert.equal(item.attachments.length, 1);
      const [read] = await h.drive(agent, [{ name: 'recall_read', args: { action: 'read', ref: item.ref, target: 'attachments', attachments: item.attachments.map(a => a.ref) } }]);
      const file = read.value.attachmentResults[0];
      assert.equal(file.path, join(fixed ? b : process.cwd(), 'note.txt'));
      assert.equal(file.version.state, 'same');
      assert.equal(baseline.source.cwd, fixed ? b : process.cwd());
      if (fixed) {
        await unlink(join(process.cwd(), 'note.txt'));
        await writeFile(join(b, 'note.txt'), 'B changed');
        const [changed] = await h.drive(agent, [{ name: 'recall_read', args: { action: 'read', ref: item.ref, target: 'attachments', attachments: item.attachments.map(a => a.ref) } }]);
        assert.equal(changed.value.attachmentResults[0].path, join(b, 'note.txt'));
        assert.equal(changed.value.attachmentResults[0].version.state, 'different');
        await writeFile(join(process.cwd(), 'note.txt'), 'A'); await writeFile(join(b, 'note.txt'), 'B');
        // Persist a legacy saved baseline pointing to A; a cold agent must still read B without claiming same.
        const legacy = structuredClone(baseline); legacy.source.cwd = process.cwd(); legacy.resolvedPath = join(process.cwd(), 'note.txt');
        await ctx.recallHashes.table.put(hashKey(legacy.source), legacy);
        await h.agents.find(handle => handle.agent === agent).dispose();
        const reopened = await ctx.agents.resume({ resumeSessionId: agent.id, agentOptions: h.model.options }); h.agents.push(reopened);
        const [cold] = await h.drive(reopened.agent, [{ name: 'recall_read', args: { action: 'read', ref: item.ref, target: 'attachments', attachments: item.attachments.map(a => a.ref) } }], human('check old baseline'));
        assert.equal(cold.value.attachmentResults[0].path, join(b, 'note.txt'));
        assert.equal(cold.value.attachmentResults[0].version.state, 'unverified');
        assert.equal(cold.value.attachmentResults[0].version.reason, 'baseline_source_mismatch');
        assert.deepEqual(ctx.recallHashes.get(hashKey(legacy.source)), legacy, 'cold read cannot overwrite the old sample');
        // A legacy unfinished row must fail provenance verification before byte sampling.
        await [...ctx.registry.get(RecallAttachmentService).fibers].find(f => f.state === 2).dispose();
        const pending = { ...legacy, state: 'pending', attempts: 0, spentMs: 0 }; delete pending.sample;
        await ctx.recallHashes.table.put(hashKey(pending.source), pending);
        await ctx.plugin(RecallAttachmentService);
        await until(() => ctx.recallHashes.get(hashKey(pending.source)).state === 'failed');
        const failed = ctx.recallHashes.get(hashKey(pending.source));
        assert.equal(failed.reason, 'source_unverifiable'); assert.equal(failed.attempts, 0);
      }
      return { initial: agent.session.header.cwd, expected: join(b, 'note.txt'), actual: file.path, version: file.version.state };
    });
    await check('F01', async fixed => {
      await writeFile('parameter.txt', 'parameter content'); await writeFile('parameter.png', fixturePng());
      const { agent } = await h.seed('repair-parameters');
      const results = await h.drive(agent, [{ name: 'read', args: { file_path: join(process.cwd(), 'parameter.txt') } }, { name: 'read_image', args: { file_path: join(process.cwd(), 'parameter.png') } }], human('read files'));
      assert.equal(results[0].data.message.isError, false, JSON.stringify(results[0].data));
      assert.equal(results[1].data.message.isError, false, JSON.stringify(results[1].data));
      assert.ok(results[1].data.message.content.some(b => b.type === 'image'));
      await ctx.recallAttachments.idleAdmissions(); await compact(agent);
      const calls = (await records(agent)).filter(r => r.kind === 'tool_call' && ['read', 'read_image'].includes(r.tool?.name));
      assert.equal(calls.length, 2);
      assert.deepEqual(calls.map(r => recordAttachments(r).length), fixed ? [1, 1] : [0, 0]);
      if (fixed) await until(() => ctx.recallHashes.records().filter(r => r.source.sessionId === agent.id && r.state === 'saved').length === 2);
      assert.equal(ctx.recallHashes.records().filter(r => r.source.sessionId === agent.id).length, fixed ? 2 : 0);
      if (fixed) {
        const folder = join(process.cwd(), 'parameter-relative'); await mkdir(folder, { recursive: true });
        await writeFile(join(folder, 'parameter.txt'), 'relative content'); await writeFile(join(folder, 'parameter.png'), fixturePng());
        await h.drive(agent, [{ name: 'working_directory', args: { cd: folder } }], human('change before relative calls'));
        const relative = await h.drive(agent, [{ name: 'read', args: { file_path: 'parameter.txt' } }, { name: 'read_image', args: { file_path: 'parameter.png' } }], human('read relative files'));
        assert.ok(relative.every(r => !r.data.message.isError));
        await ctx.recallAttachments.idleAdmissions();
        await until(() => ctx.recallHashes.records().filter(r => r.source.sessionId === agent.id && r.state === 'saved').length === 4);
        const rows = ctx.recallHashes.records().filter(r => r.source.sessionId === agent.id && r.source.path === 'parameter.txt');
        assert.equal(rows.length, 1); assert.equal(rows[0].resolvedPath, join(folder, 'parameter.txt'));
        await compact(agent);
        const item = (await h.search(agent, human('find relative call'), ['parameter.txt'])).value.items.find(i => i.source.kind === 'tool_call' && i.content.includes('"file_path":"parameter.txt"'));
        assert.ok(item);
        const [read] = await h.drive(agent, [{ name: 'recall_read', args: { action: 'read', ref: item.ref, target: 'attachments', attachments: item.attachments.map(a => a.ref) } }]);
        assert.equal(read.value.attachmentResults[0].path, join(folder, 'parameter.txt')); assert.equal(read.value.attachmentResults[0].version.state, 'same');
      }
      return { tools: calls.map(r => r.tool.name), references: calls.map(r => recordAttachments(r).length), imageCallError: results[1].data.message.isError };
    });
    await check('F03', async fixed => {
      const folder = join(process.cwd(), 'spill-input'); await mkdir(folder, { recursive: true });
      await Promise.all(Array.from({ length: 6 }, (_, i) => writeFile(join(folder, `f${i}.txt`), 'spill-needle')));
      const { agent } = await h.seed('repair-spill');
      const results = await h.drive(agent, [{ name: 'grep', args: { pattern: 'spill-needle', path: folder } }, { name: 'glob', args: { pattern: '*.txt', path: folder } }], human('find files'));
      for (const result of results) assert.equal(result.data.message.isError, false, JSON.stringify(result.data));
      assert.match(results[0].data.message.content[0].text, /Full grep result stored at:/);
      assert.match(results[1].data.message.content[0].text, /Full sorted result stored at:/);
      await compact(agent);
      const found = (await records(agent)).filter(r => r.kind === 'tool_result' && ['grep', 'glob'].includes(r.tool?.name));
      assert.equal(found.length, 2); assert.deepEqual(found.map(r => recordAttachments(r).length), fixed ? [1, 1] : [0, 0]);
      if (fixed) {
        const search = await h.search(agent, human('recall saved search results'), ['result stored at:']);
        const items = search.value.items.filter(item => item.attachments.some(a => a.type === 'spill'));
        assert.equal(items.length, 2);
        for (const item of items) {
          const [read] = await h.drive(agent, [{ name: 'recall_read', args: { action: 'read', ref: item.ref, target: 'attachments', attachments: item.attachments.map(a => a.ref) } }]);
          const result = read.value.attachmentResults[0];
          assert.equal(result.state, 'accessible'); assert.equal(result.version.state, 'unverified');
          assert.equal(result.version.reason, 'original_spill_locator_without_digest');
          assert.ok((await readFile(result.path, 'utf8')).includes('f5.txt'), 'full result includes a path beyond the preview');
        }
      }
      return { tools: found.map(r => r.tool.name), references: found.map(r => recordAttachments(r).length) };
    });
    await check('F04', async fixed => {
      const { agent } = await h.seed('repair-budget', ['needle ' + 'x'.repeat(20000)]);
      const item = (await h.search(agent)).value.items[0], args = { action: 'read', ref: item.ref };
      for (let i = 0; i < 10; i++) assert.equal((await h.drive(agent, [{ name: 'recall_read', args }], i ? recovery() : human('read repeatedly')))[0].value.status, 'ok');
      const engine = ctx.recallTools.read, budget = ctx.recallBudget;
      const rawRun = engine.run, rawReserve = budget.reserve;
      const ready = Promise.withResolvers(), reserved = Promise.withResolvers(); let page, before;
      engine.run = async function(...input) {
        const result = await rawRun.apply(this, input);
        if (input[1].callId === 'repair-page-a') { page = result.result; before = renderedTokens(page); ready.resolve(); await reserved.promise; }
        return result;
      };
      budget.reserve = async function(exec, ...rest) {
        if (exec.callId === 'repair-page-b') await ready.promise;
        const r = await rawReserve.call(this, exec, ...rest);
        if (exec.callId === 'repair-page-b') reserved.resolve();
        return r;
      };
      const timeout = setTimeout(() => { ready.reject(new Error('A not ready')); reserved.reject(new Error('B not reserved')); }, 15000);
      try {
        const [a] = await h.drive(agent, [{ id: 'repair-page-a', name: 'recall_read', args }, { id: 'repair-page-b', name: 'recall_read', args }]);
        const row = budget.state(currentInteraction(agent.session)), call = row.calls.find(c => c.callId === 'repair-page-a');
        assert.equal(row.shared, 0); assert.equal(row.actualCalls, 12);
        assert.equal(call.state, 'completed'); assert.equal(call.code, 'OK');
        if (fixed) {
          assert.equal(a.data.message.isError, false); assert.equal(a.value.status, 'ok'); assert.ok(renderedTokens(a.value) <= 2000); assert.ok(a.value.nextCursor);
          const content = a.value.items.map(i => i.content); let cursor = a.value.nextCursor, first = true;
          while (cursor) {
            const [next] = await h.drive(agent, [{ name: 'recall_read', args: { action: 'next', cursor } }], first ? human('continue after prior interaction exhausted') : recovery());
            first = false; assert.equal(next.value.status, 'ok'); content.push(...next.value.items.map(i => i.content)); cursor = next.value.nextCursor;
          }
          assert.equal(content.join(''), 'needle ' + 'x'.repeat(20000));
        }
        else { assert.equal(a.data.message.isError, true); assert.equal(a.data.error.code, 'output_budget_too_small'); assert.ok(renderedTokens(page) > 2000); }
        const mixed = fixed ? await verifyMixedCompletion(ctx, h) : undefined;
        return { before, final: renderedTokens(a.value ?? page), delivered: !a.data.message.isError, callState: call.state, error: a.data.error?.code, mixed };
      } finally { clearTimeout(timeout); ready.resolve(); reserved.resolve(); engine.run = rawRun; budget.reserve = rawReserve; }
    });
  } finally { await h.dispose(); for (const fixture of fixtures) await fixture.dispose(); }
  await writeFile(join(process.env.DSH_HOME, '..', 'repair-evidence.json'), JSON.stringify({ cases }, null, 2));
}

async function verifyMixedCompletion(ctx, h) {
  const { agent } = await h.seed('repair-budget-mixed', Array.from({ length: 12 }, (_, i) => `needle ${i} ${'x'.repeat(1200)}`));
  const item = (await h.search(agent)).value.items[0], args = { action: 'read', ref: item.ref };
  for (let i = 0; i < 10; i++) assert.equal((await h.drive(agent, [{ name: 'recall_read', args }], i ? recovery() : human('mixed concurrent exhaustion')))[0].value.status, 'ok');
  const engine = ctx.recallTools.search, budget = ctx.recallBudget, run = engine.run, reserve = budget.reserve;
  const ready = Promise.withResolvers(), reserved = Promise.withResolvers();
  engine.run = async function(...input) {
    const page = await run.apply(this, input);
    if (input[1].callId === 'mixed-search') { ready.resolve(); await reserved.promise; }
    return page;
  };
  budget.reserve = async function(exec, ...rest) {
    if (exec.callId === 'mixed-read') await ready.promise;
    const value = await reserve.call(this, exec, ...rest);
    if (exec.callId === 'mixed-read') reserved.resolve();
    return value;
  };
  const timeout = setTimeout(() => { ready.reject(new Error('mixed search not ready')); reserved.reject(new Error('mixed read not reserved')); }, 15000);
  try {
    const [search, read] = await h.drive(agent, [
      { id: 'mixed-search', name: 'recall_search', args: { action: 'search', mode: 'literal', patterns: ['needle'] } },
      { id: 'mixed-read', name: 'recall_read', args },
    ]);
    for (const result of [search, read]) { assert.equal(result.value.status, 'ok'); assert.ok(renderedTokens(result.value) <= 2000); }
    assert.equal(search.value.budget.shared_remaining, 0); assert.equal(search.value.budget.actual_calls, 12);
    assert.equal(search.value.budget.query_pages_remaining, 2); assert.ok(search.value.allowed_actions.includes('search_next'));
    const refs = search.value.items.map(i => i.ref); let page = search.value, first = true;
    assert.ok(page.nextCursor);
    while (page.nextCursor) {
      const input = page.budget.query_pages_remaining ? recovery() : human('continue saved search');
      const [next] = await h.drive(agent, [{ name: 'recall_search', args: { action: 'next', cursor: page.nextCursor } }], input);
      page = next.value; assert.equal(page.status, 'ok'); assert.ok(renderedTokens(page) <= 2000);
      if (first) { assert.equal(page.budget.shared_remaining, 0); assert.equal(page.budget.query_pages_remaining, 1); first = false; }
      refs.push(...page.items.map(i => i.ref));
    }
    assert.equal(refs.length, 12); assert.equal(new Set(refs).size, 12);
    return { searchTokens: renderedTokens(search.value), readTokens: renderedTokens(read.value), records: refs.length, freeContinuation: true };
  } finally { clearTimeout(timeout); ready.resolve(); reserved.resolve(); engine.run = run; budget.reserve = reserve; }
}
