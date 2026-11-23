import type { Context } from '@deepseek-ai/cordis';
import type { SessionHeader } from '@deepseek-ai/dsh-session';
import type { CanonicalRecord } from '../history/records.js';
import { accessAttachment, attachmentMetadata, type AttachmentSource } from './attachments.js';
import { nativeHashSources, recordHashSource } from './attachment-service.js';
import { commandInputPath } from '../history/user-content.js';
import { recallCommandInput } from '../../shared/recall-command.js';
import { argumentsHash } from '../runtime/identity.js';
import { hashKey, type HashRecord, type HashSource } from './hash-ledger.js';
import { hashCurrent } from './hashing.js';
import type { RecallConfig } from '../runtime/config.js';
import type { AttachmentResult } from '../protocol.js';

/** User-facing offsets in a command refer to its argument. Durable file samples use the native message offset. */
async function pathBinding(ctx: Context, header: SessionHeader, record: CanonicalRecord, source: AttachmentSource, signal: AbortSignal) {
  return ctx.recallHistory.withSnapshot(header.id, snapshot => {
    if (record.origin.contentPath !== commandInputPath) return recordHashSource(header, record, source, snapshot.events, snapshot.inheritedEventCount);
    const event = snapshot.events[record.origin.seq], block = record.blocks[0]?.content;
    if (event?.type !== 'user/message' || event.data.id !== record.origin.messageId || block?.type !== 'text'
      || recallCommandInput(event.data.source) !== block.text || source.offset === undefined) return;
    const raw = event.data.content[0];
    if (raw?.type !== 'text') return;
    const start = raw.text.indexOf(block.text);
    if (start < 0 || start !== raw.text.lastIndexOf(block.text)) return;
    const selector = `p0:${start + source.offset}`;
    return nativeHashSources(header, event, snapshot.events, snapshot.inheritedEventCount).find(binding => binding.selector === selector && binding.path === source.path);
  }, signal, { waitForQuiescence: true });
}

/** Source selection has already been authenticated by the read engine. */
export async function readAttachment(ctx: Context, fileContext: Context, header: SessionHeader, record: CanonicalRecord, source: AttachmentSource, config: RecallConfig, signal: AbortSignal, sourceRef: string): Promise<AttachmentResult> {
  let binding: HashSource | undefined;
  let row: HashRecord | undefined;
  let baselineUnavailable = false;
  if (source.type === 'path') {
    try {
      binding = await pathBinding(ctx, header, record, source, signal);
      const hashes = ctx.get('recallHashes');
      baselineUnavailable = !hashes;
      if (hashes) {
        row = binding && hashes.get(hashKey(binding));
        baselineUnavailable = !binding;
      }
    } catch { signal.throwIfAborted(); baselineUnavailable = true; }
  }
  let baseline = row && argumentsHash(row.source) === argumentsHash(binding) ? row : undefined;
  // A child header describes the child's cwd, not the cwd of its inherited events.
  const cwd = record.origin.inherited ? undefined : binding?.cwd;
  let access = await accessAttachment(fileContext, source, cwd, signal);
  if (baseline?.resolvedPath && access.path && baseline.resolvedPath !== access.path) baseline = undefined;
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
          access = await accessAttachment(fileContext, source, cwd, signal);
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
