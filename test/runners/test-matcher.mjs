import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isolatedEnvironment } from '../../support/isolation.mjs';
const run = await isolatedEnvironment('matcher');
const child = spawn(process.execPath, ['--test', '--test-timeout=30000', fileURLToPath(new URL('../retrieval/matcher.test.mjs', import.meta.url)), fileURLToPath(new URL('../runtime/worker-pool.test.mjs', import.meta.url))], { cwd: run.cwd, env: run.env, windowsHide: true, stdio: 'inherit' });
child.on('error', error => { console.error(error); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
