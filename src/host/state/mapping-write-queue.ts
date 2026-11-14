interface WaitingWrite {
  run(): Promise<void>;
  detach(): void;
}

/** Ref/cursor creation stays serial; cancellation removes only work not yet started. */
export class MappingWriteQueue {
  private readonly waiting = new Set<WaitingWrite>();
  private active: Promise<void> | undefined;
  private running = false;

  get size(): number { return this.waiting.size + Number(this.running); }

  run<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
    if (signal.aborted) return Promise.reject(signal.reason);
    let resolve!: (value: T) => void, reject!: (error: unknown) => void;
    const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
    const cancel = () => {
      if (!this.waiting.delete(entry)) return;
      entry.detach(); reject(signal.reason);
    };
    const entry: WaitingWrite = {
      detach: () => signal.removeEventListener('abort', cancel),
      run: async () => {
        try { signal.throwIfAborted(); resolve(await operation()); }
        catch (error) { reject(error); }
      },
    };
    this.waiting.add(entry);
    signal.addEventListener('abort', cancel, { once: true });
    this.active ??= Promise.resolve().then(async () => {
      try {
        for (const next of this.waiting) {
          this.waiting.delete(next); next.detach(); this.running = true;
          // Once started, the service owns the operation until real I/O settles.
          try { await next.run(); } finally { this.running = false; }
        }
      } finally { this.active = undefined; }
    });
    return promise;
  }

  async drain(): Promise<void> { await this.active; }
}
