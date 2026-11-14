import { Service, type Context } from '@deepseek-ai/cordis';
import type { ToolDefinition, ToolExecution } from '@deepseek-ai/dsh-tools';
import { policyFibers, policyActive } from './runtime/policies.js';
import { RecallSearchEngine } from './retrieval/search.js';
import { RecallReadEngine } from './retrieval/read.js';
import { RecallCallController } from './runtime/control.js';
import { RecallError, inputSchema, nativeSchema, recallResult, type RecallResult } from './protocol.js';
import { renderRecall } from './retrieval/output.js';
import type { RecallConfig } from './runtime/config.js';
import { RECALL_USAGE, SEARCH_DESCRIPTION, READ_DESCRIPTION } from './tool-descriptions.js';
import type {} from './state/budget.js';
import type {} from '@deepseek-ai/dsh-system-prompt';

export { RECALL_USAGE, SEARCH_DESCRIPTION, READ_DESCRIPTION } from './tool-descriptions.js';

declare module '@deepseek-ai/cordis' { interface Context { recallTools: RecallToolsService; } }
function requireTimeout(ctx: Context, exec: ToolExecution) {
  const policies = policyFibers(ctx, 'timeout-policy', exec).filter(policyActive);
  if (!policies.length) throw new RecallError('timeout_policy_unavailable', 'An active native timeout-policy applicable to this call is required; this call was not admitted or charged. Restore the policy and retry.');
}

/** Normal product registration: call control is installed in the same synchronous activation. */
export class RecallToolsService extends Service {
  static inject = ['tools', 'recallBudget', 'recallReferences', 'recallCursors', 'recallPreparation', 'recallHistory', 'sessions', 'agents'];
  readonly search: RecallSearchEngine;
  readonly read: RecallReadEngine;
  constructor(ctx: Context, readonly config: RecallConfig) {
    super(ctx, 'recallTools');
    this.search = new RecallSearchEngine(ctx, config); this.read = new RecallReadEngine(ctx, config);
    let controller: RecallCallController;
    for (const [name, kind, description] of [['recall_search', 'search', SEARCH_DESCRIPTION], ['recall_read', 'read', READ_DESCRIPTION]] as const) {
      const definition: ToolDefinition = {
        name, description, parameters: inputSchema(kind) as ToolDefinition['parameters'], timeoutMs: config.outerMs,
        isConcurrencySafe: () => true,
        output: { schema: nativeSchema(recallResult), render: (_, value) => renderRecall(value as unknown as RecallResult),
          presentationMeta: (_, value) => { const r = value as unknown as RecallResult; return { recall: { budget: r.budget, status: r.status, ...(r.scanComplete !== undefined ? { scanComplete: r.scanComplete } : {}), ...(r.readComplete !== undefined ? { readComplete: r.readComplete } : {}) } }; } },
        execute: (_, exec) => controller.body(exec),
        presentCall: () => ({ card: 'generic', kind: 'read', title: kind === 'search' ? 'Search original history' : 'Read original history' }),
      };
      ctx.tools.register(definition);
    }
    controller = new RecallCallController(ctx, config, {
      names: new Map([['recall_search', 'search'], ['recall_read', 'read']]), checkPolicy: exec => requireTimeout(ctx, exec),
      canContinue: (...args) => this.search.canContinue(...args), next: (...args) => this.search.inspectNext(...args),
      execute: async (request, exec, reservation, timeline) => {
        const release = ctx.recallPreparation.holdOperation(exec.agent!.session.id);
        timeline.operation = release.ticket;
        try { return await (exec.name === 'recall_search'
          ? this.search.run(request as Parameters<RecallSearchEngine['run']>[0], exec, reservation, timeline)
          : this.read.run(request as Parameters<RecallReadEngine['run']>[0], exec, reservation, timeline)); }
        finally { timeline.operation = undefined; release(); this.search.matcher.wake(); }
      },
    });
    // Tool descriptions already carry the usage contract. Extra system guidance
    // can attach/recover independently of the core tool service.
    void Promise.resolve(ctx.inject(['systemPrompt'], prompt => {
      prompt.systemPrompt.section({ name: 'recall:usage', order: 4100, text: RECALL_USAGE, interpolate: false });
    })).catch(error => ctx.logger.warn('Recall extra prompt guidance unavailable: %s', String(error)));
    ctx.on('recall/view-accepted', () => this.search.matcher.wake());
    ctx.effect(() => async () => { this.read.clear(); await this.search.dispose(); });
  }
}
