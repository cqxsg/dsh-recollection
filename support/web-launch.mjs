import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolatedEnvironment } from './isolation.mjs';

/** Shared parent launch; import DSH only in the child after isolation. */
export async function launchWeb({ label = 'web', persistent = true, patch = [], args = [], nodeArgs = [] } = {}) {
  const run = await isolatedEnvironment(label, { persistent });
  // JSON is a YAML subset and preserves Windows paths without YAML escaping.
  const patchPath = join(run.root, 'recall.patch.yml');
  await writeFile(patchPath, JSON.stringify([
    { id: 'spill-local', config: { root: join(run.home, 'spills'), cleanupPeriodDays: 0 } },
    ...patch,
  ], null, 2));
  console.log(`Isolated DSH home: ${run.home}`);
  console.log(`Isolated workspace: ${run.cwd}`);
  const child = spawn(process.execPath, [
    ...nodeArgs,
    fileURLToPath(new URL('../scripts/dev/web-runtime.mjs', import.meta.url)), patchPath, ...args,
  ], { cwd: run.cwd, env: run.env, stdio: 'inherit', windowsHide: true });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
  child.on('error', error => { console.error(error); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
  return child;
}
