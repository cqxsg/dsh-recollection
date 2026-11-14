import { Service, type Context } from '@deepseek-ai/cordis';
import { BASELINE, type BaselineStatus } from '../shared/baseline.js';
import type {} from '@deepseek-ai/dsh-api-gateway/client';
import type {} from '@deepseek-ai/dsh-api-session-controller/client';
import type {} from '@deepseek-ai/dsh-client-ui-layout/client';
import type {} from '@deepseek-ai/dsh-client-connection/client';
import { TYPERT_REMOTE } from '../../lib/typert.remote-client.js';
import { PageObserver } from './observer.js';
import { PageReporter } from './reporter.js';

declare module '@deepseek-ai/cordis' {
  interface Context {
    recallClient: RecallClientService;
  }
}

/** Page-local observers and reporting, with no Session retention or history IO. */
export class RecallClientService extends Service {
  static inject = ['remote', 'remote.recall', 'sessions', 'layout'];
  readonly status: BaselineStatus = BASELINE;
  readonly pageId = crypto.randomUUID();

  constructor(ctx: Context) {
    super(ctx, 'recallClient');
    ctx.effect(() => {
      let reporter: PageReporter | undefined;
      const observer = new PageObserver({
        sessions: ctx.sessions.list, panel: ctx.layout.panelInfo, document, window,
      }, () => reporter?.request(), () => reporter?.reconnect());
      const reports = reporter = new PageReporter(this.pageId, ctx.remote.recall, () => observer.read());
      const disconnect = ctx.on('connection/reset', () => reports.reconnect());
      reports.request();
      return () => { disconnect(); observer.dispose(); reports.dispose(); };
    });
  }
}

export const inject = ['remote', 'sessions', 'layout'];

export async function apply(ctx: Context): Promise<() => void | Promise<void>> {
  const unmount = await ctx.remote.$mount(TYPERT_REMOTE);
  ctx.plugin(RecallClientService);
  return unmount;
}
