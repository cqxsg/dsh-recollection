import { spawn } from 'node:child_process';
import type { CanonicalRecord } from '../history/records.js';
import { RecallError, type SearchTerms } from '../protocol.js';
import type { CallTimeline } from '../runtime/deadline.js';
import { argumentsHash } from '../runtime/identity.js';
import { MatchingPool, verifiedWorker, scalarSafe, type MatchUnit, type WorkerManifest } from './worker.js';
export const RG_VERSION = '15.2.0';
export interface TextSegment { path: string; start: number; end: number; }
export interface RecordDocument { body: string; segments: TextSegment[]; metadata: { path: string; text: string }[]; }
export interface MatchSpan { field: 'body' | 'metadata'; start: number; end: number; byteStart: number; byteEnd: number; locations: { path: string; start: number; end: number }[]; }
export interface RecordMatch { recordId: string; spans: MatchSpan[]; }

/** Concatenate real text blocks without inserted headers; metadata is searched separately. */
export function recordDocument(record: CanonicalRecord): RecordDocument {
  let body = '';
  const segments: TextSegment[] = [], metadata: RecordDocument['metadata'] = [];
  const add = (path: string, text: string) => { const start = body.length; body += text; segments.push({ path, start, end: body.length }); };
  const strings = (value: unknown, path: string) => {
    if (typeof value === 'string') metadata.push({ path, text: value });
    else if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) strings(child, `${path}.${key}`);
  };
  for (const block of record.blocks) {
    if (block.content.type === 'text') add(`${block.path}.text`, block.content.text);
    else if (block.content.type === 'tool-call') { add(`${block.path}.name`, block.content.name); add(`${block.path}.arguments`, block.content.arguments); }
    else strings(block.content.attachment, `${block.path}.attachment`);
  }
  return { body, segments, metadata };
}


/** The sole production matcher. Each record/body and metadata field stays independent. */
export class NativeMatcher {
  readonly children = new Set<number>();
  info: { version: string; executable: string; sha256: string; build: string } | undefined;
  private pool: MatchingPool | undefined;
  private initializing: Promise<WorkerManifest> | undefined;
  private disposed = false;
  constructor(private readonly requested?: string, private readonly launch: typeof spawn = spawn,
    private readonly background: <T>(operation: () => T) => T = operation => operation()) {}
  private async initialize(timeline: CallTimeline) {
    timeline.check();
    if (this.disposed) throw new RecallError('worker_failed', 'Matcher disposed.');
    if (this.pool) return;
    const attempt = this.initializing ??= verifiedWorker(this.requested);
    try {
      const manifest = await attempt;
      timeline.check();
      if (this.disposed) throw new RecallError('worker_failed', 'Matcher disposed.');
      if (!this.pool) {
        this.info = { version: RG_VERSION, executable: manifest.executable, sha256: manifest.sha256, build: manifest.build };
        this.pool = new MatchingPool(manifest, ((...args: Parameters<typeof spawn>) => this.launch(...args)) as typeof spawn, this.children, this.background);
      }
    } finally {
      // Share only the current verification round; rejection must not poison
      // the instance. A cancelled waiter cannot clear a newer round.
      if (this.initializing === attempt) this.initializing = undefined;
    }
  }
  stats() { return this.pool?.stats() ?? { live: 0, active: 0, queued: 0, queuedBytes: 0, launches: 0 }; }
  wake() { this.pool?.wake(); }
  async dispose() { this.disposed = true; await this.initializing?.catch(() => {}); await this.pool?.dispose(); }
  async validate(terms: SearchTerms, timeline: CallTimeline): Promise<void> {
    await this.initialize(timeline);
    await this.scanText('', terms, timeline, { purpose: 'validation' });
  }
  async match(record: CanonicalRecord, terms: SearchTerms, timeline: CallTimeline): Promise<RecordMatch> {
    await this.initialize(timeline);
    const document = recordDocument(record), spans: MatchSpan[] = [];
    for (const part of [...(document.segments.length ? [{ path: '', text: document.body }] : []), ...document.metadata]) {
      timeline.check();
      if (!scalarSafe(part.text)) throw new RecallError('source_encoding_invalid', 'Native text contains an unpaired UTF-16 surrogate; matching would change its content.');
      const byteLength = Buffer.byteLength(part.text);
      const ranges = await timeline.retry(() => this.scanText(part.text, terms, timeline, { purpose: 'match', recordId: record.id, field: part.path || 'body' }));
      const endpoints = [...new Set(ranges.flatMap(r => [r.start, r.end]))].sort((a, b) => a - b);
      const offsets = new Map<number, number>();
      let i = 0, byte = 0, at = 0, checkpoint = 0;
      while (at < endpoints.length) {
        if (byte === endpoints[at]) { offsets.set(byte, i); at++; continue; }
        if (i >= part.text.length || byte > endpoints[at]!) throw new RecallError('rg_output_invalid', 'rg reported a non-Unicode boundary.');
        const code = part.text.codePointAt(i)!; byte += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4; i += code > 0xffff ? 2 : 1;
        if (i - checkpoint >= 16384) { checkpoint = i; await new Promise<void>(resolve => setImmediate(resolve)); timeline.check(); }
      }
      for (const range of ranges) {
        const start = offsets.get(range.start)!, end = offsets.get(range.end)!;
        const locations = part.path ? [{ path: part.path, start, end }] : document.segments.filter(s => s.end > start && s.start < end || start === end && s.start <= start && s.end >= end).map(s => ({ path: s.path, start: Math.max(start - s.start, 0), end: Math.min(end, s.end) - s.start }));
        if (range.end > byteLength) throw new RecallError('rg_output_invalid', 'rg match extends past its complete input.');
        spans.push({ field: part.path ? 'metadata' : 'body', start, end, byteStart: range.start, byteEnd: range.end, locations });
      }
    }
    return { recordId: record.id, spans };
  }
  private async scanText(text: string, terms: SearchTerms, timeline: CallTimeline, unit: MatchUnit): Promise<{ start: number; end: number }[]> {
    try { return await this.scanUnchecked(text, terms, timeline, unit); }
    catch (error) {
      if (!(error instanceof RecallError) || error.code !== 'invalid_pattern') throw error;
      const patterns = [...new Set(terms.patterns)].sort();
      // Diagnose only failed compilations. Isolating the offending condition
      // keeps OR ordering and unrelated valid patterns out of its identity.
      if (patterns.length > 1) for (const pattern of patterns) {
        try { await this.scanUnchecked('', { ...terms, patterns: [pattern] }, timeline, { ...unit, purpose: 'invalid-diagnosis' }); }
        catch (isolated) {
          if (!(isolated instanceof RecallError) || isolated.code !== 'invalid_pattern') throw isolated;
          throw this.patternFailure(isolated, terms.mode, [pattern]);
        }
      }
      // An error arising only from the combined expression belongs to that set.
      throw this.patternFailure(error, terms.mode, patterns);
    }
  }
  private patternFailure(error: RecallError, mode: SearchTerms['mode'], patterns: string[]): RecallError {
    const reason = error.message.split(/\r?\n/).filter(line => line.startsWith('error:')).at(-1)?.trim() ?? error.message;
    return new RecallError('invalid_pattern', error.message, true,
      'Reordering conditions or adding unrelated valid conditions does not change the invalid pattern.',
      argumentsHash({ mode, patterns, reason }));
  }

  private scanUnchecked(text: string, terms: SearchTerms, timeline: CallTimeline, unit: MatchUnit) {
    return this.pool!.run(text, terms, timeline, unit);
  }
}
