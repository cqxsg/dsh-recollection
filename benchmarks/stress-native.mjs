import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, mkdtemp } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrototypeMatcher } from '../test/reference/native-client.mjs';
import { processResourceMeter } from './resources.mjs';
import { NativeMatcher, CallTimeline, loadRecallConfig } from '../lib/index.js';
const base = fileURLToPath(new URL('../.local/native-pressure/', import.meta.url)); await mkdir(base,{recursive:true}); const root=await mkdtemp(join(base,'run-'));
const meter=await processResourceMeter();
const production=process.argv.includes('--production'), exits=[];
const matcher=new (production ? NativeMatcher : PrototypeMatcher)(undefined,(...args)=>{
  const child=spawn(...args); if(child.pid)meter.track(child.pid);
  child.once('close',(code,signal)=>exits.push({pid:child.pid,code,signal}));return child;
});
const record=text=>({id:'r',blocks:[{path:'a',content:{type:'text',text:text.slice(0,123)}},{path:'b',content:{type:'text',text:text.slice(123)}}]});
const rows=[];
async function run(label,text,patterns,allowLimit=false) {
  meter.phase(label); const timeline=new CallTimeline(loadRecallConfig(),new AbortController().signal),started=performance.now();
  try {
    const found=await matcher.match(record(text),{mode:'regex',patterns,case_sensitive:true},timeline);
    rows.push({label,bytes:Buffer.byteLength(text),status:'ok',spans:found.spans.length,elapsedMs:performance.now()-started});
    return found;
  } catch(e) {
    if(!allowLimit || e.code!=='worker_resource_limit')throw e;
    rows.push({label,bytes:Buffer.byteLength(text),status:e.code,elapsedMs:performance.now()-started,
      exitCodes:production ? exits.map(c=>c.code) : matcher.channels.map(c=>c.exitCode??null)});
  } finally {
    timeline.dispose();
    if(production){const state=matcher.stats();assert.ok(state.live<=2 && state.queued<=32 && state.queuedBytes<=64*1024*1024)}
  }
}
let resources;
try {
  for(const size of [1,8,32]) {
    const text=`LEFT${'a'.repeat(size*1024*1024)}RIGHT`;
    const none=await run(`${size}MiB-none`,text,['absent'],size===32);if(none)assert.equal(none.spans.length,0);
    const whole=await run(`${size}MiB-whole`,text,['LEFT[\\s\\S]+RIGHT'],size>1);
    if(whole){assert.equal(whole.spans.length,1);assert.equal(whole.spans[0].end,text.length);assert.equal(whole.spans[0].locations.length,2)}
  }
  assert.equal(await run('dense-million','a'.repeat(1_000_000),['a'],true),undefined);
  assert.equal(await run('dense-zero-width','x'.repeat(1_000_000),['(?m)^|\\B'],true),undefined);
  // Large default-engine compilation must be bounded even below its own 100MiB NFA limit.
  await run('compile-pressure','x',['(?:[a-zA-Z0-9]){100000}'],true);
  assert.equal(await run('allocation-limit','a'.repeat(64*1024*1024),['absent\\npattern'],true),undefined);
  assert.ok(exits.some(c=>c.code===70),'allocation guard must terminate the owned worker with exit 70');
  assert.equal(await run('oversize-input','a'.repeat(64*1024*1024+1),['absent'],true),undefined);
  const zero=await run('zero-width-small','x'.repeat(4096),['(?m)^']);
  assert.equal(zero.spans.length,1);assert.equal(zero.spans[0].start,0);assert.equal(zero.spans[0].end,0);
  assert.equal((await run('repeated-pattern','needle',['needle','needle'])).spans.length,1);
  for(const [label,patterns] of [['invalid',['valid','[']],['unsupported',['(?<=a)b']]]){
    const timeline=new CallTimeline(loadRecallConfig(),new AbortController().signal),started=performance.now();
    try{await assert.rejects(matcher.validate({mode:'regex',patterns,case_sensitive:true},timeline),e=>e.code==='invalid_pattern');
      rows.push({label,status:'invalid_pattern',elapsedMs:performance.now()-started})}finally{timeline.dispose()}
  }
  for(let i=0;i<12;i++)assert.equal((await run(`cache-${i}`,'small record',[`condition${i}`])).spans.length,0);
  if(!production)assert.ok(matcher.channels.every(c=>c.stats.peakAllocatedBytes<=128*1024*1024));
} finally {await matcher.dispose(); resources=await meter.stop();assert.equal(matcher.children.size,0)}
assert.equal(resources.complete,true);assert.equal(resources.droppedFrames,0);assert.equal(resources.droppedRecords,0);
assert.equal(resources.stats.openMisses,0);assert.equal(resources.stats.cpuMissing,0);assert.equal(resources.stats.rssMissing,0);
if(!production)assert.ok(resources.stats.sampledTreePeakBytes<1024*1024*1024);
if(production){assert.equal(matcher.stats().live,0);assert.equal(matcher.stats().queued,0);assert.equal(matcher.stats().queuedBytes,0)}
await writeFile(join(root,'result.json'),JSON.stringify({adapter:production?'production':'p1-prototype',manifest:matcher.info,rows,worker:matcher.stats(),exits,resources,
  rssTargetIsAdvisory:production,sampledTreeWithinGiB:resources.stats.sampledTreePeakBytes<1024**3},null,2));
console.log(JSON.stringify({evidence:root,rows,peakMiB:resources.stats.sampledTreePeakBytes/1024/1024,processes:resources.registeredByHost}));
