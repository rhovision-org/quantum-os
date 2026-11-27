import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {initialize,apply,audit,openJournal} from './authority-journal.mjs';
const dir=await mkdtemp(join(tmpdir(),'authority-journal-'));
const worker=fileURLToPath(new URL('./journal-worker.mjs',import.meta.url));
const checks=[];
const grant=(request,id,target,parent=0,mask=10)=>({kind:'grant',request,id,target,parent,mask,process:7});
const exec=(request,parent,right=1)=>({kind:'execute',request,parent,right,process:7});
const revoke=(request,id)=>({kind:'revoke',request,id});
const yes=(db,actor,c)=>assert.equal(apply(db,actor,c).accepted,true);
const no=(db,actor,c,reason)=>assert.deepEqual(apply(db,actor,c),{accepted:false,reason});
function child(db,actor,c,crash=''){
 return new Promise((resolve,reject)=>{
  const p=spawn(process.execPath,[worker,db,String(actor),JSON.stringify(c),crash],{stdio:['ignore','pipe','pipe']});
  let stdout='',stderr='';
  p.stdout.on('data',x=>stdout+=x);p.stderr.on('data',x=>stderr+=x);
  p.on('error',reject);
  p.on('close',(code,signal)=>{
    if(crash){if(signal!=='SIGKILL')reject(Error('expected SIGKILL: '+code+' '+stderr));else resolve({signal});}
    else if(code!==0)reject(Error(stderr));else{try{resolve(JSON.parse(stdout));}catch(e){reject(e);}}
  });
 });
}
function fresh(name){const db=join(dir,name+'.db');initialize(db);return db;}
try{
 const db=fresh('serial');
 yes(db,0,grant(1,1,1));yes(db,1,grant(2,2,2,1,2));yes(db,0,grant(3,3,3,0,2));
 yes(db,2,exec(4,2));no(db,2,exec(4,2),'replay');no(db,2,exec(4,2,5),'request-conflict');
 yes(db,0,revoke(5,1));const before=audit(db);
 no(db,2,exec(6,2),'revoked');no(db,1,grant(7,4,2,1,2),'revoked');
 assert.deepEqual(audit(db),before);yes(db,3,exec(8,3));
 assert.equal(audit(db).receipts,6);checks.push('serial replay, conflicting request, ancestor revocation, sibling independence and denial immutability');
 const race=fresh('same-request');
 const same=await Promise.all(Array.from({length:8},()=>child(race,0,grant(1,1,1))));
 assert.equal(same.filter(r=>r.accepted).length,1);assert.equal(same.filter(r=>r.reason==='replay').length,7);assert.equal(audit(race).receipts,1);
 checks.push('eight concurrent identical requests: one commit, seven replays');
 const competing=fresh('same-grant');
 const res=await Promise.all([child(competing,0,grant(1,1,1)),child(competing,0,grant(2,1,2))]);
 assert.equal(res.filter(r=>r.accepted).length,1);assert.equal(res.filter(r=>r.reason==='id-used').length,1);assert.equal(audit(competing).receipts,1);
 checks.push('two distinct requests competing for one grant ID: one commit');
 const crash=fresh('crash');
 const g=grant(1,1,1);
 await child(crash,0,g,'before-commit');assert.equal(audit(crash).receipts,0);assert.equal(audit(crash).state.grants.length,1);
 yes(crash,0,g);checks.push('SIGKILL before commit: no partial grant or receipt; retry accepted');
 await child(crash,0,revoke(2,1),'after-commit');assert.equal(audit(crash).receipts,2);
 no(crash,0,revoke(2,1),'replay');no(crash,1,exec(3,1),'revoked');
 checks.push('SIGKILL after commit: revocation and receipt durable; replay refused');
 const order=fresh('ordering');
 yes(order,0,grant(1,1,1));
 const [run,rev]=await Promise.all([child(order,1,exec(2,1)),child(order,0,revoke(3,1))]);
 assert(rev.accepted);
 assert(run.accepted?run.ordinal<rev.ordinal:run.reason==='revoked');
 assert.equal(audit(order).receipts,run.accepted?3:2);no(order,1,exec(4,1),'revoked');
 checks.push('concurrent execution/revocation consistent with serialized commit order');
 const tamper=fresh('tamper');yes(tamper,0,grant(1,1,1));
 const raw=openJournal(tamper);raw.exec("UPDATE receipt SET after_hash='invalid' WHERE ordinal=1");raw.close();
 assert.throws(()=>audit(tamper),/transition mismatch/);
 checks.push('receipt corruption detected by independent journal replay');
 const report={schema:'authority-journal-witness/1',prHead:process.env.AUTHORITY_HEAD,testedMerge:process.env.GITHUB_SHA,node:process.version,checks,scope:'single SQLite database, process crashes, trusted actors and storage; no external effects or distributed consensus'};
 await writeFile('authority-journal.json',JSON.stringify(report,null,2)+'\n');
 console.log(JSON.stringify(report,null,2));
}finally{await rm(dir,{recursive:true,force:true});}
