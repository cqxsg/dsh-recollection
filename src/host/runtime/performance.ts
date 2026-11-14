import { performance } from 'node:perf_hooks';

export type PerformanceKind = 'matcher.process' | 'matcher.unit' | 'preparation.batch' | 'preparation.acquire'
  | 'preparation.fingerprint' | 'records.classify' | 'records.descriptors' | 'records.layouts'
  | 'records.compare' | 'records.select' | 'records.extract';
type Fields = Record<string, string | number | boolean | null>;
interface SpanRow {
  id: number; kind: PerformanceKind; startedMs: number; durationMs: number | null; outcome: string | null;
  fields: Fields; marks: Record<string, number>; counters: Record<string, number>;
}
interface Aggregate { started: number; completed: number; failed: number; durationMsSum: number; maxDurationMs: number; counters: Record<string, number>; }
interface PerformanceSnapshot {
  protocol: string; pid: number; clock: string; startedMs: number; elapsedMs: number; hostCpuMicroseconds: NodeJS.CpuUsage;
  maxEvents: number; maxPending: number; active: number; untrackedPending: number; droppedEvents: number;
  aggregates: Partial<Record<PerformanceKind, Aggregate>>; events: SpanRow[]; pending: SpanRow[];
  unmeasured: { childCpu: null; childRss: null; simultaneousTreeRss: null; cliCompileMs: null; reason: string };
}
let current: PerformanceCapture | undefined;

/** Host-only opt-in. No Remote/model configuration and no source text or native objects. */
export function performanceDiagnostics(): PerformanceCapture | undefined { return current; }
export function startPerformanceCapture(options: { maxEvents?: number; maxPending?: number } = {}): PerformanceCapture {
  if (current) throw new Error('A performance capture is already active in this Host.');
  const capture = new PerformanceCapture(options.maxEvents ?? 8192, options.maxPending ?? 128);
  current = capture;
  return capture;
}

export class PerformanceSpan {
  private ended = false;
  constructor(private readonly capture: PerformanceCapture, readonly row: SpanRow) {}
  mark(name: string) { this.row.marks[name] ??= performance.now() - this.row.startedMs; }
  count(name: string, value: number) { this.row.counters[name] = (this.row.counters[name] ?? 0) + value; }
  field(name: string, value: Fields[string]) { this.row.fields[name] = value; }
  end(outcome = 'ok') {
    if (this.ended) return;
    this.ended = true;
    this.row.durationMs = performance.now() - this.row.startedMs;
    this.row.outcome = outcome;
    this.capture.finish(this.row);
  }
}

export class PerformanceCapture {
  private readonly began = performance.now();
  private readonly cpu = process.cpuUsage();
  private readonly events: SpanRow[] = [];
  private readonly pending = new Map<number, SpanRow>();
  private readonly aggregates = new Map<PerformanceKind, Aggregate>();
  private serial = 0;
  private active = 0;
  private droppedEvents = 0;
  private untrackedPending = 0;
  private stopped: PerformanceSnapshot | undefined;
  constructor(private readonly maxEvents: number, private readonly maxPending: number) {
    if (![maxEvents, maxPending].every(n => Number.isSafeInteger(n) && n >= 0 && n <= 100000)) throw new RangeError('Invalid diagnostic event limits.');
  }
  begin(kind: PerformanceKind, fields: Fields = {}): PerformanceSpan {
    if (this.stopped) throw new Error('Performance capture is stopped.');
    const row: SpanRow = { id: ++this.serial, kind, startedMs: performance.now(), durationMs: null, outcome: null,
      fields: { ...fields }, marks: {}, counters: {} };
    const aggregate = this.aggregates.get(kind) ?? { started: 0, completed: 0, failed: 0, durationMsSum: 0, maxDurationMs: 0, counters: {} };
    aggregate.started++; this.aggregates.set(kind, aggregate); this.active++;
    if (this.pending.size < this.maxPending) this.pending.set(row.id, row); else this.untrackedPending++;
    return new PerformanceSpan(this, row);
  }
  finish(row: SpanRow) {
    if (this.stopped) return;
    this.active--;
    if (!this.pending.delete(row.id)) this.untrackedPending--;
    const aggregate = this.aggregates.get(row.kind)!;
    aggregate.completed++; if (row.outcome !== 'ok') aggregate.failed++;
    aggregate.durationMsSum += row.durationMs!; aggregate.maxDurationMs = Math.max(aggregate.maxDurationMs, row.durationMs!);
    for (const [key, value] of Object.entries(row.counters)) aggregate.counters[key] = (aggregate.counters[key] ?? 0) + value;
    if (this.events.length < this.maxEvents) this.events.push(row); else this.droppedEvents++;
  }
  snapshot(): PerformanceSnapshot {
    return this.stopped ?? structuredClone({ protocol: 'dsh-recall-performance-v1', pid: process.pid,
      clock: 'process-local performance.now milliseconds; overlapping spans must not be summed as wall/CPU time',
      startedMs: this.began, elapsedMs: performance.now() - this.began, hostCpuMicroseconds: process.cpuUsage(this.cpu),
      maxEvents: this.maxEvents, maxPending: this.maxPending, active: this.active, untrackedPending: this.untrackedPending,
      droppedEvents: this.droppedEvents, aggregates: Object.fromEntries(this.aggregates), events: this.events, pending: [...this.pending.values()],
      unmeasured: { childCpu: null, childRss: null, simultaneousTreeRss: null, cliCompileMs: null,
        reason: 'Span recorder only. See the separate processResources capture when enabled; CLI has no compilation/readiness handshake.' } });
  }
  stop() {
    if (current === this) current = undefined;
    this.stopped ??= this.snapshot();
    this.events.length = 0; this.pending.clear(); this.aggregates.clear();
    return this.stopped;
  }
}
