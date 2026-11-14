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
  runtime = await runProfile({ environment: loadLayeredEnv('reference-recovery', process.cwd()), profile: 'web', patchFiles: [process.argv[2]], args: ['--host', '127.0.0.1', '--port', '0', '--no-open'] });
  // Web startup can finish while this plugin is still loading its persistent state.
  await [...runtime.ctx.loader.entries()].find(entry => entry.options.id === 'recall')?.fiber.await();
  const ctx = runtime.ctx, [mode, phase] = process.argv[3].split(':'), id = `reference-page-${phase}`, callId = `reference-${phase}-interrupted`;
  const path = join(process.env.DSH_HOME, '..', `checkpoint-${phase}.json`), h = recallHarness(ctx);
  await h.ready();
  const args = { action: 'search', mode: 'literal', patterns: ['needle'], order: 'oldest' };
  let armed = false, agent, candidate, cursor, completedRow;
  const durable = [], state = () => ctx.recallBudget.state(currentInteraction(agent.session));
  async function checkpoint() {
    await ctx.sessions.flush(agent.session);
    const delivered = agent.session.snapshotEvents().some(e => e.type === 'tool/result' && e.data.message.toolCallId === callId && !e.data.message.isError);
    await fs.writeFile(path, JSON.stringify({ phase, pid: process.pid, candidate, cursor, durable, row: completedRow ?? state(), delivered }, null, 2));
    process.send({ phase, pid: process.pid }); await new Promise(() => {});
  }
  if (mode === 'crash') {
    const backend = ctx.storage.backend.get('json'), open = backend.kv.open.bind(backend.kv);
    const restore = replace(backend.kv, 'open', async descriptor => {
      const unit = await open(descriptor), put = unit.putRecord.bind(unit);
      if (/^dsh_recall_references_[a-f0-9]{2}$/.test(descriptor.name)) replace(unit, 'putRecord', async (table, key, value) => {
        const target = armed && value.sessionId === id;
        if (target) { candidate = structuredClone(value); if (phase === 'before-first') await checkpoint(); }
        await put(table, key, value);
        if (target) { durable.push(structuredClone(value)); if (phase === 'partial' && durable.length === 1) await checkpoint(); }
      });
      if (descriptor.name === 'dsh_recall_cursors_v3') replace(unit, 'putRecord', async (table, key, value) => {
        const target = armed && value.sessionId === id;
        if (target) { cursor = structuredClone(value); if (phase === 'references') await checkpoint(); }
        await put(table, key, value); if (target && phase === 'cursor') await checkpoint();
      });
      if (descriptor.name === 'dsh_recall_business') replace(unit, 'putRecord', async (table, key, value) => {
        await put(table, key, value);
        if (armed && phase === 'completed' && value.sessionId === id && value.calls.at(-1).callId === callId && value.calls.at(-1).state === 'completed') {
          completedRow = structuredClone(value); await checkpoint();
        }
      });
      return unit;
    });
    try { await [...ctx.loader.entries()].find(e => e.options.id === 'recall').fiber.restart(); } finally { restore(); }
    if (phase === 'temp-synced') {
      const openFile = fs.open.bind(fs);
      fs.open = async (path, ...args) => {
        const handle = await openFile(path, ...args);
        if (armed && /\/dsh_recall_references_[a-f0-9]{2}\/records\//.test(String(path).replaceAll('\\', '/')) && String(path).endsWith('.tmp')) {
          const sync = handle.sync.bind(handle); handle.sync = async () => { await sync(); await checkpoint(); };
        }
        return handle;
      };
      syncBuiltinESMExports();
    }
    ({ agent } = await h.seed(id, Array.from({ length: 12 }, (_, i) => `needle ${i} ` + '原始内容😀'.repeat(180))));
    armed = true;
    const [result] = await h.drive(agent, [{ id: callId, name: 'recall_search', args }], human('find historical evidence'));
    assert.equal(phase, 'delivered'); assert.equal(result.value.status, 'ok'); assert.ok(result.value.nextCursor);
    await checkpoint();
  } else {
    const saved = JSON.parse(await fs.readFile(path, 'utf8')); assert.notEqual(saved.pid, process.pid);
    const row = ctx.recallBudget.records().find(r => r.sessionId === id);
    assert.deepEqual(row, saved.row); assert.equal(row.shared, 11); assert.equal(row.searches, 5); assert.equal(row.actualCalls, 1);
    const completed = ['completed', 'delivered'].includes(phase), cursorPublished = ['cursor', 'completed', 'delivered'].includes(phase);
    assert.equal(row.calls[0].state, completed ? 'completed' : 'reserved');
    assert.equal(row.queries[0].granted, completed); assert.equal(row.queries[0].free, completed ? 2 : 0);
    const mappings = ctx.recallReferences.records().filter(r => r.sessionId === id);
    assert.deepEqual(mappings.sort((a, b) => a.seq - b.seq), saved.durable.sort((a, b) => a.seq - b.seq));
    if (['before-first', 'temp-synced'].includes(phase)) {
      assert.equal(mappings.length, 0); assert.throws(() => ctx.recallReferences.resolve(saved.candidate.handle, id), e => e.code === 'stale_reference');
    } else if (phase === 'partial') assert.equal(mappings.length, 1); else assert.ok(mappings.length > 1);
    if (saved.cursor) {
      if (cursorPublished) assert.deepEqual(ctx.recallCursors.resolve(saved.cursor.handle, id, 'search'), saved.cursor);
      else assert.throws(() => ctx.recallCursors.resolve(saved.cursor.handle, id, 'search'), e => e.code === 'stale_reference');
      assert.equal(mappings.length, saved.cursor.locator.index, 'all final page sources were durable before cursor publication');
    }
    const handle = await ctx.agents.resume({ resumeSessionId: id, agentOptions: h.model.options }); h.agents.push(handle); agent = handle.agent;
    const delivered = agent.session.snapshotEvents().some(e => e.type === 'tool/result' && e.data.message.toolCallId === callId && !e.data.message.isError);
    assert.equal(delivered, phase === 'delivered'); assert.equal(delivered, saved.delivered);
    const replay = await ctx.tools.execute({ name: 'recall_search', callId, arguments: args, agent, signal: new AbortController().signal });
    assert.equal(replay.error.info.code, 'call_replay'); assert.deepEqual(state(), row);
    const [retry] = await h.drive(agent, [{ name: 'recall_search', args }], recovery());
    assert.equal(retry.value.status, 'ok'); assert.equal(retry.value.start, 0); assert.equal(state().interactionId, row.interactionId);
    assert.equal(state().shared, 10); assert.equal(state().searches, 4); assert.equal(state().queries.length, 1); assert.equal(state().queries[0].free, 2);
    for (const mapping of mappings) assert.equal(retry.value.items.find(i => i.source.seq === mapping.seq).ref, mapping.handle);
    await fs.writeFile(join(process.env.DSH_HOME, '..', `recovered-${phase}.json`), JSON.stringify({ phase, sourcePid: saved.pid, recoveredPid: process.pid,
      mappingsAtCrash: mappings.length, cursorPublished, originalCallState: row.calls[0].state, delivered, originalChargesRetained: true,
      replayRejected: true, retryStart: retry.value.start, stablePublishedMappings: true, retryBudget: retry.value.budget, queryGrants: state().queries }, null, 2));
    console.log(`PASS: ${phase} preserves reference publication, cursor order, original charges, native delivery and stable retry`);
    await h.dispose(); await runtime.shutdown.shutdown(0);
  }
} catch (error) { console.error(error); if (runtime) await runtime.shutdown.shutdown(1); process.exitCode = 1; }
finally { clearTimeout(timer); }
