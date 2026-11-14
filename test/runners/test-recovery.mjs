import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolatedEnvironment } from '../../support/isolation.mjs';

const run = await isolatedEnvironment('recovery');
const patch = join(run.root, 'recall.patch.yml');
await writeFile(patch, JSON.stringify([
  { id: 'spill-local', config: { root: join(run.home, 'spills'), cleanupPeriodDays: 0 } },
  { id: 'web-runtime', config: { openBrowser: false, printUrl: false, surfaceContext: true } },
  { insert: [{ id: 'recall', name: new URL('../../lib/index.js', import.meta.url).href, config: { diagnostics: true } }] },
], null, 2));
console.log(`Recovery evidence: ${run.root}`);
const checkpoints = [];
const children = [];
async function launch(mode) {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('../runtime/children/recovery-runtime.mjs', import.meta.url)), patch, mode], { cwd: run.cwd, env: run.env, stdio: ['ignore', 'inherit', 'inherit', 'ipc'], windowsHide: true });
    children.push({ mode, pid: child.pid });
    let checkpoint;
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`Child timeout: ${mode}`)); }, 130_000);
    child.on('message', message => {
      try {
        assert.equal(mode, `crash:${message.checkpoint}`);
        assert.equal(message.actions, message.checkpoint === 'reserved' ? 0 : 1);
        checkpoint = message; checkpoints.push(message);
        // Abrupt process termination; no shutdown handler/finally is awaited.
        child.kill('SIGKILL');
      } catch (error) { child.kill('SIGKILL'); reject(error); }
    });
    child.on('error', reject);
    child.on('exit', code => {
      clearTimeout(timer);
      if (checkpoint || (!mode.startsWith('crash:') && code === 0)) resolve(); else reject(new Error(`${mode} exited ${code} without its expected completion`));
    });
  });
}
await launch('verify');
for (const phase of ['reserved', 'completed']) { await launch(`crash:${phase}`); await launch(`recover:${phase}`); }
assert.equal(new Set(children.map(child => child.pid)).size, 5);
await writeFile(join(run.root, 'process-evidence.json'), JSON.stringify({ checkpoints, children, isolatedHome: run.home }, null, 2));
console.log('PASS: native ledger suite and both abrupt independent-process restart windows');
