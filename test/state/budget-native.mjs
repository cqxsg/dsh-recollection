import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { RecallBudgetService, RecallCallController, CallTimeline, loadRecallConfig, currentInteraction, nativeSchema, recallResult, renderRecall, RecallError } from '../../lib/index.js';
import { scriptedModel, human, recovery } from '../../support/fixtures/scripted-model.mjs';
import { deferred, replace } from '../../support/fixtures/control.mjs';

export async function verifyBudget(ctx) {
  const cases = [], order = [], model = scriptedModel(ctx);
  const config = loadRecallConfig();
  let actionCount = 0, actionHook = async () => {}, mount;
  const check = async (label, fn) => { await fn(); cases.push(label); console.log(`PASS: ${label}`); };
  async function install(cfg = config) {
    mount = await ctx.plugin({ name: 'isolated-recall-budget-probe', inject: ['tools'], async apply(parent) {
      await parent.plugin(RecallBudgetService, cfg);
      await parent.inject(['recallBudget', 'tools'], scope => {
      let controller;
      for (const name of ['recall_search', 'recall_read']) scope.tools.register({
        name, parameters: { type: 'object', properties: { action: { type: 'string' } }, required: ['action'], additionalProperties: true },
        timeoutMs: cfg.outerMs, description: 'Isolated budget probe', isConcurrencySafe: () => true,
        output: { schema: nativeSchema(recallResult), render: (_, value) => renderRecall(value) },
        execute: (_, exec) => controller.body(exec),
      });
      controller = new RecallCallController(scope, cfg, {
        names: new Map([['recall_search', 'search'], ['recall_read', 'read']]),
        next: request => request.cursor.startsWith('q:') ? { query: request.cursor.split(':')[1], page: request.cursor } : undefined,
        execute: async (request, exec, reservation, timeline) => {
          actionCount++; order.push('action'); await actionHook(exec, timeline); timeline.check();
          if (request.action === 'read' && request.ref === 'stale') throw new RecallError('stale_reference', 'The same source is missing.', true);
          if (request.action === 'read' && request.ref === 'temporary') throw Object.assign(new Error('temporary ordinary failure'), { code: 'EIO' });
          const query = request.action === 'search' ? request.patterns[0] : request.action === 'next' ? request.cursor.split(':')[1] : undefined;
          if (query && request.action === 'search') await scope.recallBudget.associate(reservation, query);
          return { result: { status: 'ok', items: [], budget: scope.recallBudget.summary(reservation.interaction, query), allowed_actions: [] }, ...(query ? { query, hasMore: true } : {}) };
        },
      });
      });
    } });
  }
  await install();
  const off = ctx.on('domain/changed', change => { if (change.domain === 'dsh_recall_business') order.push(change.value.calls.at(-1).state); });
  const agents = [];
  async function agent(id) { const handle = await ctx.agents.create({ sessionId: id, agentOptions: model.options, meta: { cwd: process.cwd() } }); agents.push(handle); return handle.agent; }
  const search = patterns => ({ action: 'search', mode: 'literal', patterns });
  const read = ref => ({ action: 'read', ref });
  let serial = 0;
  async function drive(a, name, args, input = recovery(), count = 1) {
    const ids = Array.from({ length: count }, () => `budget-${++serial}`);
    model.replies.push({ calls: ids, name, args: JSON.stringify(args) }, {});
    a.followup(input); await a.whenIdle(); await ctx.sessions.flush(a.session);
    assert.equal(model.replies.length, 0);
    return ids.map(id => {
      const event = a.session.snapshotEvents().findLast(e => e.type === 'tool/result' && e.data.message.toolCallId === id);
      if (event.data.message.isError) return { nativeError: event.data.error, message: event.data.message };
      return JSON.parse(event.data.message.content[0].text);
    });
  }
  const state = a => ctx.recallBudget.state(currentInteraction(a.session));
  try {
    const a = await agent('budget-rules');
    await check('native direct pipeline persists before action; searches/reads/F/paid-pages use authoritative balances', async () => {
      const [first] = await drive(a, 'recall_search', search(['A']), human('begin'));
      assert.deepEqual(order.slice(0, 2), ['reserved', 'action']);
      assert.equal(first.budget.search_remaining, 5); assert.equal(first.budget.shared_remaining, 11); assert.equal(first.budget.query_pages_remaining, 2);
      for (let i = 0; i < 2; i++) await drive(a, 'recall_search', { action: 'next', cursor: `q:A:${i}` });
      assert.equal(state(a).shared, 11); assert.equal(state(a).queries[0].free, 0);
      for (let i = 2; i < 4; i++) await drive(a, 'recall_search', { action: 'next', cursor: `q:A:${i}` });
      assert.equal(state(a).shared, 9); assert.equal(state(a).paidPages, 2);
      const [denied] = await drive(a, 'recall_search', { action: 'next', cursor: 'q:A:4' });
      assert.equal(denied.code, 'paid_pages_exhausted'); assert.equal(state(a).shared, 9);
      await drive(a, 'recall_read', read('valid'));
      assert.equal(state(a).shared, 8);
      await drive(a, 'recall_search', search(['A']));
      assert.equal(state(a).queries[0].free, 0, 'completion must not refresh an existing grant');
    });
    await check('schema-invalid calls are persisted/charged; second equivalent invalid closes only this interaction', async () => {
      const before = actionCount;
      const bad = await agent('budget-invalid');
      let [result] = await drive(bad, 'recall_search', { action: 'search', mode: 'wrong', patterns: ['x'] }, human('invalid'));
      assert.equal(result.code, 'invalid_arguments'); assert.equal(result.budget.shared_remaining, 11);
      const originalReason = result.message;
      [result] = await drive(bad, 'recall_search', { patterns: ['y'], mode: 'wrong', action: 'search', order: 'oldest' });
      assert.equal(result.budget.closed, true); assert.equal(actionCount, before);
      assert.ok(result.message.includes(originalReason), 'closure retains the parameter failure');
      assert.equal(result.message.match(/Recall closed after/g)?.length, 1);
      assert.equal(ctx.tools.schemas(bad).some(t => t.name === 'recall_read'), false);
      assert.equal(ctx.tools.schemas(a).some(t => t.name === 'recall_read'), true);
      const [fresh] = await drive(bad, 'recall_read', read('valid'), human('new interaction'));
      assert.equal(fresh.status, 'ok'); assert.equal(fresh.budget.shared_remaining, 11);
    });
    await check('different errors/corrections and normal execution failure/retry are not accumulated into closure', async () => {
      const b = await agent('budget-corrected');
      await drive(b, 'recall_search', { action: 'search', mode: 'wrong', patterns: ['x'] }, human('correct'));
      await drive(b, 'recall_read', read('stale'));
      await drive(b, 'recall_read', read('valid'));
      await drive(b, 'recall_read', read('temporary'));
      await drive(b, 'recall_read', read('temporary'));
      assert.equal(state(b).closed, false); assert.equal(state(b).shared, 7);
    });
    await check('search allowance denial preserves the independently detected parameter failure', async () => {
      const b = await agent('budget-denied-invalid');
      for (let i = 0; i < 6; i++) await drive(b, 'recall_search', search([`query-${i}`]), i ? recovery() : human('search allowance'));
      const before = actionCount;
      const [failed] = await drive(b, 'recall_search', { action: 'search', mode: 'wrong', patterns: ['invalid'] });
      assert.equal(failed.code, 'search_exhausted'); assert.equal(actionCount, before);
      assert.match(failed.message, /mode:/); assert.match(failed.message, /No search attempts remain/);
      assert.equal(failed.budget.shared_remaining, 6); assert.equal(failed.budget.closed, false);
    });
    await check('new interaction attaches old query with S/R and gets its own F once; old F does not transfer', async () => {
      const [first] = await drive(a, 'recall_search', { action: 'next', cursor: 'q:A:old' }, human('next cycle'));
      assert.equal(first.budget.search_remaining, 5); assert.equal(first.budget.shared_remaining, 11); assert.equal(first.budget.query_pages_remaining, 2);
      const [second] = await drive(a, 'recall_search', { action: 'next', cursor: 'q:A:other' });
      assert.equal(second.budget.search_remaining, 5); assert.equal(second.budget.query_pages_remaining, 1);
    });
    await check('same native call replay never executes or charges again; same arguments on new calls do charge', async () => {
      const row = state(a), call = row.calls[0], before = actionCount;
      const replay = await ctx.tools.execute({ name: call.name, callId: call.callId, arguments: { action: 'next', cursor: 'q:A:old' }, agent: a, signal: new AbortController().signal });
      assert.equal(replay.error.info.code, 'call_replay'); assert.equal(actionCount, before); assert.equal(state(a).actualCalls, row.actualCalls);
      await drive(a, 'recall_read', read('valid')); await drive(a, 'recall_read', read('valid'));
      assert.equal(state(a).shared, row.shared - 2);
    });
    await check('controlled monotonic deadline includes queue time; retries share one allowance and never begin after expiry', async () => {
      let now = 0, runs = 0;
      const clock = new CallTimeline(config, new AbortController().signal, () => now);
      try {
        await clock.retry(async () => { if (++runs === 1) throw Object.assign(new Error(), { code: 'EAGAIN' }); return true; });
        assert.equal(runs, 2);
        await assert.rejects(clock.retry(async () => { runs++; throw Object.assign(new Error(), { code: 'EBUSY' }); }));
        assert.equal(runs, 3);
        now = 55000;
        await assert.rejects(clock.retry(async () => { runs++; }), e => e.code === 'business_deadline'); assert.equal(runs, 3);
      } finally { clock.dispose(); }
    });
    await check('native PTC dispatch persists its own subcall and counts schema-invalid requests before execution', async () => {
      const b = await agent('budget-ptc');
      const unreg = ctx.tools.register(defineTool({ name: 'budget_transport', description: 'test transport', parameters: {},
        output: { schema: { type: 'boolean' }, render: (_, value) => [{ type: 'text', text: String(value) }] },
        execute: async (_, exec) => {
          const data = { rootCallId: exec.rootCallId, parentCallId: exec.callId, subCallId: `${exec.callId}:ptc:1`, name: 'recall_search', arguments: { action: 'search', mode: 'bad', patterns: ['x'] } };
          exec.agent.session.append('tool/ptc-dispatch-start', data);
          const result = await ctx.tools.execute({ name: data.name, callId: data.subCallId, arguments: data.arguments, rootCallId: exec.rootCallId, parent: exec.token, agent: exec.agent, signal: exec.signal });
          exec.agent.session.append('tool/ptc-dispatch', { ...data, content: result.content, isError: result.isError });
          assert.equal(result.value.code, 'invalid_arguments'); return true;
        },
      }));
      try {
        model.replies.push({ calls: ['budget-ptc-root'], name: 'budget_transport' }, {});
        b.followup(human('ptc')); await b.whenIdle();
        const r = state(b); assert.equal(r.calls.length, 1); assert.equal(r.calls[0].kind, 'ptc'); assert.equal(r.shared, 11);
      } finally { await unreg(); }
    });
    await check('raw malformed JSON and whitespace arguments retain native call identity and are charged before rejection', async () => {
      const b = await agent('budget-malformed');
      for (const [index, raw] of ['   ', '{'].entries()) {
        const id = `malformed-${index}`;
        model.replies.push({ calls: [id], name: 'recall_search', args: raw }, {});
        b.followup(index ? recovery() : human('malformed input')); await b.whenIdle();
        const event = b.session.snapshotEvents().findLast(e => e.type === 'tool/result' && e.data.message.toolCallId === id);
        assert.equal(event.data.message.isError, false, JSON.stringify(event.data));
        assert.equal(JSON.parse(event.data.message.content[0].text).code, 'invalid_arguments');
      }
      assert.equal(state(b).shared, 10); assert.equal(state(b).actualCalls, 2); assert.equal(state(b).closed, true);
    });
    await check('distinct read-argument causes do not merge and unrelated ref changes cannot correct an invalid scope', async () => {
      const b = await agent('budget-read-argument-causes');
      await drive(b, 'recall_read', { action: 'read', ref: '' }, human('read argument causes'));
      await drive(b, 'recall_read', { action: 'read', ref: 'valid', scope: 'invalid' });
      assert.equal(state(b).closed, false); assert.equal(state(b).shared, 10);
      const [again] = await drive(b, 'recall_read', { ref: 'different-but-unrelated', action: 'read', scope: 'invalid' });
      assert.equal(again.budget.closed, true); assert.equal(state(b).shared, 9);
    });
    async function writes(intercept, cfg = config) {
      await mount.dispose();
      const backend = ctx.storage.backend.get('json');
      const open = backend.kv.open.bind(backend.kv);
      const restore = replace(backend.kv, 'open', async descriptor => {
        const unit = await open(descriptor);
        if (descriptor.name === 'dsh_recall_business') {
          const put = unit.putRecord.bind(unit);
          replace(unit, 'putRecord', (table, key, value) => intercept(value, () => put(table, key, value)));
        }
        return unit;
      });
      try { await install(cfg); } finally { restore(); }
    }
    await check('reservation and completion persistence failures cannot authorize an unrecorded action or replay', async () => {
      let fail = true;
      await writes(async (value, next) => { if (fail && value.sessionId === 'budget-write-fault') { fail = false; throw new Error('EIO'); } return next(); });
      const b = await agent('budget-write-fault'), before = actionCount;
      const [result] = await drive(b, 'recall_read', read('valid'), human('fault'));
      assert.equal(result.nativeError.code, 'ledger_write_failed'); assert.equal(actionCount, before);
      assert.equal(state(b), undefined);
      let completion = true;
      await writes(async (value, next) => { if (completion && value.sessionId === 'budget-write-fault' && value.calls.at(-1).state === 'completed') { completion = false; throw new Error('EIO'); } return next(); });
      const [failed] = await drive(b, 'recall_read', read('valid'), human('completion fault'));
      assert.equal(failed.nativeError.code, 'ledger_write_failed'); assert.equal(state(b).calls[0].state, 'reserved');
      const c = state(b).calls[0];
      const replay = await ctx.tools.execute({ name: c.name, callId: c.callId, arguments: read('valid'), agent: b, signal: new AbortController().signal });
      assert.equal(replay.error.info.code, 'call_replay'); assert.equal(state(b).shared, 11);
    });
    await check('cancellation during an uninterruptible durable reservation waits and retains the charge', async () => {
      const entered = deferred(), release = deferred();
      await writes(async (value, next) => { if (value.sessionId === 'budget-write-cancel' && value.calls.at(-1).state === 'reserved') { entered.resolve(); await release.promise; } return next(); });
      const b = await agent('budget-write-cancel'), before = actionCount;
      model.replies.push({ calls: ['budget-write-cancel-call'], name: 'recall_read', args: JSON.stringify(read('valid')) });
      b.followup(human('cancel persist')); const pending = b.whenIdle(); await entered.promise; b.cancel({ kind: 'user' });
      let settled = false; void pending.then(() => { settled = true; }); await new Promise(resolve => setImmediate(resolve)); assert.equal(settled, false);
      release.resolve(); await pending;
      assert.equal(actionCount, before); assert.equal(state(b).shared, 11); assert.equal(state(b).calls[0].state, 'reserved');
      await writes((value, next) => next());
    });
    await check('native timeout starts adjacent to the component timeline and drains an intentionally uncooperative probe', async () => {
      await mount.dispose(); await install(loadRecallConfig({ prepareMs: 20, businessMs: 40, outerMs: 5040 }));
      const b = await agent('budget-timeout'), started = performance.now();
      actionHook = async (exec, timeline) => {
        await new Promise(resolve => timeline.signal.addEventListener('abort', resolve, { once: true }));
        assert.ok(timeline.elapsed() >= 30 && timeline.elapsed() < 1000);
        // Test-only: force the outer native deadline to demonstrate its replacement path.
        await new Promise(resolve => exec.signal.addEventListener('abort', resolve, { once: true }));
      };
      try {
        const [result] = await drive(b, 'recall_read', read('valid'), human('outer timeout'));
        assert.equal(result.nativeError.code, 'TOOL_TIMEOUT'); assert.ok(performance.now() - started >= 5000);
        assert.equal(state(b).shared, 11);
      } finally { actionHook = async () => {}; await mount.dispose(); await install(); }
    });
    await check('reloaded config cannot refill an existing interaction; concurrent last R only authorizes one body', async () => {
      const b = await agent('budget-last-shared');
      await drive(b, 'recall_search', search(['keep-F']), human('last R'));
      for (let i = 0; i < 10; i++) await drive(b, 'recall_read', read('valid'));
      assert.equal(state(b).shared, 1);
      await mount.dispose(); await install(loadRecallConfig({ shared: 99, searches: 99 }));
      const before = actionCount;
      const results = await drive(b, 'recall_read', read('valid'), recovery(), 2);
      assert.equal(actionCount, before + 1); assert.equal(state(b).shared, 0); assert.equal(state(b).limits.shared, 12);
      assert.equal(results.filter(r => r.status === 'ok').length, 1);
      assert.equal(ctx.tools.schemas(b).some(t => t.name === 'recall_search'), true, 'F survives when R is zero');
      const [page] = await drive(b, 'recall_search', { action: 'next', cursor: 'q:keep-F:0' });
      assert.equal(page.status, 'ok'); assert.equal(page.budget.shared_remaining, 0); assert.equal(page.budget.query_pages_remaining, 1);
      const [invalid] = await drive(b, 'recall_search', { action: 'next', cursor: 'q:keep-F:1', patterns: ['extra'] });
      assert.equal(invalid.code, 'shared_exhausted'); assert.match(invalid.message, /patterns/);
      assert.match(invalid.message, /No shared budget remains/);
      assert.equal(invalid.message.match(/Shared budget exhausted/g)?.length, 1);
      assert.equal(invalid.recovery, 'next accepts only action and cursor.');
      assert.doesNotMatch(invalid.message, /undisplayed|not read|not verified/i);
    });
  } finally {
    await off(); for (const handle of agents) await handle.dispose(); await model.dispose(); await mount.dispose();
  }
  const output = join(process.env.DSH_HOME, '..', 'budget-evidence.json');
  await writeFile(output, JSON.stringify({ cases, order, actionCount }, null, 2)); console.log(`Budget evidence: ${output}`);
}
