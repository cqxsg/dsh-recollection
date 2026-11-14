import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { checkpointWriter } from '../../support/checkpoint.mjs';
import { isolatedEnvironment } from '../../support/isolation.mjs';

async function lockReplacement(target, environment) {
  const script = `[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$stream = [System.IO.File]::Open($env:DSH_CHECKPOINT_LOCK_TARGET, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read)
try {
  [Console]::Out.WriteLine('locked')
  [Console]::Out.Flush()
  [Console]::In.ReadLine() | Out-Null
} finally { $stream.Dispose() }
`;
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...environment, DSH_CHECKPOINT_LOCK_TARGET: target },
  });
  const closed = new Promise(resolve => child.once('close', resolve));
  const lines = createInterface({ input: child.stdout });
  let stderr = '';
  child.stderr.on('data', value => { stderr = (stderr + value).slice(-2000); });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Lock helper timed out: ${stderr}`)), 5000);
      const finish = error => { clearTimeout(timer); error ? reject(error) : resolve(); };
      lines.once('line', value => finish(value === 'locked' ? undefined : new Error(value)));
      child.once('error', finish);
      child.once('exit', code => finish(new Error(`Lock helper exited ${code}: ${stderr}`)));
    });
  } catch (error) { child.kill(); await closed; throw error; }
  finally { lines.close(); }
  return async () => { child.stdin.end('\n'); await closed; };
}

test('Windows checkpoint replacement survives a reader lock and preserves ordered atomic writes', { skip: process.platform !== 'win32', timeout: 10000 }, async () => {
  const run = await isolatedEnvironment('checkpoint-unit'), path = join(run.root, 'checkpoint.json');
  const persist = checkpointWriter(path);
  await persist({ generation: 0, complete: true });
  const release = await lockReplacement(path, run.env);
  let settled = false;
  const writes = Promise.all([persist({ generation: 1 }), persist({ generation: 2 })]).finally(() => { settled = true; });
  void writes.catch(() => {});
  try {
    await delay(100);
    assert.equal(settled, false);
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { generation: 0, complete: true });
  } finally { await release(); }
  await writes;
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { generation: 2 });
});

test('a persistent Windows reader lock fails within a bound without removing the last checkpoint', { skip: process.platform !== 'win32', timeout: 10000 }, async () => {
  const run = await isolatedEnvironment('checkpoint-unit'), path = join(run.root, 'checkpoint.json');
  const persist = checkpointWriter(path), previous = { generation: 0, measured: 42 };
  await persist(previous);
  const release = await lockReplacement(path, run.env), started = performance.now();
  try {
    await assert.rejects(persist({ generation: 1 }), error => ['EPERM', 'EACCES', 'EBUSY'].includes(error.code));
    assert.ok(performance.now() - started < 5000, 'replacement failure must remain bounded');
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), previous);
    assert.deepEqual(JSON.parse(await readFile(`${path}.tmp`, 'utf8')), { generation: 1 });
  } finally { await release(); }
});
