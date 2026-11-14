import { performance } from 'node:perf_hooks';
import { RecallError } from '../protocol.js';
import type { RecallConfig } from './config.js';
import type { OperationTicket } from './scheduler.js';

/** One monotonic timeline per real invocation, including queue/write/retry time. */
export class CallTimeline {
  readonly started: number;
  readonly signal: AbortSignal;
  private readonly stop = new AbortController();
  private readonly timer: ReturnType<typeof setTimeout>;
  private retries = 0;
  operation: OperationTicket | undefined;
  constructor(readonly config: RecallConfig, upstream: AbortSignal, private readonly now = () => performance.now()) {
    this.started = now();
    this.signal = AbortSignal.any([upstream, this.stop.signal]);
    this.timer = setTimeout(() => this.stop.abort(new RecallError('business_deadline', 'Recall business deadline reached; no further work is started.')), config.businessMs);
  }
  elapsed() { return this.now() - this.started; }
  check() {
    if (this.elapsed() >= this.config.businessMs && !this.stop.signal.aborted) this.stop.abort(new RecallError('business_deadline', 'Recall business deadline reached; no further work is started.'));
    this.signal.throwIfAborted();
  }
  async prepare<T>(wait: (signal: AbortSignal) => Promise<T>): Promise<T> {
    this.check();
    const stop = new AbortController();
    const timer = setTimeout(() => stop.abort(new RecallError('preparation_timeout', 'History preparation wait exceeded its allowance.', false, 'Shared history preparation continues independently of this wait.')), Math.min(this.config.prepareMs, this.config.businessMs - this.elapsed()));
    try { const value = await wait(AbortSignal.any([this.signal, stop.signal])); this.check(); return value; }
    finally { clearTimeout(timer); }
  }
  async retry<T>(run: () => Promise<T>): Promise<T> {
    this.check();
    try { const result = await run(); this.check(); return result; }
    catch (error) {
      this.check();
      // Only known pre-action resource failures. Unknown/EIO/missing/corrupt errors are not transient.
      let cause: any = error, transient = false;
      for (let depth = 0; cause && depth < 8; depth++, cause = cause.cause) if (['EAGAIN', 'EBUSY', 'EMFILE', 'ENFILE'].includes(cause.code)) transient = true;
      if (this.retries || !transient) throw error;
      this.retries++;
      await new Promise<void>(resolve => setImmediate(resolve));
      this.check();
      const result = await run(); this.check(); return result;
    }
  }
  dispose() { clearTimeout(this.timer); this.operation = undefined; }
}
