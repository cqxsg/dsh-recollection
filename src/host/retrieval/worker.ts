import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { readFile, realpath, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { RecallError, type SearchTerms } from '../protocol.js';
import type { CallTimeline } from '../runtime/deadline.js';
import { performanceDiagnostics, type PerformanceSpan } from '../runtime/performance.js';

export const WORKER_LIMITS = Object.freeze({ header: 65536, input: 64 * 1024 * 1024, output: 8 * 1024 * 1024, spans: 65536, cache: 4, allocation: 128 * 1024 * 1024 });
export const POOL_LIMITS = Object.freeze({ workers: 2, queued: 32, queuedBytes: 64 * 1024 * 1024 });
export interface MatchUnit { purpose: 'validation' | 'match' | 'invalid-diagnosis'; recordId?: string; field?: string; }
export interface WorkerManifest { protocol: number; source: string; build: string; sha256: string; target: string; ripgrep: string; executable: string; }
type Range = { start: number; end: number };
const digest = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
export const scalarSafe = (text: string) => !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(text);
const nonnegative = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
function normalize(terms: SearchTerms) {
  const nul = terms.patterns.some(p => p.includes('\0'));
  if (terms.patterns.some(p => !scalarSafe(p))) throw new RecallError('invalid_pattern', 'Patterns must contain valid Unicode scalar values.', true);
  // NUL-containing literals use escaped regex transport but retain literal case sensitivity.
  return { fixed: terms.mode === 'literal' && !nul, case_sensitive: terms.mode === 'literal' && terms.case_sensitive, patterns: terms.patterns.map(p => {
    if (nul && terms.mode === 'literal') return p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\0/g, '\\x00');
    for (let at = p.indexOf('\0'); at >= 0; at = p.indexOf('\0', at + 1)) {
      let slashes = 0; for (let i = at - 1; i >= 0 && p[i] === '\\'; i--) slashes++;
      if (slashes % 2) throw new RecallError('invalid_pattern', 'A NUL following an unmatched regex escape is invalid.', true);
    }
    return p.replace(/\0/g, '\\x00');
  }) };
}

/** The override changes location only. Identity always comes from this package. */
export async function verifiedWorker(requested?: string): Promise<WorkerManifest> {
  try {
    const manifest: WorkerManifest = JSON.parse(await readFile(new URL('./native/manifest.json', import.meta.url), 'utf8'));
    if (process.platform !== 'win32' || process.arch !== 'x64' || manifest.protocol !== 1 || manifest.target !== 'x86_64-pc-windows-gnu'
      || manifest.ripgrep !== '15.2.0' || manifest.source !== 'e89fff89ac9af12e8d4ce9d5fd07beb408ca730f'
      || !/^[a-f0-9]{64}$/.test(manifest.build) || !/^[a-f0-9]{64}$/.test(manifest.sha256)) throw new RecallError('worker_version_mismatch', 'This package requires its verified Windows x64 worker and protocol 1 manifest.');
    manifest.executable = await realpath(requested ?? fileURLToPath(new URL('./native/worker.exe', import.meta.url)));
    if (digest(await readFile(manifest.executable)) !== manifest.sha256) throw new RecallError('worker_version_mismatch', 'Worker binary hash differs from the packaged manifest.');
    return Object.freeze(manifest);
  } catch (error) {
    if (error instanceof RecallError) throw error;
    throw new RecallError('worker_unavailable', 'Packaged recall worker/manifest is missing or unreadable.');
  }
}

interface Pending { request: Record<string, unknown>; bytes: Buffer; trace: PerformanceSpan | undefined; resolve(ranges: Range[]): void; reject(error: unknown): void; }
/** One framed, complete input at a time. No output is accepted before completion. */
class WorkerChannel {
  readonly child: ChildProcessWithoutNullStreams;
  readonly ready: Promise<void>;
  readonly closed: Promise<void>;
  private readyResolve!: () => void;
  private readyReject!: (error: unknown) => void;
  private pending: Pending | undefined;
  private handshake = false;
  private next = 0;
  failure: unknown;
  ended = false;
  busy = false;
  constructor(readonly manifest: WorkerManifest, launch: typeof spawn, children: Set<number>) {
    const trace = performanceDiagnostics()?.begin('matcher.process', {});
    this.ready = new Promise((resolve, reject) => { this.readyResolve = resolve; this.readyReject = reject; });
    void this.ready.catch(() => {});
    try { this.child = launch(manifest.executable, ['--parent-pid', String(process.pid)], { windowsHide: true, shell: false, stdio: 'pipe' }) as ChildProcessWithoutNullStreams; }
    catch (error) { trace?.end('failed'); throw error; }
    trace?.field('pid', this.child.pid ?? null);
    this.child.once('spawn', () => trace?.mark('spawnEventMs'));
    void this.ready.then(() => { trace?.mark('readyMs'); trace?.end(); }, () => trace?.end('failed'));
    if (this.child.pid) children.add(this.child.pid);
    const header = Buffer.alloc(4); let headerAt = 0, body: Buffer | undefined, bodyAt = 0, stderr = '';
    this.child.stdout.on('data', (chunk: Buffer) => {
      const start = performance.now(), activeTrace = this.pending?.trace;
      activeTrace?.count('stdoutBytes', chunk.length);
      try {
        for (let at = 0; at < chunk.length;) {
          if (!body) {
            const n = Math.min(4 - headerAt, chunk.length - at); chunk.copy(header, headerAt, at, at + n); at += n; headerAt += n;
            if (headerAt < 4) continue;
            const length = header.readUInt32BE();
            if (!length || length > WORKER_LIMITS.output) throw new RecallError('worker_output_invalid', 'Worker frame exceeds the output bound.');
            body = Buffer.alloc(length); bodyAt = 0;
          }
          const n = Math.min(body.length - bodyAt, chunk.length - at); chunk.copy(body, bodyAt, at, at + n); at += n; bodyAt += n;
          if (bodyAt === body.length) {
            const message = JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(body));
            body = undefined; headerAt = 0; this.receive(message);
          }
        }
      } catch (error) { this.fail(error instanceof RecallError ? error : new RecallError('worker_output_invalid', 'Malformed worker response.')); }
      finally { activeTrace?.count('hostDecodeParseValidateMs', performance.now() - start); }
    });
    this.child.stderr.on('data', (data: Buffer) => { stderr = (stderr + data.toString()).slice(0, 4096); });
    this.child.stdin.on('error', (error: NodeJS.ErrnoException) => { if (error.code !== 'EPIPE') this.fail(error); });
    this.child.on('error', error => { this.failure ??= error; });
    this.closed = new Promise(resolve => this.child.once('close', (code, signal) => {
      this.ended = true;
      this.failure ??= new RecallError(code === 70 ? 'worker_resource_limit' : 'worker_failed', stderr || `Worker closed (${code ?? signal}); the incomplete unit was discarded.`);
      this.readyReject(this.failure); this.pending?.reject(this.failure); this.pending = undefined;
      if (this.child.pid) children.delete(this.child.pid);
      body = undefined;
      this.child.stdin.destroy(); this.child.stdout.destroy(); this.child.stderr.destroy(); resolve();
    }));
  }
  fail(error: unknown) { this.failure ??= error; if (!this.ended) this.child.kill('SIGKILL'); }
  private receive(message: any) {
    if (this.failure) return;
    if (!this.handshake) {
      if (message.kind !== 'ready' || message.protocol !== 1 || message.build !== this.manifest.build
        || message.source !== this.manifest.source || message.rg !== '15.2.0' || message.pid !== this.child.pid
        || Object.entries(WORKER_LIMITS).some(([key, value]) => message.limits?.[key] !== value)) throw new RecallError('worker_version_mismatch', 'Worker handshake differs from the verified package.');
      this.handshake = true; this.readyResolve(); return;
    }
    const pending = this.pending;
    if (!pending) throw new RecallError('worker_output_invalid', 'Unsolicited or duplicate worker frame.');
    const { request, bytes, trace } = pending;
    for (const key of ['protocol', 'request', 'query', 'unit', 'field', 'input_bytes', 'input_sha256']) {
      if (message[key] !== request[key]) throw new RecallError('worker_output_invalid', `Worker ${key} does not identify the submitted complete unit.`);
    }
    if (message.complete === false) {
      if (!['invalid_pattern', 'worker_resource_limit', 'worker_failed'].includes(message.code) || typeof message.message !== 'string') throw new RecallError('worker_output_invalid', 'Unknown worker failure.');
      this.pending = undefined; pending.reject(new RecallError(message.code, message.message, message.code === 'invalid_pattern')); return;
    }
    if (message.complete !== true || message.searches !== 1 || message.bytes_searched !== bytes.length
      || !Array.isArray(message.spans) || message.spans.length > WORKER_LIMITS.spans || !Number.isSafeInteger(message.matches) || message.matches < 0
      || Boolean(message.matches) !== Boolean(message.spans.length) || ![0, 1].includes(message.begin) || message.end !== message.begin || message.searches_with_match !== message.begin
      || typeof message.compiled !== 'boolean' || !Number.isSafeInteger(message.cache_entries) || message.cache_entries < 0 || message.cache_entries > WORKER_LIMITS.cache
      || !Number.isSafeInteger(message.peak_allocated_bytes) || message.peak_allocated_bytes < 0 || message.peak_allocated_bytes > WORKER_LIMITS.allocation
      || !['compile_ms', 'scan_and_encode_ms', 'input_ms'].every(key => nonnegative(message[key]))) throw new RecallError('worker_output_invalid', 'Worker did not confirm a bounded complete scan.');
    let previous = 0;
    for (const span of message.spans) {
      if (!Number.isSafeInteger(span.start) || !Number.isSafeInteger(span.end) || span.start < previous || span.end < span.start
        || span.end > bytes.length || span.sha256 !== digest(bytes.subarray(span.start, span.end))) throw new RecallError('worker_output_invalid', 'Worker range does not map to original input bytes.');
      previous = span.end;
    }
    trace?.count('compiles', Number(message.compiled)); trace?.count('compileMs', message.compile_ms);
    trace?.count('scanAndEncodeMs', message.scan_and_encode_ms); trace?.count('workerInputMs', message.input_ms);
    this.pending = undefined; pending.resolve(message.spans.map(({ start, end }: Range) => ({ start, end })));
  }
  async request(text: string, terms: SearchTerms, timeline: CallTimeline, unit: MatchUnit, trace: PerformanceSpan | undefined) {
    timeline.check(); const abort = () => this.fail(timeline.signal.reason);
    timeline.signal.addEventListener('abort', abort, { once: true });
    try {
      if (timeline.signal.aborted) abort();
      await this.ready; timeline.check(); trace?.mark('readyMs');
      if (this.failure || this.ended) throw this.failure;
      if (this.pending) throw new Error('A worker accepts one complete unit at a time.');
      const condition = normalize(terms), bytes = Buffer.from(text);
      const request = { protocol: 1, request: ++this.next, query: digest(JSON.stringify(condition)), unit: unit.recordId ?? unit.purpose,
        field: unit.field ?? '', ...condition, input_bytes: bytes.length, input_sha256: digest(bytes) };
      const header = Buffer.from(JSON.stringify(request));
      if (header.length > WORKER_LIMITS.header) throw new RecallError('worker_resource_limit', 'Pattern/identity frame exceeds the header limit.');
      const length = Buffer.alloc(4); length.writeUInt32BE(header.length);
      const result = new Promise<Range[]>((resolve, reject) => { this.pending = { request, bytes, trace, resolve, reject }; });
      this.child.stdin.write(length); this.child.stdin.write(header); this.child.stdin.write(bytes); trace?.mark('inputQueuedMs');
      const ranges = await result; timeline.check();
      if (this.failure) { await this.closed; throw this.failure; }
      return ranges;
    } catch (error) {
      if (timeline.signal.aborted) { abort(); await this.closed; timeline.check(); }
      if (this.failure) await this.closed;
      throw error;
    } finally { timeline.signal.removeEventListener('abort', abort); }
  }
  async dispose() { this.fail(new RecallError('worker_failed', 'Matcher disposed.')); await this.closed; }
}

interface Queued { text: string; terms: SearchTerms; timeline: CallTimeline; unit: MatchUnit; bytes: number; order: number; trace: PerformanceSpan | undefined; detach(): void; resolve(ranges: Range[]): void; reject(error: unknown): void; }
/** One pool per Host. Pending requests retain strings, never encoded buffers. */
export class MatchingPool {
  private readonly channels = new Set<WorkerChannel>();
  private readonly queue: Queued[] = [];
  private readonly owners = new WeakMap<CallTimeline, number>();
  private order = 0;
  private queuedBytes = 0;
  private scheduled: ReturnType<typeof setImmediate> | undefined;
  private running: Promise<void> | undefined;
  private disposed = false;
  private stamp: string | undefined;
  private launches = 0;
  private previous: WeakRef<CallTimeline> | undefined;
  constructor(private readonly manifest: WorkerManifest, private readonly launch: typeof spawn, private readonly children: Set<number>,
    private readonly background: <T>(operation: () => T) => T = operation => operation()) {}
  stats() { return { live: this.channels.size, active: [...this.channels].filter(c => c.busy).length, queued: this.queue.length, queuedBytes: this.queuedBytes, launches: this.launches }; }
  run(text: string, terms: SearchTerms, timeline: CallTimeline, unit: MatchUnit): Promise<Range[]> {
    timeline.check();
    if (this.disposed) return Promise.reject(new RecallError('worker_failed', 'Matcher disposed.'));
    const bytes = Buffer.byteLength(text);
    if (bytes > WORKER_LIMITS.input || this.queue.length >= POOL_LIMITS.queued || this.queuedBytes + bytes > POOL_LIMITS.queuedBytes) return Promise.reject(new RecallError('worker_resource_limit', 'Matching input/queue capacity is exhausted; no partial unit was accepted.'));
    const trace = performanceDiagnostics()?.begin('matcher.unit', { ...unit, callStartedMs: timeline.started, mode: terms.mode, patternCount: terms.patterns.length });
    trace?.count('inputBytes', bytes);
    let order = this.owners.get(timeline); if (order === undefined) { order = ++this.order; this.owners.set(timeline, order); }
    return new Promise<Range[]>((resolve, reject) => {
      const cancel = () => { const at = this.queue.indexOf(entry); if (at < 0) return; this.remove(at); trace?.end('cancelled'); reject(timeline.signal.reason); this.wake(); };
      const entry: Queued = { text, terms, timeline, unit, bytes, order, trace, resolve, reject, detach: () => timeline.signal.removeEventListener('abort', cancel) };
      this.queue.push(entry); this.queuedBytes += bytes;
      timeline.signal.addEventListener('abort', cancel, { once: true });
      if (timeline.signal.aborted) cancel(); else this.wake();
    });
  }
  private remove(index: number) { const entry = this.queue.splice(index, 1)[0]!; this.queuedBytes -= entry.bytes; entry.detach(); return entry; }
  wake() {
    if (this.disposed || this.scheduled || this.running) return;
    // Let the just-completed caller submit its next complete unit at its stable FIFO position.
    this.scheduled = this.background(() => setImmediate(() => { this.scheduled = setImmediate(() => {
      this.scheduled = undefined;
      this.running = this.pump().finally(() => {
        this.running = undefined;
        if (this.queue.length && (this.channels.size < POOL_LIMITS.workers || [...this.channels].some(c => !c.busy && !c.failure))) this.wake();
      });
    }); }));
  }
  private pumping = false;
  private async pump() {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (!this.disposed && this.queue.length) {
        let channel = [...this.channels].find(c => !c.busy && !c.ended && !c.failure);
        if (!channel && this.channels.size >= POOL_LIMITS.workers) break;
        const priority = (entry: Queued) => entry.timeline.operation?.priority() ?? 4;
        this.queue.sort((a, b) => priority(a) - priority(b) || (a.timeline.operation?.order ?? a.order) - (b.timeline.operation?.order ?? b.order));
        const previous = this.previous?.deref();
        const retained = this.queue.findIndex(entry => entry.timeline === previous && priority(entry) === priority(this.queue[0]!));
        const entry = this.remove(retained < 0 ? 0 : retained);
        this.previous = new WeakRef(entry.timeline);
        entry.trace?.field('priority', priority(entry)); entry.trace?.field('order', entry.timeline.operation?.order ?? entry.order);
        try {
          entry.timeline.check();
          if (!channel) {
            // Recheck at worker creation, never per record; fail if the verified file changed.
            const signature = await stat(this.manifest.executable); entry.timeline.check();
            const stamp = `${signature.size}:${signature.mtimeMs}`;
            if (this.stamp !== stamp && digest(await readFile(this.manifest.executable)) !== this.manifest.sha256) throw new RecallError('worker_dependency_changed', 'Worker executable no longer matches the verified package.');
            if (this.disposed) throw new RecallError('worker_failed', 'Matcher disposed.');
            entry.timeline.check(); this.stamp = stamp;
            channel = new WorkerChannel(this.manifest, this.launch, this.children); this.channels.add(channel); this.launches++;
            const owned = channel;
            void owned.closed.then(() => { this.channels.delete(owned); this.wake(); });
          }
          channel.busy = true; entry.trace?.mark('admittedMs');
          const owned = channel;
          void owned.request(entry.text, entry.terms, entry.timeline, entry.unit, entry.trace).then(ranges => {
            entry.trace?.count('confirmedUnits', 1); entry.trace?.count('spans', ranges.length); entry.trace?.end(); entry.resolve(ranges);
          }, error => { entry.trace?.end(entry.timeline.signal.aborted ? 'cancelled' : 'failed'); entry.reject(error); }).finally(() => { owned.busy = false; this.wake(); });
        } catch (error) { entry.trace?.end('failed'); entry.reject(error); }
      }
    } finally { this.pumping = false; }
  }
  async dispose() {
    this.disposed = true; if (this.scheduled) clearImmediate(this.scheduled); this.scheduled = undefined;
    while (this.queue.length) { const entry = this.remove(0); entry.trace?.end('cancelled'); entry.reject(new RecallError('worker_failed', 'Matcher disposed.')); }
    await this.running;
    await Promise.all([...this.channels].map(channel => channel.dispose()));
  }
}
