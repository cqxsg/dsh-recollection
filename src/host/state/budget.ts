import { Service, type Context } from '@deepseek-ai/cordis';
import { defineDomain, domainTable, type KvTable } from '@deepseek-ai/dsh-storage-domain';
import type { ToolExecution } from '@deepseek-ai/dsh-tools';
import { z } from 'zod';
import { missingPriorBudget, resolveCallIdentity, nativeInvalidFeedback, type CallIdentity, type InteractionIdentity } from '../runtime/identity.js';
import { interactionKey } from './ledger.js';
import { RecallError, type BudgetSummary } from '../protocol.js';
import type { RecallConfig } from '../runtime/config.js';
import type { CallTimeline } from '../runtime/deadline.js';

const n = z.number().int().nonnegative();
const query = z.strictObject({ id: z.string(), free: n, granted: z.boolean(), complete: z.boolean() });
const call = z.strictObject({
  kind: z.enum(['direct', 'ptc']), eventSeq: n, turn: n, step: n, callId: z.string(), rootCallId: z.string(), name: z.string(), argsHash: z.string(),
  state: z.enum(['reserved', 'completed', 'failed', 'rejected']), authorized: z.boolean(), charge: z.enum(['search', 'shared', 'free', 'none']),
  query: z.string().optional(), page: z.string().optional(), code: z.string().optional(), invalidKey: z.string().min(1).optional(),
});
export const businessLedgerRecord = z.strictObject({
  version: z.literal(1), sessionId: z.string().min(1), interactionId: z.string().min(1), anchorSeq: n, revision: n,
  limits: z.strictObject({ searches: n, shared: n, freePages: n, paidPages: n }),
  searches: n, shared: n, paidPages: n, actualCalls: n, closed: z.boolean(),
  queries: z.array(query), calls: z.array(call), invalid: z.array(z.string()),
}).superRefine((r, ctx) => {
  const issue = (message: string) => ctx.addIssue({ code: 'custom', message });
  if (r.searches > r.limits.searches || r.shared > r.limits.shared || r.paidPages > r.limits.paidPages) issue('Balances exceed inherited limits');
  if (r.actualCalls !== r.calls.length || new Set(r.calls.map(c => c.eventSeq)).size !== r.calls.length) issue('Call count or identity mismatch');
  if (new Set(r.queries.map(q => q.id)).size !== r.queries.length || r.queries.length > r.limits.searches) issue('Query registration mismatch');
  if (r.queries.some(q => q.free > r.limits.freePages || (!q.granted && q.free > 0))) issue('Invalid F grant');
  if (r.limits.searches - r.searches !== r.calls.filter(c => c.charge === 'search').length
    || r.limits.shared - r.shared !== r.calls.filter(c => c.charge === 'search' || c.charge === 'shared').length) issue('Charges do not reconcile with S/R');
  if (r.paidPages !== r.calls.filter(c => c.charge === 'shared' && c.query && c.page).length) issue('Paid-page charges do not reconcile');
  for (const q of r.queries) if (q.free + r.calls.filter(c => c.query === q.id && c.charge === 'free').length !== (q.granted ? r.limits.freePages : 0)) issue('F charges do not reconcile');
  if (r.calls.some(c => c.invalidKey !== undefined && (!['failed', 'rejected'].includes(c.state) || !c.code || !r.invalid.includes(c.invalidKey)))) issue('Invalid feedback has no matching failed/rejected call');
});
export type BusinessLedgerRecord = z.infer<typeof businessLedgerRecord>;
export const businessLedgerSpec = defineDomain({ name: 'dsh_recall_business', version: 1, layout: 'single', tables: { interactions: domainTable<string, BusinessLedgerRecord>(businessLedgerRecord) } });
export interface Operation { kind: 'search' | 'next' | 'read'; query?: string; page?: string; valid?: boolean; }
interface InvalidFeedback { readonly keys: ReadonlySet<string>; readonly legacyCodes: ReadonlySet<string>; }
export interface Reservation { readonly key: string; readonly interaction: InteractionIdentity; readonly call: CallIdentity; readonly operation: Operation; readonly denied?: RecallError; readonly invalidFeedback: InvalidFeedback; }
export interface CompletionView { budget: BudgetSummary; allowed_actions: string[]; }
interface CompletionOutcome { code?: string; invalidKey?: string; query?: string; hasMore?: boolean; success: boolean; }
declare module '@deepseek-ai/cordis' { interface Context { recallBudget: RecallBudgetService; } }

/** Authoritative S/R/F and call state. Bodies/results never enter this domain. */
export class RecallBudgetService extends Service {
  static inject = ['storageDomain', 'sessions'];
  private table!: KvTable<string, BusinessLedgerRecord>;
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly pending = new Set<Promise<unknown>>();
  private readonly calls = new Set<Promise<void>>();
  private readonly lifetime = new AbortController();
  get signal() { return this.lifetime.signal; }
  private closing = false;
  constructor(ctx: Context, readonly config: RecallConfig) { super(ctx, 'recallBudget'); }
  async [Service.init]() {
    const domain = await this.ctx.storageDomain.open(businessLedgerSpec);
    this.table = domain.table('interactions');
    try { this.ctx.effect(() => async () => {
      this.closing = true;
      this.lifetime.abort(new RecallError('recall_unloaded', 'Recall budget unloaded; owned native bodies must settle.'));
      await Promise.allSettled(this.calls); await Promise.allSettled(this.pending); await domain.close();
    }); }
    catch (error) { await domain.close(); throw error; }
    for (const [key, value] of this.table.entries()) if (key !== interactionKey(value)) throw new RecallError('ledger_invalid', 'Business ledger key/identity mismatch');
  }
  records() { return structuredClone([...this.table.entries()].map(([, value]) => value)); }
  /** Keep the domain open for the WHOLE native call, not merely its current write. */
  track<T>(run: () => Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(new RecallError('recall_unloaded', 'Budget service is unloading.'));
    let resolve!: () => void;
    const done = new Promise<void>(finish => { resolve = finish; }); this.calls.add(done);
    const finish = () => { this.calls.delete(done); resolve(); };
    try { return run().finally(finish); } catch (error) { finish(); throw error; }
  }
  state(identity: InteractionIdentity) { const value = this.table.get(interactionKey(identity)); return value === undefined ? undefined : structuredClone(value); }
  summary(identity: InteractionIdentity, queryId?: string): BudgetSummary {
    const r = this.table.get(interactionKey(identity));
    if (!r) throw new RecallError('ledger_missing', 'No authoritative budget exists for this interaction.');
    return this.summaryRecord(r, queryId);
  }
  private summaryRecord(r: BusinessLedgerRecord, queryId?: string): BudgetSummary {
    return { revision: r.revision, search_remaining: r.searches, shared_remaining: r.shared, query_pages_remaining: r.queries.find(q => q.id === queryId)?.free ?? 0,
      paid_pages_remaining: r.limits.paidPages - r.paidPages, actual_calls: r.actualCalls, closed: r.closed };
  }
  allowed(identity: InteractionIdentity, queryId?: string, canContinue: (queryId: string) => boolean = () => true): string[] {
    const r = this.table.get(interactionKey(identity));
    return this.allowedRecord(r, queryId, canContinue);
  }
  private allowedRecord(r: BusinessLedgerRecord | undefined, queryId?: string, canContinue: (queryId: string) => boolean = () => true): string[] {
    if (!r || r.closed) return [];
    const actions: string[] = [];
    if (r.shared && r.searches) actions.push('search', 'attach_old_search');
    if (r.shared) actions.push('read', 'read_next');
    const next = (q: BusinessLedgerRecord['queries'][number]) =>
      (q.free > 0 || (r.shared > 0 && r.paidPages < r.limits.paidPages)) && canContinue(q.id);
    if (r.queries.some(q => q.id === queryId && next(q))) actions.push('search_next');
    if (r.queries.some(q => q.id !== queryId && next(q))) actions.push('other_query_next');
    return actions;
  }
  previewCompletion(reservation: Reservation, queryId?: string, hasMore = false) {
    const budget = this.summary(reservation.interaction, queryId);
    const r = this.table.get(reservation.key)!;
    const q = r.queries.find(q => q.id === queryId);
    budget.revision++;
    if (q && !q.granted && hasMore) budget.query_pages_remaining = r.limits.freePages;
    // Budget-only superset: page construction must reserve space for every
    // action the final cursor-aware response could retain.
    const allowed_actions = this.allowed(reservation.interaction, queryId);
    if (budget.query_pages_remaining && !allowed_actions.includes('search_next') && !budget.closed) allowed_actions.push('search_next');
    return { budget, allowed_actions };
  }
  async reserve(exec: ToolExecution, timeline: CallTimeline, operation: Operation): Promise<Reservation> {
    timeline.check();
    const { interaction, call, hasSettledCalls, settled } = resolveCallIdentity(exec, new Set(['recall_search', 'recall_read', exec.name]));
    try { if (!await this.ctx.sessions.flush(exec.agent!.session)) throw new Error('Persistence unavailable'); }
    catch { throw new RecallError('provenance_write_failed', 'Native input/call provenance could not be saved; no business action ran.'); }
    const key = interactionKey(interaction);
    let denied: RecallError | undefined;
    const feedback = { keys: new Set<string>(), legacyCodes: new Set<string>() };
    await this.serial(key, async () => {
      timeline.check();
      const prior = this.table.get(key);
      if (!prior && hasSettledCalls) throw new RecallError('ledger_missing', missingPriorBudget);
      const r: BusinessLedgerRecord = prior ? structuredClone(prior) : {
        ...interaction, version: 1, revision: 0, limits: { searches: this.config.searches, shared: this.config.shared, freePages: this.config.freePages, paidPages: this.config.paidPages },
        searches: this.config.searches, shared: this.config.shared, paidPages: 0, actualCalls: 0, closed: false, queries: [], calls: [], invalid: [],
      };
      if (r.anchorSeq !== interaction.anchorSeq) throw new RecallError('ledger_invalid', 'Interaction anchor differs from its budget record.');
      const previous = r.calls.find(c => c.eventSeq === call.eventSeq);
      if (previous) {
        if (Object.entries(call).some(([k, v]) => previous[k as keyof CallIdentity] !== v)) throw new RecallError('ledger_invalid', 'Stored native call identity changed.');
        throw new RecallError('call_replay', `Call is already ${previous.state}; original charge retained.`, false, 'A recorded native call identity cannot be executed again.');
      }
      if (settled) throw new RecallError('ledger_missing', 'Settled call has no matching reservation.');
      for (const previous of r.calls) {
        if (!['failed', 'rejected'].includes(previous.state) || !nativeInvalidFeedback(exec.agent!.session, previous, call)) continue;
        if (previous.invalidKey) feedback.keys.add(previous.invalidKey);
        // Older v1 rows lack call-bound keys; older reference errors also put
        // recovery prose in the key. Preserve delivered feedback only when the
        // native tool and arguments match exactly, never from prose alone.
        const legacyReference = previous.invalidKey?.includes(':stale_reference:Use an unchanged reference from this executing session; search again if unavailable.:');
        if ((!previous.invalidKey || legacyReference) && previous.name === call.name && previous.argsHash === call.argsHash && r.invalid.some(key => {
          const kind = exec.name === 'recall_read' ? 'read' : 'search';
          return key.startsWith(`${previous.code}:`) || key.startsWith(`${kind}:${previous.code}:`)
            || previous.code === 'invalid_arguments' && key.startsWith(`${kind}:${(exec.arguments as any)?.action}:invalid:`);
        })) {
          feedback.legacyCodes.add(previous.code!);
        }
      }
      const q = r.queries.find(q => q.id === operation.query);
      let charge: 'search' | 'shared' | 'free' | 'none' = 'none';
      const fail = (code: string, message: string) => { denied = new RecallError(code, message, true); };
      if (r.closed) fail('recall_closed', 'Recall is closed for the rest of this user interaction.');
      else if (operation.kind === 'search' || (operation.kind === 'next' && operation.valid && operation.query && !q)) {
        if (!r.searches) fail('search_exhausted', 'No search attempts remain.');
        else if (!r.shared) fail('shared_exhausted', 'No shared budget remains for search/old-query registration.');
        else { r.searches--; r.shared--; charge = 'search'; if (operation.query && !q) r.queries.push({ id: operation.query, free: 0, granted: false, complete: false }); }
      } else if (operation.kind === 'next' && operation.valid && q?.free) { q.free--; charge = 'free'; }
      else if (!r.shared) fail('shared_exhausted', 'No shared budget remains for this operation.');
      else if (operation.kind === 'next' && operation.valid && q && r.paidPages >= r.limits.paidPages) fail('paid_pages_exhausted', 'The interaction-wide paid search-page limit is exhausted.');
      else { r.shared--; charge = 'shared'; if (operation.kind === 'next' && operation.valid && q) r.paidPages++; }
      r.actualCalls++; r.revision++;
      r.calls.push({ ...call, authorized: !denied, state: denied ? 'rejected' : 'reserved', charge, ...(operation.query ? { query: operation.query } : {}), ...(operation.page ? { page: operation.page } : {}), ...(denied ? { code: denied.code } : {}) });
      if (denied && !r.closed) this.invalid(r, r.calls.at(-1)!, `${denied.code}:${operation.kind}`, feedback);
      await this.put(key, r);
    });
    // A pending persistence operation is never abandoned on cancellation.
    timeline.check();
    return { key, interaction, call, operation, invalidFeedback: feedback, ...(denied ? { denied } : {}) };
  }
  /** Called after a search fixes E(C); its attempt was already durably charged. */
  associate(reservation: Reservation, queryId: string): Promise<void> {
    return this.change(reservation, r => {
      const c = r.calls.find(c => c.eventSeq === reservation.call.eventSeq)!;
      c.query = queryId;
      if (!r.queries.some(q => q.id === queryId)) r.queries.push({ id: queryId, free: 0, granted: false, complete: false });
    });
  }
  complete(reservation: Reservation, outcome: CompletionOutcome): Promise<void> {
    return this.completeWithResult(reservation, outcome, () => undefined);
  }
  /** Validate a synchronous result against the proposed completion, then persist.
   * No history/file IO or page construction belongs inside this short serial section. */
  completeWithResult<T>(reservation: Reservation, outcome: CompletionOutcome, render: (view: CompletionView) => T,
    canContinue: (queryId: string) => boolean = () => true): Promise<T> {
    return this.serial(reservation.key, async () => {
      const original = this.table.get(reservation.key);
      if (!original) throw new RecallError('ledger_missing', 'Authoritative budget disappeared.');
      const r = structuredClone(original);
      const c = r.calls.find(c => c.eventSeq === reservation.call.eventSeq)!;
      if (!c || c.state !== 'reserved') throw new RecallError('ledger_invalid', 'Completion has no active reservation.');
      c.state = outcome.success ? 'completed' : 'failed'; c.code = outcome.code ?? 'OK';
      if (outcome.invalidKey) this.invalid(r, c, outcome.invalidKey, reservation.invalidFeedback);
      const q = r.queries.find(q => q.id === (outcome.query ?? c.query));
      if (outcome.success && q) {
        q.complete = true;
        if (outcome.hasMore && !q.granted) { q.free = r.limits.freePages; q.granted = true; }
      }
      r.revision++;
      const result = render({ budget: this.summaryRecord(r, outcome.query), allowed_actions: this.allowedRecord(r, outcome.query, canContinue) });
      await this.put(reservation.key, r);
      return result;
    }, true);
  }
  private invalid(r: BusinessLedgerRecord, call: BusinessLedgerRecord['calls'][number], key: string, feedback: InvalidFeedback) {
    call.invalidKey = key;
    if (!r.invalid.includes(key)) r.invalid.push(key);
    if (feedback.keys.has(key) || feedback.legacyCodes.has(call.code!)) r.closed = true;
  }
  private change(reservation: Reservation, fn: (record: BusinessLedgerRecord) => void) {
    return this.serial(reservation.key, async () => {
      const value = this.table.get(reservation.key);
      if (!value) throw new RecallError('ledger_missing', 'Authoritative budget disappeared.');
      const r = structuredClone(value); fn(r); r.revision++; await this.put(reservation.key, r);
    }, true);
  }
  private async put(key: string, value: BusinessLedgerRecord) {
    try { await this.table.put(key, businessLedgerRecord.parse(value)); }
    catch (error) { if (error instanceof RecallError) throw error; throw new RecallError('ledger_write_failed', 'Budget persistence failed; uncertain reservations remain charged.'); }
  }
  private serial<T>(key: string, run: () => Promise<T>, completing = false): Promise<T> {
    if (this.closing && !completing) return Promise.reject(new RecallError('recall_unloaded', 'Budget service is unloading.'));
    const task = (this.queues.get(key) ?? Promise.resolve()).then(run);
    this.pending.add(task);
    const tail = task.then(() => undefined, () => undefined);
    this.queues.set(key, tail);
    void tail.then(() => { this.pending.delete(task); if (this.queues.get(key) === tail) this.queues.delete(key); });
    return task;
  }
}
