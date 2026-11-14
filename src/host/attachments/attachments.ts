import type { Context } from '@deepseek-ai/cordis';
import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import type { FsTarget, FsInfo } from '@deepseek-ai/dsh-fs';
import type {} from '@deepseek-ai/dsh-attachment';
import { hasSpillNotice } from '@deepseek-ai/dsh-spill-policy/notice';
import { posix, win32 } from 'node:path';
import type { CanonicalRecord } from '../history/records.js';
import type { AttachmentItem } from '../protocol.js';

export interface AttachmentSource {
  selector: string;
  block: number;
  type: 'file' | 'image' | 'path' | 'spill';
  metadata: Record<string, any>;
  original?: string;
  path?: string;
  offset?: number;
  media?: Extract<ContentBlock, { type: 'file' | 'image' }>;
}
/** Native prompt spelling, not arbitrary prose/markdown paths. No filesystem I/O. */
export function fileMentions(text: string): { original: string; path: string; offset: number }[] {
  const out: ReturnType<typeof fileMentions> = [];
  for (const match of text.matchAll(/(?:^|\s)(@(?:"([^"\r\n]+)"|([^\s"]+)))(?=\s|$)/gu)) {
    const path = match[2] ?? match[3]!;
    if (/[\u0000-\u001f\u007f-\u009f]/u.test(path)) continue;
    out.push({ original: match[1]!, path, offset: match.index! + match[0].length - match[1]!.length });
  }
  return out;
}
/** Only the exact local rc.4 footer is a path locator. Other backends remain unresolved. */
function spillLocation(text: string): { path: string; offset: number } | undefined {
  if (!hasSpillNotice(text)) return;
  const marker = ' Full formatted result stored at: ', suffix = '. Use read with offset/limit, or grep this path to search within it.)';
  if (!text.endsWith(suffix)) return;
  const start = text.lastIndexOf(marker);
  if (start < 0) return;
  const path = text.slice(start + marker.length, -suffix.length);
  if (!absoluteFilePath(path)) return;
  return { path, offset: start + marker.length };
}
export const absoluteFilePath = (path: string): boolean => posix.isAbsolute(path) || win32.isAbsolute(path);

export function blockAttachments(block: Readonly<ContentBlock>, index: number, role: string, kind: string): AttachmentSource[] {
  if (block.type === 'file' || block.type === 'image') return [{ selector: `a${index}`, block: index, type: block.type, metadata: { ...block.attachment }, media: block }];
  if (block.type === 'text' && role === 'user') return fileMentions(block.text).map(p => ({ selector: `p${index}:${p.offset}`, block: index, type: 'path', ...p, metadata: { original: p.original, path: p.path, offset: p.offset } }));
  if (block.type === 'tool-call' && ['read', 'read_image'].includes(block.name)) {
    try {
      const args = JSON.parse(block.arguments);
      if (typeof args.path === 'string' && args.path.length && !args.path.includes('\0')) return [{ selector: `t${index}`, block: index, type: 'path', original: args.path, path: args.path, metadata: { path: args.path, tool: block.name } }];
    } catch { /* Malformed old arguments are text, never a guessed file source. */ }
  }
  if (block.type === 'text' && kind === 'tool_result') {
    const location = spillLocation(block.text);
    if (location) return [{ selector: `s${index}:${location.offset}`, block: index, type: 'spill', ...location,
      original: location.path, metadata: { path: location.path, locatorConvention: 'rc.4-local-spill-notice', authenticatedContent: false, originallyDelivered: 'preview_and_locator' } }];
  }
  return [];
}
export function recordAttachments(record: CanonicalRecord): AttachmentSource[] {
  return record.blocks.flatMap(block => blockAttachments(block.content, block.index, record.role, record.kind));
}
export function attachmentMetadata(sourceRef: string, source: AttachmentSource): AttachmentItem {
  return { ref: `${sourceRef}:${source.selector}`, block: source.block, type: source.type, metadata: source.metadata, state: 'not_checked' };
}
export type AccessState = 'accessible' | 'missing' | 'permission_denied' | 'unreachable' | 'unresolved' | 'not_file' | 'error';
export interface AttachmentAccess {
  state: AccessState; path?: string; target?: FsTarget; info?: FsInfo; reason?: string;
}
export function fileFailure(error: unknown): Exclude<AccessState, 'accessible'> {
  const code = (error as { code?: string })?.code ?? '';
  if (['ENOENT', 'ENOTDIR', 'FS_NOT_FOUND', 'FS_NOT_DIRECTORY'].includes(code)) return 'missing';
  if (['EACCES', 'EPERM', 'FS_PERMISSION_DENIED', 'FS_SANDBOX_DENIED'].includes(code)) return 'permission_denied';
  if (['FS_NOT_REGULAR_FILE', 'EISDIR'].includes(code)) return 'not_file';
  return 'error';
}
/** All probes use the executing world's provider; no Host-side read or export fallback. */
export async function accessAttachment(ctx: Context, source: AttachmentSource, cwd: string | undefined, signal: AbortSignal, resolvedPath?: string): Promise<AttachmentAccess> {
  signal.throwIfAborted();
  const fs = ctx.get('fs');
  if (!fs) return { state: 'unreachable', reason: 'filesystem_provider_unavailable' };
  try {
    let path: string | undefined = resolvedPath ?? source.path;
    if (source.media) {
      const attachments = ctx.get('attachments');
      if (!attachments) return { state: 'unreachable', reason: 'attachment_store_unavailable' };
      const hostPath = source.media.type === 'file' ? attachments.fileHostPath(source.media.attachment) : attachments.imageHostPath(source.media.attachment);
      path = hostPath && fs.processPathFromHostPath(hostPath);
      if (!path) return { state: 'unreachable', reason: 'no_execution_path_mapping' };
    } else if (source.type === 'spill') {
      path = source.path && fs.processPathFromHostPath(source.path);
      if (!path) return { state: 'unreachable', reason: 'no_execution_path_mapping' };
    }
    if (!path || path.includes('\0') || (!absoluteFilePath(path) && !cwd)) return { state: 'unresolved', reason: 'historical_working_directory_unavailable' };
    const target = await fs.resolve(path, { ...(cwd ? { cwd } : {}), signal });
    const info = await fs.stat(target, signal);
    if (!info) return { state: 'missing', reason: 'file_not_found' };
    if (info.type !== 'file') return { state: 'not_file', reason: info.type };
    // stat alone cannot prove permission. A bounded probe opens even an empty file.
    await fs.readByteRange(target, { offset: 0, length: 1 }, signal);
    signal.throwIfAborted();
    return { state: 'accessible', path: fs.processPath(target), target, info };
  } catch (error) {
    signal.throwIfAborted();
    return { state: fileFailure(error), reason: String((error as { code?: string })?.code ?? 'file_access_failed') };
  }
}
