import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadLayeredEnv } from '@deepseek-ai/dsh-app-boot';
import { runProfile } from '@deepseek-ai/dsh/profile-boot';
import { RecallBudgetService, RecallCallController, loadRecallConfig, nativeSchema, recallResult, renderRecall, currentInteraction } from '../../../lib/index.js';
import { scriptedModel, human, recovery } from '../../../support/fixtures/scripted-model.mjs';
import { replace } from '../../../support/fixtures/control.mjs';

const timer = setTimeout(() => process.exit(1), 45000);
let runtime;
try {
  runtime = await runProfile({ environment: loadLayeredEnv('recall-budget-recovery', process.cwd()), profile: 'web', patchFiles: [process.argv[2]], args: ['--host', '127.0.0.1', '--port', '0', '--no-open'] });
  // Web startup can finish while this plugin is still loading its persistent state.
  await [...runtime.ctx.loader.entries()].find(entry => entry.options.id === 'recall')?.fiber.await();
  const ctx = runtime.ctx, [mode, phase] = process.argv[3].split(':'), id = `budget-crash-${phase}`;
  let actions = 0;
  const model = scriptedModel(ctx);
  const config = loadRecallConfig(mode === 'recover' ? { shared: 99, searches: 99, freePages: 99 } : {});
  if (mode === 'crash') {
    const backend = ctx.storage.backend.get('json'), open = backend.kv.open.bind(backend.kv);
    replace(backend.kv, 'open', async descriptor => {
      const unit = await open(descriptor);
      if (descriptor.name === 'dsh_recall_business') {
        const put = unit.putRecord.bind(unit);
        replace(unit, 'putRecord', async (table, key, value) => {
          await put(table, key, value);
          if (value.sessionId === id && value.calls.at(-1).state === phase) {
            process.send({ checkpoint: phase, actions, pid: process.pid });
            await new Promise(() => {});
          }
        });
      }
      return unit;
    });
  }
  await ctx.plugin(RecallBudgetService, config);
  const scope = await ctx.inject(['recallBudget', 'tools'], local => {
    let controller;
    for (const name of ['recall_search', 'recall_read']) local.tools.register({ name, description: 'isolated recovery probe', parameters: { type: 'object', properties: {}, additionalProperties: true },
      timeoutMs: config.outerMs, output: { schema: nativeSchema(recallResult), render: (_, value) => renderRecall(value) }, execute: (_, exec) => controller.body(exec) });
    controller = new RecallCallController(local, config, { names: new Map([['recall_search', 'search'], ['recall_read', 'read']]), execute: async (request, exec, reservation) => {
      actions++;
      const query = request.action === 'search' ? 'fixed-query' : undefined;
      if (query) await local.recallBudget.associate(reservation, query);
      return { result: { status: 'ok', items: [], budget: local.recallBudget.summary(reservation.interaction, query), allowed_actions: [] }, ...(query ? { query, hasMore: true } : {}) };
    } });
  });
  const args = { action: 'search', mode: 'literal', patterns: ['crash-query'] }, callId = `${phase}-business-call`;
  if (mode === 'crash') {
    const { agent } = await ctx.agents.create({ sessionId: id, agentOptions: model.options, meta: { cwd: process.cwd() } });
    model.replies.push({ calls: [callId], name: 'recall_search', args: JSON.stringify(args) }, {});
    agent.followup(human('crash query')); await agent.whenIdle(); assert.fail('parent must kill process');
  } else {
    const row = ctx.recallBudget.records().find(r => r.sessionId === id);
    assert.equal(row.shared, 11); assert.equal(row.searches, 5); assert.equal(row.calls[0].state, phase);
    assert.equal(row.queries[0]?.free ?? 0, phase === 'completed' ? 2 : 0);
    const before = structuredClone(row);
    const { agent, dispose } = await ctx.agents.resume({ resumeSessionId: id, agentOptions: model.options });
    assert.ok(agent.session.snapshotEvents().some(e => e.type === 'turn/end' && e.data.reason.kind === 'interrupted'));
    const replay = await ctx.tools.execute({ name: 'recall_search', callId, arguments: args, agent, signal: new AbortController().signal });
    assert.equal(replay.error.info.code, 'call_replay'); assert.equal(actions, 0);
    assert.deepEqual(ctx.recallBudget.state(currentInteraction(agent.session)), before);
    async function drive(input, nextId) {
      model.replies.push({ calls: [nextId], name: 'recall_read', args: JSON.stringify({ action: 'read', ref: 'verified-probe' }) }, {});
      agent.followup(input); await agent.whenIdle(); return ctx.recallBudget.state(currentInteraction(agent.session));
    }
    const continued = await drive(recovery(), `continued-${phase}`);
    assert.equal(continued.shared, 10); assert.equal(continued.limits.shared, 12); assert.equal(continued.interactionId, before.interactionId);
    assert.equal(continued.queries[0]?.free ?? 0, phase === 'completed' ? 2 : 0);
    const fresh = await drive(human('继续'), `fresh-${phase}`);
    assert.equal(fresh.shared, 98); assert.equal(fresh.queries.length, 0);
    await writeFile(join(process.env.DSH_HOME, '..', `business-recovered-${phase}.json`), JSON.stringify({ before, continued, fresh, actions, pid: process.pid }, null, 2));
    await dispose(); await scope.dispose(); await model.dispose();
    console.log(`PASS: durable ${phase} recovery retains S/R/F, refuses replay and applies new limits only to a new interaction`);
  }
  await runtime.shutdown.shutdown(0);
} catch (error) { console.error(error); if (runtime) await runtime.shutdown.shutdown(1); process.exitCode = 1; }
finally { clearTimeout(timer); }
