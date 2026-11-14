import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';

const { values } = parseArgs({ options: { input: { type: 'string', multiple: true }, output: { type: 'string' } } });
if (!values.input?.length || !values.output) throw new Error('Use --input report.json [--input report.json ...] --output summary.json');
const sources = [], rows = [], resources = [], groups = new Map();
const distribution = values => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b), n = sorted.length;
  return { n, min: sorted[0] ?? null, median: n ? (sorted[Math.floor((n - 1) / 2)] + sorted[Math.floor(n / 2)]) / 2 : null,
    max: sorted.at(-1) ?? null, empiricalP95: n >= 20 ? sorted[Math.ceil(0.95 * n) - 1] : null };
};
for (const path of values.input) {
  const bytes = await readFile(path), report = JSON.parse(bytes);
  if (report.mode !== 'performance' || !report.finishedAt) throw new Error(`Not a terminal performance report: ${path}`);
  const source = sources.length;
  sources.push({ path: resolve(path), sha256: createHash('sha256').update(bytes).digest('hex'), revision: report.revision,
    dirtyAtStart: report.dirtyAtStart, complete: report.complete, plannedTrials: report.plannedTrials, actualTrials: report.trials.length,
    startedAt: report.startedAt, finishedAt: report.finishedAt, environment: report.trials[0]?.environment });
  for (const [trial, value] of report.trials.entries()) {
    if (value.suite !== 'matrix') throw new Error('This summary requires the frozen matrix suite.');
    const row = { source, trial, repeat: value.repeat, profile: value.profile, records: value.records, benchmark: value.benchmark,
      querySet: value.querySet, sourceDigest: value.sourceDigest, evidence: value.evidence, trialComplete: value.trialComplete,
      infrastructureFailure: value.infrastructureFailure ?? null, diagnostics: value.diagnosticsEnabled, resources: !!value.processResources,
      gcAtMemoryBoundaries: value.gcAtMemoryBoundaries, metrics: value.metrics, hostResources: value.resources,
      diagnosticComparison: value.diagnosticComparison, resourceComparison: value.resourceComparison,
      diagnosticAggregates: value.diagnostics?.aggregates, diagnosticDroppedEvents: value.diagnostics?.droppedEvents,
      tools: value.tools.map(({ name, phase, query, status, code, elapsedMs, matchedRecords, matchMs, expectedHits, outputTokens, value: result }) =>
        ({ name, phase, query, status, code: code ?? null, elapsedMs, matchedRecords, matchMs, expectedHits, outputTokens,
          scanComplete: result?.scanComplete ?? false, scannedRecords: result?.scannedRecords ?? null, totalHits: result?.totalHits ?? null })),
      skipped: value.skipped };
    rows.push(row);
    const measurements = [...row.tools, ...row.skipped.map(item => ({ ...item, phase: 'hot', elapsedMs: null })),
      ...(value.metrics.preparation ? [{ phase: 'prepare', query: 'independent', ...value.metrics.preparation }] : [])];
    for (const measure of measurements) {
      const key = [source, row.profile, row.records, row.benchmark, measure.phase, measure.query, row.diagnostics, row.resources].join('/');
      if (!groups.has(key)) groups.set(key, { source, profile: row.profile, records: row.records, benchmark: row.benchmark,
        phase: measure.phase, query: measure.query, diagnostics: row.diagnostics, resources: row.resources, samples: [] });
      groups.get(key).samples.push({ trial, repeat: row.repeat, status: measure.status, code: measure.code ?? null,
        elapsedMs: measure.elapsedMs, validTrial: row.trialComplete && !row.infrastructureFailure });
    }
    if (value.processResources) {
      const p = value.processResources, children = p.processes.filter(p => p.kind === 'matcher');
      resources.push({ source, trial, records: value.records, benchmark: value.benchmark, complete: p.complete,
        intervalMs: p.intervalMs, environment: p.environment, failure: p.failure ?? null, elapsedMs: p.elapsedMs,
        registeredByHost: p.registeredByHost, droppedFrames: p.droppedFrames, droppedRecords: p.droppedRecords, stats: p.stats,
        owners: p.processes.filter(p => p.kind !== 'matcher'),
        detailCoverage: { rows: children.length, failed: children.filter(p => p.failure).length,
          cpuComplete: children.filter(p => p.cpuComplete).length, cpuUnknown: children.filter(p => p.cpuMs === null).length,
          zeroCpuCounters: children.filter(p => p.cpuMs === 0).length, aliveAtCaptureEnd: children.filter(p => p.aliveAtCaptureEnd).length,
          sumCpuMs: children.reduce((n, p) => n + (p.cpuMs ?? 0), 0), sampledRssMissing: children.filter(p => p.sampledPeakRssBytes === null).length } });
    }
  }
}
const result = { protocol: 'dsh-performance-summary-v1', sources,
  definition: 'All scheduled queries, including explicit skips, stay in each denominator. Successful latency excludes incomplete/failed/skipped work and invalid trials. Observed latency includes censored work. P95 is omitted below 20 successful samples.',
  groups: [...groups.values()].map(({ samples, ...group }) => ({ ...group, nScheduled: samples.length,
    statuses: Object.fromEntries([...new Set(samples.map(s => s.status))].map(status => [status, samples.filter(s => s.status === status).length])),
    invalidTrials: samples.filter(s => !s.validTrial).length,
    successfulMs: distribution(samples.filter(s => s.status === 'ok' && s.validTrial).map(s => s.elapsedMs)),
    observedMs: distribution(samples.map(s => s.elapsedMs)), samples })), resources, rows };
await writeFile(values.output, JSON.stringify(result, null, 2) + '\n');
console.log(`Summarized ${rows.length} trials from ${sources.length} terminal reports; retained ${result.groups.length} measurement groups.`);
