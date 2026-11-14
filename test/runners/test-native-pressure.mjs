import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isolatedEnvironment } from '../../support/isolation.mjs';

// Isolate before importing the product or any native DSH services.
const run = await isolatedEnvironment('native-pressure-host');
const child = spawn(process.execPath, [fileURLToPath(new URL('../../benchmarks/stress-native.mjs', import.meta.url)), '--production'], {
  cwd: run.cwd, env: run.env, windowsHide: true, stdio: 'inherit',
});
child.on('error', error => { console.error(error); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
