import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { deferred, immediate, replace } from '../../support/fixtures/control.mjs';

// A timeout diagnoses a stuck test; ordering is established by explicit gates.
export async function bounded(promise) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('mapping gate did not complete')), 5000); })]); }
  finally { clearTimeout(timer); }
}

/** Exercise both mapping services through their real native tables. */
export async function verifyMappingWaits(store, { target, key, mutate, writeError }) {
  const signal = new AbortController().signal, table = store.table, put = table.put.bind(table);
  const durableTarget = target('durable'), durable = await store.issue(durableTarget, signal);
  const blocked = target('blocked'), cancelled = target('cancelled'), captured = target('captured'), expected = key(captured);
  const entered = deferred(), release = deferred(), signals = [], writes = [], tasks = [];
  const run = store.writes.run.bind(store.writes);
  const restoreRun = replace(store.writes, 'run', (s, operation) => { signals.push(s); return run(s, operation); });
  let active = 0, peak = 0;
  const restore = replace(table, 'put', async (id, row) => {
    writes.push(id); active++; peak = Math.max(peak, active);
    try { if (id === key(blocked)) { entered.resolve(); await release.promise; } return await put(id, row); }
    finally { active--; }
  });
  try {
    const first = store.issue(blocked, signal); tasks.push(first); await bounded(entered.promise);
    let duplicateSettled = false;
    const duplicate = store.issue(blocked, signal).then(row => { duplicateSettled = true; return row; }); tasks.push(duplicate);
    const controller = new AbortController(), pending = store.issue(cancelled, controller.signal);
    const rejected = assert.rejects(pending, /cancel queued mapping/); tasks.push(rejected);
    const cancelledSignal = signals.at(-1);
    assert.equal(getEventListeners(cancelledSignal, 'abort').length, 1);
    const capture = store.issue(captured, signal); tasks.push(capture); mutate(captured);
    const crossSession = { ...durableTarget, sessionId: durableTarget.sessionId + '-other' };
    const isolated = store.issue(crossSession, signal); tasks.push(isolated);

    assert.deepEqual(await bounded(store.issue(durableTarget, signal)), durable);
    await assert.rejects(store.issue(durableTarget, AbortSignal.abort(new Error('cancel fast reuse'))), /cancel fast reuse/);
    await assert.rejects(store.issue({ ...durableTarget, sessionId: '' }, signal));
    controller.abort(new Error('cancel queued mapping')); await bounded(rejected);
    assert.equal(getEventListeners(cancelledSignal, 'abort').length, 0);
    assert.equal(store.stats().pendingWrites, 4); // active, duplicate, captured, other session
    assert.equal(duplicateSettled, false); assert.deepEqual(writes, [key(blocked)]);
    assert.equal(table.get(key(blocked)), undefined, 'an unfinished native write is not reusable');

    release.resolve();
    assert.equal((await duplicate).handle, (await first).handle);
    assert.equal(key(await capture), expected);
    assert.notEqual((await isolated).handle, durable.handle);
    await store.writes.drain();
    assert.equal(peak, 1); assert.equal(store.stats().pendingWrites, 0);
    assert.equal(writes.filter(id => id === key(blocked)).length, 1);
    assert.equal(writes.includes(key(cancelled)), false); assert.equal(table.get(key(cancelled)), undefined);
    assert.ok(signals.every(s => getEventListeners(s, 'abort').length === 0));
  } finally { release.resolve(); await Promise.allSettled(tasks); restore(); restoreRun(); }

  // A native table may expose its row before the service has finished put/index publication.
  const publishing = target('publishing'), published = deferred(), finish = deferred(), publications = [];
  let publicationWrites = 0;
  const undoPublication = replace(table, 'put', async (...args) => {
    publicationWrites++; await put(...args); published.resolve(); await finish.promise;
  });
  try {
    const owner = store.issue(publishing, signal); publications.push(owner); await bounded(published.promise);
    assert.ok(table.get(key(publishing))); assert.equal(store.byHandle.has(table.get(key(publishing)).handle), false);
    let settled = false;
    const peer = store.issue(publishing, signal).then(row => { settled = true; return row; }); publications.push(peer);
    assert.deepEqual(await bounded(store.issue(durableTarget, signal)), durable);
    await immediate(); assert.equal(settled, false);
    finish.resolve(); assert.deepEqual(await peer, await owner);
    await store.writes.drain(); assert.equal(publicationWrites, 1);
  } finally { finish.resolve(); await Promise.allSettled(publications); undoPublication(); }

  // A failed owner must release creation coordination so an already queued peer retries.
  const failedTarget = target('failed-owner'), failureEntered = deferred(), failureRelease = deferred();
  let attempts = 0;
  const undo = replace(table, 'put', async (...args) => {
    if (args[0] === key(failedTarget) && ++attempts === 1) { failureEntered.resolve(); await failureRelease.promise; throw new Error('injected mapping EIO'); }
    return put(...args);
  });
  const retries = [];
  try {
    const failed = assert.rejects(store.issue(failedTarget, signal), e => e.code === writeError); retries.push(failed);
    await bounded(failureEntered.promise);
    const retry = store.issue(failedTarget, signal); retries.push(retry);
    failureRelease.resolve(); await failed;
    assert.deepEqual(await store.issue(failedTarget, signal), await retry);
    await store.writes.drain(); assert.equal(attempts, 2); assert.equal(store.stats().pendingWrites, 0);
  } finally { failureRelease.resolve(); await Promise.allSettled(retries); undo(); }

  // Cancellation of the active owner still drains I/O and preserves its waiting peer.
  const owned = target('cancelled-owner'), ownerEntered = deferred(), ownerRelease = deferred(), owner = new AbortController();
  let ownerWrites = 0, ownerSettled = false;
  const undoOwner = replace(table, 'put', async (...args) => { ownerWrites++; ownerEntered.resolve(); await ownerRelease.promise; return put(...args); });
  const owners = [];
  try {
    const first = assert.rejects(store.issue(owned, owner.signal), /cancel active owner/).then(() => { ownerSettled = true; }); owners.push(first);
    await bounded(ownerEntered.promise);
    const peer = store.issue(owned, signal); owners.push(peer);
    owner.abort(new Error('cancel active owner')); await immediate();
    assert.equal(ownerSettled, false); assert.equal(store.stats().pendingWrites, 2);
    ownerRelease.resolve(); await first; const saved = await peer;
    assert.deepEqual(await store.issue(owned, signal), saved);
    await store.writes.drain(); assert.equal(ownerWrites, 1); assert.equal(store.stats().pendingWrites, 0);
  } finally { ownerRelease.resolve(); await Promise.allSettled(owners); undoOwner(); }
}
