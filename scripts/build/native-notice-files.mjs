import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

export const nativeNoticeFiles = ['THIRD_PARTY_NOTICES.txt', 'RUST-STANDARD-LIBRARY.html', 'WINDOWS-RUNTIME.txt', 'index.json'];
// Text hashes survive a Git checkout with either LF or CRLF line endings.
export const noticeText = bytes => bytes.toString('utf8').replace(/\r\n/g, '\n');
export const noticeHash = bytes => createHash('sha256').update(noticeText(bytes)).digest('hex');

export async function verifyNativeNotices(root, { cargoLock, rustVersion, target } = {}) {
  assert.deepEqual((await readdir(root)).sort(), [...nativeNoticeFiles].sort(), 'Unexpected or missing native notice files');
  const index = JSON.parse(await readFile(join(root, 'index.json'), 'utf8'));
  assert.equal(index.schemaVersion, 2);
  if (rustVersion) assert.equal(index.rustVersion, rustVersion, 'Rust notice version is stale');
  if (target) assert.equal(index.target, target, 'Native notice target is stale');
  if (cargoLock) assert.equal(index.cargoLockSha256, noticeHash(await readFile(cargoLock)), 'Cargo notices are stale; run npm run notices:update');
  assert.ok(index.packages.length > 0 && index.documents.length > 0, 'Empty native notice index');
  assert.deepEqual(index.files.map(entry => entry.file).sort(), nativeNoticeFiles.filter(file => file !== 'index.json').sort());
  for (const { file, sha256 } of index.files) {
    assert.equal(noticeHash(await readFile(join(root, file))), sha256, `Native notice content differs: ${file}`);
  }
  return index;
}
