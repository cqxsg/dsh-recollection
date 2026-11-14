import { randomBytes } from 'node:crypto';
import { Service, type Context } from '@deepseek-ai/cordis';
import { defineDomain, domainTable, type KvTable } from '@deepseek-ai/dsh-storage-domain';
import { z } from 'zod';
import { argumentsHash } from '../runtime/identity.js';
import { RecallError } from '../protocol.js';
import { referenceHandle } from './reference-store.js';
import { retainedBytes } from '../runtime/memory.js';
import { MappingWriteQueue } from './mapping-write-queue.js';

const hash = z.string().regex(/^[a-f0-9]{64}$/), index = z.number().int().nonnegative();
const sessionId = z.string().min(1);
const readLocator = z.strictObject({ anchorRef: referenceHandle, readStateId: hash, index, charOffset: index });
const positions = {
  search: z.strictObject({ sessionId, kind: z.literal('search'), locator: z.strictObject({ queryId: hash, order: z.enum(['newest', 'oldest']), index }) }),
  read: z.strictObject({ sessionId, kind: z.literal('read'), locator: readLocator }),
  files: z.strictObject({ sessionId, kind: z.literal('files'), locator: readLocator.extend({ fileIndex: index }) }),
};
const cursorTarget = z.discriminatedUnion('kind', [positions.search, positions.read, positions.files]);
export type CursorTarget = z.infer<typeof cursorTarget>;
export type CursorKind = CursorTarget['kind'];
const prefixes = { search: 'rs3_', read: 'rd3_', files: 'rf3_' } as const;
const stored = { version: z.literal(3), handle: z.string().regex(/^r[sdf]3_[A-Za-z0-9_-]{22}$/), pageId: hash };

/** Fixed page identity, independent of handle, object key order, balances and delivery. */
export function cursorPageId(target: CursorTarget): string {
  const p = target.locator;
  const fields = target.kind === 'search' ? [target.locator.queryId, target.locator.order, p.index]
    : [target.locator.anchorRef, target.locator.readStateId, p.index, target.locator.charOffset, ...(target.kind === 'files' ? [target.locator.fileIndex] : [])];
  return argumentsHash(['recall-cursor', 3, target.sessionId, target.kind, ...fields]);
}
export const cursorRecord = z.discriminatedUnion('kind', [positions.search.extend(stored), positions.read.extend(stored), positions.files.extend(stored)])
  .superRefine((record, ctx) => {
    if (record.pageId !== cursorPageId(record)) ctx.addIssue({ code: 'custom', message: 'Cursor page identity does not match its location' });
    if (!record.handle.startsWith(prefixes[record.kind])) ctx.addIssue({ code: 'custom', message: 'Cursor handle type differs from its location' });
  });
export type CursorRecord = z.infer<typeof cursorRecord>;
export const cursorDomainSpec = defineDomain({ name: 'dsh_recall_cursors_v3', version: 3, layout: 'per-record', invalidRecords: 'backup-and-skip',
  tables: { pages: domainTable<string, CursorRecord>(cursorRecord) } });

/** Same rendered size as an issued handle; candidates never allocate or persist mappings. */
export const cursorPlaceholder = (kind: CursorKind): string => `${prefixes[kind]}${'A'.repeat(22)}`;
const unavailable = (handle: string) => new RecallError('stale_reference', 'Cursor format, type, session or persisted mapping cannot be verified.', true,
  'Use an unchanged nextCursor from this executing session; search or read its source again if unavailable.', argumentsHash(handle));

declare module '@deepseek-ai/cordis' { interface Context { recallCursors: RecallCursorStore; } }

/** Durable location metadata only. Fixed results, delivery and S/R/F have separate owners. */
export class RecallCursorStore extends Service {
  static inject = ['storageDomain', 'recallReferences'];
  private table: KvTable<string, CursorRecord> | undefined;
  private readonly byHandle = new Map<string, string>();
  private readonly writes = new MappingWriteQueue();
  private readonly lifetime = new AbortController();
  private closing = false;
  constructor(ctx: Context) { super(ctx, 'recallCursors'); }

  async [Service.init]() {
    const domain = await this.ctx.storageDomain.open(cursorDomainSpec);
    try {
      this.table = domain.table('pages');
      this.rebuildIndex();
      this.ctx.effect(() => async () => {
        this.closing = true;
        this.lifetime.abort(new RecallError('recall_unloaded', 'Recall cursor storage unloaded.'));
        await this.writes.drain();
        this.byHandle.clear(); this.table = undefined;
        await domain.close();
      });
    } catch (error) { this.byHandle.clear(); this.table = undefined; await domain.close(); throw error; }
  }

  /** Rebuildable reverse index; native domain rows remain the persisted authority. */
  rebuildIndex(): void {
    const next = new Map<string, string>();
    for (const [key, row] of this.table!.entries()) {
      if (key !== row.pageId || next.has(row.handle)) throw new RecallError('cursor_store_invalid', 'Cursor storage contains a conflicting key or handle.');
      next.set(row.handle, key);
    }
    this.byHandle.clear(); for (const [handle, page] of next) this.byHandle.set(handle, page);
  }

  resolve(handle: string, session: string, tool: 'search'): Extract<CursorRecord, { kind: 'search' }>;
  resolve(handle: string, session: string, tool: 'read'): Exclude<CursorRecord, { kind: 'search' }>;
  resolve(handle: string, session: string, tool: 'search' | 'read'): CursorRecord {
    if (this.closing || !this.table) throw new RecallError('recall_unloaded', 'Recall cursor storage is unavailable.');
    const key = this.byHandle.get(handle), row = key && this.table.get(key);
    if (!row || row.sessionId !== session || (tool === 'search' ? row.kind !== 'search' : row.kind === 'search')) throw unavailable(handle);
    if (row.kind !== 'search') this.ctx.recallReferences.resolve(row.locator.anchorRef, session);
    return structuredClone(row);
  }

  async issue(target: CursorTarget, callerSignal: AbortSignal): Promise<CursorRecord> {
    // Parse a private deep copy before waiting, including the nested locator.
    const position = cursorTarget.parse(target), pageId = cursorPageId(position);
    const signal = AbortSignal.any([callerSignal, this.lifetime.signal]);
    const reusable = () => {
      signal.throwIfAborted();
      if (this.closing || !this.table) throw new RecallError('recall_unloaded', 'Recall cursor storage is unavailable.');
      if (position.kind !== 'search') this.ctx.recallReferences.resolve(position.locator.anchorRef, position.sessionId);
      const existing = this.table.get(pageId);
      if (existing && this.byHandle.get(existing.handle) === pageId) {
        return position.kind === 'search' ? this.resolve(existing.handle, position.sessionId, 'search')
          : this.resolve(existing.handle, position.sessionId, 'read');
      }
    };
    const saved = reusable();
    if (saved) return saved;
    return this.writes.run(signal, async () => {
      const existing = reusable();
      if (existing) return existing;
      let handle: string;
      do { handle = prefixes[position.kind] + randomBytes(16).toString('base64url'); } while (this.byHandle.has(handle));
      const row = cursorRecord.parse({ ...position, version: 3, handle, pageId });
      try { await this.table!.put(pageId, row); }
      catch { throw new RecallError('cursor_write_failed', 'The continuation mapping could not be saved; no continuation was returned.'); }
      // A pending native write is drained even after cancellation; never publish a non-durable handle.
      this.byHandle.set(handle, pageId);
      signal.throwIfAborted();
      return structuredClone(row);
    });
  }

  records(): CursorRecord[] { return structuredClone(this.table ? [...this.table.entries()].map(([, value]) => value) : []); }
  stats() {
    const rows = this.table ? [...this.table.entries()] : [];
    return { records: rows.length, logicalBytes: rows.reduce((sum, [, row]) => sum + Buffer.byteLength(JSON.stringify(row)), 0),
      retainedRecordBytes: retainedBytes(rows), indexBytes: retainedBytes(this.byHandle), indexEntries: this.byHandle.size,
      pendingWrites: this.writes.size, closed: this.closing };
  }
}
