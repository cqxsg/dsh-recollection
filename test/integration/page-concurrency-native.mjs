import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy';
import { currentInteraction } from '../../lib/index.js';
import { recallHarness } from '../../support/fixtures/recall-harness.mjs';
import { human, recovery } from '../../support/fixtures/scripted-model.mjs';
import { deferred, replace } from '../../support/fixtures/control.mjs';

const bodies = () => Array.from({ length: 18 }, (_, i) => `needle ${i} ` + '中文😀'.repeat(170));
export async function verifyPageConcurrency(ctx) {
  const h = recallHarness(ctx), cases = [], timing = [];
  const check = async (label, run) => { await run(); cases.push(label); console.log(`PASS: ${label}`); };
  const state = agent => ctx.recallBudget.state(currentInteraction(agent.session));
  const call = (name, cursor) => ({ name, args: { action: 'next', cursor } });
  async function parallel(agent, name, cursor, count = 2, ptc = false) {
    const engine = name === 'recall_search' ? ctx.recallTools.search : ctx.recallTools.read;
    const raw = engine.run.bind(engine), gate = deferred(); let bodiesEntered = 0, timedOut = false;
    const undo = replace(engine, 'run', async (request, exec, ...rest) => {
      if (exec.agent.id === agent.id && request.action === 'next' && request.cursor === cursor) { bodiesEntered++; await gate.promise; }
      return raw(request, exec, ...rest);
    });
    const off = ctx.on('tools/execute', async (exec, next) => {
      const result = await next();
      if (exec.agent?.id === agent.id && result.value?.code === 'page_in_flight') gate.resolve();
      return result;
    });
    const timer = setTimeout(() => { timedOut = true; gate.resolve(); }, 5000);
    try {
      let values;
      if (!ptc) values = (await h.drive(agent, Array.from({ length: count }, () => call(name, cursor)))).map(r => r.value);
      else {
        setSandboxMode(agent.session, 'read-only'); const unmount = agent.ctx.tools.presentAs('ptc');
        const before = agent.session.seq;
        try {
          const [result] = await h.drive(agent, [{ name: 'run_code', args: { code: `return await Promise.all(Array.from({length:${count}},()=>tools.${name}({action:"next",cursor:${JSON.stringify(cursor)}})));`, description: 'Concurrent recall continuation' } }]);
          assert.equal(result.data.message.isError, false);
          values = agent.session.snapshotEvents().filter(e => e.seq > before && e.type === 'tool/ptc-dispatch' && e.data.name === name).map(e => JSON.parse(e.data.content[0].text));
        } finally { unmount(); }
      }
      assert.equal(timedOut, false, 'conflict dispatch must finish without waiting for delivery');
      assert.equal(bodiesEntered, 1, 'only one fixed page body runs');
      assert.equal(values.filter(v => v?.status === 'ok').length, 1, JSON.stringify(values));
      assert.ok(values.some(v => v?.code === 'page_in_flight'));
      assert.ok(values.every(v => v.status === 'ok' || ['page_in_flight', 'duplicate_page'].includes(v.code)));
      assert.equal(state(agent).closed, false);
      assert.equal(state(agent).calls.filter(c => c.code === 'page_in_flight').every(c => c.state === 'failed' && !c.invalidKey), true);
      return values;
    } finally { clearTimeout(timer); gate.resolve(); undo(); await off(); }
  }
  const offs = [
    ctx.on('tools/execute', async (exec, next) => { const result = await next(); if (exec.name.startsWith('recall_')) timing.push({ id: exec.callId, phase: 'body' }); return result; }),
    ctx.on('tools/result', exec => { if (exec.name.startsWith('recall_')) timing.push({ id: exec.callId, phase: 'result' }); }),
    ctx.on('session/event', (_session, event) => {
      if (event.type === 'tool/result') timing.push({ id: event.data.message.toolCallId, phase: 'history' });
      if (event.type === 'tool/ptc-dispatch') timing.push({ id: event.data.subCallId, phase: 'history' });
    }),
  ];
  try {
    for (const mode of ['native', 'ptc']) await check(`${mode} body, final result notification and history delivery are separate ordered stages`, async () => {
      const { agent } = await h.seed(`page-timing-${mode}`, bodies());
      const first = (await h.search(agent)).value; assert.ok(first.nextCursor);
      await parallel(agent, 'recall_search', first.nextCursor, 2, mode === 'ptc');
      const row = ctx.recallBudget.state(currentInteraction(agent.session));
      for (const call of row.calls.slice(-2)) assert.deepEqual(timing.filter(t => t.id === call.callId).map(t => t.phase), ['body', 'result', 'history']);
      assert.equal(row.actualCalls, 3); assert.equal(row.queries[0].free, 0);
      assert.equal(row.searches, 5); assert.equal(row.shared, 11); assert.equal(row.paidPages, 0);
      assert.equal((await h.next(agent, first.nextCursor)).value.code, 'duplicate_page');
    });
    await check('multi-call search batches charge every actual call without another F grant or closure', async () => {
      const { agent } = await h.seed('page-multi-search', bodies()), first = (await h.search(agent)).value;
      await parallel(agent, 'recall_search', first.nextCursor, 3);
      assert.equal(state(agent).actualCalls, 4); assert.equal(state(agent).queries[0].free, 0);
      assert.equal(state(agent).shared, 10); assert.equal(state(agent).paidPages, 1); assert.equal(state(agent).searches, 5);
    });
    for (const target of ['text', 'attachments', 'both']) await check(`${target} read continuation admits one body; a new interaction may read the same page`, async () => {
      for (let i = 0; i < 8; i++) await writeFile(`page-file-${i}.txt`, `original ${i}`);
      const text = 'needle ' + 'long history '.repeat(2000) + ' ' + Array.from({ length: 8 }, (_, i) => `@page-file-${i}.txt`).join(' ');
      const { agent } = await h.seed(`page-read-${target}`, [text]);
      const item = (await h.search(agent)).value.items[0];
      const read = ctx.recallTools.read, undo = replace(read, 'config', { ...read.config, readPageTokens: 1000 });
      try {
        const [first] = await h.drive(agent, [{ name: 'recall_read', args: { action: 'read', ref: item.ref, target, ...(target !== 'text' ? { attachments: item.attachments.map(f => f.ref) } : {}) } }]);
        assert.ok(first.value?.nextCursor, JSON.stringify(first));
        await parallel(agent, 'recall_read', first.value.nextCursor, 2, target === 'both');
        assert.equal(state(agent).actualCalls, 4); assert.equal(state(agent).shared, 8);
        assert.equal((await h.drive(agent, [call('recall_read', first.value.nextCursor)]))[0].value.code, 'duplicate_page');
        assert.equal((await h.drive(agent, [call('recall_read', first.value.nextCursor)], human('new interaction')))[0].value.status, 'ok');
        assert.equal(state(agent).shared, 11); assert.equal(state(agent).actualCalls, 1);
      } finally { undo(); }
    });
    for (const failure of ['body', 'blocked', 'replaced', 'cancelled']) await check(`${failure} page is retryable after failure; spent F is retained`, async () => {
      const { agent } = await h.seed(`page-failure-${failure}`, bodies()), first = (await h.search(agent)).value;
      let undo;
      if (failure === 'body') undo = replace(ctx.recallTools.search, 'run', async () => { throw new Error('Injected page execution failure'); });
      else undo = ctx.on('tools/post-execute', async (exec, _result, next) => {
        const decision = await next(); if (exec.agent?.id !== agent.id || exec.name !== 'recall_search') return decision;
        if (failure === 'cancelled') { agent.cancel({ kind: 'user' }); return decision; }
        return failure === 'blocked' ? { kind: 'block', feedback: [{ type: 'text', text: 'Page delivery blocked' }] }
          : { kind: 'accept', content: [{ type: 'text', text: 'Page delivery replaced' }] };
      });
      try {
        const [result] = await h.drive(agent, [call('recall_search', first.nextCursor)], recovery(), failure !== 'cancelled');
        assert.notEqual(result.value?.status, 'ok'); assert.equal(state(agent).queries[0].free, 1); assert.equal(state(agent).closed, false);
      } finally { await undo(); }
      assert.equal((await h.next(agent, first.nextCursor)).value.status, 'ok');
      assert.equal(state(agent).queries[0].free, 0); assert.equal(state(agent).shared, 11); assert.equal(state(agent).actualCalls, 3);
    });
    await check('PTC SDK retry during delayed log gets in-flight; replaced history then permits a paid retry', async () => {
      const { agent } = await h.seed('page-ptc-log', bodies()), first = (await h.search(agent)).value;
      const gate = deferred(); let delayed = false, timedOut = false;
      const timer = setTimeout(() => { timedOut = true; gate.resolve(); }, 5000);
      const log = ctx.on('tools/ptc-dispatch-log', async (dispatch, next) => {
        if (dispatch.agent.id !== agent.id || dispatch.name !== 'recall_search' || delayed) return next();
        delayed = true; await gate.promise; return [{ type: 'text', text: 'Injected omitted page content' }];
      });
      const off = ctx.on('tools/execute', async (exec, next) => { const result = await next(); if (exec.agent?.id === agent.id && result.value?.code === 'page_in_flight') gate.resolve(); return result; });
      setSandboxMode(agent.session, 'read-only'); const unmount = agent.ctx.tools.presentAs('ptc');
      try {
        const args = JSON.stringify({ action: 'next', cursor: first.nextCursor });
        const [result] = await h.drive(agent, [{ name: 'run_code', args: { code: `const a=await tools.recall_search(${args}); const b=await tools.recall_search(${args}); return [a.status,b.code];`, description: 'Retry before page log' } }]);
        assert.equal(result.data.message.isError, false); assert.equal(timedOut, false); assert.ok(delayed);
        assert.equal(state(agent).calls.at(-1).code, 'page_in_flight'); assert.equal(state(agent).closed, false);
      } finally { clearTimeout(timer); gate.resolve(); await log(); await off(); unmount(); }
      assert.equal((await h.next(agent, first.nextCursor)).value.status, 'ok');
      assert.equal(state(agent).actualCalls, 4); assert.equal(state(agent).shared, 10); assert.equal(state(agent).paidPages, 1);
    });
    await check('failed native history append releases the claim at idle and allows a charged retry', async () => {
      const { agent } = await h.seed('page-append-failure', bodies()), first = (await h.search(agent)).value;
      const append = agent.session.append.bind(agent.session); let rejected = 0;
      const undo = replace(agent.session, 'append', (type, ...args) => {
        if (type === 'tool/result') { rejected++; throw new Error('Injected native history append failure'); }
        return append(type, ...args);
      });
      try {
        h.model.replies.push({ sessionId: agent.id, calls: [{ ...call('recall_search', first.nextCursor), id: 'failed-history-page' }] });
        agent.followup(recovery()); await agent.whenIdle();
        assert.equal(rejected, 2, 'both normal append and native recovery append fail'); assert.equal(h.model.replies.some(r => r.sessionId === agent.id), false);
        assert.equal(agent.session.snapshotEvents().some(e => e.type === 'tool/result' && e.data.message.toolCallId === 'failed-history-page'), false);
      } finally { undo(); }
      assert.equal((await h.next(agent, first.nextCursor)).value.status, 'ok');
      assert.equal(state(agent).actualCalls, 3); assert.equal(state(agent).queries[0].free, 0); assert.equal(state(agent).closed, false);
    });
    await check('different sessions execute pages concurrently without sharing claims', async () => {
      const agents = await Promise.all(['a', 'b'].map(async id => {
        const { agent } = await h.seed(`page-session-${id}`, bodies()); return { agent, first: (await h.search(agent)).value };
      }));
      const raw = ctx.recallTools.search.run.bind(ctx.recallTools.search), gate = deferred(); let entered = 0, timedOut = false;
      const undo = replace(ctx.recallTools.search, 'run', async (...args) => { if (args[0].action === 'next') { if (++entered === 2) gate.resolve(); await gate.promise; } return raw(...args); });
      const timer = setTimeout(() => { timedOut = true; gate.resolve(); }, 5000);
      try {
        const results = await Promise.all(agents.map(({ agent, first }) => h.next(agent, first.nextCursor)));
        assert.equal(timedOut, false); assert.equal(entered, 2); assert.ok(results.every(r => r.value.status === 'ok'));
        for (const { agent } of agents) assert.equal(state(agent).actualCalls, 2);
      } finally { clearTimeout(timer); gate.resolve(); undo(); }
    });
    await check('plugin unload drains an executing page claim and retains its charge', async () => {
      const { agent } = await h.seed('page-active-unload', bodies()), first = (await h.search(agent)).value;
      const entered = deferred(), oldMemory = ctx.recallMemory.budget;
      const undo = replace(ctx.recallTools.search, 'run', async (_request, _exec, _reservation, timeline) => {
        entered.resolve(); await new Promise(resolve => timeline.signal.addEventListener('abort', resolve, { once: true })); timeline.check();
      });
      try {
        const pending = h.next(agent, first.nextCursor); await entered.promise;
        await [...ctx.loader.entries()].find(e => e.options.id === 'recall').fiber.restart();
        assert.equal((await pending).value.code, 'recall_unloaded');
        assert.equal(state(agent).actualCalls, 2); assert.equal(state(agent).queries[0].free, 1);
        assert.equal(oldMemory.stats().pins, 0);
        assert.equal((await h.next(agent, first.nextCursor)).value.code, 'stale_reference');
        assert.equal(state(agent).actualCalls, 3); assert.equal(state(agent).shared, 10);
      } finally { undo(); }
    });
    await check('different pages run concurrently and plugin unload expires fixed pages without refreshing quota', async () => {
      const { agent } = await h.seed('page-independent', bodies()), first = (await h.search(agent)).value;
      const second = (await h.next(agent, first.nextCursor)).value; assert.ok(second.nextCursor);
      const raw = ctx.recallTools.search.run.bind(ctx.recallTools.search), gate = deferred(); let entered = 0, timedOut = false;
      const undo = replace(ctx.recallTools.search, 'run', async (...args) => { if (args[1].agent.id === agent.id && args[0].action === 'next') { if (++entered === 2) gate.resolve(); await gate.promise; } return raw(...args); });
      const timer = setTimeout(() => { timedOut = true; gate.resolve(); }, 5000);
      try {
        const results = await h.drive(agent, [first.nextCursor, second.nextCursor].map(c => call('recall_search', c)), human('independent fixed pages'));
        assert.equal(timedOut, false); assert.equal(entered, 2); assert.ok(results.every(r => r.value.status === 'ok'));
      } finally { clearTimeout(timer); gate.resolve(); undo(); }
      const row = state(agent);
      await [...ctx.loader.entries()].find(e => e.options.id === 'recall').fiber.restart();
      assert.deepEqual(state(agent), row);
      assert.equal((await h.next(agent, second.nextCursor)).value.code, 'stale_reference');
      assert.equal(state(agent).actualCalls, row.actualCalls + 1);
    });
  } finally { for (const off of offs) await off(); await h.dispose(); }
  const path = join(process.env.DSH_HOME, '..', 'page-concurrency-evidence.json');
  await writeFile(path, JSON.stringify({ cases, timing }, null, 2)); console.log(`Page concurrency evidence: ${path}`);
}
