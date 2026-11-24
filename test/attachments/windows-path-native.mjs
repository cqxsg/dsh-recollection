import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename, win32 } from 'node:path';
import { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy';
import { RecallAttachmentService, hashKey } from '../../lib/index.js';
import { human } from '../../support/fixtures/scripted-model.mjs';
import { rangeFixture } from '../../support/fixtures/range.mjs';

const until = async predicate => {
  const end = performance.now() + 15000;
  while (!predicate()) { assert.ok(performance.now() < end, 'Windows path probe timed out'); await new Promise(r => setTimeout(r, 5)); }
};
async function compact(ctx, agent) {
  const groups = [[]];
  for (const seq of agent.session.surface.nodes) {
    if (agent.session.snapshotEvents()[seq].type === 'system/message') groups.push([]); else groups.at(-1).push(seq);
  }
  for (const group of groups) if (group.length) rangeFixture(agent.session).summary(group);
  await ctx.sessions.flush(agent.session);
}

/** Real local files on two drives, isolated Native calls and durable baseline rows. */
export async function verifyWindowsPathRepairs(ctx, h) {
  assert.equal(process.platform, 'win32');
  const initial = process.cwd(), temporaryRoot = resolve(tmpdir());
  assert.notEqual(win32.parse(initial).root.toLowerCase(), win32.parse(temporaryRoot).root.toLowerCase(), 'Cross-drive test requires the workspace and TEMP on different drives');
  const folder = await mkdtemp(join(temporaryRoot, 'dsh-recollection-path-'));
  const target = join(folder, 'note.txt'), rootPath = target.slice(2), slashPath = rootPath.replaceAll('\\', '/'), drivePath = `${target.slice(0, 2)}note.txt`;
  const cases = [], rowFor = (id, path) => ctx.recallHashes.records().filter(r => r.source.sessionId === id && r.source.path === path).at(-1);
  let agent;
  const change = async cwd => {
    const [result] = await h.drive(agent, [{ name: 'working_directory', args: { cd: cwd } }], human('change test directory'));
    assert.equal(result.data.message.isError, false);
  };
  const read = async (item, attachment = item.attachments[0]) => {
    const [result] = await h.drive(agent, [{ name: 'recall_read', args: { action: 'read', ref: item.ref, target: 'attachments', attachments: [attachment.ref] } }], human('verify historical file'));
    assert.equal(result.value?.status, 'ok', JSON.stringify(result));
    return result.value.attachmentResults[0];
  };
  const reopen = async () => {
    await h.agents.find(handle => handle.agent === agent).dispose();
    const handle = await ctx.agents.resume({ resumeSessionId: agent.id, agentOptions: h.model.options }); h.agents.push(handle); agent = handle.agent;
  };
  try {
    await writeFile(target, 'Windows historical path content');
    ({ agent } = await h.seed('repair-windows-paths'));
    setSandboxMode(agent.session, 'read-only');
    await change(folder);
    const release = ctx.recallPreparation.holdOperation(agent.id);
    try {
      await h.drive(agent, [], human(`needle win-paths-reference @"${rootPath}" @"${slashPath}" @"${drivePath}"`), false);
      const results = await h.drive(agent, [rootPath, slashPath, drivePath].map(file_path => ({ name: 'read', args: { file_path } })), human('read Windows path forms'));
      assert.ok(results.every(result => !result.data.message.isError));
      await ctx.recallAttachments.idleAdmissions();
      await change(initial);
    } finally { release(); }
    await until(() => ctx.recallHashes.records().filter(r => r.source.sessionId === agent.id && r.state === 'saved').length === 6);
    const rows = ctx.recallHashes.records().filter(r => r.source.sessionId === agent.id);
    assert.equal(rows.length, 6);
    for (const row of rows) { assert.equal(row.source.cwd, folder); assert.equal(row.resolvedPath, target); }
    await compact(ctx, agent);
    const item = (await h.search(agent, human('find Windows references'), ['win-paths-reference'])).value.items[0];
    assert.equal(item.attachments.length, 3);
    for (const attachment of item.attachments) {
      const file = await read(item, attachment); assert.equal(file.path, target); assert.equal(file.version.state, 'same');
    }
    cases.push({ id: 'B01', scenario: 'Native user and read references retain both root spellings and same-drive C:relative after another directory change', initial, historical: folder, target, saved: 6 });

    // A real directory transition during read prevents early sampling and later guessing.
    await change(folder);
    const priorRows = ctx.recallHashes.records().length, ready = Promise.withResolvers(), unblock = Promise.withResolvers();
    const originalRead = ctx.fs.readText;
    let pending;
    const timeout = setTimeout(() => { ready.reject(new Error('native read was not reached')); unblock.resolve(); }, 15000);
    ctx.fs.readText = async function(file, ...args) {
      if (file.displayPath === target) { ready.resolve(); await unblock.promise; }
      return originalRead.call(this, file, ...args);
    };
    try {
      pending = h.drive(agent, [{ id: 'windows-inflight-read', name: 'read', args: { file_path: rootPath } }], human('directory transition during read'));
      await ready.promise;
      await ctx.recallAttachments.idleAdmissions(); assert.equal(ctx.recallHashes.records().length, priorRows, 'root path cannot register at declaration time');
      await ctx.workingDirectory.set(agent, initial); unblock.resolve();
      const [result] = await pending; assert.equal(result.data.message.isError, false);
    } finally { clearTimeout(timeout); unblock.resolve(); await pending?.catch(() => {}); ctx.fs.readText = originalRead; }
    await ctx.recallAttachments.idleAdmissions();
    const uncertain = rowFor(agent.id, rootPath);
    assert.equal(uncertain.state, 'failed'); assert.equal(uncertain.source.cwd, undefined); assert.equal(uncertain.attempts, 0);
    await compact(ctx, agent);
    const toolItem = (await h.search(agent, human('find uncertain call'), [JSON.stringify(rootPath).slice(1, -1)])).value.items.find(i => i.source.callId === 'windows-inflight-read' && i.source.kind === 'tool_call');
    assert.ok(toolItem); assert.equal((await read(toolItem)).state, 'unresolved');
    cases.push({ id: 'B01', scenario: 'Actual directory change during Native read leaves no sampled baseline and cold attachment access unresolved', attempts: uncertain.attempts });

    const baseline = rows.find(row => row.source.selector.startsWith('p') && row.source.path === rootPath);
    const legacyRoot = structuredClone(baseline); legacyRoot.source.cwd = initial; legacyRoot.resolvedPath = win32.resolve(initial, rootPath);
    await ctx.recallHashes.table.put(hashKey(legacyRoot.source), legacyRoot);
    await reopen();
    const rootAttachment = item.attachments.find(a => a.metadata.path === rootPath);
    const cold = await read(item, rootAttachment);
    assert.equal(cold.path, target); assert.equal(cold.version.state, 'unverified'); assert.equal(cold.version.reason, 'baseline_source_mismatch');
    assert.deepEqual(ctx.recallHashes.get(hashKey(legacyRoot.source)), legacyRoot);
    cases.push({ id: 'B01', scenario: 'Cold resumed agent resolves historical drive and rejects immutable old saved baseline', path: cold.path, version: cold.version });

    await h.drive(agent, [], human(`needle cross-drive-reference @"${drivePath}"`), false);
    await ctx.recallAttachments.idleAdmissions();
    const cross = rowFor(agent.id, drivePath);
    assert.equal(cross.source.cwd, initial); assert.equal(cross.state, 'failed'); assert.equal(cross.attempts, 0); assert.equal(cross.resolvedPath, undefined);
    await compact(ctx, agent);
    const crossItem = (await h.search(agent, human('find cross-drive reference'), ['cross-drive-reference'])).value.items[0];
    assert.equal((await read(crossItem)).state, 'unresolved');
    const legacyCross = { ...cross, state: 'saved', attempts: 1, sample: baseline.sample, resolvedPath: target }; delete legacyCross.reason;
    await ctx.recallHashes.table.put(hashKey(legacyCross.source), legacyCross);
    await reopen();
    const unavailable = await read(crossItem);
    assert.equal(unavailable.state, 'unresolved'); assert.equal(unavailable.version.state, 'unverified'); assert.equal(unavailable.path, undefined);
    assert.deepEqual(ctx.recallHashes.get(hashKey(legacyCross.source)), legacyCross);
    cases.push({ id: 'B02', scenario: 'Cross-drive C:relative is unresolved before and after cold resume even with an old saved target', result: unavailable });

    await [...ctx.registry.get(RecallAttachmentService).fibers].find(f => f.state === 2).dispose();
    for (const legacy of [legacyRoot, legacyCross]) {
      const pendingRow = { ...legacy, state: 'pending', attempts: 0, spentMs: 0 }; delete pendingRow.sample;
      await ctx.recallHashes.table.put(hashKey(pendingRow.source), pendingRow);
    }
    await ctx.plugin(RecallAttachmentService);
    await until(() => [legacyRoot, legacyCross].every(row => ctx.recallHashes.get(hashKey(row.source)).state === 'failed'));
    for (const legacy of [legacyRoot, legacyCross]) {
      const failed = ctx.recallHashes.get(hashKey(legacy.source));
      assert.equal(failed.reason, 'source_unverifiable'); assert.equal(failed.attempts, 0); assert.equal(failed.sample, undefined);
    }
    cases.push({ id: 'B01/B02', scenario: 'Reloaded admission rejects old pending root/cross-drive rows before any sample attempt', attempts: [0, 0] });
    await writeFile(join(process.env.DSH_HOME, '..', 'windows-path-evidence.json'), JSON.stringify({ cases }, null, 2));
    for (const value of cases) console.log(`PASS: ${value.id} ${value.scenario}`);
  } finally {
    // Delete only the unique directory created by this test beneath the known TEMP root.
    assert.equal(dirname(resolve(folder)).toLowerCase(), temporaryRoot.toLowerCase());
    assert.ok(basename(folder).startsWith('dsh-recollection-path-'));
    await rm(folder, { recursive: true, force: true });
  }
}
