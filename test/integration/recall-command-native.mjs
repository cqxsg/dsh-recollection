import assert from 'node:assert/strict';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy';
import { currentInteraction, classifyHistoryRange } from '../../lib/index.js';
import { human } from '../../support/fixtures/scripted-model.mjs';
import { deferred, replace } from '../../support/fixtures/control.mjs';

const marker = '[/recall request';
const textOf = message => message.content.filter(b => b.type === 'text').map(b => b.text).join('');
export const commandInputs = agent => agent.session.snapshotEvents().filter(e => e.type === 'user/message' && textOf(e.data).startsWith(marker));
export const executeRecall = (ctx, agent, raw = '', signal = new AbortController().signal, attachments = []) => ctx.commands.execute(agent, `/recall${raw}`, attachments, signal);

export async function verifyRecallCommand(ctx, h, evidence, check) {
  const { agent } = await h.seed('command-native');
  const events = a => a.session.snapshotEvents();
  const state = a => ctx.recallBudget.state(currentInteraction(a.session));
  const result = (a, id) => {
    const e = events(a).findLast(e => e.type === 'tool/result' && e.data.message.toolCallId === id);
    assert.ok(e, `native tool result ${id}`);
    let value;
    if (!e.data.message.isError) { try { value = JSON.parse(e.data.message.content[0].text); } catch {} }
    return { ...e.data, value };
  };
  const search = id => ({ id, name: 'recall_search', args: { action: 'search', mode: 'literal', patterns: ['needle'] } });
  const reply = (a, calls, extra = {}) => h.model.replies.push({ sessionId: a.id, ...(calls ? { calls } : {}), ...extra });
  async function finish(a) {
    await a.whenIdle(); await ctx.sessions.flush(a.session);
    assert.equal(h.model.replies.some(r => r.sessionId === a.id), false, 'planned native requests consumed');
  }
  let ref;
  await check('bare command admits one marked user request and delivers native search/read evidence', async () => {
    const descriptor = ctx.commands.find(agent, 'recall');
    assert.ok(descriptor.input.hint); assert.notEqual(descriptor.input.attachments, true);
    const before = currentInteraction(agent.session);
    reply(agent, [search('command-search')]);
    reply(agent, [{ id: 'command-read', name: 'recall_read', args: { action: 'read', get ref() { return result(agent, 'command-search').value.items[0].ref; } } }]);
    reply(agent);
    assert.deepEqual((await executeRecall(ctx, agent)).result, { kind: 'success' });
    await finish(agent);
    const inputs = commandInputs(agent); assert.equal(inputs.length, 1);
    assert.equal(inputs[0].data.source.kind, 'user');
    assert.deepEqual(inputs[0].data.source.dshRecollection, { type: 'recall', userInput: '' });
    assert.ok(agent.session.surface.nodes.includes(inputs[0].seq), 'complete model input remains in native history');
    assert.match(textOf(inputs[0].data), /do not use the recall tools\. Ask the user for clarification/);
    assert.notEqual(currentInteraction(agent.session).interactionId, before?.interactionId);
    assert.equal(currentInteraction(agent.session).interactionId, inputs[0].data.id);
    const found = result(agent, 'command-search').value; ref = found.items[0].ref;
    assert.equal(found.totalHits, 1); assert.equal(result(agent, 'command-read').value.readComplete, true);
    assert.equal(state(agent).shared, state(agent).limits.shared - 2);
    assert.ok(JSON.stringify(evidence.requests.at(-1).messages).includes('needle original'));
    assert.equal(events(agent).filter(e => e.type === 'command/done').at(-1).data.text, undefined);
    assert.equal(events(agent).filter(e => e.type === 'assistant/message').some(e => textOf(e.data.message).length), false, 'plugin emits no narration');
    const range = await ctx.recallHistory.withSnapshot(agent.id, cut => classifyHistoryRange(cut, ctx.sessions.messageProjections));
    assert.ok(range.sources.every(source => !events(agent)[source.seq].type.startsWith('command/')), 'command lifecycle is not historical evidence');
  });
  await check('whitespace chooses the bare template; multiline and long targets remain intact', async () => {
    const inputs = [' \t\r\n ', '  中文目标\nE:\\work\\a+b.ts [x].*  ', '\n' + '保留原文😀 x.* '.repeat(1800) + '\n  '];
    for (const raw of inputs) {
      reply(agent);
      await executeRecall(ctx, agent, raw); await finish(agent);
      const message = commandInputs(agent).at(-1).data, text = textOf(message);
      assert.equal(message.source.kind, 'user');
      assert.deepEqual(message.source.dshRecollection, { type: 'recall', userInput: raw.trim() ? raw : '' });
      if (raw.trim()) {
        assert.ok(text.includes(`User-requested recall target:\n${raw}\n\nFollow the user's specified recall target.`));
        assert.ok(!text.includes('infer a useful recall target'));
      }
      else assert.equal(text, textOf(commandInputs(agent)[0].data));
      assert.equal(events(agent).filter(e => e.type === 'command/run').at(-1).data.args, raw);
      assert.equal(events(agent).filter(e => e.type === 'tool/call').length, 2, 'handler did not pre-execute a search');
    }
  });
  await check('reliable reference can be read directly and model-owned narration is allowed', async () => {
    reply(agent, [{ id: 'command-direct-read', name: 'recall_read', args: { action: 'read', ref } }], { text: 'I will check that historical constraint.' }); reply(agent);
    await executeRecall(ctx, agent, ' Check the earlier constraint'); await finish(agent);
    assert.equal(result(agent, 'command-direct-read').value.status, 'ok');
    assert.deepEqual(state(agent).calls.map(c => c.name), ['recall_read']);
    assert.ok(events(agent).filter(e => e.type === 'assistant/message').some(e => textOf(e.data.message).includes('I will check that historical constraint.')));
  });
  await check('pre-cancelled and attachment-bearing commands deliver no input or budget', async () => {
    const count = commandInputs(agent).length, before = state(agent);
    await assert.rejects(executeRecall(ctx, agent, ' cancelled', AbortSignal.abort(new Error('command cancelled'))), /command cancelled/);
    const attached = await executeRecall(ctx, agent, '', undefined, [{ type: 'file', receiptId: 'not-admitted' }]);
    assert.equal(attached.result.kind, 'error'); assert.match(attached.result.text, /does not accept attachments/);
    assert.equal(commandInputs(agent).length, count); assert.deepEqual(state(agent), before);
  });
  await check('submission failure and a no-longer-registered receiver are truthful failures', async () => {
    const count = commandInputs(agent).length, before = state(agent);
    const restore = replace(agent, 'steer', () => { throw new Error('Injected inbox admission failure'); });
    try { await assert.rejects(executeRecall(ctx, agent), /Injected inbox admission failure/); } finally { restore(); }
    assert.equal(events(agent).filter(e => e.type === 'command/done').at(-1).data.kind, 'error');
    const get = ctx.agents.get.bind(ctx.agents);
    const restoreGet = replace(ctx.agents, 'get', id => id === agent.id ? undefined : get(id));
    try { assert.equal((await executeRecall(ctx, agent)).result.kind, 'error'); } finally { restoreGet(); }
    assert.equal(commandInputs(agent).length, count); assert.deepEqual(state(agent), before);
  });
  await check('multiple queued commands allocate nothing until one native step admits them in order', async () => {
    const { agent: a } = await h.seed('command-batch'), gate = deferred();
    const maintenance = a.runMaintenance(() => gate.promise), before = currentInteraction(a.session);
    try {
      await executeRecall(ctx, a, ' first'); await executeRecall(ctx, a, ' second');
      assert.equal(commandInputs(a).length, 0); assert.deepEqual(currentInteraction(a.session), before);
      assert.equal(ctx.recallBudget.records().filter(r => r.sessionId === a.id).length, 0);
      assert.equal(a.inbox.nextStep.length, 2);
      const ids = a.inbox.nextStep.map(m => m.id); assert.equal(new Set(ids).size, 2);
      reply(a, [search('command-batch-search')]); reply(a); gate.resolve(); await maintenance; await finish(a);
      assert.deepEqual(commandInputs(a).map(e => e.data.id), ids);
      assert.equal(currentInteraction(a.session).interactionId, ids[0]);
      assert.equal(ctx.recallBudget.records().filter(r => r.sessionId === a.id).length, 1);
      assert.equal(state(a).shared, state(a).limits.shared - 1);
      evidence.batchedInputs = ids;
    } finally { gate.resolve(); await maintenance; }
  });
  async function withGate(label, fn) {
    const { agent: a } = await h.seed(label), entered = deferred(), release = deferred();
    const off = ctx.tools.register(defineTool({ name: 'command_wait', description: 'Test native steering boundary', parameters: {},
      output: { schema: { type: 'boolean' }, render: (_, value) => [{ type: 'text', text: String(value) }] },
      execute: async (_, exec) => { entered.resolve(); await Promise.race([release.promise, new Promise(resolve => exec.signal.addEventListener('abort', resolve, { once: true }))]); exec.signal.throwIfAborted(); return true; } }));
    try { await fn(a, entered, release); } finally { release.resolve(); await a.whenIdle(); await off(); }
  }
  await check('running steering preserves interaction and remaining budget without interrupting the tool', () => withGate('command-running', async (a, entered, release) => {
    reply(a, [search('running-search')]); reply(a, [{ id: 'running-gate', name: 'command_wait', args: {} }]);
    reply(a, [{ id: 'running-read', name: 'recall_read', args: { action: 'read', get ref() { return result(a, 'running-search').value.items[0].ref; } } }]); reply(a);
    a.followup(human('Continue the current task')); await entered.promise;
    const before = currentInteraction(a.session), budget = state(a), rpc = new AbortController();
    assert.equal((await executeRecall(ctx, a, ' verify the constraint', rpc.signal)).result.kind, 'success');
    rpc.abort(); // The completed UI request does not own the agent's activity.
    assert.equal(a.status, 'running'); assert.equal(commandInputs(a).length, 0); assert.deepEqual(state(a), budget);
    release.resolve(); await finish(a);
    assert.deepEqual(currentInteraction(a.session), before); assert.equal(state(a).shared, budget.shared - 1);
    assert.equal(result(a, 'running-gate').message.isError, false);
  }));
  await check('running recall cannot reset exhausted budget; a later idle request gets its native new interaction', () => withGate('command-exhausted', async (a, entered, release) => {
    reply(a, [search('exhaust-1')]); reply(a, [search('exhaust-2')]); reply(a, [search('exhaust-3')]);
    reply(a, [{ id: 'exhaust-gate', name: 'command_wait', args: {} }]); reply(a, [search('exhaust-denied')]); reply(a);
    a.followup(human('Use the available recall budget')); await entered.promise;
    const before = currentInteraction(a.session); assert.equal(state(a).shared, 0);
    await executeRecall(ctx, a); release.resolve(); await finish(a);
    assert.deepEqual(currentInteraction(a.session), before); assert.equal(state(a).shared, 0);
    assert.equal(result(a, 'exhaust-denied').message.isError, true);
    reply(a, [search('fresh-search')]); reply(a); await executeRecall(ctx, a); await finish(a);
    assert.notEqual(currentInteraction(a.session).interactionId, before.interactionId); assert.equal(state(a).shared, 2);
  }));
  await check('agent cancellation discards pending command and later work does not resend it', () => withGate('command-cancel', async (a, entered, release) => {
    reply(a, [{ id: 'cancel-gate', name: 'command_wait', args: {} }]);
    a.followup(human('An ongoing task')); await entered.promise;
    await executeRecall(ctx, a, ' pending cancellation'); const pendingId = a.inbox.nextStep[0].id;
    a.cancel({ kind: 'user' }); release.resolve(); await finish(a);
    assert.equal(a.inbox.nextStep.length, 0); assert.equal(commandInputs(a).length, 0);
    reply(a); a.followup(human('ordinary follow-up')); await finish(a);
    assert.equal(events(a).filter(e => e.type === 'user/message' && e.data.id === pendingId).length, 0);
    evidence.cancelledMessageId = pendingId;
  }));
  await check('native pre-step rejection removes claimed input without admission, budget allocation or plugin replay', async () => {
    const { agent: a } = await h.seed('command-rejected');
    const reject = a.ctx.on('agent/pre-step', async () => ({ kind: 'reject' }));
    const before = currentInteraction(a.session);
    try { assert.equal((await executeRecall(ctx, a)).result.kind, 'success'); await a.whenIdle(); } finally { await reject(); }
    assert.equal(commandInputs(a).length, 0); assert.deepEqual(currentInteraction(a.session), before);
    assert.equal(a.inbox.nextStep.length, 0);
    assert.equal(ctx.recallBudget.records().filter(r => r.sessionId === a.id).length, 0);
    reply(a); a.followup(human('Wake the native inbox')); await finish(a);
    assert.equal(commandInputs(a).length, 0);
    evidence.rejectedStep = { admitted: false, retainedInInbox: false, replayed: false };
  });
  await check('provider failure does not resend the accepted command or add it to later requests', async () => {
    const { agent: a } = await h.seed('command-provider-failure');
    reply(a, undefined, { error: true });
    await executeRecall(ctx, a, ' fail once'); await finish(a);
    assert.equal(commandInputs(a).length, 1); const id = commandInputs(a)[0].data.id;
    reply(a); a.followup(human('ordinary follow-up')); await finish(a);
    assert.equal(commandInputs(a).length, 1);
    assert.equal(events(a).filter(e => e.type === 'command/run').length, 1);
    const requests = evidence.requests.filter(r => r.sessionId === a.id);
    assert.equal(requests.length, 2);
    for (const r of requests) assert.equal(r.messages.filter(m => m.id === id).length, 1, 'original remains in history once');
  });
  await check('actual PTC run_code uses product search/read under the command input identity', async () => {
    const { agent: a } = await h.seed('command-ptc'); setSandboxMode(a.session, 'read-only');
    const off = a.ctx.tools.presentAs('ptc');
    try {
      reply(a, [{ id: 'command-ptc-code', name: 'run_code', args: { description: 'Recall via SDK', code: 'const s = await tools.recall_search({action:"search",mode:"literal",patterns:["needle"]}); return await tools.recall_read({action:"read",ref:s.items[0].ref});' } }]); reply(a);
      await executeRecall(ctx, a, ' verify prior constraints'); await finish(a);
      assert.equal(result(a, 'command-ptc-code').message.isError, false);
      assert.equal(state(a).shared, 1); assert.equal(state(a).calls.length, 2);
      assert.ok(state(a).calls.every(c => c.kind === 'ptc' && c.state === 'completed'));
      assert.equal(currentInteraction(a.session).interactionId, commandInputs(a)[0].data.id);
      assert.ok(JSON.stringify(evidence.requests.at(-1).messages).includes('needle original'));
    } finally { off(); }
  });
  await check('separate receiving agents keep their commands, input identities and budgets', async () => {
    const pair = await Promise.all([h.seed('command-session-a'), h.seed('command-session-b')]);
    for (const { agent: a } of pair) { reply(a, [search(`search-${a.id}`)]); reply(a); }
    await Promise.all(pair.map(({ agent: a }) => executeRecall(ctx, a, ` purpose for ${a.id}`)));
    await Promise.all(pair.map(({ agent: a }) => finish(a)));
    for (const { agent: a } of pair) {
      assert.equal(commandInputs(a).length, 1); assert.equal(commandInputs(a)[0].data.source.dshRecollection.userInput, ` purpose for ${a.id}`);
      assert.equal(state(a).shared, 2); assert.equal(state(a).sessionId, a.id);
    }
  });
  evidence.sessions = h.agents.map(({ agent: a }) => ({ id: a.id, events: events(a), budget: ctx.recallBudget.records().filter(r => r.sessionId === a.id) }));
}
