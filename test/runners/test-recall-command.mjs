import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolatedEnvironment } from '../../support/isolation.mjs';

const available = ['native', 'disabled', 'missing', 'conflict', 'registration-failure', 'prompt-absent'];
const modes = process.argv.length > 2 ? process.argv.slice(2) : available;
assert.ok(modes.every(mode => available.includes(mode)), 'unknown recall command scenario');
for (const mode of modes) {
  const run = await isolatedEnvironment(`recall-command-${mode}`), patch = join(run.root, 'patch.json');
  await writeFile(patch, JSON.stringify([
    { id: 'spill-local', config: { root: join(run.home, 'spills'), cleanupPeriodDays: 0 } },
    { id: 'web-runtime', config: { openBrowser: false, printUrl: false } },
  ]));
  console.log(`Command ${mode} root: ${run.root}`);
  const startedAt = new Date().toISOString(), started = performance.now();
  const exitCode = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('../runtime/children/recall-command-runtime.mjs', import.meta.url)), mode, patch],
      { cwd: run.cwd, env: run.env, windowsHide: true, stdio: 'inherit' });
    const timer = setTimeout(() => { child.kill(); reject(new Error(`recall command ${mode} timeout`)); }, 180_000);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('exit', code => { clearTimeout(timer); resolve(code); });
  });
  await writeFile(join(run.root, 'process-evidence.json'), JSON.stringify({ mode, startedAt, elapsedMs: performance.now() - started, exitCode }, null, 2) + '\n');
  assert.equal(exitCode, 0, mode);
}
