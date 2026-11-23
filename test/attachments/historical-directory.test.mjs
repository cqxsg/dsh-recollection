import assert from 'node:assert/strict';
import { test } from 'node:test';
import { historicalDirectory, toolDirectory, nativeHashSources } from '../../lib/index.js';

const header = { id: 'directory', cwd: 'C:/A' };
test('historical paths use the event-time directory, including unknown transitions and inherited boundaries', () => {
  const events = [
    { seq: 0, type: 'user/message' },
    { seq: 1, type: 'working-directory/change', data: { cwd: 'C:/B' } },
    { seq: 2, type: 'user/message' },
    { seq: 3, type: 'working-directory/change', data: { cwd: 'relative' } },
    { seq: 4, type: 'user/message' },
    { seq: 5, type: 'working-directory/change', data: { cwd: 'C:/C' } },
  ];
  assert.equal(historicalDirectory(header, events, 0), 'C:/A');
  assert.equal(historicalDirectory(header, events, 2), 'C:/B');
  assert.equal(historicalDirectory(header, events, 4), undefined);
  assert.equal(historicalDirectory(header, events, 5), 'C:/C');
  assert.equal(historicalDirectory(header, events, 2, 3), undefined);
  assert.equal(historicalDirectory(header, events.slice(1), 2), undefined);
  assert.equal(historicalDirectory({ id: 'unknown' }, [{ seq: 0, type: 'user/message' }], 0), undefined);
});
test('tool declaration and native result must uniquely pair with no intervening directory transition', () => {
  const block = { type: 'tool-call', id: 'c', name: 'read', arguments: '{"file_path":"note.txt"}' };
  const declaration = { seq: 0, time: 1, type: 'assistant/message', surfaceOp: 'append', data: { turn: 1, step: 1, message: { id: 'm', source: { kind: 'model' }, content: [block] } } };
  const call = { seq: 1, type: 'tool/call', data: { turn: 1, step: 1, callId: 'c', name: 'read', arguments: block.arguments } };
  const result = { seq: 2, type: 'tool/result', surfaceOp: 'append', sourceEventSeqs: [1], data: { turn: 1, step: 1, message: { toolCallId: 'c' } } };
  assert.equal(toolDirectory(header, [declaration, call], declaration, 'c'), undefined);
  assert.equal(toolDirectory(header, [declaration, call, result], declaration, 'c'), 'C:/A');
  const changed = [declaration, call, { seq: 2, type: 'working-directory/change', data: { cwd: 'C:/B' } }, { ...result, seq: 3 }];
  assert.equal(toolDirectory(header, changed, declaration, 'c'), undefined);
  assert.equal(toolDirectory(header, [declaration, call, { ...result, sourceEventSeqs: [] }], declaration, 'c'), undefined);
  assert.equal(toolDirectory(header, [declaration, call, result, { ...result, seq: 3 }], declaration, 'c'), undefined);
  const user = { seq: 1, time: 3, type: 'user/message', surfaceOp: 'append', data: { id: 'u', source: { kind: 'user' }, content: [{ type: 'text', text: '@note.txt' }] } };
  assert.equal(nativeHashSources(header, user, [{ seq: 0, type: 'working-directory/change', data: { cwd: 'C:/B' } }, user])[0].cwd, 'C:/B');
});
