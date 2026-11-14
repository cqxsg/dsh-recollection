import { createHash } from 'node:crypto';
import { HarnessError } from '@deepseek-ai/dsh-llm';
import type { Session } from '@deepseek-ai/dsh-session';
import type { ToolExecution } from '@deepseek-ai/dsh-tools';

export interface InteractionIdentity {
  readonly sessionId: string;
  readonly interactionId: string;
  readonly anchorSeq: number;
}

export interface CallIdentity {
  readonly kind: 'direct' | 'ptc';
  readonly eventSeq: number;
  readonly turn: number;
  readonly step: number;
  readonly callId: string;
  readonly rootCallId: string;
  readonly name: string;
  readonly argsHash: string;
}

function identityError(message: string): never {
  throw new HarnessError(message, 'RECALL_IDENTITY_UNVERIFIED');
}

/** Hash arguments for consistency checks, never as the identity of a call. */
export function argumentsHash(value: unknown): string {
  const canonical = (item: unknown): string => {
    if (Array.isArray(item)) return `[${item.map(canonical).join(',')}]`;
    if (item && typeof item === 'object') return `{${Object.keys(item).sort().map(key => `${JSON.stringify(key)}:${canonical((item as Record<string, unknown>)[key])}`).join(',')}}`;
    const encoded = JSON.stringify(item);
    if (encoded === undefined) return identityError('Tool arguments must be JSON');
    return encoded;
  };
  return createHash('sha256').update(canonical(value)).digest('hex');
}

/**
 * Fold native admitted messages, not inbox notifications or UI selection.
 * Rebuildable on reload; no subscription gap and no durable copy of content.
 * Only this session's own suffix can establish a new interaction.
 */
function foldIdentity(session: Session) {
  let current: InteractionIdentity | undefined;
  let turn = 0, step = 0, firstStep = 0;
  let choseHuman = false;
  const messages = new Map<string, InteractionIdentity>();
  const calls: { interaction: InteractionIdentity | undefined; call: CallIdentity }[] = [];
  const events = session.snapshotEvents(session.inheritedEventCount);
  for (const event of events) {
    if (event.type === 'turn/start') {
      turn = event.data.turn; step = 0; firstStep = 0; choseHuman = false;
    } else if (event.type === 'turn/end') {
      turn = 0; step = 0;
    } else if (event.type === 'step/start') {
      step = event.data.step;
      if (!firstStep) firstStep = step;
    } else if (event.type === 'user/message' && event.data.source.kind === 'user') {
      if (!turn || !step) identityError('User input has no admitted native step');
      const prior = messages.get(event.data.id);
      if (!choseHuman && step === firstStep) {
        // A repeated identified message is recovery, even in a technical new turn.
        current = prior ?? { sessionId: session.id, interactionId: event.data.id, anchorSeq: event.seq };
        choseHuman = true;
      } else if (!current) {
        current = prior ?? { sessionId: session.id, interactionId: event.data.id, anchorSeq: event.seq };
        choseHuman = true;
      } else if (prior && prior.interactionId !== current.interactionId) {
        identityError('Conflicting replayed input inside the current interaction');
      }
      messages.set(event.data.id, current);
    } else if (event.type === 'tool/call') {
      let args: unknown;
      try { args = event.data.arguments ? JSON.parse(event.data.arguments) : {}; }
      catch { args = event.data.arguments; }
      calls.push({ interaction: current, call: {
        kind: 'direct', eventSeq: event.seq, turn: event.data.turn, step: event.data.step,
        callId: event.data.callId, rootCallId: event.data.callId, name: event.data.name, argsHash: argumentsHash(args),
      } });
    } else if (event.type === 'tool/ptc-dispatch-start') {
      const roots = calls.filter(item => item.call.kind === 'direct' && item.call.callId === event.data.rootCallId);
      const root = roots.length === 1 ? roots[0] : undefined;
      if (!root) identityError('PTC root call is missing or ambiguous');
      calls.push({ interaction: root.interaction, call: {
        kind: 'ptc', eventSeq: event.seq, turn: root.call.turn, step: root.call.step,
        callId: event.data.subCallId, rootCallId: event.data.rootCallId,
        name: event.data.name, argsHash: argumentsHash(event.data.arguments),
      } });
    }
  }
  return { current, calls };
}

/** Diagnostic inspection only; does not allocate a record or a budget. */
export function currentInteraction(session: Session): InteractionIdentity | undefined {
  return foldIdentity(session).current;
}
/** A generated value is not delivery: require an accepted native result/log with intact recall JSON. */
export function successfulRecallContent(content: unknown): boolean {
  if (!Array.isArray(content) || content[0]?.type !== 'text') return false;
  try { const value = JSON.parse(content[0].text); return value.status === 'ok' && (value.scanComplete === true || typeof value.readComplete === 'boolean'); } catch { return false; }
}
/** Terminal native history exists even when a result was blocked, cancelled or replaced. */
export function nativeCallSettled(exec: ToolExecution, call: Pick<CallIdentity, 'kind' | 'eventSeq' | 'callId' | 'rootCallId'>): boolean {
  return exec.agent!.session.snapshotEvents().some(event => call.kind === 'direct'
    ? event.type === 'tool/result' && event.data.message.toolCallId === call.callId && event.sourceEventSeqs?.includes(call.eventSeq as any)
    : event.type === 'tool/ptc-dispatch' && event.data.subCallId === call.callId && event.data.rootCallId === call.rootCallId);
}
export function nativeCallDelivered(exec: ToolExecution, call: Pick<CallIdentity, 'kind' | 'eventSeq' | 'callId' | 'rootCallId'>): boolean {
  return exec.agent!.session.snapshotEvents().some(event => {
    const content = call.kind === 'direct'
      ? event.type === 'tool/result' && !event.data.message.isError && event.sourceEventSeqs?.includes(call.eventSeq as any) ? event.data.message.content : undefined
      : event.type === 'tool/ptc-dispatch' && !event.data.isError && event.data.subCallId === call.callId && event.data.rootCallId === call.rootCallId ? event.data.content : undefined;
    return successfulRecallContent(content);
  });
}

/** Only feedback available before this request can establish an uncorrected repeat. */
export function nativeInvalidFeedback(session: Session, previous: CallIdentity & { code?: string | undefined }, current: CallIdentity): boolean {
  if (!previous.code || previous.eventSeq >= current.eventSeq) return false;
  // Direct calls in one model step were decided together. Within one PTC root,
  // a later dispatch can instead be a decision made after reading SDK feedback.
  if (previous.turn === current.turn && previous.step === current.step
    && !(previous.kind === 'ptc' && current.kind === 'ptc' && previous.rootCallId === current.rootCallId)) return false;
  return session.snapshotEvents().some(event => {
    if (event.seq >= current.eventSeq) return false;
    const content = previous.kind === 'direct'
      ? event.type === 'tool/result' && !event.data.message.isError && event.data.message.toolCallId === previous.callId
        && event.sourceEventSeqs?.includes(previous.eventSeq as any) ? event.data.message.content : undefined
      : event.type === 'tool/ptc-dispatch' && !event.data.isError && event.data.subCallId === previous.callId
        && event.data.rootCallId === previous.rootCallId ? event.data.content : undefined;
    if (content?.[0]?.type !== 'text') return false;
    try {
      const value = JSON.parse(content[0].text);
      return value.status === 'error' && value.code === previous.code && typeof value.message === 'string' && value.message.length > 0
        && Array.isArray(value.items) && value.items.length === 0 && typeof value.budget?.revision === 'number'
        && (value.scanComplete === false || value.readComplete === false);
    } catch { return false; }
  });
}

/** Capture a unique native call event; ToolExecution itself has no turn/step. */
export function resolveCallIdentity(exec: ToolExecution, toolNames: ReadonlySet<string> = new Set([exec.name])): {
  interaction: InteractionIdentity; call: CallIdentity; hasSettledCalls: boolean; settled: boolean;
} {
  if (!exec.agent) return identityError('An executing agent is required');
  const { calls } = foldIdentity(exec.agent.session);
  const candidates = calls.filter(({ call }) => call.callId === exec.callId);
  if (candidates.length !== 1) return identityError('Native call event is missing or callId is ambiguous');
  const found = candidates[0]!;
  if (!found.interaction || found.call.name !== exec.name || found.call.rootCallId !== exec.rootCallId
    || found.call.kind !== (exec.parent ? 'ptc' : 'direct') || found.call.argsHash !== argumentsHash(exec.arguments)) {
    return identityError('Native input or call provenance does not match execution');
  }
  const settledSeqs = new Set<number>();
  const settledPtc = new Set<string>();
  const unadmittedSeqs = new Set<number>(), unadmittedPtc = new Set<string>();
  for (const event of exec.agent.session.snapshotEvents()) {
    if (event.type === 'tool/result') for (const seq of event.sourceEventSeqs ?? []) {
      settledSeqs.add(seq);
      if (event.data.message.isError && event.data.error?.name === 'RecallError' && event.data.error.code === 'timeout_policy_unavailable') unadmittedSeqs.add(seq);
    }
    else if (event.type === 'tool/ptc-dispatch') {
      const key = JSON.stringify([event.data.rootCallId, event.data.subCallId]); settledPtc.add(key);
      if (event.data.isError && event.data.error?.name === 'RecallError' && event.data.error.code === 'timeout_policy_unavailable') unadmittedPtc.add(key);
    }
  }
  const isSettled = (call: CallIdentity) => call.kind === 'direct' ? settledSeqs.has(call.eventSeq)
    : settledPtc.has(JSON.stringify([call.rootCallId, call.callId]));
  // Only the native error produced before admission proves no ledger should
  // exist. Unknown failures still require authoritative accounting; even this
  // rejected call remains settled and cannot itself be replayed.
  const unadmitted = (call: CallIdentity) => call.kind === 'direct' ? unadmittedSeqs.has(call.eventSeq)
    : unadmittedPtc.has(JSON.stringify([call.rootCallId, call.callId]));
  const hasSettledCalls = calls.some(item => toolNames.has(item.call.name)
    && item.interaction?.interactionId === found.interaction!.interactionId && isSettled(item.call) && !unadmitted(item.call));
  return { interaction: found.interaction, call: found.call, hasSettledCalls, settled: isSettled(found.call) };
}
