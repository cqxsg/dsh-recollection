import { randomBytes } from 'node:crypto';
import { Service, type Context } from '@deepseek-ai/cordis';
import { defineDomain, domainTable, type KvTable } from '@deepseek-ai/dsh-storage-domain';
import { z } from 'zod';
import { argumentsHash } from '../runtime/identity.js';
import { retainedBytes } from '../runtime/memory.js';
import { MappingWriteQueue } from './mapping-write-queue.js';
import { RecallError } from '../protocol.js';
import type { CanonicalRecord } from '../history/records.js';

const hash = z.string().regex(/^[a-f0-9]{64}$/), index = z.number().int().nonnegative();
export const referenceHandle = z.string().regex(/^rr2_[A-Za-z0-9_-]{22}$/);
export const referencePlaceholder = `rr2_${'A'.repeat(22)}`;
export const recordLocatorSchema = z.strictObject({
  sessionId: z.string().min(1), formatVersion: index, historyId: hash, seq: index, recordId: hash, fingerprint: hash,
});
export type RecordLocator = z.infer<typeof recordLocatorSchema>;
export function recordLocator(record: CanonicalRecord): RecordLocator {
  const o = record.origin;
  return { sessionId: o.sessionId, formatVersion: o.formatVersion, historyId: o.historyId, seq: o.seq, recordId: record.id, fingerprint: record.fingerprint };
}
export const recordKey = (locator: RecordLocator): string => argumentsHash(['recall-reference', 1, locator.sessionId,
  locator.formatVersion, locator.historyId, locator.seq, locator.recordId, locator.fingerprint]);
export const referenceRecord = recordLocatorSchema.extend({ version: z.literal(1), handle: referenceHandle, recordKey: hash })
  .superRefine((row, ctx) => {
    if (row.recordKey !== recordKey(row)) ctx.addIssue({ code: 'custom', message: 'Reference identity does not match its source location' });
  });
export type ReferenceRecord = z.infer<typeof referenceRecord>;
export const referenceShards = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));
export const referenceDomainSpec = (shard: string) => defineDomain({ name: `dsh_recall_references_${shard}`, version: 1, layout: 'per-record', invalidRecords: 'backup-and-skip',
  tables: { records: domainTable<string, ReferenceRecord>(referenceRecord) } });
const unavailable = (handle: string) => new RecallError('stale_reference', 'Record reference format, session or persisted mapping cannot be verified.', true,
  'Search the original history again to obtain a current reference.', argumentsHash(handle));

declare module '@deepseek-ai/cordis' { interface Context { recallReferences: RecallReferenceStore; } }

/** Durable source locations only. A mapping never proves that the native source still exists. */
export class RecallReferenceStore extends Service {
  static inject = ['storageDomain'];
  private table: Pick<KvTable<string, ReferenceRecord>, 'get' | 'put' | 'delete' | 'entries'> | undefined;
  private readonly tables = new Map<string, KvTable<string, ReferenceRecord>>();
  private readonly byHandle = new Map<string, string>();
  private readonly writes = new MappingWriteQueue();
  private readonly lifetime = new AbortController();
  private closing = false;
  constructor(ctx: Context) { super(ctx, 'recallReferences'); }

  async [Service.init]() {
    const domains: { close(): Promise<void> }[] = [];
    const close = async () => { for (const domain of domains.reverse()) await domain.close(); this.tables.clear(); };
    try {
      // The native JSON backend reads each domain's files concurrently. Sequential
      // hash shards keep measured source populations below its open-file ceiling.
      for (const shard of referenceShards) {
        const domain = await this.ctx.storageDomain.open(referenceDomainSpec(shard));
        domains.push(domain); this.tables.set(shard, domain.table('records'));
      }
      const tables = this.tables, target = (key: string) => tables.get(key.slice(0, 2))!;
      this.table = { get: key => target(key)?.get(key), put: (key, row) => target(key).put(key, row), delete: key => target(key).delete(key),
        *entries() { for (const table of tables.values()) yield* table.entries(); } };
      this.rebuildIndex();
      this.ctx.effect(() => async () => {
        this.closing = true;
        this.lifetime.abort(new RecallError('recall_unloaded', 'Recall reference storage unloaded.'));
        await this.writes.drain();
        this.byHandle.clear(); this.table = undefined;
        await close();
      });
    } catch (error) { this.byHandle.clear(); this.table = undefined; await close(); throw error; }
  }

  rebuildIndex(): void {
    const next = new Map<string, string>();
    for (const [shard, table] of this.tables) for (const [key, row] of table.entries()) {
      if (!key.startsWith(shard) || key !== row.recordKey || next.has(row.handle)) throw new RecallError('reference_store_invalid', 'Reference storage contains a conflicting shard, key or handle.');
      next.set(row.handle, key);
    }
    this.byHandle.clear(); for (const [handle, key] of next) this.byHandle.set(handle, key);
  }

  resolve(handle: string, sessionId: string): ReferenceRecord {
    if (this.closing || !this.table) throw new RecallError('recall_unloaded', 'Recall reference storage is unavailable.');
    const key = this.byHandle.get(handle), row = key && this.table.get(key);
    if (!referenceHandle.safeParse(handle).success || !row || row.sessionId !== sessionId) throw unavailable(handle);
    return structuredClone(row);
  }

  private newHandle(): string { return `rr2_${randomBytes(16).toString('base64url')}`; }

  async issue(locator: RecordLocator, callerSignal: AbortSignal): Promise<ReferenceRecord> {
    // Capture a validated copy before queuing; callers cannot change a queued source location.
    const source = recordLocatorSchema.parse(locator), key = recordKey(source);
    const signal = AbortSignal.any([callerSignal, this.lifetime.signal]);
    const reusable = () => {
      signal.throwIfAborted();
      if (this.closing || !this.table) throw new RecallError('recall_unloaded', 'Recall reference storage is unavailable.');
      const existing = this.table.get(key);
      // The reverse index is published only after put settles (or validated startup).
      if (existing && this.byHandle.get(existing.handle) === key) return this.resolve(existing.handle, source.sessionId);
    };
    const saved = reusable();
    if (saved) return saved;
    return this.writes.run(signal, async () => {
      const existing = reusable();
      if (existing) return existing;
      let handle: string | undefined;
      for (let attempt = 0; attempt < 8; attempt++) {
        const candidate = this.newHandle();
        if (candidate !== referencePlaceholder && !this.byHandle.has(candidate)) { handle = candidate; break; }
      }
      if (!handle) throw new RecallError('reference_allocation_failed', 'A unique source reference could not be allocated; retry the operation.');
      const row = referenceRecord.parse({ ...source, version: 1, handle, recordKey: key });
      try { await this.table!.put(key, row); }
      catch { throw new RecallError('reference_write_failed', 'The source reference mapping could not be saved; no result page was returned.'); }
      this.byHandle.set(handle, key);
      // Native writes drain even on cancellation. Publish only after durability and caller checks.
      signal.throwIfAborted();
      return structuredClone(row);
    });
  }

  records(): ReferenceRecord[] { return structuredClone(this.table ? [...this.table.entries()].map(([, row]) => row) : []); }
  stats() {
    const rows = this.table ? [...this.table.entries()] : [];
    return { records: rows.length, logicalBytes: rows.reduce((sum, [, row]) => sum + Buffer.byteLength(JSON.stringify(row)), 0),
      retainedRecordBytes: retainedBytes(rows), indexBytes: retainedBytes(this.byHandle), indexEntries: this.byHandle.size,
      shards: this.tables.size, maxShardRecords: Math.max(0, ...[...this.tables.values()].map(t => [...t.entries()].length)),
      pendingWrites: this.writes.size, closed: this.closing };
  }
}
