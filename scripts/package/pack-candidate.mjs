import { projectRoot } from '../../support/paths.mjs';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { readFile, writeFile, mkdir, mkdtemp, rename, access, copyFile, cp } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { parseArgs } from 'node:util';
import { sha256, verifyPackage } from './candidate-package.mjs';
import { createCompatibilityManifest, compatibilityReadme } from './compatibility-package.mjs';

const root = projectRoot;
const npm = process.env.npm_execpath;
assert.ok(npm, 'Run through npm run pack:candidate so the selected npm executable is recorded.');
assert.equal(process.platform, 'win32'); assert.equal(process.arch, 'x64');
const { values } = parseArgs({ options: { 'compat-version': { type: 'string' } } });
const sourcePackage = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const compatibilityTest = values['compat-version'] !== undefined;
const pkg = compatibilityTest ? createCompatibilityManifest(sourcePackage, values['compat-version']) : sourcePackage;
const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'));
assert.equal(lock.name, sourcePackage.name);
assert.equal(lock.version, sourcePackage.version);
for (const key of ['name', 'version', 'license', 'engines', 'os', 'cpu', 'peerDependencies', 'devDependencies']) {
  assert.deepEqual(lock.packages[''][key], sourcePackage[key], `Lockfile differs: ${key}`);
}
assert.equal(pkg.name, 'dsh-recollection');
assert.match(pkg.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
const parent = join(root, '.local', 'releases', pkg.name), destination = join(parent, pkg.version);
await mkdir(parent, { recursive: true });
try { await access(destination); throw new Error(`Candidate ${pkg.version} already exists; use a new version. Nothing overwritten.`); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true }).trim();
assert.equal(git('status', '--porcelain', '--untracked-files=all', '--', '.'), '', 'Commit project changes before freezing a candidate.');
const sourceCommit = git('rev-parse', 'HEAD');
const paths = git('ls-files', '--', '.').split('\n').filter(path =>
  /^(src\/|locale\/|native\/|scripts\/|benchmarks\/|experiments\/(?:run|freeze-parameters)\.mjs$|support\/|test\/runners\/|test\/runtime\/children\/|test\/reference\/(?:build-reference|native-client)\.mjs$|package(?:-lock)?\.json$|tsconfig(?:\.client)?\.json$|cordis\.patch\.yml$|README\.md$|LICENSE$)/.test(path));
const snapshot = async () => Promise.all(paths.map(async path => ({ path, sha256: sha256(await readFile(join(root, path))) })));
const sources = await snapshot();
const scratch = await mkdtemp(join(parent, `.building-${pkg.version}-`));
const run = (command, args, log, cwd = root) => {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', windowsHide: true,
    maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  const output = String(result.stdout ?? '') + String(result.stderr ?? '');
  if (log || result.error || result.status !== 0) writeFileSync(join(scratch, log ?? 'failed-command.log'), output);
  if (result.error || result.status !== 0) throw result.error ?? new Error(`Command failed (${result.status}); see ${scratch}`);
  return result.stdout;
};
console.log(`Building candidate ${pkg.version} from ${sourceCommit}; staging ${scratch}`);
run(process.execPath, [npm, 'run', 'build'], 'build.log');
const packageRoot = compatibilityTest ? join(scratch, 'package-source') : root;
if (compatibilityTest) {
  await mkdir(packageRoot);
  for (const path of ['lib', 'locale', 'cordis.patch.yml', 'LICENSE']) await cp(join(root, path), join(packageRoot, path), { recursive: true });
  await writeFile(join(packageRoot, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
  await writeFile(join(packageRoot, 'README.md'), compatibilityReadme(pkg));
}
const packText = run(process.execPath, [npm, 'pack', '--ignore-scripts', '--json', '--pack-destination', scratch], undefined, packageRoot);
const [pack] = JSON.parse(packText);
assert.equal(pack.name, pkg.name); assert.equal(pack.version, pkg.version);
assert.equal(pack.filename, `${pkg.name}-${pkg.version}.tgz`);
const tarball = join(scratch, pack.filename);
const listed = run('tar.exe', ['-tf', tarball]).trim().split(/\r?\n/).filter(Boolean);
for (const path of listed) assert.ok(path.startsWith('package/') && !path.split('/').includes('..') && !path.includes('\\'), `Unsafe archive entry: ${path}`);
const extracted = join(scratch, 'unpacked'); await mkdir(extracted);
run('tar.exe', ['-xf', tarball, '-C', extracted]);
const payload = await verifyPackage(join(extracted, 'package'), pkg, [root.replace(/[\\/]$/, ''), homedir(), scratch], { compatibilityTest });
assert.deepEqual(payload.files.map(f => f.path).sort(), pack.files.map(f => f.path).sort());
for (const file of payload.files) {
  const sourceRoot = compatibilityTest && ['package.json', 'README.md'].includes(file.path) ? packageRoot : root;
  assert.equal(file.sha256, sha256(await readFile(join(sourceRoot, file.path))), `Packed file differs from build: ${file.path}`);
}
assert.deepEqual(await snapshot(), sources, 'Source changed during candidate build.');
assert.equal(git('rev-parse', 'HEAD'), sourceCommit, 'HEAD changed during candidate build.');
assert.equal(git('status', '--porcelain', '--untracked-files=all', '--', '.'), '', 'Harness changed during candidate build.');
const tarHash = sha256(await readFile(tarball));
const manifest = {
  schemaVersion: 1, createdAt: new Date().toISOString(), name: pkg.name, version: pkg.version,
  purpose: compatibilityTest ? 'compatibility-test' : 'release-candidate',
  status: compatibilityTest ? 'Local compatibility test package; installation and runtime validation pending' : 'Packaged and inspected; installation acceptance pending',
  package: { sourceVersion: sourcePackage.version, private: pkg.private === true, engines: pkg.engines, peerDependencies: pkg.peerDependencies },
  source: { commit: sourceCommit, harnessWorktreeDiff: '', files: sources },
  tools: { node: process.version, npm: run(process.execPath, [npm, '--version']).trim(), platform: process.platform, arch: process.arch,
    typescript: JSON.parse(await readFile(join(root, 'node_modules/typescript/package.json'))).version,
    esbuild: JSON.parse(await readFile(join(root, 'node_modules/esbuild/package.json'))).version,
    dsh: JSON.parse(await readFile(join(root, 'node_modules/@deepseek-ai/dsh/package.json'))).version,
    rust: payload.worker.rustVersion, target: payload.worker.target, tar: run('tar.exe', ['--version']).trim() },
  archive: { file: pack.filename, sha256: tarHash, bytes: (await readFile(tarball)).length, unpackedBytes: pack.unpackedSize },
  files: payload.files, worker: payload.worker,
};
// Publish only delivery files; keep build log and extracted inspection tree in scratch.
const delivery = join(scratch, 'delivery'); await mkdir(delivery);
await copyFile(tarball, join(delivery, pack.filename));
await copyFile(join(extracted, 'package/README.md'), join(delivery, 'INSTALL.md'));
await writeFile(join(delivery, 'build-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
const checksumNames = [pack.filename, 'build-manifest.json', 'INSTALL.md'];
await writeFile(join(delivery, 'SHA256SUMS'), (await Promise.all(checksumNames.map(async name => `${sha256(await readFile(join(delivery, name)))}  ${name}`))).join('\n') + '\n');
await rename(delivery, destination); // Fails instead of overwriting an existing nonempty candidate.
console.log(JSON.stringify({ destination: resolve(destination), sha256: tarHash, files: payload.files.length, inspection: scratch }, null, 2));
