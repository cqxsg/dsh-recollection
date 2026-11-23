import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatSpillNotice } from '@deepseek-ai/dsh-spill-policy/notice';
import { blockAttachments } from '../../lib/index.js';

const hint = 'Use read with offset/limit, or grep this path to search within it.';
const extract = (text, tool, kind = 'tool_result') => blockAttachments({ type: 'text', text }, 3, 'tool', kind, tool);
const grep = path => `Found 2 of 6 matches\n\npreview\n\n(Full grep result stored at: ${path}. ${hint})`;
const glob = (path, basis = '.') => `a.txt\nb.txt\n\n(Showing 2 of 6 paths${basis} Full sorted result stored at: ${path}. ${hint})`;

test('native generic, grep and both glob sampling footers preserve exact path and offset', () => {
  for (const path of ['C:\\资料 folder\\result.txt', '/tmp/历史 result.txt']) {
    const cases = [
      ['example', formatSpillNotice({ kind: 'exact', count: 100 }, { locator: path, retrievalHint: hint })],
      ['grep', grep(path)], ['glob', glob(path)],
      ['glob', glob(path, ', sampled across 2 of the 3 top-level entries this pattern matched instead of taken in modification-time order. Narrow path to inspect a specific subtree.')],
      ['glob', glob(path, ', sampled across 3 of the 3 top-level entries this pattern matched instead of taken in modification-time order.')],
    ];
    for (const [tool, text] of cases) {
      const [source] = extract(text, tool);
      assert.equal(source.path, path); assert.equal(text.slice(source.offset, source.offset + path.length), path);
      assert.equal(source.selector, `s3:${source.offset}`); assert.equal(source.metadata.authenticatedContent, false);
    }
  }
});

test('specialized locators require matching tool, native framing and a valid absolute local path', () => {
  for (const [tool, format] of [['grep', grep], ['glob', glob]]) {
    const valid = format('C:\\temp\\result.txt');
    for (const wrong of [undefined, 'example', 'recall_read', tool === 'grep' ? 'glob' : 'grep']) assert.equal(extract(valid, wrong).length, 0);
    for (const kind of ['message', 'tool_call']) assert.equal(extract(valid, tool, kind).length, 0);
    for (const path of ['relative.txt', 'spill://result', 'C:\\bad\0path', 'C:\\bad\npath']) assert.equal(extract(format(path), tool).length, 0);
    for (const malformed of [valid + '\ntrailing prose', valid.replace(hint, 'Read this file.'), valid.replace(/Found|Showing/u, 'Example'), valid.replace('\n\n(', '\n(')]) assert.equal(extract(malformed, tool).length, 0);
  }
  assert.equal(extract('Discussion: Full grep result stored at: C:\\temp\\result.txt.', 'grep').length, 0);
});
