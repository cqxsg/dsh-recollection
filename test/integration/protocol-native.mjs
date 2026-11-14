import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as spill from '@deepseek-ai/dsh-spill-policy';
import { createScope } from '@deepseek-ai/dsh-scope';
import { estimateContent } from '@deepseek-ai/dsh-token-meter/estimate';
import { assertSupportedJsonSchema, validateJsonSchemaValue } from '@deepseek-ai/dsh-tools';
import { Config, loadRecallConfig, parseRequest, searchInput, readInput, inputSchema, nativeSchema, recallResult, queryTermsId, effectiveSpill, pageBudget, renderRecall, renderedTokens, verifyOutput } from '../../lib/index.js';

export async function verifyProtocol(ctx) {
  const cases = [];
  const check = async (label, fn) => { await fn(); cases.push(label); console.log(`PASS: ${label}`); };
  const config = loadRecallConfig();
  const budget = { revision: 1, search_remaining: 6, shared_remaining: 12, query_pages_remaining: 0, paid_pages_remaining: 2, actual_calls: 0, closed: false };
  const value = { status: 'ok', scanComplete: true, items: [], budget, allowed_actions: ['search', 'read'] };
  await check('strict actions, enums, exclusive next fields, preserved whitespace and attachment extension contract', () => {
    assert.deepEqual(parseRequest('search', { action: 'search', mode: 'literal', patterns: [' ', ' key '] }), { action: 'search', mode: 'literal', patterns: [' ', ' key '], case_sensitive: false, order: 'newest' });
    assert.equal(parseRequest('read', { action: 'read', ref: 'r' }).scope, 'record');
    assert.equal(parseRequest('read', { action: 'read', ref: 'r', target: 'attachments', attachments: ['a'] }).target, 'attachments');
    for (const [tool, args] of [
      ['search', { action: 'search', mode: 'literal', patterns: [] }], ['search', { action: 'search', mode: 'regex', patterns: [''] }],
      ['search', { action: 'search', mode: 'literal', patterns: ['x'], roles: ['system'] }], ['search', { action: 'search', mode: 'auto', patterns: ['x'] }],
      ['search', { action: 'next', cursor: 's', patterns: ['x'] }], ['read', { action: 'next', cursor: 'r', scope: 'turn' }],
      ['read', { action: 'read', ref: 'r', target: 'attachments', attachments: ['a'], scope: 'record' }],
      ['read', { action: 'read', ref: 'r', target: 'both' }], ['read', { action: 'read', ref: 'r', sessionId: 'elsewhere' }],
    ]) assert.throws(() => parseRequest(tool, args), e => e.code === 'invalid_arguments');
    for (const tool of ['search', 'read']) assertSupportedJsonSchema(inputSchema(tool));
    assertSupportedJsonSchema(nativeSchema(recallResult));
    assert.deepEqual(validateJsonSchemaValue(nativeSchema(recallResult), value), []);
  });
  await check('model-facing schemas retain descriptions across action flattening and preserve defaults', () => {
    for (const [tool, source] of [['search', searchInput], ['read', readInput]]) {
      const schema = inputSchema(tool);
      for (const [name, property] of Object.entries(schema.properties)) {
        assert.ok(typeof property.description === 'string' && property.description.length > 0, `${tool}.${name} has a description`);
      }
      for (const branch of nativeSchema(source).oneOf) {
        for (const [name, property] of Object.entries(branch.properties)) {
          assert.equal(schema.properties[name].description, property.description, `${tool}.${name} survives flattening`);
        }
      }
    }
    assert.equal(inputSchema('search').properties.case_sensitive.default, false);
    assert.equal(inputSchema('search').properties.order.default, 'newest');
    assert.equal(inputSchema('read').properties.scope.default, 'record');
    assert.equal(inputSchema('read').properties.target.default, 'text');
    assert.notEqual(inputSchema('search').properties.cursor.description, inputSchema('read').properties.cursor.description);
  });
  await check('immutable validated defaults and query identity independent of display direction', () => {
    assert.equal(Object.isFrozen(config), true);
    assert.deepEqual([config.previewTokens, config.searchPageTokens, config.readPageTokens], [300, 2000, 2000]);
    assert.equal(pageBudget(loadRecallConfig({ readPageTokens: 4000 }), 'read', { state: 'disabled' }), 4000, 'explicit larger budgets remain configurable');
    assert.deepEqual([config.searches, config.shared, config.freePages, config.paidPages, config.prepareMs, config.businessMs, config.outerMs], [6, 12, 2, 2, 15000, 55000, 60000]);
    for (const raw of [{ shared: -1 }, { previewTokens: 0 }, { outerMs: 55000 }, { businessMs: 1000 }, { spillRatio: 0.9 }, { unknown: true }]) assert.throws(() => loadRecallConfig(raw));
    const terms = parseRequest('search', { action: 'search', mode: 'regex', patterns: [' A ', 'B'] });
    assert.equal(queryTermsId(terms), queryTermsId({ ...terms, patterns: ['B', ' A ', 'B'], order: 'oldest' }));
    assert.notEqual(queryTermsId(terms), queryTermsId({ ...terms, patterns: ['A', 'B'] }));
    assert.equal(queryTermsId(terms), queryTermsId({ ...terms, case_sensitive: true }), 'regex ignores the literal-only flag');
    const literal = { ...terms, mode: 'literal' };
    assert.notEqual(queryTermsId(literal), queryTermsId({ ...literal, case_sensitive: true }), 'literal case sensitivity changes the query');
  });
  await check('source references resolve durable mappings and reject damage, wrong session, versions and cursors', async () => {
    const row = await ctx.recallReferences.issue({ sessionId: 'session', formatVersion: 4, historyId: 'a'.repeat(64), seq: 3, recordId: 'b'.repeat(64), fingerprint: 'c'.repeat(64) }, new AbortController().signal);
    const token = row.handle; assert.equal(ctx.recallReferences.resolve(token, 'session').seq, 3);
    for (const [ref, session] of [[token, 'other'], ['rs3_' + 'A'.repeat(22), 'session'], ['rr1.unsupported', 'session'], [token + 'x', 'session']]) assert.throws(() => ctx.recallReferences.resolve(ref, session), e => e.code === 'stale_reference');
  });
  await check('direct timer fields reject overflow at load; cumulative hash allowance remains independent', () => {
    const max = 2_147_483_647;
    for (const field of ['prepareMs', 'businessMs', 'outerMs']) {
      assert.throws(() => loadRecallConfig({ [field]: max + 1 }), error => error.issues.some(issue => issue.path[0] === field));
    }
    const large = loadRecallConfig({ prepareMs: max - 5000, businessMs: max - 5000, outerMs: max, hashActiveMs: max + 1 });
    assert.equal(large.outerMs, max); assert.equal(large.hashActiveMs, max + 1);
    assert.equal(Config({ diagnosticTimeoutMs: max }).diagnosticTimeoutMs, max);
    assert.throws(() => Config({ diagnosticTimeoutMs: max + 1 }), /diagnosticTimeoutMs/);
  });
  await check('actual JSON rendering prices escaping, CJK, emoji, metadata and all mandatory fields', () => {
    const extended = { ...value, message: '\\"\n中文😀'.repeat(150), range: 's'.repeat(2000), nextCursor: 'c'.repeat(1000) };
    assert.equal(renderedTokens(extended), estimateContent(renderRecall(extended)));
    assert.ok(renderedTokens(extended) > renderedTokens(value) + 900);
    verifyOutput(extended, config.readPageTokens);
    assert.throws(() => verifyOutput(extended, 100), e => e.code === 'output_budget_too_small');
  });
  const original = [...ctx.registry.get(spill).fibers].find(f => f.state === 2);
  await check('real rc.4 effective default H=12500 and lowered cap use the same estimator as spill', async () => {
    assert.deepEqual(effectiveSpill(ctx), { state: 'enabled', tokens: 12500 });
    assert.equal(pageBudget(config, 'search', effectiveSpill(ctx)), 2000);
    assert.equal(pageBudget(config, 'read', effectiveSpill(ctx)), 2000);
    await original.dispose();
    const low = await ctx.plugin(spill, { maxInlineTokens: 500 });
    try {
      assert.deepEqual(effectiveSpill(ctx), { state: 'enabled', tokens: 500 });
      assert.equal(pageBudget(config, 'read', effectiveSpill(ctx)), 400);
    } finally { await low.dispose(); }
  });
  await check('disabled and unknown policies differ; a minimum legal page cannot escape a tiny cap', async () => {
    assert.deepEqual(effectiveSpill(ctx), { state: 'disabled' });
    assert.equal(pageBudget(config, 'read', effectiveSpill(ctx)), 2000);
    const other = await ctx.plugin({ name: 'spill-policy', apply() {} });
    try { assert.equal(effectiveSpill(ctx).state, 'unknown'); assert.throws(() => pageBudget(config, 'read', effectiveSpill(ctx)), e => e.code === 'configuration_unknown'); }
    finally { await other.dispose(); }
    const tiny = await ctx.plugin(spill, { maxInlineTokens: 10 });
    try { assert.throws(() => verifyOutput(value, pageBudget(config, 'search', effectiveSpill(ctx))), e => e.code === 'output_budget_too_small'); }
    finally { await tiny.dispose(); }
    await ctx.plugin(spill, { maxInlineTokens: 12500 });
  });
  await check('independently loaded native spill copies compose by minimum and respect execution scope', async () => {
    const copy = await import(import.meta.resolve('@deepseek-ai/dsh-spill-policy') + '?recall-copy');
    assert.notEqual(copy.apply, spill.apply);
    const second = await ctx.plugin(copy, { maxInlineTokens: 1700 });
    const agent = {}, other = {}, scope = createScope(ctx, agent);
    let scoped;
    try {
      assert.deepEqual(effectiveSpill(ctx), { state: 'enabled', tokens: 1700 });
      scoped = await scope.ctx.plugin(copy, { maxInlineTokens: 800 });
      assert.deepEqual(effectiveSpill(ctx, { agent }), { state: 'enabled', tokens: 800 });
      assert.deepEqual(effectiveSpill(ctx, { agent: other }), { state: 'enabled', tokens: 1700 });
      const bad = await scope.ctx.plugin({ name: 'spill-policy', apply() {} });
      try {
        assert.equal(effectiveSpill(ctx, { agent }).state, 'unknown');
        assert.equal(effectiveSpill(ctx, { agent: other }).state, 'enabled');
      } finally { await bad.dispose(); }
    } finally { await scope.dispose(); await second.dispose(); }
    assert.deepEqual(effectiveSpill(ctx), { state: 'enabled', tokens: 12500 });
  });
  await check('additive validated spill configuration is accepted; changed cap contracts and transitions stay unknown', async () => {
    const configured = value => ({ '~standard': { version: 1, vendor: 'recall-test', validate: () => ({ value }) } });
    const extended = await ctx.plugin({ name: 'spill-policy', Config: configured({ maxInlineTokens: 1300, description: 'additive field' }), apply: (ctx, config) => spill.apply(ctx, config) });
    try { assert.deepEqual(effectiveSpill(ctx), { state: 'enabled', tokens: 1300 }); }
    finally { await extended.dispose(); }
    const unknown = await ctx.plugin({ name: 'spill-policy', Config: configured({ renamedCap: 100 }), apply() {} });
    try { assert.equal(effectiveSpill(ctx).state, 'unknown'); }
    finally { await unknown.dispose(); }
    const gate = Promise.withResolvers();
    const loading = ctx.plugin({ name: 'spill-policy', Config: spill.Config, async apply(ctx, config) { await gate.promise; spill.apply(ctx, config); } }, { maxInlineTokens: 1400 });
    try {
      assert.equal(effectiveSpill(ctx).state, 'unknown');
      gate.resolve(); await loading;
      assert.deepEqual(effectiveSpill(ctx), { state: 'enabled', tokens: 1400 });
    } finally { gate.resolve(); await loading.dispose(); }
  });
  const output = join(process.env.DSH_HOME, '..', 'protocol-evidence.json');
  await writeFile(output, JSON.stringify({ cases, dsh: '0.2.1-rc.4', defaultConfig: config, renderedTokens: renderedTokens(value) }, null, 2));
  console.log(`Protocol evidence: ${output}`);
}
