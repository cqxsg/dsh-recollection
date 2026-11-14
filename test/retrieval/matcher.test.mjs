import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { NativeMatcher, CallTimeline, loadRecallConfig, parseRequest, startPerformanceCapture } from '../../lib/index.js';

const config = loadRecallConfig();
const record = (text, id = 'record') => ({ id, blocks: (Array.isArray(text) ? text : [text]).map((value, index) => ({ index, path: `data.content[${index}]`, content: { type: 'text', text: value } })) });
const terms = (patterns, mode = 'literal', rest = {}) => parseRequest('search', { action: 'search', patterns, mode, ...rest });
async function call(fn, upstream = new AbortController()) {
  const timeline = new CallTimeline(config, upstream.signal);
  try { return await fn(timeline); } finally { timeline.dispose(); }
}
const matcher = new NativeMatcher();
after(() => matcher.dispose());

test('known Unicode, OR, case, whitespace, literal metacharacters and default engine semantics', async () => {
  const cases = [
    ['中文 编号42 😀 e\u0301', terms(['编号\\d+'], 'regex'), ['编号42']],
    ['Aa aa AA', terms(['aa']), ['Aa', 'aa', 'AA']],
    ['Aa aa AA', terms(['aa'], 'literal', { case_sensitive: true }), ['aa']],
    ['Aa aa AA', terms(['aa'], 'regex', { case_sensitive: false }), ['Aa', 'aa', 'AA']],
    ['Aa aa AA', terms(['aa'], 'regex', { case_sensitive: true }), ['Aa', 'aa', 'AA']],
    ['Aa aa AA', terms(['(?-i:AA)'], 'regex'), ['AA']],
    ['Aa aa AA', terms(['(?-i:AA)'], 'regex', { case_sensitive: true }), ['AA']],
    ['Aa aa AA', terms(['(?i:aa)'], 'regex', { case_sensitive: true }), ['Aa', 'aa', 'AA']],
    ['Aa aa AA', terms(['(?-i:AA)|(?i:aa)'], 'regex', { case_sensitive: true }), ['Aa', 'aa', 'AA']],
    ['A\0x a\0x', terms(['A\0x'], 'literal', { case_sensitive: true }), ['A\0x']],
    ['A\0x a\0x', terms(['A\0x'], 'literal', { case_sensitive: false }), ['A\0x', 'a\0x']],
    ['  key  \nother', terms(['  key  ']), ['  key  ']],
    ['one two', terms(['two', 'one']), ['one', 'two']],
    ['a.*b literal', terms(['a.*b']), ['a.*b']],
    ['😀e\u0301\uFEFF\0END', terms(['😀', 'e\u0301', '\0END']), ['😀', 'e\u0301', '\0END']],
    ['é e\u0301', terms(['é']), ['é']],
    [' ', terms([' ']), [' ']],
  ];
  await call(async timeline => {
    for (const [text, query, expected] of cases) {
      await matcher.validate(query, timeline);
      const found = await matcher.match(record(text), query, timeline);
      assert.deepEqual(found.spans.map(s => text.slice(s.start, s.end)), expected);
      for (const span of found.spans) assert.equal(Buffer.from(text).subarray(span.byteStart, span.byteEnd).toString(), text.slice(span.start, span.end));
    }
  });
});
test('multiline/CRLF/NUL and cross-block matches retain exact offsets without crossing records', async () => {
  await call(async timeline => {
    const text = '前😀foo\r\nbar\nend';
    const found = await matcher.match(record(['前😀fo', 'o\r\nba', 'r\nend']), terms(['foo\\r?\\nbar'], 'regex'), timeline);
    assert.equal(found.spans[0].start, 3); assert.equal(text.slice(found.spans[0].start, found.spans[0].end), 'foo\r\nbar');
    assert.equal(found.spans[0].locations.length, 3);
    assert.equal((await matcher.match(record(text), terms(['foo.bar'], 'regex'), timeline)).spans.length, 0);
    assert.equal((await matcher.match(record('foo\nbar'), terms(['foo\nbar']), timeline)).spans.length, 1);
    for (const text of ['foo\n', 'bar']) assert.equal((await matcher.match(record(text), terms(['foo[\\s\\S]*bar'], 'regex'), timeline)).spans.length, 0);
    assert.equal((await matcher.match(record('x\0y'), terms(['x\0y'], 'regex'), timeline)).spans.length, 1);
  });
});
test('all patterns compile before scanning; invalid and unsupported regex, bad Unicode and dependencies fail explicitly', async () => {
  await call(async timeline => {
    for (const pattern of ['(', '(?<=a)b', '(a)\\1']) await assert.rejects(matcher.validate(terms(['valid', pattern], 'regex'), timeline), e => e.code === 'invalid_pattern');
    await assert.rejects(matcher.validate(terms(['\ud800']), timeline), e => e.code === 'invalid_pattern');
    await assert.rejects(matcher.match(record('bad\ud800'), terms(['bad']), timeline), e => e.code === 'source_encoding_invalid');
    await assert.rejects(new NativeMatcher(join(process.cwd(), 'missing-rg')).validate(terms(['x']), timeline));
    const wrong = new NativeMatcher(undefined, () => spawn(process.execPath, ['-e', 'const b=Buffer.from(JSON.stringify({kind:"ready",protocol:0})),n=Buffer.alloc(4);n.writeUInt32BE(b.length);process.stdout.write(n);process.stdout.write(b);process.stdin.resume();'], { windowsHide: true }));
    await assert.rejects(wrong.validate(terms(['x']), timeline), e => e.code === 'worker_version_mismatch');
  });
});
test('native metadata values are separately mapped; record IDs, paths and internal headers never match', async () => {
  const r = record('plain', 'internal-secret');
  r.blocks.push({ index: 1, path: 'data.content[1]', content: { type: 'file', attachment: { attachmentId: 'native-id', name: '中文.txt' } } });
  await call(async timeline => {
    assert.equal((await matcher.match(r, terms(['internal-secret', 'data.content']), timeline)).spans.length, 0);
    const hits = await matcher.match(r, terms(['中文']), timeline);
    assert.equal(hits.spans[0].field, 'metadata'); assert.equal(hits.spans[0].locations[0].path, 'data.content[1].attachment.name');
  });
});

test('invalid pattern identities isolate causes and ignore unrelated OR conditions without extra valid-query processes', async () => {
  let launches = 0;
  const counted = new NativeMatcher(undefined, (...args) => { launches++; return spawn(...args); });
  await call(async timeline => {
    await counted.validate(terms(['valid', 'another'], 'regex'), timeline);
    assert.equal(launches, 1, 'one reusable worker, not one process per condition');
    const invalid = async patterns => {
      let failure;
      await assert.rejects(counted.validate(terms(patterns, 'regex'), timeline), error => {
        failure = error; return error.code === 'invalid_pattern' && /^[a-f0-9]{64}$/.test(error.invalidIdentity);
      });
      return failure;
    };
    const first = await invalid(['[']);
    assert.equal((await invalid(['valid', '['])).invalidIdentity, first.invalidIdentity);
    assert.equal((await invalid(['[', 'unrelated', 'valid', '['])).invalidIdentity, first.invalidIdentity);
    assert.notEqual((await invalid(['(?=needle)'])).invalidIdentity, first.invalidIdentity);
    assert.notEqual((await invalid(['('])).invalidIdentity, first.invalidIdentity);
    assert.notEqual((await invalid(['\ud800'])).invalidIdentity, (await invalid(['\\\0'])).invalidIdentity);
  });
  assert.equal(counted.stats().active, 0); await counted.dispose(); assert.equal(counted.children.size, 0);
});
test('very long whole-record matches cross internal blocks and yield to Host notifications; costs are recorded', async () => {
  const middle = 'a'.repeat(2_000_000), text = `prefix LEFT${middle}RIGHT suffix`;
  let notifications = 0, delay = 0, last = performance.now(), peak = process.memoryUsage().heapUsed;
  const timer = setInterval(() => { const now = performance.now(); delay = Math.max(delay, now - last - 5); last = now; notifications++; peak = Math.max(peak, process.memoryUsage().heapUsed); }, 5);
  const before = process.memoryUsage(), started = performance.now();
  try {
    await call(async timeline => {
      const hits = await matcher.match(record(['prefix LEFT', middle.slice(0, 900000), middle.slice(900000), 'RIGHT suffix']), terms(['LEFT[\\s\\S]+RIGHT'], 'regex'), timeline);
      assert.equal(hits.spans.length, 1); assert.equal(hits.spans[0].end - hits.spans[0].start, middle.length + 9); assert.equal(hits.spans[0].locations.length, 4);
    });
  } finally { clearInterval(timer); }
  assert.ok(notifications > 0);
  const output = join(process.env.DSH_HOME, '..', 'matcher-evidence.json');
  await writeFile(output, JSON.stringify({ binary: matcher.info, chars: text.length, elapsedMs: performance.now() - started, notificationCount: notifications, notificationExtraDelayMs: delay, beforeHeap: before.heapUsed, sampledPeakHeap: peak, memoryAfter: process.memoryUsage() }, null, 2));
  console.log(`Matcher evidence: ${output}`);
});
test('real child cancellation is awaited and partial/malformed output or exit failure cannot commit a record', async () => {
  const capture = startPerformanceCapture({ maxEvents: 2 });
  try {
    const abort = new AbortController(); let killed = 0;
    const real = new NativeMatcher(undefined, (binary, args, options) => {
      const child = spawn(binary, args, options);
      if (!args.includes('--version')) { killed++; setImmediate(() => abort.abort(new Error('test cancel'))); }
      return child;
    });
    await assert.rejects(call(timeline => real.match(record('a'.repeat(4_000_000)), terms(['a+'], 'regex'), timeline), abort));
    assert.equal(killed, 1); assert.equal(real.children.size, 0);
    for (const source of [
      'process.stdout.write(Buffer.from([0,0,0,99,123]));process.exit(0);',
      'process.stdin.resume();console.log("malformed");',
      'process.stderr.write("injected failure");process.exit(3);',
    ]) {
      const broken = new NativeMatcher(undefined, (_binary, _args, options) => spawn(process.execPath, ['-e', source], options));
      await assert.rejects(call(timeline => broken.match(record('abc'), terms(['a']), timeline)), e => ['worker_version_mismatch', 'worker_output_invalid', 'worker_failed'].includes(e.code));
      assert.equal(broken.children.size, 0);
    }
    const short = new CallTimeline(loadRecallConfig({ prepareMs: 1, businessMs: 1, outerMs: 5001 }), new AbortController().signal);
    try { await assert.rejects(matcher.match(record('a'.repeat(4_000_000)), terms(['a+'], 'regex'), short), e => e.code === 'business_deadline'); }
    finally { short.dispose(); }
    const diagnostics = capture.snapshot();
    assert.equal(diagnostics.active, 0);
    assert.ok(diagnostics.droppedEvents > 0);
    assert.ok(diagnostics.aggregates['matcher.process'].failed > 0);
  } finally { capture.stop(); }
});

test('30 balanced diagnostic microbenchmark pairs preserve exact spans and invalid-condition identity', async () => {
  const rows = [], cases = [
    [record(['secret-prefix 前😀fo', 'o\r\nbar\0end']), terms(['foo\\r?\\nbar', '\\x00end'], 'regex')],
    [record('Aa aa AA é e\u0301'), terms(['aa', 'é'])],
    [record('foo\nbar'), terms(['foo.bar'], 'regex')],
    [record('one\ntwo\n'), terms(['(?m)^', '$'], 'regex')],
    [record('a.*b literal'), terms(['a.*b'])],
  ];
  const meta = record('file body'); meta.blocks.push({ index: 1, path: 'data.content[1]', content: { type: 'file', attachment: { name: '中文.txt', attachmentId: 'native-id' } } });
  cases.push([meta, terms(['中文', 'body'])]);
  await call(timeline => matcher.validate(terms(['warmup']), timeline));
  for (let repeat = 0; repeat < 30; repeat++) {
    const [source, query] = cases[repeat % cases.length], pair = {};
    for (const enabled of repeat % 2 ? [true, false] : [false, true]) {
      const capture = enabled ? startPerformanceCapture() : undefined;
      const start = performance.now();
      try {
        const result = await call(timeline => matcher.match(source, query, timeline));
        pair[enabled ? 'on' : 'off'] = { elapsedMs: performance.now() - start, result };
        if (capture) {
          const snapshot = capture.snapshot();
          assert.equal(snapshot.active, 0);
          assert.equal(snapshot.aggregates['matcher.unit'].counters.confirmedUnits, source === meta ? 3 : 1);
          assert.equal(snapshot.aggregates['matcher.process']?.started ?? 0, 0, 'warm requests reuse the verified worker');
          assert.ok(snapshot.events.filter(e => e.kind === 'matcher.unit').every(e => e.marks.inputQueuedMs >= e.marks.admittedMs));
          assert.equal(JSON.stringify(snapshot).includes('secret-prefix'), false);
        }
      } finally { capture?.stop(); }
    }
    assert.deepEqual(pair.on.result, pair.off.result);
    rows.push({ repeat, case: repeat % cases.length, offMs: pair.off.elapsedMs, onMs: pair.on.elapsedMs });
  }
  for (const patterns of [['['], ['valid', '['], ['(?<=a)b']]) {
    const identities = [];
    for (const enabled of [false, true]) {
      const capture = enabled ? startPerformanceCapture() : undefined;
      try { await assert.rejects(call(t => matcher.validate(terms(patterns, 'regex'), t)), error => { identities.push(error.invalidIdentity); return error.code === 'invalid_pattern'; }); }
      finally { assert.equal(capture?.snapshot().active ?? 0, 0); capture?.stop(); }
    }
    assert.equal(identities[0], identities[1]);
  }
  const output = join(process.env.DSH_HOME, '..', 'performance-micro-evidence.json');
  await writeFile(output, JSON.stringify({ repeats: 30, binary: matcher.info, rows }, null, 2));
  console.log(`Performance micro evidence: ${output}`);
});
