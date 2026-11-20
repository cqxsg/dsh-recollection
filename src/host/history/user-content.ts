import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import type { SessionEvent } from '@deepseek-ai/dsh-session/types';
import { recallCommandInput } from '../../shared/recall-command.js';

export const commandInputPath = 'data.source.dshRecollection.userInput';

/** Stored command messages carry both the model prompt and the user's own words. */
export function userHistoryContent(message: SessionEvent<'user/message'>['data']): {
  content: readonly ContentBlock[]; contentPath: 'data.content' | typeof commandInputPath;
} {
  const input = recallCommandInput(message.source);
  if (input === undefined) return { content: message.content, contentPath: 'data.content' };
  return { content: input ? [{ type: 'text', text: input }] : [], contentPath: commandInputPath };
}
