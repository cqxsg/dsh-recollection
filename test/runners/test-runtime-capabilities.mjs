import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolatedEnvironment } from '../../support/isolation.mjs';

const modes = process.argv.slice(2);
for (const mode of modes.length ? modes : ['hash-off', 'hash-init-failure', 'hash-init-paused', 'diagnostic-failure', 'prompt-absent', 'prompt-failure', 'visibility-failure', 'hash-read-failure', 'hash-paused']) {
  const run = await isolatedEnvironment(`capabilities-${mode}`), patch = join(run.root, 'patch.json');
  await writeFile(patch, JSON.stringify([
    { id: 'spill-local', config: { root: join(run.home, 'spills'), cleanupPeriodDays: 0 } },
    { id: 'web-runtime', config: { openBrowser: false, printUrl: false } },
  ]));
  const code = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('../runtime/children/runtime-capabilities.mjs', import.meta.url)), mode, patch],
      { cwd: run.cwd, env: run.env, windowsHide: true, stdio: 'inherit' });
    const timer = setTimeout(() => { child.kill(); reject(new Error(`capability ${mode} timeout`)); }, 120_000);
    child.on('error', reject); child.on('exit', code => { clearTimeout(timer); resolve(code); });
  });
  assert.equal(code, 0, mode);
  console.log(`PASS: runtime capability ${mode}: ${run.root}`);
}
