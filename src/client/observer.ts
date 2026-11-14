import type { SessionId } from '@deepseek-ai/dsh-session/types';
import type { ViewState } from '../shared/view-protocol.js';

interface Snapshot<T> {
  getSnapshot(): T;
  subscribe(listener: () => void): () => void;
}

export interface PageSources {
  readonly sessions: Snapshot<{ readonly byId: Readonly<Record<SessionId, {
    readonly id: SessionId;
    readonly retainedBy: Readonly<Record<string, number | undefined>>;
  }>> }>;
  readonly panel: Snapshot<{ readonly activePanelId: string | null }>;
  readonly document: Pick<Document, 'visibilityState' | 'hasFocus' | 'addEventListener' | 'removeEventListener'>;
  readonly window: Pick<Window, 'addEventListener' | 'removeEventListener'>;
}

/** Reads only public snapshots. Catalog order never decides the selected view. */
export class PageObserver {
  private closed = false;
  private disposed = false;
  private scheduled: ReturnType<typeof setTimeout> | undefined;
  private previous = '';
  private readonly disposers: (() => void)[] = [];

  constructor(private readonly sources: PageSources, changed: () => void, restored: () => void) {
    const publish = () => {
      if (this.disposed) return;
      const key = JSON.stringify(this.read());
      if (key === this.previous) return;
      this.previous = key;
      changed();
    };
    // Native mainView release/retain and panel updates can share a navigation.
    const schedule = () => {
      if (this.scheduled !== undefined) return;
      this.scheduled = setTimeout(() => { this.scheduled = undefined; publish(); }, 0);
    };
    const listen = (target: PageSources['window'] | PageSources['document'], event: string, listener: () => void) => {
      target.addEventListener(event, listener);
      this.disposers.push(() => target.removeEventListener(event, listener));
    };
    this.disposers.push(sources.sessions.subscribe(schedule), sources.panel.subscribe(schedule));
    listen(sources.document, 'visibilitychange', publish);
    listen(sources.window, 'focus', publish);
    listen(sources.window, 'blur', publish);
    listen(sources.window, 'pagehide', () => { this.closed = true; publish(); });
    listen(sources.window, 'pageshow', () => {
      if (!this.closed) return;
      this.closed = false;
      this.previous = '';
      restored();
      publish();
    });
    schedule();
  }

  read(): ViewState {
    const candidates = Object.values(this.sources.sessions.getSnapshot().byId)
      .filter(row => (row.retainedBy.mainView ?? 0) > 0);
    const selected = candidates.length === 1 ? candidates[0] : undefined;
    return {
      sessionId: selected?.id ?? null,
      selection: selected ? 'selected' : candidates.length > 1 ? 'ambiguous' : 'none',
      conversationVisible: this.sources.panel.getSnapshot().activePanelId === null,
      visible: this.sources.document.visibilityState === 'visible',
      focused: this.sources.document.hasFocus(),
      closed: this.closed,
    };
  }

  dispose(): void {
    this.disposed = true;
    clearTimeout(this.scheduled);
    for (const dispose of this.disposers.splice(0).reverse()) dispose();
  }
}
