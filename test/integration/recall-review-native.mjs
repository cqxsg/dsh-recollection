import assert from 'node:assert/strict';
import { verifyMatchingScheduling } from '../runtime/matching-scheduling-native.mjs';
import { verifyRecallMemory } from '../runtime/memory-native.mjs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy';
import { currentInteraction } from '../../lib/index.js';
import { human, recovery } from '../../support/fixtures/scripted-model.mjs';
import { deferred, replace } from '../../support/fixtures/control.mjs';
import { recallHarness } from '../../support/fixtures/recall-harness.mjs';

export async function verifyRecallReviewSuite(ctx) {
  const h = recallHarness(ctx), cases = [];
  try {
    await verifyRecallReview(ctx, h, async (label, fn) => { await fn(); cases.push(label); console.log(`PASS: ${label}`); });
    const path = join(process.env.DSH_HOME, '..', 'recall-review-evidence.json');
    await writeFile(path, JSON.stringify({ cases, pid: process.pid }, null, 2));
    console.log(`Recall review evidence: ${path}`);
  } finally { await h.dispose(); }
}

/** Review regressions use the ordinary product services and native delivery. */
export async function verifyRecallReview(ctx, h, check) {
  await verifyMatchingScheduling(ctx, h, check);
  await verifyRecallMemory(ctx, h, check);
  const state = agent => ctx.recallBudget.state(currentInteraction(agent.session));
  await check('distinct regex failures stay separate; changing unrelated OR terms does not correct an already explained pattern', async () => {
    const { agent } = await h.seed('review-regex-causes');
    const inputs = [['['], ['(?=needle)'], ['unrelated', '[', 'valid']];
    for (const [index, patterns] of inputs.entries()) {
      const [result] = await h.drive(agent, [{ name: 'recall_search', args: { action: 'search', mode: 'regex', patterns } }], index ? recovery() : human('regex causes'));
      assert.equal(result.value.code, 'invalid_pattern');
      assert.equal(result.value.budget.closed, index === 2);
    }
    assert.equal(state(agent).invalid.length, 2); assert.equal(state(agent).shared, 9);
    assert.equal(ctx.recallTools.search.stats().some(q => q.sessionId === agent.id), false, 'invalid terms never scan or create a query');
  });
  await check('real PTC preserves distinct regex causes and closes only the repeated unchanged invalid condition', async () => {
    const { agent } = await h.seed('review-regex-ptc');
    setSandboxMode(agent.session, 'read-only'); const unmount = agent.ctx.tools.presentAs('ptc');
    try {
      const code = 'const results=[]; for (const patterns of [["["],["(?=needle)"],["unrelated","["]]) results.push(await tools.recall_search({action:"search",mode:"regex",patterns})); return results.map(r=>({code:r.code,closed:r.budget.closed}));';
      const [result] = await h.drive(agent, [{ name: 'run_code', args: { code, description: 'Verify regex error causes' } }], human('PTC regex'));
      assert.equal(result.data.message.isError, false);
      const values = agent.session.snapshotEvents().filter(e => e.type === 'tool/ptc-dispatch' && e.data.name === 'recall_search').map(e => JSON.parse(e.data.content[0].text));
      assert.deepEqual(values.map(v => [v.code, v.budget.closed]), [['invalid_pattern', false], ['invalid_pattern', false], ['invalid_pattern', true]]);
      assert.equal(state(agent).shared, 9);
    } finally { unmount(); }
  });
  const invalid = { action: 'search', mode: 'wrong', patterns: ['needle'] };
  const invalidCall = () => ({ name: 'recall_search', args: invalid });
  for (const mode of ['blocked', 'cancelled']) await check(`${mode} invalid feedback retains charges but cannot close recall before an error is actually delivered`, async () => {
    const { agent } = await h.seed(`review-feedback-${mode}`);
    const off = ctx.on('tools/post-execute', async (exec, result, proceed) => {
      const decision = await proceed();
      if (exec.agent?.id !== agent.id || exec.name !== 'recall_search') return decision;
      if (mode === 'cancelled') { agent.cancel({ kind: 'user' }); return decision; }
      return { kind: 'block', feedback: [{ type: 'text', text: 'Injected result delivery failure' }] };
    });
    try {
      const [first] = await h.drive(agent, [invalidCall()], human('delivery failure'), mode !== 'cancelled');
      assert.notEqual(first.value?.code, 'invalid_arguments');
      assert.equal(state(agent).shared, 11); assert.equal(state(agent).closed, false);
      assert.ok(state(agent).calls[0].invalidKey, 'cause is persisted independently of feedback');
    } finally { await off(); }
    await [...ctx.loader.entries()].find(e => e.options.id === 'recall').fiber.restart();
    const [second] = await h.drive(agent, [invalidCall()]);
    assert.equal(second.value.code, 'invalid_arguments'); assert.equal(second.value.budget.closed, false);
    const [third] = await h.drive(agent, [invalidCall()]);
    assert.equal(third.value.budget.closed, true); assert.equal(state(agent).shared, 9);
  });
  await check('parallel direct invalid calls were decided before either warning; only a later uncorrected request closes recall', async () => {
    const { agent } = await h.seed('review-feedback-parallel');
    const results = await h.drive(agent, [invalidCall(), invalidCall()], human('parallel invalid'));
    assert.deepEqual(results.map(r => r.value.budget.closed), [false, false]);
    assert.equal(state(agent).shared, 10);
    assert.equal((await h.drive(agent, [invalidCall()]))[0].value.budget.closed, true);
  });
  await check('real PTC retries a replaced error and receives its first correction before repeat closure', async () => {
    const { agent } = await h.seed('review-feedback-ptc-hidden');
    setSandboxMode(agent.session, 'read-only'); const unmount = agent.ctx.tools.presentAs('ptc');
    let seen = 0;
    const off = ctx.on('tools/post-execute', async (exec, result, proceed) => {
      const decision = await proceed();
      if (exec.agent?.id !== agent.id || exec.name !== 'recall_search' || ++seen !== 1) return decision;
      return { kind: 'block', feedback: [{ type: 'text', text: 'Injected PTC delivery failure' }] };
    });
    try {
      const code = 'const results=[]; for(let i=0;i<3;i++){try{results.push(await tools.recall_search({action:"search",mode:"wrong" as any,patterns:["needle"]}));}catch(e){results.push(String(e));}} return results;';
      const [result] = await h.drive(agent, [{ name: 'run_code', args: { code, description: 'Verify PTC feedback delivery' } }], human('PTC delivery'));
      assert.equal(result.data.message.isError, false);
      const events = agent.session.snapshotEvents().filter(e => e.type === 'tool/ptc-dispatch' && e.data.name === 'recall_search');
      assert.equal(events.length, 3); assert.match(events[0].data.content[0].text, /Injected PTC delivery failure/);
      assert.deepEqual(events.slice(1).map(e => JSON.parse(e.data.content[0].text).budget.closed), [false, true]);
      assert.equal(state(agent).shared, 9);
    } finally { await off(); unmount(); }
  });
  await check('parallel PTC requests do not count future feedback but a sequential SDK retry does', async () => {
    const { agent } = await h.seed('review-feedback-ptc-parallel');
    setSandboxMode(agent.session, 'read-only'); const unmount = agent.ctx.tools.presentAs('ptc');
    const both = deferred(); let seen = 0;
    // Post-execute finalization is ordered by the native PTC commit lane;
    // rendezvous in the overlapping execution bodies instead.
    const off = ctx.on('tools/execute', async (exec, proceed) => {
      const result = await proceed();
      if (exec.agent?.id === agent.id && exec.name === 'recall_search' && ++seen <= 2) {
        if (seen === 2) both.resolve();
        await both.promise;
      }
      return result;
    });
    try {
      const code = 'const args={action:"search" as const,mode:"wrong" as any,patterns:["needle"]}; const first=await Promise.all([tools.recall_search(args),tools.recall_search(args)]); const last=await tools.recall_search(args); return {first,last};';
      const [result] = await h.drive(agent, [{ name: 'run_code', args: { code, description: 'Verify parallel PTC feedback' } }], human('PTC parallel'));
      assert.equal(result.data.message.isError, false);
      const values = agent.session.snapshotEvents().filter(e => e.type === 'tool/ptc-dispatch' && e.data.name === 'recall_search').map(e => JSON.parse(e.data.content[0].text));
      assert.deepEqual(values.map(v => v.budget.closed), [false, false, true]); assert.equal(state(agent).shared, 9);
    } finally { both.resolve(); await off(); unmount(); }
  });
  await check('budget denial also requires delivered feedback before repeated-invalid closure', async () => {
    const { agent } = await h.seed('review-feedback-denied', Array.from({ length: 8 }, () => 'needle ' + 'x'.repeat(900)));
    for (let i = 0; i < 6; i++) assert.equal((await h.search(agent, i ? recovery() : human('exhaust S'), ['needle', `variant-${i}`])).value.status, 'ok');
    assert.equal(state(agent).searches, 0); assert.equal(state(agent).shared, 6);
    const off = ctx.on('tools/post-execute', async (exec, result, proceed) => {
      const decision = await proceed(); return exec.agent?.id === agent.id && exec.name === 'recall_search'
        ? { kind: 'block', feedback: [{ type: 'text', text: 'Injected denial delivery failure' }] } : decision;
    });
    try { await h.search(agent, recovery(), ['new']); } finally { await off(); }
    const next = (await h.search(agent, recovery(), ['new'])).value;
    assert.equal(next.code, 'search_exhausted'); assert.equal(next.budget.closed, false);
    assert.equal((await h.search(agent, recovery(), ['new'])).value.budget.closed, true);
    assert.equal(state(agent).shared, 6); assert.equal(state(agent).actualCalls, 9);
  });
  const bodies = () => Array.from({ length: 30 }, (_, i) => `needle ${i < 6 ? 'subset ' : ''}${i} ` + 'x'.repeat(900));
  const visible = agent => ctx.tools.schemas(agent).map(t => t.name);
  await check('read results advertise free and paid search continuation until the interaction-wide paid-page cap', async () => {
    const { agent } = await h.seed('review-actions-paid', bodies());
    let page = (await h.search(agent)).value; const ref = page.items[0].ref;
    assert.ok(page.allowed_actions.includes('search_next')); assert.equal(page.budget.query_pages_remaining, 2);
    assert.ok((await h.read(agent, ref)).value.allowed_actions.includes('other_query_next'));
    for (let i = 0; i < 2; i++) page = (await h.next(agent, page.nextCursor)).value;
    assert.equal(page.budget.query_pages_remaining, 0); assert.ok(page.nextCursor); assert.ok(page.allowed_actions.includes('search_next'));
    const read = (await h.read(agent, ref)).value;
    assert.ok(read.allowed_actions.includes('other_query_next')); assert.equal(read.budget.paid_pages_remaining, 2);
    assert.ok(visible(agent).includes('recall_search'));
    const before = state(agent).shared;
    for (let i = 0; i < 2; i++) {
      page = (await h.next(agent, page.nextCursor)).value;
      assert.equal(page.status, 'ok'); assert.equal(page.budget.shared_remaining, before - i - 1);
      assert.equal(page.allowed_actions.includes('search_next'), i === 0);
    }
    assert.ok(page.nextCursor, 'usable cursor may outlive its current paid allowance');
    assert.equal((await h.read(agent, ref)).value.allowed_actions.includes('other_query_next'), false);
  });
  await check('multiple queries expose both continuations; exhausted cursors and R=0 remove impossible actions and tools', async () => {
    const { agent } = await h.seed('review-actions-multiple', bodies());
    let first = (await h.search(agent)).value;
    for (let i = 0; i < 2; i++) first = (await h.next(agent, first.nextCursor)).value;
    assert.equal(first.budget.query_pages_remaining, 0); assert.ok(first.nextCursor);
    let second = (await h.search(agent, recovery(), ['subset'])).value;
    const ref = second.items[0].ref;
    assert.ok(second.nextCursor); assert.ok(second.allowed_actions.includes('search_next')); assert.ok(second.allowed_actions.includes('other_query_next'));
    let pages = 0;
    while (second.nextCursor) { assert.ok(++pages < 6); second = (await h.next(agent, second.nextCursor)).value; assert.equal(second.status, 'ok'); }
    assert.equal(second.allowed_actions.includes('search_next'), false);
    assert.ok(second.allowed_actions.includes('other_query_next'), 'another query can still use paid pages');
    assert.ok(visible(agent).includes('recall_search'));
    let read;
    while (state(agent).shared > 0) read = (await h.read(agent, ref)).value;
    assert.deepEqual(read.allowed_actions, []); assert.equal(state(agent).closed, false);
    assert.equal(read.message.match(/no usable recall budget/g)?.length, 1, 'page sizing and final rendering do not duplicate the notice');
    assert.doesNotMatch(read.message, /Shared budget exhausted|undisplayed|not verified/i, 'final state replaces any provisional quota notice');
    assert.equal(visible(agent).includes('recall_search'), false); assert.equal(visible(agent).includes('recall_read'), false);
  });
  await check('lost search cursors cannot be advertised from a durable free grant after reload', async () => {
    const { agent } = await h.seed('review-actions-lost', bodies());
    const first = (await h.search(agent)).value, ref = first.items[0].ref;
    await [...ctx.loader.entries()].find(e => e.options.id === 'recall').fiber.restart();
    const read = (await h.read(agent, ref)).value;
    assert.equal(read.status, 'ok'); assert.equal(state(agent).queries[0].free, 2);
    assert.equal(read.allowed_actions.includes('other_query_next'), false);
    while (state(agent).shared > 0) await h.read(agent, ref);
    assert.equal(visible(agent).includes('recall_search'), false);
  });
  await check('failed page execution leaves its cursor advertised for a legal retry', async () => {
    const { agent } = await h.seed('review-actions-retry', bodies());
    const first = (await h.search(agent)).value;
    const restore = replace(ctx.recallTools.search, 'run', async () => { throw new Error('Injected page failure'); });
    try {
      const failed = (await h.next(agent, first.nextCursor)).value;
      assert.equal(failed.code, 'execution_failed'); assert.ok(failed.allowed_actions.includes('search_next'));
    } finally { restore(); }
    const retry = (await h.next(agent, first.nextCursor)).value;
    assert.equal(retry.status, 'ok'); assert.ok(retry.nextCursor); assert.equal(retry.budget.query_pages_remaining, 0);
  });
}
