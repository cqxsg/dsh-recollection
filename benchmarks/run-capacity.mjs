import { projectRoot } from '../support/paths.mjs';
import { parseArgs } from 'node:util';
import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { isolatedEnvironment } from '../support/isolation.mjs';
import { runTrialProcess } from '../support/process.mjs';

const { values } = parseArgs({ options: { minutes: { type: 'string', default: '0' }, rounds: { type: 'string', default: '1' },
  records: { type: 'string', default: '10000' }, histories: { type: 'string', default: '20' }, 'gc-diagnostic': { type: 'boolean', default: false },
  'heap-snapshots': { type: 'boolean', default: false }, 'cache-mib': { type: 'string' } } });
const recall = values['cache-mib'] === undefined ? {} : { cacheMiB: Number(values['cache-mib']) };
if (recall.cacheMiB !== undefined && (!Number.isSafeInteger(recall.cacheMiB) || recall.cacheMiB < 1 || recall.cacheMiB > 1024)) throw new Error('cache-mib must be an integer from 1 through 1024');
const minutes = Number(values.minutes), rounds = Number(values.rounds), records = Number(values.records), histories = Number(values.histories);
if (!Number.isFinite(minutes) || minutes < 0 || minutes > 180 || !Number.isSafeInteger(rounds) || rounds < 1 || rounds > 100
  || !Number.isSafeInteger(records) || records < 8 || records > 10000 || !Number.isSafeInteger(histories) || histories < 3 || histories > 20) throw new Error('Invalid capacity workload');
if (values['gc-diagnostic'] && rounds < 4) throw new Error('GC diagnostic requires a warm round and at least three identical full rotations');
if (values['heap-snapshots'] && !values['gc-diagnostic']) throw new Error('Heap snapshots are a separate forced-GC debugging run only');
const run = await isolatedEnvironment('capacity'), output = join(run.root, 'result.json'), patchPath = join(run.root, 'capacity.patch.json'), specPath = join(run.root, 'spec.json');

const git = args => execFileSync('git', args, { cwd: projectRoot, encoding: 'utf8', windowsHide: true }).trim();
const productTreeRef = `HEAD:${git(['rev-parse', '--show-prefix']).replace(/\/$/, '')}`;
const revision = git(['rev-parse', 'HEAD']), productTree = git(['rev-parse', productTreeRef]);
const changedPaths = git(['status', '--porcelain', '--untracked-files=all']).split('\n').filter(Boolean);
const dirtyAtStart = changedPaths.length > 0, productDirtyAtStart = !!git(['status', '--porcelain', '--untracked-files=all', '--', '.']);
const bundleDigest = async () => createHash('sha256').update(await readFile(new URL('../lib/index.js', import.meta.url))).digest('hex');
const bundleSha256 = await bundleDigest();
const trialWatchdogMs = Math.max(600000, minutes * 60000 + rounds * 600000 + 300000);
const spec = { mode: 'performance', suite: 'capacity', durationMs: minutes * 60000, rounds, records, histories,
  gcDiagnostic: values['gc-diagnostic'], heapSnapshots: values['heap-snapshots'], recall, resources: true, resourceIntervalMs: 100, trialWatchdogMs, output, patchPath };
await writeFile(patchPath, JSON.stringify([
  { id: 'web-runtime', config: { openBrowser: false, printUrl: false, surfaceContext: true } },
  { id: 'spill-local', config: { root: join(run.home, 'spills'), cleanupPeriodDays: 0 } },
  { id: 'session-title-llm', disabled: true }, { id: 'llm-retry', disabled: true },
  { id: 'tool-fs', disabled: false, config: { read: true, readImage: false, write: false, edit: false } },
  { insert: [{ id: 'recall', name: new URL('../lib/index.js', import.meta.url).href, config: { enabled: true, recall } }] },
], null, 2));
await writeFile(specPath, JSON.stringify(spec, null, 2));
console.log(`Capacity report: ${output}`);
const startedAt = new Date().toISOString();
const processResult = await runTrialProcess({ args: [...(spec.gcDiagnostic ? ['--expose-gc'] : []), fileURLToPath(new URL('./runtime.mjs', import.meta.url)), specPath],
  cwd: run.cwd, env: run.env, logPath: join(run.root, 'runtime.log'), watchdogMs: trialWatchdogMs + 30000 });
const report = JSON.parse(await readFile(output, 'utf8'));
const measured = report.processResources;
const productDirtyAtEnd = !!git(['status', '--porcelain', '--untracked-files=all', '--', '.']);
report.capacityRun = { revision, productTree, dirtyAtStart, changedPaths, productDirtyAtStart, productDirtyAtEnd, bundleSha256,
  sourceStable: !productDirtyAtStart && !productDirtyAtEnd && productTree === git(['rev-parse', productTreeRef]) && bundleSha256 === await bundleDigest(),
  startedAt, finishedAt: new Date().toISOString(), process: processResult, spec };
report.capacityAcceptance = { completed: report.trialComplete && processResult.code === 0, fullWorkset: records === 10000 && histories === 20,
  normalHour: !spec.gcDiagnostic && report.workloadMs >= 3600000, resourcesComplete: !!measured?.complete && !measured.droppedRecords,
  sampledTreeWithinGiB: measured?.stats?.sampledTreePeakBytes <= 1024 ** 3, rssTargetIsAdvisory: true, workloadChecks: report.acceptance };
await writeFile(output, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ capacityAcceptance: report.capacityAcceptance, counters: report.counters, workloadMs: report.workloadMs,
  treePeakBytes: measured?.stats?.sampledTreePeakBytes, heapWindows: report.windows?.map(w => ({ round: w.round, heapUsed: w.memory.heapUsed, gcDiagnostic: w.gcDiagnostic })) }));
console.log(`Capacity report: ${output}`);
if (processResult.code || !report.trialComplete || !report.acceptance?.correct || !report.capacityAcceptance.resourcesComplete
  || spec.gcDiagnostic && !report.acceptance.forcedGcHeapStable) process.exitCode = 1;
