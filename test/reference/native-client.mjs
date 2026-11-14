// Frozen P1 candidate; only retained for reproducible comparison, never packaged.
import { spawn } from 'node:child_process';
import { readFile, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { RecallError } from '../../lib/index.js';
await import('./build-reference.mjs');
export const { RgMatcher } = await import('../../.local/cli-matcher.mjs');

export const LIMITS = Object.freeze({ header: 65536, input: 64 * 1024 * 1024, output: 8 * 1024 * 1024, spans: 65536, cache: 4, allocation: 128 * 1024 * 1024 });
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const safe = text => !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(text);
export function normalize(terms) {
  const nul = terms.patterns.some(p => p.includes('\0'));
  if (terms.patterns.some(p => !safe(p))) throw new RecallError('invalid_pattern', 'Patterns must contain valid Unicode scalar values.', true);
  return { fixed: terms.mode === 'literal' && !nul, case_sensitive: terms.case_sensitive, patterns: terms.patterns.map(p => {
    if (nul && terms.mode === 'literal') return p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\0/g, '\\x00');
    for (let at = p.indexOf('\0'); at >= 0; at = p.indexOf('\0', at + 1)) {
      let slashes = 0; for (let i = at - 1; i >= 0 && p[i] === '\\'; i--) slashes++;
      if (slashes % 2) throw new RecallError('invalid_pattern', 'A NUL following an unmatched regex escape is invalid.', true);
    }
    return p.replace(/\0/g, '\\x00');
  }) };
}

export class WorkerChannel {
  constructor(manifest, launch = spawn, children = new Set()) {
    this.manifest = manifest; this.next = 0; this.pending = undefined; this.failure = undefined; this.ended = false;
    this.stats = { requests: 0, compiles: 0, compileMs: 0, scanAndEncodeMs: 0, inputMs: 0, peakAllocatedBytes: 0 };
    this.ready = new Promise((resolve, reject) => { this.readyResolve = resolve; this.readyReject = reject; });
    this.ready.catch(() => {});
    this.child = launch(manifest.executable, ['--parent-pid', String(process.pid)], { windowsHide: true, shell: false, stdio: 'pipe' });
    if (this.child.pid) children.add(this.child.pid);
    let header = Buffer.alloc(4), headerAt = 0, body, bodyAt = 0, stderr = '';
    this.child.stdout.on('data', chunk => {
      try {
        for (let at = 0; at < chunk.length;) {
          if (!body) {
            const n = Math.min(4 - headerAt, chunk.length - at); chunk.copy(header, headerAt, at, at + n); at += n; headerAt += n;
            if (headerAt < 4) continue;
            const length = header.readUInt32BE();
            if (!length || length > LIMITS.output) throw new RecallError('worker_output_invalid', 'Worker frame exceeds the output bound.');
            body = Buffer.alloc(length); bodyAt = 0;
          }
          const n = Math.min(body.length - bodyAt, chunk.length - at); chunk.copy(body, bodyAt, at, at + n); at += n; bodyAt += n;
          if (bodyAt === body.length) {
            const message = JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(body));
            body = undefined; headerAt = 0; this.receive(message);
          }
        }
      } catch (error) { this.fail(error instanceof RecallError ? error : new RecallError('worker_output_invalid', 'Malformed worker response.')); }
    });
    this.child.stderr.on('data', data => { stderr = (stderr + data.toString()).slice(0, 4096); });
    this.child.stdin.on('error', error => { if (error.code !== 'EPIPE') this.fail(error); });
    this.child.on('error', error => { this.failure ??= error; });
    this.closed = new Promise(resolve => this.child.once('close', (code, signal) => {
      this.exitCode = code;
      this.ended = true;
      this.failure ??= new RecallError(code === 70 ? 'worker_resource_limit' : 'worker_failed', stderr || `Worker closed (${code ?? signal}); no incomplete unit is accepted.`);
      this.readyReject(this.failure); this.pending?.reject(this.failure); this.pending = undefined;
      if (this.child.pid) children.delete(this.child.pid);
      this.child.stdin.destroy(); this.child.stdout.destroy(); this.child.stderr.destroy(); resolve();
    }));
  }
  fail(error) { this.failure ??= error; if (!this.ended) this.child.kill('SIGKILL'); }
  receive(message) {
    if (this.failure) return;
    if (!this.handshake) {
      if (message.kind !== 'ready' || message.protocol !== 1 || message.build !== this.manifest.build
        || message.source !== this.manifest.source || message.rg !== '15.2.0' || message.pid !== this.child.pid
        || Object.entries(LIMITS).some(([key, value]) => message.limits?.[key] !== value)) {
        throw new RecallError('worker_version_mismatch', 'Worker protocol/build identity differs from the verified manifest.');
      }
      this.handshake = true; this.readyResolve(); return;
    }
    const pending = this.pending;
    if (!pending) throw new RecallError('worker_output_invalid', 'Unsolicited or duplicate worker frame.');
    const { request, bytes } = pending;
    for (const key of ['protocol', 'request', 'query', 'unit', 'field', 'input_bytes', 'input_sha256']) {
      if (message[key] !== request[key]) throw new RecallError('worker_output_invalid', `Worker ${key} does not identify the submitted complete unit.`);
    }
    if (message.complete === false) {
      if (!['invalid_pattern', 'worker_resource_limit', 'worker_failed'].includes(message.code) || typeof message.message !== 'string') throw new RecallError('worker_output_invalid', 'Unknown worker failure.');
      this.pending = undefined; pending.reject(new RecallError(message.code, message.message, message.code === 'invalid_pattern')); return;
    }
    if (message.complete !== true || message.searches !== 1 || message.bytes_searched !== bytes.length
      || !Array.isArray(message.spans) || message.spans.length > LIMITS.spans || !Number.isSafeInteger(message.matches)
      || Boolean(message.matches) !== Boolean(message.spans.length) || ![0, 1].includes(message.begin) || message.end !== message.begin
      || message.searches_with_match !== message.begin
      || typeof message.compiled !== 'boolean' || !Number.isSafeInteger(message.cache_entries) || message.cache_entries > LIMITS.cache
      || !Number.isSafeInteger(message.peak_allocated_bytes) || message.peak_allocated_bytes > LIMITS.allocation) {
      throw new RecallError('worker_output_invalid', 'Worker did not confirm a bounded complete scan.');
    }
    let previous = 0;
    for (const span of message.spans) {
      if (!Number.isSafeInteger(span.start) || !Number.isSafeInteger(span.end) || span.start < previous || span.end < span.start
        || span.end > bytes.length || span.sha256 !== digest(bytes.subarray(span.start, span.end))) throw new RecallError('worker_output_invalid', 'Worker range does not map to original input bytes.');
      previous = span.end;
    }
    this.stats.requests++; this.stats.compiles += Number(message.compiled);
    this.stats.compileMs += message.compile_ms; this.stats.scanAndEncodeMs += message.scan_and_encode_ms; this.stats.inputMs += message.input_ms;
    this.stats.peakAllocatedBytes = Math.max(this.stats.peakAllocatedBytes, message.peak_allocated_bytes);
    this.pending = undefined; pending.resolve(message.spans.map(({ start, end }) => ({ start, end })));
  }
  async request(text, terms, timeline, unit) {
    timeline.check();
    const abort = () => this.fail(timeline.signal.reason);
    timeline.signal.addEventListener('abort', abort, { once: true });
    try {
      if (timeline.signal.aborted) abort();
      await this.ready; timeline.check();
      if (this.failure || this.ended) throw this.failure;
      if (this.pending) throw new Error('A worker accepts only one complete unit at a time.');
      const condition = normalize(terms), bytes = Buffer.from(text);
      if (bytes.length > LIMITS.input) throw new RecallError('worker_resource_limit', 'One complete unit exceeds the input byte limit.');
      const request = { protocol: 1, request: ++this.next, query: digest(JSON.stringify(condition)), unit: unit.recordId ?? unit.purpose,
        field: unit.field ?? '', ...condition, input_bytes: bytes.length, input_sha256: digest(bytes) };
      const header = Buffer.from(JSON.stringify(request));
      if (header.length > LIMITS.header) throw new RecallError('worker_resource_limit', 'Pattern/identity frame exceeds the header limit.');
      const length = Buffer.alloc(4); length.writeUInt32BE(header.length);
      const result = new Promise((resolve, reject) => { this.pending = { request, bytes, resolve, reject }; });
      // At most one bounded input is in the writable pipe. The next request
      // waits for a complete response; no unbounded write queue is accumulated.
      this.child.stdin.write(length); this.child.stdin.write(header); this.child.stdin.write(bytes);
      const ranges = await result; timeline.check(); return ranges;
    } catch (error) {
      if (timeline.signal.aborted) { abort(); await this.closed; timeline.check(); }
      if (this.failure) await this.closed;
      throw error;
    } finally { timeline.signal.removeEventListener('abort', abort); }
  }
  async dispose() { if (!this.ended) { this.child.stdin.end(); this.child.kill('SIGKILL'); } await this.closed; }
}

export class PrototypeMatcher extends RgMatcher {
  constructor(manifestPath = fileURLToPath(new URL('../../.local/native-build/manifest.json', import.meta.url)), launch = spawn) {
    super(); this.manifestPath = manifestPath; this.workerLaunch = launch; this.channels = []; this.waiting = []; this.disposed = false;
  }
  async initialize(timeline) {
    this.initialization ??= (async () => {
      const manifest = JSON.parse(await readFile(this.manifestPath, 'utf8'));
      manifest.executable = await realpath(manifest.executable);
      if (digest(await readFile(manifest.executable)) !== manifest.sha256) throw new RecallError('worker_version_mismatch', 'Worker binary hash differs from the build manifest.');
      this.manifest = manifest; this.info = { version: '15.2.0', executable: manifest.executable, sha256: manifest.sha256, build: manifest.build };
    })();
    await this.initialization; timeline.check();
  }
  async scanUnchecked(text, terms, timeline, unit) {
    timeline.check(); if (this.disposed) throw new RecallError('worker_failed', 'Matcher disposed.');
    let channel = this.channels.find(c => !c.busy && !c.ended && !c.failure);
    if (!channel && this.channels.filter(c => !c.ended).length < 2) {
      channel = new WorkerChannel(this.manifest, this.workerLaunch, this.children); this.channels.push(channel);
    }
    if (!channel) throw new RecallError('worker_resource_limit', 'Prototype allows two simultaneous complete units.');
    channel.busy = true;
    try { return await channel.request(text, terms, timeline, unit); }
    finally { channel.busy = false; }
  }
  stats() { return this.channels.map(c => ({ pid: c.child.pid, closed: c.ended, ...c.stats })); }
  async dispose() { this.disposed = true; await Promise.all(this.channels.map(c => c.dispose())); }
}
