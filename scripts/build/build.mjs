import { projectRoot } from '../../support/paths.mjs';
import { build } from 'esbuild';
import { readFile, mkdir, copyFile, cp } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { verifyNativeNotices } from './native-notice-files.mjs';

const root = projectRoot;
const pkg = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
const common = {
  absWorkingDir: root,
  bundle: true,
  sourcemap: true,
  logLevel: 'info',
  target: 'es2022',
};

const { spawn } = await import('node:child_process');
await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, ['scripts/build/build-native.mjs'], { cwd: root, stdio: 'inherit', windowsHide: true });
  child.on('error', reject); child.on('close', code => code === 0 ? resolve() : reject(new Error('Worker build failed')));
});
const manifest = JSON.parse(await readFile(new URL('../../.local/native-build/manifest.json', import.meta.url), 'utf8'));
await verifyNativeNotices(join(root, 'native/third-party'), {
  cargoLock: join(root, 'native/worker/Cargo.lock'), rustVersion: manifest.rustVersion, target: manifest.target,
});
await mkdir(new URL('../../lib/native/', import.meta.url), { recursive: true });
const packagedWorker = new URL('../../lib/native/worker.exe', import.meta.url);
const installedHash = await readFile(packagedWorker).then(bytes => createHash('sha256').update(bytes).digest('hex'), () => undefined);
if (installedHash !== manifest.sha256) await copyFile(manifest.executable, packagedWorker);
await cp(new URL('../../native/third-party/', import.meta.url), new URL('../../lib/native/third-party/', import.meta.url), { recursive: true });
await (await import('node:fs/promises')).writeFile(new URL('../../lib/native/manifest.json', import.meta.url), JSON.stringify({ ...manifest, executable: 'worker.exe', flags: undefined }, null, 2) + '\n');

await build({
  ...common,
  entryPoints: ['src/index.ts', 'src/prewarm.ts'],
  outdir: 'lib',
  platform: 'node',
  format: 'esm',
  packages: 'external',
});

// rc.4 browser bundles register a lazy CJS factory; they are not ESM scripts.
// Cordis must come from the page's singleton module table, never be bundled.
const client = await build({
  ...common,
  entryPoints: ['src/client/index.ts'],
  outfile: 'lib/client.js',
  platform: 'browser',
  format: 'cjs',
  external: ['@deepseek-ai/cordis', 'zod'],
  metafile: true,
  write: false,
  banner: { js: `window.__ModuleLoader__.load({ id: ${JSON.stringify(pkg.name)}, factory: (require) => {\nvar module = { exports: {} }; var exports = module.exports;` },
  footer: { js: 'return module.exports;\n} });' },
});
// Fail loudly when a future import needs a new module-table declaration.
const permitted = new Set(['@deepseek-ai/cordis', 'zod', ...(pkg.dsh.client.external ?? [])]);
for (const output of Object.values(client.metafile.outputs)) {
  for (const dependency of output.imports) {
    if (!dependency.external || !permitted.has(dependency.path)) {
      throw new Error(`Undeclared client dependency: ${dependency.path}`);
    }
  }
}
const { writeFile } = await import('node:fs/promises');
for (const output of client.outputFiles) await writeFile(output.path, output.contents);
