import assert from 'node:assert/strict';
import { test } from 'node:test';
import { blockAttachments } from '../../lib/index.js';

for (const name of ['read', 'read_image']) test(`${name} recognizes the real field without guessing from old or malformed arguments`, () => {
  const extract = value => blockAttachments({ type: 'tool-call', name, id: 'call', arguments: typeof value === 'string' ? value : JSON.stringify(value) }, 2, 'assistant', 'tool_call');
  for (const args of ['{', 'null', '42', '[]', { file_path: 12 }, { file_path: '' }, { file_path: '  ' }, { file_path: 'a\0b' }, { path: 'old.txt' }, { file_path: null, path: 'old.txt' }]) assert.equal(extract(args).length, 0);
  assert.equal(extract({ file_path: ' 历史 file.txt ' })[0].path, ' 历史 file.txt ');
  assert.equal(extract({ file_path: 'actual.txt', path: 'ignored-unknown-field.txt' })[0].path, 'actual.txt');
  assert.equal(extract({ file_path: 'C:\\资料\\图.png' })[0].selector, 't2');
});
