import { Service, type Context } from '@deepseek-ai/cordis';
import { HarnessError } from '@deepseek-ai/dsh-llm';
import { performance } from 'node:perf_hooks';
import type { Session, SessionEvent, SessionId } from '@deepseek-ai/dsh-session';
import { isReplacementSurfaceEvent } from '@deepseek-ai/dsh-session/surface';
import type { ViewState } from '../../shared/view-protocol.js';
import { snapshotPrefix, type HistorySnapshot } from './history.js';
import { fingerprintHistory, HistoryRecordCache, type CanonicalRecord, type PreparedRecordBatch, type RecordBatchOptions } from './records.js';
import type {} from '../state/page-state.js';
import { PreparationScheduler, type OperationTicket } from '../runtime/scheduler.js';
import { performanceDiagnostics } from '../runtime/performance.js';
import { retainedBytes, type MemoryHolder, type RecallMemoryBudget } from '../runtime/memory.js';

declare module '@deepseek-ai/cordis' {
  interface Context { recallPreparation: RecallPreparationService; }
}

export class RecallPreparationError extends HarnessError {
  constructor(readonly code: 'recall/preparation-source-changed' | 'recall/preparation-stale-source' | 'recall/preparation-expired' | 'recall/preparation-unloaded', message: string) {
    super(message, code); this.name = 'RecallPreparationError';
  }
}

/** Fixed completed selection. Body access must go through the owning Host service. */
export interface PreparedSession {
  readonly sessionId: SessionId;
  readonly cursor: number;
  readonly batch: PreparedRecordBatch;
  readonly fingerprint: string;
}
export interface PreparationStatus {
  readonly sessionId: SessionId;
  readonly state: 'queued' | 'preparing' | 'ready' | 'failed';
  readonly cursor: number | null;
  readonly targetCursor: number | null;
  readonly preparedCursor: number | null;
  readonly waiters: number;
  readonly bufferedEvents: number;
  readonly records: number;
  readonly batches: number;
  readonly observations: number;
  readonly error: string | null;
  readonly priority: 'current' | 'waiting' | 'background' | null;
  readonly queueOrder: number | null;
  readonly preemptions: number;
  readonly timings: Readonly<PreparationTimings>;
}
export interface PreparationTimings {
  observationMs: number;
  verificationMs: number;
  classificationMs: number;
  metadataMs: number;
  extractionMs: number;
  maxBatchMs: number;
}
/** Trusted Host configuration, not a Remote or model argument. */
export interface PreparationOptions {
  readonly maxBufferedEvents?: number;
  readonly batch?: Omit<RecordBatchOptions, 'selection'>;
}
interface Waiter {
  demand: number;
  resolve(value: PreparedSession): void;
  reject(reason: unknown): void;
  detach(): void;
}
interface Seal { cursor: number; fingerprint: string; }
interface Task {
  readonly kind: 'history';
  readonly sessionId: SessionId;
  readonly order: number;
  readonly entry: Entry;
  waiters: number;
  demand: number | undefined;
  minimum: number;
  unpin?: (() => void) | undefined;
}
interface HashTask {
  kind: 'hash'; key: string; sessionId: SessionId; order: number; waiters: number;
  run(signal: AbortSignal): Promise<boolean>; failed(error: unknown): void;
}
interface OperationTask { kind: 'operation'; sessionId: SessionId; order: number; waiters: number; }
type WorkTask = Task | HashTask | OperationTask;
interface Entry {
  id: SessionId;
  cache: HistoryRecordCache;
  epoch: number;
  abort: AbortController;
  state: PreparationStatus['state'];
  instance: WeakRef<Session> | undefined;
  cursor: number | null;
  buffer: Set<number>;
  rescanAt: number;
  changeSeq: number;
  demand: number;
  satisfied: number;
  target: { cursor: number; demand: number } | undefined;
  seal: Seal | undefined;
  prepared: PreparedSession | undefined;
  waiters: Set<Waiter>;
  batches: number;
  observations: number;
  error: unknown;
  task: Task | undefined;
  preemptions: number;
  timings: PreparationTimings;
  memory: MemoryHolder | undefined;
}
const affectsRange = (event: SessionEvent) => isReplacementSurfaceEvent(event) || (event.type as string) === 'image/offload';
const errorCode = (error: unknown) => error instanceof HarnessError ? error.code : error instanceof Error ? error.name : 'preparation-failed';

/** Borrow a prefix only for this callback; all access still checks the native lease. */
function prefix(snapshot: HistorySnapshot, cursor: number): HistorySnapshot {
  if (snapshot.cursor < cursor || snapshot.inheritedEventCount > cursor + 1) throw new RecallPreparationError('recall/preparation-source-changed', 'Native history no longer contains the verified prefix');
  return snapshotPrefix(snapshot, cursor);
}

/**
 * One merged task per session. Strict priorities are reconsidered after each batch.
 * Native subscriptions precede every observation; no snapshot survives a batch.
 */
export class RecallPreparationService extends Service {
  static inject = ['recallPages', 'recallMemory', 'recallHistory', 'sessions', 'agents'];
  private readonly entries = new Map<SessionId, Entry>();
  private readonly handles = new WeakMap<PreparedSession, { entry: Entry; epoch: number }>();
  private readonly scheduler = new PreparationScheduler<WorkTask>();
  private readonly supplemental = new Set<HashTask | OperationTask>();
  private readonly lifetime = new AbortController();
  private nextOrder = 0;
  private readonly maxBufferedEvents: number;
  private readonly batch: Omit<RecordBatchOptions, 'selection'>;
  private active: Entry | undefined;
  private scheduled: ReturnType<typeof setImmediate> | undefined;
  private running: Promise<void> | undefined;
  private hashing: Promise<void> | undefined;
  private closed = false;
  private readonly memory: RecallMemoryBudget | undefined;
  private readonly entryBytes: number;

  constructor(ctx: Context, options: PreparationOptions = {}) {
    super(ctx, 'recallPreparation');
    this.maxBufferedEvents = options.maxBufferedEvents ?? 1024;
    this.memory = ctx.get('recallMemory')?.budget;
    this.entryBytes = 1024 + this.maxBufferedEvents * 24;
    if (!Number.isSafeInteger(this.maxBufferedEvents) || this.maxBufferedEvents < 1) throw new TypeError('maxBufferedEvents must be a positive safe integer');
    // Target 1 MiB of UTF-16 text per batch; an oversized whole record is alone.
    // Keep the 16 ms extraction slice and a complete strong proof per lease.
    this.batch = { maxRecords: 256, maxTextChars: 524_288, ...options.batch };
    ctx.on('session/event', (session, event) => this.append(session, event));
    ctx.on('session/created', session => this.instanceChanged(session));
    ctx.on('session/disposed', session => this.instanceChanged(session, true));
    ctx.on('recall/view-accepted', (view, selectionChanged) => {
      this.view(view, selectionChanged);
      this.scheduler.update(this.tasks(), ctx.recallPages.snapshot());
    });
    ctx.effect(() => async () => {
      this.closed = true;
      if (this.scheduled) clearImmediate(this.scheduled);
      this.scheduled = undefined;
      const error = new RecallPreparationError('recall/preparation-unloaded', 'Recall preparation service unloaded');
      this.lifetime.abort(error); this.supplemental.clear();
      for (const entry of this.entries.values()) {
        entry.abort.abort(error); entry.epoch++;
        this.rejectWaiters(entry, error); entry.cache.dispose(); entry.buffer.clear();
        entry.prepared = undefined; entry.target = undefined; entry.seal = undefined; entry.instance = undefined;
        if (entry !== this.active) entry.task?.unpin?.();
        entry.task = undefined; entry.memory?.dispose();
      }
      this.scheduler.clear();
      // withSnapshot drains the provider and callback, including a late lease.
      await this.running;
      await this.hashing;
      this.entries.clear();
    });
    for (const page of ctx.recallPages.snapshot()) if (page.phase === 'open' && page.view) this.view(page.view);
    this.scheduler.update(this.tasks(), ctx.recallPages.snapshot());
  }

  private view(view: ViewState, revalidate = false): void {
    if (view.selection === 'selected' && view.sessionId && view.conversationVisible && !view.closed) this.warm(view.sessionId, revalidate);
  }

  private entry(id: SessionId): Entry {
    if (this.closed) throw new RecallPreparationError('recall/preparation-unloaded', 'Recall preparation service unloaded');
    if (typeof id !== 'string' || !id.length) throw new TypeError('An explicit native SessionId is required');
    let entry = this.entries.get(id);
    if (!entry) {
      let cacheMemory: MemoryHolder | undefined, memory: MemoryHolder | undefined;
      const evict = () => this.evictEntry(entry!);
      try {
      memory = this.memory?.hold(id, 'prepared-selection', evict);
      memory?.resize(this.entryBytes);
      cacheMemory = this.memory?.hold(id, 'prepared-records', evict);
      entry = { id, cache: new HistoryRecordCache(cacheMemory), memory, epoch: 0, abort: new AbortController(), state: 'queued', instance: undefined,
        cursor: null, buffer: new Set(), rescanAt: -1, changeSeq: -1, demand: 1, satisfied: 0, target: undefined,
        seal: undefined, prepared: undefined, waiters: new Set(), batches: 0, observations: 0, error: undefined,
        task: undefined, preemptions: 0, timings: { observationMs: 0, verificationMs: 0, classificationMs: 0, metadataMs: 0, extractionMs: 0, maxBatchMs: 0 } };
      this.entries.set(id, entry);
      } catch (error) { cacheMemory?.dispose(); memory?.dispose(); throw error; }
    }
    this.memory?.touch(id);
    return entry;
  }

  private evictEntry(entry: Entry): void {
    if (this.entries.get(entry.id) !== entry) return;
    entry.epoch++; entry.abort.abort(new RecallPreparationError('recall/preparation-expired', 'Inactive preparation was evicted'));
    if (entry.task) { this.scheduler.finish(entry.task); entry.task.unpin?.(); }
    entry.task = undefined; entry.cache.dispose(); entry.buffer.clear();
    entry.prepared = undefined; entry.target = undefined; entry.seal = undefined; entry.instance = undefined;
    entry.memory?.dispose(); this.entries.delete(entry.id);
  }
  private forgetPrepared(entry: Entry): void {
    entry.prepared = undefined;
    if (entry.memory) entry.memory.resize(Math.min(this.entryBytes, entry.memory.bytes));
  }

  /** Authorized page listeners only register demand; no Session lookup or history I/O. */
  warm(id: SessionId, revalidate = false): void {
    let entry: Entry;
    try { entry = this.entry(id); }
    catch (error) { if ((error as { code?: string })?.code === 'cache_resource_limit') return; throw error; }
    if (revalidate && (entry.state === 'ready' || entry.state === 'failed')) {
      entry.demand++; entry.state = 'queued'; entry.error = undefined;
    }
    if (entry.state !== 'ready' && entry.state !== 'failed') this.enqueue(entry);
  }

  /**
   * Trusted Host callers authorize the explicit id before calling. A new wait on
   * a ready/failed entry revalidates its source. Cancellation removes one waiter,
   * never the shared preparation. Joining a task waits for its fixed demand cut.
   */
  wait(id: SessionId, signal?: AbortSignal): Promise<PreparedSession> {
    try { signal?.throwIfAborted(); } catch (error) { return Promise.reject(error); }
    let entry: Entry;
    let unpin: (() => void) | undefined;
    try { unpin = this.memory?.pin(id); entry = this.entry(id); } catch (error) { unpin?.(); return Promise.reject(error); }
    if (entry.state === 'ready' || entry.state === 'failed') { entry.demand++; entry.error = undefined; }
    const pending = new Promise<PreparedSession>((resolve, reject) => {
      const cancel = () => {
        entry.waiters.delete(waiter); waiter.detach();
        if (entry.task) entry.task.waiters = entry.waiters.size;
        reject(signal!.reason);
      };
      const waiter: Waiter = { demand: entry.demand, resolve, reject, detach: () => { signal?.removeEventListener('abort', cancel); unpin?.(); } };
      entry.waiters.add(waiter);
      signal?.addEventListener('abort', cancel, { once: true });
    });
    this.enqueue(entry);
    return pending;
  }

  records(prepared: PreparedSession): readonly CanonicalRecord[] {
    const owner = this.handles.get(prepared);
    if (this.closed || !owner || owner.epoch !== owner.entry.epoch) throw new RecallPreparationError('recall/preparation-expired', 'Prepared selection no longer belongs to this source generation');
    return owner.entry.cache.records(prepared.batch);
  }

  status(id: SessionId): PreparationStatus | undefined {
    const entry = this.entries.get(id);
    return entry && Object.freeze({ sessionId: id, state: entry.state, cursor: entry.cursor, targetCursor: entry.target?.cursor ?? null,
      preparedCursor: entry.prepared?.cursor ?? null, waiters: entry.waiters.size, bufferedEvents: entry.buffer.size,
      records: entry.cache.stats().records, batches: entry.batches, observations: entry.observations, error: entry.error === undefined ? null : errorCode(entry.error),
      priority: entry.task ? ({ 0: 'current', 2: 'waiting', 4: 'background' } as const)[this.scheduler.priority(entry.task) as 0 | 2 | 4] : null,
      queueOrder: entry.task?.order ?? null, preemptions: entry.preemptions, timings: Object.freeze({ ...entry.timings }) });
  }
  snapshot(): readonly PreparationStatus[] { return Object.freeze([...this.entries.keys()].map(id => this.status(id)!)); }

  private rejectWaiters(entry: Entry, error: unknown): void {
    for (const waiter of entry.waiters) { waiter.detach(); waiter.reject(error); }
    entry.waiters.clear();
    if (entry.task) entry.task.waiters = 0;
  }

  private instanceChanged(session: Session, disposed = false): void {
    if (this.closed) return;
    const current = this.ctx.recallPages.snapshot().some(page => page.phase === 'open' && page.view?.sessionId === session.id
      && page.view.selection === 'selected' && page.view.conversationVisible && !page.view.closed);
    if (disposed && !current && this.memory && !this.memory.pinned(session.id) && this.memory.evict(session.id)) return;
    const entry = this.entries.get(session.id);
    if (!entry) return;
    const error = new RecallPreparationError('recall/preparation-source-changed', 'Native session instance was replaced or disposed');
    entry.abort.abort(error); entry.abort = new AbortController(); entry.epoch++;
    if (entry.task) this.scheduler.finish(entry.task);
    if (entry !== this.active) entry.task?.unpin?.();
    entry.task = undefined;
    entry.cache.clear(); entry.seal = undefined; this.forgetPrepared(entry); entry.target = undefined;
    entry.instance = undefined; entry.cursor = null; entry.buffer.clear(); entry.rescanAt = -1; entry.changeSeq = -1;
    entry.demand++; entry.error = undefined; entry.state = 'queued';
    this.rejectWaiters(entry, error);
    this.enqueue(entry);
  }

  private changed(entry: Entry, seq: number): void {
    if (seq > entry.changeSeq) { entry.changeSeq = seq; entry.demand++; }
    entry.error = undefined;
    this.enqueue(entry);
  }
  private rescan(entry: Entry, seq: number): void {
    if (seq > entry.rescanAt) { entry.rescanAt = seq; entry.demand++; }
    this.enqueue(entry);
  }

  private append(session: Session, event: SessionEvent): void {
    const entry = this.entries.get(session.id);
    if (!entry || this.closed) return;
    const previous = entry.instance?.deref();
    if (previous && previous !== session) this.instanceChanged(session);
    entry.instance = new WeakRef(session);
    if (entry.cursor !== null && event.seq <= entry.cursor) return;
    if (entry.cursor !== null && event.seq !== entry.cursor + 1) this.rescan(entry, event.seq);
    if (affectsRange(event)) this.changed(entry, event.seq);
    entry.cursor = event.seq;
    if (entry.state !== 'ready') {
      if (entry.buffer.size >= this.maxBufferedEvents) { entry.buffer.clear(); this.rescan(entry, event.seq); }
      entry.buffer.add(event.seq);
    }
  }

  private enqueue(entry: Entry): void {
    if (this.closed) return;
    entry.task ??= { kind: 'history', sessionId: entry.id, order: ++this.nextOrder, entry, waiters: entry.waiters.size, demand: undefined, minimum: -1 };
    entry.task.waiters = entry.waiters.size;
    if (this.active === entry) {
      if (entry.state === 'ready' || entry.state === 'failed') entry.state = 'queued';
      return;
    }
    entry.state = 'queued';
    this.kick();
  }

  /** Shared queue: batches own their resources and return true only at a terminal state. */
  scheduleHash(key: string, sessionId: SessionId, run: HashTask['run'], failed: HashTask['failed']): () => void {
    if (this.closed) throw new RecallPreparationError('recall/preparation-unloaded', 'Preparation service unloaded');
    let task = [...this.supplemental].find((t): t is HashTask => t.kind === 'hash' && t.key === key);
    if (!task) {
      const peer = [...this.supplemental].find(t => t.kind === 'hash' && t.sessionId === sessionId);
      task = { kind: 'hash', key, sessionId, order: peer?.order ?? ++this.nextOrder, waiters: 0, run, failed };
      this.supplemental.add(task);
    }
    const owned = task; this.scheduler.update(this.tasks(), this.ctx.recallPages.snapshot()); this.kick();
    return () => { this.supplemental.delete(owned); this.scheduler.finish(owned); this.kick(); };
  }
  /** Current-session business keeps precedence while history preparation may still run. */
  holdOperation(sessionId: SessionId): (() => void) & { readonly ticket: OperationTicket } {
    const task: OperationTask = { kind: 'operation', sessionId, order: ++this.nextOrder, waiters: 0 };
    this.supplemental.add(task); this.scheduler.update(this.tasks(), this.ctx.recallPages.snapshot());
    return Object.assign(() => { this.supplemental.delete(task); this.scheduler.finish(task); this.kick(); }, {
      ticket: Object.freeze({ sessionId, order: task.order, priority: () => this.scheduler.priority(task) }),
    });
  }
  workSnapshot() {
    this.scheduler.update(this.tasks(), this.ctx.recallPages.snapshot());
    return this.tasks().map(t => ({ sessionId: t.sessionId, kind: t.kind, order: t.order, priority: this.scheduler.priority(t), ...(t.kind === 'hash' ? { key: t.key } : {}) }));
  }
  private kick(): void {
    if (this.closed) return;
    if (this.running || this.scheduled) return;
    // A macrotask boundary is intentional: receipt handling never starts a read.
    this.scheduled = this.ctx.agents.withoutInitiator(() => setImmediate(() => {
      this.scheduled = undefined;
      this.running = this.pump().finally(() => { this.running = undefined; });
    }));
  }

  private bridge(entry: Entry, snapshot: HistorySnapshot): void {
    for (const seq of entry.buffer) if (seq <= snapshot.cursor) entry.buffer.delete(seq);
    let expected = snapshot.cursor + 1;
    for (const seq of [...entry.buffer].sort((a, b) => a - b)) {
      if (seq !== expected) this.rescan(entry, seq);
      expected = seq + 1;
    }
    entry.cursor = Math.max(entry.cursor ?? -1, snapshot.cursor);
    if (snapshot.cursor >= entry.rescanAt) entry.rescanAt = -1;
  }

  private tasks(): WorkTask[] { return [...[...this.entries.values()].flatMap(entry => entry.task ? [entry.task] : []), ...this.supplemental]; }

  /** One batch owns one native lease; unfinished targets survive return. */
  private async runBatch(task: Task): Promise<void> {
    const entry = task.entry, epoch = entry.epoch, signal = entry.abort.signal;
    if (task.demand === undefined) { task.demand = entry.demand; task.minimum = entry.rescanAt; }
    const demand = task.demand, minimum = task.minimum;
    const started = performance.now();
    const trace = performanceDiagnostics()?.begin('preparation.batch', { sessionId: entry.id, demand, targetCursor: entry.target?.cursor ?? null });
    const acquisition = performanceDiagnostics()?.begin('preparation.acquire', { sessionId: entry.id });
    entry.state = 'preparing';
    try {
      task.unpin ??= this.memory?.pin(entry.id);
      const instance = this.ctx.sessions.get(entry.id);
      entry.instance = instance ? new WeakRef(instance) : undefined;
      signal.throwIfAborted();
      const batch = await this.ctx.recallHistory.withSnapshot(entry.id, async (snapshot, scope) => {
        acquisition?.field('source', snapshot.source); acquisition?.end();
        const observedAt = performance.now();
        entry.timings.observationMs += observedAt - started;
        entry.observations++;
        if (snapshot.cursor < minimum) throw new RecallPreparationError('recall/preparation-stale-source', 'Native observation is behind already committed notifications');
        // A digest verifies even an uncached source, truncation or a rewritten
        // prefix. This also guards cold reads across persistence revisions.
        const cut = prefix(snapshot, entry.target?.cursor ?? snapshot.cursor);
        if (entry.seal) {
          const fingerprint = await fingerprintHistory(entry.seal.cursor === cut.cursor ? cut : prefix(snapshot, entry.seal.cursor), scope);
          scope.throwIfAborted();
          if (fingerprint !== entry.seal.fingerprint) throw new RecallPreparationError('recall/preparation-source-changed', 'Verified native history prefix changed');
        }
        if (!entry.target) {
          entry.target = { cursor: snapshot.cursor, demand };
          const fingerprint = await fingerprintHistory(cut, scope);
          scope.throwIfAborted();
          entry.seal = { cursor: snapshot.cursor, fingerprint };
        }
        // A new snapshot may reveal a tail whose notification was lost. Only
        // real replacements/offloads expand recall demand; plain appends do not.
        for (let seq = entry.target.cursor + 1; seq <= snapshot.cursor; seq++) {
          if (affectsRange(snapshot.events[seq]!)) this.changed(entry, seq);
        }
        this.bridge(entry, snapshot);
        entry.timings.verificationMs += performance.now() - observedAt;
        const batch = await entry.cache.prepareBatch(cut, this.ctx.sessions.messageProjections, this.batch, scope);
        const timings = entry.cache.timings();
        entry.timings.classificationMs += timings!.classificationMs;
        entry.timings.metadataMs += timings!.metadataMs;
        entry.timings.extractionMs += timings!.extractionMs;
        return batch;
      }, signal, { waitForQuiescence: true });
      signal.throwIfAborted(); entry.batches++;
      trace?.field('targetCursor', batch.cursor); trace?.field('status', batch.status);
      trace?.count('preparedRecords', batch.preparedInBatch); trace?.count('reusedRecords', batch.reusedRecords); trace?.end();
      entry.timings.maxBatchMs = Math.max(entry.timings.maxBatchMs, performance.now() - started);
      if (batch.status !== 'complete') { entry.state = 'queued'; return; }
      entry.cache.releaseMetadata();
      const prepared = Object.freeze({ sessionId: entry.id, cursor: batch.cursor, batch, fingerprint: entry.seal!.fingerprint });
      entry.memory?.resize(this.entryBytes + retainedBytes(prepared));
      this.handles.set(prepared, { entry, epoch }); entry.prepared = prepared;
      entry.satisfied = demand; entry.target = undefined; entry.state = entry.demand > demand ? 'queued' : 'ready'; entry.error = undefined;
      if (entry.state === 'ready') entry.buffer.clear();
      for (const waiter of entry.waiters) if (waiter.demand <= demand) {
        entry.waiters.delete(waiter); waiter.detach(); waiter.resolve(prepared);
      }
      this.scheduler.finish(task); entry.task = undefined;
      return;
    } catch (error) {
      acquisition?.end('failed'); trace?.end(signal.aborted ? 'cancelled' : 'failed');
      if (this.closed || epoch !== entry.epoch) return;
      entry.epoch++; entry.cache.clear(); entry.seal = undefined; this.forgetPrepared(entry); entry.target = undefined;
      entry.buffer.clear(); entry.state = 'failed'; entry.error = error;
      this.rejectWaiters(entry, error);
      this.scheduler.finish(task); entry.task = undefined;
    } finally {
      if (this.closed || entry.task !== task) { task.unpin?.(); task.unpin = undefined; }
    }
  }

  private async pump(): Promise<void> {
    let previous: WorkTask | undefined;
    while (!this.closed) {
      const all = this.tasks(), pages = this.ctx.recallPages.snapshot();
      this.scheduler.update(all, pages);
      const candidates = all.filter(t => (t.kind !== 'hash' || !this.hashing) && (t.kind !== 'operation' || this.scheduler.priority(t) === 0));
      let task = this.scheduler.select(candidates, pages);
      if (task?.kind === 'operation') {
        task = candidates.filter((t): t is Task => t.kind === 'history' && this.scheduler.priority(t) === 0).sort((a, b) => a.order - b.order)[0];
        if (!task) break; // release/new history demand wakes the pump; no polling.
      }
      if (!task) break;
      if (previous?.kind === 'history' && previous !== task && previous.entry.task === previous) previous.entry.preemptions++;
      if (task.kind === 'hash') {
        // At most one hash batch owns I/O, but its provider wait cannot hold
        // the history lane. Keep ownership until actual settlement on unload.
        const hash = task;
        this.hashing = Promise.resolve().then(() => hash.run(this.lifetime.signal)).then(done => {
          if (done) { this.supplemental.delete(hash); this.scheduler.finish(hash); }
        }, error => {
          this.supplemental.delete(hash); this.scheduler.finish(hash);
          if (!this.closed) {
            try { hash.failed(error); }
            catch (failure) { this.ctx.logger.warn('Recall hash failure reporting failed: %s', String(failure)); }
          }
        }).finally(() => { this.hashing = undefined; this.kick(); });
      } else {
        const entry = task.entry; this.active = entry;
        await this.runBatch(task); this.active = undefined;
        if (!this.closed && !entry.task && entry.state !== 'failed' && entry.demand > entry.satisfied) this.enqueue(entry);
      }
      previous = task;
      // Observe newly arrived higher-priority work at the next batch boundary.
      await new Promise<void>(resolve => setImmediate(resolve));
    }
  }
}
