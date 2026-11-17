import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { writeFile, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolatedEnvironment } from '../../support/isolation.mjs';

// RC4a investigation only: never installed in a user's profile or exported in a package.
const run = await isolatedEnvironment('recall-presentation-probe');
const patch = join(run.root, 'probe.patch.json');
await writeFile(patch, JSON.stringify([
  { id: 'spill-local', config: { root: join(run.home, 'spills'), cleanupPeriodDays: 0 } },
  { id: 'web-runtime', config: { openBrowser: false, printUrl: false, surfaceContext: true } },
  { insert: [
    { id: 'recall', name: new URL('../../lib/index.js', import.meta.url).href, config: { prewarm: false, attachmentHashing: false } },
    { id: 'recall-test-probe', name: new URL('../fixtures/browser-probe/index.mjs', import.meta.url).href },
  ] },
], null, 2));
console.log(`RC4a isolated root: ${run.root}`);
const results = [];
for (const mode of ['probe', 'reopen']) {
  const started = Date.now(), log = join(run.root, `${mode}.log`);
  const child = spawn(process.execPath, [fileURLToPath(new URL('../runtime/children/recall-presentation-probe.mjs', import.meta.url)), patch, mode], {
    cwd: run.cwd, env: run.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let writes = Promise.resolve();
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => {
    process.stdout.write(chunk);
    writes = writes.then(() => appendFile(log, chunk));
  });
  const timer = setTimeout(() => child.kill(), 180_000);
  const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve); });
  clearTimeout(timer); await writes;
  results.push({ mode, code, elapsedMs: Date.now() - started, log });
  await writeFile(join(run.root, 'runner-results.json'), JSON.stringify(results, null, 2));
  assert.equal(code, 0, `${mode} probe failed; evidence retained at ${run.root}`);
}
