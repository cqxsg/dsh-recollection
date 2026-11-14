import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolatedEnvironment } from '../../support/isolation.mjs';

const run = await isolatedEnvironment('hash-recovery'), patch = join(run.root, 'recall.patch.yml');
await writeFile(patch, JSON.stringify([
  { id: 'spill-local', config: { root: join(run.home, 'spills'), cleanupPeriodDays: 0 } },
  { id: 'web-runtime', config: { openBrowser: false, printUrl: false, surfaceContext: true } },
  { insert: [{ id: 'recall', name: new URL('../../lib/index.js', import.meta.url).href, config: { enabled: false } }] },
]));
const children = [], checkpoints = [];
for (const phase of ['registered', 'reserved', 'paused', 'saved', 'exhausted']) for (const mode of ['crash', 'recover']) {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('../runtime/children/hash-recovery-runtime.mjs', import.meta.url)), patch, `${mode}:${phase}`], { cwd: run.cwd, env: run.env, stdio: ['ignore', 'inherit', 'inherit', 'ipc'], windowsHide: true });
    children.push({ pid: child.pid, mode, phase }); let checkpoint;
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Hash recovery timeout')); }, 45000);
    child.on('message', message => {
      try { assert.equal(message.phase, phase); if (['registered', 'reserved', 'exhausted'].includes(phase)) assert.equal(message.reads, 0); checkpoint = message; checkpoints.push(message); child.kill('SIGKILL'); }
      catch (error) { child.kill('SIGKILL'); reject(error); }
    });
    child.on('error', reject);
    child.on('exit', code => { clearTimeout(timer); if (checkpoint || mode === 'recover' && code === 0) resolve(); else reject(new Error(`Hash process ${mode}:${phase} exited ${code}`)); });
  });
}
assert.equal(new Set(children.map(c => c.pid)).size, 10);
await writeFile(join(run.root, 'hash-process-evidence.json'), JSON.stringify({ children, checkpoints }, null, 2));
console.log(`PASS: five independent-process hash recovery windows: ${run.root}`);
