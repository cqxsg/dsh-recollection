import assert from 'node:assert/strict';
import { test } from 'node:test';
import { win32 } from 'node:path';
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local';
import { fullyQualifiedWindowsPath, historicalPathAvailable, historicalDirectory, nativeHashSources,
  accessAttachment, RecallHashLedger, hashKey, hashRecord, loadRecallConfig } from '../../lib/index.js';

test('Windows path qualification excludes both implicit drive and implicit per-drive directories', async () => {
  for (const path of ['C:\\file', 'c:/file', '\\\\server\\share\\file', '\\\\?\\C:\\file', '\\\\?\\UNC\\server\\share\\file', '\\\\.\\C:\\file']) {
    assert.equal(fullyQualifiedWindowsPath(path), true, path);
    assert.equal(historicalPathAvailable(path), true, path);
  }
  for (const path of ['\\file', '/file', 'C:file', 'C:', 'file', '..\\file', '', 'C:\\bad\0file']) {
    assert.equal(fullyQualifiedWindowsPath(path), false, path);
    assert.equal(historicalPathAvailable(path), false, path);
  }
  for (const cwd of [undefined, 'relative', '\\unknown-root', '/unknown-root', 'C:unknown']) {
    assert.equal(historicalPathAvailable('file', cwd), false);
    assert.equal(historicalDirectory({ cwd }, [{ seq: 0 }], 0), undefined);
  }
  assert.equal(historicalPathAvailable('C:file', 'c:\\history'), true);
  assert.equal(historicalPathAvailable('C:file', 'E:\\history'), false);
  assert.equal(historicalPathAvailable('C:file', '\\\\server\\share\\history'), false);
  assert.equal(historicalPathAvailable('C:file', '\\\\?\\C:\\history'), false, 'namespace cwd is a different win32.resolve device');
  for (const [path, cwd, expected] of [
    ['\\logs\\file', 'C:\\history', 'C:\\logs\\file'], ['/logs/file', 'C:\\history', 'C:\\logs\\file'],
    ['c:file', 'C:\\history', 'c:\\history\\file'], ['file', '\\\\server\\share\\history', '\\\\server\\share\\history\\file'],
  ]) {
    assert.equal(historicalPathAvailable(path, cwd), true);
    assert.equal(win32.resolve(cwd, path).toLowerCase(), expected.toLowerCase());
    // UNC spelling is checked above; no live network share is required here.
    if (process.platform === 'win32' && /^[a-z]:/i.test(cwd)) {
      const actual = await LocalFileSystem.prototype.resolve.call({ config: { cwd: 'E:\\unrelated' } }, path, { cwd });
      assert.equal(actual.displayPath.toLowerCase(), expected.toLowerCase());
    }
  }
});

test('root-relative tool bindings wait for a paired result and reject intervening directory changes', () => {
  const header = { id: 'windows-tool', cwd: 'E:\\initial' };
  for (const path of ['\\logs\\file', '/logs/file', 'C:file']) {
    const block = { type: 'tool-call', name: 'read', id: 'call', arguments: JSON.stringify({ file_path: path }) };
    const change = { seq: 0, type: 'working-directory/change', data: { cwd: 'C:\\history' } };
    const declaration = { seq: 1, time: 1, type: 'assistant/message', surfaceOp: 'append', data: { turn: 1, step: 1, message: { id: 'm', source: { kind: 'model' }, content: [block] } } };
    const call = { seq: 2, type: 'tool/call', data: { turn: 1, step: 1, callId: 'call', name: 'read', arguments: block.arguments } };
    const result = { seq: 3, type: 'tool/result', surfaceOp: 'append', sourceEventSeqs: [2], data: { turn: 1, step: 1, message: { toolCallId: 'call' } } };
    const bind = events => nativeHashSources(header, declaration, events)[0];
    assert.equal(bind([change, declaration, call]).cwd, undefined);
    assert.equal(bind([change, declaration, call, result]).cwd, 'C:\\history');
    const shifted = [change, declaration, call, { ...change, seq: 3, data: { cwd: 'E:\\later' } }, { ...result, seq: 4 }];
    assert.equal(bind(shifted).cwd, undefined);
  }
  const event = { seq: 1, time: 1, type: 'user/message', surfaceOp: 'append', data: { id: 'u', source: { kind: 'user' }, content: [{ type: 'text', text: '@"C:\\full.txt"' }] } };
  const events = [{ seq: 0, type: 'working-directory/change', data: { cwd: 'C:\\history' } }, event];
  assert.equal(nativeHashSources(header, event, events)[0].cwd, header.cwd, 'published fully-qualified baseline identity stays stable');
});

test('unknown and cross-drive historical paths perform no provider resolution or byte access', async () => {
  const fs = new Proxy({}, { get: (_target, name) => () => assert.fail(`unexpected filesystem ${String(name)}`) });
  const ctx = { get: name => name === 'fs' ? fs : undefined };
  for (const [path, cwd] of [['\\file', undefined], ['/file', undefined], ['file', '\\unknown'], ['C:file', 'E:\\history']]) {
    const result = await accessAttachment(ctx, { type: 'path', path, block: 0, selector: 'p0:0', metadata: {} }, cwd, new AbortController().signal);
    assert.equal(result.state, 'unresolved'); assert.equal(result.reason, 'historical_working_directory_unavailable');
  }
});

test('baseline admission and old pending sampling cannot use a saved target to bypass missing historical context', async () => {
  const rows = new Map(), ledger = Object.create(RecallHashLedger.prototype);
  const fs = new Proxy({}, { get: (_target, name) => () => assert.fail(`unexpected filesystem ${String(name)}`) });
  Object.assign(ledger, { config: loadRecallConfig(), queues: new Map(), progress: new Map(), lifetime: new AbortController(), closing: false,
    table: { get: key => rows.get(key), put: async (key, value) => rows.set(key, hashRecord.parse(value)) } });
  Object.defineProperty(ledger, 'ctx', { value: { fs } });
  let seq = 0;
  for (const [path, cwd] of [['\\file', undefined], ['/file', undefined], ['C:file', 'E:\\history']]) {
    const source = { sessionId: 'paths', seq: ++seq, messageId: `m${seq}`, block: 0, selector: 'p0:0', fingerprint: 'f', referenceText: path, path,
      ...(cwd ? { cwd } : {}), recordedAt: 1 };
    const key = await ledger.register(source), failed = ledger.get(key);
    assert.equal(failed.state, 'failed'); assert.equal(failed.attempts, 0);
    assert.equal(failed.reason, 'historical_working_directory_unavailable');
    const legacy = { ...failed, state: 'sampling', attempts: 1, spentMs: 3, resolvedPath: 'C:\\wrong.txt', reserved: { id: 'old', ms: 17 } };
    delete legacy.reason; rows.set(key, hashRecord.parse(legacy));
    const stopped = await ledger.step(key);
    assert.equal(stopped.state, 'failed'); assert.equal(stopped.reason, 'historical_working_directory_unavailable');
    assert.equal(stopped.attempts, 1); assert.equal(stopped.spentMs, 20); assert.equal(stopped.sample, undefined);
    assert.equal(stopped.resolvedPath, legacy.resolvedPath); assert.equal(hashKey(source), key);
  }
});
