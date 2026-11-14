import assert from 'node:assert/strict';
import { writeFile, copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as spill from '@deepseek-ai/dsh-spill-policy';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { estimateContent } from '@deepseek-ai/dsh-token-meter/estimate';
import { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy';
import * as timeoutPolicy from '@deepseek-ai/dsh-tool-call-timeout-policy';
import { createScope } from '@deepseek-ai/dsh-scope';
import { currentInteraction, renderedTokens, DIAGNOSTIC_TOOL_NAME, NativeMatcher } from '../../lib/index.js';
import { human, recovery } from '../../support/fixtures/scripted-model.mjs';
import { replace, deferred } from '../../support/fixtures/control.mjs';
import { recallHarness } from '../../support/fixtures/recall-harness.mjs';
import { verifyPublicEntry } from './public-entry-native.mjs';

export async function verifyRecall(ctx, browserBase) {
  const h = recallHarness(ctx), cases = [], evidence = { cases, performance: {}, pages: [], ptc: [] };
  const check = async (label, fn) => { await fn(); cases.push(label); console.log(`PASS: ${label}`); };
  const state = agent => ctx.recallBudget.state(currentInteraction(agent.session));
  let browser;
  try {
    if (!browserBase) {
    await verifyPublicEntry(ctx, h, check);
    await check('default product tools have native schemas, descriptions, prompt guidance, render/meta budgets and verified original refs', async () => {
      assert.ok(ctx.recallTools); assert.equal(ctx.recallPages.status.recallAvailable, true); assert.equal(ctx.tools.get(DIAGNOSTIC_TOOL_NAME), undefined);
      for (const name of ['recall_search', 'recall_read']) {
        const tool = ctx.tools.get(name); assert.equal(tool.timeoutMs, 60000); assert.equal(tool.parameters.additionalProperties, false); assert.equal(tool.parameters.properties.sessionId, undefined); assert.match(tool.description, /allowed_actions/);
      }
      const { agent } = await h.seed('recall-default', Array.from({ length: 12 }, (_, i) => `needle ${i} ` + '中文😀'.repeat(170)));
      const found = await h.search(agent); assert.equal(found.value.scanComplete, true); assert.equal(found.value.totalHits, 12); assert.ok(found.value.nextCursor);
      assert.deepEqual(found.data.meta.recall.budget, found.value.budget); assert.ok(renderedTokens(found.value) <= 2000);
      const ref = found.value.items[0].ref; assert.equal(ctx.recallReferences.resolve(ref, agent.id).sessionId, agent.id);
      const read = await h.read(agent, ref); assert.equal(read.value.readComplete, true); assert.ok(renderedTokens(read.value) <= 2000); assert.deepEqual(read.data.meta.recall.budget, read.value.budget);
      assert.ok(h.model.requests.filter(r => r.sessionId === agent.id).every(r => r.hasRecallUsage));
      evidence.pages.push({ search: renderedTokens(found.value), read: renderedTokens(read.value), meta: found.data.meta });
    });
    await check('native next-step declarations remove closed recall only; other tools run and admitted new input restores recall before assembly', async () => {
      const { agent } = await h.seed('recall-declarations');
      const other = ctx.tools.register(defineTool({ name: 'recall_test_other', description: 'ordinary isolated tool', parameters: {}, output: { schema: { type: 'boolean' }, render: (_, v) => [{ type: 'text', text: String(v) }] }, execute: async () => true }));
      try {
        for (let i = 0; i < 2; i++) {
          const [bad] = await h.drive(agent, [{ name: 'recall_search', args: { action: 'search', mode: 'wrong', patterns: [String(i)] } }], i ? recovery() : human('invalid'));
          assert.equal(bad.value.code, 'invalid_arguments');
        }
        assert.equal(state(agent).closed, true);
        const last = h.model.requests.filter(r => r.sessionId === agent.id).at(-1); assert.equal(last.tools.includes('recall_search'), false); assert.equal(last.tools.includes('recall_read'), false); assert.ok(last.tools.includes('recall_test_other'));
        const count = state(agent).actualCalls; const [normal] = await h.drive(agent, [{ name: 'recall_test_other', args: {} }]); assert.equal(normal.value, true); assert.equal(state(agent).actualCalls, count);
        const index = h.model.requests.length; const fresh = await h.search(agent, human('继续')); assert.equal(fresh.value.status, 'ok'); assert.equal(fresh.value.budget.shared_remaining, 11);
        assert.ok(h.model.requests[index].tools.includes('recall_search')); assert.ok(h.model.requests[index].tools.includes('recall_read'));
      } finally { await other(); }
    });
    await check('invalid attachment selection is explicit and changing an unrelated valid ref cannot bypass repeated-invalid closure', async () => {
      const { agent } = await h.seed('recall-attachment-target', ['needle first', 'needle second']);
      const found = (await h.search(agent)).value;
      for (const item of found.items) {
        const [result] = await h.drive(agent, [{ name: 'recall_read', args: { action: 'read', target: 'both', ref: item.ref, attachments: ['not-loaded'] } }]);
        assert.equal(result.value.code, 'invalid_attachment'); assert.deepEqual(result.value.items, []);
      }
      assert.equal(state(agent).closed, true);
    });
    await check('actual run_code process dispatches product search/read and schema errors are counted; PTC cannot reset closure', async () => {
      const { agent } = await h.seed('recall-ptc'); setSandboxMode(agent.session, 'read-only'); const native = agent.ctx.tools.presentAs('ptc');
      try {
        const code = 'const s = await tools.recall_search({action:"search",mode:"literal",patterns:["needle"]}); const r = await tools.recall_read({action:"read",ref:s.items[0].ref}); return {status:r.status,readComplete:r.readComplete};';
        const [result] = await h.drive(agent, [{ name: 'run_code', args: { code, description: 'Validate actual recall SDK' } }], human('PTC'));
        assert.equal(result.data.message.isError, false, JSON.stringify(result.data));
        let row = state(agent); assert.equal(row.calls.length, 2); assert.ok(row.calls.every(c => c.kind === 'ptc' && c.state === 'completed')); assert.equal(row.shared, 10);
        for (const event of agent.session.snapshotEvents().filter(e => e.type === 'tool/ptc-dispatch')) {
          const value = JSON.parse(event.data.content[0].text); assert.equal(value.status, 'ok'); assert.deepEqual(event.data.meta.recall.budget, value.budget); evidence.ptc.push({ name: event.data.name, code: value.status, budget: value.budget });
        }
        for (let i = 0; i < 2; i++) await h.drive(agent, [{ name: 'run_code', args: { code: 'return await tools.recall_search({action:"search",mode:"wrong" as any,patterns:["x"]});', description: 'Invalid recall parameters' } }]);
        row = state(agent); assert.equal(row.closed, true); assert.equal(row.calls.length, 4); assert.equal(row.shared, 8);
        const [ordinary] = await h.drive(agent, [{ name: 'run_code', args: { code: 'return 42;', description: 'Ordinary work after recall closed' } }]); assert.equal(ordinary.data.message.isError, false); assert.equal(state(agent).calls.length, 4);
      } finally { native(); }
    });
    await check('R=0 preserves real usable F pages and final delivery withdraws tools even when an unusable F balance remains', async () => {
      const { agent } = await h.seed('recall-free-only', Array.from({ length: 8 }, (_, i) => `needle ${i} ` + 'x'.repeat(900)));
      const first = (await h.search(agent)).value; assert.ok(first.nextCursor);
      for (let i = 0; i < 11; i++) assert.equal((await h.read(agent, first.items[0].ref)).value.status, 'ok');
      assert.equal(state(agent).shared, 0); assert.ok(ctx.tools.schemas(agent).some(t => t.name === 'recall_search')); assert.equal(ctx.tools.schemas(agent).some(t => t.name === 'recall_read'), false);
      const next = (await h.next(agent, first.nextCursor)).value; assert.equal(next.status, 'ok'); assert.equal(next.nextCursor, undefined); assert.equal(next.budget.query_pages_remaining, 1); assert.deepEqual(next.allowed_actions, []);
      assert.equal(ctx.tools.schemas(agent).some(t => t.name === 'recall_search'), false);
    });
    await check('concurrent last-R product calls preserve the last valid result and authorize only one body', async () => {
      const { agent } = await h.seed('recall-last-r', Array.from({ length: 4 }, () => 'needle ' + 'x'.repeat(900)));
      const first = (await h.search(agent)).value;
      for (let i = 0; i < 10; i++) await h.read(agent, first.items[0].ref);
      const results = await h.drive(agent, [1, 2].map(() => ({ name: 'recall_read', args: { action: 'read', ref: first.items[0].ref } })));
      assert.equal(results.filter(r => r.value?.status === 'ok').length, 1, JSON.stringify(results.map(r => r.data)));
      assert.equal(results.filter(r => r.value?.code === 'shared_exhausted').length, 1); assert.equal(state(agent).shared, 0);
    });
    await check('real lowered/disabled/unknown spill policies preserve full bounded JSON; unknown policy starts no history action', async () => {
      const { agent } = await h.seed('recall-spill', ['needle ' + '中文😀'.repeat(4500)]);
      const original = [...ctx.registry.get(spill).fibers].find(f => f.state === 2); await original.dispose();
      let active = await ctx.plugin(spill, { maxInlineTokens: 1600 });
      try {
        const found = await h.search(agent); assert.equal(found.value.status, 'ok'); assert.ok(renderedTokens(found.value) <= 1280);
        const read = await h.read(agent, found.value.items[0].ref); assert.equal(read.value.status, 'ok'); assert.ok(read.value.nextCursor); assert.ok(renderedTokens(read.value) <= 1280);
        await active.dispose();
        const disabled = await h.search(agent, human('disabled policy')); assert.equal(disabled.value.status, 'ok'); assert.ok(renderedTokens(disabled.value) <= 2000);
        active = await ctx.plugin({ name: 'spill-policy', apply() {} });
        let reads = 0; const raw = ctx.recallHistory.withSnapshot.bind(ctx.recallHistory), undo = replace(ctx.recallHistory, 'withSnapshot', (...args) => { reads++; return raw(...args); });
        try { const bad = await h.search(agent, human('unknown policy')); assert.equal(bad.data.message.isError, true); assert.equal(bad.data.error.code, 'configuration_unknown'); assert.equal(reads, 0); }
        finally { undo(); }
      } finally { await active.dispose(); await ctx.plugin(spill, { maxInlineTokens: 12500 }); }
    });
    await check('caller cancellation removes only its preparation waiter and leaves durable accounting and shared work intact', async () => {
      const { agent } = await h.seed('recall-cancel'); const entered = deferred(), release = deferred();
      const raw = ctx.recallHistory.withSnapshot.bind(ctx.recallHistory);
      const undo = replace(ctx.recallHistory, 'withSnapshot', async (id, ...args) => { if (id === agent.id) { entered.resolve(); await release.promise; } return raw(id, ...args); });
      try {
        const pending = h.drive(agent, [{ name: 'recall_search', args: { action: 'search', mode: 'literal', patterns: ['needle'] } }], human('cancel preparation'), false);
        await entered.promise; agent.cancel({ kind: 'user' }); const [cancelled] = await pending;
        assert.equal(cancelled.data.message.isError, true); assert.equal(cancelled.data.error.code, 'ABORTED'); assert.equal(ctx.recallPreparation.status(agent.id).waiters, 0); assert.equal(state(agent).shared, 11);
        release.resolve(); await ctx.recallPreparation.wait(agent.id, AbortSignal.timeout(5000));
      } finally { release.resolve(); undo(); }
    });
    await check('worker file recovery needs no recall reload, retains failed charge and leaves original text reads available', async () => {
      const { agent } = await h.seed('recall-worker-recovery');
      const ref = (await h.search(agent)).value.items[0].ref;
      const search = ctx.recallTools.search, path = join(process.cwd(), 'repaired-worker.exe'), matcher = new NativeMatcher(path);
      const restore = replace(search, 'matcher', matcher);
      try {
        const failed = await h.search(agent, human('worker missing')); assert.equal(failed.value.code, 'worker_unavailable');
        assert.equal(state(agent).shared, 11); assert.equal(state(agent).searches, 5);
        assert.equal((await h.read(agent, ref)).value.status, 'ok'); assert.equal(state(agent).shared, 10);
        await copyFile(new URL('../../lib/native/worker.exe', import.meta.url), path);
        const recovered = await h.search(agent, recovery()); assert.equal(recovered.value.status, 'ok');
        assert.equal(state(agent).shared, 9); assert.equal(state(agent).searches, 4); assert.equal(state(agent).actualCalls, 3);
        assert.equal(ctx.recallTools.search, search); assert.equal(search.matcher, matcher); assert.equal(state(agent).closed, false);
      } finally { restore(); await matcher.dispose(); assert.equal(matcher.children.size, 0); }
    });
    }
    if (browserBase) await check('real browser selection A/B/A never overrides background B product search/read ownership', async () => {
      await writeFile('browser-reference.txt', 'B historical file');
      const a = (await h.seed('recall-ui-a', ['needle A original'])).agent, b = (await h.seed('recall-ui-b', ['needle B original @browser-reference.txt'])).agent;
      await ctx.recallAttachments.idleAdmissions();
      await ctx.sessionController.rename({ sessionId: a.id, title: 'Diagnostic fixture A' }); await ctx.sessionController.rename({ sessionId: b.id, title: 'Diagnostic fixture B' });
      const beforeOpen = a.session.seq, modelRequests = h.model.requests.length;
      const { openDiagnosticBrowser } = await import('./diagnostics-browser.mjs'); browser = await openDiagnosticBrowser(ctx, browserBase, { a: a.id, b: b.id });
      assert.ok(ctx.recallPreparation.status(a.id)); assert.equal(a.session.seq, beforeOpen); assert.equal(h.model.requests.length, modelRequests);
      const entered = deferred(), release = deferred(), raw = ctx.recallTools.search.matcher.match.bind(ctx.recallTools.search.matcher);
      const undo = replace(ctx.recallTools.search.matcher, 'match', async (...args) => { if (args[0].origin.sessionId === b.id) { entered.resolve(); await release.promise; } return raw(...args); });
      try {
        const pending = h.search(b); await entered.promise; await browser.select(b.id); await browser.select(a.id); release.resolve(); const found = await pending;
        assert.equal(browser.state().view.sessionId, a.id); assert.ok(found.value.items.every(i => ctx.recallReferences.resolve(i.ref, b.id).sessionId === b.id));
        const item = found.value.items[0];
        const [read] = await h.drive(b, [{ name: 'recall_read', args: { action: 'read', ref: item.ref, target: 'both', attachments: item.attachments.map(f => f.ref) } }]);
        assert.match(read.value.items[0].content, /B original/); assert.equal(read.value.attachmentResults[0].path, join(process.cwd(), 'browser-reference.txt'));
        assert.equal(read.value.attachmentResults[0].state, 'accessible'); assert.equal(read.value.attachmentResults[0].contentRead, false);
        assert.equal(browser.state().view.sessionId, a.id); evidence.browser = { ...await browser.finish(), openWithoutMessageOrModel: true, backgroundAttachment: read.value.attachmentResults[0] };
      } finally { release.resolve(); undo(); }
    });
    if (!browserBase) await check('cold/hot component search, match/read time, output overhead, notification latency and process memory are measured', async () => {
      const sample = await h.seed('recall-performance', Array.from({ length: 96 }, (_, i) => `needle ${i}\n` + 'native original 中文😀\n'.repeat(110)));
      const timings = { search: [], matchMs: 0, previewMs: [], read: [], resumeMs: sample.resumeMs };
      const search = ctx.recallTools.search.run.bind(ctx.recallTools.search), page = ctx.recallTools.search.page.bind(ctx.recallTools.search), match = ctx.recallTools.search.matcher.match.bind(ctx.recallTools.search.matcher), read = ctx.recallTools.read.run.bind(ctx.recallTools.read);
      const undos = [replace(ctx.recallTools.search, 'run', async (...args) => { const at = performance.now(); try { return await search(...args); } finally { timings.search.push(performance.now() - at); } }),
        replace(ctx.recallTools.search.matcher, 'match', async (...args) => { const at = performance.now(); try { return await match(...args); } finally { timings.matchMs += performance.now() - at; } }),
        replace(ctx.recallTools.search, 'page', (...args) => { const at = performance.now(); try { return page(...args); } finally { timings.previewMs.push(performance.now() - at); } }),
        replace(ctx.recallTools.read, 'run', async (...args) => { const at = performance.now(); try { return await read(...args); } finally { timings.read.push(performance.now() - at); } })];
      let last = performance.now(), delay = 0, ticks = 0, peakHeap = 0, peakRss = 0;
      const timer = setInterval(() => { const now = performance.now(), memory = process.memoryUsage(); delay = Math.max(delay, now - last - 5); last = now; ticks++; peakHeap = Math.max(peakHeap, memory.heapUsed); peakRss = Math.max(peakRss, memory.rss); }, 5);
      try {
        const cold = (await h.search(sample.agent)).value, coldQuery = state(sample.agent).calls.at(-1).query, matched = timings.matchMs;
        const hot = (await h.search(sample.agent, human('hot cache new interaction'))).value;
        assert.equal(coldQuery, state(sample.agent).calls.at(-1).query); assert.equal(timings.matchMs, matched);
        await h.read(sample.agent, hot.items[0].ref);
        const bodyTokens = estimateContent([{ type: 'text', text: hot.items.map(i => i.content).join('') }]);
        evidence.performance = { ...timings, preparation: ctx.recallPreparation.status(sample.agent.id).timings, pageTokens: renderedTokens(hot), bodyTokens, auxiliaryAndJsonFraction: 1 - bodyTokens / renderedTokens(hot), ticks, notificationExtraDelayMs: delay, sampledPeakHeap: peakHeap, sampledPeakRss: peakRss };
      } finally { clearInterval(timer); undos.reverse().forEach(undo => undo()); }
    });
    if (!browserBase) await check('unload drains an active native body and reload preserves its charge before a legal retry', async () => {
      const { agent } = await h.seed('recall-unload'); const found = (await h.search(agent)).value;
      const object = ctx.recallTools.read, raw = object.run.bind(object), entered = deferred();
      const undo = replace(object, 'run', async (request, exec, reservation, timeline) => {
        if (exec.agent.id !== agent.id) return raw(request, exec, reservation, timeline);
        entered.resolve(); await new Promise(resolve => timeline.signal.addEventListener('abort', resolve, { once: true })); timeline.check();
      });
      try {
        const pending = h.read(agent, found.items[0].ref); await entered.promise;
        await [...ctx.loader.entries()].find(e => e.options.id === 'recall').fiber.restart();
        const interrupted = await pending; assert.ok(interrupted.value, JSON.stringify(interrupted.data)); assert.equal(interrupted.value.code, 'recall_unloaded'); assert.equal(state(agent).shared, 10);
        const retry = await h.read(agent, found.items[0].ref); assert.equal(retry.value.status, 'ok'); assert.equal(state(agent).shared, 9);
      } finally { undo(); }
    });
    if (!browserBase) for (const mode of ['native', 'ptc']) await check(`missing timeout policy rejects admission; ${mode} recovers in the same interaction without reload or a ledger bypass`, async () => {
      const { agent } = await h.seed(`recall-timeout-policy-${mode}`);
      setSandboxMode(agent.session, 'read-only');
      const unmount = mode === 'ptc' ? agent.ctx.tools.presentAs('ptc') : () => {};
      const invoke = async input => {
        if (mode === 'native') return h.search(agent, input);
        await h.drive(agent, [{ name: 'run_code', args: { code: 'return await tools.recall_search({action:"search",mode:"literal",patterns:["needle"]});', description: 'Recall after policy recovery' } }], input);
        const event = agent.session.snapshotEvents().findLast(e => e.type === 'tool/ptc-dispatch' && e.data.name === 'recall_search');
        return { data: event.data, value: event.data.isError ? undefined : JSON.parse(event.data.content[0].text), event };
      };
      const search = ctx.recallTools.search;
      await [...ctx.registry.get(timeoutPolicy).fibers].find(f => f.state === 2).dispose();
      let fresh;
      try {
        const absent = await invoke(human('policy unavailable')); assert.equal(absent.data.error.code, 'timeout_policy_unavailable'); assert.equal(state(agent), undefined);
        const identity = currentInteraction(agent.session);
        fresh = await ctx.plugin(timeoutPolicy);
        if (mode === 'native') {
          const replay = await ctx.tools.execute({ name: 'recall_search', callId: absent.data.message.toolCallId,
            arguments: { action: 'search', mode: 'literal', patterns: ['needle'] }, agent, signal: new AbortController().signal });
          assert.equal(replay.error.info.code, 'ledger_missing'); assert.equal(state(agent), undefined);
        }
        const reordered = await invoke(recovery()); assert.equal(reordered.value?.status, 'ok', JSON.stringify(reordered)); assert.equal(state(agent).shared, 11);
        assert.deepEqual(currentInteraction(agent.session), identity); assert.equal(state(agent).actualCalls, 1);
        assert.equal(ctx.recallTools.search, search);
        const before = state(agent), table = ctx.recallBudget.table, get = table.get.bind(table);
        const restore = replace(table, 'get', key => { const row = get(key); return row?.sessionId === agent.id ? undefined : row; });
        try {
          assert.equal((await invoke(recovery())).data.error.code, 'ledger_missing');
        } finally { restore(); }
        assert.deepEqual(state(agent), before);
      } finally { unmount(); if (!fresh) await ctx.plugin(timeoutPolicy); }
    });
    if (!browserBase) await check('a separately loaded scoped native timeout policy admits only its executing agent', async () => {
      const { agent } = await h.seed('recall-policy-copy');
      const { agent: other } = await h.seed('recall-policy-other');
      const copy = await import(import.meta.resolve('@deepseek-ai/dsh-tool-call-timeout-policy') + '?recall-copy');
      assert.notEqual(copy.apply, timeoutPolicy.apply);
      await [...ctx.registry.get(timeoutPolicy).fibers].find(f => f.state === 2).dispose();
      const scope = createScope(ctx, agent);
      try {
        await scope.ctx.plugin(copy);
        assert.equal((await h.search(agent)).value.status, 'ok');
        assert.equal((await h.search(other)).data.error.code, 'timeout_policy_unavailable');
        assert.equal(state(other), undefined);
        setSandboxMode(agent.session, 'read-only');
        const undo = agent.ctx.tools.presentAs('ptc');
        try {
          const [result] = await h.drive(agent, [{ name: 'run_code', args: { code: 'return await tools.recall_search({action:"search",mode:"literal",patterns:["needle"]});', description: 'Scoped policy copy' } }], human('PTC policy copy'));
          assert.equal(result.data.message.isError, false);
          assert.equal(state(agent).actualCalls, 1);
          assert.equal(state(agent).calls[0].state, 'completed');
        } finally { undo(); }
      } finally { await scope.dispose(); await ctx.plugin(timeoutPolicy); }
    });
    for (const handle of h.agents) { await ctx.sessions.flush(handle.agent.session); const stored = await ctx.sessionPersistence.open(handle.agent.id, 'read'); try { await stored.read(); } finally { await stored.close(); } }
  } finally { await browser?.close(); await h.dispose(); }
  const output = join(process.env.DSH_HOME, '..', 'recall-evidence.json'); await writeFile(output, JSON.stringify(evidence, null, 2)); console.log(`Product recall evidence: ${output}`);
}
