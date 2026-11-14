import { execFileSync } from 'node:child_process';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { isolatedEnvironment } from '../support/isolation.mjs';
import { projectRoot } from '../support/paths.mjs';
import { PROTOCOL, LIMITS, summary } from '../support/trial-report.mjs';
import { recoverTrial } from '../support/checkpoint.mjs';
import { runTrialProcess } from '../support/process.mjs';
import { SCALES, QUERIES, BOUNDARY_QUERIES } from './corpus.mjs';

const { values } = parseArgs({ options: { repeats: { type: 'string', default: '1' }, records: { type: 'string' },
  diagnostics: { type: 'string', default: 'off' }, 'diagnostic-max-events': { type: 'string', default: '8192' },
  'watchdog-ms': { type: 'string' }, 'gc-boundaries': { type: 'boolean', default: false },
  suite: { type: 'string', default: 'legacy' }, profile: { type: 'string', default: 'mixed' }, benchmark: { type: 'string', default: 'all' },
  queries: { type: 'string', default: 'primary' }, resources: { type: 'string', default: 'off' } } });
const mode = 'performance';
const repeats = Number(values.repeats), maxRepeats = 100;
if (!Number.isSafeInteger(repeats) || repeats < 1 || repeats > maxRepeats) throw new Error(`repeats must be 1..${maxRepeats}`);
if (!['off', 'on', 'compare'].includes(values.diagnostics)) throw new Error('diagnostics must be off, on or compare');
if (!['off', 'on', 'compare'].includes(values.resources)) throw new Error('resources must be off, on or compare');
if (values.resources === 'compare' && values.diagnostics === 'compare') throw new Error('Calibrate resource and diagnostic capture separately.');
if (!['legacy', 'matrix'].includes(values.suite) || !['mixed', 'legacy', 'all'].includes(values.profile) || !['all', 'search', 'prepare'].includes(values.benchmark)) throw new Error('Invalid suite selection');
if (!['primary', 'all'].includes(values.queries) && values.queries.split(',').some(id => ![...QUERIES, ...BOUNDARY_QUERIES].some(q => q.id === id))) throw new Error('Unknown manifest query');
if (new Set(values.queries.split(',')).size !== values.queries.split(',').length) throw new Error('Duplicate manifest query');
const diagnosticMaxEvents = Number(values['diagnostic-max-events']), trialWatchdogMs = Number(values['watchdog-ms'] ?? 300000);
if (!Number.isSafeInteger(diagnosticMaxEvents) || diagnosticMaxEvents < 0 || diagnosticMaxEvents > 100000) throw new Error('diagnostic-max-events must be 0..100000');
if (!Number.isSafeInteger(trialWatchdogMs) || trialWatchdogMs < 100 || trialWatchdogMs > 86400000) throw new Error('watchdog-ms must be 100..86400000; product deadlines remain unchanged');
const recordCount = values.records === undefined ? undefined : Number(values.records);
if (recordCount !== undefined && (!Number.isSafeInteger(recordCount) || recordCount < 1 || recordCount > 10000)) throw new Error('records must be 1..10000');
const run = await isolatedEnvironment('experiment-performance'), trials = [];
const report = { protocol: PROTOCOL, mode, suite: values.suite,
  revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: projectRoot, encoding: 'utf8', windowsHide: true }).trim(),
  dirtyAtStart: !!execFileSync('git', ['status', '--porcelain'], { cwd: projectRoot, encoding: 'utf8', windowsHide: true }).trim(), model: null,
  limits: LIMITS, repeats, startedAt: new Date().toISOString(), complete: false, trials, summary: [] };
const jobs = [];
for (let repeat = 0; repeat < repeats; repeat++) {
  for (const records of recordCount ? [recordCount] : values.suite === 'matrix' ? SCALES : [128, 512, 2048]) {
    const modes = values.diagnostics === 'compare' ? (repeat % 2 ? [true, false] : [false, true]) : [values.diagnostics === 'on'];
    const resourceModes = values.resources === 'compare' ? (repeat % 2 ? [true, false] : [false, true]) : [values.resources === 'on'];
    const profiles = values.suite === 'matrix' ? values.profile === 'all' ? ['legacy', 'mixed'] : [values.profile] : ['legacy'];
    const benchmarks = values.suite === 'matrix' ? values.benchmark === 'all' ? ['prepare', 'search'] : [values.benchmark] : ['legacy'];
    for (const profile of profiles) for (const benchmark of benchmarks) for (const diagnostics of modes) for (const resources of resourceModes)
      jobs.push({ mode, suite: values.suite, profile, benchmark, queries: values.queries, resources, repeat, records, diagnostics, diagnosticMaxEvents, trialWatchdogMs, gcAtBoundaries: values['gc-boundaries'] });
  }
}
report.plannedTrials = jobs.length;
for (const [index, job] of jobs.entries()) {
  const childRun = await isolatedEnvironment('experiment-performance-trials');
  const patchPath = join(childRun.root, 'experiment.patch.json'), specPath = join(childRun.root, 'spec.json'), output = join(childRun.root, 'result.json');
  const patch = [
    { id: 'web-runtime', config: { openBrowser: false, printUrl: false, surfaceContext: true } },
    { id: 'spill-local', config: { root: join(childRun.home, 'spills'), cleanupPeriodDays: 0 } },
    { id: 'session-title-llm', disabled: true }, { id: 'llm-retry', disabled: true },
    { id: 'tool-fs', disabled: false, config: { read: true, readImage: false, write: false, edit: false } },
    { insert: [{ id: 'recall', name: new URL('../lib/index.js', import.meta.url).href, config: { enabled: true } }] },
  ];
  await writeFile(patchPath, JSON.stringify(patch, null, 2));
  await writeFile(specPath, JSON.stringify({ ...job, patchPath, output }, null, 2));
  console.log(`[${index + 1}/${jobs.length}] ${job.task ?? job.records} ${job.arm ?? `${job.profile}/${job.benchmark} diagnostics=${job.diagnostics} resources=${job.resources}`} -> ${output}`);
  const { code, termination } = await runTrialProcess({ args: [...(job.gcAtBoundaries ? ['--expose-gc'] : []), fileURLToPath(new URL('./runtime.mjs', import.meta.url)), specPath],
    cwd: childRun.cwd, env: childRun.env, logPath: join(childRun.root, 'runtime.log'), watchdogMs: job.trialWatchdogMs + 30000 });
  const result = await recoverTrial(output, job, code, termination);
  if (values.diagnostics === 'compare' && !result.infrastructureFailure) {
    const control = trials.find(t => t.records === job.records && t.repeat === job.repeat && t.profile === result.profile && t.benchmark === result.benchmark && t.diagnosticsEnabled !== result.diagnosticsEnabled);
    if (control) {
      result.diagnosticComparison = { pairedEvidence: control.evidence, sourceEqual: control.sourceDigest === result.sourceDigest,
        semanticsEqual: control.semanticDigest === result.semanticDigest };
      if (!result.diagnosticComparison.sourceEqual || !result.diagnosticComparison.semanticsEqual) result.infrastructureFailure = 'diagnostic_pair_differs';
    }
  }
  if (values.resources === 'compare' && !result.infrastructureFailure) {
    const control = trials.find(t => t.records === job.records && t.repeat === job.repeat && t.profile === result.profile && t.benchmark === result.benchmark && !!t.processResources !== !!result.processResources);
    if (control) {
      result.resourceComparison = { pairedEvidence: control.evidence, sourceEqual: control.sourceDigest === result.sourceDigest, semanticsEqual: control.semanticDigest === result.semanticDigest };
      if (!result.resourceComparison.sourceEqual || !result.resourceComparison.semanticsEqual) result.infrastructureFailure = 'resource_pair_differs';
    }
  }
  trials.push({ ...result, repeat: job.repeat, evidence: output }); report.summary = summary(trials);
  await mkdir(run.root, { recursive: true }); await writeFile(join(run.root, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(result.grade ?? { failure: result.infrastructureFailure, metrics: result.metrics }));
  if (code !== 0 || result.infrastructureFailure) { process.exitCode = 1; break; }
}
report.complete = trials.length === jobs.length && !trials.some(t => t.infrastructureFailure);
report.finishedAt = new Date().toISOString();
await writeFile(join(run.root, 'report.json'), JSON.stringify(report, null, 2));
console.log(`Experiment report: ${join(run.root, 'report.json')}`);
