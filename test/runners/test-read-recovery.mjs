import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolatedEnvironment } from '../../support/isolation.mjs';
const run = await isolatedEnvironment('read-recovery'), patch = join(run.root, 'recall.patch.yml');
await writeFile(patch, JSON.stringify([
  { id: 'spill-local', config: { root: join(run.home, 'spills'), cleanupPeriodDays: 0 } },
  { id: 'web-runtime', config: { openBrowser: false, printUrl: false, surfaceContext: true } },
  { insert: [{ id: 'recall', name: new URL('../../lib/index.js', import.meta.url).href }] },
]));
for (const mode of ['prepare', 'verify']) await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [fileURLToPath(new URL('../runtime/children/read-recovery-runtime.mjs', import.meta.url)), patch, mode], { cwd: run.cwd, env: run.env, windowsHide: true, stdio: 'inherit' });
  child.on('error', reject); child.on('exit', code => code === 0 ? resolve() : reject(new Error(`read recovery ${mode} failed: ${code}`)));
});
console.log(`Read process evidence: ${join(run.root, 'read-process-evidence.json')}`);
