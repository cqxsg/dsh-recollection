import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolatedEnvironment } from '../../support/isolation.mjs';
const run = await isolatedEnvironment('recall-recovery'), children = [], checkpoints = [];
const patches = {};
for (const mode of ['crash', 'recover']) {
  patches[mode] = join(run.root, `${mode}.patch.yml`);
  await writeFile(patches[mode], JSON.stringify([
    { id: 'spill-local', config: { root: join(run.home, 'spills'), cleanupPeriodDays: 0 } },
    { id: 'web-runtime', config: { openBrowser: false, printUrl: false, surfaceContext: true } },
    { insert: [{ id: 'recall', name: new URL('../../lib/index.js', import.meta.url).href, config: { recall: mode === 'recover' ? { shared: 99, searches: 99, freePages: 99 } : {} } }] },
  ]));
}
const phases = process.argv.length > 2 ? process.argv.slice(2) : ['reserved', 'page', 'completed', 'delivery', 'last-r'];
assert.ok(phases.every(phase => ['reserved', 'page', 'completed', 'delivery', 'last-r'].includes(phase)));
for (const phase of phases) for (const mode of ['crash', 'recover']) await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [fileURLToPath(new URL('../runtime/children/recall-recovery-runtime.mjs', import.meta.url)), patches[mode], `${mode}:${phase}`], { cwd: run.cwd, env: run.env, windowsHide: true, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
  children.push({ mode, phase, pid: child.pid }); let checkpoint;
  const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`Product recovery timeout ${mode}:${phase}`)); }, 100000);
  child.on('message', async message => {
    try {
      assert.equal(message.checkpoint, phase); assert.equal(message.actions, ['reserved', 'last-r'].includes(phase) ? 0 : 1);
      checkpoint = message; checkpoints.push(message);
      await writeFile(join(run.root, `checkpoint-${phase}.json`), JSON.stringify(message)); child.kill('SIGKILL');
    } catch (error) { child.kill('SIGKILL'); reject(error); }
  });
  child.on('error', reject);
  child.on('exit', code => { clearTimeout(timer); if (checkpoint || mode === 'recover' && code === 0) resolve(); else reject(new Error(`Product recovery ${mode}:${phase} exited ${code}`)); });
});
assert.equal(new Set(children.map(c => c.pid)).size, phases.length * 2);
await writeFile(join(run.root, 'product-process-evidence.json'), JSON.stringify({ children, checkpoints }, null, 2)); console.log(`Product process evidence: ${run.root}`);
