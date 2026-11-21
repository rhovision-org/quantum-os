// Explicit registry availability adapter. No deploy is performed during replay.
import { MAX_OBJECT_BYTES, isObjectId } from "./qos-memory.js";
import { objectIdentity, type MemoryDurableBackend } from "./qos-memory-bytes.js";
import { deployTerm, deployVerdict, evalTerm, type NodeConfig } from "./rholang.js";
import type { ObjectLocator } from "./qos-memory.js";
const uriOk=(uri:string)=>/^rho:id:[a-z0-9]{1,128}$/.test(uri);
const hex=(b:Uint8Array)=>Array.from(b,x=>x.toString(16).padStart(2,"0")).join("");
export function memoryPublishProgram(id:string,bytes:Uint8Array):string{
  if(!isObjectId(id)||bytes.byteLength>MAX_OBJECT_BYTES)throw new Error("invalid object");
  // Store ASCII JSON as a Rholang string, avoiding node-specific map rendering.
  const record=JSON.stringify(JSON.stringify({schema:"qos.memory/1",id,hex:hex(bytes)}));
  return `new insertArbitrary(\`rho:registry:insertArbitrary\`), ret in {
  insertArbitrary!(${record}, *ret) |
  for (@uri <- ret) { return!(uri) | deployId!(uri) }
}`;
}
export function memoryReadProgram(uri:string):string{
  if(!uriOk(uri))throw new Error("invalid registry URI");
  return `new lookup(\`rho:registry:lookup\`), stored in {
  lookup!(\`${uri}\`, *stored) |
  for (@record <- stored) {
    match record { (_, value) => { return!(value) } value => { return!(value) } }
  }
}`;
}
export async function decodeMemoryRecord(values:readonly string[],expectedId?:string):Promise<Uint8Array|null>{
  // Reject ambiguous answers rather than selecting an arbitrary record.
  if(values.length!==1||values[0].length>MAX_OBJECT_BYTES*2+512)return null;
  let v:unknown;try{v=JSON.parse(values[0]);if(typeof v==="string")v=JSON.parse(v);}catch{return null;}
  if(!v||typeof v!=="object"||Array.isArray(v))return null;
  const r=v as Record<string,unknown>;
  if(Object.keys(r).length!==3||r.schema!=="qos.memory/1"||!isObjectId(r.id)||
     (expectedId!==undefined&&r.id!==expectedId)||typeof r.hex!=="string"||
     r.hex.length>MAX_OBJECT_BYTES*2||!/^(?:[0-9a-f]{2})*$/.test(r.hex))return null;
  const data=Uint8Array.from(r.hex.match(/../g)??[],x=>parseInt(x,16));
  return await objectIdentity(data)===r.id?data:null;
}
export class RholoRegistryMemory implements MemoryDurableBackend {
  constructor(readonly network:string,private readonly config:NodeConfig){}
  async publish(bytes:Uint8Array,id:string):Promise<ObjectLocator>{
    const data=Uint8Array.from(bytes);
    if(await objectIdentity(data)!==id)throw new Error("publication hash mismatch");
    const sent=await deployTerm(this.config,memoryPublishProgram(id,data));
    if(!sent.ok||!sent.sig)throw new Error("registry deploy not accepted");
    const verdict=await deployVerdict(this.config,sent.sig);
    if(!verdict?.ok)throw new Error("registry deploy outcome unavailable or failed");
    const uris=[...new Set(verdict.values.map(v=>v.replace(/^"|"$/g,"")).filter(uriOk))];
    if(uris.length!==1)throw new Error("registry receipt missing or ambiguous");
    return {network:this.network,uri:uris[0]};
  }
  async read(locator:ObjectLocator):Promise<Uint8Array|null>{
    if(locator.network!==this.network||!uriOk(locator.uri))return null;
    const result=await evalTerm(this.config,memoryReadProgram(locator.uri));
    return decodeMemoryRecord(result.values);
  }
}
