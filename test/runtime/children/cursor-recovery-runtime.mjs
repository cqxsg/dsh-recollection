import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { loadLayeredEnv } from '@deepseek-ai/dsh-app-boot';
import { runProfile } from '@deepseek-ai/dsh/profile-boot';
import { currentInteraction } from '../../../lib/index.js';
import { recallHarness } from '../../../support/fixtures/recall-harness.mjs';
import { human, recovery } from '../../../support/fixtures/scripted-model.mjs';
import { replace } from '../../../support/fixtures/control.mjs';

const timer = setTimeout(() => process.exit(1), 55000);
let runtime;
try {
  runtime = await runProfile({ environment: loadLayeredEnv('cursor-recovery', process.cwd()), profile: 'web', patchFiles: [process.argv[2]], args: ['--host', '127.0.0.1', '--port', '0', '--no-open'] });
  // Web startup can finish while this plugin is still loading its persistent state.
  await [...runtime.ctx.loader.entries()].find(entry => entry.options.id === 'recall')?.fiber.await();
  const ctx = runtime.ctx, [mode, phase] = process.argv[3].split(':'), id = `cursor-crash-${phase}`, callId = `cursor-${phase}-interrupted`;
  const checkpointPath = join(process.env.DSH_HOME, '..', `checkpoint-${phase}.json`);
  const h = recallHarness(ctx);
  await h.ready();
  let armed = false, agent, candidate, saved;
  const state = () => ctx.recallBudget.state(currentInteraction(agent.session));
  async function checkpoint() {
    await ctx.sessions.flush(agent.session);
    const row = saved.budgetCompleted ?? state(), result = agent.session.snapshotEvents().findLast(e => e.type === 'tool/result' && e.data.message.toolCallId === callId);
    const successDelivered = !!result && !result.data.message.isError;
    await fs.writeFile(checkpointPath, JSON.stringify({ ...saved, phase, candidate, budgetAtCrash: row, successDelivered, pid: process.pid }, null, 2));
    process.send({ phase, pid: process.pid, state: row.calls.at(-1).state, shared: row.shared, successDelivered });
    await new Promise(() => {});
  }

  if (mode === 'crash') {
    const backend = ctx.storage.backend.get('json'), open = backend.kv.open.bind(backend.kv);
    const restore = replace(backend.kv, 'open', async descriptor => {
      const unit = await open(descriptor), put = unit.putRecord.bind(unit);
      if (descriptor.name === 'dsh_recall_cursors_v3') replace(unit, 'putRecord', async (table, key, value) => {
        const target = armed && value.sessionId === id;
        if (target) { candidate = structuredClone(value); if (phase === 'before-write') await checkpoint(); }
        await put(table, key, value);
        if (target && phase === 'mapped') await checkpoint();
      });
      if (descriptor.name === 'dsh_recall_business') replace(unit, 'putRecord', async (table, key, value) => {
        await put(table, key, value);
        if (armed && phase === 'completed' && value.sessionId === id && value.calls.at(-1).callId === callId && value.calls.at(-1).state === 'completed') {
          // The raw write is durable before the domain's in-memory projection catches up.
          saved.budgetCompleted = structuredClone(value);
          await checkpoint();
        }
      });
      return unit;
    });
    try { await [...ctx.loader.entries()].find(e => e.options.id === 'recall').fiber.restart(); } finally { restore(); }
    if (phase === 'temp-synced') {
      const openFile = fs.open.bind(fs);
      fs.open = async (path, ...args) => {
        const handle = await openFile(path, ...args);
        if (armed && String(path).replaceAll('\\', '/').includes('/dsh_recall_cursors_v3/pages/') && String(path).endsWith('.tmp')) {
          const sync = handle.sync.bind(handle);
          handle.sync = async () => { await sync(); await checkpoint(); };
        }
        return handle;
      };
      // Exercise the native JSON backend's real temp-file fsync, before its atomic rename.
      syncBuiltinESMExports();
    }
    ({ agent } = await h.seed(id, ['needle ' + '原文😀 line\n'.repeat(6000)]));
    const ref = (await h.search(agent)).value.items[0].ref, first = (await h.read(agent, ref)).value;
    const input = ctx.recallCursors.resolve(first.nextCursor, id, 'read');
    saved = { id, ref, input, args: { action: 'next', cursor: first.nextCursor }, callId, budgetBefore: state() };
    armed = true;
    const [result] = await h.drive(agent, [{ id: callId, name: 'recall_read', args: saved.args }]);
    assert.equal(phase, 'delivered'); assert.equal(result.value.status, 'ok');
    await checkpoint();
  } else {
    saved = JSON.parse(await fs.readFile(checkpointPath, 'utf8')); assert.notEqual(saved.pid, process.pid);
    const row = ctx.recallBudget.records().find(r => r.sessionId === id && r.interactionId === saved.budgetBefore.interactionId);
    assert.equal(row.shared, saved.budgetBefore.shared - 1); assert.equal(row.searches, saved.budgetBefore.searches);
    assert.equal(row.actualCalls, saved.budgetBefore.actualCalls + 1);
    const completed = ['completed', 'delivered'].includes(phase), published = !['before-write', 'temp-synced'].includes(phase);
    assert.equal(row.calls.at(-1).state, completed ? 'completed' : 'reserved');
    assert.equal(row.calls.at(-1).page, saved.input.pageId); assert.deepEqual(row.queries, saved.budgetBefore.queries);
    assert.deepEqual(ctx.recallCursors.resolve(saved.input.handle, id, 'read'), saved.input);
    if (published) assert.deepEqual(ctx.recallCursors.resolve(saved.candidate.handle, id, 'read'), saved.candidate);
    else assert.throws(() => ctx.recallCursors.resolve(saved.candidate.handle, id, 'read'), e => e.code === 'stale_reference');
    const handle = await ctx.agents.resume({ resumeSessionId: id, agentOptions: h.model.options }); h.agents.push(handle); agent = handle.agent;
    const delivered = agent.session.snapshotEvents().some(e => e.type === 'tool/result' && e.data.message.toolCallId === callId && !e.data.message.isError);
    assert.equal(delivered, phase === 'delivered');
    const replay = await ctx.tools.execute({ name: 'recall_read', callId, arguments: saved.args, agent, signal: new AbortController().signal });
    assert.equal(replay.error.info.code, 'call_replay'); assert.deepEqual(state(), row);
    const [lost] = await h.drive(agent, [{ name: 'recall_read', args: saved.args }], recovery());
    assert.equal(lost.value.code, 'stale_reference'); assert.ok(lost.value.recovery.includes(saved.ref));
    assert.equal(state().shared, row.shared - 1); assert.equal(state().interactionId, row.interactionId); assert.equal(state().closed, false);
    const recovered = (await h.read(agent, saved.ref, human('read the verified source again'))).value;
    assert.equal(recovered.status, 'ok'); assert.equal(recovered.items[0].start, 0); assert.equal(recovered.nextCursor.length, 26);
    await fs.writeFile(join(process.env.DSH_HOME, '..', `recovered-${phase}.json`), JSON.stringify({ phase, sourcePid: saved.pid, recoveredPid: process.pid,
      mappingPublished: published, originalMappingRestored: true, crashCallState: row.calls.at(-1).state, successDelivered: delivered,
      sharedBefore: saved.budgetBefore.shared, sharedRestored: row.shared, replayRejected: true, verifiedAnchorRecovery: true, newInteractionBudget: recovered.budget }, null, 2));
    console.log(`PASS: ${phase} preserves mapping publication, source recovery, delivery evidence, page identity and original charges`);
    await h.dispose(); await runtime.shutdown.shutdown(0);
  }
} catch (error) { console.error(error); if (runtime) await runtime.shutdown.shutdown(1); process.exitCode = 1; }
finally { clearTimeout(timer); }
