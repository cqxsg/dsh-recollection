import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureRust, local, rustVersion, target } from './native-toolchain.mjs';
import { noticeHash, noticeText, verifyNativeNotices } from './native-notice-files.mjs';

const root = fileURLToPath(new URL('../../native/third-party/', import.meta.url));
const worker = fileURLToPath(new URL('../../native/worker/', import.meta.url));
const cargoLock = join(worker, 'Cargo.lock');
const rustLicenses = ['BSD-2-Clause', 'LLVM-exception', 'NCSA', 'Unicode-3.0'];

export async function collectNativeNotices() {
  const sysroot = await ensureRust();
  const metadata = spawnSync(join(sysroot, 'bin/cargo.exe'), ['metadata', '--locked', '--offline', '--format-version=1', '--filter-platform', target], {
    cwd: worker, windowsHide: true, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, CARGO_HOME: join(local, 'cargo'), RUSTC: join(sysroot, 'bin/rustc.exe') },
  });
  if (metadata.error || metadata.status !== 0) throw metadata.error ?? new Error(metadata.stderr);
  const graph = JSON.parse(metadata.stdout), packages = [], documents = new Map();
  const content = async (path, component) => {
    const text = noticeText(await readFile(path)), sha256 = noticeHash(text);
    // Formatting may differ; never remove or combine different copyright words.
    const key = noticeHash(text.replace(/[ \t\r\n]+/g, ' ').trim());
    if (!documents.has(key)) documents.set(key, { id: `notice-${String(documents.size + 1).padStart(2, '0')}`, sha256, origins: [], text });
    const entry = documents.get(key);
    entry.origins.push({ component, file: basename(path), sha256 });
    return entry.id;
  };
  for (const pkg of graph.packages.filter(p => !graph.workspace_members.includes(p.id)).sort((a, b) => a.name.localeCompare(b.name))) {
    const paths = new Set();
    if (pkg.license_file) paths.add(resolve(dirname(pkg.manifest_path), pkg.license_file));
    for (let directory = dirname(pkg.manifest_path), depth = 0; depth < 4; depth++, directory = dirname(directory)) {
      const names = (await readdir(directory, { withFileTypes: true })).filter(f => f.isFile() && /^(LICENSE|LICENCE|COPYING|COPYRIGHT|UNLICENSE|NOTICE)([.\-_]|$)/i.test(f.name));
      for (const name of names.sort((a, b) => a.name.localeCompare(b.name))) paths.add(join(directory, name.name));
      if (paths.size) break;
    }
    if (!paths.size) throw new Error(`No upstream notice found for ${pkg.name}`);
    const notices = [];
    for (const path of paths) notices.push(await content(path, `${pkg.name} ${pkg.version}`));
    packages.push({ name: pkg.name, version: pkg.version, source: pkg.source, license: pkg.license, notices: [...new Set(notices)],
      features: graph.resolve.nodes.find(n => n.id === pkg.id)?.features ?? [] });
  }
  const distribution = join(local, 'rust', `${rustVersion}-${target}`, `rustc-${rustVersion}-${target}`);
  const rustNotices = [];
  for (const name of ['COPYRIGHT', 'LICENSE-APACHE', 'LICENSE-MIT']) rustNotices.push(await content(join(distribution, name), `Rust ${rustVersion}`));
  for (const license of rustLicenses) rustNotices.push(await content(join(sysroot, 'share/doc/rust/licenses', `${license}.txt`), `Rust ${rustVersion}: ${license}`));
  const library = await readFile(join(sysroot, 'share/doc/rust/COPYRIGHT-library.html'));
  const windows = await readFile(join(root, 'WINDOWS-RUNTIME.txt'));
  // This curated runtime notice must be reviewed explicitly when the toolchain changes.
  assert.ok(noticeText(windows).includes(`Reviewed Rust distribution: ${rustVersion} (${target})`), 'Review WINDOWS-RUNTIME.txt for the new Rust toolchain');
  const entries = [...documents.values()];
  const header = `DSH Recollection: native worker third-party notices
===================================================

The project's own code is licensed under Apache-2.0; see the repository/package
root LICENSE. Third-party code retains the terms and copyrights below.
Upstream phrases such as "this project" refer to the component named above the
notice, not to DSH Recollection.

Contents
--------
1. Cargo dependency inventory and full deduplicated notices (this file).
2. RUST-STANDARD-LIBRARY.html: unmodified upstream standard-library attribution,
   including its out-of-tree dependency license texts. Rust's COPYRIGHT and
   core license texts are also included below; upstream filenames in those
   texts refer to the corresponding notice sections here.
3. WINDOWS-RUNTIME.txt: MinGW-w64 and GNU runtime attributions and full terms.
4. index.json: versions, upstream sources, notice mappings and SHA-256 hashes
   computed after normalizing CRLF to LF.
Identical texts differing only in spaces, tabs or line breaks are stored once.
Each original text hash remains in index.json; copyright wording is preserved.

Scope
-----
Generated from Cargo.lock and Rust ${rustVersion}, target ${target}.
The Cargo inventory conservatively retains the entire resolved dependency
graph, including build dependencies and proc macros. It is not an object-level
claim that every dependency is linked into the executable.
The Rust standard-library document is preserved in full, including entries for
other targets. The compiler, Cargo, LLVM tools, documentation and fonts are not
shipped with the plugin. Their tool-only license templates are omitted:
CC-BY-SA-4.0 (embedded book), OFL-1.1 (rustdoc fonts), GPL-2.0-only (GCC tests),
ISC (GCC tests and non-libstd tools).
LLVM-exception and the legacy NCSA terms are retained conservatively for
compiler/runtime attribution; this inventory does not prove object-level use.
Generic Apache/MIT templates are covered by the Rust LICENSE-APACHE/LICENSE-MIT
texts. GNU GPLv3 and the GCC Runtime Library Exception remain in the Windows
runtime notice. This is not a change to any upstream license choice.

Regenerate: npm run notices:update (after fetching/building the locked Cargo dependencies).
Verify against cached upstream sources: npm run notices:check.
WINDOWS-RUNTIME.txt is curated; review its provenance when changing toolchains.

Cargo packages
--------------
${packages.map(p => `${p.name} ${p.version}\n  Source: ${p.source}\n  Declared license: ${p.license}\n  Notices: ${p.notices.join(', ')}`).join('\n')}

Rust ${rustVersion} core notices: ${[...new Set(rustNotices)].join(', ')}
`;
  const fullText = header + entries.map(doc => `\n${'='.repeat(78)}\n[${doc.id}]\n${doc.origins.map(origin => `${origin.component}: ${origin.file}`).join('\n')}\nSHA-256 (LF): ${doc.sha256}\n${'-'.repeat(78)}\n${doc.text}${doc.text.endsWith('\n') ? '' : '\n'}`).join('');
  const files = new Map([['THIRD_PARTY_NOTICES.txt', Buffer.from(fullText)], ['RUST-STANDARD-LIBRARY.html', library], ['WINDOWS-RUNTIME.txt', windows]]);
  const index = { schemaVersion: 2, rustVersion, target, cargoLockSha256: noticeHash(await readFile(cargoLock)), packages,
    rust: { notices: [...new Set(rustNotices)], supplementalLicenses: rustLicenses },
    documents: entries.map(({ text, ...entry }) => entry),
    files: [...files].map(([file, bytes]) => ({ file, sha256: noticeHash(bytes) })) };
  files.set('index.json', Buffer.from(JSON.stringify(index, null, 2) + '\n'));
  return files;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.ok(process.argv.slice(2).every(arg => arg === '--check'), 'Usage: node scripts/build/native-notices.mjs [--check]');
  const files = await collectNativeNotices();
  const check = process.argv.includes('--check');
  if (!check) await mkdir(root, { recursive: true });
  for (const [file, bytes] of files) {
    if (check) assert.equal(noticeHash(await readFile(join(root, file))), noticeHash(bytes), `Stale native notice: ${file}`);
    else if (file !== 'WINDOWS-RUNTIME.txt') await writeFile(join(root, file), bytes);
  }
  await verifyNativeNotices(root, { cargoLock, rustVersion, target });
  const index = JSON.parse(files.get('index.json'));
  console.log(`${check ? 'Verified' : 'Generated'} ${files.size} notice files; ${index.packages.length} Cargo packages, ${index.documents.length} distinct texts.`);
}
