// #280: pure immutable directory manifests. Bytes live in the memory layer.
import {sha256} from "@noble/hashes/sha2.js";
import {canonicalJson} from "./qos-process.js";
import {isObjectId} from "./qos-memory.js";
export const VFS_OPS=["fs_init","fs_stat","fs_ls","fs_open","fs_put","fs_mkdir","fs_unlink","fs_rename","fs_mount","fs_unmount","fs_grant"] as const;
export type VfsOp=typeof VFS_OPS[number];
export const MAX_VFS_ENTRIES=1024;
const cmp=(a:string,b:string)=>a<b?-1:a>b?1:0;
const hash=(x:unknown)=>Array.from(sha256(new TextEncoder().encode(canonicalJson(x))),b=>b.toString(16).padStart(2,"0")).join("");
export type VfsEntry={path:string;kind:"dir"|"mount"}|{path:string;kind:"file";id:string};
export type VfsNamespace={id:string;root:string;version:string;entries:VfsEntry[]};
export type VfsResult<T>={ok:true;value:T}|{ok:false;errno:"EACCES"|"ENOENT"|"EINVAL"|"EAGAIN";detail:string};
const ok=<T>(value:T):VfsResult<T>=>({ok:true,value});
const fail=(errno:"EACCES"|"ENOENT"|"EINVAL"|"EAGAIN",detail:string):VfsResult<never>=>({ok:false,errno,detail});
const parent=(p:string)=>p.slice(0,p.lastIndexOf("/"))||"/";
const childOf=(p:string,root:string)=>root==="/"?p!=="/":p.startsWith(root+"/");
export function vfsPath(raw:string):VfsResult<string>{
  if(typeof raw!=="string"||raw.length>1024||!raw.startsWith("/")||/[\u0000-\u001f\u007f\\]/.test(raw))return fail("EINVAL","absolute bounded path required");
  const out:string[]=[];
  for(const part of raw.split("/")){
    if(!part||part===".")continue;
    if(part===".."){if(!out.length)return fail("EACCES","path escapes capability root");out.pop();continue;}
    if(part.length>128||out.length>=32)return fail("EINVAL","path component or depth limit");
    out.push(part);
  }
  return ok("/"+out.join("/"));
}
function manifest(entries:VfsEntry[]){
  const ids=new Map<string,string>();
  for(const e of [...entries].sort((a,b)=>b.path.length-a.path.length||cmp(a.path,b.path))){
    if(e.kind==="file"){ids.set(e.path,e.id);continue;}
    const children=entries.filter(x=>x.path!==e.path&&parent(x.path)===e.path).sort((a,b)=>cmp(a.path,b.path))
      .map(x=>[x.path.slice(x.path.lastIndexOf("/")+1),x.kind,ids.get(x.path)!]);
    ids.set(e.path,hash({schema:"qos.directory/1",entries:children}));
  }
  return ids;
}
export class QosVfs{
  private namespaces=new Map<string,VfsNamespace>();
  clone(){const v=new QosVfs();for(const [id,n] of this.namespaces)v.namespaces.set(id,{...n,entries:n.entries.map(e=>({...e}))});return v;}
  state(){return [...this.namespaces.values()].sort((a,b)=>cmp(a.id,b.id)).map(n=>({...n,entries:n.entries.map(e=>({...e}))}));}
  get(id:string){const n=this.namespaces.get(id);return n?{...n,entries:n.entries.map(e=>({...e}))}:null;}
  create(id:string){if(this.namespaces.has(id))return fail("EINVAL","namespace already exists");const entries:VfsEntry[]=[{path:"/",kind:"dir"}];const n={id,entries,root:manifest(entries).get("/")!,version:""};this.namespaces.set(id,n);return ok(this.get(id)!);}
  stamp(id:string,version:string){const n=this.namespaces.get(id);if(n)n.version=version;}
  fileIds(id:string){return (this.namespaces.get(id)?.entries??[]).flatMap(e=>e.kind==="file"?[e.id]:[]);}
  inspect(id:string,path:string,list=false):VfsResult<unknown>{
    const p=vfsPath(path);if(!p.ok)return p;const n=this.namespaces.get(id);if(!n)return fail("ENOENT","namespace absent");
    const e=n.entries.find(e=>e.path===p.value);if(!e)return fail("ENOENT","path absent");
    const ids=manifest(n.entries);
    if(list){if(e.kind==="file")return fail("EINVAL","not a directory");
      return ok(n.entries.filter(x=>x.path!==e.path&&parent(x.path)===e.path).map(x=>({...x,id:ids.get(x.path)!})));
    }
    return ok({...e,id:ids.get(e.path)!,root:n.root,version:n.version});
  }
  file(id:string,path:string):VfsResult<string>{
    const p=vfsPath(path);if(!p.ok)return p;const e=this.namespaces.get(id)?.entries.find(e=>e.path===p.value);
    return !e?fail("ENOENT","path absent"):e.kind!=="file"?fail("EINVAL","not a file"):ok(e.id);
  }
  mutate(id:string,base:string,version:string,op:VfsOp,path:string,extra?:string,source?:string):VfsResult<{id:string;root:string}>{
    const current=this.namespaces.get(id);if(!current)return fail("ENOENT","namespace absent");
    if(current.root!==base||current.version!==version)return fail("EAGAIN","namespace base root/version conflict");
    const p=vfsPath(path);if(!p.ok)return p;const at=p.value;
    if(at==="/")return fail("EACCES","cannot replace namespace root");
    const entries=new Map(current.entries.map(e=>[e.path,{...e}]));
    const mounted=(path:string,include=true)=>[...entries.values()].some(e=>e.kind==="mount"&&((include&&e.path===path)||childOf(path,e.path)));
    if(mounted(at,op!=="fs_unmount"))return fail("EACCES","read-only snapshot mount");
    const existing=entries.get(at),dir=entries.get(parent(at));
    if(!dir||dir.kind!=="dir")return fail("ENOENT","writable parent directory absent");
    switch(op){
      case "fs_put":
        if(!isObjectId(extra))return fail("EINVAL","invalid content identity");
        if(existing&&existing.kind!=="file")return fail("EINVAL","destination is not a file");
        entries.set(at,{path:at,kind:"file",id:extra});break;
      case "fs_mkdir":
        if(existing)return fail("EINVAL","path exists");
        entries.set(at,{path:at,kind:"dir"});break;
      case "fs_unlink":
        if(!existing)return fail("ENOENT","path absent");
        if([...entries.keys()].some(x=>childOf(x,at)))return fail("EINVAL","directory not empty");
        entries.delete(at);break;
      case "fs_rename":{
        if(!existing)return fail("ENOENT","source absent");
        const to=vfsPath(extra??"");if(!to.ok)return to;
        if(to.value==="/"||entries.has(to.value)||childOf(to.value,at))return fail("EINVAL","invalid or existing rename destination");
        if(mounted(to.value)||entries.get(parent(to.value))?.kind!=="dir")return fail("EACCES","destination outside writable directory");
        if([...entries.values()].some(e=>e.kind==="mount"&&(e.path===at||childOf(e.path,at))))return fail("EACCES","detach mounts before rename");
        const moved=[...entries.values()].filter(e=>e.path===at||childOf(e.path,at));
        for(const e of moved)entries.delete(e.path);
        for(const e of moved){const path=to.value+e.path.slice(at.length);if(!vfsPath(path).ok)return fail("EINVAL","renamed path exceeds limit");entries.set(path,{...e,path});}
        break;
      }
      case "fs_mount":{
        if(existing)return fail("EINVAL","mount destination exists");
        const n=source?this.namespaces.get(source):null;
        if(!n)return fail("ENOENT","source namespace absent");
        entries.set(at,{path:at,kind:"mount"});
        for(const e of n.entries){if(e.path==="/")continue;const path=at+e.path;if(!vfsPath(path).ok)return fail("EINVAL","mounted path exceeds limit");entries.set(path,{...e,path});}
        break;
      }
      case "fs_unmount":
        if(existing?.kind!=="mount")return fail("EINVAL","not a mount point");
        for(const x of [...entries.keys()])if(x===at||childOf(x,at))entries.delete(x);
        break;
      default:return fail("EINVAL","unsupported namespace mutation");
    }
    if(entries.size>MAX_VFS_ENTRIES)return fail("EINVAL","namespace entry limit");
    const next=[...entries.values()].sort((a,b)=>cmp(a.path,b.path));
    const root=manifest(next).get("/")!;
    this.namespaces.set(id,{id,root,version:current.version,entries:next});
    return ok({id,root});
  }
}
