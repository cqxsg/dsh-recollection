import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolatedEnvironment } from '../../support/isolation.mjs';

const run = await isolatedEnvironment('cursor-recovery'), patch = join(run.root, 'recall.patch.yml');
await writeFile(patch, JSON.stringify([
  { id: 'spill-local', config: { root: join(run.home, 'spills'), cleanupPeriodDays: 0 } },
  { id: 'web-runtime', config: { openBrowser: false, printUrl: false, surfaceContext: true } },
  { insert: [{ id: 'recall', name: new URL('../../lib/index.js', import.meta.url).href }] },
]));
const children = [], checkpoints = [], results = [];
for (const phase of ['before-write', 'temp-synced', 'mapped', 'completed', 'delivered']) {
  for (const mode of ['crash', 'recover']) await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('../runtime/children/cursor-recovery-runtime.mjs', import.meta.url)), patch, `${mode}:${phase}`],
      { cwd: run.cwd, env: run.env, stdio: ['ignore', 'inherit', 'inherit', 'ipc'], windowsHide: true });
    children.push({ pid: child.pid, mode, phase }); let checkpoint;
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`Cursor recovery timed out: ${mode}:${phase}`)); }, 60000);
    child.on('message', message => {
      try { assert.equal(mode, 'crash'); assert.equal(message.phase, phase); checkpoint = message; checkpoints.push(message); child.kill('SIGKILL'); }
      catch (error) { child.kill('SIGKILL'); reject(error); }
    });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('exit', code => { clearTimeout(timer); if (checkpoint || mode === 'recover' && code === 0) resolve(); else reject(new Error(`Cursor child ${mode}:${phase} exited ${code}`)); });
  });
  results.push(JSON.parse(await readFile(join(run.root, `recovered-${phase}.json`), 'utf8')));
}
assert.equal(new Set(children.map(child => child.pid)).size, 10);
await writeFile(join(run.root, 'cursor-process-evidence.json'), JSON.stringify({ children, checkpoints, results }, null, 2));
console.log(`PASS: five cursor publication/delivery crash windows with independent-process recovery: ${run.root}`);
