import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadLayeredEnv } from '@deepseek-ai/dsh-app-boot';
import { runProfile } from '@deepseek-ai/dsh/profile-boot';
import * as plugin from '../../../lib/index.js';
import { recallHarness } from '../../../support/fixtures/recall-harness.mjs';
import { deferred, replace } from '../../../support/fixtures/control.mjs';
import { human } from '../../../support/fixtures/scripted-model.mjs';

const mode = process.argv[2], gate = deferred(), entered = deferred(), restores = [];
const until = async fn => { const end = performance.now() + 10000; while (!fn()) { assert.ok(performance.now() < end, 'capability condition timeout'); await new Promise(r => setTimeout(r, 5)); } };
let runtime, mount, h, active = 0, maxActive = 0, extraHashStarted = false, cancelExtra;
try {
  runtime = await runProfile({ environment: loadLayeredEnv('recall-capabilities'), profile: 'web', patchFiles: [process.argv[3]], args: ['--host', '127.0.0.1', '--port', '0', '--no-open'] });
  const ctx = mode === 'prompt-absent' ? runtime.ctx.isolate('systemPrompt') : runtime.ctx;
  if (mode === 'prompt-absent') assert.equal(ctx.get('systemPrompt'), undefined);
  if (['hash-init-failure', 'hash-init-paused', 'diagnostic-failure'].includes(mode)) {
    const open = ctx.storageDomain.open.bind(ctx.storageDomain);
    restores.push(replace(ctx.storageDomain, 'open', async spec => {
      if (spec.name === (mode === 'diagnostic-failure' ? 'dsh_recall_diagnostics' : 'dsh_recall_hashes')) {
        entered.resolve();
        if (mode === 'hash-init-paused') await gate.promise;
        throw new Error('Injected optional domain failure');
      }
      return open(spec);
    }));
  }
  if (mode === 'prompt-failure') {
    const section = ctx.systemPrompt.section.bind(ctx.systemPrompt);
    restores.push(replace(ctx.systemPrompt, 'section', spec => { if (spec.name === 'recall:usage') throw new Error('Injected extra guidance failure'); return section(spec); }));
  }
  if (mode === 'visibility-failure') {
    const restrict = ctx.tools.restrict;
    restores.push(replace(ctx.tools, 'restrict', function(spec) { if (spec.deny?.some(name => name.startsWith('recall_'))) throw new Error('Injected visibility failure'); return restrict.call(this, spec); }));
  }
  if (mode === 'hash-paused') {
    const read = ctx.fs.readByteRange.bind(ctx.fs);
    restores.push(replace(ctx.fs, 'readByteRange', async (target, range, signal) => {
      if (ctx.fs.processPath(target) === join(process.cwd(), 'optional.txt')) {
        active++; maxActive = Math.max(maxActive, active); entered.resolve();
        try { await gate.promise; signal.throwIfAborted(); }
        finally { active--; }
      }
      return read(target, range, signal);
    }));
  }
  mount = await ctx.plugin(plugin, plugin.Config({ prewarm: false, attachmentHashing: mode !== 'hash-off', diagnostics: mode === 'diagnostic-failure' }));
  assert.ok(ctx.recallTools); assert.ok(ctx.recallPreparation);
  if (mode.includes('init') || mode === 'diagnostic-failure') await entered.promise;
  if (mode === 'diagnostic-failure') assert.equal(ctx.get('recallDiagnostics'), undefined);
  if (!['hash-off', 'hash-init-failure', 'hash-init-paused'].includes(mode)) await until(() => ctx.get('recallAttachments'));
  else assert.equal(ctx.get('recallHashes'), undefined);
  const search = ctx.recallTools.search;
  await writeFile('optional.txt', 'historical attachment');
  h = recallHarness(ctx);
  const { agent } = await h.seed(`capability-${mode}`, ['needle @optional.txt']);
  if (mode === 'hash-paused') {
    await entered.promise;
    cancelExtra = ctx.recallPreparation.scheduleHash('extra-probe', agent.id, async () => { extraHashStarted = true; return true; }, () => {});
  }
  if (mode === 'hash-read-failure') {
    await ctx.recallAttachments.idleAdmissions();
    await until(() => ctx.recallHashes.records().some(r => r.state === 'saved'));
    restores.push(replace(ctx.recallHashes, 'get', () => { throw new Error('Injected baseline lookup failure'); }));
  }
  const found = await h.search(agent);
  assert.equal(found.value?.status, 'ok', JSON.stringify(found));
  if (mode === 'prompt-failure' || mode === 'prompt-absent') assert.equal(h.model.requests.some(r => r.sessionId === agent.id && r.hasRecallUsage), false);
  const ref = found.value.items[0].ref;
  assert.equal((await h.read(agent, ref)).value.status, 'ok');
  if (mode === 'hash-paused') {
    assert.equal(active, 1, 'history and text read complete while hash provider remains pending');
    assert.equal(extraHashStarted, false, 'never start a second background hash batch');
    let disposed = false;
    const disposing = mount.dispose().then(() => { disposed = true; });
    await new Promise(r => setTimeout(r, 30)); assert.equal(disposed, false, 'unload retains real I/O ownership');
    gate.resolve(); await disposing; mount = undefined;
    assert.equal(active, 0); assert.equal(maxActive, 1);
  } else {
    if (['hash-off', 'hash-init-failure', 'hash-init-paused', 'hash-read-failure'].includes(mode)) {
      const item = found.value.items[0];
      const [result] = await h.drive(agent, [{ name: 'recall_read', args: { action: 'read', ref, target: 'both', attachments: item.attachments.map(a => a.ref) } }]);
      assert.equal(result.value.status, 'ok'); assert.match(result.value.items[0].content, /needle/);
      assert.equal(result.value.attachmentResults[0].state, 'accessible');
      assert.deepEqual(result.value.attachmentResults[0].version, { state: 'unverified', reason: 'baseline_unavailable' });
    }
    if (mode === 'visibility-failure') {
      for (let i = 0; i < 2; i++) {
        const [result] = await h.drive(agent, [{ name: 'recall_search', args: {} }]);
        assert.equal(result.value.code, 'invalid_arguments');
      }
      assert.equal(ctx.recallBudget.state(plugin.currentInteraction(agent.session)).closed, true);
      const before = ctx.recallBudget.state(plugin.currentInteraction(agent.session)).actualCalls;
      const denied = await h.read(agent, ref); assert.equal(denied.data.message.isError, true);
      assert.equal(ctx.recallBudget.state(plugin.currentInteraction(agent.session)).actualCalls, before);
      assert.equal((await h.search(agent, human('new interaction'))).value.status, 'ok');
    }
    assert.equal(ctx.recallTools.search, search, 'optional failures never rebuilt core');
  }
  await writeFile(join(process.env.DSH_HOME, '..', 'capabilities-evidence.json'), JSON.stringify({ mode, search: found.value.status, read: 'ok', active, maxActive, extraHashStarted }, null, 2));
} finally {
  gate.resolve(); cancelExtra?.(); restores.reverse().forEach(restore => restore());
  await h?.dispose(); await mount?.dispose(); await runtime?.shutdown.shutdown(0);
}
