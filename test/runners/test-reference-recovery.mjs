import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolatedEnvironment } from '../../support/isolation.mjs';

const run = await isolatedEnvironment('reference-recovery'), patch = join(run.root, 'recall.patch.yml');
await writeFile(patch, JSON.stringify([
  { id: 'spill-local', config: { root: join(run.home, 'spills'), cleanupPeriodDays: 0 } },
  { id: 'web-runtime', config: { openBrowser: false, printUrl: false, surfaceContext: true } },
  { insert: [{ id: 'recall', name: new URL('../../lib/index.js', import.meta.url).href }] },
]));
const children = [], results = [];
for (const phase of ['before-first', 'partial', 'temp-synced', 'references', 'cursor', 'completed', 'delivered']) {
  for (const mode of ['crash', 'recover']) await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('../runtime/children/reference-recovery-runtime.mjs', import.meta.url)), patch, `${mode}:${phase}`],
      { cwd: run.cwd, env: run.env, windowsHide: true, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
    children.push({ mode, phase, pid: child.pid }); let checkpoint;
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`Reference/page recovery timed out: ${mode}:${phase}`)); }, 60000);
    child.on('message', value => {
      try { assert.equal(mode, 'crash'); assert.equal(value.phase, phase); checkpoint = value; child.kill('SIGKILL'); }
      catch (error) { child.kill('SIGKILL'); reject(error); }
    });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('exit', code => { clearTimeout(timer); if (checkpoint || mode === 'recover' && code === 0) resolve(); else reject(new Error(`${mode}:${phase} exited ${code}`)); });
  });
  results.push(JSON.parse(await readFile(join(run.root, `recovered-${phase}.json`), 'utf8')));
}
await writeFile(join(run.root, 'reference-page-process-evidence.json'), JSON.stringify({ children, results }, null, 2));
console.log(`PASS: seven reference/page publication and delivery crash windows: ${run.root}`);
