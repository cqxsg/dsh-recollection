import { Service, type Context } from '@deepseek-ai/cordis';
import type { Session, SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session';
import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import { blockAttachments, type AttachmentSource } from './attachments.js';
import { argumentsHash } from '../runtime/identity.js';
import { hashKey, type HashSource } from './hash-ledger.js';
import type { CanonicalRecord } from '../history/records.js';
import type {} from '../history/preparation.js';
import type {} from '../history/history.js';
import { RecallError } from '../protocol.js';

function sourceBinding(header: SessionHeader, seq: number, time: number, messageId: string, sourceKind: string, content: Readonly<ContentBlock>, source: AttachmentSource): HashSource {
  return { sessionId: header.id, seq, messageId, block: source.block, selector: source.selector,
    fingerprint: argumentsHash([header, seq, time, messageId, sourceKind, source.block, source.selector, content]),
    referenceText: source.original!, path: source.path!, ...(header.cwd ? { cwd: header.cwd } : {}), recordedAt: time };
}
export function nativeHashSources(header: SessionHeader, event: SessionEvent): HashSource[] {
  if (event.surfaceOp !== 'append') return [];
  if (event.type === 'user/message' && event.data.source.kind === 'user') {
    return event.data.content.flatMap((block, index) => blockAttachments(block, index, 'user', 'message')
      .filter(a => a.type === 'path').map(a => sourceBinding(header, event.seq, event.time, event.data.id, event.data.source.kind, block, a)));
  }
  if (event.type === 'assistant/message') {
    return event.data.message.content.flatMap((block, index) => blockAttachments(block, index, 'assistant', 'tool_call')
      .filter(a => a.type === 'path').map(a => sourceBinding(header, event.seq, event.time, event.data.message.id, event.data.message.source.kind, block, a)));
  }
  return [];
}
export function recordHashSource(header: SessionHeader, record: CanonicalRecord, source: AttachmentSource): HashSource {
  return sourceBinding(header, record.origin.seq, record.origin.time, record.origin.messageId, record.origin.sourceKind,
    record.blocks.find(b => b.index === source.block)!.content, source);
}
declare module '@deepseek-ai/cordis' { interface Context { recallAttachments: RecallAttachmentService; } }

/** Listens only to new post-commit native events. Cold reads never create baselines. */
export class RecallAttachmentService extends Service {
  static inject = ['recallHashes', 'recallPreparation', 'recallHistory', 'sessions'];
  private readonly seen = new WeakMap<Session, number>();
  private readonly pending = new Set<Promise<unknown>>();
  private readonly jobs = new Map<string, () => void>();
  private readonly lifetime = new AbortController();
  private readonly errors = new Map<string, string>();
  private droppedErrors = 0;
  private failure(key: string, error: unknown, fallback: string) {
    this.errors.delete(key); this.errors.set(key, String((error as { code?: string })?.code ?? fallback).slice(0, 256));
    if (this.errors.size > 128) { this.errors.delete(this.errors.keys().next().value!); this.droppedErrors++; }
  }
  constructor(ctx: Context) {
    super(ctx, 'recallAttachments');
    for (const session of ctx.sessions.list()) this.seen.set(session, session.seq - 1);
    ctx.on('session/created', session => this.seen.set(session, Math.max(this.seen.get(session) ?? -1, session.seq - 1)));
    ctx.on('session/event', (session, event) => {
      const previous = this.seen.get(session) ?? event.seq - 1;
      if (event.seq <= previous || event.seq < session.inheritedEventCount || this.lifetime.signal.aborted) return;
      this.seen.set(session, event.seq);
      const sources = nativeHashSources(session.header, event);
      if (!sources.length) return;
      const work = Promise.resolve().then(async () => {
        this.lifetime.signal.throwIfAborted();
        if (!await ctx.sessions.flush(session)) throw new RecallError('hash_source_not_saved', 'Reference event could not be durably recorded.');
        for (const source of sources) {
          this.lifetime.signal.throwIfAborted();
          const key = await ctx.recallHashes.register(source); this.schedule(key);
        }
      }).catch(error => {
        if (!this.lifetime.signal.aborted) for (const source of sources) this.failure(hashKey(source), error, 'hash_registration_failed');
      });
      this.pending.add(work); void work.finally(() => this.pending.delete(work));
    });
    ctx.effect(() => async () => {
      this.lifetime.abort(new RecallError('recall_unloaded', 'Attachment admission unloaded.'));
      for (const cancel of this.jobs.values()) cancel(); this.jobs.clear();
      await Promise.allSettled(this.pending);
      this.errors.clear();
    });
    for (const row of ctx.recallHashes.records()) if (row.state === 'pending' || row.state === 'sampling') this.schedule(hashKey(row.source));
  }
  async idleAdmissions(): Promise<void> { await Promise.allSettled(this.pending); }
  status() { return { queued: [...this.jobs.keys()], errors: Object.fromEntries(this.errors), droppedErrors: this.droppedErrors }; }
  private schedule(key: string): void {
    if (this.jobs.has(key) || this.lifetime.signal.aborted) return;
    const row = this.ctx.recallHashes.get(key);
    if (!row || row.state === 'saved' || row.state === 'failed') return;
    let verified = false;
    const cancel = this.ctx.recallPreparation.scheduleHash(key, row.source.sessionId as SessionId, async schedulerSignal => {
      const signal = AbortSignal.any([schedulerSignal, this.lifetime.signal]);
      if (!verified) {
        try {
          const matches = await this.ctx.recallHistory.withSnapshot(row.source.sessionId as SessionId, (snapshot, scope) => {
            scope.throwIfAborted(); const event = snapshot.events[row.source.seq];
            return event && event.seq >= snapshot.inheritedEventCount && nativeHashSources(snapshot.header, event).some(source => argumentsHash(source) === argumentsHash(row.source));
          }, signal, { waitForQuiescence: true });
          if (!matches) throw new RecallError('hash_source_changed', 'Registered native reference no longer matches.');
          verified = true;
        } catch (error) {
          signal.throwIfAborted();
          await this.ctx.recallHashes.fail(key, 'source_unverifiable'); this.jobs.delete(key); return true;
        }
      }
      const pending = this.ctx.recallHashes.step(key, signal); this.pending.add(pending);
      let result;
      try { result = await pending; } finally { this.pending.delete(pending); }
      const done = result.state === 'saved' || result.state === 'failed';
      if (done) this.jobs.delete(key);
      return done;
    }, error => { this.jobs.delete(key); this.failure(key, error, 'hash_task_failed'); });
    this.jobs.set(key, cancel);
  }
}
