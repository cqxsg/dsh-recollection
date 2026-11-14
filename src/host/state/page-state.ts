import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { Service, type Context } from '@deepseek-ai/cordis';
import { BASELINE } from '../../shared/baseline.js';
import type { OpenPageRequest, ViewReport, ViewState } from '../../shared/view-protocol.js';
import { PageRegistry } from './pages.js';

declare module '@deepseek-ai/cordis' {
  interface Context { recallPages: RecallPageState; }
  interface Events { 'recall/view-accepted'(view: ViewState, selectionChanged: boolean): void; }
}

/** Core page hints; no transport, Remote contract or history access. */
export class RecallPageState extends Service {
  private pages = new PageRegistry(randomUUID(), () => performance.now(), randomUUID);
  private state: 'disabled' | 'unavailable' | 'available' | 'failed';
  private reason: string | null;
  constructor(ctx: Context, readonly enabled: boolean) {
    super(ctx, 'recallPages');
    this.state = enabled ? 'unavailable' : 'disabled';
    this.reason = enabled ? 'Page Remote is not connected.' : null;
    ctx.effect(() => () => this.pages.clear());
  }
  get status() {
    return { ...BASELINE, recallAvailable: !!this.ctx.get('recallTools'), pageReportsAvailable: this.state === 'available',
      prewarm: { enabled: this.enabled, state: this.state, reason: this.reason } };
  }
  failed(error: unknown) { this.state = 'failed'; this.reason = error instanceof Error ? error.message : String(error); }
  connect(): () => void {
    if (!this.enabled) throw new Error('Page prewarming is disabled.');
    const pages = this.pages = new PageRegistry(randomUUID(), () => performance.now(), randomUUID);
    this.state = 'available'; this.reason = null;
    const timer = setInterval(() => pages.expire(), 5000);
    return () => {
      clearInterval(timer); pages.clear();
      if (this.pages === pages) { this.state = 'unavailable'; this.reason = 'Page Remote was disconnected.'; }
    };
  }
  private requireAvailable() { if (this.state !== 'available') throw new Error('Page prewarming is unavailable.'); }
  open(request: OpenPageRequest, owner: string) { this.requireAvailable(); return this.pages.open(request, owner); }
  report(report: ViewReport, owner: string) {
    this.requireAvailable();
    const previous = this.pages.snapshot().find(page => page.pageId === report.pageId);
    const receipt = this.pages.report(report, owner);
    if (receipt.accepted) this.ctx.emit('recall/view-accepted', { ...report.view },
      previous?.phase !== 'open' || previous.view?.sessionId !== report.view.sessionId
      || !previous.view?.conversationVisible || previous.view.selection !== 'selected');
    return receipt;
  }
  snapshot() { return this.pages.snapshot(); }
}
