import { PAGE_EXPIRY_MS, isActiveView, type OpenPageRequest, type PageRegistration, type ViewReport, type ViewReceipt, type ViewState } from '../../shared/view-protocol.js';

interface PageErrorDetails {
  'recall/invalid-report': { field: string };
  'recall/page-conflict': { reason: 'owner' | 'registration-order' };
  'recall/re-register': { reason: 'host-changed' | 'expired' | 'unknown-registration' };
}
export class PageReportError<K extends keyof PageErrorDetails = keyof PageErrorDetails> extends Error {
  constructor(readonly code: K, message: string, readonly details: PageErrorDetails[K]) { super(message); this.name = 'RecallPageReportError'; }
}
export function isPageReportError(error: unknown): error is PageReportError {
  return error instanceof Error && error.name === 'RecallPageReportError' && 'code' in error && 'details' in error;
}

interface Page {
  pageId: string;
  owner: string;
  registrationSequence: number;
  registrationId: string;
  lastSequence: number;
  lastActivationSequence: number;
  lastReceivedAt: number;
  phase: 'open' | 'closed' | 'expired';
  view: ViewState | null;
  previousView: ViewState | null;
  activationOrder: number;
}

/** Host-only diagnostic state. Registration capabilities never leave via snapshots. */
export interface PageSnapshot {
  readonly pageId: string;
  readonly sequence: number;
  readonly lastReceivedAt: number;
  readonly phase: 'open' | 'closed' | 'expired';
  readonly view: ViewState | null;
  readonly active: boolean;
  readonly activationOrder: number;
}

function invalid(field: string): never {
  throw new PageReportError('recall/invalid-report', 'Invalid page report.', { field });
}

function identity(value: string, field: string): void {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256) invalid(field);
}

function sequence(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 1) invalid(field);
}

/** In-memory page declarations only; no history IO, preparation tasks or budgets. */
export class PageRegistry {
  private readonly pages = new Map<string, Page>();
  private activationOrder = 0;

  constructor(
    readonly hostEpoch: string,
    private readonly now: () => number,
    private readonly randomId: () => string,
  ) {}

  open(request: OpenPageRequest, owner: string): PageRegistration {
    if (request.protocolVersion !== 1) invalid('protocolVersion');
    identity(request.pageId, 'pageId');
    sequence(request.registrationSequence, 'registrationSequence');
    if (request.sessionId !== null) identity(request.sessionId, 'sessionId');
    this.expire();
    const previous = this.pages.get(request.pageId);
    if (previous !== undefined) {
      if (previous.owner !== owner) throw new PageReportError('recall/page-conflict', 'Page belongs to another principal.', { reason: 'owner' });
      if (request.registrationSequence < previous.registrationSequence) {
        throw new PageReportError('recall/page-conflict', 'Registration was superseded.', { reason: 'registration-order' });
      }
      if (request.registrationSequence === previous.registrationSequence) {
        if (previous.phase !== 'open') this.requireRegistration('expired');
        // Idempotent open does not renew the lease or create an activation edge.
        return { hostEpoch: this.hostEpoch, registrationId: previous.registrationId };
      }
    }
    const retained = previous?.phase === 'open' ? previous : undefined;
    const page: Page = {
      pageId: request.pageId, owner,
      registrationSequence: request.registrationSequence,
      registrationId: this.randomId(), lastSequence: 0,
      lastActivationSequence: retained?.lastActivationSequence ?? 0,
      lastReceivedAt: this.now(), phase: 'open', view: null,
      previousView: retained?.view ?? retained?.previousView ?? null,
      activationOrder: retained?.activationOrder ?? 0,
    };
    this.pages.set(request.pageId, page);
    return { hostEpoch: this.hostEpoch, registrationId: page.registrationId };
  }

  report(report: ViewReport, owner: string): ViewReceipt {
    if (report.protocolVersion !== 1) invalid('protocolVersion');
    identity(report.pageId, 'pageId');
    identity(report.hostEpoch, 'hostEpoch');
    identity(report.registrationId, 'registrationId');
    sequence(report.sequence, 'sequence');
    if (!Number.isSafeInteger(report.activationSequence) || report.activationSequence < 0) invalid('activationSequence');
    const view = report.view;
    if ((view.selection === 'selected') !== (view.sessionId !== null)) invalid('view.selection');
    if (view.sessionId !== null) identity(view.sessionId, 'view.sessionId');
    if (report.hostEpoch !== this.hostEpoch) this.requireRegistration('host-changed');
    this.expire();
    const page = this.pages.get(report.pageId);
    if (page === undefined || page.registrationId !== report.registrationId || page.owner !== owner) this.requireRegistration('unknown-registration');
    if (page.phase !== 'open') this.requireRegistration('expired');
    if (report.sequence <= page.lastSequence) return { accepted: false, reason: 'stale', hostEpoch: this.hostEpoch };
    if (report.activationSequence < page.lastActivationSequence) invalid('activationSequence');
    const before = page.view ?? page.previousView;
    if (isActiveView(view) && (!isActiveView(before) || before?.sessionId !== view.sessionId || report.activationSequence > page.lastActivationSequence)) {
      page.activationOrder = ++this.activationOrder;
    }
    page.view = Object.freeze({ ...view });
    page.previousView = null;
    page.lastSequence = report.sequence;
    page.lastActivationSequence = report.activationSequence;
    page.lastReceivedAt = this.now();
    if (view.closed) page.phase = 'closed';
    return { accepted: true, reason: 'accepted', hostEpoch: this.hostEpoch };
  }

  expire(): void {
    const now = this.now();
    for (const page of this.pages.values()) {
      if (page.phase === 'open' && now - page.lastReceivedAt >= PAGE_EXPIRY_MS) page.phase = 'expired';
      // Keep order tombstones for one additional lease. Old capabilities cannot
      // revive a page even after eviction: opening always issues a fresh token.
      if (page.phase !== 'open' && now - page.lastReceivedAt >= PAGE_EXPIRY_MS * 2) this.pages.delete(page.pageId);
    }
  }

  snapshot(): readonly PageSnapshot[] {
    this.expire();
    return [...this.pages.values()].map(page => ({
      pageId: page.pageId, sequence: page.lastSequence, lastReceivedAt: page.lastReceivedAt,
      phase: page.phase, view: page.view,
      active: page.phase === 'open' && isActiveView(page.view),
      activationOrder: page.activationOrder,
    }));
  }

  clear(): void { this.pages.clear(); }

  private requireRegistration(reason: 'host-changed' | 'expired' | 'unknown-registration'): never {
    throw new PageReportError('recall/re-register', 'Read current page state and register again.', { reason });
  }
}
