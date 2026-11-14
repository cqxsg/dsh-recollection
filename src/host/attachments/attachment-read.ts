import type { Context } from '@deepseek-ai/cordis';
import type { SessionHeader } from '@deepseek-ai/dsh-session';
import type { CanonicalRecord } from '../history/records.js';
import { accessAttachment, attachmentMetadata, type AttachmentSource } from './attachments.js';
import { recordHashSource } from './attachment-service.js';
import { argumentsHash } from '../runtime/identity.js';
import { hashKey, type HashRecord } from './hash-ledger.js';
import { hashCurrent } from './hashing.js';
import type { RecallConfig } from '../runtime/config.js';
import type { AttachmentResult } from '../protocol.js';

/** Source selection has already been authenticated by the read engine. */
export async function readAttachment(ctx: Context, fileContext: Context, header: SessionHeader, record: CanonicalRecord, source: AttachmentSource, config: RecallConfig, signal: AbortSignal, sourceRef: string): Promise<AttachmentResult> {
  const binding = source.type === 'path' ? recordHashSource(header, record, source) : undefined;
  let row: HashRecord | undefined;
  let baselineUnavailable = false;
  if (binding) {
    try {
      const hashes = ctx.get('recallHashes');
      baselineUnavailable = !hashes;
      row = hashes?.get(hashKey(binding));
    } catch { baselineUnavailable = true; }
  }
  const baseline = row && argumentsHash(row.source) === argumentsHash(binding) ? row : undefined;
  // A child header describes the child's cwd, not the cwd of its inherited events.
  const cwd = record.origin.inherited ? undefined : header.cwd;
  let access = await accessAttachment(fileContext, source, cwd, signal, baseline?.resolvedPath);
  let version: AttachmentResult['version'] = { state: 'unverified', reason: access.reason ?? 'no_historical_baseline' };
  if (access.state === 'accessible') {
    if (source.media?.type === 'image') version = { state: 'native_identity', reason: 'native_normalized_image_reference' };
    else {
      const expected = source.media?.type === 'file' ? /^sha256:([a-f0-9]{64})$/.exec(String(source.media.attachment.attachmentId))?.[1] : baseline?.sample?.hash;
      if (expected) {
        const verification = await hashCurrent(fileContext.get('fs')!, access.path!, config, signal);
        if (verification.sample) {
          version = { state: verification.sample.hash === expected ? 'same' : 'different', algorithm: 'sha256', hash: verification.sample.hash,
            checkedAt: verification.sample.completedAt, ...(baseline?.sample ? { baselineAt: baseline.sample.completedAt } : {}) };
        } else {
          version = { state: 'unverified', reason: verification.reason ?? 'hash_verification_failed', ...(baseline?.sample ? { baselineAt: baseline.sample.completedAt } : {}) };
          // Missing/denied after the first probe must not retain a false usable path.
          access = await accessAttachment(fileContext, source, cwd, signal, baseline?.resolvedPath);
        }
      } else version = { state: 'unverified', reason: source.type === 'spill' ? 'original_spill_locator_without_digest'
        : baselineUnavailable ? 'baseline_unavailable' : row && !baseline ? 'baseline_source_mismatch' : baseline?.state === 'failed' ? baseline.reason ?? 'baseline_failed'
          : baseline ? 'baseline_pending' : 'baseline_never_registered' };
    }
  }
  signal.throwIfAborted();
  return { ref: attachmentMetadata(sourceRef, source).ref, sourceRef, block: source.block, type: source.type,
    state: access.state, ...(access.state === 'accessible' ? { path: access.path! } : {}), ...(access.reason ? { reason: access.reason } : {}),
    contentRead: false, checkedAt: Date.now(), storage: source.type === 'file' ? 'archived_file' : source.type === 'image' ? 'normalized_image' : source.type === 'spill' ? 'spill' : 'current_file', version };
}
