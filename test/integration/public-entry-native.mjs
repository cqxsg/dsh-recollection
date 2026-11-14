import assert from 'node:assert/strict';
import * as timeoutPolicy from '@deepseek-ai/dsh-tool-call-timeout-policy';
import { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy';
import { CallTimeline, currentInteraction, inputSchema, parseRequest } from '../../lib/index.js';
import { human } from '../../support/fixtures/scripted-model.mjs';
import { replace } from '../../support/fixtures/control.mjs';

/** Exercise the public raw definition before changing the production controller. */
export async function verifyPublicEntry(ctx, h, check) {
  const name = 'recall_entry_probe', entered = [];
  const dispose = ctx.tools.register({
    name, description: 'Isolated public entry feasibility probe', parameters: inputSchema('search'),
    timeoutMs: 100, isConcurrencySafe: () => true,
    output: { schema: { type: 'string' }, render: (_, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args, exec) {
      entered.push(structuredClone(args));
      const timeline = new CallTimeline(ctx.recallTools.config, exec.signal);
      try {
        return await ctx.recallBudget.track(async () => {
          let code = 'ok';
          try { parseRequest('search', args); } catch { code = 'invalid_arguments'; }
          const reservation = await ctx.recallBudget.reserve(exec, timeline, { kind: 'search' });
          await ctx.recallBudget.complete(reservation, { success: code === 'ok', code });
          return code;
        });
      } finally { timeline.dispose(); }
    },
  });
  try {
    await check('public raw definition receives schema-invalid Native/PTC arguments and durably charges each call', async () => {
      const inputs = [{}, { action: 'wrong' }, { action: 'search', mode: 1, patterns: [] }, { action: 'search', mode: 'literal', patterns: ['x'], extra: true }];
      const { agent } = await h.seed('public-entry-native');
      for (const [index, args] of inputs.entries()) {
        const [result] = await h.drive(agent, [{ name, args }], index ? undefined : human('public entry'));
        assert.equal(result.value, 'invalid_arguments');
      }
      assert.deepEqual(entered, inputs);
      let row = ctx.recallBudget.state(currentInteraction(agent.session));
      assert.equal(row.actualCalls, inputs.length); assert.equal(row.searches, 2); assert.equal(row.shared, 8);
      const replay = await ctx.tools.execute({ name, callId: row.calls[0].callId, arguments: inputs[0], agent, signal: new AbortController().signal });
      assert.equal(replay.error.info.code, 'call_replay');
      assert.equal(ctx.recallBudget.state(currentInteraction(agent.session)).actualCalls, inputs.length);
      const ptc = (await h.seed('public-entry-ptc')).agent;
      setSandboxMode(ptc.session, 'read-only'); const unmount = ptc.ctx.tools.presentAs('ptc');
      try {
        const [result] = await h.drive(ptc, [{ name: 'run_code', args: { code: `return await tools.${name}({} as any);`, description: 'Invalid public entry' } }], human('PTC public entry'));
        assert.equal(result.data.message.isError, false);
        row = ctx.recallBudget.state(currentInteraction(ptc.session));
        assert.equal(row.actualCalls, 1); assert.equal(row.shared, 11); assert.equal(row.calls[0].kind, 'ptc');
      } finally { unmount(); }
    });
    await check('public entry after policy remount inherits native outer cancellation and drains a pending reservation write', async () => {
      await [...ctx.registry.get(timeoutPolicy).fibers].find(f => f.state === 2).dispose();
      await ctx.plugin(timeoutPolicy);
      const { agent } = await h.seed('public-entry-timeout');
      let committed = false;
      const table = ctx.recallBudget.table, put = table.put.bind(table);
      const undo = replace(table, 'put', async (...args) => {
        await new Promise(resolve => setTimeout(resolve, 180));
        await put(...args); committed = true;
      });
      try {
        const started = performance.now();
        const [result] = await h.drive(agent, [{ name, args: { action: 'search', mode: 'literal', patterns: ['x'] } }], human('timeout write'));
        assert.equal(result.data.error.code, 'TOOL_TIMEOUT');
        assert.ok(committed); assert.ok(performance.now() - started >= 180);
        const row = ctx.recallBudget.state(currentInteraction(agent.session));
        assert.equal(row.shared, 11); assert.equal(row.calls[0].state, 'reserved');
      } finally { undo(); }
    });
  } finally {
    await dispose();
  }
}
