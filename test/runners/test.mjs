import { projectRoot } from '../../support/paths.mjs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isolatedEnvironment } from '../../support/isolation.mjs';
import { build } from 'esbuild';

await build({
  absWorkingDir: projectRoot,
  entryPoints: ['src/host/state/pages.ts', 'src/host/runtime/scheduler.ts', 'src/client/observer.ts', 'src/client/reporter.ts'],
  outdir: '.local/test-code', outbase: 'src',
  bundle: true, platform: 'node', format: 'esm', packages: 'external',
});

await import('../reference/build-reference.mjs');
const run = await isolatedEnvironment('tests');
const child = spawn(process.execPath, [
  '--test',
  '--test-timeout=30000',
  fileURLToPath(new URL('../integration/native-loading.test.mjs', import.meta.url)),
  fileURLToPath(new URL('../state/pages.test.mjs', import.meta.url)),
  fileURLToPath(new URL('../runtime/scheduler.test.mjs', import.meta.url)),
  fileURLToPath(new URL('../client/client.test.mjs', import.meta.url)),
  fileURLToPath(new URL('../performance/performance.test.mjs', import.meta.url)),
  fileURLToPath(new URL('../support/checkpoint.test.mjs', import.meta.url)),
  fileURLToPath(new URL('../performance/performance-corpus.test.mjs', import.meta.url)),
  fileURLToPath(new URL('../runtime/memory.test.mjs', import.meta.url)),
], { cwd: run.cwd, env: run.env, stdio: 'inherit', windowsHide: true });
child.on('error', error => { console.error(error); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
