import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolatedEnvironment } from '../../support/isolation.mjs';

const phases = process.argv.length > 2 ? process.argv.slice(2) : ['pending', 'claimed', 'admitted'];
assert.ok(phases.every(phase => ['pending', 'claimed', 'admitted'].includes(phase)));
const run = await isolatedEnvironment('recall-command-recovery'), patch = join(run.root, 'patch.json'), children = [], checkpoints = [];
await writeFile(patch, JSON.stringify([
  { id: 'spill-local', config: { root: join(run.home, 'spills'), cleanupPeriodDays: 0 } },
  { id: 'web-runtime', config: { openBrowser: false, printUrl: false } },
  { insert: [{ id: 'recall', name: new URL('../../lib/index.js', import.meta.url).href, config: { prewarm: false, attachmentHashing: false } }] },
]));
console.log(`Command recovery root: ${run.root}`);
for (const phase of phases) for (const mode of ['crash', 'recover']) {
  const started = performance.now();
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('../runtime/children/recall-command-recovery.mjs', import.meta.url)), patch, `${mode}:${phase}`],
      { cwd: run.cwd, env: run.env, windowsHide: true, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
    const record = { mode, phase, pid: child.pid }; children.push(record);
    let checkpoint;
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`command recovery timeout ${mode}:${phase}`)); }, 100000);
    child.on('message', async message => {
      try {
        assert.equal(mode, 'crash'); assert.equal(message.checkpoint, phase);
        assert.equal(message.admitted, phase === 'admitted');
        assert.equal(message.charged, phase === 'admitted' ? 1 : 0);
        checkpoint = message; checkpoints.push(message);
        await writeFile(join(run.root, `checkpoint-${phase}.json`), JSON.stringify(message, null, 2) + '\n');
        child.kill('SIGKILL');
      } catch (error) { child.kill('SIGKILL'); reject(error); }
    });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('exit', code => {
      clearTimeout(timer); record.exitCode = code; record.elapsedMs = performance.now() - started; record.checkpointReached = Boolean(checkpoint);
      if (checkpoint || mode === 'recover' && code === 0) resolve(); else reject(new Error(`command recovery ${mode}:${phase} exited ${code}`));
    });
  });
}
assert.equal(new Set(children.map(c => c.pid)).size, phases.length * 2);
await writeFile(join(run.root, 'process-evidence.json'), JSON.stringify({ children, checkpoints }, null, 2) + '\n');
