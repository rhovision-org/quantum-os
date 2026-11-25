// Offline differential witness: production TS, Lean enumerator, synthetic event log.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
const {build}=await import(pathToFileURL(process.env.AUTHORITY_ESBUILD).href);
const built=await build({entryPoints:['packages/browser/src/qos-process.ts','packages/browser/src/dyncap.ts'],bundle:true,format:'esm',platform:'node',outdir:'out',write:false,external:['@quantum-os/zfa-core']});
const modules={};
for(const f of built.outputFiles) modules[f.path.split('/').pop()]=await import('data:text/javascript;base64,'+Buffer.from(f.text).toString('base64'));
const Q=modules['qos-process.js'],D=modules['dyncap.js'];
const raw=await readFile('authority-vectors.txt','utf8');
const scopes=new Map(),rights=new Map();
for(const line of raw.trim().split('\n')){
  // Lean also prints the axiom footprint from the imported executable module.
  if(line.includes('QosAuthority.subsetCheck_sound')&&line.includes('axiom'))continue;
  const [type,...v]=line.split(',');
  assert(type==='scope'||type==='right',line);
  assert(v.every(x=>/^\d+$/.test(x)));
  const values=v.map(Number),result=values.pop(),key=values.join(',');
  const dest=type==='scope'?scopes:rights;assert(!dest.has(key));assert(result===0||result===1);dest.set(key,result===1);
}
assert.equal(scopes.size,8192);assert.equal(rights.size,384);
const events=[['nomination'],['ballot'],['process-start','process-suspend','process-resume','process-terminate'],['capability-grant'],['poll-open','poll-close','lemma'],['anchor']];
assert.deepEqual([...events.flat()].sort(),[...Q.QOS_EVENT_TYPES].sort());
const has=(m,i)=>Boolean(m&(1<<i));
const scope=(m,process='fixture')=>({process,events:['nomination','ballot'].filter((_,i)=>has(m,i)),canLifecycle:has(m,2),canGrant:has(m,3),canClose:has(m,4),canAnchor:has(m,5)});
let scopeCases=0,eventCases=0,strictCases=0;
for(let p=0;p<64;p++){
 for(let c=0;c<64;c++){
  for(const same of [1,0]){
   const key=[p,c,same].join(',');assert(scopes.has(key));
   assert.equal(Q.attenuateScope(scope(p),scope(c,same?'fixture':'other'))!==null,scopes.get(key),key);scopeCases++;
  }
 }
 for(let r=0;r<6;r++)for(const e of events[r]){
  const key=[p,r].join(',');assert(rights.has(key));assert.equal(Q.scopeAllows(scope(p),e),rights.get(key),key+':'+e);eventCases++;
 }
 // These raw fields do not grant additional effective rights but attenuation
 // still rejects adding them to a child when absent from its parent.
 for(const e of events.slice(2).flat()){
  const parent=scope(p),child={...parent,events:[...parent.events,e]};
  assert.equal(Q.attenuateScope(parent,child),null);
  for(const kind of Q.QOS_EVENT_TYPES)assert.equal(Q.scopeAllows(parent,kind),Q.scopeAllows(child,kind));
  strictCases++;
 }
}
const ROOM='cap:room:67';
async function fixture(n){const seed=Uint8Array.from({length:32},(_,i)=>(n*17+i*13)&255);const identity=await D.newDynCapState(seed);return {identity,room:new Q.QosProcessRoom({roomId:ROOM,identity,transport:{broadcast:()=>{}}})};}
const a=await fixture(1),b=await fixture(2);
const start=await a.room.startProcess('authority-fixture',{entropyHex:'1234',quorum:{required:1}});
const pid=start.processId;
const grant=await a.room.grant(pid,start.event,b.identity.anchor,Q.newParticipantScope(pid,['nomination']),'1234');
for(const e of a.room.log.eventsFor(pid))assert(await b.room.onMessage('fixture',e));
const nomination=await b.room.nominates(pid,grant.event,'Permitted fixture');
const first=await a.room.log.ingest(nomination);assert(first.ok&&!first.duplicate);
const before=a.room.log.eventsFor(pid).length;
const replay=await a.room.log.ingest(nomination);assert(replay.ok&&replay.duplicate);
assert.equal(a.room.log.eventsFor(pid).length,before);
const view=await a.room.view(pid);assert(view.nominations.some(n=>n.text==='Permitted fixture'));
const traceChecks=['delegated nomination accepted','duplicate envelope acknowledged but not appended'];
// A separate valid envelope cannot enlarge the grant's effective scope.
const denied=await b.room.emit(pid,grant.event,'poll-close',{reason:'synthetic negative'});
assert((await a.room.log.ingest(denied)).ok);
const after=await a.room.view(pid);
assert(after.rejected.some(r=>r.hash===denied.hash&&/capability does not allow/.test(r.reason)),JSON.stringify(after.rejected));
traceChecks.push('out-of-scope operation rejected by reducer despite envelope acceptance');
const report={schema:'authority-refinement-witness/1',testedMerge:process.env.GITHUB_SHA,prHead:process.env.AUTHORITY_HEAD,scopeCases,eventCases,strictCases,traceChecks,leanVectorSha256:createHash('sha256').update(raw).digest('hex'),scope:'bounded effective-right comparison and isolated runtime traces; no revocation implementation, authentication or general refinement'};
await writeFile('authority-refinement.json',JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report,null,2));
