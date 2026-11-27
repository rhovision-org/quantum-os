// Filesystem availability cache for room-memory carriers, not machine history.
import fs from "node:fs/promises";
import path from "node:path";
import {createHash,randomUUID} from "node:crypto";
const valid=id=>typeof id==="string"&&/^[0-9a-f]{64}$/.test(id);
const hash=b=>createHash("sha256").update(b).digest("hex");
const MAX=64*1024;
export class DaemonMemoryByteCache{
  constructor(stateDir,scopeHash){
    if(!valid(scopeHash))throw new Error("invalid room scope");
    this.dir=path.join(stateDir,"memory-bytes-v1",scopeHash);
  }
  file(id){if(!valid(id))throw new Error("invalid object ID");return path.join(this.dir,id);}
  async get(id){
    try{const f=this.file(id);if((await fs.stat(f)).size>MAX)return null;
      const b=await fs.readFile(f);return b.length<=MAX&&hash(b)===id?Uint8Array.from(b):null;}catch{return null;}
  }
  async put(id,bytes){
    const data=Buffer.from(bytes);if(data.length>MAX||hash(data)!==id)throw new Error("cache hash mismatch");
    const target=this.file(id);await fs.mkdir(this.dir,{recursive:true,mode:0o700});
    const temp=path.join(this.dir,"."+randomUUID()+".part");
    try{await fs.writeFile(temp,data,{mode:0o600,flag:"wx"});await fs.rename(temp,target);}finally{await fs.rm(temp,{force:true});}
  }
  async remove(id){await fs.rm(this.file(id),{force:true});}
  async keys(){try{return (await fs.readdir(this.dir)).filter(valid).sort();}catch(e){if(e.code==="ENOENT")return [];throw e;}}
}
