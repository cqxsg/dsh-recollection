import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RecallBudgetService, businessLedgerRecord, pageTokens, renderedTokens, resultGuidance, loadRecallConfig } from '../../lib/index.js';

test('page envelope dominates every action subset, notice and safe integer width', () => {
  const actions = ['search', 'attach_old_search', 'read', 'read_next', 'search_next', 'other_query_next'];
  for (const number of [0, 1, 9, 10, 99, 100, Number.MAX_SAFE_INTEGER]) for (const closed of [false, true]) for (let mask = 0; mask < 64; mask++) {
    const value = resultGuidance({ status: 'ok', items: [], message: '保留原始说明 "quoted"\n\nadditional context',
      budget: { revision: number, search_remaining: number, shared_remaining: number, query_pages_remaining: number, paid_pages_remaining: number, actual_calls: number, closed },
      allowed_actions: actions.filter((_, i) => mask & (1 << i)) });
    assert.ok(renderedTokens(value) <= pageTokens(value));
  }
});

function fixture() {
  let row = { version: 1, sessionId: 's', interactionId: 'i', anchorSeq: 0, revision: 2,
    limits: { searches: 6, shared: 12, freePages: 2, paidPages: 2 }, searches: 5, shared: 11, paidPages: 0, actualCalls: 1, closed: false,
    queries: [{ id: 'q', free: 0, granted: false, complete: false }], invalid: [],
    calls: [{ kind: 'direct', eventSeq: 1, turn: 1, step: 1, callId: 'c', rootCallId: 'c', name: 'recall_search', argsHash: 'hash', state: 'reserved', authorized: true, charge: 'search', query: 'q' }] };
  row = businessLedgerRecord.parse(row);
  const budget = Object.create(RecallBudgetService.prototype);
  const writes = [];
  Object.assign(budget, { config: loadRecallConfig(), queues: new Map(), pending: new Set(), closing: false,
    table: { get: () => row, put: async (_key, value) => { row = businessLedgerRecord.parse(value); writes.push(structuredClone(row)); } } });
  const reservation = { key: 'key', call: { eventSeq: 1 }, invalidFeedback: { keys: new Set(), legacyCodes: new Set() } };
  return { budget, reservation, writes, row: () => row };
}
test('completion validation precedes durable success and free-page grants', async () => {
  const f = fixture();
  await assert.rejects(f.budget.completeWithResult(f.reservation, { success: true, query: 'q', hasMore: true }, view => {
    assert.equal(view.budget.query_pages_remaining, 2); throw new Error('page does not fit');
  }), /page does not fit/);
  assert.equal(f.writes.length, 0); assert.equal(f.row().calls[0].state, 'reserved'); assert.equal(f.row().queries[0].free, 0);
  await f.budget.complete(f.reservation, { success: false, code: 'output_budget_too_small' });
  assert.equal(f.row().calls[0].state, 'failed'); assert.equal(f.row().shared, 11); assert.equal(f.row().queries[0].granted, false);
});
test('successful result uses the exact proposed completion and failed storage never returns it', async () => {
  const f = fixture();
  const view = await f.budget.completeWithResult(f.reservation, { success: true, query: 'q', hasMore: true }, value => value);
  assert.equal(view.budget.revision, f.row().revision); assert.equal(view.budget.query_pages_remaining, 2); assert.ok(view.allowed_actions.includes('search_next'));
  f.row().shared = 0; assert.equal(view.budget.shared_remaining, 11, 'snapshot is detached');
  const failed = fixture(); failed.budget.table.put = async () => { throw new Error('disk unavailable'); };
  await assert.rejects(failed.budget.completeWithResult(failed.reservation, { success: true, query: 'q', hasMore: true }, value => value), e => e.code === 'ledger_write_failed');
  assert.equal(failed.row().calls[0].state, 'reserved'); assert.equal(failed.row().queries[0].granted, false);
});
