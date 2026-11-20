import { HarnessError, type ContentBlock } from '@deepseek-ai/dsh-llm';
import { KNOWN_SESSION_EVENT_TYPES, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session';
import { foldSurface, isAppendSurfaceEvent, type SessionMessageProjection } from '@deepseek-ai/dsh-session/surface';
import type { SessionEvent } from '@deepseek-ai/dsh-session/types';
import type { HistorySnapshot } from './history.js';
import { DIAGNOSTIC_TOOL_NAME } from '../diagnostics.js';
import { forwardedRecallResults } from './recall-copies.js';
import { userHistoryContent, type commandInputPath } from './user-content.js';

// Exact native identities, never a substring search over historical text.
const RECALL_TOOLS = new Set(['recall_search', 'recall_read', DIAGNOSTIC_TOOL_NAME]);

export type RangeExitReason =
  | { readonly kind: 'replacement' | 'tool_prune'; readonly eventSeq: number }
  | { readonly kind: 'image_offload'; readonly eventSeq: number; readonly imageIndexes: readonly number[] };

export interface RangeBlock {
  readonly index: number;
  readonly type: 'text' | 'image' | 'file' | 'tool-call';
  readonly kind: 'message' | 'tool_call' | 'tool_result';
  readonly callId?: string;
  readonly toolName?: string;
}

/** Positions in original native content, with no copied text or attachment bytes. */
export interface RangeSource {
  readonly seq: number;
  readonly role: 'user' | 'assistant' | 'tool';
  readonly contentPath: 'data.content' | 'data.message.content' | typeof commandInputPath;
  readonly inherited: boolean;
  readonly retention: 'removed' | 'partial';
  readonly blocks: readonly RangeBlock[];
  readonly reasons: readonly RangeExitReason[];
}

/** The same eligibility rules also apply to explicitly requested context. */
export interface OriginalSource extends Omit<RangeSource, 'retention'> {
  readonly retention: RangeSource['retention'] | 'retained';
}

/** E(C) for one cut. Classification does not mean body extraction is complete. */
export interface HistoryRange {
  readonly status: 'classified';
  readonly sessionId: string;
  readonly formatVersion: number;
  readonly createdAt: number;
  readonly cursor: number;
  readonly inheritedEventCount: number;
  readonly parentSession?: string;
  readonly surfaceSeqs: readonly number[];
  readonly sources: readonly RangeSource[];
}

export class RecallRangeError extends HarnessError {
  constructor(readonly code: 'recall/range-invalid' | 'recall/range-unsupported' | 'recall/range-source-unverified', message: string, cause?: unknown) {
    super(message, code, cause === undefined ? {} : { cause });
    this.name = 'RecallRangeError';
  }
}

interface CallDeclaration {
  readonly seq: number;
  readonly origin: 'assistant' | 'log';
  readonly name: string;
  readonly args: string;
}
const callKey = (turn: number, step: number, id: string) => JSON.stringify([turn, step, id]);

/** A call may have one assistant block and one log-only execution record. */
function indexCalls(events: readonly SessionEvent[]): Map<string, CallDeclaration[]> {
  const calls = new Map<string, CallDeclaration[]>();
  const add = (key: string, declaration: CallDeclaration) => {
    const group = calls.get(key) ?? [];
    group.push(declaration);
    calls.set(key, group);
  };
  for (const event of events) {
    if (event.type === 'tool/call') {
      add(callKey(event.data.turn, event.data.step, event.data.callId), {
        seq: event.seq, origin: 'log', name: event.data.name, args: event.data.arguments,
      });
    } else if (event.type === 'assistant/message' && isAppendSurfaceEvent(event)) {
      for (const block of event.data.message.content) {
        if (block.type === 'tool-call') add(callKey(event.data.turn, event.data.step, block.id), {
          seq: event.seq, origin: 'assistant', name: block.name, args: block.arguments,
        });
      }
    }
  }
  return calls;
}

function resolveCall(calls: Map<string, CallDeclaration[]>, turn: number, step: number, id: string): CallDeclaration[] {
  const group = calls.get(callKey(turn, step, id));
  if (!group?.length || new Set(group.map(item => item.origin)).size !== group.length
    || group.some(item => item.name !== group[0]!.name || item.args !== group[0]!.args)) {
    throw new RecallRangeError('recall/range-source-unverified', `Missing, ambiguous or conflicting native call ${id} at turn ${turn}, step ${step}`);
  }
  return group;
}

function resultToolName(event: SessionEvent<'tool/result'>, calls: Map<string, CallDeclaration[]>): string {
  const { message, turn, step } = event.data;
  if (message.source.kind !== 'tool' || message.source.callId !== message.toolCallId) {
    throw new RecallRangeError('recall/range-source-unverified', `Tool result at seq ${event.seq} has inconsistent call provenance`);
  }
  const group = resolveCall(calls, turn, step, message.toolCallId);
  if (group.some(item => item.seq >= event.seq)
    || (event.sourceEventSeqs && !group.some(item => event.sourceEventSeqs!.includes(item.seq as typeof event.seq)))) {
    throw new RecallRangeError('recall/range-source-unverified', `Tool result at seq ${event.seq} does not cite its native call`);
  }
  return group[0]!.name;
}

function eligibleBlocks(content: readonly ContentBlock[], role: RangeSource['role'], event: SessionEvent, calls: Map<string, CallDeclaration[]>, resultName?: string): RangeBlock[] {
  const blocks: RangeBlock[] = [];
  for (const [index, block] of content.entries()) {
    if (block.type === 'reasoning' || block.type === 'tool-addition' || block.type === 'tool-removal') continue;
    if (block.type === 'tool-call') {
      if (event.type !== 'assistant/message') throw new RecallRangeError('recall/range-source-unverified', `Tool call outside assistant message at seq ${event.seq}`);
      resolveCall(calls, event.data.turn, event.data.step, block.id);
      if (!RECALL_TOOLS.has(block.name)) blocks.push({ index, type: block.type, kind: 'tool_call', callId: block.id, toolName: block.name });
    } else if (block.type === 'text' || block.type === 'image' || block.type === 'file') {
      blocks.push({ index, type: block.type, kind: role === 'tool' ? 'tool_result' : 'message',
        ...(event.type === 'tool/result' ? { callId: event.data.message.toolCallId, toolName: resultName! } : {}),
      });
    } else {
      throw new RecallRangeError('recall/range-unsupported', `Unsupported content block at seq ${event.seq}, index ${index}`);
    }
  }
  return blocks;
}

/** Only newly allocated metadata is frozen; borrowed native events are untouched. */
function freezeTree<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) freezeTree(item);
    Object.freeze(value);
  }
  return value;
}

/**
 * Host-only, within withSnapshot's lease. Use ctx.sessions.messageProjections.
 * Native fold/projection errors are fatal, including missing interpreters.
 * This synchronous step cannot preempt native decoding/folding; batching comes
 * with body extraction and scheduling, not a second surface implementation.
 */
export function inspectHistorySources(snapshot: HistorySnapshot, projections: readonly SessionMessageProjection[], signal?: AbortSignal) {
  signal?.throwIfAborted();
  const { header, cursor, inheritedEventCount, events } = snapshot;
  if (header.version !== SESSION_FORMAT_VERSION) throw new RecallRangeError('recall/range-unsupported', `Unsupported native format ${header.version}`);
  if (!header.id || !Number.isSafeInteger(header.createdAt) || header.createdAt < 0
    || !Number.isSafeInteger(cursor) || cursor < -1 || events.length !== cursor + 1
    || !Number.isSafeInteger(inheritedEventCount) || inheritedEventCount < 0 || inheritedEventCount > events.length) {
    throw new RecallRangeError('recall/range-invalid', 'Snapshot identity, cursor or inherited prefix is inconsistent');
  }
  for (const event of events) {
    if (!KNOWN_SESSION_EVENT_TYPES.has(event.type) && event.ignorable !== true) {
      throw new RecallRangeError('recall/range-unsupported', `Unknown required native event ${event.type}`);
    }
  }
  let folded: ReturnType<typeof foldSurface>;
  try { folded = foldSurface(events, projections); }
  catch (cause) {
    throw new RecallRangeError('recall/range-invalid', `Native surface could not be interpreted: ${cause instanceof Error ? cause.message : String(cause)}`, cause);
  }
  signal?.throwIfAborted();
  const reasons = new Map<number, RangeExitReason[]>();
  const add = (seq: number, reason: RangeExitReason) => {
    const previous = reasons.get(seq) ?? [];
    previous.push(reason);
    reasons.set(seq, previous);
  };
  // Union every actual removal. A later summary replacing an earlier summary
  // must not erase the original sources shadowed by that earlier operation.
  for (const replacement of folded.replacements) {
    for (const seq of replacement.shadowedSeqs) add(seq, {
      kind: events[replacement.seq]!.type === 'tool/result' ? 'tool_prune' : 'replacement', eventSeq: replacement.seq,
    });
  }
  for (const event of events) {
    // The official interpreter has already validated targets and occurrence
    // indexes against the exact preceding surface, including repeat offloads.
    if ((event.type as string) !== 'image/offload') continue;
    const { targets } = event.data as unknown as { targets: { seq: number; imageIndexes: number[] }[] };
    for (const target of targets) add(target.seq, { kind: 'image_offload', eventSeq: event.seq, imageIndexes: [...target.imageIndexes] });
  }
  const calls = indexCalls(events);
  const forwarded = forwardedRecallResults(events);
  const current = new Set<number>(folded.nodes);
  const source = (event: SessionEvent): OriginalSource | undefined => {
    signal?.throwIfAborted();
    const exits = reasons.get(event.seq) ?? [];
    if (!isAppendSurfaceEvent(event)) return;
    let role: RangeSource['role'], content: readonly ContentBlock[], contentPath: RangeSource['contentPath'];
    let resultName: string | undefined;
    if (event.type === 'user/message') {
      // Source identity also excludes checkpoints imported as append messages.
      if ((event.data.source.kind as string) === 'compact-checkpoint') return;
      role = 'user';
      ({ content, contentPath } = userHistoryContent(event.data));
    } else if (event.type === 'assistant/message') {
      role = 'assistant'; content = event.data.message.content; contentPath = 'data.message.content';
    } else if (event.type === 'tool/result') {
      resultName = resultToolName(event, calls);
      if (RECALL_TOOLS.has(resultName) || forwarded.results.has(event.seq)) return;
      role = 'tool'; content = event.data.message.content; contentPath = 'data.message.content';
    } else return;
    const blocks = eligibleBlocks(content, role, event, calls, resultName);
    if (!blocks.length) return;
    return { seq: event.seq, role, contentPath, inherited: event.seq < inheritedEventCount,
      retention: !exits.length ? 'retained' : current.has(event.seq) ? 'partial' : 'removed', blocks,
      reasons: [...exits].sort((a, b) => a.eventSeq - b.eventSeq),
    };
  };
  const sources = events.filter(event => reasons.has(event.seq)).flatMap(event => {
    const original = source(event);
    return original ? [original as RangeSource] : [];
  });
  const range: HistoryRange = freezeTree({ status: 'classified', sessionId: header.id, formatVersion: header.version, createdAt: header.createdAt,
    cursor, inheritedEventCount, ...(header.parentSession === undefined ? {} : { parentSession: header.parentSession }),
    surfaceSeqs: [...folded.nodes], sources,
  });
  // Internal, borrowed view: use and discard within the snapshot callback.
  return { range, forwardedCalls: forwarded.calls, originals: () => {
    void snapshot.events; // Enforce the owning scope even after classification.
    return events.flatMap(event => { const original = source(event); return original ? [freezeTree(original)] : []; });
  } };
}

export function classifyHistoryRange(snapshot: HistorySnapshot, projections: readonly SessionMessageProjection[], signal?: AbortSignal): HistoryRange {
  return inspectHistorySources(snapshot, projections, signal).range;
}
