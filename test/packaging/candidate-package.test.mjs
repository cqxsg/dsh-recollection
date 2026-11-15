import { projectRoot } from '../../support/paths.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cp, mkdir, mkdtemp, readFile, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { verifyPackage } from '../../scripts/package/candidate-package.mjs';
import { verifyNativeNotices } from '../../scripts/build/native-notice-files.mjs';
import { createCompatibilityManifest, compatibilityReadme, isDshPeer } from '../../scripts/package/compatibility-package.mjs';
import { evaluatePluginCompatibility, readPluginMeta } from '@deepseek-ai/dsh-app-boot';

// Exercise the same semver dependency used by the installed DSH baseline.
const { satisfies } = createRequire(import.meta.resolve('@deepseek-ai/dsh-app-boot'))('semver');

const project = projectRoot;
async function payloadFixture() {
  const parent = join(project, '.local', 'candidate-payload-tests'); await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, 'run-'));
  for (const path of ['lib', 'locale', 'README.md', 'LICENSE', 'cordis.patch.yml', 'package.json']) await cp(join(project, path), join(root, path), { recursive: true });
  const pkg = JSON.parse(await readFile(join(root, 'package.json')));
  return { root, pkg };
}

test('native notice checks reject stale dependencies, toolchains and obsolete files', async () => {
  const parent = join(project, '.local', 'candidate-payload-tests'); await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, 'notices-'));
  const notices = join(root, 'third-party'), cargoLock = join(root, 'Cargo.lock');
  await cp(join(project, 'native/third-party'), notices, { recursive: true });
  await cp(join(project, 'native/worker/Cargo.lock'), cargoLock);
  const index = await verifyNativeNotices(notices, { cargoLock });
  await assert.rejects(verifyNativeNotices(notices, { rustVersion: `${index.rustVersion}-changed` }), /Rust notice version is stale/);
  await assert.rejects(verifyNativeNotices(notices, { target: 'another-target' }), /Native notice target is stale/);
  await writeFile(cargoLock, (await readFile(cargoLock, 'utf8')) + '\n# changed dependencies\n');
  await assert.rejects(verifyNativeNotices(notices, { cargoLock }), /Cargo notices are stale/);
  await writeFile(join(notices, 'obsolete-license.txt'), 'old toolchain notice');
  await assert.rejects(verifyNativeNotices(notices), /Unexpected or missing native notice files/);
});

test('candidate inspection rejects corrupted or nonportable payloads', async () => {
  const { root, pkg } = await payloadFixture();
  const verify = () => verifyPackage(root, pkg, [project.replace(/[\\/]$/, '')]);
  await verify();
  const license = join(root, 'LICENSE'), originalLicense = await readFile(license);
  await unlink(license); await assert.rejects(verify, /Missing LICENSE/); await writeFile(license, originalLicense);
  const notice = join(root, 'lib/native/third-party/THIRD_PARTY_NOTICES.txt'), originalNotice = await readFile(notice);
  await unlink(notice); await assert.rejects(verify, /missing native notice files/); await writeFile(notice, originalNotice);
  await writeFile(notice, 'Only the license names; copyright and full terms lost.');
  await assert.rejects(verify, /Native notice content differs/); await writeFile(notice, originalNotice);
  const worker = join(root, 'lib/native/worker.exe'), originalWorker = await readFile(worker);
  await writeFile(worker, Buffer.concat([originalWorker, Buffer.from('tampered')]));
  await assert.rejects(verify); await writeFile(worker, originalWorker);
  const entry = join(root, 'lib/client.js'), originalEntry = await readFile(entry);
  await unlink(entry); await assert.rejects(verify, /Missing entry/); await writeFile(entry, originalEntry);
  await mkdir(join(root, 'lib/.local')); const leaked = join(root, 'lib/.local/session.json');
  await writeFile(leaked, '{}'); await assert.rejects(verify, /Private\/development payload/); await unlink(leaked);
  await mkdir(join(root, 'lib/attachments'));
  for (const path of ['lib/attachments/session.json', 'lib/types/host/attachments/session.json']) {
    const attachmentData = join(root, path);
    await writeFile(attachmentData, '{}');
    await assert.rejects(verify, /Private\/development payload/);
    await unlink(attachmentData);
  }
  const map = join(root, 'lib/nonportable.map');
  await writeFile(map, JSON.stringify({ version: 3, sources: ['C:/build/private/source.ts'] }));
  await assert.rejects(verify, /Non-portable map/); await unlink(map);
  const pathLeak = join(root, 'lib/build-path.txt');
  await writeFile(pathLeak, project); await assert.rejects(verify, /Build path leaked/); await unlink(pathLeak);
  await verify();
});

test('public package accepts portable README links and rejects private or misdirected publication', async () => {
  const { root, pkg } = await payloadFixture();
  const readme = join(root, 'README.md');
  const publicReadme = '# Public plugin\n\n[Start](#start) | [License](./LICENSE#terms)\n'
    + '[English](https://github.com/cqxsg/dsh-recollection/blob/main/README_en.md)\n'
    + '<img src="https://raw.githubusercontent.com/cqxsg/dsh-recollection/main/docs/diagrams/runtime-flow.svg">\n\n## Start\n';
  // Public documentation need not repeat the package version.
  assert.ok(!publicReadme.includes(pkg.version));
  await writeFile(readme, publicReadme);
  await verifyPackage(root, pkg);
  for (const reference of ['[Architecture](docs/architecture.md)', '<img src="docs/diagrams/runtime-flow.svg">', "<img src='file:///C:/private/picture.svg'>"]) {
    await writeFile(readme, publicReadme + reference);
    await assert.rejects(verifyPackage(root, pkg), /README link outside package/);
  }
  await writeFile(readme, publicReadme);
  for (const [changes, message] of [
    [{ private: true }, /Private package cannot be published/],
    [{ publishConfig: { access: 'public', registry: 'https://example.invalid/' } }, /Unexpected publish destination/],
    [{ publishConfig: { access: 'restricted', registry: 'https://registry.npmjs.org/' } }, /Unexpected publish destination/],
  ]) {
    const changed = { ...pkg, ...changes };
    await writeFile(join(root, 'package.json'), JSON.stringify(changed));
    await assert.rejects(verifyPackage(root, changed), message);
  }
});

test('DSH compatibility bounds admit newer releases and reject excluded versions', async () => {
  const pkg = JSON.parse(await readFile(join(project, 'package.json')));
  const accepted = [
    '0.2.1-rc.1', '0.2.1-rc.3', '0.2.1-rc.4', '0.2.1-rc.5', '0.2.1-rc.6', '0.2.1',
    '0.2.2-alpha.3', '0.2.2-beta.1', '0.2.2-rc.1', '0.2.2-rc.2', '0.2.2-rc.3', '0.2.2-rc.4', '0.2.2', '0.2.3', '0.2.99',
  ];
  const rejected = [
    '0.2.0', '0.2.1-beta.1', '0.2.1-rc.0', '0.2.2-0', '0.2.2-alpha.1', '0.2.2-alpha.2', '0.2.2-alpha.2.1',
    '0.3.0-0', '0.3.0-alpha.1', '0.3.0-rc.1', '0.3.0', '1.0.0',
  ];
  const manifests = [pkg, { ...pkg, engines: { node: pkg.engines.node } }];
  for (const [expected, versions] of [[true, accepted], [false, rejected]]) {
    for (const version of versions) {
      for (const includePrerelease of [false, true]) {
        assert.equal(satisfies(version, pkg.engines.dsh, { includePrerelease }), expected, `${version} (prereleases=${includePrerelease})`);
      }
      for (const manifest of manifests) {
        assert.equal(evaluatePluginCompatibility(manifest, {}, version) === undefined, expected, version);
      }
    }
  }
  // DSH opts into future prereleases; ordinary semver matching excludes new patch tuples.
  for (const version of ['0.2.3-alpha.1', '0.2.3-rc.1', '0.2.99-rc.1']) {
    assert.equal(satisfies(version, pkg.engines.dsh), false, version);
    assert.equal(satisfies(version, pkg.engines.dsh, { includePrerelease: true }), true, version);
    for (const manifest of manifests) assert.equal(evaluatePluginCompatibility(manifest, {}, version), undefined, version);
  }
  for (const [name, range] of Object.entries(pkg.peerDependencies)) {
    if (isDshPeer(name)) assert.equal(range, pkg.engines.dsh, name);
  }
  for (const [name, versions, outside] of [
    ['@deepseek-ai/cordis', ['4.0.5', '4.0.6-alpha.2', '4.1.0'], ['4.0.4', '4.0.6-alpha.3', '4.1.1']],
    ['@deepseek-ai/schemastery', ['3.18.5', '3.18.6-alpha.2', '3.19.0'], ['3.18.4', '3.18.6-alpha.3', '3.19.1']],
    ['zod', ['4.4.3', '4.6.6', '4.6.7'], ['4.4.2', '4.6.8']],
  ]) {
    for (const version of versions) assert.ok(satisfies(version, pkg.peerDependencies[name]), `${name}@${version}`);
    for (const version of outside) assert.ok(!satisfies(version, pkg.peerDependencies[name]), `${name}@${version}`);
    assert.ok(satisfies(pkg.devDependencies[name], pkg.peerDependencies[name]), `Build baseline rejected: ${name}`);
  }
});

test('packaged metadata is discoverable by DSH and missing or unexported locales fail inspection', async () => {
  const { root, pkg } = await payloadFixture();
  const expected = {};
  for (const language of ['en', 'zh']) expected[language] = JSON.parse(await readFile(join(root, `locale/${language}.json`))).meta.description;
  assert.notEqual(expected.en, expected.zh);
  const meta = readPluginMeta(pkg.name, pathToFileURL(join(root, 'package.json')).href);
  assert.equal(meta?.error, undefined);
  assert.equal(meta?.title, pkg.name);
  assert.deepEqual(meta?.description, expected);
  const verify = expectedPackage => verifyPackage(root, expectedPackage);
  const chinese = join(root, 'locale/zh.json'), original = await readFile(chinese);
  await unlink(chinese); await assert.rejects(verify(pkg), /Missing entry/); await writeFile(chinese, original);
  await writeFile(chinese, '{"meta":{"description":""}}');
  await assert.rejects(verify(pkg), /Empty localized description/); await writeFile(chinese, original);
  for (const language of ['en', 'zh']) {
    const changed = structuredClone(pkg);
    delete changed.exports[`./locale/${language}.json`];
    await writeFile(join(root, 'package.json'), JSON.stringify(changed));
    await assert.rejects(verify(changed), /Locale must be exported/);
  }
  await writeFile(join(root, 'package.json'), JSON.stringify(pkg));
  await verify(pkg);
});

test('local compatibility manifest passes the native DSH gate without changing the development baseline', async () => {
  const source = JSON.parse(await readFile(join(project, 'package.json')));
  const original = structuredClone(source);
  const pkg = createCompatibilityManifest(source, '0.1.1-compat.1');
  assert.deepEqual(source, original);
  assert.deepEqual(pkg.devDependencies, source.devDependencies);
  assert.equal(evaluatePluginCompatibility(source, {}, '0.3.0-alpha.1').exempted, false);
  for (const version of ['0.0.1', '0.2.1-rc.4', '0.2.2-rc.3', '0.3.0-alpha.1', '1.0.0']) {
    assert.equal(evaluatePluginCompatibility(pkg, {}, version), undefined, version);
    // Also check the peer fallback, so engines.dsh cannot hide a remaining DSH peer pin.
    assert.equal(evaluatePluginCompatibility({ ...pkg, engines: { node: pkg.engines.node } }, {}, version), undefined, version);
  }
  for (const [name, range] of Object.entries(source.peerDependencies)) {
    if (!isDshPeer(name)) assert.equal(pkg.peerDependencies[name], range, name);
  }
  for (const version of ['0.1.0', '0.1.1-rc.1', '01.1.1-compat.1', '0.1.1-compat.1/../../other', '']) {
    assert.throws(() => createCompatibilityManifest(source, version), /Use a local test version/);
  }
});

test('compatibility payload requires explicit test inspection and retains artifact integrity checks', async () => {
  const fixture = await payloadFixture();
  const pkg = createCompatibilityManifest(fixture.pkg, '0.1.1-compat.1');
  const manifest = join(fixture.root, 'package.json');
  await writeFile(manifest, JSON.stringify(pkg));
  await writeFile(join(fixture.root, 'README.md'), compatibilityReadme(pkg));
  const verify = expected => verifyPackage(fixture.root, expected, [], { compatibilityTest: true });
  await verify(pkg);
  await assert.rejects(verifyPackage(fixture.root, pkg), /Private package cannot be published/);
  for (const [changed, message] of [
    [{ ...pkg, private: false }, /must remain private/],
    [{ ...pkg, engines: { ...pkg.engines, dsh: '0.2.1-rc.4' } }, /must not restrict DSH/],
    [{ ...pkg, peerDependencies: { ...pkg.peerDependencies, '@deepseek-ai/dsh-agent': '0.2.1-rc.4' } }, /peer must not restrict DSH/],
  ]) {
    await writeFile(manifest, JSON.stringify(changed));
    await assert.rejects(verify(changed), message);
  }
  await writeFile(manifest, JSON.stringify(pkg));
  const worker = join(fixture.root, 'lib/native/worker.exe');
  await writeFile(worker, Buffer.concat([await readFile(worker), Buffer.from('tampered')]));
  await assert.rejects(verify(pkg));
});
