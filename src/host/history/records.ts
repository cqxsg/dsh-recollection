import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { isDeepStrictEqual } from 'node:util';
import { HarnessError, type ContentBlock } from '@deepseek-ai/dsh-llm';
import type { SessionEvent } from '@deepseek-ai/dsh-session/types';
import type { SessionMessageProjection } from '@deepseek-ai/dsh-session/surface';
import { isScopedSnapshot, type HistorySnapshot } from './history.js';
import { inspectHistorySources, type HistoryRange, type OriginalSource, type RangeBlock, type RangeExitReason } from './range.js';
import { performanceDiagnostics, type PerformanceSpan } from '../runtime/performance.js';
import { retainedBytes, type MemoryHolder } from '../runtime/memory.js';
import { commandInputPath, userHistoryContent } from './user-content.js';

type RecallContent = Extract<ContentBlock, { type: RangeBlock['type'] }>;
export interface RecordOrigin {
  readonly historyId: string;
  readonly sessionId: string;
  readonly formatVersion: number;
  readonly seq: number;
  readonly eventType: string;
  readonly time: number;
  readonly messageId: string;
  readonly sourceKind: string;
  readonly provider?: string;
  readonly model?: string;
  readonly interrupted?: true;
  readonly isError?: boolean;
  readonly authorship: 'human' | 'model' | 'tool' | 'injected';
  readonly turn: number | null;
  readonly step: number | null;
  readonly inherited: boolean;
  readonly contentPath: OriginalSource['contentPath'];
  readonly sourceEventSeqs: readonly number[];
}
export interface RecordTool {
  readonly callId: string;
  readonly name: string;
  /** Scoped by history identity and native turn/step, not callId alone. */
  readonly pairId: string;
}
export interface CanonicalBlock {
  readonly index: number;
  readonly path: string;
  readonly fingerprint: string;
  readonly content: Readonly<RecallContent>;
  readonly attachmentBytes: 'not_loaded' | 'not_applicable';
}
export interface CanonicalRecord {
  readonly id: string;
  readonly origin: RecordOrigin;
  readonly role: OriginalSource['role'];
  readonly kind: RangeBlock['kind'];
  readonly tool?: RecordTool;
  readonly blocks: readonly CanonicalBlock[];
  readonly fingerprint: string;
  readonly bodyComplete: true;
}
export interface RecordToolPair {
  readonly id: string;
  readonly callId: string;
  readonly callRecordIds: readonly string[];
  readonly resultRecordIds: readonly string[];
  readonly nativeCallSeqs: readonly number[];
  readonly status: 'paired' | 'result_excluded' | 'call_record_missing' | 'result_missing' | 'ambiguous';
}
export type RecordSelection = { readonly kind: 'recall' } | {
  readonly kind: 'events';
  readonly eventSeqs: readonly number[];
  readonly includeToolPairs?: boolean;
} | {
  readonly kind: 'records'; readonly recordIds: readonly string[]; readonly includeToolPairs?: boolean;
};
export interface RecordBatchOptions {
  readonly selection?: RecordSelection;
  readonly maxRecords?: number;
  readonly maxTextChars?: number;
  readonly chunkChars?: number;
  readonly yieldMs?: number;
  readonly maxBatchMs?: number;
}
export interface RecordBatchTimings {
  readonly classificationMs: number;
  readonly metadataMs: number;
  readonly extractionMs: number;
}
export interface PreparedRecordBatch {
  readonly status: 'complete' | 'incomplete';
  readonly historyId: string;
  readonly cursor: number;
  readonly range: HistoryRange;
  readonly recordIds: readonly string[];
  readonly pendingRecordIds: readonly string[];
  readonly preparedInBatch: number;
  readonly reusedRecords: number;
  readonly sources: readonly { readonly recordId: string; readonly retention: OriginalSource['retention']; readonly reasons: readonly RangeExitReason[] }[];
  readonly pairs: readonly RecordToolPair[];
}
export interface RecordBlockCoverage {
  readonly recordId: string;
  readonly path: string;
  readonly fingerprint: string;
  readonly contentComplete: true;
  readonly attachmentBytes: CanonicalBlock['attachmentBytes'];
}
export class RecallRecordsError extends HarnessError {
  constructor(readonly code: 'recall/records-invalid' | 'recall/records-scope' | 'recall/records-source-changed' | 'recall/records-incomplete' | 'recall/records-closed' | 'recall/records-busy', message: string) {
    super(message, code);
    this.name = 'RecallRecordsError';
  }
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
}

/** Original typed grammar, iterated without a generator/promise per tiny token.
 * The stack holds only one frame per nesting level; output stays chunk bounded. */
function* hashChunks(value: unknown, chunk: number): Generator<string> {
  interface Frame { value: unknown[] | Record<string, unknown>; keys: string[] | undefined; index: number; length: number; }
  const stack: Frame[] = [];
  let parts: string[] = [], length = 0;
  const add = (token: string) => { parts.push(token); length += token.length; };
  while (true) {
    if (value === null) add('n');
    else if (typeof value === 'string') {
      add(`s${value.length}:`);
      for (let start = 0; start < value.length; start += chunk) {
        add(value.slice(start, start + chunk));
        if (length >= chunk) { yield parts.join(''); parts = []; length = 0; }
      }
    } else if (typeof value === 'number' && Number.isFinite(value)) add(`d${JSON.stringify(value)};`);
    else if (typeof value === 'boolean') add(value ? 'b1' : 'b0');
    else if (Array.isArray(value)) {
      add(`a${value.length}:`); stack.push({ value, keys: undefined, index: 0, length: value.length });
    } else if (typeof value === 'object' && value !== null) {
      const object = value as Record<string, unknown>, keys = Object.keys(object).filter(key => object[key] !== undefined).sort();
      add(`o${keys.length}:`); stack.push({ value: object, keys, index: 0, length: keys.length * 2 });
    } else throw new RecallRecordsError('recall/records-invalid', 'Record metadata must be finite JSON values');
    if (length >= chunk) { yield parts.join(''); parts = []; length = 0; }
    let found = false;
    while (stack.length) {
      const frame = stack[stack.length - 1]!;
      if (frame.index >= frame.length) { stack.pop(); continue; }
      const at = frame.index++;
      value = frame.keys ? at % 2 ? (frame.value as Record<string, unknown>)[frame.keys[at >> 1]!] : frame.keys[at >> 1]
        : (frame.value as unknown[])[at];
      found = true; break;
    }
    if (!found) break;
  }
  if (length) yield parts.join('');
}
function identity(value: unknown, trace?: PerformanceSpan): string {
  const hash = createHash('sha256').update('dsh-recall-record-v1');
  let bytes = 0;
  for (const token of hashChunks(value, 16_384)) { hash.update(token, 'utf16le'); if (trace) bytes += token.length * 2; }
  trace?.count('hashedUtf16Bytes', bytes);
  return hash.digest('hex');
}
class WorkSlice {
  private chars = 0;
  private since = performance.now();
  constructor(readonly chunk: number, private readonly ms: number, private readonly signal?: AbortSignal) {}
  checkpoint(chars: number): Promise<void> | undefined {
    this.signal?.throwIfAborted();
    this.chars += chars;
    if (this.chars >= this.chunk || performance.now() - this.since >= this.ms) return this.pause();
    return undefined;
  }
  async pause() {
    await new Promise<void>(resolve => setImmediate(resolve));
    this.signal?.throwIfAborted();
    this.chars = 0; this.since = performance.now();
  }
  async fingerprint(value: unknown, trace?: PerformanceSpan): Promise<string> {
    const hash = createHash('sha256').update('dsh-recall-record-v1');
    let bytes = 0;
    try {
      for (const token of hashChunks(value, this.chunk)) {
        hash.update(token, 'utf16le');
        if (trace) bytes += token.length * 2;
        const pause = this.checkpoint(token.length); if (pause) await pause;
      }
      return hash.digest('hex');
    } finally { trace?.count('hashedUtf16Bytes', bytes); }
  }
}

const proofs = new WeakMap<HistorySnapshot, string>();
function verifiedProof(snapshot: HistorySnapshot): string | undefined { return isScopedSnapshot(snapshot) ? proofs.get(snapshot) : undefined; }
/** Internal cut seal: every NEW lease proves all content; only same-lease reuse is allowed. */
export async function fingerprintHistory(snapshot: HistorySnapshot, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  const proved = verifiedProof(snapshot);
  if (proved !== undefined) return proved;
  const trace = performanceDiagnostics()?.begin('preparation.fingerprint', { sessionId: snapshot.header.id, cursor: snapshot.cursor });
  trace?.count('events', snapshot.events.length);
  try {
    const fingerprint = await new WorkSlice(16_384, 8, signal).fingerprint({
      header: snapshot.header, inheritedEventCount: snapshot.inheritedEventCount, events: snapshot.events,
    }, trace);
    signal.throwIfAborted();
    if (isScopedSnapshot(snapshot)) proofs.set(snapshot, fingerprint);
    trace?.count('fullProofs', 1); trace?.end(); return fingerprint;
  } catch (error) { trace?.end('failed'); throw error; }
}

interface Descriptor {
  id: string;
  origin: RecordOrigin;
  role: OriginalSource['role'];
  kind: RangeBlock['kind'];
  tool?: RecordTool;
  source: OriginalSource;
  blocks: readonly RangeBlock[];
}
interface PreparedMetadata {
  proof: string; cursor: number; historyId: string; range: HistoryRange; originals: readonly OriginalSource[];
  all: Descriptor[]; byId: Map<string, Descriptor>; layouts: Map<number, string>; pairs: Map<string, RecordToolPair>;
}
const pairKey = (historyId: string, turn: number | null, step: number | null, id: string, trace?: PerformanceSpan) => identity([historyId, turn, step, id], trace);
const descriptorMetadata = (d: Descriptor) => ({ id: d.id, origin: d.origin, role: d.role, kind: d.kind, ...(d.tool ? { tool: d.tool } : {}) });
const recordMetadata = (r: CanonicalRecord) => ({ id: r.id, origin: r.origin, role: r.role, kind: r.kind, ...(r.tool ? { tool: r.tool } : {}) });

function nativeContent(event: SessionEvent): readonly ContentBlock[] {
  if (event.type === 'user/message') return userHistoryContent(event.data).content;
  if (event.type === 'assistant/message' || event.type === 'tool/result') return event.data.message.content;
  throw new RecallRecordsError('recall/records-invalid', `No original content at seq ${event.seq}`);
}
function descriptors(snapshot: HistorySnapshot, originals: readonly OriginalSource[], historyId: string, trace?: PerformanceSpan): Descriptor[] {
  const events = snapshot.events;
  const positions = new Map<number, { turn: number | null; step: number | null }>();
  let turn: number | null = null, step: number | null = null;
  for (const event of events) {
    if (event.type === 'turn/start') { turn = event.data.turn; step = null; }
    else if (event.type === 'step/start') step = event.data.step;
    else if (event.type === 'step/end') step = null;
    else if (event.type === 'turn/end') { turn = null; step = null; }
    if (event.type === 'user/message') positions.set(event.seq, { turn, step });
  }
  return originals.flatMap(source => {
    const event = events[source.seq]!;
    if (event.type !== 'user/message' && event.type !== 'assistant/message' && event.type !== 'tool/result') {
      throw new RecallRecordsError('recall/records-invalid', `Invalid original event ${source.seq}`);
    }
    const message = event.type === 'user/message' ? event.data : event.data.message;
    const position = event.type === 'user/message' ? positions.get(event.seq)! : { turn: event.data.turn, step: event.data.step };
    const origin: RecordOrigin = {
      historyId, sessionId: snapshot.header.id, formatVersion: snapshot.header.version,
      seq: event.seq, eventType: event.type, time: event.time, messageId: message.id, sourceKind: message.source.kind,
      ...(event.type === 'assistant/message' ? { provider: event.data.message.source.provider, model: event.data.message.source.model,
        ...(event.data.interrupted ? { interrupted: true as const } : {}) } : {}),
      ...(event.type === 'tool/result' && event.data.message.isError !== undefined ? { isError: event.data.message.isError } : {}),
      authorship: source.role === 'user' ? message.source.kind === 'user' ? 'human' : 'injected' : source.role === 'assistant' ? 'model' : 'tool',
      ...position, inherited: source.inherited, contentPath: source.contentPath, sourceEventSeqs: [...(event.sourceEventSeqs ?? [])],
    };
    const groups: RangeBlock[][] = [];
    if (event.type !== 'assistant/message') groups.push([...source.blocks]);
    else {
      const allowed = new Map(source.blocks.map(block => [block.index, block]));
      let body: RangeBlock[] = [];
      const flush = () => { if (body.length) groups.push(body); body = []; };
      for (const [index, block] of message.content.entries()) {
        // Even an excluded recall call separates the surrounding assistant text.
        if (block.type === 'tool-call') { flush(); if (allowed.has(index)) groups.push([allowed.get(index)!]); }
        else if (allowed.has(index)) body.push(allowed.get(index)!);
      }
      flush();
    }
    return groups.map(blocks => {
      const first = blocks[0]!;
      const id = identity([historyId, origin.seq, origin.messageId, first.kind, blocks.map(block => block.index)], trace);
      const tool = first.callId === undefined ? undefined : {
        callId: first.callId, name: first.toolName!, pairId: pairKey(historyId, origin.turn, origin.step, first.callId, trace),
      };
      return { id, origin, role: source.role, kind: first.kind, ...(tool ? { tool } : {}), source, blocks };
    });
  });
}

function toolPairs(all: readonly Descriptor[], events: readonly SessionEvent[], historyId: string, forwardedCalls: ReadonlySet<number>): Map<string, RecordToolPair> {
  const groups = new Map<string, { callId: string; callRecordIds: string[]; resultRecordIds: string[]; nativeCallSeqs: number[] }>();
  const group = (id: string, callId: string) => {
    if (!groups.has(id)) groups.set(id, { callId, callRecordIds: [], resultRecordIds: [], nativeCallSeqs: [] });
    return groups.get(id)!;
  };
  for (const d of all) {
    if (!d.tool) continue;
    const g = group(d.tool.pairId, d.tool.callId);
    (d.kind === 'tool_call' ? g.callRecordIds : g.resultRecordIds).push(d.id);
  }
  for (const event of events) if (event.type === 'tool/call') {
    const key = pairKey(historyId, event.data.turn, event.data.step, event.data.callId);
    // Excluded calls do not gain a pairing entry via their log-only duplicate.
    groups.get(key)?.nativeCallSeqs.push(event.seq);
  }
  return new Map([...groups].map(([id, g]) => {
    const excluded = g.nativeCallSeqs.some(seq => forwardedCalls.has(seq));
    let status: RecordToolPair['status'] = 'paired';
    if (g.callRecordIds.length > 1 || g.resultRecordIds.length + Number(excluded) > 1 || g.nativeCallSeqs.length > 1) status = 'ambiguous';
    else if (!g.callRecordIds.length) status = 'call_record_missing';
    else if (excluded) status = 'result_excluded';
    else if (!g.resultRecordIds.length) status = 'result_missing';
    return [id, freeze({ id, ...g, status })];
  }));
}

/** Metadata only; allows precise canonical-record context without extracting retained bodies. */
export function indexHistoryRecords(snapshot: HistorySnapshot, projections: readonly SessionMessageProjection[], signal?: AbortSignal) {
  const historyId = identity({ header: snapshot.header, inheritedEventCount: snapshot.inheritedEventCount });
  const inspection = inspectHistorySources(snapshot, projections, signal);
  const all = descriptors(snapshot, inspection.originals(), historyId);
  const events = snapshot.events;
  const records = all.map(d => ({
    ...descriptorMetadata(d), blockIndexes: d.blocks.map(b => b.index),
    textChars: d.blocks.every(block => block.type === 'text') ? textSize(nativeContent(events[d.origin.seq]!), d.blocks) : null,
  }));
  return freeze({ historyId, records, pairs: [...toolPairs(all, events, historyId, inspection.forwardedCalls).values()] });
}

const textSize = (content: readonly ContentBlock[], blocks: readonly RangeBlock[]) => blocks.reduce((size, block) => {
  const value = content[block.index]!;
  return size + (value.type === 'text' ? value.text.length : value.type === 'tool-call' ? value.name.length + value.arguments.length : 0);
}, 0);
function copyContent(block: RecallContent): RecallContent {
  // Strings are immutable. Only attachment metadata needs a detached object.
  return block.type === 'image' || block.type === 'file' ? { ...block, attachment: structuredClone(block.attachment) } as RecallContent : { ...block };
}

/** Per-session, memory-only canonical bodies. No queue, subscription or model tool. */
export class HistoryRecordCache {
  private binding: { sessionId: string; historyId: string } | undefined;
  private readonly entries = new Map<string, CanonicalRecord>();
  private readonly layouts = new Map<number, string>();
  private readonly batches = new WeakMap<PreparedRecordBatch, number>();
  private generation = 0;
  private busy = false;
  private closed = false;
  private timing: RecordBatchTimings | undefined;
  private metadata: PreparedMetadata | undefined;
  private storedBytes = 0;
  constructor(private readonly memory?: MemoryHolder) {}

  clear(): void {
    this.generation++; this.entries.clear(); this.layouts.clear(); this.binding = undefined; this.metadata = undefined;
    this.storedBytes = 0; this.memory?.clear();
  }
  dispose(): void { this.clear(); this.closed = true; this.memory?.dispose(); }
  /** Reuse is useful between fixed-task batches, not after the task has ended.
   * Canonical records, layout proofs and completed selection handles survive. */
  releaseMetadata(): void {
    if (this.busy) throw new RecallRecordsError('recall/records-busy', 'Cannot release metadata during a preparation batch');
    this.remember(undefined);
  }
  private remember(metadata: PreparedMetadata | undefined): void {
    const bytes = this.memory && metadata ? retainedBytes(metadata) : 0;
    this.memory?.resize(this.storedBytes + bytes);
    this.metadata = metadata;
  }
  stats() { return { records: this.entries.size, sourceBlocks: [...this.entries.values()].reduce((sum, record) => sum + record.blocks.length, 0) }; }
  /** Durations of the last successful batch, separate from deterministic records. */
  timings(): RecordBatchTimings | undefined { return this.timing; }
  private changed(message: string): never {
    this.clear();
    throw new RecallRecordsError('recall/records-source-changed', message);
  }
  private assertBatch(batch: PreparedRecordBatch) {
    if (this.closed || this.batches.get(batch) !== this.generation) throw new RecallRecordsError('recall/records-closed', 'Prepared selection no longer belongs to this cache generation');
  }
  records(batch: PreparedRecordBatch): readonly CanonicalRecord[] {
    this.assertBatch(batch);
    if (batch.status !== 'complete') throw new RecallRecordsError('recall/records-incomplete', 'Selected records have not all been prepared');
    return Object.freeze(batch.recordIds.map(id => this.entries.get(id)!));
  }
  coverage(batch: PreparedRecordBatch): readonly RecordBlockCoverage[] {
    this.assertBatch(batch);
    return freeze(batch.recordIds.flatMap(id => this.entries.get(id)?.blocks.map(block => ({
      recordId: id, path: block.path, fingerprint: block.fingerprint, contentComplete: true as const, attachmentBytes: block.attachmentBytes,
    })) ?? []));
  }

  /**
   * Call inside withSnapshot, then release its lease when this batch returns.
   * Repeat with a verified snapshot to continue; completed records are reused.
   * Cancellation retains completed records, never a partial searchable record.
   */
  async prepareBatch(snapshot: HistorySnapshot, projections: readonly SessionMessageProjection[], options: RecordBatchOptions = {}, signal?: AbortSignal): Promise<PreparedRecordBatch> {
    if (this.closed) throw new RecallRecordsError('recall/records-closed', 'Record cache is disposed');
    if (this.busy) throw new RecallRecordsError('recall/records-busy', 'Merge preparation requests before using the same cache concurrently');
    signal?.throwIfAborted();
    const settings = { maxRecords: options.maxRecords ?? 64, maxTextChars: options.maxTextChars ?? 65_536, chunkChars: options.chunkChars ?? 16_384, yieldMs: options.yieldMs ?? 8, maxBatchMs: options.maxBatchMs ?? 16 };
    if (Object.values(settings).some(value => !Number.isSafeInteger(value) || value <= 0)) throw new RecallRecordsError('recall/records-invalid', 'Batch settings must be positive safe integers');
    this.busy = true;
    this.timing = undefined;
    const generation = this.generation;
    let phase: PerformanceSpan | undefined;
    const assertLive = () => {
      signal?.throwIfAborted();
      if (this.closed || this.generation !== generation) throw new RecallRecordsError('recall/records-closed', 'Record preparation was invalidated');
      void snapshot.events;
    };
    try {
      const { header, inheritedEventCount, events, cursor } = snapshot;
      const historyId = identity({ header, inheritedEventCount });
      if (this.binding?.sessionId !== undefined && this.binding.sessionId !== header.id) throw new RecallRecordsError('recall/records-scope', 'The record cache is bound to a different native session');
      if (this.binding && this.binding.historyId !== historyId) this.changed('Native session identity changed');
      const classificationStart = performance.now();
      phase = performanceDiagnostics()?.begin('records.classify', { sessionId: header.id, cursor });
      phase?.count('events', events.length);
      const inspection = inspectHistorySources(snapshot, projections, signal);
      phase?.count('recallSources', inspection.range.sources.length); phase?.end();
      const metadataStart = performance.now(), originals = inspection.originals(), proof = verifiedProof(snapshot), previous = this.metadata;
      const reuse = proof !== undefined && previous?.proof === proof && previous.cursor === cursor && previous.historyId === historyId
        && isDeepStrictEqual(previous.range, inspection.range) && isDeepStrictEqual(previous.originals, originals);
      let all: Descriptor[], byId: Map<string, Descriptor>, layouts: Map<number, string>, pairs: Map<string, RecordToolPair>;
      if (reuse) {
        ({ all, byId, layouts, pairs } = previous);
        phase = performanceDiagnostics()?.begin('records.descriptors', { sessionId: header.id, cursor });
        phase?.count('metadataReuses', 1); phase?.end();
      } else {
        phase = performanceDiagnostics()?.begin('records.descriptors', { sessionId: header.id, cursor });
        all = descriptors(snapshot, originals, historyId, phase);
        phase?.count('descriptors', all.length); phase?.end();
        phase = performanceDiagnostics()?.begin('records.layouts', { sessionId: header.id, cursor });
        byId = new Map(all.map(d => [d.id, d]));
        layouts = new Map<number, string>();
        const perSource = new Map<number, Descriptor[]>();
        for (const d of all) { const group = perSource.get(d.origin.seq) ?? []; group.push(d); perSource.set(d.origin.seq, group); }
        for (const [seq, group] of perSource) layouts.set(seq, identity(group.map(d => ({ ...descriptorMetadata(d), blocks: d.blocks })), phase));
        phase?.count('layouts', layouts.size); phase?.end();
        phase = performanceDiagnostics()?.begin('records.compare', { sessionId: header.id, cursor });
        // Verify every cached source visible in this cut, including context-only
        // records. Older fixed cuts do not inspect later records in the cache.
        for (const [seq, layout] of this.layouts) if (seq <= cursor && layouts.get(seq) !== layout) this.changed(`Original source layout changed at seq ${seq}`);
        for (const record of this.entries.values()) {
          if (record.origin.seq > cursor) continue;
          phase?.count('cachedRecords', 1);
          const d = byId.get(record.id);
          if (!d || !isDeepStrictEqual(descriptorMetadata(d), recordMetadata(record))) this.changed(`Original record identity changed at seq ${record.origin.seq}`);
          const content = nativeContent(events[record.origin.seq]!);
          for (const block of record.blocks) {
            assertLive();
            phase?.count('blocks', 1);
            phase?.count('comparedTextCodeUnits', block.content.type === 'text' ? block.content.text.length : block.content.type === 'tool-call' ? block.content.name.length + block.content.arguments.length : 0);
            if (!isDeepStrictEqual(content[block.index], block.content)) this.changed(`Original content changed at ${block.path}, seq ${record.origin.seq}`);
          }
        }
        phase?.end();
        pairs = toolPairs(all, events, historyId, inspection.forwardedCalls);
        if (proof !== undefined) {
        // inspectHistorySources constructs/freezeTree's range and originals;
        // descriptors creates origins (including copied sourceEventSeqs), groups
        // and tools; toolPairs builds fresh arrays. Their remaining fields are
        // scalars. These are already detached, without cloning the whole graph.
        // Never store the inspection closure, lease, events or projection function.
        for (const d of all) {
          Object.freeze(d.origin.sourceEventSeqs); Object.freeze(d.origin); Object.freeze(d.blocks);
          if (d.tool) Object.freeze(d.tool); Object.freeze(d);
        }
        Object.freeze(all); Object.freeze(originals);
        this.remember({ proof, cursor, historyId, range: inspection.range, originals, all, byId, layouts, pairs });
        } else this.remember(undefined);
      }
      phase = performanceDiagnostics()?.begin('records.select', { sessionId: header.id, cursor });
      this.binding = { sessionId: header.id, historyId };
      const selection = options.selection ?? { kind: 'recall' };
      if (selection.kind !== 'recall' && selection.kind !== 'events' && selection.kind !== 'records') throw new RecallRecordsError('recall/records-invalid', 'Unknown record selection');
      if (selection.kind === 'events' && (!Array.isArray(selection.eventSeqs) || selection.eventSeqs.some(seq => !Number.isSafeInteger(seq) || seq < 0 || seq > cursor))) {
        throw new RecallRecordsError('recall/records-invalid', 'Context positions must exist in the supplied snapshot');
      }
      if (selection.kind === 'records' && (!Array.isArray(selection.recordIds) || selection.recordIds.some(id => !byId.has(id)))) throw new RecallRecordsError('recall/records-invalid', 'Explicit canonical records must exist in the fixed snapshot');
      const seqs = new Set(selection.kind === 'recall' ? inspection.range.sources.map(source => source.seq) : selection.kind === 'events' ? selection.eventSeqs : []);
      const wanted = new Set(selection.kind === 'records' ? selection.recordIds : all.filter(d => seqs.has(d.origin.seq)).map(d => d.id));
      if (selection.kind !== 'recall' && selection.includeToolPairs) {
        for (const d of all) if (wanted.has(d.id) && d.tool) {
          const pair = pairs.get(d.tool.pairId)!;
          if (pair.status === 'paired') for (const id of [...pair.callRecordIds, ...pair.resultRecordIds]) wanted.add(id);
        }
      }
      const selected = all.filter(d => wanted.has(d.id));
      const reusedRecords = selected.filter(d => this.entries.has(d.id)).length;
      phase?.count('selectedRecords', selected.length); phase?.count('toolPairs', pairs.size); phase?.end();
      const work = new WorkSlice(settings.chunkChars, settings.yieldMs, signal);
      const extractionStart = performance.now();
      phase = performanceDiagnostics()?.begin('records.extract', { sessionId: header.id, cursor });
      let preparedInBatch = 0, chars = 0;
      for (const d of selected) {
        if (this.entries.has(d.id)) continue;
        const content = nativeContent(events[d.origin.seq]!);
        const size = textSize(content, d.blocks);
        if (preparedInBatch >= settings.maxRecords || (preparedInBatch > 0
          && (chars + size > settings.maxTextChars || performance.now() - extractionStart >= settings.maxBatchMs))) break;
        assertLive();
        const blocks: CanonicalBlock[] = [];
        for (const block of d.blocks) {
          const value = copyContent(content[block.index] as RecallContent);
          const path = d.origin.contentPath === commandInputPath ? commandInputPath : `${d.origin.contentPath}[${block.index}]`;
          const fingerprint = await work.fingerprint({ path, content: value }, phase);
          assertLive();
          blocks.push({ index: block.index, path, fingerprint, content: value, attachmentBytes: value.type === 'image' || value.type === 'file' ? 'not_loaded' : 'not_applicable' });
        }
        const metadata = descriptorMetadata(d);
        const fingerprint = identity({ ...metadata, blocks: blocks.map(block => block.fingerprint) });
        assertLive();
        // Atomic publication of the whole record and all its block coverage.
        const record = freeze({ ...metadata, blocks, fingerprint, bodyComplete: true as const });
        const bytes = this.memory ? 48 + retainedBytes(d.id) + (this.layouts.has(d.origin.seq) ? 0 : 56 + retainedBytes(layouts.get(d.origin.seq))) : 0;
        this.memory?.add(bytes, [record]); this.storedBytes += bytes;
        this.entries.set(d.id, record);
        this.layouts.set(d.origin.seq, layouts.get(d.origin.seq)!);
        preparedInBatch++; chars += size;
        phase?.count('preparedRecords', 1); phase?.count('copiedTextCodeUnits', size);
        const pause = work.checkpoint(0); if (pause) await pause;
      }
      // A real event-loop yield even when this batch contains only small records.
      await work.pause(); assertLive();
      const recordIds = selected.map(d => d.id);
      const pendingRecordIds = recordIds.filter(id => !this.entries.has(id));
      const selectedPairs = new Set(selected.flatMap(d => d.tool ? [d.tool.pairId] : []));
      const batch: PreparedRecordBatch = freeze({
        status: pendingRecordIds.length ? 'incomplete' : 'complete', historyId, cursor, range: inspection.range,
        recordIds, pendingRecordIds, preparedInBatch, reusedRecords,
        sources: selected.map(d => ({ recordId: d.id, retention: d.source.retention, reasons: d.source.reasons })),
        pairs: [...selectedPairs].map(id => pairs.get(id)!),
      });
      this.batches.set(batch, generation);
      this.timing = Object.freeze({ classificationMs: metadataStart - classificationStart,
        metadataMs: extractionStart - metadataStart, extractionMs: performance.now() - extractionStart });
      phase?.end();
      return batch;
    } catch (error) { phase?.end('failed'); throw error; }
    finally { this.busy = false; }
  }
}
