import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadLayeredEnv } from '@deepseek-ai/dsh-app-boot';
import { runProfile } from '@deepseek-ai/dsh/profile-boot';
import { currentInteraction } from '../../../lib/index.js';
import { scriptedModel, human, recovery } from '../../../support/fixtures/scripted-model.mjs';
import { waitForRecall } from '../../../support/wait-for-recall.mjs';
import { createHistoryFixture } from '../../../support/fixtures/history.mjs';
import { rangeFixture, text } from '../../../support/fixtures/range.mjs';
const timer = setTimeout(() => process.exit(1), 45000);
let runtime;
try {
  runtime = await runProfile({ environment: loadLayeredEnv('read-recovery', process.cwd()), profile: 'web', patchFiles: [process.argv[2]], args: ['--host', '127.0.0.1', '--port', '0', '--no-open'] });
  // Web startup can finish while this plugin is still loading its persistent state.
  await [...runtime.ctx.loader.entries()].find(entry => entry.options.id === 'recall')?.fiber.await();
  const ctx = runtime.ctx, mode = process.argv[3], id = 'read-process-source';
  const model = scriptedModel(ctx);
  await waitForRecall(ctx);
  if (mode === 'prepare') {
    const fixture = await createHistoryFixture(ctx, id, []), f = rangeFixture(fixture.session);
    f.append('turn/start', { turn: 1 }); f.append('step/start', { turn: 1, step: 1 });
    f.append('system/message', { turn: 1, step: 1, message: { id: 'fixture-system', role: 'system', source: { kind: 'system-prompt' }, content: [text('fixture system')] } }, { surfaceOp: 'append' });
    f.user([text('needle ' + 'original😀 line\n'.repeat(3000))]);
    f.append('step/end', { turn: 1, step: 1 }); f.append('turn/end', { turn: 1, reason: { kind: 'completed' } }); f.summary([...fixture.session.surface.nodes].filter(seq => fixture.session.snapshotEvents()[seq].type !== 'system/message'));
    await fixture.flush(); await fixture.close();
  }
  const { agent, dispose } = await ctx.agents.resume({ resumeSessionId: id, agentOptions: model.options });
  async function call(name, args, input, callId) {
    model.replies.push({ calls: [callId], name, args: JSON.stringify(args) }, {});
    agent.followup(input); await agent.whenIdle(); await ctx.sessions.flush(agent.session);
    const event = agent.session.snapshotEvents().findLast(e => e.type === 'tool/result' && e.data.message.toolCallId === callId);
    assert.equal(event.data.message.isError, false, JSON.stringify(event.data)); return JSON.parse(event.data.message.content[0].text);
  }
  const path = join(process.env.DSH_HOME, '..', 'read-process-ref.json');
  if (mode === 'prepare') {
    const search = await call('recall_search', { action: 'search', mode: 'literal', patterns: ['needle'] }, human('find source'), 'prepare-search');
    const ref = search.items[0].ref;
    const first = await call('recall_read', { action: 'read', ref }, recovery(), 'prepare-read'); assert.ok(first.nextCursor);
    const mapping = ctx.recallCursors.resolve(first.nextCursor, agent.id, 'read');
    assert.equal(first.nextCursor.length, 26);
    await writeFile(path, JSON.stringify({ ref, cursor: first.nextCursor, mapping, interactionId: currentInteraction(agent.session).interactionId, budget: first.budget, pid: process.pid }, null, 2));
  } else {
    const saved = JSON.parse(await readFile(path, 'utf8')); assert.notEqual(saved.pid, process.pid);
    assert.deepEqual(ctx.recallCursors.resolve(saved.cursor, agent.id, 'read'), saved.mapping);
    const first = await call('recall_read', { action: 'read', ref: saved.ref }, recovery(), 'restart-read');
    assert.equal(first.status, 'ok'); assert.equal(first.items[0].start, 0); assert.match(first.items[0].content, /^needle original😀/);
    assert.equal(first.budget.shared_remaining, saved.budget.shared_remaining - 1); assert.equal(currentInteraction(agent.session).interactionId, saved.interactionId);
    const expired = await call('recall_read', { action: 'next', cursor: saved.cursor }, recovery(), 'restart-cursor');
    assert.equal(expired.code, 'stale_reference'); assert.ok(expired.recovery.includes(saved.ref)); assert.equal(expired.budget.closed, false);
    const fresh = await call('recall_read', { action: 'read', ref: saved.ref }, human('继续读取原文'), 'new-cycle-old-ref');
    assert.equal(fresh.status, 'ok'); assert.equal(fresh.budget.shared_remaining, 11); assert.equal(fresh.budget.search_remaining, 6);
    await writeFile(join(process.env.DSH_HOME, '..', 'read-process-evidence.json'), JSON.stringify({ sourcePid: saved.pid, restoredPid: process.pid, productTools: !!ctx.get('recallTools'), refVerified: true, mappingRestored: true, fixedRangeLost: true, retainedBudget: first.budget, newBudget: fresh.budget }, null, 2));
    console.log('PASS: independent-process cursor mapping restoration, native ref verification, retained budget and explicit lost fixed range');
  }
  await dispose(); await model.dispose(); await runtime.shutdown.shutdown(0);
} catch (error) { console.error(error); if (runtime) await runtime.shutdown.shutdown(1); process.exitCode = 1; }
finally { clearTimeout(timer); }
