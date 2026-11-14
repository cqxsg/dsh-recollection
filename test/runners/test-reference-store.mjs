import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolatedEnvironment } from '../../support/isolation.mjs';

const run = await isolatedEnvironment('reference-store'), patch = join(run.root, 'recall.patch.yml');
await writeFile(patch, JSON.stringify([
  { id: 'spill-local', config: { root: join(run.home, 'spills'), cleanupPeriodDays: 0 } },
  { id: 'web-runtime', config: { openBrowser: false, printUrl: false, surfaceContext: true } },
  { insert: [{ id: 'recall', name: new URL('../../lib/index.js', import.meta.url).href, config: { enabled: false, prewarm: false } }] },
]));
const children = [], checkpoints = [];
for (const spec of ['suite', ...['before-write', 'temp-synced', 'mapped'].flatMap(phase => [`crash:${phase}`, `recover:${phase}`])]) {
  const [mode, phase] = spec.split(':');
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('../runtime/children/reference-store-runtime.mjs', import.meta.url)), patch, spec],
      { cwd: run.cwd, env: run.env, windowsHide: true, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
    children.push({ spec, pid: child.pid }); let checkpoint;
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`Reference check timed out: ${spec}`)); }, 60000);
    child.on('message', message => {
      try { assert.equal(mode, 'crash'); assert.equal(message.phase, phase); checkpoint = message; checkpoints.push(message); child.kill('SIGKILL'); }
      catch (error) { child.kill('SIGKILL'); reject(error); }
    });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('exit', code => { clearTimeout(timer); if (checkpoint || mode !== 'crash' && code === 0) resolve(); else reject(new Error(`Reference child ${spec} exited ${code}`)); });
  });
}
const results = await Promise.all(['before-write', 'temp-synced', 'mapped'].map(async phase => JSON.parse(await readFile(join(run.root, `reference-recovered-${phase}.json`), 'utf8'))));
await writeFile(join(run.root, 'reference-process-evidence.json'), JSON.stringify({ children, checkpoints, results }, null, 2));
console.log(`PASS: reference store native checks and three process crash windows: ${run.root}`);
