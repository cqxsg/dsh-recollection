import type { Context } from '@deepseek-ai/cordis';
import type { ToolExecution } from '@deepseek-ai/dsh-tools';
import type { SessionHeader } from '@deepseek-ai/dsh-session';
import { RecallError, type ReadRequest, type RecallResult, type ResultItem, type AttachmentResult } from '../protocol.js';
import { recordLocator, recordKey, referencePlaceholder } from '../state/reference-store.js';
import { cursorPlaceholder, type CursorTarget } from '../state/cursors.js';
import { argumentsHash, nativeCallDelivered } from '../runtime/identity.js';
import { fingerprintHistory, indexHistoryRecords, HistoryRecordCache, type CanonicalRecord } from '../history/records.js';
import type { RecallConfig } from '../runtime/config.js';
import type { Reservation } from '../state/budget.js';
import type { CallTimeline } from '../runtime/deadline.js';
import { recordDocument } from './matcher.js';
import { PageReferences } from './items.js';
import { historyPrefix, verifyHistoryCut, sourceFailure } from '../history/sources.js';
import { effectiveSpill, pageBudget, renderedTokens, unicodeBoundary, verifyOutput } from './output.js';
import { resultGuidance, type BusinessPage } from '../runtime/control.js';
import { recordAttachments, type AttachmentSource } from '../attachments/attachments.js';
import { readAttachment } from '../attachments/attachment-read.js';
import { retainedBytes, type MemoryHolder } from '../runtime/memory.js';

interface ReadState {
  sessionId: string; anchor: string; cursor: number; fingerprint: string; scope: 'record' | 'context' | 'turn';
  before: number; after: number; ids: string[]; units: { start: number; end: number }[]; gaps: string[]; boundaries: string[];
  header: SessionHeader; target?: 'attachments' | 'both'; files?: { record: CanonicalRecord; source: AttachmentSource }[];
  fileGaps: Map<number, string>;
  memory?: MemoryHolder | undefined;
}
/** Persisted cursor locations survive reload; continuation still requires the issued fixed range. */
export class RecallReadEngine {
  private readonly states = new Map<string, ReadState>();
  private readonly issued = new Map<string, string>();
  private readonly cursorMemory = new Map<string, MemoryHolder>();
  private readonly caches = new Map<string, HistoryRecordCache>();
  private readonly queues = new Map<string, Promise<unknown>>();
  constructor(private readonly ctx: Context, readonly config: RecallConfig) {}
  private drop(sessionId: string) {
    for (const [key, state] of this.states) if (state.sessionId === sessionId) {
      this.states.delete(key); delete state.files; state.ids.length = 0; state.units.length = 0; state.fileGaps.clear(); state.memory?.dispose();
    }
    for (const [cursor, id] of this.issued) if (id === sessionId) this.issued.delete(cursor);
    this.cursorMemory.get(sessionId)?.dispose(); this.cursorMemory.delete(sessionId);
    this.caches.get(sessionId)?.dispose(); this.caches.delete(sessionId);
  }
  clear() {
    for (const id of new Set([...this.caches.keys(), ...this.cursorMemory.keys(), ...[...this.states.values()].map(s => s.sessionId)])) this.drop(id);
  }
  run(request: ReadRequest, exec: ToolExecution, reservation: Reservation, timeline: CallTimeline): Promise<BusinessPage> {
    const sessionId = exec.agent!.session.id;
    const task = (this.queues.get(sessionId) ?? Promise.resolve()).then(async () => {
      try { return await this.read(request, exec, reservation, timeline); }
      finally { this.caches.get(sessionId)?.releaseMetadata(); }
    }).catch(error => { timeline.check(); throw sourceFailure(error, request.action === 'read' ? request.ref : request.cursor); });
    const tail = task.then(() => undefined, () => undefined); this.queues.set(sessionId, tail);
    void tail.then(() => { if (this.queues.get(sessionId) === tail) this.queues.delete(sessionId); });
    return task;
  }
  private cache(id: string): HistoryRecordCache {
    let cache = this.caches.get(id);
    if (!cache) { cache = new HistoryRecordCache(this.ctx.get('recallMemory')?.budget.hold(id, 'read-records', () => this.drop(id))); this.caches.set(id, cache); }
    return cache;
  }
  private stateBytes(state: ReadState): number {
    const excluded = new Set<object>(state.files?.map(file => file.record) ?? []);
    if (state.memory) excluded.add(state.memory);
    return retainedBytes(state, excluded);
  }
  private key(state: Pick<ReadState, 'sessionId' | 'anchor' | 'cursor' | 'fingerprint' | 'scope' | 'before' | 'after'> & Partial<Pick<ReadState, 'target' | 'files'>>) {
    const base = [state.sessionId, state.anchor, state.cursor, state.fingerprint, state.scope, state.before, state.after];
    return argumentsHash(state.target ? [...base, state.target, state.files!.map(f => [recordKey(recordLocator(f.record)), f.source.selector])] : base);
  }
  private async read(request: ReadRequest, exec: ToolExecution, reservation: Reservation, timeline: CallTimeline): Promise<BusinessPage> {
    timeline.check();
    const sessionId = exec.agent!.session.id;
    let state: ReadState, index = 0, offset = 0, fileIndex = 0;
    if (request.action === 'next') {
      const cursor = this.ctx.recallCursors.resolve(request.cursor, sessionId, 'read');
      const anchor = cursor.locator.anchorRef, known = this.states.get(cursor.locator.readStateId);
      index = cursor.locator.index; offset = cursor.locator.charOffset; fileIndex = cursor.kind === 'files' ? cursor.locator.fileIndex : 0;
      if (!known || known.sessionId !== sessionId || known.anchor !== anchor || !!known.target !== (cursor.kind === 'files') || !this.issued.has(cursor.pageId)) {
        // A saved locator recovers its verified anchor, never an assumed fixed range.
        await this.reference(anchor, exec, timeline);
        throw new RecallError('stale_reference', 'The cursor mapping is available, but its fixed read range is no longer available.', true, `The original source remains verified: ref=${anchor}.`, cursor.pageId);
      }
      state = known;
      if (this.ctx.recallBudget.state(reservation.interaction)?.calls.some(c => c.page === cursor.pageId && c.state === 'completed' && nativeCallDelivered(exec, c))) throw new RecallError('duplicate_page', 'This fixed read page was already returned successfully.', true, 'The submitted cursor identifies the already delivered page.', cursor.pageId);
    } else {
      const info = await this.reference(request.ref, exec, timeline);
      const scope = request.target === 'attachments' ? 'record' : request.scope;
      const position = info.index.records.findIndex(r => r.id === info.record.id);
      const first = scope === 'context' ? Math.max(0, position - this.config.contextBefore) : position;
      const last = scope === 'context' ? Math.min(info.index.records.length, position + this.config.contextAfter + 1) : position + 1;
      const selected = scope === 'turn' && info.record.origin.turn !== null
        ? info.index.records.filter(r => r.origin.turn === info.record.origin.turn) : info.index.records.slice(first, last);
      const ids = new Set(selected.map(r => r.id)), gaps: string[] = [];
      if (scope === 'turn' && info.record.origin.turn === null) gaps.push('turn_identity_unavailable');
      for (const record of selected) if (record.tool && request.target !== 'attachments') {
        const pair = info.index.pairs.find(p => p.id === record.tool!.pairId);
        if (!pair || pair.status !== 'paired') gaps.push(`${record.tool.pairId}:${pair?.status ?? 'pair_unavailable'}`);
        if (pair) for (const id of [...pair.callRecordIds, ...pair.resultRecordIds]) ids.add(id);
      }
      const ordered = info.index.records.filter(r => ids.has(r.id));
      // Merge overlapping event/pair intervals rather than moving nonadjacent partners together.
      const groups = new Map<string, number[]>();
      for (const [at, record] of ordered.entries()) for (const group of [`event:${record.origin.seq}`, ...(record.tool ? [`pair:${record.tool.pairId}`] : [])]) {
        const positions = groups.get(group) ?? []; positions.push(at); groups.set(group, positions);
      }
      const intervals = [...groups.values()].map(positions => ({ start: positions[0]!, end: positions.at(-1)! + 1 })).sort((a, b) => a.start - b.start || a.end - b.end);
      const units: ReadState['units'] = [];
      for (const interval of intervals) { const previous = units.at(-1); if (previous && interval.start < previous.end) previous.end = Math.max(previous.end, interval.end); else units.push(interval); }
      state = { sessionId, anchor: request.ref, cursor: info.cursor, fingerprint: info.fingerprint, scope,
        header: info.header, fileGaps: new Map(), before: this.config.contextBefore, after: this.config.contextAfter,
        ids: request.target === 'attachments' ? [] : ordered.map(r => r.id), units, gaps: [...new Set(gaps)],
        boundaries: scope === 'context' ? [...(first === 0 ? ['history_start'] : []), ...(last === info.index.records.length ? ['fixed_snapshot_end'] : [])] : [] };
      if (request.target !== 'text') {
        const records = await this.load(ordered.map(r => r.id), state, exec, timeline);
        const available = new Map(records.flatMap(record => recordAttachments(record).map(source => [JSON.stringify([recordKey(recordLocator(record)), source.selector]), { record, source }] as const)));
        const invalid: string[] = [], files: NonNullable<ReadState['files']> = [];
        for (const ref of new Set(request.attachments)) {
          const separator = ref.indexOf(':');
          if (separator < 0) { invalid.push(ref); continue; }
          try {
            const parent = this.ctx.recallReferences.resolve(ref.slice(0, separator), sessionId);
            const file = available.get(JSON.stringify([parent.recordKey, ref.slice(separator + 1)]));
            if (file) files.push(file); else invalid.push(ref);
          } catch (error) {
            if (error instanceof RecallError && error.code === 'stale_reference') invalid.push(ref); else throw error;
          }
        }
        if (invalid.length) throw new RecallError('invalid_attachment', 'Selected attachment does not belong to the verified original read range.', true,
          'attachments selects refs from the target record; both selects refs within the chosen text range.', argumentsHash([...new Set(invalid)].sort()));
        state.target = request.target; state.files = files;
      }
      const key = this.key(state), memory = this.ctx.get('recallMemory')?.budget.hold(sessionId, 'read-range', () => this.drop(sessionId));
      try { memory?.add(this.stateBytes(state), state.files?.map(file => file.record) ?? []); }
      catch (error) { memory?.dispose(); throw error; }
      state.memory = memory; this.states.get(key)?.memory?.dispose(); this.states.set(key, state);
    }
    await verifyHistoryCut(this.ctx, sessionId, state.cursor, state.fingerprint, timeline);
    return { result: await this.page(state, index, offset, exec, reservation, timeline, fileIndex) };
  }
  private async reference(ref: string, exec: ToolExecution, timeline: CallTimeline) {
    const locator = this.ctx.recallReferences.resolve(ref, exec.agent!.session.id);
    const { sessionId, formatVersion: format, historyId, seq, recordId: id, fingerprint } = locator;
    timeline.check();
    const info = await timeline.retry(() => this.ctx.recallHistory.withSnapshot(exec.agent!.session.id, async (snapshot, signal) => {
      if (snapshot.header.version !== format) throw new RecallError('stale_reference', 'Native format differs from the source ref.', true);
      const index = indexHistoryRecords(snapshot, this.ctx.sessions.messageProjections, signal);
      if (index.historyId !== historyId || !index.records.some(r => r.id === id && r.origin.seq === seq)) throw new RecallError('stale_reference', 'Ref does not identify an eligible original native record.', true);
      return { index, header: structuredClone(snapshot.header), cursor: snapshot.cursor, fingerprint: await fingerprintHistory(snapshot, signal) };
    }, timeline.signal, { waitForQuiescence: true }));
    const fixed = { sessionId, cursor: info.cursor, fingerprint: info.fingerprint };
    const [record] = await this.load([id], fixed, exec, timeline);
    if (!record || record.fingerprint !== fingerprint || recordKey(recordLocator(record)) !== locator.recordKey) throw new RecallError('stale_reference', 'Original record content/provenance no longer matches the source ref.', true, 'The reference is bound to the original record content and provenance.', ref);
    return { ...info, record };
  }
  private async load(ids: string[], state: Pick<ReadState, 'sessionId' | 'cursor' | 'fingerprint'>, exec: ToolExecution, timeline: CallTimeline): Promise<readonly CanonicalRecord[]> {
    while (true) {
      timeline.check();
      const result = await timeline.retry(() => this.ctx.recallHistory.withSnapshot(exec.agent!.session.id, async (snapshot, signal) => {
        const cut = historyPrefix(snapshot, state.cursor);
        if (await fingerprintHistory(cut, signal) !== state.fingerprint) throw new RecallError('stale_reference', 'Fixed read source changed; no cursor was advanced.', true);
        const cache = this.cache(state.sessionId);
        const batch = await cache.prepareBatch(cut, this.ctx.sessions.messageProjections, { selection: { kind: 'records', recordIds: ids } }, signal);
        return batch.status === 'complete' ? cache.records(batch) : undefined;
      }, timeline.signal, { waitForQuiescence: true }));
      if (result) return result;
      await new Promise<void>(resolve => setImmediate(resolve));
    }
  }
  private async page(state: ReadState, initialIndex: number, initialOffset: number, exec: ToolExecution, reservation: Reservation, timeline: CallTimeline, initialFile = 0): Promise<RecallResult> {
    const references = new PageReferences(this.ctx.recallReferences);
    const files = state.files ?? [];
    if (initialIndex < 0 || initialIndex > state.ids.length || initialOffset < 0 || initialFile > files.length || initialFile < 0
      || initialIndex === state.ids.length && (initialOffset !== 0 || initialFile === files.length)) throw new RecallError('stale_reference', 'Read cursor is outside the fixed range.', true);
    const limit = pageBudget(this.config, 'read', effectiveSpill(this.ctx, exec));
    const attachmentResults: AttachmentResult[] = []; let atFile = initialFile;
    const build = (items: ResultItem[], index: number, offset: number, results = attachmentResults, fileIndex = atFile): RecallResult => resultGuidance({
      status: 'ok', readComplete: index === state.ids.length, sourceComplete: !state.gaps.length && ![...state.fileGaps].some(([i]) => i < initialFile) && results.every(r => r.state === 'accessible'),
      range: `${state.scope}: ${state.ids.length} fixed canonical records in native order`,
      gaps: [...state.gaps, ...[...state.fileGaps].filter(([i]) => i < initialFile).map(([i, state]) => `attachment:${i}:${state}`), ...results.flatMap((r, i) => r.state === 'accessible' ? [] : [`attachment:${initialFile + i}:${r.state}`])], boundaries: state.boundaries,
      start: initialIndex, end: index, remaining: state.ids.length - index, items,
      ...(state.target ? { textRequested: state.target === 'both', attachmentResults: results, attachmentsComplete: fileIndex === files.length,
        attachmentStart: initialFile, attachmentEnd: fileIndex, attachmentsRemaining: files.length - fileIndex } : {}),
      ...(index < state.ids.length || fileIndex < files.length ? { nextCursor: cursorPlaceholder(state.target ? 'files' : 'read') } : {}),
      ...this.ctx.recallBudget.previewCompletion(reservation),
    });
    for (; atFile < files.length; atFile++) {
      timeline.check(); const file = files[atFile]!;
      const result = references.attachment(file.record, await readAttachment(this.ctx, exec.agent!.ctx, state.header, file.record, file.source, this.config, timeline.signal, referencePlaceholder));
      timeline.check();
      const candidate = build([], initialIndex, initialOffset, [...attachmentResults, result], atFile + 1);
      if (renderedTokens(candidate) > limit) {
        if (!attachmentResults.length) throw new RecallError('output_budget_too_small', 'One complete attachment status and its source/cursor exceed the output budget.');
        break;
      }
      attachmentResults.push(result);
    }
    let index = initialIndex, offset = initialOffset;
    const items: ResultItem[] = [];
    while (atFile === files.length && index < state.ids.length) {
      timeline.check();
      const unit = state.units.find(u => u.start <= index && index < u.end)!;
      const pending: ResultItem[] = [];
      let at = index, within = offset, overflow: { record: CanonicalRecord; text: string } | undefined;
      while (at < unit.end) {
        const [record] = await this.load([state.ids[at]!], state, exec, timeline), text = recordDocument(record!).body;
        if (within > text.length || unicodeBoundary(text, within) !== within) throw new RecallError('stale_reference', 'Read cursor is outside a Unicode-safe record position.', true);
        const item = references.item(record!, text.slice(within), within, text.length, text.length);
        if (renderedTokens(build([...items, ...pending, item], at + 1, 0)) > limit) { overflow = { record: record!, text }; break; }
        pending.push(item); at++; within = 0;
      }
      if (!overflow) { items.push(...pending); index = at; offset = 0; continue; }
      if (items.length || attachmentResults.length) break; // Keep the next whole event/interaction for a fresh page.
      if (pending.length) { items.push(...pending); index = at; offset = within; break; }
      const { record, text } = overflow;
      const candidate = (length: number) => {
        const end = unicodeBoundary(text, Math.min(text.length, within + length));
        return { end, item: references.item(record, text.slice(within, end), within, end, text.length) };
      };
      let low = 0, high = text.length - within;
      while (low < high) { const middle = Math.ceil((low + high) / 2), c = candidate(middle); const endIndex = c.end === text.length ? at + 1 : at; if (renderedTokens(build([c.item], endIndex, c.end === text.length ? 0 : c.end)) <= limit) low = middle; else high = middle - 1; }
      let c = candidate(low);
      if (c.end < text.length) {
        const tail = c.item.content; const boundary = Math.max(tail.lastIndexOf('\n'), tail.lastIndexOf('。'), tail.lastIndexOf('. '));
        if (boundary >= Math.floor(tail.length / 2)) c = candidate(boundary + 1);
      }
      if (c.end === within && within < text.length) throw new RecallError('output_budget_too_small', 'Required source and read cursor leave no room for even one Unicode scalar.');
      index = c.end === text.length ? at + 1 : at; offset = c.end === text.length ? 0 : c.end;
      verifyOutput(build([c.item], index, offset), limit); items.push(c.item); break;
    }
    const result = verifyOutput(build(items, index, offset), limit);
    await references.publish(result, state.sessionId, timeline.signal);
    const fileGaps = new Map(state.fileGaps);
    attachmentResults.forEach((file, i) => { if (file.state === 'accessible') fileGaps.delete(initialFile + i); else fileGaps.set(initialFile + i, file.state); });
    state.memory?.resize(this.stateBytes({ ...state, fileGaps })); state.fileGaps = fileGaps;
    if (result.nextCursor) {
      const locator = { anchorRef: state.anchor, readStateId: this.key(state), index, charOffset: offset };
      const target: CursorTarget = state.target ? { sessionId: state.sessionId, kind: 'files', locator: { ...locator, fileIndex: atFile } }
        : { sessionId: state.sessionId, kind: 'read', locator };
      const cursor = await this.ctx.recallCursors.issue(target, timeline.signal);
      timeline.check(); result.nextCursor = cursor.handle;
      verifyOutput(result, limit);
      if (!this.issued.has(cursor.pageId)) {
        let memory = this.cursorMemory.get(state.sessionId);
        if (!memory) {
          memory = this.ctx.get('recallMemory')?.budget.hold(state.sessionId, 'read-cursors', () => this.drop(state.sessionId));
          if (memory) this.cursorMemory.set(state.sessionId, memory);
        }
        memory?.add(48 + retainedBytes(cursor.pageId) + retainedBytes(state.sessionId)); this.issued.set(cursor.pageId, state.sessionId);
      }
    }
    await verifyHistoryCut(this.ctx, state.sessionId, state.cursor, state.fingerprint, timeline);
    return verifyOutput(result, limit);
  }
}
