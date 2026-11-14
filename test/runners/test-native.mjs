import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { PrototypeMatcher, WorkerChannel, LIMITS, RgMatcher } from '../reference/native-client.mjs';
import { NativeMatcher, CallTimeline, loadRecallConfig } from '../../lib/index.js';

const root = fileURLToPath(new URL('../../.local/native-tests/', import.meta.url)); await mkdir(root, { recursive: true });
const run = await mkdtemp(join(root, 'run-'));
const installation = JSON.parse(await readFile(new URL('../../.local/tools/rg-install.json', import.meta.url), 'utf8'));
const manifest = JSON.parse(await readFile(new URL('../../.local/native-build/manifest.json', import.meta.url), 'utf8'));
const production = process.argv.includes('--production');
const cli = new RgMatcher(installation.executable), candidate = production ? new NativeMatcher() : new PrototypeMatcher(), config = loadRecallConfig();
const record = (parts, attachment) => ({ id: 'record', blocks: [...parts.map((text, index) => ({ index, path: `data.content[${index}]`, content: { type: 'text', text } })),
  ...(attachment ? [{ index: parts.length, path: `data.content[${parts.length}]`, content: { type: 'file', attachment } }] : [])] });
const terms = (patterns, mode = 'regex', case_sensitive = false) => ({ patterns, mode, case_sensitive });
const call = async (fn, signal = new AbortController().signal, settings = config) => {
  const timeline = new CallTimeline(settings, signal);
  try { return await fn(timeline); } finally { timeline.dispose(); }
};
const outcome = async fn => { try { return { result: await fn() }; } catch (e) { return { code: e.code ?? e.name, invalidIdentity: e.invalidIdentity,
  ...(e.code === 'rg_output_invalid' ? { reason: e.message } : {}) }; } };
let seed = 0x5eedc0de; const random = n => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) % n; };
const literals = ['alpha','BETA','中文','编号42','😀','é','e\u0301','\r\n','\n','\0',' x ','\uFEFF','Ω','δ','İ','K','ſ','zz','a.*b'];
const regex = ['alpha','BETA','中文','编号\\d+','(?m)^','$','\\z','\\A','\\b\\w+\\b','(?s:alpha.*BETA)',
  '(?-i:BETA)','(?i:alpha)','[\\s\\S]*','a*','.*','.{0,3}','\\p{Greek}+','(?:😀|中文)','\\x00','é|e\\u0301',
  'alpha\\r?\\nBETA','alpha.BETA','(?m)^.*$','^alpha','[A-Z]+','[\\x00-\\x7f]+','\\b','\\B'];
const invalid = ['[','(','(?=x)','(?<=a)b','(a)\\1','\\','a{4,2}','\\\0','\ud800'];
const fixed = [
  [['前😀fo','o\r\nba','r\nend'],terms(['foo\\r?\\nbar'])],
  [['foo\nbar'],terms(['foo.bar'])], [['foo\nbar'],terms(['foo\nbar'],'literal')],
  [['x\0y'],terms(['x\0y'])], [['foo\n'],terms(['foo[\\s\\S]*bar'])], [['bar'],terms(['foo[\\s\\S]*bar'])],
  [['one\ntwo\n'],terms(['(?m)^','$'])], [[''],terms(['^','$'])], [['x\n'],terms(['$','x'])],
  [['x\r\n'],terms(['.*'])], [['\uFEFF中文\0END'],terms(['\uFEFF','\0END'],'literal')],
  [['a.*b δ a.*b δ'],terms(['^alpha','$'],'regex',true),{name:'δ',description:' x '}],
  [['abc'],terms(['ab','a'])], [['abc'],terms(['a','ab'])], [['bad\ud800'],terms(['bad'],'literal')],
  [['plain'],terms(['native-id','中文'],'literal'),{ attachmentId:'native-id', name:'中文.txt' }],
  [['body-left'],terms(['left[\\s\\S]*right']),{ name:'right', description:'tail' }],
  [['plain'],terms(['left[\\s\\S]*right']),{ name:'left', description:'right' }],
  [['plain'],terms(['internal-secret','data.content'],'literal'),{ name:'hello' }],
];
const summary = createHash('sha256'), rows = [], started = performance.now();
try {
  for (let i = 0; i < 1200 + fixed.length; i++) {
    let parts, query, attachment;
    if (i < fixed.length) [parts, query, attachment] = fixed[i];
    else {
      let text = Array.from({ length: random(12) }, () => literals[random(literals.length)]).join(random(2) ? ' ' : '');
      if (random(3) === 0) text += '\n';
      const cut = random(text.length + 1); parts = [text.slice(0, cut), text.slice(cut)];
      const mode = random(3) ? 'regex' : 'literal', pool = mode === 'regex' ? regex : literals;
      const patterns = Array.from({ length: 1 + random(3) }, () => pool[random(pool.length)]);
      if (i % 17 === 0) patterns.push(invalid[random(invalid.length)]);
      if (i % 13 === 0) patterns.push(patterns[0]);
      query = terms(patterns, i % 17 === 0 ? 'regex' : mode, !!random(2));
      if (i % 11 === 0) attachment = { name:literals[random(literals.length)], description:literals[random(literals.length)] };
    }
    const source = record(parts, attachment);
    // The frozen P1 candidate keeps its original contract; current regex searches use inline flags only.
    const referenceQuery = production && query.mode === 'regex' ? { ...query, case_sensitive: false } : query;
    const expected = await outcome(() => call(t => cli.match(source, referenceQuery, t)));
    const actual = await outcome(() => call(t => candidate.match(source, query, t)));
    assert.deepEqual(actual, expected, `differential case ${i}: ${JSON.stringify({ parts, query, attachment })}`);
    summary.update(JSON.stringify({ i, query, parts, attachment, expected }));
    rows.push({ i, code: actual.code ?? 'ok', spans: actual.result?.spans.length ?? null, reason: actual.reason });
    if (i % 200 === 0) console.log(`Differential ${i}/${1200 + fixed.length}`);
  }
  const identities = [];
  for (const patterns of [['['], ['valid','['], ['[','other','valid','[']]) {
    const a = await outcome(() => call(t => cli.validate(terms(patterns), t)));
    const b = await outcome(() => call(t => candidate.validate(terms(patterns), t)));
    assert.deepEqual(b, a); identities.push(b.invalidIdentity);
  }
  assert.equal(new Set(identities).size, 1);
  await writeFile(join(run, 'differential.json'), JSON.stringify({ manifest, rg:cli.info, seed:'0x5eedc0de', cases:rows.length,
    digest:summary.digest('hex'), elapsedMs:performance.now()-started, rows, worker:candidate.stats() }, null, 2));
} finally { await candidate.dispose(); assert.equal(candidate.children.size, 0); }

const failures = [];
// Inject protocol faults after a valid handshake: none can publish a unit.
const ready = { protocol:1, kind:'ready', build:manifest.build, source:manifest.source, rg:'15.2.0', limits:LIMITS };
for (const fault of ['truncated','wrong-id','bad-json','oversized','exit','cancel']) {
  const source = `const send=x=>{let b=Buffer.from(JSON.stringify(x)),n=Buffer.alloc(4);n.writeUInt32BE(b.length);process.stdout.write(n);process.stdout.write(b)};
    send({...${JSON.stringify(ready)},pid:process.pid});let used=false;process.stdin.on('data',()=>{if(used)return;used=true;
    ${fault === 'truncated' ? 'process.stdout.write(Buffer.from([0,0,0,99,123]));process.exit(0)' :
      fault === 'wrong-id' ? 'send({protocol:1,request:999})' :
      fault === 'bad-json' ? 'process.stdout.write(Buffer.from([0,0,0,1,123]))' :
      fault === 'oversized' ? 'process.stdout.write(Buffer.from([127,255,255,255]))' :
      fault === 'exit' ? 'process.exit(3)' : 'setTimeout(()=>{},10000)'} });`;
  const channel = new WorkerChannel(manifest, (_binary, _args, options) => spawn(process.execPath, ['-e', source], options));
  const controller = new AbortController(); const timer = fault === 'cancel' ? setTimeout(() => controller.abort(new Error('owned cancellation')), 100) : undefined;
  try { await assert.rejects(call(t => channel.request('complete native input',terms(['native'],'literal'),t,{purpose:'match',recordId:'r',field:'body'}),controller.signal)); failures.push(fault); }
  finally { clearTimeout(timer); await channel.dispose(); assert.equal(channel.ended,true); }
}
const cancelled = new PrototypeMatcher(), controller = new AbortController();
try {
  await call(t => cancelled.validate(terms(['warm'],'literal'),t));
  const work = call(t => cancelled.match(record(['a'.repeat(32 * 1024 * 1024)]), terms(['a+']), t), controller.signal);
  setTimeout(() => controller.abort(new Error('cancel actual worker')), 1);
  await assert.rejects(work);
} finally { await cancelled.dispose(); assert.equal(cancelled.children.size,0); }
await writeFile(join(run,'protocol.json'),JSON.stringify({failures,realCancellation:true,childrenAfterClose:0},null,2));
console.log(`Native candidate evidence: ${run}`);
