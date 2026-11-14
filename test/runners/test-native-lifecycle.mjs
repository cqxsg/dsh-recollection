import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { processResourceMeter } from '../../benchmarks/resources.mjs';
const base=fileURLToPath(new URL('../../.local/native-lifecycle/',import.meta.url));await mkdir(base,{recursive:true});const root=await mkdtemp(join(base,'run-'));
const manifest=JSON.parse(await readFile(new URL('../../.local/native-build/manifest.json',import.meta.url),'utf8'));
const meter=await processResourceMeter(),rows=[];
try{
  for(const fault of ['truncated-header','oversized-header','truncated-input','wrong-digest']){
    const child=spawn(manifest.executable,['--parent-pid',String(process.pid)],{windowsHide:true,stdio:'pipe'});meter.track(child.pid);
    const closed=new Promise((resolve,reject)=>{child.once('close',resolve);child.once('error',reject)});
    let ready=false;child.stderr.resume();child.stdin.on('error',()=>{});
    child.stdout.on('data',()=>{if(ready)return;ready=true;setTimeout(()=>{
      if(fault==='truncated-header'){child.stdin.end(Buffer.from([0,0]));return}
      if(fault==='oversized-header'){child.stdin.end(Buffer.from([127,255,255,255]));return}
      const header=Buffer.from(JSON.stringify({protocol:1,request:1,query:'q',unit:'r',field:'body',patterns:['a'],fixed:true,case_sensitive:true,input_bytes:4,input_sha256:'0'.repeat(64)}));
      const len=Buffer.alloc(4);len.writeUInt32BE(header.length);child.stdin.write(len);child.stdin.write(header);child.stdin.end(fault==='truncated-input'?'a':'abcd');
    },30)});
    const code=await closed;assert.notEqual(code,0);rows.push({fault,code});
  }
  const parentSource=`import {PrototypeMatcher} from ${JSON.stringify(new URL('../reference/native-client.mjs',import.meta.url).href)};
    import {CallTimeline,loadRecallConfig} from ${JSON.stringify(new URL('../../lib/index.js',import.meta.url).href)};
    const matcher=new PrototypeMatcher(),t=new CallTimeline(loadRecallConfig(),new AbortController().signal);
    await matcher.validate({patterns:['ready'],mode:'literal',case_sensitive:true},t);t.dispose();
    console.log(JSON.stringify({pid:matcher.channels[0].child.pid}));`;
  const path=join(root,'parent.mjs');await writeFile(path,parentSource);
  const parent=spawn(process.execPath,[path],{windowsHide:true,stdio:'pipe'});meter.track(parent.pid);parent.stderr.resume();
  const closed=new Promise(resolve=>parent.once('close',resolve));
  const pid=await new Promise((resolve,reject)=>{let text='';parent.stdout.on('data',b=>{text+=b;if(text.includes('\n'))resolve(JSON.parse(text.trim()).pid)});parent.once('error',reject);parent.once('close',()=>reject(Error('parent exited before handshake')))});
  meter.track(pid);await new Promise(resolve=>setTimeout(resolve,35));parent.kill('SIGKILL');await closed;
  const deadline=performance.now()+3000;let alive=true;
  while(alive&&performance.now()<deadline){try{process.kill(pid,0);await new Promise(resolve=>setTimeout(resolve,20))}catch(e){if(e.code!=='ESRCH')throw e;alive=false}}
  assert.equal(alive,false,'owned worker must exit after its retained parent handle signals');rows.push({fault:'parent-death',workerExited:true});
}finally{
  const resources=await meter.stop();assert.equal(resources.complete,true);assert.equal(resources.stats.openMisses,0);
  assert.ok(resources.processes.filter(p=>p.kind==='matcher').every(p=>!p.aliveAtCaptureEnd));
  await writeFile(join(root,'result.json'),JSON.stringify({rows,resources},null,2));
}
console.log(`Native lifecycle evidence: ${root}`);
