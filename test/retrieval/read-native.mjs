import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { RecallBudgetService, RecallReferenceStore, RecallCursorStore, RecallCallController, RecallSearchEngine, RecallReadEngine, HistoryRecordCache, recordLocator, loadRecallConfig, nativeSchema, inputSchema, recallResult, renderRecall, renderedTokens, currentInteraction } from '../../lib/index.js';
import { scriptedModel, human, recovery } from '../../support/fixtures/scripted-model.mjs';
import { replace } from '../../support/fixtures/control.mjs';
import { createHistoryFixture } from '../../support/fixtures/history.mjs';
import { rangeFixture, text, file } from '../../support/fixtures/range.mjs';

export async function verifyRead(ctx) {
  const cases = [], samples = [], model = scriptedModel(ctx), agents = [];
  let searchEngine, readEngine, mount, serial = 0;
  const check = async (label, fn) => { await fn(); cases.push(label); console.log(`PASS: ${label}`); };
  async function install(config = loadRecallConfig()) {
    mount = await ctx.plugin({ name: 'isolated-read-host', async apply(parent) {
      await parent.plugin(RecallBudgetService, config);
      await parent.plugin(RecallReferenceStore);
      await parent.plugin(RecallCursorStore);
      await parent.inject(['recallBudget', 'recallReferences', 'recallCursors', 'recallPreparation', 'recallHistory', 'sessions', 'tools'], scope => {
        searchEngine = new RecallSearchEngine(scope, config); readEngine = new RecallReadEngine(scope, config);
        let controller;
        for (const [name, kind] of [['recall_search', 'search'], ['recall_read', 'read']]) scope.tools.register({ name, description: 'isolated read/search', parameters: inputSchema(kind), timeoutMs: config.outerMs,
          output: { schema: nativeSchema(recallResult), render: (_, value) => renderRecall(value) }, isConcurrencySafe: () => true, execute: (_, exec) => controller.body(exec) });
        controller = new RecallCallController(scope, config, { names: new Map([['recall_search', 'search'], ['recall_read', 'read']]), next: (request, exec) => searchEngine.inspectNext(request, exec),
          execute: (request, exec, ...rest) => exec.name === 'recall_search' ? searchEngine.run(request, exec, ...rest) : readEngine.run(request, exec, ...rest) });
        const ownedSearch = searchEngine, ownedRead = readEngine;
        scope.effect(() => async () => { ownedRead.clear(); await ownedSearch.dispose(); assert.equal(ownedSearch.matcher.children.size, 0); });
      });
    } });
  }
  await install();
  async function seeded(id, build, parent) {
    const fixture = await createHistoryFixture(ctx, id, [], parent), f = rangeFixture(fixture.session);
    const turn = parent ? (parent.snapshotEvents().findLast(e => e.type === 'turn/start')?.data.turn ?? 0) + 1 : 1;
    f.append('turn/start', { turn }); f.append('step/start', { turn, step: 1 });
    if (!parent) f.append('system/message', { turn, step: 1, message: { id: `${id}-system`, role: 'system', source: { kind: 'system-prompt' }, content: [text('fixture system')] } }, { surfaceOp: 'append' });
    const expected = build(f, fixture.session, turn) ?? {};
    f.append('step/end', { turn, step: expected.lastStep ?? 1 }); f.append('turn/end', { turn, reason: { kind: 'completed' } });
    const originalNodes = [...fixture.session.surface.nodes].filter(seq => fixture.session.snapshotEvents()[seq].type !== 'system/message');
    if (originalNodes.length) f.summary(originalNodes);
    await fixture.flush(); await fixture.close();
    const handle = await ctx.agents.resume({ resumeSessionId: id, agentOptions: model.options }); agents.push(handle); return { agent: handle.agent, expected };
  }
  async function drive(agent, name, args, input = recovery()) {
    const id = `read-${++serial}`;
    model.replies.push({ calls: [id], name, args: JSON.stringify(args) }, {});
    agent.followup(input); await agent.whenIdle(); await ctx.sessions.flush(agent.session); assert.equal(model.replies.length, 0);
    const event = agent.session.snapshotEvents().findLast(e => e.type === 'tool/result' && e.data.message.toolCallId === id);
    const value = event.data.message.isError ? { nativeError: event.data.error ?? { message: event.data.message.content[0]?.text } } : JSON.parse(event.data.message.content[0].text);
    samples.push({ sessionId: agent.id, name, args, value, tokens: event.data.message.isError ? undefined : renderedTokens(value) }); return value;
  }
  const search = (agent, patterns, input = human('find'), rest = {}) => drive(agent, 'recall_search', { action: 'search', mode: 'literal', patterns, ...rest }, input);
  const read = (agent, ref, scope = 'record', input = recovery()) => drive(agent, 'recall_read', { action: 'read', ref, scope }, input);
  const next = (agent, cursor, input = recovery()) => drive(agent, 'recall_read', { action: 'next', cursor }, input);
  const state = agent => ctx.recallBudget.state(currentInteraction(agent.session));
  try {
    await check('record/context/turn select exact canonical records and nonadjacent tool partners without expanding the context center', async () => {
      const { agent, expected } = await seeded('read-ranges', f => {
        f.user([text('outside')]); const x = f.callBlock('read-pair', 'read', '{"needle":"tool"}');
        const a = f.assistant([text('excluded-before'), x, text('between call and center')]), log = f.callLog(x);
        const center = f.user([text('needle center')]), after = f.assistant([text('after center')]), last = f.user([text('last neighbor')]);
        const result = f.result(x, log, [text('needle tool result')]); return { a, center, after, last, result };
      });
      const found = await search(agent, ['needle'], human('ranges'), { roles: ['user'], kinds: ['message'] });
      const ref = found.items[0].ref;
      let page = await read(agent, ref); assert.equal(page.items.length, 1); assert.equal(page.items[0].content, 'needle center');
      page = await read(agent, ref, 'context');
      assert.equal(page.readComplete, true); assert.equal(page.sourceComplete, true);
      assert.deepEqual(page.items.map(i => [i.source.seq, i.source.blocks]), [[expected.a.seq, [1]], [expected.a.seq, [2]], [expected.center.seq, [0]], [expected.after.seq, [0]], [expected.last.seq, [0]], [expected.result.seq, [0]]]);
      assert.equal(page.items.some(i => i.content === 'excluded-before'), false, 'same assistant event cannot broaden the canonical neighbor window');
      page = await read(agent, ref, 'turn'); assert.equal(page.items.length, 8); assert.equal(page.readComplete, true);
      const pair = await search(agent, ['needle tool result'], human('tool pairing'));
      page = await read(agent, pair.items[0].ref); assert.deepEqual(page.items.map(i => i.source.kind), ['tool_call', 'tool_result']);
    });
    await check('missing partners and turns without a final reply distinguish source completeness from selected-range completion', async () => {
      const handle = await ctx.agents.create({ sessionId: 'read-gaps', agentOptions: model.options, meta: { cwd: process.cwd() } }); agents.push(handle);
      const { agent } = handle; let page;
      const unreg = ctx.tools.register(defineTool({ name: 'read_gap_transport', description: 'probe an open native tool interaction', parameters: {},
        output: { schema: { type: 'boolean' }, render: (_, value) => [text(String(value))] },
        execute: async (_, exec) => {
          const cache = new HistoryRecordCache();
          const ref = await ctx.recallHistory.withSnapshot(agent.id, async (snapshot, signal) => {
            const source = snapshot.events.findLast(e => e.type === 'assistant/message' && e.data.message.content.some(b => b.type === 'tool-call' && b.id === exec.callId));
            const batch = await cache.prepareBatch(snapshot, ctx.sessions.messageProjections, { selection: { kind: 'events', eventSeqs: [source.seq] } }, signal);
            return (await ctx.recallReferences.issue(recordLocator(cache.records(batch)[0]), signal)).handle;
          }); cache.dispose();
          const data = { rootCallId: exec.rootCallId, parentCallId: exec.callId, subCallId: `${exec.callId}:ptc:1`, name: 'recall_read', arguments: { action: 'read', ref, scope: 'turn' } };
          agent.session.append('tool/ptc-dispatch-start', data);
          const result = await ctx.tools.execute({ name: data.name, callId: data.subCallId, arguments: data.arguments, agent, rootCallId: exec.rootCallId, parent: exec.token, signal: exec.signal });
          agent.session.append('tool/ptc-dispatch', { ...data, content: result.content, isError: result.isError }); page = result.value; return true;
        },
      }));
      try { model.replies.push({ calls: ['gap-root'], name: 'read_gap_transport' }, {}); agent.followup(human('read the unfinished native turn')); await agent.whenIdle(); }
      finally { await unreg(); }
      assert.equal(page.readComplete, true); assert.equal(page.sourceComplete, false); assert.match(page.gaps.join(','), /result_missing/); assert.equal(page.nextCursor, undefined);
      assert.equal(page.items.filter(i => i.source.kind === 'tool_call').length, 1);
      assert.equal(page.items.filter(i => i.source.role === 'assistant' && i.source.kind === 'message').length, 0);
    });
    await check('reused call IDs in different steps remain separate and source refs cannot switch native positions or sessions', async () => {
      const { agent } = await seeded('read-scoped-pairs', f => {
        const x = f.callBlock('same-call', 'read', 'needle-first'); f.assistant([x]); f.result(x, f.callLog(x), [text('first result')]);
        f.append('step/end', { turn: 1, step: 1 }); f.append('step/start', { turn: 1, step: 2 });
        const y = f.callBlock('same-call', 'read', 'needle-second'); f.assistant([y], 1, 2); f.result(y, f.callLog(y, 1, 2), [text('second result')], 1, 2); return { lastStep: 2 };
      });
      const found = await search(agent, ['needle-first']); const ref = found.items[0].ref;
      const page = await read(agent, ref); assert.deepEqual(page.items.map(i => i.content), ['readneedle-first', 'first result']);
      const { version, handle, recordKey, ...locator } = ctx.recallReferences.resolve(ref, agent.id);
      const altered = await ctx.recallReferences.issue({ ...locator, seq: locator.seq + 1 }, new AbortController().signal);
      assert.equal((await read(agent, altered.handle)).code, 'stale_reference');
      const other = await seeded('read-other-session', f => f.user([text('other')]) && {});
      assert.equal((await read(other.agent, ref, 'record', human('cross session'))).code, 'stale_reference');
    });
    await check('oversized events and interleaved tool interactions page in exact original order with Unicode-safe progress', async () => {
      // Full synthetic reconstruction tests pagination, not default-quota reachability.
      await mount.dispose(); await install(loadRecallConfig({ shared: 100 }));
      const argsX = ' { "needle": "' + 'X😀'.repeat(3000) + '" } ', argsY = ' { "needle": "' + 'Y'.repeat(9000) + '" } ';
      const resultY = 'Y😀\n'.repeat(4500), resultX = 'X中文\r\n'.repeat(3500);
      const { agent } = await seeded('read-long-units', f => {
        f.user([text('needle process')]); const x = f.callBlock('long-x', 'read', argsX), y = f.callBlock('long-y', 'read', argsY);
        f.assistant([x, y]); const lx = f.callLog(x), ly = f.callLog(y); f.result(y, ly, [text(resultY)]); f.result(x, lx, [text(resultX)]);
      });
      const found = await search(agent, ['needle process']); let page = await read(agent, found.items[0].ref, 'turn');
      const order = [], texts = new Map(); let pages = 0;
      while (true) {
        assert.equal(page.status, 'ok'); assert.ok(renderedTokens(page) <= 2000); assert.ok(pages < 100, 'bounded, advancing pagination');
        for (const item of page.items) { if (!texts.has(item.ref)) order.push(item.ref); assert.equal(item.start, (texts.get(item.ref) ?? '').length); assert.equal(item.end - item.start, item.content.length); texts.set(item.ref, (texts.get(item.ref) ?? '') + item.content); assert.equal(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/.test(item.content), false); }
        pages++; if (!page.nextCursor) break; assert.equal(page.readComplete, false); page = await next(agent, page.nextCursor);
      }
      assert.equal(page.readComplete, true); assert.ok(pages >= 4); assert.deepEqual(order.map(ref => texts.get(ref)), ['needle process', 'read' + argsX, 'read' + argsY, resultY, resultX]);
      await mount.dispose(); await install();
    });
    await check('a complete tool interaction moves to a fresh page when it fits there', async () => {
      const { agent } = await seeded('read-whole-unit', f => {
        f.user([text('needle ' + 'a'.repeat(6000))]);
        const call = f.callBlock('whole-pair', 'read', 'args ' + 'b'.repeat(1000)); f.assistant([call]); f.result(call, f.callLog(call), [text('small result')]);
      });
      const found = await search(agent, ['needle']); const first = await read(agent, found.items[0].ref, 'turn');
      assert.equal(first.items.length, 1); assert.equal(first.items[0].contentComplete, true); assert.ok(first.nextCursor);
      const second = await next(agent, first.nextCursor);
      assert.deepEqual(second.items.map(i => i.source.kind), ['tool_call', 'tool_result']);
      assert.ok(second.items.every(i => i.contentComplete)); assert.equal(second.readComplete, true);
      assert.ok(renderedTokens(first) <= 2000 && renderedTokens(second) <= 2000);
    });
    await check('oversized required source metadata fails without an empty advancing page or cursor writes', async () => {
      const { agent } = await seeded('read-long-metadata', f => {
        const event = f.user([text('short body')]);
        // Use the native append path for a legal, exceptionally long message identity.
        f.append('user/message', { ...event.data, id: 'm'.repeat(9000) }, { surfaceOp: 'append' });
      });
      const cache = new HistoryRecordCache();
      const ref = await ctx.recallHistory.withSnapshot(agent.id, async (snapshot, signal) => {
        const source = snapshot.events.find(e => e.type === 'user/message' && e.data.id.length === 9000);
        const batch = await cache.prepareBatch(snapshot, ctx.sessions.messageProjections, { selection: { kind: 'events', eventSeqs: [source.seq] } }, signal);
        return (await ctx.recallReferences.issue(recordLocator(cache.records(batch)[0]), signal)).handle;
      }); cache.dispose();
      const before = ctx.recallCursors.stats().records;
      for (let i = 0; i < 2; i++) {
        const failed = await read(agent, ref, 'record', i ? recovery() : human('long required metadata'));
        assert.equal(failed.code, 'output_budget_too_small'); assert.equal(failed.nextCursor, undefined); assert.deepEqual(failed.items, []);
        assert.equal(ctx.recallCursors.stats().records, before); assert.equal(failed.budget.shared_remaining, 11 - i);
      }
    });
    await check('ordinary failures and post-execute rejection cannot advance an old cursor; successful duplicate pages are bounded', async () => {
      const body = 'needle ' + '中😀 long line\n'.repeat(2600);
      const { agent } = await seeded('read-retry', f => f.user([text(body)]) && {});
      const found = await search(agent, ['needle']); const first = await read(agent, found.items[0].ref);
      const { locator: { index, charOffset: offset } } = ctx.recallCursors.resolve(first.nextCursor, agent.id, 'read'); assert.equal(index, 0); assert.ok(offset > 0);
      const observe = ctx.recallHistory.withSnapshot.bind(ctx.recallHistory);
      let temporary = true;
      const retry = replace(ctx.recallHistory, 'withSnapshot', (...args) => {
        if (temporary) { temporary = false; throw Object.assign(new Error('wrapped temporary descriptor exhaustion'), { code: 'SESSION_QUERY_PERSISTENCE_FAILED', cause: Object.assign(new Error('EMFILE'), { code: 'EMFILE' }) }); }
        return observe(...args);
      });
      const beforeRetry = state(agent).shared;
      try { const retried = await read(agent, found.items[0].ref); assert.equal(retried.status, 'ok'); assert.equal(retried.budget.shared_remaining, beforeRetry - 1); } finally { retry(); }
      const undo = replace(ctx.recallHistory, 'withSnapshot', async () => { throw Object.assign(new Error('ordinary disk failure'), { code: 'SESSION_QUERY_PERSISTENCE_FAILED', cause: Object.assign(new Error('EIO'), { code: 'EIO' }) }); });
      try { for (let i = 0; i < 2; i++) { const failed = await next(agent, first.nextCursor); assert.equal(failed.code, 'SESSION_QUERY_PERSISTENCE_FAILED'); assert.equal(failed.readComplete, false); assert.equal(failed.budget.closed, false); } } finally { undo(); }
      const block = ctx.on('tools/post-execute', async (exec, result, proceed) => { const decision = await proceed(); return exec.agent?.id === agent.id && exec.name === 'recall_read' ? { kind: 'block', feedback: [text('injected delivery failure')] } : decision; });
      try { const blocked = await next(agent, first.nextCursor); assert.ok(blocked.nativeError, JSON.stringify(blocked)); } finally { await block(); }
      const recovered = await next(agent, first.nextCursor); assert.equal(recovered.status, 'ok'); assert.equal(recovered.items[0].start, offset); assert.equal(body.slice(offset, recovered.items[0].end), recovered.items[0].content);
      const duplicate = await next(agent, first.nextCursor); assert.equal(duplicate.code, 'duplicate_page');
      const twice = await next(agent, first.nextCursor); assert.equal(twice.budget.closed, true);
    });
    await check('old refs survive memory reload and new interactions; lost read cursors expire with a verified anchor recovery', async () => {
      const { agent } = await seeded('read-reload', f => f.user([text('needle ' + 'x😀'.repeat(10000)), { ...file, attachment: { ...file.attachment, attachmentId: 'sha256:' + 'a'.repeat(64) } }]) && {});
      const found = await search(agent, ['needle']); const ref = found.items[0].ref, first = await read(agent, ref);
      readEngine.clear();
      const expired = await next(agent, first.nextCursor); assert.equal(expired.code, 'stale_reference'); assert.match(expired.recovery, /ref=rr2_/); assert.equal(expired.budget.closed, false);
      const recovered = await read(agent, ref, 'record', human('new cycle with old ref'));
      assert.equal(recovered.status, 'ok'); assert.equal(recovered.items[0].start, 0); assert.equal(recovered.budget.shared_remaining, 11); assert.equal(recovered.budget.search_remaining, 6);
      const attachment = await drive(agent, 'recall_read', { action: 'read', ref, target: 'attachments', attachments: [found.items[0].attachments[0].ref] });
      assert.equal(attachment.status, 'ok'); assert.deepEqual(attachment.items, []); assert.equal(attachment.attachmentResults[0].state, 'missing'); assert.equal(attachment.sourceComplete, false);
    });
    await check('retained neighboring text is read on demand, history boundaries are explicit and fork origins stay in the child scope', async () => {
      const parent = await seeded('read-parent', f => f.user([text('needle inherited')]) && {});
      const child = await seeded('read-child', () => ({}), parent.agent.session);
      const f = rangeFixture(child.agent.session); const retained = f.user([text('retained neighbor')], { kind: 'fixture-context' });
      const found = await search(child.agent, ['needle']); assert.equal(found.items[0].source.inherited, true);
      const page = await read(child.agent, found.items[0].ref, 'context');
      assert.equal(page.items[0].source.inherited, true); assert.equal(page.items.some(i => i.source.seq === retained.seq), true);
      assert.ok(page.boundaries.includes('history_start'));
      assert.ok(!page.items.some(i => i.source.kind === 'tool_result' && i.content.includes('scanComplete')));
    });
    await check('source absence/mutation and tiny output cap explicitly fail without an advancing cursor', async () => {
      const { agent } = await seeded('read-source-failure', f => f.user([text('needle source')]) && {});
      const found = await search(agent, ['needle']), ref = found.items[0].ref;
      const observe = ctx.recallHistory.withSnapshot.bind(ctx.recallHistory);
      const undo = replace(ctx.recallHistory, 'withSnapshot', async () => { throw Object.assign(new Error('source missing'), { code: 'SESSION_QUERY_SESSION_NOT_FOUND' }); });
      try { const failed = await read(agent, ref); assert.equal(failed.code, 'stale_reference'); assert.equal(failed.nextCursor, undefined); } finally { undo(); }
      const changed = replace(ctx.recallHistory, 'withSnapshot', (id, action, ...rest) => observe(id, (snapshot, signal) => action({ ...snapshot, header: { ...snapshot.header, createdAt: snapshot.header.createdAt + 1 } }, signal), ...rest));
      try { assert.equal((await read(agent, ref, 'record', human('changed source'))).code, 'stale_reference'); } finally { changed(); }
      await mount.dispose(); await install(loadRecallConfig({ readPageTokens: 100 }));
      const failed = await read(agent, ref, 'record', human('tiny cap')); assert.equal(failed.nativeError.code, 'output_budget_too_small');
    });
    for (const handle of agents) { await ctx.sessions.flush(handle.agent.session); const stored = await ctx.sessionPersistence.open(handle.agent.id, 'read'); try { await stored.read(); } finally { await stored.close(); } }
  } finally { for (const handle of agents) await handle.dispose(); await model.dispose(); await mount.dispose(); }
  const output = join(process.env.DSH_HOME, '..', 'read-evidence.json'); await writeFile(output, JSON.stringify({ cases, samples }, null, 2)); console.log(`Read evidence: ${output}`);
}
