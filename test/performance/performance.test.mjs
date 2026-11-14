import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { checkpointWriter, recoverTrial } from '../../support/checkpoint.mjs';
import { runTrialProcess } from '../../support/process.mjs';
import { isolatedEnvironment } from '../../support/isolation.mjs';
import { performanceDiagnostics, startPerformanceCapture } from '../../lib/index.js';

test('diagnostics are opt-in, bounded and keep aggregate failures after event overflow', () => {
  assert.equal(performanceDiagnostics(), undefined);
  const capture = startPerformanceCapture({ maxEvents: 2, maxPending: 1 });
  try {
    assert.throws(() => startPerformanceCapture(), /already active/);
    const spans = Array.from({ length: 9 }, () => performanceDiagnostics().begin('matcher.unit', { purpose: 'test' }));
    assert.equal(capture.snapshot().pending.length, 1);
    assert.equal(capture.snapshot().untrackedPending, 8);
    spans.forEach((span, i) => { span.count('inputBytes', 3); span.end(i % 2 ? 'failed' : 'ok'); span.end(); });
    const snapshot = capture.snapshot();
    assert.equal(snapshot.active, 0); assert.equal(snapshot.untrackedPending, 0);
    assert.equal(snapshot.events.length, 2); assert.equal(snapshot.droppedEvents, 7);
    assert.equal(snapshot.aggregates['matcher.unit'].completed, 9);
    assert.equal(snapshot.aggregates['matcher.unit'].failed, 4);
    assert.equal(snapshot.aggregates['matcher.unit'].counters.inputBytes, 27);
    assert.equal(snapshot.unmeasured.childCpu, null);
  } finally { capture.stop(); }
  assert.equal(performanceDiagnostics(), undefined);
  assert.throws(() => capture.begin('matcher.unit'), /stopped/);
});

test('stopping during an operation preserves an explicitly unfinished span', () => {
  const capture = startPerformanceCapture(), span = capture.begin('matcher.process');
  const stopped = capture.stop(); span.end();
  assert.equal(stopped.active, 1); assert.equal(stopped.pending[0].durationMs, null);
  assert.deepEqual(capture.stop(), stopped);
});

test('atomic checkpoints preserve prior metrics after truncated output and do not claim trial completion', async () => {
  const run = await isolatedEnvironment('performance-unit'), output = join(run.root, 'result.json');
  const persist = checkpointWriter(`${output}.checkpoint.json`);
  const pending = { stage: 'cold-search', tools: [{ status: 'ok' }], metrics: { preparation: 12 }, trialComplete: false };
  await persist(pending);
  await writeFile(output, '{truncated'); await writeFile(`${output}.checkpoint.json.tmp`, '{truncated');
  const recovered = await recoverTrial(output, {}, 2, 'parent_watchdog');
  assert.equal(recovered.recoveredCheckpoint, true); assert.equal(recovered.trialComplete, false);
  assert.deepEqual(recovered.tools, pending.tools); assert.equal(recovered.infrastructureFailure, 'parent_watchdog');
  await Promise.all([persist({ order: 1 }), persist({ order: 2 }), persist({ order: 3 })]);
  assert.equal(JSON.parse(await readFile(`${output}.checkpoint.json`, 'utf8')).order, 3);
  await checkpointWriter(output)({ trialComplete: true, metrics: { measured: 42 } });
  const forced = await recoverTrial(output, {}, 1, 'parent_watchdog_forced_tree');
  assert.equal(forced.trialComplete, false); assert.equal(forced.metrics.measured, 42);
});

test('parent watchdog requests shutdown and recovers the last checkpoint', async () => {
  const run = await isolatedEnvironment('performance-unit'), output = join(run.root, 'result.json'), child = join(run.root, 'child.mjs');
  const writerUrl = new URL('../../support/checkpoint.mjs', import.meta.url).href;
  await writeFile(child, `import { checkpointWriter } from ${JSON.stringify(writerUrl)};
    await checkpointWriter(process.argv[2] + '.checkpoint.json')({ stage: 'measuring', metrics: { completed: 3 } });
    process.on('message', message => { if (message.type === 'experiment-stop') process.exit(2); });
    setInterval(() => {}, 1000);`);
  const result = await runTrialProcess({ args: [child, output], cwd: run.cwd, env: run.env,
    logPath: join(run.root, 'runtime.log'), watchdogMs: 1000, graceMs: 2000 });
  assert.equal(result.termination, 'parent_watchdog'); assert.equal(result.code, 2);
  const recovered = await recoverTrial(output, {}, result.code, result.termination);
  assert.equal(recovered.metrics.completed, 3); assert.equal(recovered.trialComplete, false);
});

test('forced watchdog terminates the isolated child tree, retaining measured evidence', async () => {
  const run = await isolatedEnvironment('performance-unit'), output = join(run.root, 'result.json'), child = join(run.root, 'child.mjs');
  await writeFile(child, `import { spawn } from 'node:child_process';
    import { writeFile } from 'node:fs/promises';
    const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { windowsHide: true, stdio: 'ignore' });
    await writeFile(process.argv[2] + '.checkpoint.json', JSON.stringify({ childPid: grandchild.pid, metrics: { completed: 7 } }));
    setInterval(() => {}, 1000);`);
  const result = await runTrialProcess({ args: [child, output], cwd: run.cwd, env: run.env,
    logPath: join(run.root, 'runtime.log'), watchdogMs: 1000, graceMs: 200 });
  assert.equal(result.termination, 'parent_watchdog_forced_tree');
  const recovered = await recoverTrial(output, {}, result.code, result.termination);
  assert.equal(recovered.metrics.completed, 7); assert.equal(recovered.trialComplete, false);
  assert.throws(() => process.kill(recovered.childPid, 0), error => error.code === 'ESRCH');
});
