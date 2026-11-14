import { projectRoot } from '../../support/paths.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cp, mkdir, mkdtemp, readFile, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { verifyPackage } from '../../scripts/package/candidate-package.mjs';
import { verifyNativeNotices } from '../../scripts/build/native-notice-files.mjs';

const project = projectRoot;
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
  const parent = join(project, '.local', 'candidate-payload-tests'); await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, 'run-'));
  for (const path of ['lib', 'README.md', 'LICENSE', 'cordis.patch.yml', 'package.json']) await cp(join(project, path), join(root, path), { recursive: true });
  const pkg = JSON.parse(await readFile(join(root, 'package.json')));
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
