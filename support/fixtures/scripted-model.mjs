import assert from 'node:assert/strict';
import { LlmAdapter, createUserMessage, isAgentLoopRequest } from '@deepseek-ai/dsh-llm';
import { DIAGNOSTIC_TOOL_NAME, RECALL_USAGE } from '../../lib/index.js';

export const human = text => createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] });

// An explicit test-owned producer, using the native extensible source contract.
export const recovery = () => createUserMessage({ source: { kind: 'recall-test-recovery' }, content: [{ type: 'text', text: 'Resume the existing work' }] });

/** Only the provider stream is scripted; inbox, loop, logs and tools are native. */
export function scriptedModel(ctx, capabilities = {}) {
  const replies = [];
  const requests = [];
  class FixtureAdapter extends LlmAdapter {
    async resolveModel(...args) {
      return { ...await super.resolveModel(...args), ...(capabilities.inputModalities ? { inputModalities: capabilities.inputModalities } : {}) };
    }
    async *stream() { yield { type: 'finish', reason: { kind: 'stop' } }; }
  }
  // The marker belongs to the pre-projection request at this public waterfall.
  // Adapter-side tool-history projection can replace the request object.
  const offStream = ctx.on('llm/stream', async function* (options, next) {
      if (options.provider !== 'recall-fixture' || !isAgentLoopRequest(options)) { yield* next(); return; }
      const agent = ctx.agents.requireInitiator();
      requests.push({ sessionId: agent.id, seq: agent.session.seq, tools: (options.tools ?? []).map(t => t.name), hasRecallUsage: JSON.stringify(options.messages.filter(m => m.role === 'system')).includes(JSON.stringify(RECALL_USAGE).slice(1, -1)) });
      const replyIndex = replies.findIndex(reply => reply.sessionId === undefined || reply.sessionId === agent.id);
      const reply = replyIndex >= 0 ? replies.splice(replyIndex, 1)[0] : undefined;
      assert.ok(reply, 'unexpected extra model request');
      if (reply.error) { yield { type: 'finish', reason: { kind: 'error', failure: { code: 'NETWORK', message: 'Injected provider retry' } } }; return; }
      if (reply.text) {
        yield { type: 'block-start', index: 0, blockType: 'text' };
        yield { type: 'text-delta', index: 0, text: reply.text };
        yield { type: 'block-end', index: 0, block: { type: 'text', text: reply.text } };
      }
      for (const [offset, spec] of (reply.calls ?? []).entries()) {
        const index = offset + (reply.text ? 1 : 0);
        const callId = typeof spec === 'string' ? spec : spec.id;
        const block = { type: 'tool-call', id: callId, name: typeof spec === 'string' ? reply.name ?? DIAGNOSTIC_TOOL_NAME : spec.name,
          arguments: typeof spec === 'string' ? reply.args ?? '{}' : typeof spec.args === 'string' ? spec.args : JSON.stringify(spec.args ?? {}) };
        yield { type: 'block-start', index, blockType: 'tool-call' };
        yield { type: 'tool-call-delta', index, id: callId, name: block.name, argumentsDelta: block.arguments };
        yield { type: 'block-end', index, block };
      }
      yield { type: 'finish', reason: { kind: reply.calls?.length ? 'tool-calls' : 'stop' } };
  });
  const dispose = ctx.llm.registerAdapter(['recall-fixture'], new FixtureAdapter());
  return {
    replies, requests, async dispose() { await offStream(); await dispose(); },
    options: { provider: 'recall-fixture', model: 'scripted' },
    async drive(agent, message, calls, method = 'followup') {
      replies.push({ calls }, {});
      agent[method](message);
      await agent.whenIdle();
      await ctx.sessions.flush(agent.session);
      assert.equal(replies.length, 0, `scripted replies consumed by the native loop: ${JSON.stringify(agent.session.snapshotEvents().slice(-4))}`);
      return calls.map(callId => agent.session.snapshotEvents().findLast(e => e.type === 'tool/result' && e.data.message.toolCallId === callId)?.data);
    },
  };
}
