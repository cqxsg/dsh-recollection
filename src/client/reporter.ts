import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol';
import { REPORT_INTERVAL_MS, REPORT_TIMEOUT_MS, isActiveView, type OpenPageRequest, type PageRegistration, type ViewReport, type ViewReceipt, type ViewState } from '../shared/view-protocol.js';

export interface PageRemote {
  openPage(request: OpenPageRequest, signal?: AbortSignal): Promise<RemoteResult<PageRegistration>>;
  reportView(report: ViewReport, signal?: AbortSignal): Promise<RemoteResult<ViewReceipt>>;
}

/** One in-flight RPC and one coalesced pending sample per page. */
export class PageReporter {
  private registration: PageRegistration | undefined;
  private registrationSequence = 1;
  private sequence = 0;
  private activationSequence = 0;
  private observed: ViewState | null = null;
  private generation = 0;
  private busy = false;
  private pending = false;
  private disposed = false;
  private retried = false;
  private controller: AbortController | undefined;
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(
    readonly pageId: string,
    private readonly remote: PageRemote,
    private readonly sample: () => ViewState,
  ) {
    this.timer = setInterval(() => {
      this.retried = false;
      if (!this.sample().closed) this.request();
    }, REPORT_INTERVAL_MS);
  }

  request(): void {
    if (this.disposed) return;
    this.read();
    this.pending = true;
    if (!this.busy) void this.flush();
  }

  /** Invalidate old responses; every new generation takes fresh UI snapshots. */
  reconnect(): void {
    this.invalidate();
    this.retried = false;
    this.request();
  }

  dispose(): void {
    this.disposed = true;
    this.pending = false;
    clearInterval(this.timer);
    this.controller?.abort();
  }

  private invalidate(): void {
    this.generation++;
    this.registrationSequence++;
    this.sequence = 0;
    this.registration = undefined;
    this.controller?.abort();
  }

  private read(): ViewState {
    const view = this.sample();
    if (isActiveView(view) && (!isActiveView(this.observed) || view.sessionId !== this.observed?.sessionId)) {
      this.activationSequence++;
    }
    this.observed = view;
    return view;
  }

  private async call<T>(invoke: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    this.controller = controller;
    const timeout = setTimeout(() => controller.abort(), REPORT_TIMEOUT_MS);
    try { return await invoke(controller.signal); }
    finally {
      clearTimeout(timeout);
      if (this.controller === controller) this.controller = undefined;
    }
  }

  private async flush(): Promise<void> {
    this.busy = true;
    this.pending = false;
    const generation = this.generation;
    const current = () => !this.disposed && generation === this.generation;
    try {
      if (!this.registration) {
        const result = await this.call(signal => this.remote.openPage({
          protocolVersion: 1, pageId: this.pageId,
          registrationSequence: this.registrationSequence,
          sessionId: this.read().sessionId,
        }, signal));
        if (!current()) return;
        if (!result.ok) { this.failed(result.error.code); return; }
        this.registration = result.value;
      }
      // Never replay the sample that preceded registration or reconnection.
      const view = this.read();
      this.pending = false;
      const report: ViewReport = {
        protocolVersion: 1, pageId: this.pageId, ...this.registration,
        sequence: ++this.sequence, activationSequence: this.activationSequence, view,
      };
      const result = await this.call(signal => this.remote.reportView(report, signal));
      if (!current()) return;
      if (!result.ok) { this.failed(result.error.code); return; }
      if (result.value.hostEpoch !== this.registration.hostEpoch) this.failed('recall/re-register');
      else this.retried = false;
    } catch {
      // Transport cancellation/failure is retried by the next state/heartbeat,
      // not by an unbounded immediate loop. Native Remote normally folds it.
    } finally {
      this.busy = false;
      if (this.pending && !this.disposed) void this.flush();
    }
  }

  private failed(code: string): void {
    if (code !== 'recall/re-register') return;
    this.invalidate();
    if (!this.retried) { this.retried = true; this.pending = true; }
  }
}
