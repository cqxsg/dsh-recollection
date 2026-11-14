import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { test } from 'node:test';
import { corpusManifest, makeCorpus, QUERIES, BOUNDARY_QUERIES, expectedIndexes } from '../../benchmarks/corpus.mjs';
import { processResourceMeter } from '../../benchmarks/resources.mjs';
import { RgMatcher } from '../../.local/cli-matcher.mjs';
import { CallTimeline, loadRecallConfig, parseRequest } from '../../lib/index.js';

test('frozen data, length distribution, query membership and independent fields agree with rg', async () => {
  assert.deepEqual(corpusManifest(), JSON.parse(await readFile(new URL('../../benchmarks/performance-manifest.json', import.meta.url), 'utf8')));
  const corpus = makeCorpus('mixed', 128), matcher = new RgMatcher();
  for (const query of [...QUERIES, ...BOUNDARY_QUERIES]) {
    const terms = parseRequest('search', { action: 'search', mode: query.mode, patterns: query.patterns, case_sensitive: query.case_sensitive });
    const expected = expectedIndexes(query, 128), timeline = new CallTimeline(loadRecallConfig(), new AbortController().signal);
    try {
      for (const i of [0, 1, 10, 100, 127]) {
        const source = corpus.records[i];
        const blocks = [...source.parts.map(text => ({ type: 'text', text })), ...(source.attachment ? [{ type: 'file', attachment: source.attachment }] : [])];
        const record = { id: `row-${i}`, blocks: blocks.map((content, index) => ({ index, path: `data.content[${index}]`, content })) };
        const result = await matcher.match(record, terms, timeline);
        assert.equal(result.spans.length > 0, expected.includes(i), `${query.id} at ${i}`);
      }
    } finally { timeline.dispose(); }
  }
  assert.equal(matcher.children.size, 0);
});

test('Windows sampler retains process identity, real CPU, overlapping RSS and explicit omissions', { skip: process.platform !== 'win32' }, async () => {
  const meter = await processResourceMeter({ intervalMs: 5, maxRecords: 100 });
  const children = [];
  try {
    meter.phase('concurrent');
    for (let i = 0; i < 2; i++) {
      const child = spawn(process.execPath, ['-e', 'const b=Buffer.alloc(16*1024*1024,7); const end=Date.now()+500; while(Date.now()<end) { Math.sqrt(Math.random()); } process.stdout.write(String(b[0]));'], { windowsHide: true, stdio: 'ignore' });
      children.push(child); meter.track(child.pid);
    }
    meter.track(children[0].pid); // Same identity is never included twice in a sampling sweep.
    meter.track(2147483647); // Missing processes are unknown, not zero CPU/RSS.
    await Promise.all(children.map(child => once(child, 'close')));
    const result = await meter.stop();
    assert.equal(result.complete, true);
    assert.equal(result.stats.duplicateIdentity, 1); assert.equal(result.stats.openMisses, 1);
    const good = result.processes.filter(p => p.kind === 'matcher' && !p.failure);
    assert.equal(good.length, 2);
    for (const row of good) {
      assert.ok(row.cpuMs > 0 && row.cpuComplete); assert.ok(row.sampledPeakRssBytes >= 16 * 1024 * 1024);
      assert.equal(row.aliveAtCaptureEnd, false);
    }
    assert.equal(result.stats.sampledTreePeakBytes, result.stats.peakSample.members.reduce((n, p) => n + p.rssBytes, 0));
    assert.equal(new Set(result.stats.peakSample.members.map(p => p.pid)).size, result.stats.peakSample.members.length);
    assert.ok(result.processes.some(p => p.kind === 'observer' && p.cpuMs !== null));
    assert.ok(result.processes.some(p => p.failure === 'open_or_identity_unavailable' && p.cpuMs === null));
  } finally {
    for (const child of children) if (child.exitCode === null) child.kill();
    await meter.stop();
  }
});

test('sampler detail retention is bounded while complete aggregate CPU survives overflow', { skip: process.platform !== 'win32' }, async () => {
  const meter = await processResourceMeter({ maxRecords: 1 });
  try {
    for (let i = 0; i < 3; i++) {
      const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60)'], { windowsHide: true, stdio: 'ignore' });
      meter.track(child.pid); await once(child, 'close');
    }
    const result = await meter.stop();
    assert.equal(result.stats.registered, 3); assert.equal(result.stats.closed, 3);
    assert.equal(result.droppedRecords, 2); assert.equal(result.processes.filter(p => p.kind === 'matcher').length, 1);
    assert.equal(result.stats.openMisses, 0); assert.equal(result.stats.cpuMissing, 0);
  } finally { await meter.stop(); }
});

test('sampler distinguishes killed work, active-handle exhaustion and observer failure', { skip: process.platform !== 'win32' }, async () => {
  const meter = await processResourceMeter();
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { windowsHide: true, stdio: 'ignore' });
  const closed = once(child, 'close');
  try {
    meter.track(child.pid);
    await new Promise(resolve => setTimeout(resolve, 100));
    child.kill(); await closed;
    const result = await meter.stop();
    const row = result.processes.find(p => p.kind === 'matcher');
    assert.ok(row.cpuComplete); assert.equal(row.aliveAtCaptureEnd, false);
    assert.equal(result.stats.closed, 1);
  } finally { if (child.exitCode === null) child.kill(); await meter.stop(); }
  const bounded = await processResourceMeter({ maxActive: 2 });
  bounded.track(process.pid);
  const exhausted = await bounded.stop();
  assert.equal(exhausted.stats.activeLimitMisses, 1);
  assert.equal(exhausted.processes.find(p => p.kind === 'matcher').cpuMs, null);
  const failed = await processResourceMeter();
  process.kill(failed.snapshot().environment.pid);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal((await failed.stop()).complete, false);
});
