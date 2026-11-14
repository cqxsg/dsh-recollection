import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { readFile, access, realpath, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { CanonicalRecord } from '../../src/host/history/records.js';
import { RecallError, performanceDiagnostics } from 'dsh-recollection';
import type { SearchTerms } from '../../src/host/protocol.js';
import type { CallTimeline } from '../../src/host/runtime/deadline.js';
import { argumentsHash } from '../../src/host/runtime/identity.js';


interface MatchUnit { purpose: 'version' | 'validation' | 'match' | 'invalid-diagnosis'; recordId?: string; field?: string; }

export const RG_VERSION = '15.2.0';
export interface TextSegment { path: string; start: number; end: number; }
export interface RecordDocument { body: string; segments: TextSegment[]; metadata: { path: string; text: string }[]; }
export interface MatchSpan { field: 'body' | 'metadata'; start: number; end: number; byteStart: number; byteEnd: number; locations: { path: string; start: number; end: number }[]; }
export interface RecordMatch { recordId: string; spans: MatchSpan[]; }

/** Concatenate real text blocks without inserted headers; metadata is searched separately. */
export function recordDocument(record: CanonicalRecord): RecordDocument {
  let body = '';
  const segments: TextSegment[] = [], metadata: RecordDocument['metadata'] = [];
  const add = (path: string, text: string) => { const start = body.length; body += text; segments.push({ path, start, end: body.length }); };
  const strings = (value: unknown, path: string) => {
    if (typeof value === 'string') metadata.push({ path, text: value });
    else if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) strings(child, `${path}.${key}`);
  };
  for (const block of record.blocks) {
    if (block.content.type === 'text') add(`${block.path}.text`, block.content.text);
    else if (block.content.type === 'tool-call') { add(`${block.path}.name`, block.content.name); add(`${block.path}.arguments`, block.content.arguments); }
    else strings(block.content.attachment, `${block.path}.attachment`);
  }
  return { body, segments, metadata };
}

async function executablePath(binary: string): Promise<string> {
  if (isAbsolute(binary) || binary.includes('/') || binary.includes('\\')) return realpath(resolve(binary));
  const path = process.env.PATH ?? process.env.Path ?? '';
  const suffixes = process.platform === 'win32' ? ['', '.exe'] : [''];
  for (const folder of path.split(delimiter)) for (const suffix of suffixes) {
    const candidate = join(folder.replace(/^"|"$/g, ''), binary + suffix);
    try { await access(candidate); return realpath(candidate); } catch {}
  }
  throw new RecallError('rg_unavailable', `ripgrep ${RG_VERSION} is required; install the verified release and configure rgPath.`);
}
const scalarSafe = (text: string) => !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(text);
function patternArgs(terms: SearchTerms): string[] {
  const nul = terms.patterns.some(p => p.includes('\0'));
  if (terms.patterns.some(p => !scalarSafe(p))) throw new RecallError('invalid_pattern', 'Patterns must contain valid Unicode scalar values.', true);
  const args = ['--no-config', '--json', '--multiline', '--text', '--encoding=none', '--engine=default', '--no-crlf', '--no-mmap', '--threads=1', '--color=never', terms.case_sensitive ? '--case-sensitive' : '--ignore-case'];
  if (terms.mode === 'literal' && !nul) args.push('--fixed-strings');
  for (let pattern of terms.patterns) {
    if (nul && terms.mode === 'literal') pattern = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\0/g, '\\x00');
    else if (pattern.includes('\0')) {
      // Native argv cannot carry NUL. An unescaped NUL is the equivalent regex atom \x00.
      for (let at = pattern.indexOf('\0'); at >= 0; at = pattern.indexOf('\0', at + 1)) {
        let slashes = 0; for (let i = at - 1; i >= 0 && pattern[i] === '\\'; i--) slashes++;
        if (slashes % 2) throw new RecallError('invalid_pattern', 'A NUL following an unmatched regex escape is invalid.', true);
      }
      pattern = pattern.replace(/\0/g, '\\x00');
    }
    args.push('-e', pattern);
  }
  args.push('-');
  return args;
}

/** One child per complete record/body (or individual metadata field): impossible to cross records. */
export class RgMatcher {
  private binary: string | undefined;
  private stamp: string | undefined;
  private initializing: Promise<void> | undefined;
  readonly children = new Set<number>();
  info: { version: string; executable: string; sha256: string } | undefined;
  constructor(private readonly requested = 'rg', private readonly launch: typeof spawn = spawn) {}
  private async initialize(timeline: CallTimeline) {
    if (!this.initializing) this.initializing = (async () => {
      this.binary = await executablePath(this.requested);
      const signature = await stat(this.binary);
      this.stamp = `${signature.size}:${signature.mtimeMs}`;
      const sha256 = createHash('sha256').update(await readFile(this.binary)).digest('hex');
      let output = '';
      await this.process(['--no-config', '--version'], '', timeline, line => { output += line + '\n'; }, { purpose: 'version' });
      if (![ `ripgrep ${RG_VERSION}`, `ripgrep ${RG_VERSION} (rev e89fff89ac)` ].includes(output.split(/\r?\n/)[0]!)) throw new RecallError('rg_version_mismatch', `Expected ripgrep ${RG_VERSION}; got ${output.split(/\r?\n/)[0]}.`);
      this.info = { version: RG_VERSION, executable: this.binary, sha256 };
    })().catch(error => { this.initializing = undefined; throw error; });
    await this.initializing;
    timeline.check();
    const signature = await stat(this.binary!);
    if (`${signature.size}:${signature.mtimeMs}` !== this.stamp) throw new RecallError('rg_dependency_changed', 'The verified rg executable changed; reload the plugin.');
  }
  async validate(terms: SearchTerms, timeline: CallTimeline): Promise<void> {
    await this.initialize(timeline);
    await this.scanText('', terms, timeline, { purpose: 'validation' });
  }
  async match(record: CanonicalRecord, terms: SearchTerms, timeline: CallTimeline): Promise<RecordMatch> {
    await this.initialize(timeline);
    const document = recordDocument(record), spans: MatchSpan[] = [];
    for (const part of [...(document.segments.length ? [{ path: '', text: document.body }] : []), ...document.metadata]) {
      timeline.check();
      if (!scalarSafe(part.text)) throw new RecallError('source_encoding_invalid', 'Native text contains an unpaired UTF-16 surrogate; matching would change its content.');
      const bytes = Buffer.from(part.text);
      const ranges = await timeline.retry(() => this.scanText(part.text, terms, timeline, { purpose: 'match', recordId: record.id, field: part.path || 'body' }));
      const endpoints = [...new Set(ranges.flatMap(r => [r.start, r.end]))].sort((a, b) => a - b);
      const offsets = new Map<number, number>();
      let i = 0, byte = 0, at = 0, checkpoint = 0;
      while (at < endpoints.length) {
        if (byte === endpoints[at]) { offsets.set(byte, i); at++; continue; }
        if (i >= part.text.length || byte > endpoints[at]!) throw new RecallError('rg_output_invalid', 'rg reported a non-Unicode boundary.');
        const code = part.text.codePointAt(i)!; byte += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4; i += code > 0xffff ? 2 : 1;
        if (i - checkpoint >= 16384) { checkpoint = i; await new Promise<void>(resolve => setImmediate(resolve)); timeline.check(); }
      }
      for (const range of ranges) {
        const start = offsets.get(range.start)!, end = offsets.get(range.end)!;
        const locations = part.path ? [{ path: part.path, start, end }] : document.segments.filter(s => s.end > start && s.start < end || start === end && s.start <= start && s.end >= end).map(s => ({ path: s.path, start: Math.max(start - s.start, 0), end: Math.min(end, s.end) - s.start }));
        if (range.end > bytes.length) throw new RecallError('rg_output_invalid', 'rg match extends past its complete input.');
        spans.push({ field: part.path ? 'metadata' : 'body', start, end, byteStart: range.start, byteEnd: range.end, locations });
      }
    }
    return { recordId: record.id, spans };
  }
  private async scanText(text: string, terms: SearchTerms, timeline: CallTimeline, unit: MatchUnit): Promise<{ start: number; end: number }[]> {
    try { return await this.scanUnchecked(text, terms, timeline, unit); }
    catch (error) {
      if (!(error instanceof RecallError) || error.code !== 'invalid_pattern') throw error;
      const patterns = [...new Set(terms.patterns)].sort();
      // Diagnose only failed compilations. Isolating the offending condition
      // keeps OR ordering and unrelated valid patterns out of its identity.
      if (patterns.length > 1) for (const pattern of patterns) {
        try { await this.scanUnchecked('', { ...terms, patterns: [pattern] }, timeline, { ...unit, purpose: 'invalid-diagnosis' }); }
        catch (isolated) {
          if (!(isolated instanceof RecallError) || isolated.code !== 'invalid_pattern') throw isolated;
          throw this.patternFailure(isolated, terms.mode, [pattern]);
        }
      }
      // An error arising only from the combined expression belongs to that set.
      throw this.patternFailure(error, terms.mode, patterns);
    }
  }
  private patternFailure(error: RecallError, mode: SearchTerms['mode'], patterns: string[]): RecallError {
    const reason = error.message.split(/\r?\n/).filter(line => line.startsWith('error:')).at(-1)?.trim() ?? error.message;
    return new RecallError('invalid_pattern', error.message, true,
      'Correct the invalid pattern; reordering conditions or adding unrelated valid conditions does not correct it.',
      argumentsHash({ mode, patterns, reason }));
  }
  private async scanUnchecked(text: string, terms: SearchTerms, timeline: CallTimeline, unit: MatchUnit): Promise<{ start: number; end: number }[]> {
    const ranges: { start: number; end: number }[] = [], bytes = Buffer.from(text);
    const trace = performanceDiagnostics()?.begin('matcher.unit', { ...unit, callStartedMs: timeline.started, mode: terms.mode, patternCount: terms.patterns.length });
    trace?.count('inputBytes', bytes.length);
    let begin = 0, end = 0, summary = 0;
    try {
      await this.process(patternArgs(terms), text, timeline, line => {
        let event: any;
        try { event = JSON.parse(line); } catch { throw new RecallError('rg_output_invalid', 'rg emitted malformed JSON; this record is not complete.'); }
        if (event.type === 'begin') { if (end || summary || event.data?.path?.text !== '<stdin>') throw new RecallError('rg_output_invalid', 'rg begin does not identify the submitted stdin.'); begin++; }
        else if (event.type === 'end') { if (begin !== 1 || end || summary || event.data?.stats?.bytes_searched !== bytes.length) throw new RecallError('rg_output_invalid', 'rg did not account for the complete record input.'); end++; }
        else if (event.type === 'summary') {
          const stats = event.data?.stats;
          if (summary || !stats || stats.searches !== 1 || stats.bytes_searched !== bytes.length || stats.searches_with_match !== begin
            || !Number.isSafeInteger(stats.matches) || Boolean(stats.matches) !== Boolean(ranges.length)) throw new RecallError('rg_output_invalid', 'rg completion totals do not confirm a full scan.');
          summary++;
          const elapsed = stats.elapsed;
          if (Number.isFinite(elapsed?.secs) && Number.isFinite(elapsed?.nanos)) trace?.count('rgReportedSearchMs', elapsed.secs * 1000 + elapsed.nanos / 1e6);
        }
        else if (event.type === 'match') {
          if (begin !== 1 || end || summary || !Number.isSafeInteger(event.data?.absolute_offset) || !Array.isArray(event.data?.submatches)) throw new RecallError('rg_output_invalid', 'rg match ordering/offset is invalid.');
          const offset = event.data.absolute_offset;
          const lines = event.data.lines.text !== undefined ? Buffer.from(event.data.lines.text) : Buffer.from(event.data.lines.bytes, 'base64');
          if (offset < 0 || !bytes.subarray(offset, offset + lines.length).equals(lines)) throw new RecallError('rg_output_invalid', 'rg lines differ from the submitted native text.');
          for (const match of event.data.submatches) {
            const start = offset + match.start, finish = offset + match.end;
            const content = match.match.text !== undefined ? Buffer.from(match.match.text) : Buffer.from(match.match.bytes, 'base64');
            if (!Number.isSafeInteger(start) || !Number.isSafeInteger(finish) || start < 0 || finish < start || finish > bytes.length || !bytes.subarray(start, finish).equals(content)) throw new RecallError('rg_output_invalid', 'rg submatch cannot be mapped to native bytes.');
            ranges.push({ start, end: finish });
          }
        } else throw new RecallError('rg_output_invalid', 'Unexpected rg JSON event.');
      }, unit);
      if (summary !== 1 || begin !== end || begin > 1) throw new RecallError('rg_output_incomplete', 'rg did not confirm completion; partial record matches were discarded.');
      trace?.count('confirmedUnits', 1); trace?.count('spans', ranges.length); trace?.end();
      return ranges;
    } catch (error) { trace?.end('failed'); throw error; }
  }
  private async process(args: string[], input: string, timeline: CallTimeline, consume: (line: string) => void, unit: MatchUnit): Promise<void> {
    timeline.check();
    const trace = performanceDiagnostics()?.begin('matcher.process', { ...unit, callStartedMs: timeline.started });
    trace?.count('inputBytes', Buffer.byteLength(input));
    try {
      await new Promise<void>((resolve, reject) => {
        let child: ChildProcessWithoutNullStreams;
        try { child = this.launch(this.binary!, args, { windowsHide: true, shell: false, stdio: 'pipe' }) as ChildProcessWithoutNullStreams; }
        catch (error) { reject(error); return; }
        trace?.field('pid', child.pid ?? null);
        if (trace) {
          child.once('spawn', () => trace.mark('spawnEventMs'));
          child.stdin.once('finish', () => trace.mark('stdinFinishedMs'));
          child.once('exit', () => trace.mark('exitEventMs'));
        }
        if (child.pid) this.children.add(child.pid);
        let buffer = '', stderr = '', failure: unknown;
        const decoder = new StringDecoder('utf8');
        const abort = () => { trace?.mark('abortRequestedMs'); child.kill('SIGKILL'); };
        timeline.signal.addEventListener('abort', abort, { once: true });
        if (timeline.signal.aborted) abort();
        child.stdout.on('data', chunk => {
          trace?.mark('firstStdoutMs'); trace?.count('stdoutBytes', chunk.length);
          if (failure) return;
          const parseStart = trace ? performance.now() : 0;
          buffer += decoder.write(chunk);
          let at;
          try { while ((at = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, at); buffer = buffer.slice(at + 1); if (line) consume(line); } }
          catch (error) { failure = error; abort(); }
          finally { trace?.count('hostDecodeParseValidateMs', performance.now() - parseStart); }
        });
        child.stderr.on('data', chunk => { trace?.count('stderrBytes', chunk.length); stderr = (stderr + chunk.toString('utf8')).slice(0, 4000); });
        child.on('error', error => { failure ??= error; });
        child.stdin.on('error', error => { if ((error as NodeJS.ErrnoException).code !== 'EPIPE') failure ??= error; });
        child.on('close', (code, signal) => {
          trace?.mark('closeEventMs'); trace?.field('exitCode', code); trace?.field('exitSignal', signal);
          timeline.signal.removeEventListener('abort', abort); if (child.pid) this.children.delete(child.pid);
          child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
          try {
            timeline.check();
            if (failure) throw failure;
            if (signal || (code !== 0 && code !== 1)) throw new RecallError(code === 2 && stderr.includes('regex parse error') ? 'invalid_pattern' : 'rg_failed', stderr || `rg exited ${code ?? signal}`, code === 2 && stderr.includes('regex parse error'));
            const parseStart = trace ? performance.now() : 0;
            try { buffer += decoder.end(); if (buffer.trim()) consume(buffer); }
            finally { trace?.count('hostDecodeParseValidateMs', performance.now() - parseStart); }
            resolve();
          } catch (error) { reject(error); }
        });
        child.stdin.end(Buffer.from(input));
      });
      trace?.end();
    } catch (error) { trace?.end(timeline.signal.aborted ? 'cancelled' : 'failed'); throw error; }
  }
}
