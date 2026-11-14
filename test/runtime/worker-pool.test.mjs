import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { readFile, writeFile, copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import { NativeMatcher, CallTimeline, loadRecallConfig, WORKER_LIMITS, POOL_LIMITS } from '../../lib/index.js';

const manifest = JSON.parse(await readFile(new URL('../../lib/native/manifest.json', import.meta.url), 'utf8'));
const terms = { mode: 'literal', patterns: ['x'], case_sensitive: true };
const record = text => ({ id: 'r', blocks: [{ path: 'data.content[0]', content: { type: 'text', text } }] });
const config = loadRecallConfig();
const tick = () => new Promise(resolve => setTimeout(resolve, 10));
async function until(fn) { for (let i = 0; i < 200 && !fn(); i++) await tick(); assert.ok(fn()); }
const ready = { kind: 'ready', protocol: 1, source: manifest.source, build: manifest.build, rg: '15.2.0', limits: WORKER_LIMITS };
const launch = (fault = 'stall') => (_binary, _args, options) => spawn(process.execPath, ['-e', `
const frame=x=>{const b=Buffer.from(JSON.stringify(x)),n=Buffer.alloc(4);n.writeUInt32BE(b.length);return Buffer.concat([n,b])};const send=x=>process.stdout.write(frame(x));
send({...${JSON.stringify(ready)},pid:process.pid});
let buffer=Buffer.alloc(0),used=false;process.stdin.on('data',chunk=>{buffer=Buffer.concat([buffer,chunk]);if(used||buffer.length<4)return;
const length=buffer.readUInt32BE();if(buffer.length<4+length)return;const r=JSON.parse(buffer.subarray(4,4+length));if(buffer.length<4+length+r.input_bytes)return;used=true;
const ok={...r,complete:true,searches:1,bytes_searched:r.input_bytes,spans:[],matches:0,begin:0,end:0,searches_with_match:0,compiled:true,cache_entries:1,peak_allocated_bytes:1024,compile_ms:0,input_ms:0,scan_and_encode_ms:0};
${fault === 'stall' ? '' : fault === 'duplicate' ? 'process.stdout.write(Buffer.concat([frame(ok),frame(ok)]));' : fault === 'late' ? 'send(ok);setTimeout(()=>send(ok),100);' : fault === 'negative' ? 'send({...ok,cache_entries:-1});' : fault === 'nan' ? 'send({...ok,compile_ms:null});' : fault === 'wrong-id' ? 'send({...ok,request:r.request+1});' : fault === 'oversized' ? 'process.stdout.write(Buffer.from([127,255,255,255]));' : fault === 'truncated' ? 'process.stdout.write(Buffer.from([0,0,0,99,123]));process.exit(0);' : 'send(ok);'} });
`], options);

test('configuration migration and packaged identity are explicit, never CLI fallback', async () => {
  for (const rgPath of ['rg', 'C:/rg.exe']) assert.throws(() => loadRecallConfig({ rgPath }), /obsolete/);
  for (const path of [join(process.env.DSH_HOME, 'missing.exe'), process.execPath]) {
    const matcher = new NativeMatcher(path), timeline = new CallTimeline(config, new AbortController().signal);
    try { await assert.rejects(matcher.validate(terms, timeline), e => ['worker_unavailable', 'worker_version_mismatch'].includes(e.code)); assert.equal(matcher.stats().launches, 0); }
    finally { timeline.dispose(); await matcher.dispose(); }
  }
});

test('two global workers, finite queue, queued cancellation ownership and deadlines', async () => {
  const matcher = new NativeMatcher(undefined, launch()), owners = [], results = [];
  const start = (settings = config) => { const controller = new AbortController(), timeline = new CallTimeline(settings, controller.signal); owners.push({ controller, timeline }); const work = matcher.validate(terms, timeline); results.push(work); void work.catch(() => {}); return work; };
  try {
    start(); start(); await until(() => matcher.stats().active === 2);
    const pids = [...matcher.children];
    const deadline = start(loadRecallConfig({ prepareMs: 10, businessMs: 100, outerMs: 5100 }));
    await assert.rejects(deadline, e => e.code === 'business_deadline'); assert.deepEqual([...matcher.children], pids);
    const queued = start(); await until(() => matcher.stats().queued === 1); owners.at(-1).controller.abort(new Error('queued cancellation'));
    await assert.rejects(queued); assert.deepEqual([...matcher.children], pids);
    for (let i = 0; i < POOL_LIMITS.queued; i++) start(); await until(() => matcher.stats().queued === POOL_LIMITS.queued);
    await assert.rejects(start(), e => e.code === 'worker_resource_limit');
    assert.equal(matcher.stats().live, 2); assert.equal(matcher.stats().launches, 2);
  } finally {
    for (const owner of owners) owner.controller.abort(new Error('test complete'));
    await Promise.allSettled(results); for (const owner of owners) owner.timeline.dispose(); await matcher.dispose();
    assert.deepEqual(matcher.stats(), { live: 0, active: 0, queued: 0, queuedBytes: 0, launches: 2 }); assert.equal(matcher.children.size, 0);
  }
});

test('missing and mismatched worker can recover in the same instance; concurrent recovery shares one pool', async () => {
  const path = join(process.env.DSH_HOME, 'recover-worker.exe'), matcher = new NativeMatcher(path);
  const timelines = Array.from({ length: 8 }, () => new CallTimeline(config, new AbortController().signal));
  try {
    for (let i = 0; i < 2; i++) await assert.rejects(matcher.validate(terms, timelines[0]), { code: 'worker_unavailable' });
    await writeFile(path, 'wrong binary');
    await assert.rejects(matcher.validate(terms, timelines[0]), { code: 'worker_version_mismatch' });
    assert.equal(matcher.pool, undefined); assert.equal(matcher.children.size, 0);
    await copyFile(new URL('../../lib/native/worker.exe', import.meta.url), path);
    const pending = timelines.map(t => matcher.validate(terms, t)), round = matcher.initializing;
    assert.ok(round); assert.equal(matcher.pool, undefined);
    await Promise.all(pending);
    const pool = matcher.pool;
    assert.ok(pool); assert.equal(matcher.stats().launches, 2); assert.ok(matcher.children.size <= 2);
    await matcher.validate(terms, timelines[0]); assert.equal(matcher.pool, pool);
  } finally { timelines.forEach(t => t.dispose()); await matcher.dispose(); assert.equal(matcher.children.size, 0); }
});

test('cancellation and disposal during verification cannot activate a late pool or child', async () => {
  for (const mode of ['cancel', 'dispose', 'dispose-after-init']) {
    const matcher = new NativeMatcher(), abort = new AbortController(), timeline = new CallTimeline(config, abort.signal);
    try {
      const pending = matcher.validate(terms, timeline); void pending.catch(() => {});
      assert.ok(matcher.initializing);
      if (mode === 'cancel') abort.abort(new Error('cancel initialization'));
      else {
        if (mode === 'dispose-after-init') await matcher.initializing;
        await matcher.dispose();
      }
      await assert.rejects(pending);
      assert.equal(matcher.children.size, 0); assert.equal(matcher.stats().active, 0); assert.equal(matcher.stats().queued, 0);
      if (mode === 'cancel') {
        assert.equal(matcher.pool, undefined);
        const retry = new CallTimeline(config, new AbortController().signal);
        try { await matcher.validate(terms, retry); } finally { retry.dispose(); }
      } else await assert.rejects(matcher.validate(terms, timeline), { code: 'worker_failed' });
    } finally { timeline.dispose(); await matcher.dispose(); assert.equal(matcher.children.size, 0); }
  }
});

test('queued byte bound is enforced before encoding and a whole oversized input fails explicitly', async () => {
  const matcher = new NativeMatcher(undefined, launch()), controller = new AbortController(), timeline = new CallTimeline(config, controller.signal), pending = [];
  const submit = text => { const p = matcher.match(record(text), terms, timeline); pending.push(p); void p.catch(() => {}); return p; };
  try {
    submit('a'); submit('b'); await until(() => matcher.stats().active === 2);
    const text = 'a'.repeat(32 * 1024 * 1024); submit(text); submit(text);
    await until(() => matcher.stats().queuedBytes === POOL_LIMITS.queuedBytes);
    await assert.rejects(submit('x'), e => e.code === 'worker_resource_limit');
    await assert.rejects(submit(text + text + 'x'), e => e.code === 'worker_resource_limit');
    assert.equal(matcher.stats().queued, 2);
  } finally { controller.abort(); await Promise.allSettled(pending); timeline.dispose(); await matcher.dispose(); assert.equal(matcher.children.size, 0); }
});

test('malformed, incomplete, duplicate, identity and invalid metric frames never complete a record', async () => {
  for (const fault of ['negative', 'nan', 'wrong-id', 'oversized', 'truncated', 'duplicate']) {
    const matcher = new NativeMatcher(undefined, launch(fault)), timeline = new CallTimeline(config, new AbortController().signal);
    try { await assert.rejects(matcher.match(record('abc'), terms, timeline), e => ['worker_failed', 'worker_output_invalid'].includes(e.code), fault); }
    finally { timeline.dispose(); await matcher.dispose(); assert.equal(matcher.children.size, 0); }
  }
});

test('killed production worker is drained and replacement revalidates the executable', async () => {
  const path = join(process.env.DSH_HOME, '..', 'worker-copy.exe'); await copyFile(new URL('../../lib/native/worker.exe', import.meta.url), path);
  const matcher = new NativeMatcher(path), timeline = new CallTimeline(config, new AbortController().signal);
  try {
    await matcher.validate(terms, timeline); const pid = [...matcher.children][0]; process.kill(pid); await until(() => matcher.children.size === 0);
    await matcher.validate(terms, timeline); assert.equal(matcher.stats().launches, 2);
    process.kill([...matcher.children][0]); await until(() => matcher.children.size === 0);
    await writeFile(path, 'changed');
    await assert.rejects(matcher.validate(terms, timeline), e => e.code === 'worker_dependency_changed'); assert.equal(matcher.stats().launches, 2);
  } finally { timeline.dispose(); await matcher.dispose(); }
});

test('a late frame cannot be attributed to a later complete unit', async () => {
  const matcher = new NativeMatcher(undefined, launch('late')), timeline = new CallTimeline(config, new AbortController().signal);
  try {
    await matcher.validate(terms, timeline);
    await assert.rejects(matcher.match(record('new input'), terms, timeline), e => e.code === 'worker_output_invalid');
    assert.equal(matcher.children.size, 0);
  } finally { timeline.dispose(); await matcher.dispose(); }
});

test('fixed operation order survives record boundaries and higher priority interrupts only complete units', async () => {
  const matcher = new NativeMatcher(), timelines = [10, 20, 30].map(order => {
    const t = new CallTimeline(config, new AbortController().signal); t.operation = { sessionId: String(order), order, priority: () => order === 30 ? priority : 4 }; return t;
  });
  let priority = 4, release, count = 0, confirmed = 0, confirmBoth;
  const gate = new Promise(resolve => { release = resolve; }), starts = [];
  const bothConfirmed = new Promise(resolve => { confirmBoth = resolve; });
  try {
    await Promise.all(timelines.slice(0, 2).map(t => matcher.validate(terms, t)));
    for (const channel of matcher.pool.channels) {
      const run = channel.request.bind(channel);
      channel.request = async (...args) => {
        const at = count++; starts.push(args[3].recordId); if (at < 2) await gate;
        const result = await run(...args);
        // Make both first-batch completions ready together. If one native pipe
        // responds earlier, the pool may legally use that idle worker for B;
        // operation order does not reserve capacity for A's absent next batch.
        if (at < 2) { if (++confirmed === 2) confirmBoth(); await bothConfirmed; }
        return result;
      };
    }
    const batch = (t, round) => Promise.all([0, 1].map(i => matcher.match({ ...record('abc'), id: `${t.operation.order}-${round}-${i}` }, terms, t)));
    const a = (async () => { await batch(timelines[0], 0); await new Promise(resolve => setImmediate(resolve)); await batch(timelines[0], 1); })();
    await until(() => starts.length === 2);
    const b = batch(timelines[1], 0); await until(() => matcher.stats().queued === 2);
    release(); await Promise.all([a, b]);
    assert.deepEqual(starts.map(id => id.split('-')[0]), ['10', '10', '10', '10', '20', '20']);
    // Both workers are now occupied by whole units; changing priority cannot interrupt them.
    let unblock; const blocked = new Promise(resolve => { unblock = resolve; }); starts.length = 0;
    for (const channel of matcher.pool.channels) {
      const run = channel.request.bind(channel); channel.request = async (...args) => { if (args[3].recordId.includes('hold')) await blocked; return run(...args); };
    }
    const active = Promise.all([0, 1].map(i => matcher.match({ ...record('abc'), id: `10-hold-${i}` }, terms, timelines[0])));
    await until(() => matcher.stats().active === 2);
    const old = batch(timelines[1], 1), current = batch(timelines[2], 0); await until(() => matcher.stats().queued === 4);
    priority = 0; matcher.wake(); unblock(); await Promise.all([active, old, current]);
    assert.deepEqual(starts.map(id => id.split('-')[0]), ['10', '10', '30', '30', '20', '20']);
  } finally { release?.(); timelines.forEach(t => t.dispose()); await matcher.dispose(); }
});
