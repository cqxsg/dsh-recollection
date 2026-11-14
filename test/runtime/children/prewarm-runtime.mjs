import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadLayeredEnv } from '@deepseek-ai/dsh-app-boot';
import { runProfile } from '@deepseek-ai/dsh/profile-boot';
import * as typert from '@deepseek-ai/dsh-typert-registry';
import { recallHarness } from '../../../support/fixtures/recall-harness.mjs';
import { human } from '../../../support/fixtures/scripted-model.mjs';
import { deferred, replace } from '../../../support/fixtures/control.mjs';

const mode = process.argv[2];
let optionalLoads = 0;
const coreUrl = new URL('../../../lib/index.js', import.meta.url).href;
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL === coreUrl && specifier.includes('dsh-typert')) throw new Error('Core resolved a Typert dependency');
  if (context.parentURL === coreUrl && specifier.endsWith('/prewarm.js')) {
    optionalLoads++;
    if (mode === 'off' || mode === 'remote-missing') throw new Error('Injected missing optional Remote module');
  }
  return next(specifier, context);
} });
const { Config, currentInteraction } = await import(coreUrl);
const plugin = await import(coreUrl);
const until = async fn => { const limit = performance.now() + 15_000; while (!fn()) { assert.ok(performance.now() < limit, 'prewarm condition timeout'); await new Promise(r => setTimeout(r, 10)); } };
let runtime, h, mount, restore;
try {
  runtime = await runProfile({ environment: loadLayeredEnv('recall-prewarm'), profile: 'web', patchFiles: [process.argv[3]], args: ['--host', '127.0.0.1', '--port', '0', '--no-open'] });
  // Web startup can finish while this plugin is still loading its persistent state.
  await [...runtime.ctx.loader.entries()].find(entry => entry.options.id === 'recall')?.fiber.await();
  const ctx = mode === 'typert-absent' ? runtime.ctx.isolate('typert') : runtime.ctx;
  if (mode === 'typert-absent') assert.equal(ctx.get('typert'), undefined, 'Recall scope has no Typert service');
  if (mode === 'init-failure') restore = replace(ctx.typert, 'register', () => { throw new Error('Injected Remote registration failure'); });
  mount = await ctx.plugin(plugin, Config({ prewarm: mode !== 'off' }));
  assert.ok(ctx.recallTools); assert.ok(ctx.recallPreparation); assert.ok(ctx.recallPages);
  assert.equal(ctx.recallPages.status.prewarm.state, { off: 'disabled', 'remote-missing': 'failed', 'typert-absent': 'unavailable', 'init-failure': 'failed', default: 'available' }[mode]);
  assert.equal(ctx.recallPages.status.pageReportsAvailable, mode === 'default');
  if (mode === 'off') assert.equal(optionalLoads, 0);
  if (mode.endsWith('failure') || mode === 'remote-missing') assert.match(ctx.recallPages.status.prewarm.reason, /Injected/);
  h = recallHarness(ctx);
  await writeFile('optional-reference.txt', 'historical file content');
  const { agent } = await h.seed(`prewarm-${mode}`, ['needle @optional-reference.txt']);
  const { agent: unrelated } = await h.seed(`unrelated-${mode}`, ['unrelated history']);
  assert.equal(ctx.recallPreparation.status(agent.id), undefined, 'no Client report has warmed history');
  await ctx.recallAttachments.idleAdmissions();
  await until(() => ctx.recallHashes.records().some(r => r.source.sessionId === agent.id && r.state === 'saved'));
  assert.equal(ctx.recallPreparation.status(agent.id), undefined, 'independent hash sampling does not require page history preparation');
  const found = (await h.search(agent)).value; assert.equal(found.status, 'ok');
  assert.equal(ctx.recallPreparation.status(unrelated.id), undefined, 'real call prepares only its executing session');
  const item = found.items[0]; assert.equal((await h.read(agent, item.ref)).value.status, 'ok');
  const [attachment] = await h.drive(agent, [{ name: 'recall_read', args: { action: 'read', ref: item.ref, target: 'attachments', attachments: item.attachments.map(f => f.ref) } }]);
  assert.equal(attachment.value.attachmentResults[0].state, 'accessible'); assert.equal(attachment.value.attachmentResults[0].version.state, 'same');
  const [invalid] = await h.drive(agent, [{ name: 'recall_search', args: {} }]); assert.equal(invalid.value.code, 'invalid_arguments');
  const search = ctx.recallTools.search, entries = ctx.recallPreparation.entries, memory = ctx.recallMemory.budget;
  const ledger = ctx.recallBudget.state(currentInteraction(agent.session));
  restore?.(); restore = undefined;
  if (mode === 'remote-missing') {
    hooks.deregister();
    await ctx.plugin(await import(new URL('../../../lib/prewarm.js', import.meta.url)));
  }
  if (mode === 'typert-absent') await ctx.plugin(typert.default);
  else if (mode === 'init-failure') {
    const prewarm = await import(new URL('../../../lib/prewarm.js', import.meta.url));
    await [...ctx.registry.get(prewarm).fibers][0].restart();
  }
  if (['default', 'remote-missing', 'typert-absent', 'init-failure'].includes(mode)) {
    await until(() => ctx.recallPages.status.pageReportsAvailable);
    const prewarm = await import(new URL('../../../lib/prewarm.js', import.meta.url));
    const remote = [...ctx.registry.get(prewarm.RecallHostService).fibers].find(f => f.state === 2);
    await remote.dispose(); assert.equal(ctx.recallPages.status.pageReportsAvailable, false);
    assert.deepEqual(ctx.recallPages.snapshot(), []);
    assert.equal(ctx.recallTools.search, search); assert.equal(ctx.recallPreparation.entries, entries); assert.equal(ctx.recallMemory.budget, memory);
    assert.deepEqual(ctx.recallBudget.state(currentInteraction(agent.session)), ledger);
    assert.equal((await h.read(agent, item.ref)).value.status, 'ok');
    await ctx.plugin(prewarm.RecallHostService); assert.equal(ctx.recallPages.status.pageReportsAvailable, true);
    assert.equal(ctx.recallTools.search, search);
  }
  if (mode === 'off') {
    await mount.dispose();
    mount = await ctx.plugin(plugin, Config({ prewarm: false }));
    assert.deepEqual(ctx.recallBudget.state(currentInteraction(agent.session)), ledger);
    assert.equal((await h.read(agent, item.ref)).value.status, 'ok');
    assert.equal(optionalLoads, 0);
  }
  if (mode === 'default') {
    const read = ctx.recallTools.read, entered = deferred();
    const oldRow = ctx.recallBudget.state(currentInteraction(agent.session));
    const undo = replace(read, 'run', async (_request, _exec, _reservation, timeline) => {
      entered.resolve(); await new Promise(resolve => timeline.signal.addEventListener('abort', resolve, { once: true })); timeline.check();
    });
    try {
      const pending = h.read(agent, item.ref); await entered.promise;
      await mount.dispose(); mount = undefined;
      assert.equal((await pending).value.code, 'recall_unloaded');
      mount = await ctx.plugin(plugin, Config({ prewarm: false }));
      assert.equal(ctx.recallPages.status.prewarm.state, 'disabled');
      assert.equal(ctx.recallBudget.state(currentInteraction(agent.session)).shared, oldRow.shared - 1);
      assert.equal((await h.read(agent, item.ref)).value.status, 'ok');
    } finally { undo(); }
  }
  assert.equal((await h.search(agent, human('new interaction after optional lifecycle'))).value.status, 'ok');
  await writeFile(join(process.env.DSH_HOME, '..', 'prewarm-evidence.json'), JSON.stringify({ mode, optionalLoads, status: ctx.recallPages.status, hashRows: ctx.recallHashes.records().length, calls: ctx.recallBudget.records().map(r => ({ sessionId: r.sessionId, actualCalls: r.actualCalls, shared: r.shared })) }, null, 2));
  await h.dispose(); h = undefined;
  const matcher = ctx.recallTools.search.matcher;
  await mount.dispose(); mount = undefined;
  assert.equal(memory.stats().pins, 0); assert.equal(memory.stats().usedBytes, 0); assert.equal(matcher.children.size, 0);
  assert.equal(ctx.get('recallPages'), undefined); assert.equal(ctx.get('recallPreparation'), undefined);
} finally { restore?.(); await h?.dispose(); await mount?.dispose(); await runtime?.shutdown.shutdown(0); hooks.deregister(); }
