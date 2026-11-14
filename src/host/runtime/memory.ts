import { Service, type Context } from '@deepseek-ai/cordis';
import { RecallError } from '../protocol.js';
import { DEFAULT_CACHE_MIB, type RecallConfig } from './config.js';
import type { CanonicalRecord } from '../history/records.js';
import type {} from '../state/page-state.js';

export const RECALL_MEMORY_LIMITS = Object.freeze({ bytes: DEFAULT_CACHE_MIB * 1024 * 1024, sessions: 1024 });
const OWNER = 192, HOLDER = 160, RECORD_REF = 40, RECORD_ENTRY = 64;

/** Logical retained bytes v1, NOT a V8 heap/RSS prediction. Shared metadata is
 * deduplicated within a root; different holders conservatively charge it again.
 * Canonical bodies have separate identity/ref accounting across all holders. */
export function retainedBytes(root: unknown, excluded?: ReadonlySet<object>): number {
  const seen = new WeakSet<object>(), stack: unknown[] = [root];
  let bytes = 0;
  while (stack.length) {
    const value = stack.pop();
    if (typeof value === 'string') { bytes += 24 + value.length * 2; continue; }
    if (typeof value !== 'object' || value === null) { bytes += 8; continue; }
    if (seen.has(value) || excluded?.has(value)) { bytes += 8; continue; }
    seen.add(value);
    if (Array.isArray(value)) { bytes += 24 + value.length * 8; for (const item of value) stack.push(item); }
    else if (value instanceof Map) { bytes += 48 + value.size * 48; for (const [key, item] of value) stack.push(key, item); }
    else if (value instanceof Set) { bytes += 48 + value.size * 32; for (const item of value) stack.push(item); }
    else { const values = Object.values(value); bytes += 32 + values.length * 16; for (const item of values) stack.push(item); }
  }
  return bytes;
}
interface Owner { id: string; holders: Set<MemoryHolder>; touched: number; evicting: boolean; }
interface Body { refs: number; bytes: number; }
const exhausted = () => new RecallError('cache_resource_limit', 'Recall derived-memory capacity is exhausted; no partial record or result batch was admitted.', false,
  'Active recall work retains cache capacity. Evicted cursor state is unavailable; source refs are verified independently.');

/** A holder releases only its references, never another holder's canonical body. */
export class MemoryHolder {
  readonly records = new Set<CanonicalRecord>();
  bytes = 0;
  disposed = false;
  constructor(readonly budget: RecallMemoryBudget, readonly owner: Owner, readonly label: string, readonly onEvict: () => void) {}
  resize(bytes: number): void { this.budget.resize(this, bytes); }
  add(bytes: number, records: readonly CanonicalRecord[] = []): void { this.budget.add(this, bytes, records); }
  clear(): void { this.budget.release(this, false); }
  dispose(): void { this.budget.release(this, true); }
}

/** Host-wide derived caches only. Durable S/R/F, feedback and hash ledgers are
 * deliberately outside this component and are never deleted by eviction. */
export class RecallMemoryBudget {
  private readonly owners = new Map<string, Owner>();
  private readonly pins = new Map<string, number>();
  private readonly reclaimOnIdle = new Set<string>();
  private readonly bodies = new Map<CanonicalRecord, Body>();
  private readonly sizes = new WeakMap<CanonicalRecord, number>();
  private used = 0;
  private peak = 0;
  private clock = 0;
  private evictions = 0;
  private rejected = 0;
  private closed = false;
  readonly limitBytes: number;
  readonly maxSessions: number;
  constructor(options: { limitBytes?: number; maxSessions?: number; isCurrent?: (id: string) => boolean } = {}) {
    this.limitBytes = options.limitBytes ?? RECALL_MEMORY_LIMITS.bytes;
    this.maxSessions = options.maxSessions ?? RECALL_MEMORY_LIMITS.sessions;
    if (![this.limitBytes, this.maxSessions].every(n => Number.isSafeInteger(n) && n > 0)) throw new TypeError('Memory limits must be positive safe integers');
    this.isCurrent = options.isCurrent ?? (() => false);
  }
  private readonly isCurrent: (id: string) => boolean;
  pin(id: string): () => void {
    if (this.closed) throw exhausted();
    this.pins.set(id, (this.pins.get(id) ?? 0) + 1); this.touch(id);
    let released = false;
    return () => {
      if (released) return; released = true;
      const n = (this.pins.get(id) ?? 1) - 1;
      if (n) this.pins.set(id, n); else {
        this.pins.delete(id);
        const reclaim = this.reclaimOnIdle.delete(id);
        if (this.closed || reclaim) this.evict(id);
      }
    };
  }
  pinned(id: string): boolean { return this.pins.has(id); }
  pendingReclaim(id: string): boolean { return this.reclaimOnIdle.has(id); }
  touch(id: string): void { const owner = this.owners.get(id); if (owner) owner.touched = ++this.clock; }
  hold(id: string, label: string, onEvict: () => void): MemoryHolder {
    if (this.closed) throw exhausted();
    let owner = this.owners.get(id);
    if (owner?.evicting) throw exhausted();
    this.reserve(() => HOLDER + (owner ? 0 : OWNER + id.length * 2), id, owner ? 0 : 1);
    if (!owner) {
      owner = { id, holders: new Set(), touched: ++this.clock, evicting: false };
      this.owners.set(id, owner); this.used += OWNER + id.length * 2;
    }
    const holder = new MemoryHolder(this, owner, label, onEvict);
    owner.holders.add(holder); this.used += HOLDER; this.touch(id); this.highWater();
    return holder;
  }
  private highWater() { this.peak = Math.max(this.peak, this.used); }
  private reserve(delta: () => number, except: string, owners = 0) {
    if (this.used + delta() <= this.limitBytes && this.owners.size + owners <= this.maxSessions) return;
    const candidates = [...this.owners.values()].filter(o => o.id !== except && !o.evicting && !this.pinned(o.id))
      .sort((a, b) => Number(this.isCurrent(a.id)) - Number(this.isCurrent(b.id)) || a.touched - b.touched);
    for (const candidate of candidates) {
      this.evict(candidate.id);
      if (this.used + delta() <= this.limitBytes && this.owners.size + owners <= this.maxSessions) return;
    }
    // An owner that fills its own budget must not be stuck on every retry,
    // which would pin it again before LRU could reclaim it. Drain first.
    if (this.pinned(except)) this.reclaimOnIdle.add(except);
    this.rejected++; throw exhausted();
  }
  private valid(holder: MemoryHolder, bytes: number) {
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new TypeError('Retained bytes must be a nonnegative safe integer');
    if (holder.disposed || holder.owner.evicting || this.closed) throw exhausted();
  }
  resize(holder: MemoryHolder, bytes: number): void {
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new TypeError('Retained bytes must be a nonnegative safe integer');
    if (holder.disposed) { if (bytes === 0) return; throw exhausted(); }
    if (bytes > holder.bytes) { this.valid(holder, bytes); this.reserve(() => bytes - holder.bytes, holder.owner.id); }
    this.used += bytes - holder.bytes; holder.bytes = bytes; this.touch(holder.owner.id); this.highWater();
  }
  add(holder: MemoryHolder, bytes: number, records: readonly CanonicalRecord[]): void {
    this.valid(holder, bytes);
    const fresh = [...new Set(records)].filter(record => !holder.records.has(record));
    for (const record of fresh) if (!this.sizes.has(record)) this.sizes.set(record, retainedBytes(record) + RECORD_ENTRY);
    const delta = () => bytes + fresh.length * RECORD_REF + fresh.reduce((n, record) => n + (this.bodies.has(record) ? 0 : this.sizes.get(record)!), 0);
    this.reserve(delta, holder.owner.id);
    this.used += delta(); holder.bytes += bytes;
    for (const record of fresh) {
      const body = this.bodies.get(record) ?? { refs: 0, bytes: this.sizes.get(record)! };
      body.refs++; this.bodies.set(record, body); holder.records.add(record);
    }
    this.touch(holder.owner.id); this.highWater();
  }
  release(holder: MemoryHolder, dispose: boolean): void {
    if (holder.disposed) return;
    this.used -= holder.bytes + holder.records.size * RECORD_REF; holder.bytes = 0;
    for (const record of holder.records) {
      const body = this.bodies.get(record)!;
      if (--body.refs === 0) { this.bodies.delete(record); this.used -= body.bytes; }
    }
    holder.records.clear();
    if (dispose) {
      holder.disposed = true; holder.owner.holders.delete(holder); this.used -= HOLDER;
      if (!holder.owner.holders.size) { this.owners.delete(holder.owner.id); this.used -= OWNER + holder.owner.id.length * 2; }
    }
  }
  /** Whole inactive session. Callbacks must remove actual JS owners before the
   * corresponding accounting is released. A failed callback is not freed. */
  evict(id: string): boolean {
    const owner = this.owners.get(id);
    if (!owner || owner.evicting || this.pinned(id)) return false;
    owner.evicting = true;
    try {
      for (const holder of [...owner.holders]) if (!holder.disposed) { holder.onEvict(); holder.dispose(); }
      this.evictions++; return true;
    } finally { owner.evicting = false; }
  }
  close(): void { this.closed = true; for (const id of this.owners.keys()) this.evict(id); }
  stats() {
    return { version: 1, limitBytes: this.limitBytes, usedBytes: this.used, peakBytes: this.peak, sessions: this.owners.size,
      holders: [...this.owners.values()].reduce((n, o) => n + o.holders.size, 0), uniqueRecords: this.bodies.size,
      recordBytes: [...this.bodies.values()].reduce((n, b) => n + b.bytes, 0),
      recordReferences: [...this.bodies.values()].reduce((n, b) => n + b.refs, 0), pinnedSessions: this.pins.size,
      pins: [...this.pins.values()].reduce((n, v) => n + v, 0), reclaimOnIdle: this.reclaimOnIdle.size,
      evictions: this.evictions, rejected: this.rejected, closed: this.closed };
  }
}

declare module '@deepseek-ai/cordis' { interface Context { recallMemory: RecallMemoryService; } }
export class RecallMemoryService extends Service {
  static inject = ['recallPages'];
  readonly budget: RecallMemoryBudget;
  constructor(ctx: Context, options: Pick<RecallConfig, 'cacheMiB'> = { cacheMiB: DEFAULT_CACHE_MIB }) {
    super(ctx, 'recallMemory');
    this.budget = new RecallMemoryBudget({ limitBytes: options.cacheMiB * 1024 ** 2, isCurrent: id => ctx.recallPages.snapshot().some(page => page.phase === 'open'
      && page.view?.sessionId === id && page.view.selection === 'selected' && page.view.conversationVisible && !page.view.closed) });
    ctx.effect(() => () => this.budget.close());
  }
}
