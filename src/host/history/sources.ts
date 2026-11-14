import type { Context } from '@deepseek-ai/cordis';
import { snapshotPrefix, type HistorySnapshot } from './history.js';
import type { SessionId } from '@deepseek-ai/dsh-session';
import { fingerprintHistory } from './records.js';
import { RecallError } from '../protocol.js';
import type { CallTimeline } from '../runtime/deadline.js';
import type {} from './history.js';

export function historyPrefix(snapshot: HistorySnapshot, cursor: number): HistorySnapshot {
  if (cursor > snapshot.cursor || cursor < -1 || snapshot.inheritedEventCount > cursor + 1) throw new RecallError('stale_reference', 'Native history no longer contains the fixed range.', true);
  return snapshotPrefix(snapshot, cursor);
}
export async function verifyHistoryCut(ctx: Context, sessionId: string, cursor: number, fingerprint: string, timeline: CallTimeline): Promise<void> {
  timeline.check();
  try {
    await timeline.retry(() => ctx.recallHistory.withSnapshot(sessionId as SessionId, async (snapshot, signal) => {
      if (await fingerprintHistory(historyPrefix(snapshot, cursor), signal) !== fingerprint) throw new RecallError('stale_reference', 'Fixed native source changed.', true);
    }, timeline.signal, { waitForQuiescence: true }));
    timeline.check();
  } catch (error) {
    timeline.check();
    throw sourceFailure(error, fingerprint);
  }
}
export function sourceFailure(error: unknown, identity: string): unknown {
  if (error instanceof RecallError) return error;
  const code = (error as { code?: string })?.code ?? '';
  if (['SESSION_QUERY_SESSION_NOT_FOUND', 'SESSION_QUERY_CORRUPT_SESSION', 'SESSION_QUERY_SOURCE_CONFLICT', 'SESSION_QUERY_EVENT_NOT_FOUND',
    'SESSION_QUERY_INVALID_SURFACE', 'recall/history-inconsistent', 'recall/records-source-changed', 'recall/range-source-unverified', 'recall/range-invalid', 'recall/range-unsupported'].includes(code)) {
    return new RecallError('stale_reference', 'Native source is missing, damaged or no longer matches its original provenance.', true, 'No newer range was substituted.', identity);
  }
  return error; // Unknown/transient IO is an ordinary execution failure, never a repeated invalid operation.
}
