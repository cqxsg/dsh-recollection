import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, mkdtemp } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { PrototypeMatcher } from '../reference/native-client.mjs';
import { CallTimeline, loadRecallConfig } from '../../lib/index.js';
const base=fileURLToPath(new URL('../../.local/native-deployment/',import.meta.url));await mkdir(base,{recursive:true});const root=await mkdtemp(join(base,'run-'));
const manifest=JSON.parse(await readFile(new URL('../../.local/native-build/manifest.json',import.meta.url),'utf8')),rows=[];
for(const kind of ['missing-manifest','missing-binary','wrong-hash','wrong-build']){
  const path=join(root,kind+'.json'),copy={...manifest};
  if(kind==='missing-binary')copy.executable=join(root,'missing-worker.exe');
  if(kind==='wrong-hash')copy.sha256='0'.repeat(64);
  if(kind==='wrong-build')copy.build='0'.repeat(64);
  if(kind!=='missing-manifest')await writeFile(path,JSON.stringify(copy));
  let launches=0,error;
  const matcher=new PrototypeMatcher(path,(...args)=>{launches++;return spawn(...args)}),timeline=new CallTimeline(loadRecallConfig(),new AbortController().signal);
  try{await assert.rejects(matcher.validate({mode:'literal',patterns:['fixture'],case_sensitive:true},timeline),e=>{error=e.code??e.name;return true})}
  finally{timeline.dispose();await matcher.dispose();assert.equal(matcher.children.size,0)}
  if(kind.startsWith('missing'))assert.equal(error,'ENOENT');else assert.equal(error,'worker_version_mismatch');
  assert.equal(launches,kind==='wrong-build'?1:0);
  rows.push({kind,error,launches,childrenAfterClose:0});
}
await writeFile(join(root,'result.json'),JSON.stringify({manifest,rows},null,2));console.log(`Native deployment evidence: ${root}`);
