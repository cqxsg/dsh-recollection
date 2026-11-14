import { Service, type Context } from '@deepseek-ai/cordis';
import { HarnessError } from '@deepseek-ai/dsh-llm';
import { defineDomain, domainTable, type KvTable } from '@deepseek-ai/dsh-storage-domain';
import type { ToolExecution } from '@deepseek-ai/dsh-tools';
import { z } from 'zod';
import { resolveCallIdentity, type InteractionIdentity, type CallIdentity } from '../runtime/identity.js';

const integer = z.number().int().nonnegative();
const callSchema = z.strictObject({
  kind: z.enum(['direct', 'ptc']), eventSeq: integer, turn: integer, step: integer,
  callId: z.string().min(1), rootCallId: z.string().min(1), name: z.string().min(1), argsHash: z.string().regex(/^[a-f0-9]{64}$/),
  state: z.enum(['reserved', 'completed', 'failed']), completionCode: z.string().optional(),
});
export const diagnosticLedgerRecord = z.strictObject({
  version: z.literal(1), sessionId: z.string().min(1), interactionId: z.string().min(1), anchorSeq: integer,
  revision: z.number().int().positive(), calls: z.array(callSchema).min(1),
}).superRefine((record, ctx) => {
  if (new Set(record.calls.map(call => call.eventSeq)).size !== record.calls.length) ctx.addIssue({ code: 'custom', message: 'Duplicate native call events' });
  if (record.calls.some(call => (call.state === 'reserved') !== (call.completionCode === undefined))) ctx.addIssue({ code: 'custom', message: 'Inconsistent completion metadata' });
});
export type DiagnosticLedgerRecord = z.infer<typeof diagnosticLedgerRecord>;
export const diagnosticLedgerSpec = defineDomain({
  name: 'dsh_recall_diagnostics', version: 1,
  // Authoritative records must fail on incompatible versions, not be discarded
  // as disposable per-record cache documents by the native JSON backend.
  layout: 'single', tables: { interactions: domainTable<string, DiagnosticLedgerRecord>(diagnosticLedgerRecord) },
});
export const interactionKey = (identity: InteractionIdentity): string => JSON.stringify([identity.sessionId, identity.interactionId]);

declare module '@deepseek-ai/cordis' {
  interface Context { recallLedger: RecallCallLedger; }
}

/** Minimal write-before-action integration. No S/R/F balances or result cache. */
export class RecallCallLedger extends Service {
  static inject = ['storageDomain', 'sessions'];
  private table!: KvTable<string, DiagnosticLedgerRecord>;
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly active = new Set<Promise<unknown>>();
  private readonly lifetime = new AbortController();

  constructor(ctx: Context) { super(ctx, 'recallLedger'); }

  async [Service.init]() {
    const domain = await this.ctx.storageDomain.open(diagnosticLedgerSpec);
    this.table = domain.table('interactions');
    try {
      this.ctx.effect(() => async () => {
        this.lifetime.abort(new HarnessError('Recall ledger unloaded', 'ABORTED'));
        await Promise.allSettled(this.active);
        await domain.close();
      });
    } catch (error) {
      // Opening can finish after this consumer's scope has started unloading.
      await domain.close();
      throw error;
    }
    // Zod validates shape on native open; also validate the opaque table key.
    for (const [key, value] of this.table.entries()) {
      if (key !== interactionKey(value)) throw new HarnessError('Recall ledger key does not match its identity', 'RECALL_LEDGER_INVALID');
    }
  }

  /** Detached metadata for Host diagnostics; never exposed as a Remote. */
  records(): DiagnosticLedgerRecord[] { return structuredClone([...this.table.entries()].map(([, value]) => value)); }

  run<T>(exec: ToolExecution, callerSignal: AbortSignal, action: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const signal = AbortSignal.any([callerSignal, this.lifetime.signal]);
    const task = Promise.resolve().then(() => this.execute(exec, signal, action));
    this.active.add(task);
    return task.finally(() => this.active.delete(task));
  }

  private async execute<T>(exec: ToolExecution, signal: AbortSignal, action: (signal: AbortSignal) => Promise<T>): Promise<T> {
    signal.throwIfAborted();
    const { interaction, call, hasSettledCalls, settled } = resolveCallIdentity(exec);
    // The separate native log must contain the provenance before the ledger
    // commits it. This is ordered durability, not a cross-store transaction.
    try {
      if (!await this.ctx.sessions.flush(exec.agent!.session)) throw new Error('Native session persistence is not mounted');
    }
    catch (cause) { throw new HarnessError('Native call provenance could not be saved', 'RECALL_PROVENANCE_WRITE_FAILED', { cause }); }
    const key = interactionKey(interaction);
    await this.serial(key, async () => {
      signal.throwIfAborted();
      const existing = this.table.get(key);
      if (!existing) {
        if (hasSettledCalls) throw new HarnessError('Settled native calls exist but their ledger cannot be verified', 'RECALL_LEDGER_MISSING');
        await this.write(() => this.table.put(key, diagnosticLedgerRecord.parse({ ...interaction, version: 1, revision: 1, calls: [{ ...call, state: 'reserved' }] })));
      } else {
        await this.write(() => this.table.update(key, current => {
          signal.throwIfAborted();
          if (current.anchorSeq !== interaction.anchorSeq) throw new HarnessError('Interaction anchor changed', 'RECALL_LEDGER_INVALID');
          const previous = current.calls.find(item => item.eventSeq === call.eventSeq);
          if (previous) {
            const same = Object.entries(call).every(([field, value]) => previous[field as keyof CallIdentity] === value);
            if (!same) throw new HarnessError('Stored call identity changed', 'RECALL_LEDGER_INVALID');
            // No cached output in this diagnostic: an uncertain or completed
            // call is never automatically authorized a second time.
            throw new HarnessError(`Call already ${previous.state}; reservation retained`, 'RECALL_CALL_REPLAY');
          }
          if (settled) throw new HarnessError('Settled native call has no reservation', 'RECALL_LEDGER_MISSING');
          return diagnosticLedgerRecord.parse({ ...current, revision: current.revision + 1, calls: [...current.calls, { ...call, state: 'reserved' }] });
        }));
      }
    });
    // Cancellation cannot abandon a pending native write. A committed but
    // unstarted call remains reserved, including on abrupt process death.
    signal.throwIfAborted();
    let value: T;
    try { value = await action(signal); }
    catch (error) {
      await this.complete(key, call, 'failed', error instanceof HarnessError ? error.code : signal.aborted ? 'ABORTED' : 'ERROR');
      throw error;
    }
    await this.complete(key, call, 'completed', 'OK');
    return value;
  }

  private async complete(key: string, call: CallIdentity, state: 'completed' | 'failed', completionCode: string) {
    await this.serial(key, () => this.write(() => this.table.update(key, current => {
      if (!current.calls.some(item => item.eventSeq === call.eventSeq && item.state === 'reserved')) {
        throw new HarnessError('Completion has no matching reservation', 'RECALL_LEDGER_INVALID');
      }
      return diagnosticLedgerRecord.parse({
        ...current, revision: current.revision + 1,
        calls: current.calls.map(item => item.eventSeq === call.eventSeq ? { ...item, state, completionCode } : item),
      });
    })));
  }

  private async write<T>(operation: () => Promise<T>): Promise<T> {
    try { return await operation(); }
    catch (cause) {
      if (cause instanceof HarnessError || this.lifetime.signal.aborted) throw cause;
      throw new HarnessError('Recall reservation/completion could not be saved', 'RECALL_LEDGER_WRITE_FAILED', { cause });
    }
  }

  /** Serialize first creation as well as updates; native update has no upsert. */
  private serial<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const task = (this.queues.get(key) ?? Promise.resolve()).then(operation);
    const tail = task.then(() => undefined, () => undefined);
    this.queues.set(key, tail);
    void tail.then(() => { if (this.queues.get(key) === tail) this.queues.delete(key); });
    return task;
  }
}
