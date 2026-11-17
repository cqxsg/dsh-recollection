/** Persisted presentation metadata; never interpreted as model instructions. */
export interface RecallCommandSource {
  kind: 'user';
  dshRecollection: { type: 'recall'; userInput: string };
}

export function recallCommandInput(source: unknown): string | undefined {
  if (!source || typeof source !== 'object' || !('kind' in source) || source.kind !== 'user'
    || !('dshRecollection' in source)) return;
  const marker = source.dshRecollection;
  if (!marker || typeof marker !== 'object' || !('type' in marker) || marker.type !== 'recall'
    || !('userInput' in marker) || typeof marker.userInput !== 'string') return;
  return marker.userInput;
}

export const RECALL_INPUT_HINT = { zh: '输入你想要回想的内容', en: 'Enter what you want to recall' } as const;
export const RECALL_PREVIEWS = 'recallCommandPreviews';

/** Matches the host rail's 50-character prompt budget, without copying the instruction. */
export function recallPreview(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.length > 49 ? `${normalized.slice(0, 49).trimEnd()}…` : normalized;
}
