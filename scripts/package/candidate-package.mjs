import assert from 'node:assert/strict';
import { readdir, readFile, lstat } from 'node:fs/promises';
import { join, posix, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { verifyNativeNotices } from '../build/native-notice-files.mjs';
import { assertCompatibilityVersion, isDshPeer } from './compatibility-package.mjs';

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export async function filesUnder(root, prefix = '') {
  const files = [];
  for (const name of (await readdir(join(root, prefix))).sort()) {
    const path = posix.join(prefix, name), info = await lstat(join(root, path));
    assert.ok(!info.isSymbolicLink(), `Unexpected link: ${path}`);
    if (info.isDirectory()) files.push(...await filesUnder(root, path));
    else { assert.ok(info.isFile(), `Unexpected file type: ${path}`); files.push(path); }
  }
  return files.sort();
}

/** Verify the extracted payload, including every declared export and native identity. */
export async function verifyPackage(root, expectedPackage, forbiddenPaths = [], { compatibilityTest = false } = {}) {
  const names = await filesUnder(root);
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  assert.deepEqual(pkg, expectedPackage);
  if (compatibilityTest) {
    assertCompatibilityVersion(pkg.version);
    assert.equal(pkg.private, true, 'Compatibility test packages must remain private');
    assert.equal(pkg.engines.dsh, '*', 'Compatibility test package must not restrict DSH');
    for (const [name, range] of Object.entries(pkg.peerDependencies)) {
      if (isDshPeer(name)) assert.equal(range, '*', `Compatibility test peer must not restrict DSH: ${name}`);
    }
  } else {
    assert.notEqual(pkg.private, true, 'Private package cannot be published');
    assert.equal(pkg.engines.dsh, '>=0.2.1-rc.4 <=0.2.1-rc.5 || >=0.2.2-alpha.3 <=0.2.2-rc.3');
    for (const [name, range] of Object.entries(pkg.peerDependencies)) {
      if (isDshPeer(name)) assert.equal(range, pkg.engines.dsh, `DSH peer range differs: ${name}`);
    }
  }
  assert.equal(pkg.license, 'Apache-2.0');
  assert.deepEqual(pkg.repository, { type: 'git', url: 'git+https://github.com/cqxsg/dsh-recollection.git' });
  assert.deepEqual(pkg.publishConfig, { access: 'public', registry: 'https://registry.npmjs.org/' }, 'Unexpected publish destination');
  assert.deepEqual(pkg.os, ['win32']); assert.deepEqual(pkg.cpu, ['x64']);
  assert.equal(pkg.engines.node, '>=24.14.0');
  for (const hook of ['preinstall', 'install', 'postinstall', 'prepare']) assert.equal(pkg.scripts[hook], undefined);
  const entries = [pkg.main, pkg.types, pkg.dsh.bundle.patch];
  const visit = value => typeof value === 'string' ? entries.push(value) : Object.values(value).forEach(visit);
  visit(pkg.exports);
  for (const path of entries) {
    assert.ok(path.startsWith('./') && !path.split('/').includes('..'), `Invalid entry: ${path}`);
    assert.ok(names.includes(path.slice(2)), `Missing entry: ${path}`);
  }
  const locales = ['locale/en.json', 'locale/zh.json'];
  for (const path of locales) {
    assert.equal(pkg.exports[`./${path}`], `./${path}`, `Locale must be exported: ${path}`);
    const { meta } = JSON.parse(await readFile(join(root, path), 'utf8'));
    assert.equal(typeof meta?.description, 'string', `Missing localized description: ${path}`);
    assert.ok(meta.description.trim(), `Empty localized description: ${path}`);
    if (path === 'locale/en.json') assert.equal(meta.description, pkg.description, 'English description differs from manifest');
  }
  for (const path of ['lib/client.js', 'lib/native/manifest.json', 'lib/native/worker.exe', 'README.md', 'LICENSE']) assert.ok(names.includes(path), `Missing ${path}`);
  const license = await readFile(join(root, 'LICENSE'), 'utf8');
  assert.match(license, /Apache License\s+Version 2\.0, January 2004/);
  assert.match(license, /END OF TERMS AND CONDITIONS/);
  const inventory = [];
  for (const path of names) {
    assert.ok(['package.json', 'README.md', 'LICENSE', 'cordis.patch.yml', ...locales].includes(path) || path.startsWith('lib/'), `Unexpected payload: ${path}`);
    // Host attachment declarations are generated product types.
    const attachmentDeclaration = /^lib\/types\/host\/attachments\/[^/]+\.d\.ts(?:\.map)?$/.test(path);
    assert.ok(attachmentDeclaration || !/(^|\/)(node_modules|\.local|experiments|test|sessions|attachments|target)(\/|$)/.test(path), `Private/development payload: ${path}`);
    const bytes = await readFile(join(root, path));
    for (const forbidden of forbiddenPaths.filter(Boolean)) {
      for (const spelling of new Set([forbidden, forbidden.replaceAll('\\', '/'), forbidden.replaceAll('\\', '\\\\')])) {
        assert.equal(bytes.toString('utf8').toLowerCase().includes(spelling.toLowerCase()), false, `Build path leaked in ${path}`);
      }
    }
    if (path.endsWith('.map')) {
      const map = JSON.parse(bytes);
      for (const source of [map.sourceRoot ?? '', ...(map.sources ?? [])]) {
        assert.ok(!isAbsolute(source) && !/^[a-z]+:|^\\\\/i.test(source), `Non-portable map: ${path}: ${source}`);
      }
    }
    inventory.push({ path, bytes: bytes.length, sha256: sha256(bytes) });
  }
  const worker = JSON.parse(await readFile(join(root, 'lib/native/manifest.json'), 'utf8'));
  assert.equal(worker.executable, 'worker.exe'); assert.equal(worker.protocol, 1);
  assert.equal(worker.target, 'x86_64-pc-windows-gnu'); assert.equal(worker.ripgrep, '15.2.0');
  assert.equal(worker.sha256, inventory.find(file => file.path === 'lib/native/worker.exe').sha256);
  assert.equal(worker.flags, undefined);
  await verifyNativeNotices(join(root, 'lib/native/third-party'), { rustVersion: worker.rustVersion, target: worker.target });
  const readme = await readFile(join(root, 'README.md'), 'utf8');
  for (const match of readme.matchAll(/\]\(([^)]+)\)|\bsrc=["']([^"']+)["']/g)) {
    const link = match[1] ?? match[2];
    if (/^(?:https?:|#)/i.test(link)) continue;
    const path = decodeURIComponent(link.split('#')[0]).replace(/^\.\//, '');
    assert.ok(names.includes(path), `README link outside package: ${link}`);
  }
  return { package: pkg, files: inventory, worker };
}
