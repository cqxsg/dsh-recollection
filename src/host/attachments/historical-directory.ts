import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session';
import { absoluteFilePath } from './attachments.js';

interface DirectoryPoint { seq: number; cwd: string | undefined; }
const timelines = new WeakMap<readonly SessionEvent[], readonly DirectoryPoint[]>();
const directory = (value: unknown): string | undefined => typeof value === 'string' && !value.includes('\0') && absoluteFilePath(value) ? value : undefined;

/** A bounded index owned by the immutable event array; never asks the live directory service. */
export function historicalDirectory(header: SessionHeader, events: readonly SessionEvent[], seq: number, inherited = 0): string | undefined {
  if (seq < inherited || events[seq]?.seq !== seq) return;
  let points = timelines.get(events);
  if (!points) {
    const built: DirectoryPoint[] = [];
    for (const [index, event] of events.entries()) {
      if (event.seq !== index) return; // A partial prefix cannot establish a directory.
      if ((event.type as string) === 'working-directory/change') built.push({ seq: event.seq, cwd: directory((event.data as { cwd?: unknown }).cwd) });
    }
    points = built; timelines.set(events, points);
  }
  let lo = 0, hi = points.length;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (points[mid]!.seq <= seq) lo = mid + 1; else hi = mid; }
  return lo ? points[lo - 1]!.cwd : directory(header.cwd);
}

/** Pair a direct native result to one original declaration, not just a reused call ID. */
export function resultDeclarations(events: readonly SessionEvent[], result: SessionEvent): Extract<SessionEvent, { type: 'assistant/message' }>[] {
  if (result.type !== 'tool/result' || result.surfaceOp !== 'append') return [];
  const calls = (result.sourceEventSeqs ?? []).map(seq => events[seq]).filter(e => e?.type === 'tool/call'
    && e.seq < result.seq && e.data.callId === result.data.message.toolCallId && e.data.turn === result.data.turn && e.data.step === result.data.step);
  if (calls.length !== 1) return [];
  const call = calls[0]!;
  if (call.type !== 'tool/call') return [];
  const declarations = events.slice(0, call.seq).filter((event): event is Extract<SessionEvent, { type: 'assistant/message' }> => event.type === 'assistant/message'
    && event.surfaceOp === 'append' && event.data.turn === call.data.turn && event.data.step === call.data.step
    && event.data.message.content.filter(b => b.type === 'tool-call' && b.id === call.data.callId && b.name === call.data.name && b.arguments === call.data.arguments).length === 1);
  return declarations.length === 1 ? declarations : [];
}

/** Relative tool paths are safe only once execution settled without an intervening directory transition. */
export function toolDirectory(header: SessionHeader, events: readonly SessionEvent[], declaration: SessionEvent, callId: string, inherited = 0): string | undefined {
  const results = events.filter(e => e.type === 'tool/result' && e.data.message.toolCallId === callId && resultDeclarations(events, e)[0]?.seq === declaration.seq);
  if (results.length !== 1) return;
  const end = results[0]!.seq;
  if (events.some(e => e.seq > declaration.seq && e.seq <= end && (e.type as string) === 'working-directory/change')) return;
  return historicalDirectory(header, events, declaration.seq, inherited);
}
