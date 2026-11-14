import type { Context } from '@deepseek-ai/cordis';
import type { ToolExecution } from '@deepseek-ai/dsh-tools';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { currentInteraction, argumentsHash, nativeCallDelivered, nativeCallSettled, successfulRecallContent } from './identity.js';
import { RecallError, parseRequest, type SearchRequest, type ReadRequest, type RecallResult } from '../protocol.js';
import { CallTimeline } from './deadline.js';
import { effectiveSpill, pageBudget, verifyOutput } from '../retrieval/output.js';
import type { RecallConfig } from './config.js';
import type { Operation, Reservation, RecallBudgetService } from '../state/budget.js';
import type {} from '../state/budget.js';
import type {} from './memory.js';
import type {} from '../state/cursors.js';

export interface BusinessPage { result: RecallResult; query?: string; hasMore?: boolean; }
interface PageClaim { key: string; exec: ToolExecution; reservation: Reservation; resultSeen: boolean; }
const budgetNotices = {
  closed: 'Recall closed after the same uncorrected invalid operation; use available history and other tools, or start a new user interaction.',
  exhausted: 'This interaction has no usable recall budget. Other tools remain available.',
  shared: 'Shared budget exhausted; only registered queries with remaining free pages can continue.',
};
export function resultGuidance(result: RecallResult): RecallResult {
  // Page sizing and final accounting both render guidance. Refresh only our
  // own notice, preserving the underlying error and avoiding duplicate notices.
  const messages = result.message?.split('\n\n').filter(message => !Object.values(budgetNotices).includes(message)) ?? [];
  if (result.budget.closed) messages.push(budgetNotices.closed);
  else if (!result.allowed_actions.length) messages.push(budgetNotices.exhausted);
  else if (!result.budget.shared_remaining) messages.push(budgetNotices.shared);
  if (messages.length) result.message = messages.join('\n\n');
  else delete result.message;
  return result;
}
export interface ControlOptions {
  names: ReadonlyMap<string, 'search' | 'read'>;
  checkPolicy?(exec: ToolExecution): void;
  canContinue?(agent: Agent, queryId: string, ignorePage?: string): boolean;
  next?(request: Extract<SearchRequest, { action: 'next' }>, exec: ToolExecution): { query: string; page: string } | undefined;
  execute(request: SearchRequest | ReadRequest, exec: ToolExecution, reservation: Reservation, timeline: CallTimeline): Promise<BusinessPage>;
}

/** The raw public tool entry owns parsing and accounting for both Native and PTC. */
export class RecallCallController {
  private readonly active = new Set<Promise<unknown>>();
  private readonly lifetime = new AbortController();
  private readonly masks = new Map<Agent, { key: string; dispose: () => void }>();
  private readonly inFlight = new Map<string, number>();
  private readonly participants = new Map<string, WeakRef<Agent>>();
  private readonly pages = new Map<string, PageClaim>();
  private readonly pageCalls = new Map<unknown, PageClaim>();
  private readonly budget: RecallBudgetService;
  private visibilityFailed = false;
  constructor(private readonly ctx: Context, readonly config: RecallConfig, private readonly options: ControlOptions) {
    this.budget = ctx.recallBudget;
    ctx.on('tools/result', (exec, result) => {
      const claim = this.pageCalls.get(exec.token);
      if (claim) {
        claim.resultSeen = true;
        // A successful candidate is still protected until history confirms its
        // delivery. Native batches and PTC may publish that history later.
        if (result.isError || !successfulRecallContent(result.content)) this.releasePage(claim);
      }
      // The PTC root drains its dispatch logging before its own final result.
      // Release undelivered children even when their log write failed.
      if (!exec.parent) this.releasePages(c => c.exec.agent?.session === exec.agent?.session
        && c.reservation.call.kind === 'ptc' && c.reservation.call.rootCallId === exec.callId && c.resultSeen);
      if (options.names.has(exec.name) && exec.agent) this.visibility(exec.agent);
    });
    ctx.on('agent/created', ({ agent }) => { this.visibility(agent); });
    ctx.on('agent/disposed', ({ agent }) => { this.unmask(agent); this.participants.delete(agent.id); this.releasePages(c => c.exec.agent?.id === agent.id); });
    ctx.on('agent/status', ({ agent, status }) => { if (status === 'idle') this.releasePages(c => c.exec.agent?.id === agent.id && c.resultSeen); });
    ctx.on('session/event', (session, event) => {
      if (event.type === 'user/message') for (const agent of this.masks.keys()) if (agent.session === session) this.visibility(agent);
      if (event.type === 'tool/result' || event.type === 'tool/ptc-dispatch') {
        this.releasePages(c => c.exec.agent?.session === session && nativeCallSettled(c.exec, c.reservation.call));
        const agent = this.participants.get(session.id)?.deref(); if (agent) this.visibility(agent);
      }
    });
    // Claimed human input is only a declaration hint, never budget creation.
    // It arrives BEFORE native prompt/tool assembly. Replayed input is excluded.
    ctx.on('agent/inbox/claimed', ({ agent, message, turn }) => {
      if (!this.masks.has(agent) || message.source.kind !== 'user') return;
      const events = agent.session.snapshotEvents();
      let start = -1;
      for (const [index, event] of events.entries()) if (event.type === 'turn/start' && event.data.turn === turn) start = index;
      if (start < 0 || events.slice(start).some(e => e.type === 'user/message' && e.data.source.kind === 'user')
        || events.some(e => e.type === 'user/message' && e.data.id === message.id)) return;
      this.unmask(agent);
    });
    ctx.on('agent/pre-step', async ({ agent }, next) => {
      this.releasePages(c => c.exec.agent?.id === agent.id && c.resultSeen);
      const decision = await next();
      if (decision.kind !== 'enter') this.visibility(agent);
      return decision;
    });
    // Guards only enforce final closure. Action-specific accounting stays async.
    ctx.tools.guard(exec => {
      if (!options.names.has(exec.name) || !exec.agent) return;
      const identity = currentInteraction(exec.agent.session);
      if (identity && this.budget.state(identity)?.closed) return 'Recall is closed for this interaction; other tools remain available.';
    });
    ctx.effect(() => async () => {
      this.lifetime.abort(new RecallError('recall_unloaded', 'Recall tools unloaded.'));
      await Promise.allSettled(this.active);
      for (const agent of [...this.masks.keys()]) this.unmask(agent);
      this.participants.clear();
      this.pages.clear(); this.pageCalls.clear();
    });
    for (const agent of ctx.get('agents')?.list() ?? []) this.visibility(agent);
  }
  private releasePage(claim: PageClaim) {
    if (this.pages.get(claim.key) === claim) this.pages.delete(claim.key);
    this.pageCalls.delete(claim.exec.token);
  }
  private releasePages(matches: (claim: PageClaim) => boolean) { for (const claim of this.pages.values()) if (matches(claim)) this.releasePage(claim); }
  private claimPage(exec: ToolExecution, kind: string, reservation: Reservation, page: string): PageClaim {
    // Recheck after durable admission: another call may have delivered while
    // this call was queued for its own write. Every real call stays charged.
    // Read validates its retained fixed range (and verified anchor recovery)
    // before checking delivery inside its session queue. Preserve that order
    // when only a persisted locator survives a reload.
    if (kind === 'search' && this.budget.state(reservation.interaction)?.calls.some(c => c.page === page && c.state === 'completed' && nativeCallDelivered(exec, c))) {
      throw new RecallError('duplicate_page', `This fixed ${kind} page was already returned successfully.`, true,
        'The submitted cursor identifies the already delivered page.', page);
    }
    const key = JSON.stringify([reservation.key, kind, page]);
    if (this.pages.has(key)) throw new RecallError('page_in_flight', 'Another call is still processing or delivering this fixed page.', false,
      'Retry the same cursor after the earlier call finishes if its page was not delivered.');
    const claim: PageClaim = { key, exec, reservation, resultSeen: false };
    this.pages.set(key, claim); this.pageCalls.set(exec.token, claim); return claim;
  }
  private unmask(agent: Agent) { this.masks.get(agent)?.dispose(); this.masks.delete(agent); }
  private visibility(agent: Agent) {
    try { this.updateVisibility(agent); }
    catch (error) {
      // Hiding exhausted tools only improves declarations. The guard and
      // durable reservation still enforce closure and budgets on every call.
      if (!this.visibilityFailed) this.ctx.logger.warn('Recall tool visibility optimization unavailable: %s', String(error));
      this.visibilityFailed = true;
    }
  }
  private updateVisibility(agent: Agent) {
    if (this.inFlight.has(agent.id)) return; // Never withdraw a definition while a sibling result still needs normalization.
    const identity = currentInteraction(agent.session);
    const r = identity && this.budget.state(identity);
    const denied: string[] = [];
    const allowed = identity && r ? this.budget.allowed(identity, undefined, id => this.options.canContinue?.(agent, id) ?? true) : undefined;
    const searchAvailable = !allowed || allowed.some(action => ['search', 'attach_old_search', 'search_next', 'other_query_next'].includes(action));
    for (const [name, kind] of this.options.names) {
      if (allowed && (kind === 'read' ? !allowed.includes('read') : !searchAvailable)) denied.push(name);
    }
    const key = JSON.stringify([identity?.interactionId, denied]);
    if (this.masks.get(agent)?.key === key) return;
    this.unmask(agent);
    if (denied.length) {
      const dispose = agent.ctx.tools.restrict({ deny: denied });
      this.masks.set(agent, { key, dispose });
    }
  }
  async body(exec: ToolExecution): Promise<RecallResult> {
    this.options.checkPolicy?.(exec);
    // Every native around-execute wrapper is already active here, regardless
    // of plugin mounting order. Include its signal before the first await.
    const timeline = new CallTimeline(this.config, AbortSignal.any([exec.signal, this.lifetime.signal, this.budget.signal]));
    const id = exec.agent?.id;
    let unpin: (() => void) | undefined, task: Promise<RecallResult> | undefined;
    if (id) { this.inFlight.set(id, (this.inFlight.get(id) ?? 0) + 1); this.participants.set(id, new WeakRef(exec.agent!)); }
    try {
      unpin = id ? this.ctx.get('recallMemory')?.budget.pin(id) : undefined;
      task = this.budget.track(() => this.run(exec, timeline)); this.active.add(task);
      return await task;
    } finally {
      if (task) this.active.delete(task);
      timeline.dispose();
      if (id) { const left = this.inFlight.get(id)! - 1; if (left) this.inFlight.set(id, left); else this.inFlight.delete(id); }
      unpin?.();
    }
  }
  private async run(exec: ToolExecution, timeline: CallTimeline): Promise<RecallResult> {
    const kind = this.options.names.get(exec.name)!;
    timeline.check();
    let request: SearchRequest | ReadRequest | undefined;
    let error: unknown;
    try { request = parseRequest(kind, exec.arguments); } catch (caught) { error = caught; }
    let next: { query?: string; page: string } | undefined;
    if (request?.action === 'next') {
      try { next = kind === 'search' ? this.options.next?.(request, exec)
        : { page: this.ctx.recallCursors.resolve(request.cursor, exec.agent!.session.id, 'read').pageId }; }
      catch (caught) { error = caught; }
    }
    const operation: Operation = {
      kind: kind === 'read' ? 'read' : request?.action === 'next' || (exec.arguments as any)?.action === 'next' ? 'next' : 'search',
      ...(next ? next : {}), valid: !error && !!next,
    };
    const reservation = await this.budget.reserve(exec, timeline, operation);
    let claim: PageClaim | undefined;
    if (next && !error && !reservation.denied) {
      try { claim = this.claimPage(exec, kind, reservation, next.page); }
      catch (caught) { error = caught; }
    }
    try {
      const result = await this.finish(exec, kind, timeline, request, error, reservation, next?.query);
      if (claim && result.status !== 'ok') this.releasePage(claim);
      return result;
    } catch (caught) { if (claim) this.releasePage(claim); throw caught; }
  }
  private async finish(exec: ToolExecution, kind: 'search' | 'read', timeline: CallTimeline, request: SearchRequest | ReadRequest | undefined, error: unknown, reservation: Reservation, query?: string): Promise<RecallResult> {
    const operation = reservation.operation;
    let result: RecallResult;
    const validationError = reservation.denied ? error : undefined;
    if (reservation.denied) error = reservation.denied;
    if (!error) {
      let completing = false;
      try {
        pageBudget(this.config, kind, effectiveSpill(this.ctx, exec));
        const page = await this.options.execute(request!, exec, reservation, timeline);
        timeline.check(); query = page.query;
        // Validate a fully rendered candidate before durable completion/F grant.
        verifyOutput(page.result, pageBudget(this.config, kind, effectiveSpill(this.ctx, exec)));
        completing = true;
        await this.budget.complete(reservation, { success: true, ...(page.query ? { query: page.query } : {}), hasMore: page.hasMore ?? false });
        result = page.result;
      } catch (caught) { if (completing) throw caught; error = caught; }
    }
    if (error) {
      const code = error instanceof Error && 'code' in error ? String(error.code) : timeline.signal.aborted ? 'ABORTED' : 'execution_failed';
      if (!reservation.denied) await this.budget.complete(reservation, { success: false, code, ...(error instanceof RecallError && error.invalid ? { invalidKey: this.invalidKey(kind, error, request, exec.arguments) } : {}) });
      const failures = validationError ? [validationError, error] : [error];
      const recovery = [...new Set(failures.flatMap(failure => failure instanceof RecallError && failure.recovery ? [failure.recovery] : []))].join('\n\n');
      result = {
        status: ['business_deadline', 'preparation_timeout', 'ABORTED'].includes(code) ? 'incomplete' : 'error', code,
        message: [...new Set(failures.map(failure => failure instanceof Error ? failure.message : 'Recall operation failed.'))].join('\n\n'),
        ...(recovery ? { recovery } : {}),
        ...(kind === 'search' ? { scanComplete: false } : { readComplete: false }), items: [],
        budget: this.budget.summary(reservation.interaction, query), allowed_actions: [],
      };
    }
    result!.budget = this.budget.summary(reservation.interaction, query);
    result!.allowed_actions = this.budget.allowed(reservation.interaction, query, id =>
      id === query && kind === 'search' && !!result!.nextCursor
      || (this.options.canContinue?.(exec.agent!, id, id === query && result!.status === 'ok' ? operation.page : undefined) ?? true));
    resultGuidance(result!);
    verifyOutput(result!, pageBudget(this.config, kind, effectiveSpill(this.ctx, exec)));
    return result!;
  }
  private invalidKey(kind: string, error: RecallError, request: SearchRequest | ReadRequest | undefined, raw: unknown): string {
    if (error.invalidIdentity) return `${kind}:${error.code}:${error.invalidIdentity}`;
    if (error.code === 'invalid_arguments') {
      // Zod's issue path and cause, not unrelated valid parameters or JSON key order.
      const schema = kind === 'search' ? (raw as any)?.action : (raw as any)?.action;
      return `${kind}:${schema}:invalid:${error.message}`;
    }
    return `${kind}:${error.code}:${error.recovery ?? ''}:${request?.action === 'next' ? argumentsHash(request.cursor) : request?.action === 'read' ? argumentsHash(request.ref) : ''}:${error.code === 'duplicate_query' ? error.message : ''}`;
  }
}
