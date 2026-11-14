import { projectRoot } from '../../support/paths.mjs';
import { mkdir, readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { ensureRust, local, rustVersion, target } from './native-toolchain.mjs';

const root = projectRoot, worker = join(root, 'native/worker');
const sysroot = await ensureRust(), cargoHome = join(local, 'cargo'), output = join(local, 'native-build');
await mkdir(output, { recursive: true });
const rebuild = process.argv.includes('--rebuild');
const targetDir = rebuild ? await mkdtemp(join(local, 'native-rebuild-')) : join(local, 'native-target');
const env = { ...process.env, CARGO_HOME: cargoHome, RUSTC: join(sysroot, 'bin/rustc.exe'),
  RUSTDOC: join(sysroot, 'bin/rustdoc.exe'), CARGO_TARGET_DIR: targetDir,
  CARGO_ENCODED_RUSTFLAGS: ['-C', 'link-arg=-Wl,--no-insert-timestamp', '--remap-path-prefix', `${root}=/dsh-recollection`,
    '--remap-path-prefix', `${cargoHome}=/cargo`].join('\x1f') };
const mingw = join(sysroot, 'lib/rustlib', target, 'bin/self-contained');
env.CARGO_ENCODED_RUSTFLAGS += ['','-C', `dlltool=${join(sysroot, 'lib/rustlib', target, 'bin/llvm-dlltool.exe')}`].join('\x1f');
// Never accidentally use an unrelated system (possibly 32-bit) MinGW.
const inheritedPath = process.env.PATH ?? process.env.Path ?? '';
for (const key of Object.keys(env)) if (key.toLowerCase() === 'path') delete env[key];
env.PATH = `${mingw};${join(sysroot, 'bin')};${inheritedPath}`;
env.CARGO_TARGET_X86_64_PC_WINDOWS_GNU_LINKER = join(mingw, 'x86_64-w64-mingw32-gcc.exe');
const run = args => new Promise((resolve, reject) => {
  const child = spawn(join(sysroot, 'bin/cargo.exe'), args, { cwd: worker, env, stdio: 'inherit', windowsHide: true });
  child.on('error', reject); child.on('close', code => code === 0 ? resolve() : reject(new Error(`cargo exited ${code}`)));
});
// Lock creation is an explicit maintainer operation. Normal builds never update it.
if (process.argv.includes('--update-lock')) await run(['update', '--workspace']);
const source = createHash('sha256');
for (const path of ['Cargo.toml', 'Cargo.lock', 'src/main.rs', 'src/budget.rs']) {
  source.update(path).update('\0').update((await readFile(join(worker, path), 'utf8')).replace(/\r\n/g, '\n')).update('\0');
}
const build = source.digest('hex'); env.DSH_WORKER_BUILD = build;
await run(['build', '--release', '--locked', '--target', target, ...(process.argv.includes('--offline') ? ['--offline'] : [])]);
const executable = join(env.CARGO_TARGET_DIR, target, 'release/dsh-recollection-worker.exe');
const sha256 = createHash('sha256').update(await readFile(executable)).digest('hex');
const manifest = { protocol: 1, build, sha256, executable, rustVersion, target,
  ripgrep: '15.2.0', source: 'e89fff89ac9af12e8d4ce9d5fd07beb408ca730f',
  flags: env.CARGO_ENCODED_RUSTFLAGS.split('\x1f'), features: 'default features of the four pinned grep crates; serde/derive; sha2/default' };
if (rebuild) {
  const original = JSON.parse(await readFile(join(output, 'manifest.json'), 'utf8'));
  if (original.sha256 !== sha256 || original.build !== build) throw new Error(`Rebuild differs: ${JSON.stringify({ original, rebuilt: manifest })}`);
  await writeFile(join(output, 'rebuild.json'), JSON.stringify(manifest, null, 2) + '\n');
} else await writeFile(join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify(manifest));
