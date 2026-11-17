import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-session-projection';
import { z } from 'zod';
import { recallCommandInput, recallPreview, RECALL_PREVIEWS } from '../shared/recall-command.js';

const previewsSchema = z.record(z.string(), z.string().max(50));
const stateSchema = z.object({ turn: z.number().int(), chosen: z.boolean(), previews: previewsSchema });
type State = z.infer<typeof stateSchema>;
declare module '@deepseek-ai/dsh-session-projection' {
  interface SessionProjectionStateMap { recallCommandPreviews: State }
  interface SessionProjectionMap { recallCommandPreviews: Record<string, string> }
}

export const name = 'recall-command-previews';
export const inject = ['sessionProjections'];

/** Display-only whole-log fold, including turns outside the client's paged history. */
export function apply(ctx: Context): void {
  ctx.sessionProjections.register({
    key: RECALL_PREVIEWS, stateVersion: 1, stateSchema,
    init: () => ({ turn: 0, chosen: false, previews: {} }),
    apply(state, event) {
      if (event.type === 'turn/start') {
        return event.data.turn > state.turn ? { ...state, turn: event.data.turn, chosen: false } : state;
      }
      if (event.type !== 'user/message' || state.chosen || event.data.source.kind !== 'user') return state;
      // Follow the first nonempty human prompt, as the host turn-outline does.
      if (!event.data.content.some(block => block.type === 'text' && block.text.trim())) return state;
      const input = recallCommandInput(event.data.source);
      return { ...state, chosen: true, previews: input === undefined ? state.previews
        : { ...state.previews, [state.turn]: recallPreview(input) } };
    },
    wire: { viewSchema: previewsSchema, view: state => state.previews },
  });
}
