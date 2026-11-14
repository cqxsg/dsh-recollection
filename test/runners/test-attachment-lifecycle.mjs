import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolatedEnvironment } from '../../support/isolation.mjs';

const run = await isolatedEnvironment('attachment-lifecycle'), children = [];
for (const mode of ['prepare', 'recover', 'relocate']) {
  const patch = join(run.root, `${mode}.patch.yml`);
  await writeFile(patch, JSON.stringify([
    { id: 'spill-local', config: { root: join(run.home, mode === 'relocate' ? 'new-spills' : 'old-spills'), cleanupPeriodDays: 0 } },
    { id: 'web-runtime', config: { openBrowser: false, printUrl: false, surfaceContext: true } },
    { insert: [{ id: 'recall', name: new URL('../../lib/index.js', import.meta.url).href, config: { recall: mode === 'prepare' ? {} : { shared: 99, hashAttempts: 9, hashActiveMs: 60000 } } }] },
  ]));
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('../runtime/children/attachment-lifecycle-runtime.mjs', import.meta.url)), patch, mode], { cwd: run.cwd, env: run.env, windowsHide: true, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
    children.push({ mode, pid: child.pid }); let checkpoint;
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`Attachment lifecycle timed out: ${mode}`)); }, 120000);
    child.on('message', async message => {
      try {
        assert.equal(mode, 'prepare'); assert.equal(message.kind, 'reserved-live-hash'); assert.ok(message.pending.reserved); assert.equal(message.pending.attempts, 1);
        await writeFile(join(run.root, 'checkpoint.json'), JSON.stringify(message, null, 2)); checkpoint = message; child.kill('SIGKILL');
      } catch (error) { child.kill('SIGKILL'); reject(error); }
    });
    child.on('error', reject);
    child.on('exit', code => { clearTimeout(timer); if (checkpoint || mode !== 'prepare' && code === 0) resolve(); else reject(new Error(`Attachment lifecycle ${mode} exited ${code}`)); });
  });
}
assert.equal(new Set(children.map(c => c.pid)).size, 3);
const results = await Promise.all(['recover', 'relocate'].map(async mode => JSON.parse(await readFile(join(run.root, `${mode}-evidence.json`), 'utf8'))));
await writeFile(join(run.root, 'attachment-lifecycle-evidence.json'), JSON.stringify({ children, results }, null, 2));
console.log(`PASS: real attachment/spill/hash/budget lifecycle across three Host processes: ${run.root}`);
