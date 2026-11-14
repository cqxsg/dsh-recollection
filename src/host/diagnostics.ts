import { Service, type Context } from '@deepseek-ai/cordis';
import { HarnessError } from '@deepseek-ai/dsh-llm';
import { defineTool, ToolArgsError, TOOL_ABORTED, type ToolRunContext } from '@deepseek-ai/dsh-tools';
import type {} from './history/history.js';
import type {} from './state/ledger.js';

export const DIAGNOSTIC_TOOL_NAME = 'recall_diagnostic_history';

declare module '@deepseek-ai/cordis' {
  interface Context { recallDiagnostics: RecallDiagnosticTools; }
}

/** Explicit test-mode registration only; never enabled by the default plugin. */
export class RecallDiagnosticTools extends Service {
  static inject = ['tools', 'recallHistory', 'recallLedger'];
  private readonly lifetime = new AbortController();
  private readonly active = new Set<Promise<unknown>>();

  constructor(ctx: Context, config: { timeoutMs: number }) {
    super(ctx, 'recallDiagnostics');
    ctx.effect(() => async () => {
      this.lifetime.abort(new HarnessError('Recall diagnostics unloaded', TOOL_ABORTED));
      await Promise.allSettled(this.active);
    });
    ctx.tools.register(defineTool({
      name: DIAGNOSTIC_TOOL_NAME,
      description: 'Isolated integration diagnostic: observe the executing agent session and return only snapshot metadata. Takes no arguments.',
      parameters: {},
      timeoutMs: config.timeoutMs,
      isConcurrencySafe: () => true,
      output: {
        schema: {
          type: 'object', additionalProperties: false,
          properties: {
            sessionId: { type: 'string', required: true },
            source: { type: 'string', enum: ['live', 'prepared'], required: true },
            cursor: { type: 'integer', required: true },
            eventCount: { type: 'integer', required: true },
            inheritedEventCount: { type: 'integer', required: true },
          },
        },
        render: (_, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      presentCall: () => ({ card: 'generic', kind: 'read', title: 'Recall history diagnostic' }),
      execute: (args, exec) => {
        // Track before running, so unload also owns calls just about to start.
        const task = Promise.resolve().then(() => this.observe(args, exec));
        this.active.add(task);
        return task.finally(() => this.active.delete(task));
      },
    }));
  }

  private async observe(args: object, exec: ToolRunContext) {
    const signal = AbortSignal.any([exec.signal, this.lifetime.signal]);
    signal.throwIfAborted();
    if (!exec.agent) throw new HarnessError('Recall diagnostic requires an executing agent', 'RECALL_DIAGNOSTIC_NO_AGENT');
    // rc.4's defineTool parameter map has an open root. Explicitly reject
    // extra keys, including SessionId overrides, before any history access.
    if (Object.keys(args).length) throw new ToolArgsError(['Recall diagnostic takes no arguments']);
    const sessionId = exec.agent.session.id;
    try {
      return await this.ctx.recallLedger.run(exec, signal, actionSignal => this.ctx.recallHistory.withSnapshot(sessionId, (snapshot, readSignal) => {
        readSignal.throwIfAborted();
        return {
          sessionId: snapshot.header.id, source: snapshot.source, cursor: snapshot.cursor,
          eventCount: snapshot.events.length, inheritedEventCount: snapshot.inheritedEventCount,
        };
      }, actionSignal, { waitForQuiescence: true }));
    } catch (error) {
      if (signal.aborted) throw new HarnessError('Recall diagnostic cancelled', TOOL_ABORTED, { cause: error });
      throw error;
    }
  }
}
