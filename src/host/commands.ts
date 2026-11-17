import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-commands';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import type {} from './tools.js';
import { RECALL_INPUT_HINT, type RecallCommandSource } from '../shared/recall-command.js';

export const name = 'recall-command';
export const inject = ['commands', 'recallTools', 'agents'];

const REQUEST = `[/recall request — explicit user command]

Recall original history relevant to the current task.

Use the current context and any background already available in the conversation to identify information that needs to be recovered or verified. When no background is available, infer a useful recall target from the current task, recent questions, missing information, or earlier decisions.

If you cannot identify a concrete historical recall target, do not use the recall tools. Ask the user for clarification.

Use the recall tools to obtain original evidence, adapt your retrieval strategy as needed, and follow the tools' usage limits.

Use the recalled evidence to supplement or correct the current answer. This request applies only to the current task and does not enable a persistent recall mode.`;

function targetedRequest(input: string): string {
  return `[/recall request — explicit user command]

Recall original history relevant to the user's specified target.

User-requested recall target:
${input}

Follow the user's specified recall target. Use the current context and the recall tools to obtain original evidence, adapt your retrieval strategy as needed, and follow the tools' usage limits.

Use the recalled evidence to answer the user's question or to supplement or correct the current answer. This request applies only to the current task and does not enable a persistent recall mode.`;
}

/** A user request through the native inbox; no retrieval or budget state lives here. */
export function apply(ctx: Context): void {
  ctx.commands.register({
    name: 'recall',
    description: 'Recall original history for the current task',
    input: { hint: RECALL_INPUT_HINT.en },
    handler({ agent, rawInput, signal }) {
      signal.throwIfAborted();
      if (ctx.agents.get(agent.id) !== agent) {
        return { kind: 'error', text: 'Recall request was not submitted: the receiving agent is no longer active.' };
      }
      const userInput = rawInput.trim() ? rawInput : '';
      const text = userInput ? targetedRequest(userInput) : REQUEST;
      const source: RecallCommandSource = { kind: 'user', dshRecollection: { type: 'recall', userInput } };
      // Native command execution records thrown submission errors. Returning
      // success only acknowledges this enqueue, never retrieval or completion.
      agent.steer(createUserMessage({ source, content: [{ type: 'text', text }] }));
      return { kind: 'success' };
    },
  });
}
