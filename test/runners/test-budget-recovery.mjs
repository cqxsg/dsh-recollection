import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolatedEnvironment } from '../../support/isolation.mjs';

const run = await isolatedEnvironment('budget-recovery');
const patch = join(run.root, 'recall.patch.yml');
await writeFile(patch, JSON.stringify([
  { id: 'spill-local', config: { root: join(run.home, 'spills'), cleanupPeriodDays: 0 } },
  { id: 'web-runtime', config: { openBrowser: false, printUrl: false, surfaceContext: true } },
  { insert: [{ id: 'recall', name: new URL('../../lib/index.js', import.meta.url).href, config: { enabled: false } }] },
]));
const children = [], checkpoints = [];
for (const phase of ['reserved', 'completed']) for (const mode of ['crash', 'recover']) {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('../runtime/children/budget-recovery-runtime.mjs', import.meta.url)), patch, `${mode}:${phase}`], { cwd: run.cwd, env: run.env, stdio: ['ignore', 'inherit', 'inherit', 'ipc'], windowsHide: true });
    children.push({ pid: child.pid, mode, phase }); let checkpoint;
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Budget recovery child timed out')); }, 50000);
    child.on('message', message => {
      try { assert.equal(message.checkpoint, phase); assert.equal(message.actions, phase === 'reserved' ? 0 : 1); checkpoint = message; checkpoints.push(message); child.kill('SIGKILL'); }
      catch (error) { child.kill('SIGKILL'); reject(error); }
    });
    child.on('error', reject);
    child.on('exit', code => { clearTimeout(timer); if (checkpoint || (mode === 'recover' && code === 0)) resolve(); else reject(new Error(`Budget child ${mode}:${phase} exited ${code}`)); });
  });
}
assert.equal(new Set(children.map(c => c.pid)).size, 4);
await writeFile(join(run.root, 'business-process-evidence.json'), JSON.stringify({ checkpoints, children }, null, 2));
console.log(`PASS: independent-process business budget recovery: ${run.root}`);
