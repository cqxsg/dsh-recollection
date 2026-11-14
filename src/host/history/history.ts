import { Service, type Context } from '@deepseek-ai/cordis';
import { HarnessError } from '@deepseek-ai/dsh-llm';
import type { SessionObservation } from '@deepseek-ai/dsh-session-query';
import type { SessionId } from '@deepseek-ai/dsh-session/types';

declare module '@deepseek-ai/cordis' {
  interface Context { recallHistory: RecallHistoryService; }
}

/** A native immutable cut, usable only while its owning callback is running. */
export type HistorySnapshot = Pick<SessionObservation,
  'source' | 'header' | 'inheritedEventCount' | 'events' | 'cursor' | 'revision'>;

// A matching cursor or an arbitrary caller-created object is not a native lease.
const scopedSnapshots = new WeakSet<HistorySnapshot>();
export function isScopedSnapshot(snapshot: HistorySnapshot): boolean {
  if (!scopedSnapshots.has(snapshot)) return false;
  void snapshot.events; // Guard even cached proof access after the owning lease closes.
  return true;
}
/** Internal prefix of the SAME owned immutable cut; never transfers its lifetime. */
export function snapshotPrefix(snapshot: HistorySnapshot, cursor: number): HistorySnapshot {
  if (!Number.isSafeInteger(cursor) || cursor < -1 || cursor > snapshot.cursor || snapshot.inheritedEventCount > cursor + 1) throw new RecallHistoryError('recall/history-inconsistent', 'Invalid history prefix');
  if (snapshot.cursor === cursor) return snapshot;
  const events = snapshot.events.slice(0, cursor + 1);
  const cut: HistorySnapshot = Object.freeze({
    get source() { return snapshot.source; }, get header() { return snapshot.header; },
    get inheritedEventCount() { return snapshot.inheritedEventCount; },
    get cursor() { void snapshot.cursor; return cursor as HistorySnapshot['cursor']; },
    get events() { void snapshot.events; return events; },
  });
  if (isScopedSnapshot(snapshot)) scopedSnapshots.add(cut);
  return cut;
}

export interface HistoryScopeOptions {
  /** Native tool bodies must drain owned work before returning on cancellation. */
  readonly waitForQuiescence?: boolean;
}

export class RecallHistoryError extends HarnessError {
  constructor(readonly code: 'recall/history-scope-closed' | 'recall/history-inconsistent' | 'recall/history-invalid-id', message: string) {
    super(message, code);
    this.name = 'RecallHistoryError';
  }
}

/** Observe settlement even after cancellation, including a late provider rejection. */
function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  let abort: () => void;
  return new Promise<T>((resolve, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    pending.then(resolve, reject);
    if (signal.aborted) abort();
  }).finally(() => signal.removeEventListener('abort', abort));
}

/** Host-only access. Authorization and the explicit SessionId belong to the caller. */
export class RecallHistoryService extends Service {
  static inject = ['sessionQuery'];
  private readonly lifetime = new AbortController();

  constructor(ctx: Context) {
    super(ctx, 'recallHistory');
    ctx.effect(() => () => this.lifetime.abort(new DOMException('Recall history service unloaded', 'AbortError')));
  }

  /**
   * Own exactly one observation until the callback settles or its scope aborts.
   * Native query errors and callback errors propagate unchanged. A consumer may
   * extract needed records in memory, but must not retain this view for later use.
   */
  async withSnapshot<T>(sessionId: SessionId, operation: (snapshot: HistorySnapshot, signal: AbortSignal) => T | Promise<T>, callerSignal?: AbortSignal, options: HistoryScopeOptions = {}): Promise<T> {
    const signal = callerSignal ? AbortSignal.any([callerSignal, this.lifetime.signal]) : this.lifetime.signal;
    signal.throwIfAborted();
    if (typeof sessionId !== 'string' || !sessionId.length) {
      throw new RecallHistoryError('recall/history-invalid-id', 'An explicit native SessionId is required');
    }
    let observation: SessionObservation | undefined;
    let pending: Promise<SessionObservation> | undefined;
    let consuming: Promise<T> | undefined;
    let closed = false;
    const close = () => {
      closed = true;
      const owned = observation;
      observation = undefined;
      owned?.[Symbol.dispose]();
    };
    signal.addEventListener('abort', close, { once: true });
    try {
      pending = this.ctx.sessionQuery.observeSession(sessionId, { projectionMode: 'none', signal }).then(value => {
        // A provider may finish after cancellation. That late lease is still ours.
        if (closed || signal.aborted) {
          value[Symbol.dispose]();
          signal.throwIfAborted();
          throw new RecallHistoryError('recall/history-scope-closed', 'History scope is closed');
        }
        observation = value;
        return value;
      });
      const cut = await abortable(pending, signal);
      signal.throwIfAborted();
      if (cut.header.id !== sessionId || !Number.isSafeInteger(cut.cursor) || cut.cursor < -1
        || !Number.isSafeInteger(cut.inheritedEventCount) || cut.inheritedEventCount < 0 || cut.inheritedEventCount > cut.cursor + 1) {
        throw new RecallHistoryError('recall/history-inconsistent', 'Native history identity or cursor is inconsistent');
      }
      const read = <K extends keyof HistorySnapshot>(key: K): HistorySnapshot[K] => {
        if (!observation) throw new RecallHistoryError('recall/history-scope-closed', 'History scope is closed');
        return observation[key];
      };
      const snapshot: HistorySnapshot = {
        get source() { return read('source'); },
        get header() { return read('header'); },
        get inheritedEventCount() { return read('inheritedEventCount'); },
        get cursor() { return read('cursor'); },
        get events() {
          const events = read('events');
          const cursor = read('cursor');
          if (events.length !== cursor + 1 || (events.length > 0 && events.at(-1)?.seq !== cursor)) {
            throw new RecallHistoryError('recall/history-inconsistent', 'Native events do not match the captured cursor');
          }
          return events;
        },
      };
      // Preserve absence on live cuts and guard cold metadata after scope exit.
      if (cut.revision !== undefined) Object.defineProperty(snapshot, 'revision', { enumerable: true, get: () => read('revision') });
      Object.freeze(snapshot);
      scopedSnapshots.add(snapshot);
      consuming = Promise.resolve(operation(snapshot, signal));
      return await abortable(consuming, signal);
    } finally {
      signal.removeEventListener('abort', close);
      close();
      if (options.waitForQuiescence) {
        // Keep the original outcome; drain late completion/rejection after releasing
        // our lease. Cooperative tool timeouts may not abandon the source promise.
        await Promise.allSettled([pending, consuming]);
      }
    }
  }
}
