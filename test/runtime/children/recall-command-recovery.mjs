import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadLayeredEnv } from '@deepseek-ai/dsh-app-boot';
import { runProfile } from '@deepseek-ai/dsh/profile-boot';
import { currentInteraction } from '../../../lib/index.js';
import { recallHarness } from '../../../support/fixtures/recall-harness.mjs';
import { recovery } from '../../../support/fixtures/scripted-model.mjs';
import { commandInputs, executeRecall } from '../../integration/recall-command-native.mjs';

const [mode, phase] = process.argv[3].split(':'), id = `command-crash-${phase}`;
const evidence = { mode, phase, pid: process.pid, startedAt: new Date().toISOString() };
let runtime, h;
try {
  runtime = await runProfile({ environment: loadLayeredEnv('recall-command-recovery'), profile: 'web', patchFiles: [process.argv[2]], args: ['--host', '127.0.0.1', '--port', '0', '--no-open'] });
  const ctx = runtime.ctx;
  await [...ctx.loader.entries()].find(entry => entry.options.id === 'recall').fiber.await();
  h = recallHarness(ctx); await h.ready();
  const search = { id: `search-${phase}`, name: 'recall_search', args: { action: 'search', mode: 'literal', patterns: ['needle'] } };
  if (mode === 'crash') {
    const { agent } = await h.seed(id);
    const checkpoint = async message => {
      await ctx.sessions.flush(agent.session);
      const rows = ctx.recallBudget.records().filter(r => r.sessionId === id);
      let ref;
      if (phase === 'admitted') ref = JSON.parse(agent.session.snapshotEvents().find(e => e.type === 'tool/result' && e.data.message.toolCallId === search.id).data.message.content[0].text).items[0].ref;
      const value = { checkpoint: phase, id, message, ref, pid: process.pid, admitted: commandInputs(agent).length === 1,
        charged: rows.reduce((sum, row) => sum + row.actualCalls, 0), budget: rows, events: agent.session.snapshotEvents(),
        previews: ctx.sessionProjections.snapshot(agent.session).values.recallCommandPreviews };
      process.send(value);
      await new Promise(() => {}); // Parent kills only after durably saving this checkpoint.
    };
    if (phase === 'pending') {
      void agent.runMaintenance(() => new Promise(() => {}));
      assert.equal((await executeRecall(ctx, agent, ' pending request')).result.kind, 'success');
      assert.equal(agent.inbox.nextStep.length, 1);
      await checkpoint(agent.inbox.nextStep[0]);
    } else if (phase === 'claimed') {
      agent.ctx.on('agent/pre-step', async ({ messages }) => { await checkpoint(messages.find(m => m.content[0]?.text?.startsWith('[/recall request'))); return { kind: 'reject' }; });
      await executeRecall(ctx, agent, ' claimed request'); await agent.whenIdle();
    } else {
      h.model.replies.push({ sessionId: id, calls: [search] }, { sessionId: id });
      await executeRecall(ctx, agent, ' admitted request'); await agent.whenIdle();
      await checkpoint(commandInputs(agent)[0].data);
    }
    assert.fail('parent must kill the checkpoint process');
  } else {
    const checkpoint = JSON.parse(await readFile(join(process.env.DSH_HOME, '..', `checkpoint-${phase}.json`), 'utf8'));
    const stored = ctx.recallBudget.records().filter(r => r.sessionId === id);
    assert.deepEqual(stored, checkpoint.budget, 'reopening preserves the original charges');
    const handle = await ctx.agents.resume({ resumeSessionId: id, agentOptions: h.model.options }); h.agents.push(handle);
    const agent = handle.agent;
    assert.deepEqual(ctx.sessionProjections.snapshot(agent.session).values.recallCommandPreviews, checkpoint.previews);
    assert.equal(h.model.requests.length, 0, 'loading a command log does not invoke a model');
    assert.equal(commandInputs(agent).length, phase === 'admitted' ? 1 : 0);
    assert.equal(agent.inbox.nextStep.length, phase === 'pending' ? 1 : 0);
    if (phase === 'pending') {
      assert.equal(agent.inbox.nextStep[0].id, checkpoint.message.id);
      assert.deepEqual(agent.inbox.nextStep[0].source, checkpoint.message.source);
    }
    if (phase === 'admitted') {
      assert.equal(currentInteraction(agent.session).interactionId, checkpoint.message.id);
      assert.deepEqual(commandInputs(agent)[0].data.source, checkpoint.message.source);
    }
    const calls = phase === 'pending' ? [search] : phase === 'admitted'
      ? [{ id: 'recovered-read', name: 'recall_read', args: { action: 'read', ref: checkpoint.ref } }] : undefined;
    h.model.replies.push({ sessionId: id, ...(calls ? { calls } : {}) }, ...(calls ? [{ sessionId: id }] : []));
    agent.followup(recovery()); await agent.whenIdle(); await ctx.sessions.flush(agent.session);
    assert.equal(h.model.replies.length, 0);
    assert.equal(commandInputs(agent).length, phase === 'claimed' ? 0 : 1);
    assert.equal(agent.session.snapshotEvents().filter(e => e.type === 'command/run').length, 1);
    assert.equal(agent.inbox.nextStep.length, 0);
    const budget = ctx.recallBudget.records().filter(r => r.sessionId === id);
    if (phase === 'claimed') assert.deepEqual(budget, []);
    else {
      assert.equal(budget.length, 1); assert.equal(budget[0].interactionId, checkpoint.message.id);
      assert.equal(budget[0].shared, phase === 'pending' ? 11 : 10);
      const result = agent.session.snapshotEvents().findLast(e => e.type === 'tool/result');
      assert.equal(result.data.message.isError, false); assert.equal(JSON.parse(result.data.message.content[0].text).status, 'ok');
    }
    evidence.passed = true; evidence.budget = budget; evidence.events = agent.session.snapshotEvents();
    evidence.previews = ctx.sessionProjections.snapshot(agent.session).values.recallCommandPreviews;
    if (phase !== 'claimed') assert.ok(Object.values(evidence.previews).includes(checkpoint.message.source.dshRecollection.userInput.trim()));
    evidence.originalMessageId = checkpoint.message.id;
    console.log(`PASS: command ${phase} process recovery preserves native input boundary, identity and charges without replay`);
  }
} catch (error) {
  evidence.passed = false; evidence.error = error.stack; console.error(error); process.exitCode = 1;
} finally {
  await h?.dispose(); await runtime?.shutdown.shutdown(process.exitCode ?? 0);
  evidence.finishedAt = new Date().toISOString();
  await writeFile(join(process.env.DSH_HOME, '..', `recovered-${phase}.json`), JSON.stringify(evidence, null, 2) + '\n');
}
