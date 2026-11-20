import { createHash } from 'node:crypto';
import { HarnessError } from '@deepseek-ai/dsh-llm';
import type { Session } from '@deepseek-ai/dsh-session';
import type { ToolExecution } from '@deepseek-ai/dsh-tools';
import { indexExecutions } from './executions.js';

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

const missingCall = 'Native call event is missing or callId is ambiguous';
const mismatchedCall = 'Native input or call provenance does not match execution';
const admissionIdentityErrors = new Set([missingCall, mismatchedCall, 'PTC root call is missing or ambiguous'].map(message => `Error: ${message}`));
export const missingPriorBudget = 'Prior native recall calls have no authoritative budget for this interaction.';

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
  const executions = indexExecutions(events);
  const direct = new Map<number, typeof calls[number]>();
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
      const item: typeof calls[number] = { interaction: current, call: {
        kind: 'direct', eventSeq: event.seq, turn: event.data.turn, step: event.data.step,
        callId: event.data.callId, rootCallId: event.data.callId, name: event.data.name, argsHash: argumentsHash(args),
      } };
      calls.push(item); direct.set(event.seq, item);
    } else if (event.type === 'tool/ptc-dispatch-start') {
      const rootSeq = executions.rootByDispatch.get(event.seq);
      const root = rootSeq === undefined ? undefined : direct.get(rootSeq);
      calls.push({ interaction: root?.interaction, call: {
        kind: 'ptc', eventSeq: event.seq, turn: root?.call.turn ?? turn, step: root?.call.step ?? step,
        callId: event.data.subCallId, rootCallId: event.data.rootCallId,
        name: event.data.name, argsHash: argumentsHash(event.data.arguments),
      } });
    }
  }
  return { current, calls, ...executions };
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
  return indexExecutions(exec.agent!.session.snapshotEvents()).results.has(call.eventSeq);
}
export function nativeCallDelivered(exec: ToolExecution, call: Pick<CallIdentity, 'kind' | 'eventSeq' | 'callId' | 'rootCallId'>): boolean {
  const event = indexExecutions(exec.agent!.session.snapshotEvents()).results.get(call.eventSeq);
  const message = event?.type === 'tool/result' ? event.data.message : event?.data;
  return !message?.isError && successfulRecallContent(message?.content);
}

/** Only feedback available before this request can establish an uncorrected repeat. */
export function nativeInvalidFeedback(session: Session, previous: CallIdentity & { code?: string | undefined }, current: CallIdentity): boolean {
  if (!previous.code || previous.eventSeq >= current.eventSeq) return false;
  // Direct calls in one model step were decided together. Within one PTC root,
  // a later dispatch can instead be a decision made after reading SDK feedback.
  const { results, rootByDispatch } = indexExecutions(session.snapshotEvents());
  const previousRoot = rootByDispatch.get(previous.eventSeq);
  if (previous.turn === current.turn && previous.step === current.step
    && !(previousRoot !== undefined && previousRoot === rootByDispatch.get(current.eventSeq))) return false;
  const event = results.get(previous.eventSeq);
  if (!event || event.seq >= current.eventSeq) return false;
  const message = event.type === 'tool/result' ? event.data.message : event.data;
  const content = message.isError ? undefined : message.content;
  if (content?.[0]?.type !== 'text') return false;
  try {
    const value = JSON.parse(content[0].text);
    return value.status === 'error' && value.code === previous.code && typeof value.message === 'string' && value.message.length > 0
      && Array.isArray(value.items) && value.items.length === 0 && typeof value.budget?.revision === 'number'
      && (value.scanComplete === false || value.readComplete === false);
  } catch { return false; }
}

/** Capture a unique native call event; ToolExecution itself has no turn/step. */
export function resolveCallIdentity(exec: ToolExecution, toolNames: ReadonlySet<string> = new Set([exec.name])): {
  interaction: InteractionIdentity; call: CallIdentity; hasSettledCalls: boolean; settled: boolean;
} {
  if (!exec.agent) return identityError('An executing agent is required');
  const { calls, results } = foldIdentity(exec.agent.session);
  const candidates = calls.filter(({ call }) => call.callId === exec.callId);
  if (candidates.length !== 1) return identityError(missingCall);
  const found = candidates[0]!;
  if (!found.interaction || found.call.name !== exec.name || found.call.rootCallId !== exec.rootCallId
    || found.call.kind !== (exec.parent ? 'ptc' : 'direct') || found.call.argsHash !== argumentsHash(exec.arguments)) {
    return identityError(mismatchedCall);
  }
  // Only the native error produced before admission proves no ledger should
  // exist. Unknown failures still require authoritative accounting; even this
  // rejected call remains settled and cannot itself be replayed.
  const hasSettledCalls = calls.some(({ interaction, call }) => {
    if (interaction?.interactionId !== found.interaction!.interactionId || !toolNames.has(call.name)) return false;
    const event = results.get(call.eventSeq);
    if (!event) return false;
    const { error } = event.data;
    const message = event.type === 'tool/result' ? event.data.message : event.data;
    if (!message.isError || !error) return true;
    const [body] = message.content;
    const text = message.content.length === 1 && body?.type === 'text' ? body.text : '';
    if (error.name === 'HarnessError' && error.code === 'RECALL_IDENTITY_UNVERIFIED') return !admissionIdentityErrors.has(text);
    // A retry blocked at the missing-ledger check also made no reservation. Any
    // original charge is still independently checked against its own native result.
    return !(error.name === 'RecallError' && (error.code === 'timeout_policy_unavailable' || error.code === 'provenance_write_failed'
      || (error.code === 'ledger_missing' && text === `Error: ${missingPriorBudget}`)));
  });
  return { interaction: found.interaction, call: found.call, hasSettledCalls, settled: results.has(found.call.eventSeq) };
}
