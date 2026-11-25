import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {genesis,step} from './authority-lifecycle.mjs';
const ops=JSON.parse(await readFile('authority-lifecycle-commands.json','utf8'));
const vectors=await readFile('authority-lifecycle-vectors.jsonl','utf8');
const normalize=s=>({grants:[...s.grants].sort((a,b)=>a.id-b.id),revoked:[...s.revoked].sort((a,b)=>a-b),seen:[...s.seen].sort((a,b)=>a-b)});
const call=(s,i)=>step(s,ops[i].actor,ops[i].command);
const cached=new Map([['',genesis()]]);
const reasons={};let checks=0;
for(const line of vectors.trim().split('\n')){
  const expected=JSON.parse(line),key=expected.path.join(',');
  let s=cached.get(key);
  if(!s){s=genesis();for(const i of expected.path){const r=call(s,i);assert(r.accepted);s=r.state;}cached.set(key,s);}
  const before=JSON.stringify(s);
  const got=call(s,expected.action);
  assert.equal(JSON.stringify(s),before,'input mutation');
  assert.equal(got.accepted,expected.accepted,line);assert.equal(got.reason,expected.reason,line);
  assert.deepEqual(normalize(got.state),expected.state,line);
  if(!got.accepted)assert.equal(got.state,s);
  reasons[got.reason]=(reasons[got.reason]||0)+1;checks++;
}
assert(checks>1000);
for(const reason of ['accepted','replay','revoked','wrong-holder','wrong-process','amplification','missing-right','id-used','owner-only','unknown-grant','already-revoked'])assert(reasons[reason]>0,reason);
// Explicit descendant revocation, sibling independence, permanent ID
// retirement and exact replay behavior beyond the breadth-first bound.
let s=genesis();
const yes=(i)=>{const r=call(s,i);assert(r.accepted);s=r.state;};
const no=(i,reason)=>{const r=call(s,i);assert(!r.accepted&&r.reason===reason);assert.equal(r.state,s);};
yes(0);yes(1);yes(2);yes(6);no(15,'revoked');yes(14);no(14,'replay');no(20,'id-used');yes(8);no(19,'revoked');
for(const command of [null,{kind:'execute',request:-1},{kind:'execute',request:999,parent:0,process:7,right:6}]){
  // Last request reaches the revoked root before its invalid right; test
  // malformed right separately on a fresh state.
  const r=step(genesis(),0,command);assert(!r.accepted&&r.reason==='malformed');
}
const report={schema:'authority-lifecycle/1',source:process.env.AUTHORITY_HEAD,testedMerge:process.env.GITHUB_SHA,checks,reachableStates:cached.size,reasons,explicitTrace:'PASS',vectorsSha256:createHash('sha256').update(vectors).digest('hex'),scope:'serial isolated reference reducer; authenticated actor and trusted state assumed; not production integration'};
await writeFile('authority-lifecycle.json',JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report,null,2));
