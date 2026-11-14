import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-typert-registry';
import { validateTypertManifest } from '@deepseek-ai/dsh-typert-loader';
import { TYPERT } from '../lib/typert.host.js';
import { RecallHostService } from './host/service.js';
import type {} from './host/state/page-state.js';

export { RecallHostService };
export const name = 'recall-prewarm';
export const inject = ['typert', 'recallPages'];
export async function apply(ctx: Context) {
  try {
    ctx.typert.register(validateTypertManifest('dsh-recollection', TYPERT));
    await ctx.plugin(RecallHostService);
  } catch (error) {
    ctx.recallPages.failed(error);
    ctx.logger.warn('Recall page prewarming unavailable: %s', error instanceof Error ? error.message : String(error));
  }
}
