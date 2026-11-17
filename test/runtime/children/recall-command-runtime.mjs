import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadLayeredEnv } from '@deepseek-ai/dsh-app-boot';
import { runProfile } from '@deepseek-ai/dsh/profile-boot';
import { CommandRuntime } from '@deepseek-ai/dsh-commands';
import * as plugin from '../../../lib/index.js';
import { recallHarness } from '../../../support/fixtures/recall-harness.mjs';
import { human } from '../../../support/fixtures/scripted-model.mjs';
import { deferred, replace } from '../../../support/fixtures/control.mjs';
import { verifyRecallCommand, commandInputs, executeRecall } from '../../integration/recall-command-native.mjs';

const mode = process.argv[2];
const evidence = { mode, node: process.version, cases: [], requests: [], startedAt: new Date().toISOString() };
const check = async (label, fn) => { await fn(); evidence.cases.push(label); console.log(`PASS: ${label}`); };
const until = async fn => { const end = performance.now() + 10000; while (!fn()) { assert.ok(performance.now() < end, 'command lifecycle condition timeout'); await new Promise(r => setTimeout(r, 10)); } };
let runtime, mount, h, offRequest, commandMount, conflict, restore;
try {
  runtime = await runProfile({ environment: loadLayeredEnv('recall-command'), profile: 'web', patchFiles: [process.argv[3]], args: ['--host', '127.0.0.1', '--port', '0', '--no-open'] });
  let ctx = runtime.ctx;
  if (mode === 'missing') ctx = ctx.isolate('commands');
  if (mode === 'prompt-absent') ctx = ctx.isolate('systemPrompt');
  if (mode === 'conflict') conflict = ctx.commands.register({ name: 'recall', description: 'Other plugin command', handler: () => ({ kind: 'success', text: 'other owner' }) });
  if (mode === 'registration-failure') {
    const register = ctx.commands.register;
    restore = replace(ctx.commands, 'register', function(definition) {
      if (definition.name === 'recall') throw new Error('Injected command registration failure');
      return register.call(this, definition);
    });
  }
  const config = plugin.Config({ enabled: mode !== 'disabled', prewarm: false, attachmentHashing: false, recall: { shared: 3, searches: 3 } });
  mount = await ctx.plugin(plugin, config);
  offRequest = ctx.on('llm/stream', async function* (options, next) {
    if (options.provider === 'recall-fixture') evidence.requests.push({ sessionId: ctx.agents.requireInitiator().id, messages: structuredClone(options.messages) });
    yield* next();
  });
  h = recallHarness(ctx);
  if (mode === 'disabled') {
    await check('enabled=false registers neither recall command nor product tools', async () => {
      assert.equal(ctx.get('recallTools'), undefined); assert.equal(ctx.tools.get('recall_search'), undefined); assert.equal(ctx.tools.get('recall_read'), undefined);
      const handle = await ctx.agents.create({ sessionId: 'command-disabled', agentOptions: h.model.options, meta: { cwd: process.cwd() } }); h.agents.push(handle);
      assert.equal(ctx.commands.find(handle.agent, 'recall'), undefined);
    });
  } else {
    await h.ready();
    const coreSearch = ctx.recallTools.search;
    if (mode === 'native') {
      await verifyRecallCommand(ctx, h, evidence, check);
      await check('queued command survives plugin unload as native input and reports unavailable tools truthfully', async () => {
        const { agent } = await h.seed('command-tools-lost'), gate = deferred();
        const maintenance = agent.runMaintenance(() => gate.promise);
        try {
          await executeRecall(ctx, agent, ' queued before unloading');
          const messageId = agent.inbox.nextStep[0].id;
          await mount.dispose(); mount = undefined;
          assert.equal(ctx.commands.find(agent, 'recall'), undefined);
          h.model.replies.push({ sessionId: agent.id, calls: [{ id: 'tool-after-unload', name: 'recall_search', args: { action: 'search', mode: 'literal', patterns: ['needle'] } }] }, { sessionId: agent.id });
          gate.resolve(); await maintenance; await agent.whenIdle();
          assert.deepEqual(commandInputs(agent).map(e => e.data.id), [messageId]);
          const result = agent.session.snapshotEvents().find(e => e.type === 'tool/result' && e.data.message.toolCallId === 'tool-after-unload');
          assert.equal(result.data.message.isError, true); assert.equal(result.data.error.code, 'UNKNOWN_TOOL');
          mount = await ctx.plugin(plugin, config); await h.ready();
          await until(() => ctx.commands.find(agent, 'recall'));
          assert.equal(commandInputs(agent).length, 1); assert.equal(agent.inbox.nextStep.length, 0);
        } finally { gate.resolve(); await maintenance; }
      });
      await check('plugin unload/reload withdraws command, keeps admitted history and never replays command logs', async () => {
        const a = h.agents[0].agent, before = commandInputs(a).map(e => e.data.id), old = plugin.currentInteraction(a.session), budget = ctx.recallBudget.state(old);
        await mount.dispose(); mount = undefined;
        assert.equal(ctx.commands.find(a, 'recall'), undefined); assert.equal(ctx.tools.get('recall_search'), undefined);
        mount = await ctx.plugin(plugin, config); await h.ready();
        await until(() => ctx.commands.find(a, 'recall'));
        assert.equal(ctx.commands.list(a).filter(d => d.name === 'recall').length, 1);
        assert.deepEqual(plugin.currentInteraction(a.session), old); assert.deepEqual(ctx.recallBudget.state(old), budget);
        for (const { agent } of h.agents) { assert.equal(agent.inbox.nextStep.length, 0); assert.equal(agent.inbox.nextTurn.length, 0); }
        h.model.replies.push({ sessionId: a.id }); a.followup(human('ordinary work after reload')); await a.whenIdle();
        assert.deepEqual(commandInputs(a).map(e => e.data.id), before);
        const cancelled = h.agents.find(handle => handle.agent.id === 'command-cancel').agent;
        assert.equal(cancelled.session.snapshotEvents().some(e => e.type === 'user/message' && e.data.id === evidence.cancelledMessageId), false);
        h.model.replies.push({ sessionId: a.id }); await executeRecall(ctx, a, ' explicit new request'); await a.whenIdle();
        assert.equal(commandInputs(a).length, before.length + 1);
      });
    } else {
      const { agent } = await h.seed(`command-${mode}`);
      await check(`${mode}: product search/read remains usable`, async () => {
        const found = await h.search(agent); assert.equal(found.value.status, 'ok');
        assert.equal((await h.read(agent, found.value.items[0].ref)).value.status, 'ok');
        assert.equal(ctx.recallTools.search, coreSearch);
      });
      if (mode === 'missing') {
        await check('commands can appear, disappear and recover without rebuilding core or duplicate registration', async () => {
          assert.equal(ctx.get('commands'), undefined);
          commandMount = await ctx.plugin(CommandRuntime);
          await until(() => ctx.commands.find(agent, 'recall'));
          h.model.replies.push({ sessionId: agent.id }); await executeRecall(ctx, agent); await agent.whenIdle();
          assert.equal(commandInputs(agent).length, 1);
          await commandMount.dispose(); commandMount = undefined; assert.equal(ctx.get('commands'), undefined);
          assert.equal(ctx.recallTools.search, coreSearch);
          commandMount = await ctx.plugin(CommandRuntime); await until(() => ctx.commands.find(agent, 'recall'));
          assert.equal(ctx.commands.list(agent).filter(d => d.name === 'recall').length, 1);
          h.model.replies.push({ sessionId: agent.id }); await executeRecall(ctx, agent); await agent.whenIdle();
          assert.equal(commandInputs(agent).length, 2); assert.equal(ctx.recallTools.search, coreSearch);
        });
      } else if (mode === 'conflict' || mode === 'registration-failure') {
        await check(`${mode}: registration fails independently and explicit reload can recover`, async () => {
          if (mode === 'conflict') {
            assert.equal((await executeRecall(ctx, agent)).result.text, 'other owner');
            assert.equal(commandInputs(agent).length, 0); await conflict(); conflict = undefined;
          } else assert.equal(ctx.commands.find(agent, 'recall'), undefined);
          restore?.(); restore = undefined;
          await mount.dispose(); mount = await ctx.plugin(plugin, config); await h.ready();
          await until(() => ctx.commands.find(agent, 'recall'));
          h.model.replies.push({ sessionId: agent.id }); await executeRecall(ctx, agent); await agent.whenIdle();
          assert.equal(commandInputs(agent).length, 1);
        });
      } else if (mode === 'prompt-absent') {
        await check('command works without prewarm, attachment hashing or extra system prompt', async () => {
          assert.equal(ctx.get('systemPrompt'), undefined); assert.equal(ctx.get('recallHashes'), undefined);
          await until(() => ctx.commands.find(agent, 'recall'));
          h.model.replies.push({ sessionId: agent.id, calls: [{ id: 'without-prompt', name: 'recall_search', args: { action: 'search', mode: 'literal', patterns: ['needle'] } }] }, { sessionId: agent.id });
          await executeRecall(ctx, agent); await agent.whenIdle();
          assert.equal(commandInputs(agent).length, 1);
          assert.ok(h.model.requests.every(r => !r.hasRecallUsage));
          assert.equal(ctx.recallBudget.state(plugin.currentInteraction(agent.session)).shared, 2);
        });
      }
      evidence.events = agent.session.snapshotEvents();
    }
  }
  evidence.passed = true;
} catch (error) {
  evidence.passed = false; evidence.error = error.stack; console.error(error); process.exitCode = 1;
} finally {
  if (h) evidence.sessions = h.agents.map(({ agent }) => ({ id: agent.id, events: agent.session.snapshotEvents() }));
  restore?.(); await conflict?.(); await offRequest?.(); await h?.dispose(); await mount?.dispose(); await commandMount?.dispose();
  await runtime?.shutdown.shutdown(process.exitCode ?? 0);
  evidence.finishedAt = new Date().toISOString();
  await writeFile(join(process.env.DSH_HOME, '..', 'command-evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
}
