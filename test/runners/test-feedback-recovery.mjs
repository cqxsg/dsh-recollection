import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolatedEnvironment } from '../../support/isolation.mjs';

const run = await isolatedEnvironment('feedback-recovery'), children = [], checkpoints = [];
const patches = {};
for (const mode of ['crash', 'recover']) {
  patches[mode] = join(run.root, `${mode}.patch.yml`);
  await writeFile(patches[mode], JSON.stringify([
    { id: 'spill-local', config: { root: join(run.home, 'spills'), cleanupPeriodDays: 0 } },
    { id: 'web-runtime', config: { openBrowser: false, printUrl: false, surfaceContext: true } },
    { insert: [{ id: 'recall', name: new URL('../../lib/index.js', import.meta.url).href, config: { recall: mode === 'recover' ? { shared: 99, searches: 99, freePages: 99 } : {} } }] },
  ]));
}
const phases = ['hidden', 'delivered', 'legacy-hidden', 'legacy-delivered', 'regex-delivered', 'legacy-closed', 'legacy-reference-hidden', 'legacy-reference-delivered'];
for (const phase of phases) {
  for (const mode of ['crash', 'recover']) {
    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [fileURLToPath(new URL('../runtime/children/feedback-recovery-runtime.mjs', import.meta.url)), patches[mode], `${mode}:${phase}`], { cwd: run.cwd, env: run.env, windowsHide: true, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
      children.push({ mode, phase, pid: child.pid }); let checkpoint;
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`Feedback recovery timeout ${mode}:${phase}`)); }, 60000);
      child.on('message', async message => {
        try {
          assert.equal(mode, 'crash'); assert.equal(message.checkpoint, phase);
          assert.equal(message.delivered, phase.endsWith('hidden') ? 0 : phase.endsWith('closed') ? 2 : 1);
          checkpoint = message; checkpoints.push(message);
          await writeFile(join(run.root, `checkpoint-${phase}.json`), JSON.stringify(message)); child.kill('SIGKILL');
        } catch (error) { child.kill('SIGKILL'); reject(error); }
      });
      child.on('error', reject);
      child.on('exit', code => { clearTimeout(timer); if (checkpoint || mode === 'recover' && code === 0) resolve(); else reject(new Error(`Feedback recovery ${mode}:${phase} exited ${code}`)); });
    });
    if (mode === 'crash' && phase.startsWith('legacy-')) {
      const path = join(run.home, 'storages', 'dsh_recall_business.json');
      const data = JSON.parse(await readFile(path, 'utf8'));
      const row = Object.values(data.tables.interactions).find(r => r.sessionId === `feedback-${phase}`);
      assert.ok(row); assert.ok(row.calls.every(c => c.invalidKey));
      if (phase.includes('reference')) {
        // Reproduce the old persisted key, which embedded model-facing recovery prose.
        for (const call of row.calls) {
          const current = call.invalidKey;
          const legacy = `read:stale_reference:Use an unchanged reference from this executing session; search again if unavailable.:${current.split(':').at(-1)}:`;
          row.invalid = row.invalid.map(key => key === current ? legacy : key);
          call.invalidKey = legacy;
        }
      } else for (const call of row.calls) delete call.invalidKey;
      await writeFile(path, JSON.stringify(data));
    }
  }
}
// Windows can reuse a PID after close. Verify the owned spawn/checkpoint pairs,
// not uniqueness of a numeric PID across sequential process lifetimes.
assert.equal(children.length, phases.length * 2); assert.equal(checkpoints.length, phases.length);
for (const phase of phases) {
  const recovered = JSON.parse(await readFile(join(run.root, `feedback-recovered-${phase}.json`), 'utf8'));
  assert.equal(checkpoints.find(c => c.checkpoint === phase).pid, children.find(c => c.phase === phase && c.mode === 'crash').pid);
  assert.equal(recovered.restoredPid, children.find(c => c.phase === phase && c.mode === 'recover').pid);
}
await writeFile(join(run.root, 'feedback-process-evidence.json'), JSON.stringify({ children, checkpoints }, null, 2));
console.log(`PASS: independent-process error feedback and legacy recovery: ${run.root}`);
