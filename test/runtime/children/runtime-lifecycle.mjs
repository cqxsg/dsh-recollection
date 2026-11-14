import assert from 'node:assert/strict';
import { copyFile, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadLayeredEnv } from '@deepseek-ai/dsh-app-boot';
import { runProfile } from '@deepseek-ai/dsh/profile-boot';
import * as timeoutPolicy from '@deepseek-ai/dsh-tool-call-timeout-policy';
import * as plugin from '../../../lib/index.js';
import { recallHarness } from '../../../support/fixtures/recall-harness.mjs';
import { recovery } from '../../../support/fixtures/scripted-model.mjs';
import { deferred, replace } from '../../../support/fixtures/control.mjs';

const mode = process.argv[2], root = join(process.env.DSH_HOME, '..');
let runtime, h, mount;
try {
  runtime = await runProfile({ environment: loadLayeredEnv('recall-lifecycle'), profile: 'web', patchFiles: [process.argv[3]], args: ['--host', '127.0.0.1', '--port', '0', '--no-open'] });
  const ctx = runtime.ctx, config = plugin.Config({ prewarm: false, ...(mode === 'recover' ? { recall: { searches: 99, shared: 99, freePages: 99 } } : {}) });
  mount = await ctx.plugin(plugin, config); h = recallHarness(ctx);
  assert.equal(ctx.recallPages.status.prewarm.state, 'disabled');
  const state = agent => ctx.recallBudget.state(plugin.currentInteraction(agent.session));
  if (mode === 'create') {
    const { agent } = await h.seed('runtime-combined', Array.from({ length: 18 }, (_, i) => `needle ${i} ` + '中文😀'.repeat(170)));
    const search = ctx.recallTools.search;
    await [...ctx.registry.get(timeoutPolicy).fibers].find(f => f.state === 2).dispose();
    try { assert.equal((await h.search(agent)).data.error.code, 'timeout_policy_unavailable'); assert.equal(state(agent), undefined); }
    finally { await ctx.plugin(timeoutPolicy); }
    assert.equal(ctx.recallTools.search, search);
    const path = join(process.cwd(), 'repaired-worker.exe'), matcher = new plugin.NativeMatcher(path), restore = replace(search, 'matcher', matcher);
    let first;
    try {
      const failed = await h.search(agent, recovery()); assert.equal(failed.value?.code, 'worker_unavailable', JSON.stringify(failed));
      await copyFile(new URL('../../../lib/native/worker.exe', import.meta.url), path);
      first = (await h.search(agent, recovery())).value; assert.equal(first.status, 'ok'); assert.ok(first.nextCursor);
      assert.equal(ctx.recallTools.search, search); assert.equal(state(agent).actualCalls, 2); assert.equal(state(agent).shared, 10);
      const fail = replace(search, 'run', async () => { throw new Error('Injected combined page failure'); });
      try { assert.equal((await h.next(agent, first.nextCursor)).value.code, 'execution_failed'); } finally { fail(); }
      const raw = search.run.bind(search), gate = deferred(); let entered = 0, timedOut = false;
      const undo = replace(search, 'run', async (...args) => { entered++; await gate.promise; return raw(...args); });
      const off = ctx.on('tools/execute', async (exec, next) => { const result = await next(); if (exec.agent?.id === agent.id && result.value?.code === 'page_in_flight') gate.resolve(); return result; });
      const timer = setTimeout(() => { timedOut = true; gate.resolve(); }, 5000);
      try {
        const results = await h.drive(agent, [0, 1].map(() => ({ name: 'recall_search', args: { action: 'next', cursor: first.nextCursor } })));
        assert.equal(timedOut, false); assert.equal(entered, 1);
        assert.equal(results.filter(r => r.value.status === 'ok').length, 1); assert.equal(results.filter(r => r.value.code === 'page_in_flight').length, 1);
      } finally { clearTimeout(timer); gate.resolve(); undo(); await off(); }
      assert.equal(state(agent).actualCalls, 5); assert.equal(state(agent).shared, 9); assert.equal(state(agent).queries[0].free, 0); assert.equal(state(agent).paidPages, 1);
    } finally { restore(); await matcher.dispose(); assert.equal(matcher.children.size, 0); }
    const beforeReload = state(agent), oldMemory = ctx.recallMemory.budget;
    await mount.dispose(); mount = await ctx.plugin(plugin, config);
    assert.deepEqual(state(agent), beforeReload); assert.equal(oldMemory.stats().pins, 0); assert.equal(oldMemory.stats().usedBytes, 0);
    assert.equal((await h.read(agent, first.items[0].ref)).value.status, 'ok');
    const rebuilt = (await h.search(agent, recovery())).value; assert.equal(rebuilt.status, 'ok'); assert.ok(rebuilt.nextCursor);
    const ledger = state(agent); assert.equal(ledger.actualCalls, 7); assert.equal(ledger.shared, 7); assert.equal(ledger.queries[0].free, 0); assert.equal(ledger.closed, false);
    await ctx.sessions.flush(agent.session);
    await writeFile(join(root, 'before-restart.json'), JSON.stringify({ pid: process.pid, beforeReload, ledger, cursor: rebuilt.nextCursor, ref: rebuilt.items[0].ref }, null, 2));
  } else {
    const before = JSON.parse(await readFile(join(root, 'before-restart.json'), 'utf8'));
    const handle = await ctx.agents.resume({ resumeSessionId: 'runtime-combined', agentOptions: h.model.options }); h.agents.push(handle);
    const { agent } = handle;
    assert.deepEqual(state(agent), before.ledger, 'Host restart retains old limits, charges and grants despite larger new defaults');
    assert.equal((await h.next(agent, before.cursor)).value.code, 'stale_reference');
    assert.equal((await h.read(agent, before.ref)).value.status, 'ok');
    const ledger = state(agent); assert.equal(ledger.actualCalls, 9); assert.equal(ledger.shared, 5); assert.equal(ledger.queries[0].free, 0); assert.equal(ledger.closed, false);
    await writeFile(join(root, 'after-restart.json'), JSON.stringify({ pid: process.pid, ledger }, null, 2));
  }
  const memory = ctx.recallMemory.budget, matcher = ctx.recallTools.search.matcher;
  await h.dispose(); h = undefined; await mount.dispose(); mount = undefined;
  assert.equal(memory.stats().pins, 0); assert.equal(memory.stats().usedBytes, 0); assert.equal(matcher.children.size, 0);
} finally { await h?.dispose(); await mount?.dispose(); await runtime?.shutdown.shutdown(0); }
