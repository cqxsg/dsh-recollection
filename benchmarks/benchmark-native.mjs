import assert from 'node:assert/strict';
import { readFile, mkdir, mkdtemp } from 'node:fs/promises';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { PrototypeMatcher, RgMatcher } from '../test/reference/native-client.mjs';
import { CallTimeline, loadRecallConfig } from '../lib/index.js';
import { makeCorpus, QUERIES, expectedIndexes, queryArgs } from './corpus.mjs';
import { checkpointWriter } from '../support/checkpoint.mjs';
import { processResourceMeter } from './resources.mjs';
const {values}=parseArgs({options:{repeats:{type:'string',default:'5'},resources:{type:'boolean',default:false},'worker-only':{type:'boolean',default:false}}});
const repeats=Number(values.repeats);if(!Number.isSafeInteger(repeats)||repeats<1||repeats>100)throw Error('repeats must be 1..100');
const base=fileURLToPath(new URL('../.local/native-benchmark/',import.meta.url));await mkdir(base,{recursive:true});const root=await mkdtemp(join(base,'run-'));
const publish=checkpointWriter(join(root,'result.json'));
const installation=JSON.parse(await readFile(new URL('../.local/tools/rg-install.json',import.meta.url),'utf8'));
const corpus=makeCorpus('mixed',2048),queries=QUERIES.filter(q=>['literal-none','literal-sparse','literal-all','multiline-none','multiline-sparse','multiline-all'].includes(q.id));
assert.equal(queries.length,6);
const records=corpus.records.map(row=>({id:`r${row.index}`,blocks:[...row.parts.map((text,index)=>({path:`data.content[${index}]`,content:{type:'text',text}})),
  ...(row.attachment?[{path:`data.content[${row.parts.length}]`,content:{type:'file',attachment:row.attachment}}]:[])]}));
const report={protocol:'dsh-native-benchmark-v1',revision:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),
  dirty:!!execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim(),startedAt:new Date().toISOString(),
  repeats,resources:values.resources,sourceDigest:corpus.sourceDigest,records:2048,queryIds:queries.map(q=>q.id),rows:[],complete:false,
  definition:'Full 2048-record matching stage, validation and cold worker startup included, two complete records in parallel; original metadata fields remain independent. No native preparation/agent/output stage. Both branches retain the 55-second business limit.'};
await publish(report);
try {
  for(let repeat=0;repeat<repeats;repeat++)for(const query of queries){
    const pair={repeat,query:query.id};
    for(const kind of values['worker-only']?['worker']:repeat%2?['worker','cli']:['cli','worker']){
      let launched=0,resources;const meter=values.resources?await processResourceMeter():undefined;
      const launch=(...args)=>{const child=spawn(...args);launched++;if(child.pid)meter?.track(child.pid);return child};
      const matcher=kind==='worker'?new PrototypeMatcher(undefined,launch):new RgMatcher(installation.executable,launch);
      const timeline=new CallTimeline(loadRecallConfig(),new AbortController().signal), hash=createHash('sha256'), hits=[];
      const started=performance.now();let elapsedMs,scanned=0,status='ok',code;
      try{
        await matcher.validate(queryArgs(query),timeline);
        for(let at=0;at<records.length;at+=2){
          const settled=await Promise.allSettled(records.slice(at,at+2).map(r=>matcher.match(r,queryArgs(query),timeline)));
          const failure=settled.find(s=>s.status==='rejected');if(failure)throw failure.reason;
          for(const item of settled){const result=item.value;hash.update(JSON.stringify(result));if(result.spans.length)hits.push(Number(result.recordId.slice(1)));scanned++}
          await new Promise(resolve=>setImmediate(resolve));
        }
        timeline.check();elapsedMs=performance.now()-started;assert.deepEqual(hits,expectedIndexes(query,2048));
      }catch(error){elapsedMs=performance.now()-started;status='incomplete';code=error.code??error.message}
      finally{timeline.dispose();await matcher.dispose?.();resources=await meter?.stop()}
      pair[kind]={status,code,elapsedMs,scanned,hits:hits.length,digest:hash.digest('hex'),launched,binary:matcher.info,worker:matcher.stats?.(),resources};
      assert.equal(matcher.children.size,0);
      console.log(JSON.stringify({repeat,query:query.id,kind,status,code,elapsedMs,scanned,launched}));
      await publish({...report,current:pair});
    }
    if(pair.cli?.status==='ok'&&pair.worker.status==='ok'){assert.equal(pair.cli.digest,pair.worker.digest);pair.speedup=pair.cli.elapsedMs/pair.worker.elapsedMs}
    report.rows.push(pair);await publish(report);
  }
  report.complete=true;
}finally{report.finishedAt=new Date().toISOString();await publish(report);console.log(`Native benchmark evidence: ${join(root,'result.json')}`)}
assert.ok(report.rows.every(r=>r.worker.status==='ok'&&(!r.cli||r.cli.status==='ok')),'incomplete samples retained; matching-stage gate has not passed');
