import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadLayeredEnv } from '@deepseek-ai/dsh-app-boot';
import { runProfile } from '@deepseek-ai/dsh/profile-boot';
import { currentInteraction } from '../../../lib/index.js';
import { recallHarness } from '../../../support/fixtures/recall-harness.mjs';
import { human } from '../../../support/fixtures/scripted-model.mjs';
import { replace } from '../../../support/fixtures/control.mjs';

const timer = setTimeout(() => process.exit(1), 55000);
let runtime;
try {
  runtime = await runProfile({ environment: loadLayeredEnv('recall-feedback-recovery', process.cwd()), profile: 'web', patchFiles: [process.argv[2]], args: ['--host', '127.0.0.1', '--port', '0', '--no-open'] });
  // Web startup can finish while this plugin is still loading its persistent state.
  await [...runtime.ctx.loader.entries()].find(entry => entry.options.id === 'recall')?.fiber.await();
  const ctx = runtime.ctx, [mode, phase] = process.argv[3].split(':'), id = `feedback-${phase}`, callId = `first-${phase}`;
  const hidden = phase.endsWith('hidden'), closed = phase.endsWith('closed'), regex = phase.startsWith('regex');
  const reference = phase.includes('reference'), tool = reference ? 'recall_read' : 'recall_search';
  const args = reference ? { action: 'read', ref: 'broken' } : regex ? { action: 'search', mode: 'regex', patterns: ['['] } : { action: 'search', mode: 'wrong', patterns: ['needle'] };
  let agent;
  const checkpoint = async () => {
    const delivered = agent.session.snapshotEvents().filter(e => e.type === 'tool/result' && !e.data.message.isError && e.data.message.content[0]?.text?.includes('"status":"error"')).length;
    process.send({ checkpoint: phase, pid: process.pid, id, callId, delivered }); await new Promise(() => {});
  };
  if (mode === 'crash' && hidden) {
    const backend = ctx.storage.backend.get('json'), open = backend.kv.open.bind(backend.kv);
    const restore = replace(backend.kv, 'open', async descriptor => {
      const unit = await open(descriptor);
      if (descriptor.name === 'dsh_recall_business') {
        const put = unit.putRecord.bind(unit);
        replace(unit, 'putRecord', async (table, key, value) => {
          await put(table, key, value);
          if (value.sessionId === id && value.calls.at(-1).invalidKey) await checkpoint();
        });
      }
      return unit;
    });
    try { await [...ctx.loader.entries()].find(e => e.options.id === 'recall').fiber.restart(); } finally { restore(); }
  }
  const h = recallHarness(ctx), invalid = () => ({ name: tool, args });
  await h.ready();
  if (mode === 'crash') {
    agent = (await h.seed(id)).agent;
    const first = (await h.drive(agent, [{ ...invalid(), id: callId }], human('feedback recovery')))[0].value;
    assert.equal(first.budget.closed, false);
    if (closed) assert.equal((await h.drive(agent, [invalid()]))[0].value.budget.closed, true);
    await ctx.sessions.flush(agent.session); await checkpoint();
  } else {
    const checkpoint = JSON.parse(await readFile(join(process.env.DSH_HOME, '..', `checkpoint-${phase}.json`), 'utf8'));
    const stored = ctx.recallBudget.records().find(r => r.sessionId === id); assert.ok(stored);
    assert.equal(stored.shared, closed ? 10 : 11); assert.equal(stored.limits.shared, 12); assert.equal(stored.searches, reference ? 6 : closed ? 4 : 5);
    assert.equal(stored.closed, closed); assert.equal(stored.calls[0].state, 'failed'); assert.equal(stored.queries.length, 0);
    assert.equal(!!stored.calls[0].invalidKey, reference || !phase.startsWith('legacy-'));
    const handle = await ctx.agents.resume({ resumeSessionId: id, agentOptions: h.model.options }); h.agents.push(handle); agent = handle.agent;
    assert.equal(currentInteraction(agent.session).interactionId, stored.interactionId);
    if (hidden) assert.ok(agent.session.snapshotEvents().some(e => e.type === 'turn/end' && e.data.reason.kind === 'interrupted'));
    const replay = await ctx.tools.execute({ name: tool, callId, arguments: args, agent, signal: new AbortController().signal });
    assert.equal(replay.isError, true);
    if (closed) assert.match(replay.error.message, /Recall is closed/);
    else assert.equal(replay.error.info?.code, 'call_replay');
    assert.deepEqual(ctx.recallBudget.state(currentInteraction(agent.session)), stored);
    const results = [];
    if (!closed) {
      if (reference) {
        const changed = (await h.drive(agent, [{ name: tool, args: { ...args, ref: 'different-broken-reference' } }]))[0].value;
        assert.equal(changed.code, 'stale_reference'); assert.equal(changed.budget.closed, false, 'different inputs cannot inherit the legacy warning');
        results.push(changed);
      }
      if (regex) results.push((await h.drive(agent, [{ name: 'recall_search', args: { ...args, patterns: ['(?=needle)'] } }]))[0].value);
      else results.push((await h.drive(agent, [invalid()]))[0].value);
      assert.equal(results.at(-1).budget.closed, !(hidden || regex));
      if (hidden || regex) {
        results.push((await h.drive(agent, [{ name: tool, args: regex ? { ...args, patterns: ['unrelated', '['] } : args }]))[0].value);
        assert.equal(results.at(-1).budget.closed, true);
      }
    }
    const continued = ctx.recallBudget.state(currentInteraction(agent.session));
    assert.equal(continued.shared, stored.shared - results.length); assert.equal(continued.closed, true); assert.equal(continued.limits.shared, 12);
    assert.equal(ctx.tools.schemas(agent).some(t => t.name === 'recall_search' || t.name === 'recall_read'), false);
    const fresh = (await h.search(agent, human('new interaction'))).value;
    assert.equal(fresh.status, 'ok'); assert.equal(fresh.budget.shared_remaining, 98); assert.equal(fresh.budget.search_remaining, 98);
    await writeFile(join(process.env.DSH_HOME, '..', `feedback-recovered-${phase}.json`), JSON.stringify({ checkpoint, restoredPid: process.pid, stored, continued, results, fresh: fresh.budget }, null, 2));
    console.log(`PASS: ${phase} preserves error causes, delivery ordering, charges, closure and old limits`);
  }
  await h.dispose(); await runtime.shutdown.shutdown(0);
} catch (error) { console.error(error); if (runtime) await runtime.shutdown.shutdown(1); process.exitCode = 1; }
finally { clearTimeout(timer); }
