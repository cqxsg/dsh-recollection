import type { Context } from '@deepseek-ai/cordis';
import { Remote, RemoteError, TypertRemoteService, type Principal } from '@deepseek-ai/dsh-typert-protocol';
import type { OpenPageRequest, PageRegistration, ViewReport, ViewReceipt } from '../shared/view-protocol.js';
import { isPageReportError } from './state/pages.js';
import type {} from './state/page-state.js';

declare module '@deepseek-ai/cordis' {
  interface Context { recallHost: RecallHostService; }
}

/** Canonicalize a JSON principal, never a caller-supplied identity or Peer id. */
function principalKey(principal: Principal): string {
  const stable = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(stable);
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)]));
    }
    return value;
  };
  return JSON.stringify(stable(principal));
}

/** Lightweight authorized page declarations; listeners only enqueue Host work. */
export class RecallHostService extends TypertRemoteService {
  static inject = ['recallPages'];

  constructor(ctx: Context) {
    super(ctx, 'recallHost', { namespace: 'recall' });
    ctx.effect(() => ctx.recallPages.connect());
  }

  /** Issue a capability without reading history or declaring an active view. */
  @Remote({ resources: { session: (request) => request.sessionId ?? undefined } })
  openPage(request: OpenPageRequest, signal: AbortSignal): PageRegistration {
    signal.throwIfAborted();
    return this.invoke(() => this.ctx.recallPages.open(request, principalKey(this.ctx.invocation?.peer.principal ?? { kind: 'owner' })));
  }

  /** Authorize the selected SessionId directly, without a Session lookup. */
  @Remote({ resources: { session: (report) => report.view.sessionId ?? undefined } })
  reportView(report: ViewReport, signal: AbortSignal): ViewReceipt {
    signal.throwIfAborted();
    return this.invoke(() => this.ctx.recallPages.report(report, principalKey(this.ctx.invocation?.peer.principal ?? { kind: 'owner' })));
  }

  private invoke<T>(run: () => T): T {
    try { return run(); }
    catch (error) {
      if (isPageReportError(error)) throw new RemoteError(error.code, error.message, error.details);
      throw error;
    }
  }
}
