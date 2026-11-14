import assert from 'node:assert/strict';
import { scriptedModel, human, recovery } from './scripted-model.mjs';
import { waitForRecall } from '../wait-for-recall.mjs';
import { createHistoryFixture } from './history.mjs';
import { rangeFixture, text } from './range.mjs';

export function recallHarness(ctx) {
  const model = scriptedModel(ctx), agents = [];
  let serial = 0;
  async function seed(id, bodies = ['needle original']) {
    await waitForRecall(ctx);
    const fixture = await createHistoryFixture(ctx, id, []), f = rangeFixture(fixture.session);
    f.append('turn/start', { turn: 1 }); f.append('step/start', { turn: 1, step: 1 });
    f.append('system/message', { turn: 1, step: 1, message: { id: `${id}-system`, role: 'system', source: { kind: 'system-prompt' }, content: [text('fixture system')] } }, { surfaceOp: 'append' });
    bodies.forEach(body => f.user([text(body)]));
    f.append('step/end', { turn: 1, step: 1 }); f.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
    f.summary([...fixture.session.surface.nodes].filter(seq => fixture.session.snapshotEvents()[seq].type !== 'system/message'));
    await fixture.flush(); await fixture.close();
    const started = performance.now(), handle = await ctx.agents.resume({ resumeSessionId: id, agentOptions: model.options }); agents.push(handle);
    return { agent: handle.agent, resumeMs: performance.now() - started };
  }
  async function drive(agent, calls, input = recovery(), final = true) {
    await waitForRecall(ctx);
    const specs = calls.map(call => ({ ...call, id: call.id ?? `recall-call-${process.pid}-${++serial}` }));
    model.replies.push({ sessionId: agent.id, calls: specs }, ...(final ? [{ sessionId: agent.id }] : []));
    agent.followup(input); await agent.whenIdle(); await ctx.sessions.flush(agent.session);
    assert.equal(model.replies.some(reply => reply.sessionId === agent.id), false, 'all planned native requests consumed');
    return specs.map(spec => {
      const event = agent.session.snapshotEvents().findLast(e => e.type === 'tool/result' && e.data.message.toolCallId === spec.id);
      assert.ok(event, `missing native result ${spec.id}`);
      let value;
      if (!event.data.message.isError) { try { value = JSON.parse(event.data.message.content[0].text); } catch { value = event.data.message.content[0].text; } }
      return { data: event.data, value, event };
    });
  }
  const search = async (agent, input = human('find'), patterns = ['needle']) => (await drive(agent, [{ name: 'recall_search', args: { action: 'search', mode: 'literal', patterns } }], input))[0];
  const read = async (agent, ref, input = recovery()) => (await drive(agent, [{ name: 'recall_read', args: { action: 'read', ref } }], input))[0];
  const next = async (agent, cursor) => (await drive(agent, [{ name: 'recall_search', args: { action: 'next', cursor } }]))[0];
  async function dispose() { for (const handle of agents) await handle.dispose(); await model.dispose(); }
  return { model, agents, seed, drive, search, read, next, dispose, ready: () => waitForRecall(ctx) };
}
