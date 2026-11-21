// Availability is deliberately outside deterministic replay and its digest.
import { MAX_OBJECT_BYTES, isObjectId, parseDescriptor, type ObjectDescriptor, type ObjectLocator, type MemoryObject } from "./qos-memory.js";
import type { QosKernel } from "./qos-kernel.js";

export interface MemoryByteCache {
  get(id:string):Promise<Uint8Array|null>;
  put(id:string,bytes:Uint8Array):Promise<void>;
  remove(id:string):Promise<void>;
  keys():Promise<string[]>;
}
export interface MemoryDurableBackend {
  readonly network:string;
  publish(bytes:Uint8Array,id:string):Promise<ObjectLocator>;
  read(locator:ObjectLocator):Promise<Uint8Array|null>;
}
export async function objectIdentity(bytes:Uint8Array):Promise<string>{
  if(bytes.byteLength>MAX_OBJECT_BYTES)throw new Error("memory object too large");
  const snapshot=Uint8Array.from(bytes);
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",snapshot)),b=>b.toString(16).padStart(2,"0")).join("");
}
async function verified(bytes:Uint8Array|null,d:{id:string;size:number}):Promise<Uint8Array|null>{
  if(!bytes||bytes.byteLength!==d.size||bytes.byteLength>MAX_OBJECT_BYTES)return null;
  const snapshot=Uint8Array.from(bytes);
  return await objectIdentity(snapshot)===d.id?snapshot:null;
}
export class RoomByteCache implements MemoryByteCache {
  private values=new Map<string,Uint8Array>();
  async get(id:string){const b=this.values.get(id);return b?Uint8Array.from(b):null;}
  async put(id:string,bytes:Uint8Array){const data=Uint8Array.from(bytes);if(!isObjectId(id)||await objectIdentity(data)!==id)throw new Error("cache hash mismatch");this.values.set(id,data);}
  async remove(id:string){this.values.delete(id);}
  async keys(){return [...this.values.keys()].sort();}
}
type Dir = {getDirectoryHandle(name:string,options?:{create?:boolean}):Promise<Dir>;
  getFileHandle(name:string,options?:{create?:boolean}):Promise<{getFile():Promise<File>;createWritable():Promise<{write(data:Blob):Promise<void>;close():Promise<void>;abort():Promise<void>}>}>;
  removeEntry(name:string):Promise<void>;keys():AsyncIterable<string>};
export class OpfsMemoryCache implements MemoryByteCache {
  constructor(private readonly scopeHash:string){if(!isObjectId(scopeHash))throw new Error("invalid cache scope");}
  private async dir(create:boolean):Promise<Dir>{
    const storage=navigator.storage as unknown as {getDirectory():Promise<Dir>};
    const root=await storage.getDirectory();
    return (await root.getDirectoryHandle("qos-memory-v1",{create})).getDirectoryHandle(this.scopeHash,{create});
  }
  async get(id:string):Promise<Uint8Array|null>{
    if(!isObjectId(id))return null;
    try{const f=await (await (await this.dir(false)).getFileHandle(id)).getFile();
      return f.size<=MAX_OBJECT_BYTES?new Uint8Array(await f.arrayBuffer()):null;}catch{return null;}
  }
  async put(id:string,bytes:Uint8Array):Promise<void>{
    const b=Uint8Array.from(bytes);
    if(!isObjectId(id)||await objectIdentity(b)!==id)throw new Error("cache hash mismatch");
    const w=await (await (await this.dir(true)).getFileHandle(id,{create:true})).createWritable();
    try{await w.write(new Blob([b]));await w.close();}catch(e){await w.abort().catch(()=>{});throw e;}
  }
  async remove(id:string):Promise<void>{
    if(!isObjectId(id))throw new Error("invalid object id");
    const dir=await this.dir(false);await dir.removeEntry(id);
  }
  async keys():Promise<string[]>{
    const out:string[]=[];
    try{for await(const key of (await this.dir(false)).keys())if(isObjectId(key))out.push(key);}catch{return [];}
    return out.sort();
  }
}
// A room-local service serializes preparation, reads and collection. It cannot
// prove that an offline peer or future history does not retain a reference.
export class QosMemoryBytes {
  private tail:Promise<unknown>=Promise.resolve();
  private staged=new Map<string,number>();
  constructor(private readonly cache:MemoryByteCache,private readonly backends:readonly MemoryDurableBackend[]=[]){}
  private run<T>(fn:()=>Promise<T>):Promise<T>{
    const next=this.tail.then(fn);this.tail=next.then(()=>undefined,()=>undefined);return next;
  }
  /** Explicit publication; no network writes are hidden in replay or get. */
  prepare(bytes:Uint8Array,durableNetwork?:string):Promise<ObjectDescriptor>{
    const data=Uint8Array.from(bytes);
    return this.run(async()=>{
      const id=await objectIdentity(data),size=data.byteLength;
      let locator:ObjectLocator|null=null;
      if(durableNetwork!==undefined){
        const backend=this.backends.find(b=>b.network===durableNetwork);
        if(!backend)throw new Error("unconfigured durable network");
        locator=await backend.publish(Uint8Array.from(data),id);
        if(locator.network!==backend.network||!parseDescriptor({id,size,locator}))throw new Error("invalid publication locator");
        if(!await verified(await backend.read(locator),{id,size}))throw new Error("durable readback did not verify");
      }
      await this.cache.put(id,data);this.staged.set(id,(this.staged.get(id)??0)+1);
      return {id,size,locator};
    });
  }
  /** Release the local staging pin after the descriptor is journaled or abandoned. */
  releaseStaged(id:string):void{const n=this.staged.get(id)??0;if(n<=1)this.staged.delete(id);else this.staged.set(id,n-1);}
  /** Authorize by a live caller-owned handle before and after asynchronous I/O. */
  get(current:()=>QosKernel,pid:string,handle:string):Promise<Uint8Array|null>{
    return this.run(async()=>{
      const auth=current().memoryStat(pid,handle);if(!auth.ok)return null;
      const d:MemoryObject=auth.value;
      let data=await verified(await this.cache.get(d.id).catch(()=>null),d);
      if(!data)for(const locator of d.locators){
        const backend=this.backends.find(b=>b.network===locator.network);if(!backend)continue;
        try{data=await verified(await backend.read(locator),d);if(data)break;}catch{/* unavailable or corrupt */}
      }
      if(!data)return null;
      const after=current().memoryStat(pid,handle);
      if(!after.ok||after.value.id!==d.id||after.value.size!==d.size)return null;
      await this.cache.put(d.id,data).catch(()=>{});
      const final=current().memoryStat(pid,handle);
      return final.ok&&final.value.id===d.id&&final.value.size===d.size?Uint8Array.from(data):null;
    });
  }
  /** A mediated proxy read: no raw resource handle or target bytes are
   * handed over as a reusable capability. Recheck the same observation
   * at the resource boundary after every asynchronous availability read. */
  getProxy(current:()=>QosKernel,pid:string,token:string,path:string,version:string,expectedId:string):Promise<Uint8Array|null>{
    return this.run(async()=>{
      const before=current(),observation=before.proxyObservation(pid,token);
      const auth=before.proxyReadDescriptor(pid,token,path,version);
      if(!observation||!auth.ok||auth.value.id!==expectedId)return null;
      const d=auth.value;
      const stillAuthorized=()=>{
        const k=current(),after=k.proxyReadDescriptor(pid,token,path,version);
        return after.ok&&after.value.id===d.id&&after.value.size===d.size&&
          JSON.stringify(k.proxyObservation(pid,token))===JSON.stringify(observation);
      };
      let data=await verified(await this.cache.get(d.id).catch(()=>null),d);
      if(!data)for(const locator of d.locators){
        if(!stillAuthorized())return null;
        const backend=this.backends.find(b=>b.network===locator.network);if(!backend)continue;
        try{data=await verified(await backend.read(locator),d);if(data)break;}catch{/* unavailable */}
      }
      if(!data||!stillAuthorized())return null;
      await this.cache.put(d.id,data).catch(()=>{});
      return stillAuthorized()?Uint8Array.from(data):null;
    });
  }
  /** Deterministic candidates from local reachability + explicit pins only.
   * Never send deletion to a durable backend. Unknown cache files are retained
   * unless explicitly abandoned by the application; no global GC claim. */
  collect(current:()=>QosKernel,pins:()=>ReadonlySet<string>=()=>new Set()):Promise<string[]>{
    return this.run(async()=>{
      const removed:string[]=[];
      for(const id of (await this.cache.keys()).sort()){
        const graph=current().memoryView();
        if(!graph.unreachable.includes(id)||this.staged.has(id)||pins().has(id))continue;
        await this.cache.remove(id);removed.push(id);
      }
      return removed;
    });
  }
}
