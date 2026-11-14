import type { Context } from '@deepseek-ai/cordis';
import type { ToolExecution } from '@deepseek-ai/dsh-tools';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { RecallError, type SearchRequest, type SearchTerms, type RecallResult, type ResultItem } from '../protocol.js';
import { logicalQueryId, queryTermsId } from './references.js';
import { cursorPlaceholder } from '../state/cursors.js';
import { argumentsHash, currentInteraction, nativeCallDelivered } from '../runtime/identity.js';
import type { CanonicalRecord } from '../history/records.js';
import type { Reservation } from '../state/budget.js';
import type { RecallConfig } from '../runtime/config.js';
import { NativeMatcher, recordDocument, type RecordMatch } from './matcher.js';
import type { CallTimeline } from '../runtime/deadline.js';
import { effectiveSpill, pageBudget, renderedTokens, verifyOutput } from './output.js';
import { resultGuidance, type BusinessPage } from '../runtime/control.js';
import { previewWindow, PageReferences } from './items.js';
import { verifyHistoryCut } from '../history/sources.js';
import type {} from '../history/preparation.js';
import { retainedBytes, type MemoryHolder } from '../runtime/memory.js';

interface QueryState {
  id: string; sessionId: string; terms: SearchTerms; cursor: number; fingerprint: string;
  records: readonly CanonicalRecord[]; matches: RecordMatch[]; scanned: number; complete: boolean; busy: boolean; issued: Set<string>;
  memory?: MemoryHolder | undefined;
}
/** Per-query concurrency; oversized complete records remain alone. Not a model argument. */
export const SEARCH_MATCH_BATCH = Object.freeze({ maxRecords: 2, maxTextChars: 65_536 });
/** Only in-memory result positions. Persistent budget/grants have an independent lifetime. */
export class RecallSearchEngine {
  private readonly queries = new Map<string, QueryState>();
  private readonly incomplete = new Map<string, QueryState>();
  readonly matcher: NativeMatcher;
  constructor(private readonly ctx: Context, readonly config: RecallConfig, matcher?: NativeMatcher) {
    const agents = ctx.get('agents');
    this.matcher = matcher ?? new NativeMatcher(config.workerPath, undefined, operation => agents ? agents.withoutInitiator(operation) : operation());
  }
  private drop(query: QueryState) {
    this.queries.delete(query.id);
    for (const [key, value] of this.incomplete) if (value === query) this.incomplete.delete(key);
    query.records = []; query.matches.length = 0; query.issued.clear(); query.memory?.dispose();
  }
  clear() { for (const query of this.queries.values()) this.drop(query); this.incomplete.clear(); }
  async dispose() { this.clear(); await this.matcher.dispose(); }
  stats() { return [...this.queries.values()].map(q => ({ id: q.id, sessionId: q.sessionId, scanned: q.scanned, totalRecords: q.records.length, complete: q.complete, hits: q.matches.length })); }
  canContinue(agent: Agent, id: string, ignorePage?: string): boolean {
    if (this.ctx.get('recallMemory')?.budget.pendingReclaim(agent.id)) return false;
    const query = this.queries.get(id), identity = currentInteraction(agent.session);
    if (!query?.complete || query.sessionId !== agent.id || !identity) return false;
    const row = this.ctx.recallBudget.state(identity);
    return [...query.issued].some(page => page !== ignorePage && !row?.calls.some(c => c.page === page && c.state === 'completed' && nativeCallDelivered({ agent } as ToolExecution, c)));
  }
  inspectNext(request: Extract<SearchRequest, { action: 'next' }>, exec: ToolExecution): { query: string; page: string } {
    const { sessionId, pageId, locator: { queryId: id } } = this.ctx.recallCursors.resolve(request.cursor, exec.agent!.session.id, 'search');
    const query = this.queries.get(id);
    if (!query || query.sessionId !== sessionId || !query.complete || !query.issued.has(pageId)) throw new RecallError('stale_reference', 'Search cursor is no longer available or was not issued for this fixed result list.', true, 'Source refs are verified independently of the search cursor.', pageId);
    const identity = currentInteraction(exec.agent!.session);
    const row = identity && this.ctx.recallBudget.state(identity);
    if (row?.calls.some(c => c.page === pageId && c.state === 'completed' && nativeCallDelivered(exec, c))) throw new RecallError('duplicate_page', 'This fixed search page has already been returned successfully in this interaction.', true, 'The submitted cursor identifies the already delivered page.', pageId);
    return { query: id, page: pageId };
  }
  async run(request: SearchRequest, exec: ToolExecution, reservation: Reservation, timeline: CallTimeline): Promise<BusinessPage> {
    const sessionId = exec.agent!.session.id;
    let query: QueryState, start = 0, order: SearchTerms['order'];
    if (request.action === 'next') {
      const { pageId, locator: { queryId: id, order: direction, index } } = this.ctx.recallCursors.resolve(request.cursor, sessionId, 'search');
      query = this.queries.get(id)!; order = direction; start = index;
      if (!query || !query.complete || !query.issued.has(pageId)) throw new RecallError('stale_reference', 'The fixed search result is no longer available.', true);
      await verifyHistoryCut(this.ctx, sessionId, query.cursor, query.fingerprint, timeline);
    } else {
      // All patterns are validated even for an empty eligible history.
      await this.matcher.validate(request, timeline);
      order = request.order;
      const pendingKey = argumentsHash([sessionId, queryTermsId(request)]);
      const pending = this.incomplete.get(pendingKey);
      if (pending) query = pending;
      else {
        const prepared = await timeline.prepare(signal => this.ctx.recallPreparation.wait(sessionId, signal));
        const records = this.ctx.recallPreparation.records(prepared).filter(r => (!request.roles || request.roles.includes(r.role)) && (!request.kinds || request.kinds.includes(r.kind)));
        const id = logicalQueryId(request, [prepared.batch.historyId, records.map(r => [r.id, r.fingerprint])]);
        const existing = this.queries.get(id);
        const prior = this.ctx.recallBudget.state(reservation.interaction);
        if (existing?.complete && prior?.queries.some(q => q.id === id && q.complete)
          && prior.calls.some(c => c.query === id && c.state === 'completed' && nativeCallDelivered(exec, c))) throw new RecallError('duplicate_query', 'This search is already complete for the same conditions and effective history range.', true, 'Use its last nextCursor for remaining results, or change the search conditions.', id);
        query = existing ?? { id, sessionId, terms: request, cursor: prepared.cursor, fingerprint: prepared.fingerprint, records, matches: [], scanned: 0, complete: false, busy: false, issued: new Set() };
        if (!existing) {
          const owned = query;
          const memory = this.ctx.get('recallMemory')?.budget.hold(sessionId, 'search-result', () => this.drop(owned));
          try { memory?.add(retainedBytes({ ...query, records: undefined }) + 24 + records.length * 8, records); query.memory = memory; }
          catch (error) { memory?.dispose(); throw error; }
        }
        this.queries.set(id, query); this.incomplete.set(pendingKey, query);
      }
      await this.ctx.recallBudget.associate(reservation, query.id);
      if (query.busy) throw new RecallError('query_in_flight', 'The same fixed query is already scanning.');
      query.busy = true;
      try {
        await verifyHistoryCut(this.ctx, sessionId, query.cursor, query.fingerprint, timeline);
        while (query.scanned < query.records.length) {
          timeline.check();
          const batch: CanonicalRecord[] = []; let chars = 0;
          for (let at = query.scanned; at < query.records.length && batch.length < SEARCH_MATCH_BATCH.maxRecords; at++) {
            const record = query.records[at]!, document = recordDocument(record);
            const size = document.body.length + document.metadata.reduce((n, field) => n + field.text.length, 0);
            if (batch.length && chars + size > SEARCH_MATCH_BATCH.maxTextChars) break;
            batch.push(record); chars += size;
            if (chars >= SEARCH_MATCH_BATCH.maxTextChars) break;
          }
          // Each process still receives one whole record/metadata field. Drain
          // every started member even on failure; only a complete ordered batch
          // publishes progress. Retrying an uncertain batch may redo its members.
          const settled = await Promise.allSettled(batch.map(async record => this.matcher.match(record, query.terms, timeline)));
          timeline.check();
          const failure = settled.find(result => result.status === 'rejected');
          if (failure?.status === 'rejected') throw failure.reason;
          const matches = settled.flatMap(result => result.status === 'fulfilled' && result.value.spans.length ? [result.value] : []);
          // Admission is all-or-none for the whole confirmed matching batch.
          if (matches.length) query.memory?.add(retainedBytes(matches));
          query.matches.push(...matches);
          query.scanned += batch.length;
          await new Promise<void>(resolve => setImmediate(resolve));
        }
        await verifyHistoryCut(this.ctx, sessionId, query.cursor, query.fingerprint, timeline);
        query.complete = true; this.incomplete.delete(pendingKey);
      } catch (error) {
        if (error instanceof RecallError && error.code === 'stale_reference') this.drop(query);
        throw error;
      } finally { query.busy = false; }
    }
    const result = await this.page(query, order, start, exec, reservation, timeline);
    return { result, query: query.id, hasMore: result.nextCursor !== undefined };
  }
  private async page(query: QueryState, order: SearchTerms['order'], start: number, exec: ToolExecution, reservation: Reservation, timeline: CallTimeline): Promise<RecallResult> {
    const references = new PageReferences(this.ctx.recallReferences);
    const byId = new Map(query.records.map(r => [r.id, r]));
    const hits = order === 'newest' ? [...query.matches].reverse() : query.matches;
    if (!Number.isSafeInteger(start) || start < 0 || (start >= hits.length && start !== 0)) throw new RecallError('stale_reference', 'Search cursor is outside this fixed list.', true);
    const limit = pageBudget(this.config, 'search', effectiveSpill(this.ctx, exec));
    const build = (items: ResultItem[], end: number): RecallResult => resultGuidance({
      status: 'ok', scanComplete: true, sourceComplete: true, scannedRecords: query.records.length,
      totalHits: hits.length, start, end, remaining: hits.length - end, items,
      range: 'fixed eligible original records; later additions/compactions are excluded',
      ...(end < hits.length ? { nextCursor: cursorPlaceholder('search') } : {}),
      ...this.ctx.recallBudget.previewCompletion(reservation, query.id, end < hits.length),
    });
    const items: ResultItem[] = [];
    let end = start;
    while (end < hits.length) {
      timeline.check();
      const hit = hits[end]!, record = byId.get(hit.recordId)!, text = recordDocument(record).body;
      const item = (cap: number) => {
        const range = previewWindow(text, hit.spans, cap), value = references.item(record, text.slice(range.start, range.end), range.start, range.end, text.length);
        value.undisplayedMatches = hit.spans.filter(s => s.field === 'body' && (s.start < range.start || s.end > range.end)).length;
        value.matchedIn = [...new Set(hit.spans.map(s => s.field))];
        return value;
      };
      let candidate = item(this.config.previewTokens);
      if (renderedTokens(build([...items, candidate], end + 1)) > limit) {
        if (items.length) break;
        let low = 0, high = this.config.previewTokens;
        while (low < high) { const middle = Math.ceil((low + high) / 2); if (renderedTokens(build([item(middle)], end + 1)) <= limit) low = middle; else high = middle - 1; }
        candidate = item(low);
        verifyOutput(build([candidate], end + 1), limit);
      }
      items.push(candidate); end++;
    }
    const result = verifyOutput(build(items, end), limit);
    await references.publish(result, query.sessionId, timeline.signal);
    if (result.nextCursor) {
      const cursor = await this.ctx.recallCursors.issue({ sessionId: query.sessionId, kind: 'search', locator: { queryId: query.id, order, index: end } }, timeline.signal);
      timeline.check(); result.nextCursor = cursor.handle;
      verifyOutput(result, limit);
      if (!query.issued.has(cursor.pageId)) { query.memory?.add(32 + retainedBytes(cursor.pageId)); query.issued.add(cursor.pageId); }
    }
    await verifyHistoryCut(this.ctx, query.sessionId, query.cursor, query.fingerprint, timeline);
    return verifyOutput(result, limit);
  }
}
