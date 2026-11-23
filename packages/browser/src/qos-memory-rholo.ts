// Explicit registry availability adapter. No deploy is performed during replay.
import { MAX_OBJECT_BYTES, isObjectId } from "./qos-memory.js";
import { objectIdentity, type MemoryDurableBackend } from "./qos-memory-bytes.js";
import { deployTerm, deployVerdict, deployFate, renderExpr, type NodeConfig } from "./rholang.js";
import type { ObjectLocator } from "./qos-memory.js";
const uriOk=(uri:string)=>/^rho:id:[a-z0-9]{1,128}$/.test(uri);
const hex=(b:Uint8Array)=>Array.from(b,x=>x.toString(16).padStart(2,"0")).join("");
export function memoryPublishProgram(id:string,bytes:Uint8Array):string{
  if(!isObjectId(id)||bytes.byteLength>MAX_OBJECT_BYTES)throw new Error("invalid object");
  // Only validated ASCII schema, SHA-256 and hex enter this literal.
  // Rholo's bundled parser rejects backslash-escaped quotes in nested JSON.
  const record='"qos.memory/1:'+id+':'+hex(bytes)+'"';
  return `new insertArbitrary(\`rho:registry:insertArbitrary\`), deployId(\`rho:rchain:deployId\`), ret in {
  insertArbitrary!(${record}, *ret) |
  for (@uri <- ret) { return!(uri) | deployId!(uri) }
}`;
}
export function memoryReadProgram(uri:string):string{
  if(!uriOk(uri))throw new Error("invalid registry URI");
  return `new lookup(\`rho:registry:lookup\`), stored in {
  lookup!(\`${uri}\`, *stored) |
  for (@record <- stored) {
    match record { (_, value) => { @"out"!(value) } value => { @"out"!(value) } }
  }
}`;
}
export async function decodeMemoryRecord(values:readonly string[],expectedId?:string):Promise<Uint8Array|null>{
  // Reject ambiguous answers rather than selecting an arbitrary record.
  if(values.length!==1||values[0].length>MAX_OBJECT_BYTES*2+512)return null;
  let v:unknown;
  try{
    v=JSON.parse(values[0]);
    if(typeof v==="string"){
      const match=/^qos\.memory\/1:([0-9a-f]{64}):((?:[0-9a-f]{2})*)$/.exec(v);
      if(match)v={schema:"qos.memory/1",id:match[1],hex:match[2]};
      else v=JSON.parse(v); // legacy JSON records, if present
    }
  }catch{return null;}
  if(!v||typeof v!=="object"||Array.isArray(v))return null;
  const r=v as Record<string,unknown>;
  if(Object.keys(r).length!==3||r.schema!=="qos.memory/1"||!isObjectId(r.id)||
     (expectedId!==undefined&&r.id!==expectedId)||typeof r.hex!=="string"||
     r.hex.length>MAX_OBJECT_BYTES*2||!/^(?:[0-9a-f]{2})*$/.test(r.hex))return null;
  const data=Uint8Array.from(r.hex.match(/../g)??[],x=>parseInt(x,16));
  return await objectIdentity(data)===r.id?data:null;
}
/** Rholo #447/#449: the pinned endpoint captures @"out", not an
 * unforgeable return channel. Read the exact carrying block's POST state. */
export async function memoryReadAtBlock(cfg:NodeConfig,uri:string,blockHash:string):Promise<Uint8Array|null>{
  if(!isObjectId(blockHash))throw new Error("invalid registry block hash");
  const term=memoryReadProgram(uri);
  const base=cfg.url.replace(/\/+$/,"");
  let response:Response|undefined;
  for(const endpoint of ["/api/v1/explore-deploy-by-block-hash","/api/explore-deploy-by-block-hash"]){
    response=await fetch(base+endpoint,{
      method:"POST",headers:{"content-type":"application/json"},signal:AbortSignal.timeout(15000),
      body:JSON.stringify({term,blockHash,usePreStateHash:false}),
    });
    if(response.status!==404&&response.status!==405)break;
  }
  if(!response?.ok)throw new Error("pinned registry read HTTP "+(response?.status??"unavailable"));
  const reply:unknown=await response.json();
  if(!reply||typeof reply!=="object"||Array.isArray(reply))throw new Error("invalid pinned registry response");
  const r=reply as {expr?:unknown[];replySource?:string;block?:{blockHash?:string}};
  if(!Array.isArray(r.expr))throw new Error("pinned registry response has no expression list");
  if(r.block?.blockHash && r.block.blockHash!==blockHash)throw new Error("pinned registry response block mismatch");
  if(r.replySource!==undefined && r.replySource!=="out")throw new Error("pinned registry reply not captured on out: "+String(r.replySource).slice(0,32));
  const data=await decodeMemoryRecord(r.expr.map(renderExpr));
  if(!data)throw new Error("pinned registry content unavailable or invalid (expressions="+r.expr.length+", replySource="+(r.replySource??"unspecified")+")");
  return data;
}
export class RholoRegistryMemory implements MemoryDurableBackend {
  constructor(readonly network:string,private readonly config:NodeConfig){}
  async publish(bytes:Uint8Array,id:string):Promise<ObjectLocator>{
    const data=Uint8Array.from(bytes);
    if(await objectIdentity(data)!==id)throw new Error("publication hash mismatch");
    const sent=await deployTerm(this.config,memoryPublishProgram(id,data));
    if(!sent.ok||!sent.sig){
      // Keep the rejection reason useful without echoing arbitrary long hex
      // (payloads, signatures or keys) returned by a remote node.
      const reason=sent.message.replace(/[0-9a-f]{32,}/gi,"[redacted hex]").replace(/[\r\n]+/g," ").slice(0,300);
      throw new Error("registry deploy not accepted: "+reason);
    }
    const verdict=await deployVerdict(this.config,sent.sig);
    if(!verdict)throw new Error("registry deploy outcome unavailable");
    if(!verdict.ok)throw new Error("registry deploy execution failed: "+verdict.error.replace(/[0-9a-f]{32,}/gi,"[redacted hex]").replace(/[\r\n]+/g," ").slice(0,300));
    const uris=[...new Set(verdict.values.map(v=>v.replace(/^"|"$/g,"")).filter(uriOk))];
    if(uris.length!==1)throw new Error("registry receipt missing or ambiguous");
    // Executed status alone is not inclusion (#447). Locate the actual
    // signature-bearing block; do not substitute the highest tip.
    const carrying=await deployFate(this.config,sent.sig,25);
    if(!carrying||carrying.errored||!isObjectId(carrying.blockHash))throw new Error("registry publication has no verified carrying block");
    return {network:this.network,uri:uris[0],blockHash:carrying.blockHash};
  }
  async read(locator:ObjectLocator):Promise<Uint8Array|null>{
    if(locator.network!==this.network||!uriOk(locator.uri))return null;
    if(locator.blockHash)return memoryReadAtBlock(this.config,locator.uri,locator.blockHash);
    // Legacy locators lack an inclusion anchor. Query a named current block,
    // never silently use a different block for an anchored locator.
    const response=await fetch(this.config.url.replace(/\/+$/,"")+"/api/blocks/1",{signal:AbortSignal.timeout(10000)});
    if(!response.ok)throw new Error("legacy registry block lookup HTTP "+response.status);
    const body=await response.json() as {blockHash?:string}[]|{blocks?:{blockHash?:string}[]};
    const hash=(Array.isArray(body)?body:body.blocks)?.[0]?.blockHash;
    return isObjectId(hash)?memoryReadAtBlock(this.config,locator.uri,hash):null;
  }
}
