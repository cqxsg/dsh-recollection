import { mkdir, readFile, writeFile, cp } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';

export const rustVersion = '1.90.0', target = 'x86_64-pc-windows-gnu';
const components = {
  cargo: 'b7806005e41b7733b1f4ec9111b43c2590e1535a7713644660346161cdc71c46',
  rustc: '925e67ef4684861eb301d123a45292a63a0afba49060b60e3264f73c7f9cc1ec',
  'rust-std': 'd82b3240908390cef1ddb88d2d922fa6d5e8abb6e6ef1d47948ec503ba694bf5',
  'rust-mingw': '3254c05b7a7f8edc915a78b11dafd5395f9bc94b2c6a24016294470190e1f77c',
  'llvm-tools': '18fdd467837bc5fc9e68e1b9d83dfd9d147684afbf4bf9aa79988515c5f92a71',
};
export const local = fileURLToPath(new URL('../../.local/', import.meta.url));
export async function ensureRust() {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('The validated native build targets Windows x64 only.');
  const root = join(local, 'rust', `${rustVersion}-${target}`), sysroot = join(root, 'sysroot');
  const complete = join(root, 'installed.json'), signature = JSON.stringify({ rustVersion, target, components });
  try { if (await readFile(complete, 'utf8') === signature) return sysroot; } catch {}
  await mkdir(root, { recursive: true }); await mkdir(sysroot, { recursive: true });
  for (const [component, sha256] of Object.entries(components)) {
    const name = `${component}-${rustVersion}-${target}`, archive = join(root, `${name}.tar.xz`);
    let bytes; try { bytes = await readFile(archive); } catch {}
    if (!bytes || createHash('sha256').update(bytes).digest('hex') !== sha256) {
      console.log(`Downloading verified ${name}`);
      const response = await fetch(`https://static.rust-lang.org/dist/2025-09-18/${name}.tar.xz`, { signal: AbortSignal.timeout(180000) });
      if (!response.ok) throw new Error(`Toolchain download: ${response.status}`);
      bytes = Buffer.from(await response.arrayBuffer());
      if (createHash('sha256').update(bytes).digest('hex') !== sha256) throw new Error(`Checksum mismatch: ${name}`);
      await writeFile(archive, bytes);
    }
    const unpack = spawnSync('python', [fileURLToPath(new URL('./extract-rust.py', import.meta.url)), archive, root, name], { encoding: 'utf8', windowsHide: true, timeout: 180000 });
    if (unpack.status !== 0) throw new Error(`Extraction failed: ${unpack.stderr}`);
    await cp(join(root, name, component === 'rust-std' ? `${component}-${target}` : component === 'llvm-tools' ? 'llvm-tools-preview' : component), sysroot, { recursive: true });
  }
  // Upstream llvm-ar dispatches to the dlltool driver by executable basename.
  const llvmBin = join(sysroot, 'lib/rustlib', target, 'bin');
  await cp(join(llvmBin, 'llvm-ar.exe'), join(llvmBin, 'llvm-dlltool.exe'));
  const check = spawnSync(join(sysroot, 'bin', 'rustc.exe'), ['--version'], { encoding: 'utf8', windowsHide: true });
  if (check.status !== 0 || !check.stdout.startsWith(`rustc ${rustVersion} `)) throw new Error(`Toolchain verification failed: ${check.stderr}`);
  await writeFile(complete, signature); return sysroot;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(await ensureRust());
