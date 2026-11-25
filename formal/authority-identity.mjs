// Isolated candidate. No production identity or transport imports.
// The actor-to-key registry is provisioned out of band and pinned per stream.
import {createHash,createPublicKey,sign,verify} from 'node:crypto';
import {openJournal} from './authority-journal.mjs';
import {genesis,step} from './authority-lifecycle.mjs';
const canonical=x=>JSON.stringify(x,(_k,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);
const bytes=x=>Buffer.from(canonical(x),'utf8');
const hash=x=>createHash('sha256').update(bytes(x)).digest('hex');
const domain='qos-authority-actor/1';
const id=x=>Number.isSafeInteger(x)&&x>=0;
const shape=(o,keys)=>o!==null&&typeof o==='object'&&!Array.isArray(o)&&Object.getPrototypeOf(o)===Object.prototype&&canonical(Object.keys(o).sort())===canonical(keys);
const shapes={grant:['id','kind','mask','parent','process','request','target'],execute:['kind','parent','process','request','right'],revoke:['id','kind','request']};
function commandValid(c){
  if(!c||!Object.hasOwn(shapes,c.kind)||!shape(c,shapes[c.kind])||!id(c.request))return false;
  if(c.kind==='revoke')return id(c.id);
  if(!id(c.parent)||!id(c.process))return false;
  if(c.kind==='execute')return id(c.right)&&c.right<6;
  return id(c.id)&&id(c.target)&&id(c.mask)&&c.mask<64;
}
export function createIdentityContext(stream,entries){
  if(typeof stream!=='string'||stream.length<1||stream.length>128||/[^a-zA-Z0-9._:-]/.test(stream))throw Error('invalid stream');
  const keys=new Map(),fingerprints=new Set(),registry=[];
  for(const {actor,publicKey} of entries){
    if(!id(actor)||keys.has(actor)||publicKey?.type!=='public'||publicKey.asymmetricKeyType!=='ed25519')throw Error('invalid registry entry');
    const der=publicKey.export({type:'spki',format:'der'});
    const hex=der.toString('hex');
    if(fingerprints.has(hex))throw Error('duplicate registry key');
    fingerprints.add(hex);
    keys.set(actor,createPublicKey({key:der,type:'spki',format:'der'}));
    registry.push({actor,spki:hex});
  }
  if(!keys.has(0))throw Error('missing root key');
  registry.sort((a,b)=>a.actor-b.actor);
  const registryDigest=hash({domain,stream,registry});
  function signEnvelope(actor,command,key){
    if(!keys.has(actor)||!commandValid(command)||key?.asymmetricKeyType!=='ed25519'||key.type!=='private')throw Error('invalid signing input');
    const body={domain,stream,registry:registryDigest,actor,command:JSON.parse(canonical(command))};
    return {body,signature:sign(null,bytes(body),key).toString('hex')};
  }
  function verifyEnvelope(envelope){
    try{
      if(!shape(envelope,['body','signature']))return null;
      const {body:b,signature:s}=envelope;
      if(!shape(b,['actor','command','domain','registry','stream'])||b.domain!==domain||b.stream!==stream||b.registry!==registryDigest||!id(b.actor)||!commandValid(b.command)||typeof s!=='string'||s.length!==128||/[^0-9a-f]/.test(s))return null;
      const key=keys.get(b.actor);
      if(!key||!verify(null,bytes(b),key,Buffer.from(s,'hex')))return null;
      // Copy only the verified wire data; the caller cannot mutate the journal input.
      return JSON.parse(canonical(envelope));
    }catch{return null;}
  }
  return Object.freeze({stream,registryDigest,signEnvelope,verifyEnvelope});
}
function contextCheck(db,context){
  const row=db.prepare('SELECT stream,registry FROM identity_context WHERE id=1').get();
  if(!row||row.stream!==context.stream||row.registry!==context.registryDigest)throw Error('identity context mismatch');
}
export function initializeIdentityJournal(path,context){
  const db=openJournal(path);
  try{
    db.exec('PRAGMA journal_mode=WAL; BEGIN IMMEDIATE; CREATE TABLE IF NOT EXISTS identity_context (id INTEGER PRIMARY KEY CHECK(id=1), stream TEXT NOT NULL, registry TEXT NOT NULL); CREATE TABLE IF NOT EXISTS identity_state (id INTEGER PRIMARY KEY CHECK(id=1), body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS identity_receipt (ordinal INTEGER PRIMARY KEY, request INTEGER UNIQUE NOT NULL, envelope TEXT NOT NULL, digest TEXT NOT NULL, before_hash TEXT NOT NULL, after_hash TEXT NOT NULL);');
    const row=db.prepare('SELECT stream,registry FROM identity_context WHERE id=1').get();
    if(row){
      contextCheck(db,context);
      if(!db.prepare('SELECT id FROM identity_state WHERE id=1').get())throw Error('missing identity state');
    }else{
      // Never silently reinitialize a partially populated store.
      if(db.prepare('SELECT COUNT(*) AS n FROM identity_state').get().n||db.prepare('SELECT COUNT(*) AS n FROM identity_receipt').get().n)throw Error('orphaned identity state');
      db.prepare('INSERT INTO identity_context VALUES(1,?,?)').run(context.stream,context.registryDigest);
      db.prepare('INSERT INTO identity_state VALUES(1,?)').run(canonical(genesis()));
    }
    db.exec('COMMIT');
  }finally{db.close();}
}
export function applySigned(path,context,envelope){
  const verified=context.verifyEnvelope(envelope);
  if(!verified)return {accepted:false,reason:'invalid-authentication'};
  const {actor,command}=verified.body;
  const digest=hash(verified.body);
  const db=openJournal(path);
  try{
    db.exec('BEGIN IMMEDIATE');
    contextCheck(db,context);
    const prior=db.prepare('SELECT digest FROM identity_receipt WHERE request=?').get(command.request);
    if(prior){db.exec('ROLLBACK');return {accepted:false,reason:prior.digest===digest?'replay':'request-conflict'};}
    const state=JSON.parse(db.prepare('SELECT body FROM identity_state WHERE id=1').get().body);
    const result=step(state,actor,command);
    if(!result.accepted){db.exec('ROLLBACK');return {accepted:false,reason:result.reason};}
    const row=db.prepare('INSERT INTO identity_receipt(request,envelope,digest,before_hash,after_hash) VALUES(?,?,?,?,?)').run(command.request,canonical(verified),digest,hash(state),hash(result.state));
    db.prepare('UPDATE identity_state SET body=? WHERE id=1').run(canonical(result.state));
    db.exec('COMMIT');
    return {accepted:true,ordinal:Number(row.lastInsertRowid),digest};
  }catch(e){if(db.isTransaction)db.exec('ROLLBACK');throw e;}finally{db.close();}
}
export function auditSigned(path,context){
  const db=openJournal(path);
  try{
    db.exec('BEGIN');
    contextCheck(db,context);
    let state=genesis(),ordinal=0;
    const rows=db.prepare('SELECT * FROM identity_receipt ORDER BY ordinal').all();
    for(const row of rows){
      const envelope=context.verifyEnvelope(JSON.parse(row.envelope));
      if(!envelope)throw Error('receipt authentication failed');
      const {actor,command}=envelope.body;
      if(row.ordinal!==++ordinal||row.request!==command.request||row.digest!==hash(envelope.body)||row.before_hash!==hash(state))throw Error('receipt mismatch');
      const result=step(state,actor,command);
      if(!result.accepted||row.after_hash!==hash(result.state))throw Error('transition mismatch');
      state=result.state;
    }
    if(canonical(state)!==db.prepare('SELECT body FROM identity_state WHERE id=1').get().body)throw Error('state mismatch');
    db.exec('COMMIT');
    return {receipts:rows.length,state,digest:hash(state)};
  }finally{db.close();}
}
