// Research reference: a single trusted serial writer, read-only replicas.
// Not a consensus protocol or production identity implementation.
import {createHash,sign,verify} from 'node:crypto';
import {genesis,step} from './authority-lifecycle.mjs';
const canonical=x=>JSON.stringify(x,(_k,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);
const hash=x=>createHash('sha256').update(canonical(x)).digest('hex');
const bytes=x=>Buffer.from(canonical(x),'utf8');
const domain='authority-replica/1';
const initialTip=stream=>hash({domain,stream,genesis:genesis()});
const fields=['actor','after','before','command','domain','ordinal','parent','stream'];
const clone=x=>JSON.parse(JSON.stringify(x));
export class Writer {
  constructor(stream,privateKey){
    this.stream=stream;this.key=privateKey;this.state=genesis();
    this.tip=initialTip(stream);this.records=[];
  }
  submit(actor,command){
    const result=step(this.state,actor,command);
    if(!result.accepted)return {accepted:false,reason:result.reason};
    const body={domain,stream:this.stream,ordinal:this.records.length+1,parent:this.tip,actor,command:clone(command),before:hash(this.state),after:hash(result.state)};
    const record={body,signature:sign(null,bytes(body),this.key).toString('hex')};
    this.state=result.state;this.tip=hash(body);this.records.push(clone(record));
    return {accepted:true,record:clone(record)};
  }
}
export class Replica {
  constructor(stream,publicKey){
    this.stream=stream;this.key=publicKey;this.state=genesis();
    this.tip=initialTip(stream);this.records=[];this.quarantined=false;
  }
  receive(record){
    if(this.quarantined)return 'quarantined';
    const b=record?.body,s=record?.signature;
    if(!b||canonical(Object.keys(b).sort())!==canonical(fields)||b.domain!==domain||b.stream!==this.stream||!Number.isSafeInteger(b.ordinal)||b.ordinal<1||typeof s!=='string'||!/^[0-9a-f]{128}$/.test(s)||!verify(null,bytes(b),this.key,Buffer.from(s,'hex')))return 'invalid';
    const digest=hash(b);
    if(b.ordinal<=this.records.length){
      if(hash(this.records[b.ordinal-1].body)===digest)return 'duplicate';
      this.quarantined=true;return 'equivocation';
    }
    if(b.ordinal!==this.records.length+1)return 'gap';
    if(b.parent!==this.tip||b.before!==hash(this.state)){this.quarantined=true;return 'prefix-conflict';}
    const result=step(this.state,b.actor,b.command);
    if(!result.accepted||b.after!==hash(result.state)){this.quarantined=true;return 'invalid-transition';}
    this.state=result.state;this.tip=digest;this.records.push(clone(record));return 'applied';
  }
  // Even a valid prefix may be stale. This API never authorizes execution.
  requestExecution(){return {accepted:false,reason:this.quarantined?'quarantined':'writer-required'};}
  observation(){return {ordinal:this.records.length,tip:this.tip,state:clone(this.state),freshness:'unknown',quarantined:this.quarantined};}
}
