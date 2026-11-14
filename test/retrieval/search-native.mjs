import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { RecallBudgetService, RecallReferenceStore, RecallCursorStore, RecallCallController, RecallSearchEngine, loadRecallConfig, nativeSchema, inputSchema, recallResult, renderRecall, renderedTokens, currentInteraction, RecallError } from '../../lib/index.js';
import { scriptedModel, human, recovery } from '../../support/fixtures/scripted-model.mjs';
import { replace, deferred } from '../../support/fixtures/control.mjs';
import { createHistoryFixture } from '../../support/fixtures/history.mjs';
import { rangeFixture, text, file } from '../../support/fixtures/range.mjs';

export async function verifySearch(ctx) {
  const cases = [], samples = [], model = scriptedModel(ctx), agents = [];
  let engine, mount, serial = 0;
  const check = async (label, fn) => { await fn(); cases.push(label); console.log(`PASS: ${label}`); };
  async function install(config = loadRecallConfig()) {
    mount = await ctx.plugin({ name: 'isolated-search-host', async apply(parent) {
      await parent.plugin(RecallBudgetService, config);
      await parent.plugin(RecallReferenceStore);
      await parent.plugin(RecallCursorStore);
      await parent.inject(['recallBudget', 'recallReferences', 'recallCursors', 'recallPreparation', 'recallHistory', 'sessions', 'tools'], scope => {
        engine = new RecallSearchEngine(scope, config);
        let controller;
        scope.tools.register({ name: 'recall_search', description: 'isolated search', parameters: inputSchema('search'), timeoutMs: config.outerMs,
          output: { schema: nativeSchema(recallResult), render: (_, value) => renderRecall(value) }, isConcurrencySafe: () => true, execute: (_, exec) => controller.body(exec) });
        controller = new RecallCallController(scope, config, { names: new Map([['recall_search', 'search']]), next: (request, exec) => engine.inspectNext(request, exec), execute: (...args) => engine.run(...args) });
        const owned = engine;
        scope.effect(() => async () => { await owned.dispose(); assert.equal(owned.matcher.children.size, 0); });
      });
    } });
  }
  await install();
  async function seeded(id, build) {
    const fixture = await createHistoryFixture(ctx, id, []), f = rangeFixture(fixture.session);
    f.append('turn/start', { turn: 1 }); f.append('step/start', { turn: 1, step: 1 });
    f.append('system/message', { turn: 1, step: 1, message: { id: `${id}-system`, role: 'system', source: { kind: 'system-prompt' }, content: [text('fixture system')] } }, { surfaceOp: 'append' });
    const expected = build(f, fixture.session);
    f.append('step/end', { turn: 1, step: 1 }); f.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
    f.summary([...fixture.session.surface.nodes].filter(seq => fixture.session.snapshotEvents()[seq].type !== 'system/message')); await fixture.flush(); await fixture.close();
    const handle = await ctx.agents.resume({ resumeSessionId: id, agentOptions: model.options }); agents.push(handle);
    return { agent: handle.agent, expected };
  }
  async function drive(agent, args, input = recovery()) {
    const id = `search-${++serial}`;
    model.replies.push({ calls: [id], name: 'recall_search', args: JSON.stringify(args) }, {});
    agent.followup(input); await agent.whenIdle(); await ctx.sessions.flush(agent.session); assert.equal(model.replies.length, 0);
    const event = agent.session.snapshotEvents().findLast(e => e.type === 'tool/result' && e.data.message.toolCallId === id);
    const result = event.data.message.isError ? { nativeError: event.data.error } : JSON.parse(event.data.message.content[0].text);
    samples.push({ sessionId: agent.id, args, result, tokens: event.data.message.isError ? undefined : renderedTokens(result) });
    return result;
  }
  const search = (patterns, rest = {}) => ({ action: 'search', mode: 'literal', patterns, ...rest });
  const next = cursor => ({ action: 'next', cursor });
  const state = agent => ctx.recallBudget.state(currentInteraction(agent.session));
  try {
    await check('complete fixed scan, exact total record hits and dynamic pages preserve native order without gaps or duplicates', async () => {
      const { agent, expected } = await seeded('search-pages', f => Array.from({ length: 9 }, (_, i) => f.user([text(`needle ${i} ` + '中文😀'.repeat(170))]).seq));
      let page = await drive(agent, search(['needle']), human('find'));
      assert.equal(page.scanComplete, true); assert.equal(page.totalHits, 9); assert.equal(page.scannedRecords, 9);
      const seen = [...page.items.map(i => i.source.seq)]; let pages = 1;
      while (page.nextCursor) { page = await drive(agent, next(page.nextCursor)); assert.equal(page.status, 'ok'); seen.push(...page.items.map(i => i.source.seq)); pages++; }
      assert.deepEqual(seen, [...expected].reverse()); assert.ok(pages >= 2 && pages <= 5);
      assert.ok(samples.filter(s => s.sessionId === agent.id).every(s => s.tokens <= 2000));
      assert.equal(state(agent).queries.length, 1);
    });
    await check('short full text, long contiguous hit-centered previews, multiple matches and attachment metadata keep distinct completeness', async () => {
      const long = 'before sentence.\n'.repeat(130) + 'TARGET 中文😀 target\n' + 'after sentence.\n'.repeat(130);
      const { agent } = await seeded('search-preview', f => { f.user([text('short TARGET'), file]); f.user([text(long)]); });
      const page = await drive(agent, search(['target']), human('preview'));
      assert.equal(page.status, 'ok'); assert.equal(page.items.length, 2);
      const [large, small] = page.items;
      assert.equal(large.contentComplete, false); assert.equal(large.omittedBefore, true); assert.equal(large.omittedAfter, true);
      assert.equal(long.slice(large.start, large.end), large.content); assert.match(large.content, /TARGET/);
      assert.equal(small.contentComplete, true); assert.equal(small.attachments[0].state, 'not_checked');
      const meta = await drive(agent, search(['notes.txt']), human('metadata search'));
      assert.equal(meta.totalHits, 1); assert.deepEqual(meta.items[0].matchedIn, ['metadata']);
    });
    await check('OR, role/kind intersections, ascending order, empty result and duplicate direction do not create extra F', async () => {
      const { agent, expected } = await seeded('search-filters', f => {
        const user = f.user([text('alpha')]), block = f.callBlock('filter-call', 'read', '{"needle":"beta"}');
        const assistant = f.assistant([text('alpha assistant'), block]), log = f.callLog(block), result = f.result(block, log, [text('beta output')]);
        return { user: user.seq, assistant: assistant.seq, result: result.seq };
      });
      let page = await drive(agent, search(['alpha', 'beta'], { roles: ['assistant'], kinds: ['tool_call', 'message'], order: 'oldest' }), human('filter'));
      assert.equal(page.totalHits, 2); assert.deepEqual(page.items.map(i => i.source.seq), [expected.assistant, expected.assistant]);
      page = await drive(agent, search(['alpha', 'beta'], { roles: ['assistant'], kinds: ['tool_call', 'message'], order: 'newest' }));
      assert.equal(page.code, 'duplicate_query'); assert.equal(state(agent).queries.length, 1);
      page = await drive(agent, search(['no such text']), human('zero'));
      assert.equal(page.totalHits, 0); assert.equal(page.scanComplete, true); assert.equal(page.nextCursor, undefined); assert.equal(page.budget.query_pages_remaining, 0);
    });
    await check('literal case sensitivity and regex inline flags agree with query identity', async () => {
      const { agent } = await seeded('search-case-modes', f => {
        for (const value of ['CASE-PROBE-aa', 'CASE-PROBE-AA', 'case-probe-aa']) f.user([text(value)]);
      });
      let page = await drive(agent, search(['case-probe-aa'], { mode: 'regex', case_sensitive: true }), human('regex case'));
      assert.equal(page.totalHits, 3);
      page = await drive(agent, search(['case-probe-aa'], { mode: 'regex', case_sensitive: false }));
      assert.equal(page.code, 'duplicate_query');
      assert.equal(state(agent).queries.length, 1, 'ignored regex flag cannot create another query');
      page = await drive(agent, search(['CASE-PROBE-aa'], { case_sensitive: true }), human('literal case'));
      assert.equal(page.totalHits, 1); assert.equal(page.items[0].content, 'CASE-PROBE-aa');
      page = await drive(agent, search(['CASE-PROBE-aa'], { case_sensitive: false }));
      assert.equal(page.totalHits, 3);
      page = await drive(agent, search(['(?-i:CASE-PROBE-AA)'], { mode: 'regex', case_sensitive: false }), human('regex inline case'));
      assert.equal(page.totalHits, 1); assert.equal(page.items[0].content, 'CASE-PROBE-AA');
    });
    await check('bounded parallel matching commits in native order even when the second record finishes first', async () => {
      const { agent, expected } = await seeded('search-parallel-order', f => Array.from({ length: 4 }, (_, i) => f.user([text(`needle ordered ${i}`)]).seq));
      const raw = engine.matcher.match.bind(engine.matcher), second = deferred(), completed = [];
      let started = 0, active = 0, peak = 0;
      const undo = replace(engine.matcher, 'match', async (record, ...args) => {
        const at = ++started; active++; peak = Math.max(peak, active);
        try { if (at === 1) await second.promise; const result = await raw(record, ...args); completed.push(record.origin.seq); return result; }
        finally { if (at === 2) second.resolve(); active--; }
      });
      try {
        const page = await drive(agent, search(['needle'], { order: 'oldest' }), human('ordered parallel search'));
        assert.equal(page.status, 'ok'); assert.equal(peak, 2); assert.equal(active, 0);
        assert.equal(completed[0], expected[1]); assert.deepEqual(page.items.map(i => i.source.seq), expected);
        assert.equal(engine.matcher.stats().active, 0); assert.ok(engine.matcher.children.size <= 2);
      } finally { second.resolve(); undo(); }
    });
    await check('either failed batch member drains siblings, publishes no progress and retries the entire uncertain batch', async () => {
      for (const failureAt of [1, 2]) {
        const { agent } = await seeded(`search-parallel-failure-${failureAt}`, f => Array.from({ length: 3 }, (_, i) => f.user([text(`needle failure ${i}`)])));
        const raw = engine.matcher.match.bind(engine.matcher); let started = 0, siblingSettled = false;
        const undo = replace(engine.matcher, 'match', async (...args) => {
          const at = ++started;
          if (at === failureAt) throw new RecallError('business_deadline', 'Injected incomplete member.', false, 'Retry the same search.');
          await new Promise(resolve => setTimeout(resolve, 30)); const result = await raw(...args); siblingSettled = true; return result;
        });
        try {
          const first = await drive(agent, search(['needle']), human('incomplete parallel search'));
          assert.equal(first.status, 'incomplete'); assert.deepEqual(first.items, []); assert.equal(siblingSettled, true);
          assert.equal(engine.stats().find(q => q.sessionId === agent.id).scanned, 0); assert.equal(engine.matcher.stats().active, 0); assert.ok(engine.matcher.children.size <= 2);
        } finally { undo(); }
        let retried = 0;
        const stop = replace(engine.matcher, 'match', (...args) => { retried++; return raw(...args); });
        try { const page = await drive(agent, search(['needle'])); assert.equal(page.totalHits, 3); assert.equal(retried, 3); }
        finally { stop(); }
      }
    });
    await check('oversized complete records occupy a matching batch alone', async () => {
      const { agent } = await seeded('search-parallel-large', f => [f.user([text('needle small')]), f.user([text('needle ' + 'x'.repeat(70000))]), f.user([text('needle tail')])]);
      const raw = engine.matcher.match.bind(engine.matcher); let active = 0, largeActive = false, sawLarge = false;
      const undo = replace(engine.matcher, 'match', async (record, ...args) => {
        const large = record.blocks.some(b => b.content.type === 'text' && b.content.text.length > 65536);
        assert.equal(largeActive, false); if (large) { assert.equal(active, 0); largeActive = true; sawLarge = true; }
        active++;
        try { return await raw(record, ...args); } finally { active--; if (large) largeActive = false; }
      });
      try { const page = await drive(agent, search(['needle']), human('large isolated record')); assert.equal(page.totalHits, 3); assert.equal(sawLarge, true); assert.equal(active, 0); }
      finally { undo(); }
    });
    await check('incomplete scans publish no partial hits; retry resumes verified records and excludes later compaction', async () => {
      const { agent } = await seeded('search-resume', f => Array.from({ length: 5 }, (_, i) => f.user([text(`needle ${i}`)])));
      const raw = engine.matcher.match.bind(engine.matcher); let matched = 0;
      const undo = replace(engine.matcher, 'match', async (...args) => {
        if (++matched === 3) throw new RecallError('business_deadline', 'Injected deadline between whole records.', false, 'Retry the same search.');
        return raw(...args);
      });
      let first;
      try { first = await drive(agent, search(['needle']), human('resume')); } finally { undo(); }
      assert.equal(first.status, 'incomplete'); assert.deepEqual(first.items, []); assert.equal(first.scanComplete, false);
      assert.equal(engine.stats().find(q => q.sessionId === agent.id).scanned, 2);
      const f = rangeFixture(agent.session), added = f.user([text('needle new eligible')], { kind: 'fixture-late' }); f.summary([added.seq]);
      let retried = 0;
      const stop = replace(engine.matcher, 'match', (...args) => { retried++; return raw(...args); });
      let page;
      try { page = await drive(agent, search(['needle'])); } finally { stop(); }
      assert.equal(page.status, 'ok'); assert.equal(page.totalHits, 5); assert.equal(retried, 3);
      const originalQuery = state(agent).calls.at(-1).query;
      const newer = await drive(agent, search(['needle'])); assert.equal(newer.totalHits, 6); assert.notEqual(state(agent).calls.at(-1).query, originalQuery);
      assert.equal(state(agent).searches, 3);
    });
    await check('search cursors have fixed starts; delivered duplicates charge R and close on the second unchanged invalid request', async () => {
      const { agent } = await seeded('search-cursor', f => Array.from({ length: 9 }, (_, i) => f.user([text(`needle ${i} ` + 'x'.repeat(900))])));
      const first = await drive(agent, search(['needle']), human('cursor'));
      const second = await drive(agent, next(first.nextCursor)); assert.equal(second.start, first.end);
      const free = state(agent).queries[0].free, shared = state(agent).shared;
      const repeated = await drive(agent, next(first.nextCursor)); assert.equal(repeated.code, 'duplicate_page'); assert.equal(state(agent).queries[0].free, free); assert.equal(state(agent).shared, shared - 1);
      const twice = await drive(agent, next(first.nextCursor)); assert.equal(twice.budget.closed, true);
    });
    await check('old query registration resets no old F; lost query results expire cursors and reconstruction cannot regrant F', async () => {
      const { agent } = await seeded('search-reload', f => Array.from({ length: 12 }, (_, i) => f.user([text(`needle ${i} ` + 'x'.repeat(900))])));
      const first = await drive(agent, search(['needle']), human('old query'));
      const old = await drive(agent, next(first.nextCursor), human('new interaction'));
      assert.equal(old.budget.search_remaining, 5); assert.equal(old.budget.shared_remaining, 11); assert.equal(old.budget.query_pages_remaining, 2);
      await drive(agent, next(old.nextCursor)); assert.equal(state(agent).queries[0].free, 1);
      engine.clear(); const expired = await drive(agent, next(old.nextCursor)); assert.equal(expired.code, 'stale_reference'); assert.equal(expired.budget.closed, false);
      const rebuilt = await drive(agent, search(['needle'])); assert.equal(rebuilt.status, 'ok'); assert.equal(rebuilt.budget.query_pages_remaining, 1);
    });
    await check('real result cursor remains usable with R=0 and F>0; oversized mandatory metadata fails rather than dropping a hit', async () => {
      const { agent } = await seeded('search-free-only', f => Array.from({ length: 9 }, (_, i) => f.user([text(`needle ${i} ` + 'x'.repeat(900))])));
      const first = await drive(agent, search(['needle']), human('free only'));
      for (let i = 0; i < 11; i++) await drive(agent, next(`expired-${i}`));
      assert.equal(state(agent).shared, 0); assert.equal(state(agent).queries[0].free, 2);
      const page = await drive(agent, next(first.nextCursor)); assert.equal(page.status, 'ok'); assert.equal(page.budget.shared_remaining, 0); assert.equal(page.budget.query_pages_remaining, 1);
      const huge = await seeded('search-huge-metadata', f => f.user([text('needle'), { type: 'file', attachment: { ...file.attachment, name: 'x'.repeat(12000) } }]));
      const failed = await drive(huge.agent, search(['needle']), human('huge metadata'));
      assert.equal(failed.code, 'output_budget_too_small'); assert.deepEqual(failed.items, []);
    });
    await check('source prefix mutation fails closed; tiny output configuration cannot skip a large minimum item', async () => {
      const { agent } = await seeded('search-invalid-source', f => Array.from({ length: 8 }, () => f.user([text('needle ' + 'x'.repeat(900))])));
      const first = await drive(agent, search(['needle']), human('source'));
      const observe = ctx.recallHistory.withSnapshot.bind(ctx.recallHistory);
      const undo = replace(ctx.recallHistory, 'withSnapshot', (id, action, ...rest) => observe(id, (snapshot, signal) => action({ ...snapshot, header: { ...snapshot.header, createdAt: snapshot.header.createdAt + 1 } }, signal), ...rest));
      try { const result = await drive(agent, next(first.nextCursor)); assert.equal(result.code, 'stale_reference'); assert.deepEqual(result.items, []); } finally { undo(); }
      await mount.dispose(); await install(loadRecallConfig({ searchPageTokens: 100 }));
      const result = await drive(agent, search(['needle']), human('tiny output'));
      assert.equal(result.nativeError.code, 'output_budget_too_small');
    });
    for (const handle of agents) { await ctx.sessions.flush(handle.agent.session); const stored = await ctx.sessionPersistence.open(handle.agent.id, 'read'); try { await stored.read(); } finally { await stored.close(); } }
  } finally { for (const handle of agents) await handle.dispose(); await model.dispose(); await mount.dispose(); }
  const output = join(process.env.DSH_HOME, '..', 'search-evidence.json'); await writeFile(output, JSON.stringify({ cases, samples }, null, 2)); console.log(`Search evidence: ${output}`);
}
