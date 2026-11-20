import { hasSpillNotice } from '@deepseek-ai/dsh-spill-policy/notice';
import type { SessionEvent } from '@deepseek-ai/dsh-session/types';
import { indexExecutions } from '../runtime/executions.js';

/** Accept one return expression. Unknown lexical forms leave the original result visible. */
function directlyReturns(code: unknown, tool: string): boolean {
  if (typeof code !== 'string') return false;
  const call = /^\s*return[ \t]+(?:await\s+)?tools\.(recall_search|recall_read)\s*\(/u.exec(code);
  if (!call || call[1] !== tool) return false;
  const tail = code.slice(call[0].length).replace(/"(?:[^"\\]|\\[\s\S])*"|'(?:[^'\\]|\\[\s\S])*'/gu, '0');
  if (/['"\x60/]/u.test(tail)) return false; // Includes templates, comments and regex literals.
  let depth = 1;
  for (let i = 0; i < tail.length; i++) {
    if (tail[i] === '(') depth++;
    if (tail[i] === ')' && --depth === 0) return /^\s*;?\s*$/u.test(tail.slice(i + 1));
  }
  return false;
}

/** Compare a single native text result, including the host's head/tail spill preview. */
function matchesDisplay(display: string, full: string): boolean {
  if (display === full) return true;
  const footer = display.lastIndexOf('\n\n(');
  const notice = footer < 0 ? display : display.slice(footer + 2);
  if (!hasSpillNotice(notice)) return false;
  let head = '', tail = '';
  if (footer >= 0) {
    const gap = '\n\n[...]\n\n';
    const preview = display.slice(0, footer), cut = preview.indexOf(gap);
    if (cut < 0) return false;
    head = preview.slice(0, cut); tail = preview.slice(cut + gap.length);
    if (!full.startsWith(head) || !full.endsWith(tail) || head.length + tail.length > full.length) return false;
  }
  const omitted = Buffer.byteLength(full.slice(head.length, full.length - tail.length));
  return notice.startsWith(`(Omitted ${omitted} bytes. Full formatted result stored at: `);
}

/** Native call and result positions for verified, unmodified recall forwards. */
export function forwardedRecallResults(events: readonly SessionEvent[]) {
  const copies = { calls: new Set<number>(), results: new Set<number>() };
  if (!events.some(e => e.type === 'tool/ptc-dispatch-start' && (e.data.name === 'recall_search' || e.data.name === 'recall_read'))) return copies;
  const { rootByDispatch, results } = indexExecutions(events);
  const onlyChild = new Map<number, number | null>();
  for (const [child, root] of rootByDispatch) onlyChild.set(root, onlyChild.has(root) ? null : child);
  for (const [rootSeq, childSeq] of onlyChild) {
    if (childSeq === null) continue;
    const root = events[rootSeq], child = results.get(childSeq), outer = results.get(rootSeq);
    if (root?.type !== 'tool/call' || root.data.name !== 'run_code' || child?.type !== 'tool/ptc-dispatch'
      || child.data.parentCallId !== root.data.callId || child.data.isError || outer?.type !== 'tool/result' || outer.data.message.isError) continue;
    const inner = child.data.content, body = outer.data.message.content;
    if (inner.length !== 1 || inner[0]?.type !== 'text' || body.length !== 1 || body[0]?.type !== 'text') continue;
    try {
      if (!directlyReturns(JSON.parse(root.data.arguments).code, child.data.name)) continue;
      const rendered = JSON.stringify(JSON.parse(inner[0].text), null, 2);
      if (matchesDisplay(body[0].text, rendered) || matchesDisplay(body[0].text, rendered + '\nFile sandbox enforcement is partial on this host.')) {
        copies.calls.add(rootSeq); copies.results.add(outer.seq);
      }
    } catch { /* Unrecognized script arguments or a non-JSON tool payload remain eligible. */ }
  }
  return copies;
}
