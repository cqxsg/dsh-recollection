import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolatedEnvironment } from '../../support/isolation.mjs';

const run = await isolatedEnvironment('runtime-lifecycle'), patch = join(run.root, 'recall.patch.json');
await writeFile(patch, JSON.stringify([
  { id: 'spill-local', config: { root: join(run.home, 'spills'), cleanupPeriodDays: 0 } },
  { id: 'web-runtime', config: { openBrowser: false, printUrl: false } },
]));
const children = [];
for (const mode of ['create', 'recover']) {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('../runtime/children/runtime-lifecycle.mjs', import.meta.url)), mode, patch],
      { cwd: run.cwd, env: run.env, windowsHide: true, stdio: 'inherit' });
    children.push({ mode, pid: child.pid });
    const timer = setTimeout(() => { child.kill(); reject(new Error(`Combined lifecycle ${mode} timeout`)); }, 120_000);
    child.on('error', reject); child.on('exit', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`${mode} exited ${code}`)); });
  });
}
const before = JSON.parse(await readFile(join(run.root, 'before-restart.json'), 'utf8'));
const after = JSON.parse(await readFile(join(run.root, 'after-restart.json'), 'utf8'));
assert.equal(before.pid, children[0].pid); assert.equal(after.pid, children[1].pid);
await writeFile(join(run.root, 'lifecycle-evidence.json'), JSON.stringify({ children, before, after }, null, 2));
console.log(`PASS: combined runtime lifecycle and independent Host recovery: ${run.root}`);
