import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { currentInteraction, loadRecallConfig, renderedTokens } from '../../lib/index.js';
import { human } from '../../support/fixtures/scripted-model.mjs';
import { createHistoryFixture } from '../../support/fixtures/history.mjs';
import { rangeFixture, text } from '../../support/fixtures/range.mjs';

/** Capture the adapter input after native pre-step pressure handling and tool-history projection. */
export async function verifyDelivery(ctx) {
  const body = 'needle ' + 'ASCII 中文😀 "\\\n'.repeat(5000), requests = [], pages = [], pressure = [];
  let agent, first, offset = 0;
  const originalResult = id => agent.session.snapshotEvents().find(e => e.type === 'tool/result' && e.data.message.toolCallId === id);
  const received = (options, id) => {
    const message = options.messages.find(m => m.role === 'tool' && m.toolCallId === id);
    assert.ok(message, `adapter received ${id}`);
    const original = originalResult(id); assert.ok(original); assert.equal(original.data.message.isError, false);
    assert.deepEqual(message.content, original.data.message.content, 'complete JSON survives native delivery');
    const raw = message.content[0].text, value = JSON.parse(raw);
    assert.equal(Object.hasOwn(value, 'query'), false); assert.equal(Object.hasOwn(value, 'snapshot'), false);
    for (const item of value.items) assert.match(item.ref, /^rr2_[\w-]{22}$/);
    assert.ok(renderedTokens(value) <= 2000); assert.ok(raw.length <= 7984); assert.ok(Array.from(raw).length < 8192);
    if (value.nextCursor) assert.equal(value.nextCursor.length, 26);
    assert.deepEqual(original.data.meta.recall.budget, value.budget);
    pages.push({ callId: id, seq: original.seq, utf16: raw.length, codePoints: Array.from(raw).length, tokens: renderedTokens(value), value });
    return value;
  };
  class DeliveryAdapter extends LlmAdapter {
    async resolveModel(provider, model) { return { provider, id: model, name: model, context: { contextWindow: 131072 } }; }
    async *stream(options) {
      assert.notEqual(options.purpose, 'compaction', 'pruning alone must reduce this fixture below the pressure threshold');
      const step = requests.length; requests.push(structuredClone(options));
      let calls = [];
      if (step === 0) calls = [{ id: 'search', name: 'recall_search', args: { action: 'search', mode: 'literal', patterns: ['needle'] } }];
      if (step === 1) {
        first = received(options, 'search'); assert.equal(first.status, 'ok');
        calls = [{ id: 'read', name: 'recall_read', args: { action: 'read', ref: first.items[0].ref } },
          ...[0, 1, 2].map(i => ({ id: `noise-${i}`, name: 'delivery_noise', args: {} }))];
      }
      if (step === 2) {
        const value = received(options, 'read'); assert.equal(value.status, 'ok'); assert.ok(value.nextCursor);
        assert.equal(value.items[0].start, 0); offset = value.items[0].end; assert.equal(value.items[0].content, body.slice(0, offset));
        for (let i = 0; i < 3; i++) {
          const original = originalResult(`noise-${i}`), actual = options.messages.find(m => m.toolCallId === `noise-${i}`);
          assert.ok(original.data.message.content[0].text.length > 8192); assert.match(actual.content[0].text, /tool result middle pruned/);
          assert.ok(agent.session.snapshotEvents().some(e => e.type === 'compaction/prune' && e.data.shadowedSeqs.includes(original.seq)));
        }
        assert.ok(pressure.some(p => p.before >= 20000 && p.after < 20000));
        calls = [{ id: 'next', name: 'recall_read', args: { action: 'next', cursor: value.nextCursor } }];
      }
      if (step === 3) {
        const value = received(options, 'next'); assert.equal(value.status, 'ok'); assert.equal(value.items[0].start, offset);
        assert.equal(value.items[0].content, body.slice(offset, value.items[0].end)); assert.equal(value.budget.shared_remaining, 9);
        assert.ok(value.allowed_actions.includes('read')); assert.ok(options.tools.some(t => t.name === 'recall_read'));
        calls = [{ id: 'invalid-1', name: 'recall_search', args: { action: 'search', mode: 'invalid', patterns: ['x'] } }];
      }
      if (step === 4) {
        assert.equal(received(options, 'invalid-1').code, 'invalid_arguments');
        calls = [{ id: 'invalid-2', name: 'recall_search', args: { action: 'search', mode: 'invalid', patterns: ['y'] } }];
      }
      if (step === 5) {
        const value = received(options, 'invalid-2'); assert.equal(value.budget.closed, true); assert.deepEqual(value.allowed_actions, []);
        assert.ok(!options.tools.some(t => t.name.startsWith('recall_'))); assert.ok(options.tools.some(t => t.name === 'delivery_noise'));
      }
      assert.ok(step <= 5);
      for (const [index, call] of calls.entries()) {
        const block = { type: 'tool-call', id: call.id, name: call.name, arguments: JSON.stringify(call.args) };
        yield { type: 'block-start', index, blockType: 'tool-call' };
        yield { type: 'tool-call-delta', index, id: call.id, name: call.name, argumentsDelta: block.arguments };
        yield { type: 'block-end', index, block };
      }
      yield { type: 'finish', reason: { kind: calls.length ? 'tool-calls' : 'stop' } };
    }
  }
  const adapter = ctx.llm.registerAdapter(['recall-delivery'], new DeliveryAdapter());
  const noise = ctx.tools.register(defineTool({ name: 'delivery_noise', description: 'Generate pressure for the delivery fixture', parameters: {},
    output: { schema: { type: 'string' }, render: (_, value) => [text(value)] }, isConcurrencySafe: () => true, execute: async () => 'z'.repeat(40000) }));
  // Observe, without initiating pruning: the native pre-step handler is the caller.
  const prune = ctx.toolResultPruner.pruneSession.bind(ctx.toolResultPruner);
  ctx.toolResultPruner.pruneSession = session => {
    const before = ctx.tokenMeter.measure(session).totalTokens, result = prune(session), after = ctx.tokenMeter.measure(session).totalTokens;
    pressure.push({ before, after, ...result }); return result;
  };
  let handle;
  try {
    assert.deepEqual(ctx.toolResultPruner.config, { thresholdChars: 8192, headChars: 4096, tailChars: 1024 });
    assert.equal(ctx.compaction.config.thresholdRatio * 131072, 20000); assert.equal(ctx.compaction.config.auto, true);
    assert.deepEqual(ctx.recallTools.config, loadRecallConfig());
    const fixture = await createHistoryFixture(ctx, 'recall-pressure-delivery', []), f = rangeFixture(fixture.session);
    f.append('turn/start', { turn: 1 }); f.append('step/start', { turn: 1, step: 1 }); f.user([text(body)]);
    f.append('step/end', { turn: 1, step: 1 }); f.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
    f.summary([...fixture.session.surface.nodes]); await fixture.flush(); await fixture.close();
    handle = await ctx.agents.resume({ resumeSessionId: 'recall-pressure-delivery', agentOptions: { provider: 'recall-delivery', model: 'scripted', maxTokens: 4096 },
      setup(scope) { scope.tools.restrict({ allow: ['recall_search', 'recall_read', 'delivery_noise'] }); } });
    agent = handle.agent; agent.followup(human('find the original needle')); await agent.whenIdle(); await ctx.sessions.flush(agent.session);
    assert.equal(requests.length, 6); assert.equal(pages.length, 5); assert.equal(ctx.recallBudget.state(currentInteraction(agent.session)).actualCalls, 5);
    const output = join(process.env.DSH_HOME, '..', 'delivery-evidence.json');
    await writeFile(output, JSON.stringify({ cases: ['native pressure pruning preserves complete recall JSON at the actual adapter', 'short read continuation, default charges and closed-tool visibility agree'],
      defaultConfig: loadRecallConfig(), pruner: ctx.toolResultPruner.config, pressureThreshold: 20000, pressure, pages, requests, paidModelCalls: 0 }, null, 2));
    console.log(`PASS: native pressure, complete adapter JSON, short continuation and visibility: ${output}`);
  } finally { ctx.toolResultPruner.pruneSession = prune; await handle?.dispose(); await noise(); await adapter(); }
}
