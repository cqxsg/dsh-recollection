import type { RecallResult } from '../protocol.js';

export const budgetNotices = {
  closed: 'Recall closed after the same uncorrected invalid operation; use available history and other tools, or start a new user interaction.',
  exhausted: 'This interaction has no usable recall budget. Other tools remain available.',
  shared: 'Shared budget exhausted; only registered queries with remaining free pages can continue.',
};
const baseMessages = (result: RecallResult) => result.message?.split('\n\n').filter(message => !Object.values(budgetNotices).includes(message)) ?? [];
export function resultGuidance(result: RecallResult): RecallResult {
  const messages = baseMessages(result);
  if (result.budget.closed) messages.push(budgetNotices.closed);
  else if (!result.allowed_actions.length) messages.push(budgetNotices.exhausted);
  else if (!result.budget.shared_remaining) messages.push(budgetNotices.shared);
  if (messages.length) result.message = messages.join('\n\n'); else delete result.message;
  return result;
}

/** JSON-length upper envelope under the supported host's fixed-density text estimator.
 * Ledger integers are safe nonnegative integers; false and all actions dominate
 * every completion snapshot. Only the longest notice is ever appended. */
export function completionEnvelope(result: RecallResult): RecallResult {
  const n = Number.MAX_SAFE_INTEGER;
  const notice = Object.values(budgetNotices).reduce((longest, next) => JSON.stringify(next).length > JSON.stringify(longest).length ? next : longest);
  return { ...result, budget: { revision: n, search_remaining: n, shared_remaining: n, query_pages_remaining: n, paid_pages_remaining: n, actual_calls: n, closed: false },
    allowed_actions: ['search', 'attach_old_search', 'read', 'read_next', 'search_next', 'other_query_next'],
    message: [...baseMessages(result), notice].join('\n\n') };
}
