import { Service, type Context } from '@deepseek-ai/cordis';
import { defineDomain, domainTable, type KvTable } from '@deepseek-ai/dsh-storage-domain';
import type {} from '@deepseek-ai/dsh-fs';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { argumentsHash } from '../runtime/identity.js';
import type { RecallConfig } from '../runtime/config.js';
import { RecallError } from '../protocol.js';
import { absoluteFilePath } from './attachments.js';
import { HashComputation, HashSliceEnd, hashSlice, hashReason, retryHash, HASH_SLICE_MS } from './hashing.js';

const text = z.string().min(1), n = z.number().int().nonnegative();
export const hashSource = z.strictObject({ sessionId: text, seq: n, messageId: text, block: n, selector: text,
  fingerprint: text, referenceText: text, path: text, cwd: text.optional(), recordedAt: n });
export type HashSource = z.infer<typeof hashSource>;
const sample = z.strictObject({ algorithm: z.literal('sha256'), hash: z.string().regex(/^[a-f0-9]{64}$/), size: n, startedAt: n, completedAt: n });
export const hashRecord = z.strictObject({ version: z.literal(1), source: hashSource, revision: n,
  resolvedPath: text.optional(), registeredAt: n, limits: z.strictObject({ attempts: n.positive(), activeMs: n.positive() }),
  attempts: n, spentMs: z.number().finite().nonnegative(), reserved: z.strictObject({ id: text, ms: z.number().positive() }).optional(),
  state: z.enum(['pending', 'sampling', 'saved', 'failed']), reason: text.optional(), sample: sample.optional(),
}).superRefine((r, ctx) => {
  const fail = (message: string) => ctx.addIssue({ code: 'custom', message });
  if (r.attempts > r.limits.attempts) fail('Attempts exceed original limits');
  if (r.reserved && (r.state !== 'sampling' || !r.attempts || r.spentMs + r.reserved.ms > r.limits.activeMs)) fail('Invalid active reservation');
  if ((r.state === 'saved') !== !!r.sample || (r.sample && (r.reserved || !r.attempts || r.sample.completedAt < r.sample.startedAt))) fail('Saved baseline requires a completed, settled sample');
  if (r.state === 'failed' && (!r.reason || r.reserved)) fail('Terminal failure must be settled and have a reason');
});
export type HashRecord = z.infer<typeof hashRecord>;
export const hashKey = (source: Pick<HashSource, 'sessionId' | 'seq' | 'messageId' | 'block' | 'selector'>) => argumentsHash([source.sessionId, source.seq, source.messageId, source.block, source.selector]);
export const hashLedgerSpec = defineDomain({ name: 'dsh_recall_hashes', version: 1, layout: 'single', tables: { baselines: domainTable<string, HashRecord>(hashRecord) } });
declare module '@deepseek-ai/cordis' { interface Context { recallHashes: RecallHashLedger; } }

/** One Host owns this domain. Registration and every activity allowance are durable before byte I/O. */
export class RecallHashLedger extends Service {
  static inject = ['storageDomain', 'fs'];
  private table!: KvTable<string, HashRecord>;
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly progress = new Map<string, HashComputation>();
  private readonly lifetime = new AbortController();
  private closing = false;
  constructor(ctx: Context, readonly config: RecallConfig) { super(ctx, 'recallHashes'); }
  async [Service.init]() {
    const domain = await this.ctx.storageDomain.open(hashLedgerSpec); this.table = domain.table('baselines');
    try {
      for (const [key, original] of this.table.entries()) {
        if (key !== hashKey(original.source)) throw new RecallError('hash_ledger_invalid', 'Baseline key does not match its native source.');
        if (original.state === 'sampling' || original.reserved) {
          const value = structuredClone(original);
          value.spentMs += value.reserved?.ms ?? 0; delete value.reserved;
          value.state = 'pending'; value.reason = 'interrupted';
          this.exhausted(value); await this.put(key, value);
        }
      }
      this.ctx.effect(() => async () => {
        this.closing = true; this.lifetime.abort(new RecallError('recall_unloaded', 'Hash service unloaded.'));
        await Promise.allSettled(this.queues.values()); this.progress.clear(); await domain.close();
      });
    } catch (error) { await domain.close(); throw error; }
  }
  records(): HashRecord[] { return structuredClone([...this.table.entries()].map(([, value]) => value)); }
  get(key: string): HashRecord | undefined { const value = this.table.get(key); return value && structuredClone(value); }
  /** Trusted Host admission only. Cold-history discovery must never call this. */
  register(source: HashSource): Promise<string> {
    const parsed = hashSource.parse(source), key = hashKey(parsed);
    return this.serial(key, async () => {
      const old = this.table.get(key);
      if (old) {
        if (argumentsHash(old.source) !== argumentsHash(parsed)) throw new RecallError('hash_source_changed', 'Existing reference provenance changed.');
        return key;
      }
      const value: HashRecord = { version: 1, source: parsed, revision: 0, registeredAt: Date.now(),
        limits: { attempts: this.config.hashAttempts, activeMs: this.config.hashActiveMs }, attempts: 0, spentMs: 0, state: 'pending' };
      if (!absoluteFilePath(source.path) && !source.cwd) { value.state = 'failed'; value.reason = 'historical_working_directory_unavailable'; }
      else {
        try {
          const target = await this.ctx.fs.resolve(source.path, { ...(source.cwd ? { cwd: source.cwd } : {}), signal: this.lifetime.signal });
          value.resolvedPath = this.ctx.fs.processPath(target);
        } catch (error) { this.lifetime.signal.throwIfAborted(); value.state = 'failed'; value.reason = hashReason(error); }
      }
      await this.put(key, value); return key;
    });
  }
  /** One scheduler batch. Pauses retain digest state but hold no active time reservation. */
  step(key: string, signal?: AbortSignal): Promise<HashRecord> {
    return this.serial(key, async () => {
      const scope = signal ? AbortSignal.any([signal, this.lifetime.signal]) : this.lifetime.signal;
      scope.throwIfAborted();
      let value = this.get(key);
      if (!value) throw new RecallError('hash_task_missing', 'No registered baseline task.');
      if (value.state === 'saved' || value.state === 'failed') return value;
      if (value.reserved) {
        // A previous write/cancellation may have left an uncertain slice even
        // without a process restart. Never overwrite that allowance for free.
        value.spentMs += value.reserved.ms; delete value.reserved;
        value.state = 'pending'; value.reason = 'interrupted'; this.progress.delete(key);
        const exhausted = this.exhausted(value); await this.put(key, value);
        if (exhausted) return value;
      }
      let computation = this.progress.get(key);
      if (this.exhausted(value, !computation)) { await this.put(key, value); return value; }
      if (!computation) value.attempts++;
      const ticket = { id: randomUUID(), ms: Math.min(HASH_SLICE_MS, value.limits.activeMs - value.spentMs) };
      value.state = 'sampling'; value.reserved = ticket;
      await this.put(key, value); // Both attempt and activity reservation precede work.
      scope.throwIfAborted();
      if (!computation) { computation = new HashComputation(this.ctx.fs, value.resolvedPath ?? value.source.path, value.source.cwd); this.progress.set(key, computation); }
      const result = await hashSlice(computation, ticket.ms, scope);
      value = this.get(key)!;
      if (value.reserved?.id !== ticket.id) throw new RecallError('hash_ledger_invalid', 'Hash reservation identity changed.');
      value.spentMs += result.elapsed; delete value.reserved;
      if (value.spentMs >= value.limits.activeMs) { value.state = 'failed'; value.reason = 'hash_time_exhausted'; this.progress.delete(key); }
      else if (scope.aborted) { value.state = 'pending'; value.reason = 'interrupted'; this.progress.delete(key); }
      else if (result.sample) { value.state = 'saved'; value.sample = result.sample; delete value.reason; this.progress.delete(key); }
      else if (result.error && !(result.error instanceof HashSliceEnd)) {
        value.reason = hashReason(result.error); this.progress.delete(key);
        value.state = retryHash(result.error) && value.attempts < value.limits.attempts ? 'pending' : 'failed';
      }
      await this.put(key, value); // Failed publication cannot become a saved baseline.
      scope.throwIfAborted(); return value;
    });
  }
  fail(key: string, reason: string): Promise<void> {
    return this.serial(key, async () => {
      const value = this.get(key); if (!value || value.state === 'saved' || value.state === 'failed') return;
      value.spentMs += value.reserved?.ms ?? 0; delete value.reserved;
      value.state = 'failed'; value.reason = reason; this.progress.delete(key); await this.put(key, value);
    });
  }
  bytes(key: string): number { return this.progress.get(key)?.bytes ?? 0; }
  private exhausted(value: HashRecord, nextAttempt = true): boolean {
    if (value.spentMs >= value.limits.activeMs || (nextAttempt && value.attempts >= value.limits.attempts)) {
      value.state = 'failed'; value.reason = value.spentMs >= value.limits.activeMs ? 'hash_time_exhausted' : 'hash_attempts_exhausted'; return true;
    }
    return false;
  }
  private async put(key: string, value: HashRecord) {
    value.revision++;
    try { await this.table.put(key, hashRecord.parse(value)); }
    catch (error) { this.progress.delete(key); throw new RecallError('hash_write_failed', `Hash metadata persistence failed: ${(error as Error).message}`); }
  }
  private serial<T>(key: string, run: () => Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(new RecallError('recall_unloaded', 'Hash service is unloading.'));
    const task = (this.queues.get(key) ?? Promise.resolve()).then(run);
    const tail = task.then(() => undefined, () => undefined); this.queues.set(key, tail);
    void tail.then(() => { if (this.queues.get(key) === tail) this.queues.delete(key); });
    return task;
  }
}
