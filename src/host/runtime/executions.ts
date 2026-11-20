import type { SessionEvent } from '@deepseek-ai/dsh-session/types';

type TerminalEvent = SessionEvent<'tool/result'> | SessionEvent<'tool/ptc-dispatch'>;

/** Associate native events by execution lifetime. Call ID strings can recur in later turns. */
export function indexExecutions(events: readonly SessionEvent[]) {
  const openRoots = new Map<string, Set<number>>();
  const rootByDispatch = new Map<number, number>();
  const results = new Map<number, TerminalEvent>();
  const pending = new Map<string, number[]>();
  for (const event of events) {
    if (event.type === 'tool/call') {
      const id = event.data.callId, group = openRoots.get(id) ?? new Set<number>();
      group.add(event.seq); openRoots.set(id, group);
    } else if (event.type === 'tool/result') {
      const id = event.data.message.toolCallId, group = openRoots.get(id);
      if (!group) continue;
      const cited = event.sourceEventSeqs?.filter(seq => group.has(seq));
      if (cited?.length === 1) {
        results.set(cited[0]!, event);
        group.delete(cited[0]!);
        if (!group.size) openRoots.delete(id);
      }
    } else if (event.type === 'tool/ptc-dispatch-start' || event.type === 'tool/ptc-dispatch') {
      const { rootCallId, parentCallId, subCallId, name } = event.data;
      const group = openRoots.get(rootCallId);
      if (group?.size !== 1) continue;
      const [root] = group;
      const key = JSON.stringify([root, parentCallId, subCallId, name]);
      if (event.type === 'tool/ptc-dispatch-start') {
        rootByDispatch.set(event.seq, root!);
        const starts = pending.get(key) ?? [];
        starts.push(event.seq); pending.set(key, starts);
      } else {
        const starts = pending.get(key);
        if (starts?.length === 1) {
          results.set(starts[0]!, event);
          pending.delete(key);
        }
      }
    }
  }
  return { rootByDispatch, results };
}
