// Research-only durable serial reference. Actor authentication is external.
// No network, production imports, or external execution effects.
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {genesis,step} from './authority-lifecycle.mjs';
const canonical=x=>JSON.stringify(x,(_k,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);
const hash=x=>createHash('sha256').update(canonical(x)).digest('hex');
const validId=x=>Number.isSafeInteger(x)&&x>=0;
const keys={grant:['id','kind','mask','parent','process','request','target'],execute:['kind','parent','process','request','right'],revoke:['id','kind','request']};
export function openJournal(path){
  const db=new DatabaseSync(path);
  db.exec('PRAGMA busy_timeout=20000; PRAGMA synchronous=FULL;');
  return db;
}
export function initialize(path){
  const db=openJournal(path);
  try{
    db.exec('PRAGMA journal_mode=WAL; BEGIN IMMEDIATE; CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY CHECK(id=1), body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS receipt (ordinal INTEGER PRIMARY KEY, request INTEGER UNIQUE NOT NULL, actor INTEGER NOT NULL, command TEXT NOT NULL, digest TEXT NOT NULL, before_hash TEXT NOT NULL, after_hash TEXT NOT NULL);');
    db.prepare('INSERT OR IGNORE INTO state VALUES (1,?)').run(canonical(genesis()));
    db.exec('COMMIT');
  }finally{db.close();}
}
export function apply(path,actor,command,hook=()=>{}){
  if(!validId(actor)||!command||!validId(command.request)||!Object.hasOwn(keys,command.kind)||canonical(Object.keys(command).sort())!==canonical(keys[command.kind]))return {accepted:false,reason:'malformed'};
  const db=openJournal(path);
  try{
    db.exec('BEGIN IMMEDIATE');
    const digest=hash({domain:'authority-journal/1',actor,command});
    const prior=db.prepare('SELECT * FROM receipt WHERE request=?').get(command.request);
    if(prior){db.exec('ROLLBACK');return {accepted:false,reason:prior.digest===digest?'replay':'request-conflict'};}
    const state=JSON.parse(db.prepare('SELECT body FROM state WHERE id=1').get().body);
    const result=step(state,actor,command);
    if(!result.accepted){db.exec('ROLLBACK');return {accepted:false,reason:result.reason};}
    const row=db.prepare('INSERT INTO receipt(request,actor,command,digest,before_hash,after_hash) VALUES(?,?,?,?,?,?)').run(command.request,actor,canonical(command),digest,hash(state),hash(result.state));
    db.prepare('UPDATE state SET body=? WHERE id=1').run(canonical(result.state));
    hook('before-commit');
    db.exec('COMMIT');
    hook('after-commit');
    return {accepted:true,reason:'accepted',ordinal:Number(row.lastInsertRowid),digest};
  }catch(e){if(db.isTransaction)db.exec('ROLLBACK');throw e;}finally{db.close();}
}
export function audit(path){
  const db=openJournal(path);
  try{
    db.exec('BEGIN');
    let state=genesis(),ordinal=0;
    const rows=db.prepare('SELECT * FROM receipt ORDER BY ordinal').all();
    for(const row of rows){
      const command=JSON.parse(row.command);
      if(row.ordinal!==++ordinal||row.request!==command.request||row.digest!==hash({domain:'authority-journal/1',actor:row.actor,command})||row.before_hash!==hash(state))throw Error('receipt mismatch');
      const result=step(state,row.actor,command);
      if(!result.accepted||row.after_hash!==hash(result.state))throw Error('transition mismatch');
      state=result.state;
    }
    if(canonical(state)!==db.prepare('SELECT body FROM state WHERE id=1').get().body)throw Error('state mismatch');
    db.exec('COMMIT');
    return {state,receipts:rows.length,digest:hash(state)};
  }finally{db.close();}
}
