import { createHash, type Hash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { FileSystem, FsInfo } from '@deepseek-ai/dsh-fs';
import { RecallError } from '../protocol.js';

export const HASH_CHUNK_BYTES = 256 * 1024;
export const HASH_SLICE_MS = 250;
export interface HashSample { algorithm: 'sha256'; hash: string; size: number; startedAt: number; completedAt: number; }
export class HashSliceEnd extends Error {}
export class HashChanged extends Error {}
/** Owns at most one chunk and one incremental digest; no open descriptor across pauses. */
export class HashComputation {
  private hash: Hash = createHash('sha256');
  private offset = 0;
  private initial: { key: string; info: FsInfo } | undefined;
  private readonly startedAt = Date.now();
  constructor(private readonly fs: FileSystem, private readonly path: string, private readonly cwd?: string) {}
  get bytes() { return this.offset; }
  async step(signal: AbortSignal): Promise<HashSample | undefined> {
    signal.throwIfAborted();
    const target = await this.fs.resolve(this.path, { ...(this.cwd ? { cwd: this.cwd } : {}), signal });
    const info = await this.fs.stat(target, signal);
    if (!info) throw new RecallError('file_missing', 'Referenced file is missing.');
    if (info.type !== 'file') throw new RecallError('file_not_regular', 'Referenced source is not a regular file.');
    const same = (other: FsInfo | undefined, key: string) => !!other && key === this.initial!.key
      && other.type === 'file' && other.version === this.initial!.info.version && other.size === this.initial!.info.size;
    this.initial ??= { key: target.targetKey, info };
    if (!same(info, target.targetKey)) throw new HashChanged('File changed between chunks or while paused.');
    const data = await this.fs.readByteRange(target, { offset: this.offset, length: HASH_CHUNK_BYTES }, signal);
    const afterTarget = await this.fs.resolve(this.path, { ...(this.cwd ? { cwd: this.cwd } : {}), signal });
    const after = await this.fs.stat(afterTarget, signal);
    signal.throwIfAborted();
    if (!same(after, afterTarget.targetKey)) throw new HashChanged('File changed while reading a chunk.');
    if (data.byteLength > HASH_CHUNK_BYTES || (info.size !== undefined && data.byteLength !== Math.min(HASH_CHUNK_BYTES, Math.max(0, info.size - this.offset)))) {
      throw new HashChanged('Read length differs from the observed complete file.');
    }
    this.hash.update(data); this.offset += data.byteLength;
    const done = info.size === undefined ? data.byteLength < HASH_CHUNK_BYTES : this.offset === info.size;
    return done ? { algorithm: 'sha256', hash: this.hash.digest('hex'), size: this.offset, startedAt: this.startedAt, completedAt: Date.now() } : undefined;
  }
}
export const retryHash = (error: unknown) => error instanceof HashChanged || ['FS_IO_ERROR', 'EIO', 'EBUSY', 'ETIMEDOUT', 'EAGAIN'].includes((error as any)?.code);
export const hashReason = (error: unknown) => error instanceof HashChanged ? 'file_changed' : String((error as any)?.code ?? 'hash_read_failed');
/** A slice is an interruptible scheduling boundary, never a fresh task/attempt allowance. */
export async function hashSlice(computation: HashComputation, ms: number, signal: AbortSignal) {
  const boundary = new AbortController(), started = performance.now();
  const timer = setTimeout(() => boundary.abort(new HashSliceEnd('Hash activity reservation ended.')), ms);
  const scope = AbortSignal.any([signal, boundary.signal]);
  try {
    const sample = await computation.step(scope); scope.throwIfAborted();
    return { sample, elapsed: performance.now() - started };
  } catch (error) { return { error: scope.aborted ? scope.reason : error, elapsed: performance.now() - started }; }
  finally { clearTimeout(timer); }
}
/** Verification is ephemeral, shares N/T across retries, and never modifies a stored baseline. */
export async function hashCurrent(fs: FileSystem, path: string, limits: { hashAttempts: number; hashActiveMs: number }, signal: AbortSignal): Promise<{ sample?: HashSample; reason?: string; attempts: number; spentMs: number }> {
  let attempts = 0, spentMs = 0, computation: HashComputation | undefined, reason: string | undefined;
  while (spentMs < limits.hashActiveMs) {
    signal.throwIfAborted();
    if (!computation) {
      if (attempts >= limits.hashAttempts) break;
      attempts++; computation = new HashComputation(fs, path);
    }
    const result = await hashSlice(computation, Math.min(HASH_SLICE_MS, limits.hashActiveMs - spentMs), signal);
    spentMs += result.elapsed; signal.throwIfAborted();
    if (spentMs >= limits.hashActiveMs) return { reason: 'hash_time_exhausted', attempts, spentMs };
    if (result.sample) return { sample: result.sample, attempts, spentMs };
    if (result.error && !(result.error instanceof HashSliceEnd)) {
      reason = hashReason(result.error);
      if (!retryHash(result.error)) break;
      computation = undefined;
    }
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  return { reason: spentMs >= limits.hashActiveMs ? 'hash_time_exhausted' : reason ?? 'hash_attempts_exhausted', attempts, spentMs };
}
