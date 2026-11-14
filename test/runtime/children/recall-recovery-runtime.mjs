import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadLayeredEnv } from '@deepseek-ai/dsh-app-boot';
import { runProfile } from '@deepseek-ai/dsh/profile-boot';
import { currentInteraction } from '../../../lib/index.js';
import { recallHarness } from '../../../support/fixtures/recall-harness.mjs';
import { human, recovery } from '../../../support/fixtures/scripted-model.mjs';
import { replace } from '../../../support/fixtures/control.mjs';
const timer = setTimeout(() => process.exit(1), 90000);
let runtime;
try {
  runtime = await runProfile({ environment: loadLayeredEnv('recall-process-recovery', process.cwd()), profile: 'web', patchFiles: [process.argv[2]], args: ['--host', '127.0.0.1', '--port', '0', '--no-open'] });
  // Web startup can finish while this plugin is still loading its persistent state.
  await [...runtime.ctx.loader.entries()].find(entry => entry.options.id === 'recall')?.fiber.await();
  const ctx = runtime.ctx, [mode, phase] = process.argv[3].split(':'), id = `product-crash-${phase}`, target = `crash-${phase}`;
  let actions = 0, baseline = 0, pageMeta;
  if (mode === 'crash') {
    const backend = ctx.storage.backend.get('json'), open = backend.kv.open.bind(backend.kv);
    const restore = replace(backend.kv, 'open', async descriptor => {
      const unit = await open(descriptor);
      if (descriptor.name === 'dsh_recall_business') {
        const put = unit.putRecord.bind(unit);
        replace(unit, 'putRecord', async (table, key, value) => {
          await put(table, key, value);
          const call = value.calls.at(-1);
          if (value.sessionId === id && ((phase === 'reserved' && call.callId === target && call.state === 'reserved')
            || (phase === 'completed' && call.callId === target && call.state === 'completed')
            || (phase === 'last-r' && call.callId.startsWith(target) && call.state === 'reserved' && value.shared === 0))) {
            process.send({ checkpoint: phase, pid: process.pid, actions: actions - baseline, id, callId: call.callId, ...pageMeta }); await new Promise(() => {});
          }
        });
      }
      return unit;
    });
    try { await [...ctx.loader.entries()].find(e => e.options.id === 'recall').fiber.restart(); } finally { restore(); }
    const search = ctx.recallTools.search.run.bind(ctx.recallTools.search), read = ctx.recallTools.read.run.bind(ctx.recallTools.read);
    replace(ctx.recallTools.search, 'run', async (...args) => {
      actions++; const page = await search(...args);
      if (args[1].agent.id === id) pageMeta = { ref: page.result.items[0]?.ref, cursor: page.result.nextCursor, query: page.query };
      if (phase === 'page' && args[1].callId === target) { process.send({ checkpoint: phase, pid: process.pid, actions: actions - baseline, id, callId: target, ...pageMeta }); await new Promise(() => {}); }
      return page;
    });
    replace(ctx.recallTools.read, 'run', (...args) => { actions++; return read(...args); });
    if (phase === 'delivery') ctx.on('tools/post-execute', async (exec, result, next) => {
      const decision = await next();
      if (exec.callId === target) { assert.equal(result.isError, false); process.send({ checkpoint: phase, pid: process.pid, actions: actions - baseline, id, callId: target, ...pageMeta }); await new Promise(() => {}); }
      return decision;
    });
  }
  const h = recallHarness(ctx);
  await h.ready();
  let agent;
  if (mode === 'crash') {
    agent = (await h.seed(id, Array.from({ length: 12 }, (_, i) => `needle ${i} ` + 'original😀'.repeat(130)))).agent;
    if (phase === 'last-r') {
      const first = (await h.search(agent)).value; pageMeta = { ref: first.items[0].ref, cursor: first.nextCursor, query: ctx.recallBudget.state(currentInteraction(agent.session)).calls.at(-1).query };
      for (let i = 0; i < 10; i++) await h.read(agent, first.items[0].ref);
      baseline = actions;
      await h.drive(agent, ['a', 'b'].map(suffix => ({ id: target + suffix, name: 'recall_read', args: { action: 'read', ref: first.items[0].ref } })));
    } else await h.drive(agent, [{ id: target, name: 'recall_search', args: { action: 'search', mode: 'literal', patterns: ['needle'] } }], human('crash search'));
    assert.fail('parent must terminate the child at the checkpoint');
  } else {
    const checkpoint = JSON.parse(await readFile(join(process.env.DSH_HOME, '..', `checkpoint-${phase}.json`), 'utf8'));
    const stored = ctx.recallBudget.records().find(r => r.sessionId === id); assert.ok(stored);
    assert.equal(stored.limits.shared, 12); assert.equal(stored.shared, phase === 'last-r' ? 0 : 11);
    const expectedState = ['completed', 'delivery'].includes(phase) ? 'completed' : 'reserved'; assert.equal(stored.calls.at(-1).state, expectedState);
    assert.equal(stored.queries[0]?.free ?? 0, ['completed', 'delivery', 'last-r'].includes(phase) ? 2 : 0);
    const handle = await ctx.agents.resume({ resumeSessionId: id, agentOptions: h.model.options }); h.agents.push(handle); agent = handle.agent;
    assert.equal(currentInteraction(agent.session).interactionId, stored.interactionId);
    assert.ok(agent.session.snapshotEvents().some(e => e.type === 'turn/end' && e.data.reason.kind === 'interrupted'));
    const args = phase === 'last-r' ? { action: 'read', ref: checkpoint.ref } : { action: 'search', mode: 'literal', patterns: ['needle'] };
    const replay = await ctx.tools.execute({ name: phase === 'last-r' ? 'recall_read' : 'recall_search', callId: checkpoint.callId, arguments: args, agent, signal: new AbortController().signal });
    assert.equal(replay.isError, true); assert.ok(['call_replay', 'UNKNOWN_TOOL'].includes(replay.error.info?.code));
    assert.deepEqual(ctx.recallBudget.state(currentInteraction(agent.session)), stored);
    let ref = checkpoint.ref, continuation;
    if (phase !== 'last-r') {
      if (ref) { const original = await h.read(agent, ref); assert.equal(original.value.status, 'ok'); }
      const rebuilt = (await h.search(agent, recovery())).value; assert.equal(rebuilt.status, 'ok'); assert.equal(rebuilt.budget.query_pages_remaining, 2);
      if (checkpoint.query) assert.equal(ctx.recallBudget.state(currentInteraction(agent.session)).calls.at(-1).query, checkpoint.query);
      ref = rebuilt.items[0].ref;
      continuation = ctx.recallBudget.state(currentInteraction(agent.session));
      assert.equal(continuation.limits.freePages, 2); assert.equal(continuation.queries.length, 1); assert.equal(continuation.searches, 4);
    } else { assert.equal(ctx.tools.schemas(agent).some(t => t.name === 'recall_search' || t.name === 'recall_read'), false); continuation = stored; }
    const fresh = await h.read(agent, ref, human('继续')); assert.equal(fresh.value.status, 'ok'); assert.equal(fresh.value.budget.shared_remaining, 98); assert.equal(fresh.value.budget.search_remaining, 99);
    await writeFile(join(process.env.DSH_HOME, '..', `product-recovered-${phase}.json`), JSON.stringify({ checkpoint, restoredPid: process.pid, stored, continuation, fresh: fresh.value.budget }, null, 2));
    console.log(`PASS: product ${phase} process recovery retains charges/grants, refuses replay and verifies old sources`);
  }
  await h.dispose(); await runtime.shutdown.shutdown(0);
} catch (error) { console.error(error); if (runtime) await runtime.shutdown.shutdown(1); process.exitCode = 1; }
finally { clearTimeout(timer); }
