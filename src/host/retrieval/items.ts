import type { CanonicalRecord } from '../history/records.js';
import { RecallError, type ResultItem, type RecallResult, type AttachmentResult } from '../protocol.js';
import { recordLocator, recordKey, referencePlaceholder, type RecallReferenceStore } from '../state/reference-store.js';
import { textTokens, unicodeBoundary } from './output.js';
import type { MatchSpan } from './matcher.js';
import { recordAttachments, attachmentMetadata } from '../attachments/attachments.js';

function sourceItem(record: CanonicalRecord, content: string, start: number, end: number, fullLength: number): ResultItem {
  const ref = referencePlaceholder, o = record.origin;
  return {
    ref, source: { seq: o.seq, blocks: record.blocks.map(b => b.index), role: record.role, kind: record.kind,
      time: o.time, turn: o.turn, step: o.step, inherited: o.inherited, authorship: o.authorship, messageId: o.messageId,
      ...(record.tool ? { callId: record.tool.callId, tool: record.tool.name } : {}) },
    content, contentComplete: start === 0 && end === fullLength, start, end, omittedBefore: start > 0, omittedAfter: end < fullLength,
    attachments: recordAttachments(record).map(source => attachmentMetadata(ref, source)),
  };
}

/** Candidate sizing has no storage side effects. Only final page objects acquire durable refs. */
export class PageReferences {
  private readonly sources = new WeakMap<object, CanonicalRecord>();
  constructor(private readonly store: RecallReferenceStore) {}
  item(record: CanonicalRecord, content: string, start: number, end: number, fullLength: number): ResultItem {
    const item = sourceItem(record, content, start, end, fullLength);
    this.sources.set(item, record); return item;
  }
  attachment(record: CanonicalRecord, result: AttachmentResult): AttachmentResult { this.sources.set(result, record); return result; }
  async publish(result: RecallResult, sessionId: string, signal: AbortSignal): Promise<void> {
    const handles = new Map<string, string>();
    for (const item of [...result.items, ...(result.attachmentResults ?? [])]) {
      signal.throwIfAborted();
      const record = this.sources.get(item);
      if (!record || record.origin.sessionId !== sessionId) throw new RecallError('reference_source_invalid', 'The result page source cannot be verified.');
      const locator = recordLocator(record), key = recordKey(locator);
      let handle = handles.get(key);
      if (!handle) { handle = (await this.store.issue(locator, signal)).handle; handles.set(key, handle); }
      if ('sourceRef' in item) {
        item.ref = handle + item.ref.slice(referencePlaceholder.length); item.sourceRef = handle;
      } else {
        item.ref = handle;
        for (const attachment of item.attachments) attachment.ref = handle + attachment.ref.slice(referencePlaceholder.length);
      }
    }
  }
}
/** A single contiguous window; no disjoint hit snippets or surrogate halves. */
export function previewWindow(text: string, matches: readonly MatchSpan[], cap: number): { start: number; end: number } {
  if (textTokens(text) <= cap) return { start: 0, end: text.length };
  const first = matches.find(m => m.field === 'body');
  const center = first ? Math.floor((first.start + first.end) / 2) : 0;
  const candidate = (length: number) => {
    const start = unicodeBoundary(text, Math.max(0, Math.min(text.length - length, center - Math.floor(length / 2))));
    return { start, end: unicodeBoundary(text, Math.min(text.length, start + length)) };
  };
  let low = 0, high = text.length;
  while (low < high) { const middle = Math.ceil((low + high) / 2), range = candidate(middle); if (textTokens(text.slice(range.start, range.end)) <= cap) low = middle; else high = middle - 1; }
  let { start, end } = candidate(low);
  // Prefer the outermost available boundaries while retaining the central hit.
  const section = text.slice(start, end), boundaries = [...section.matchAll(/\n\n|\r?\n|[。！？.!?](?:\s|$)/g)].map(m => start + m.index! + m[0].length);
  const left = boundaries.find(b => b <= center), right = boundaries.filter(b => b > center).at(-1);
  if (left !== undefined) start = left;
  if (right !== undefined) end = right;
  return { start, end };
}
