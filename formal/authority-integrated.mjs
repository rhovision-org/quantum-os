// Research-only composition; no production imports or external effects.
import {createHash,createPublicKey,sign,verify} from 'node:crypto';
import {openJournal} from './authority-journal.mjs';
import {genesis,step} from './authority-lifecycle.mjs';
const canonical=x=>JSON.stringify(x,(_k,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);
const bytes=x=>Buffer.from(canonical(x),'utf8');
const hash=x=>createHash('sha256').update(bytes(x)).digest('hex');
const copy=x=>JSON.parse(canonical(x));
const domain='qos-authority-integrated/1';
const shape=(o,keys)=>o!==null&&typeof o==='object'&&!Array.isArray(o)&&canonical(Object.keys(o).sort())===canonical(keys);

export function integrationContext(identity,writerPublicKey){
 if(writerPublicKey?.type!=='public'||writerPublicKey.asymmetricKeyType!=='ed25519')throw Error('invalid writer key');
 const key=writerPublicKey.export({type:'spki',format:'der'});
 const pub=createPublicKey({key,type:'spki',format:'der'});
 const config=hash({domain,stream:identity.stream,registry:identity.registryDigest,writer:key.toString('hex')});
 const initialTip=hash({domain,config,state:genesis()});
 return Object.freeze({identity,pub,config,initialTip});
}

export class IntegratedReplica {
 constructor(context){this.context=context;this.state=genesis();this.tip=context.initialTip;this.records=[];this.quarantined=false;}
 receive(record){
  if(this.quarantined)return 'quarantined';
  let b,verified,digest;
  try{
   if(!shape(record,['body','signature']))return 'invalid';
   b=record.body;
   if(!shape(b,['after','before','config','domain','envelope','ordinal','parent'])||b.domain!==domain||b.config!==this.context.config||!Number.isSafeInteger(b.ordinal)||b.ordinal<1||typeof record.signature!=='string'||record.signature.length!==128||/[^0-9a-f]/.test(record.signature)||!verify(null,bytes(b),this.context.pub,Buffer.from(record.signature,'hex')))return 'invalid';
   verified=this.context.identity.verifyEnvelope(b.envelope);
   if(!verified)return 'invalid-actor';
   digest=hash(b);
  }catch{return 'invalid';}
  if(b.ordinal<=this.records.length){
   if(hash(this.records[b.ordinal-1].body)===digest)return 'duplicate';
   this.quarantined=true;return 'equivocation';
  }
  if(b.ordinal!==this.records.length+1)return 'gap';
  if(b.parent!==this.tip||b.before!==hash(this.state)){this.quarantined=true;return 'prefix-conflict';}
  const {actor,command}=verified.body,result=step(this.state,actor,command);
  if(!result.accepted||b.after!==hash(result.state)){this.quarantined=true;return 'invalid-transition';}
  this.state=result.state;this.tip=digest;this.records.push(copy(record));return 'applied';
 }
 observation(){return {ordinal:this.records.length,tip:this.tip,state:copy(this.state),freshness:'unknown',quarantined:this.quarantined};}
 requestExecution(){return {accepted:false,reason:this.quarantined?'quarantined':'writer-required'};}
}

function stored(db,ctx){
 const row=db.prepare('SELECT * FROM integrated_state WHERE id=1').get();
 if(!row||row.config!==ctx.config)throw Error('integration context mismatch');
 return row;
}
export function initializeIntegrated(path,ctx){
 const db=openJournal(path);
 try{
  db.exec('PRAGMA journal_mode=WAL; BEGIN IMMEDIATE; CREATE TABLE IF NOT EXISTS integrated_state(id INTEGER PRIMARY KEY CHECK(id=1), config TEXT NOT NULL, ordinal INTEGER NOT NULL, tip TEXT NOT NULL, body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS integrated_receipt(ordinal INTEGER PRIMARY KEY, request INTEGER UNIQUE NOT NULL, digest TEXT NOT NULL, record TEXT NOT NULL);');
  const row=db.prepare('SELECT id FROM integrated_state WHERE id=1').get();
  if(row)stored(db,ctx);
  else{
   if(db.prepare('SELECT COUNT(*) AS n FROM integrated_receipt').get().n)throw Error('orphaned receipts');
   db.prepare('INSERT INTO integrated_state VALUES(1,?,?,?,?)').run(ctx.config,0,ctx.initialTip,canonical(genesis()));
  }
  db.exec('COMMIT');
 }finally{db.close();}
}
export function submitIntegrated(path,ctx,writerKey,envelope,hook=()=>{}){
 const verified=ctx.identity.verifyEnvelope(envelope);
 if(!verified)return {accepted:false,reason:'invalid-authentication'};
 if(writerKey?.type!=='private'||writerKey.asymmetricKeyType!=='ed25519'||!createPublicKey(writerKey).equals(ctx.pub))throw Error('writer key mismatch');
 const {actor,command}=verified.body,digest=hash(verified.body);
 const db=openJournal(path);
 try{
  db.exec('BEGIN IMMEDIATE');
  const row=stored(db,ctx);
  const prior=db.prepare('SELECT digest FROM integrated_receipt WHERE request=?').get(command.request);
  if(prior){db.exec('ROLLBACK');return {accepted:false,reason:prior.digest===digest?'replay':'request-conflict'};}
  const state=JSON.parse(row.body),result=step(state,actor,command);
  if(!result.accepted){db.exec('ROLLBACK');return {accepted:false,reason:result.reason};}
  const body={domain,config:ctx.config,ordinal:row.ordinal+1,parent:row.tip,before:hash(state),after:hash(result.state),envelope:verified};
  const record={body,signature:sign(null,bytes(body),writerKey).toString('hex')};
  db.prepare('INSERT INTO integrated_receipt VALUES(?,?,?,?)').run(body.ordinal,command.request,digest,canonical(record));
  db.prepare('UPDATE integrated_state SET ordinal=?,tip=?,body=? WHERE id=1').run(body.ordinal,hash(body),canonical(result.state));
  hook('before-commit');
  db.exec('COMMIT');
  hook('after-commit');
  return {accepted:true,record};
 }catch(e){if(db.isTransaction)db.exec('ROLLBACK');throw e;}finally{db.close();}
}
// Snapshot audit replays BOTH signatures and every transition before export.
export function exportIntegrated(path,ctx){
 const db=openJournal(path);
 try{
  db.exec('BEGIN');
  const row=stored(db,ctx),replica=new IntegratedReplica(ctx),records=[];
  for(const receipt of db.prepare('SELECT * FROM integrated_receipt ORDER BY ordinal').all()){
   const record=JSON.parse(receipt.record);
   if(receipt.ordinal!==record.body.ordinal||receipt.request!==record.body.envelope.body.command.request||receipt.digest!==hash(record.body.envelope.body)||replica.receive(record)!=='applied')throw Error('invalid journal record');
   records.push(record);
  }
  const observation=replica.observation();
  if(row.ordinal!==observation.ordinal||row.tip!==observation.tip||row.body!==canonical(observation.state))throw Error('journal state mismatch');
  db.exec('COMMIT');
  return {records,observation};
 }finally{db.close();}
}
