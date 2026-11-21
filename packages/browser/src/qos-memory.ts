// #279: content identity, logical graph and byte availability are separate.
// The graph contains no bytes and performs no I/O.
export const MAX_OBJECT_BYTES = 64 * 1024;
export const MAX_MEMORY_FRONTIER = 4096;
export const MEMORY_OPS = ["mem_put","mem_get","mem_stat","mem_ref","mem_drop","mem_link","mem_unlink"] as const;
export type MemoryOp = typeof MEMORY_OPS[number];
export interface ObjectLocator { network:string; uri:string; blockHash?:string }
export interface ObjectDescriptor { id:string; size:number; locator:ObjectLocator|null }
const cmp = (a:string,b:string) => a<b?-1:a>b?1:0;
export const isObjectId = (id:unknown):id is string => typeof id==="string" && /^[0-9a-f]{64}$/.test(id);
export function parseDescriptor(v:unknown):ObjectDescriptor|null {
  if (!v || typeof v!=="object" || Array.isArray(v)) return null;
  const d=v as Record<string,unknown>;
  if (Object.keys(d).length!==3 || !isObjectId(d.id) || typeof d.size!=="number" ||
      !Number.isSafeInteger(d.size) || d.size<0 || d.size>MAX_OBJECT_BYTES || !Object.hasOwn(d,"locator")) return null;
  let locator:ObjectLocator|null=null;
  if (d.locator!==null) {
    if (!d.locator || typeof d.locator!=="object" || Array.isArray(d.locator)) return null;
    const l=d.locator as Record<string,unknown>;
    if ((Object.keys(l).length!==2 && Object.keys(l).length!==3) || Object.keys(l).some(k=>!["network","uri","blockHash"].includes(k)) || typeof l.network!=="string" || !/^[A-Za-z0-9._/-]{1,128}$/.test(l.network) ||
        typeof l.uri!=="string" || !/^rho:id:[a-z0-9]{1,128}$/.test(l.uri)) return null;
    if (Object.hasOwn(l,"blockHash") && !isObjectId(l.blockHash)) return null;
    locator={network:l.network,uri:l.uri,...(isObjectId(l.blockHash)?{blockHash:l.blockHash}:{})};
  }
  return {id:d.id,size:d.size,locator};
}
export type MemoryObject = {id:string;size:number;locators:ObjectLocator[]};
export class QosMemoryGraph {
  private objects=new Map<string,MemoryObject>();
  // Edge ownership is process scoped; removing one's edge never removes another's.
  private edges=new Map<string,{owner:string;from:string;to:string}>();
  private receipts=new Set<string>();
  frontier():string[]{return [...this.receipts].sort(cmp);}
  observe(hash:string):void{this.receipts.add(hash);}
  commit(hash:string):void{this.receipts=new Set([hash]);}
  clone():QosMemoryGraph{
    const g=new QosMemoryGraph();
    for(const [id,d] of this.objects)g.objects.set(id,{...d,locators:d.locators.map(l=>({...l}))});
    for(const [k,e] of this.edges)g.edges.set(k,{...e});
    g.receipts=new Set(this.receipts);return g;
  }
  put(d:ObjectDescriptor):boolean{
    const previous=this.objects.get(d.id);
    if(previous && previous.size!==d.size)return false;
    const obj=previous??{id:d.id,size:d.size,locators:[]};
    if(d.locator && !obj.locators.some(l=>l.network===d.locator!.network && l.uri===d.locator!.uri && l.blockHash===d.locator!.blockHash)){
      obj.locators.push({...d.locator});obj.locators.sort((a,b)=>cmp(a.network,b.network)||cmp(a.uri,b.uri)||cmp(a.blockHash??"",b.blockHash??""));
    }
    this.objects.set(d.id,obj);return true;
  }
  stat(id:string):MemoryObject|null{
    const obj=this.objects.get(id);return obj?{...obj,locators:obj.locators.map(l=>({...l}))}:null;
  }
  link(owner:string,from:string,to:string,remove=false):boolean{
    if(!this.objects.has(from)||!this.objects.has(to))return false;
    const key=JSON.stringify([owner,from,to]);
    if(remove)this.edges.delete(key);else this.edges.set(key,{owner,from,to});
    return true;
  }
  reachable(roots:Iterable<string>):string[]{
    const children=new Map<string,string[]>();
    for(const e of this.edges.values()){const c=children.get(e.from)??[];c.push(e.to);children.set(e.from,c);}
    const seen=new Set<string>();
    const queue=[...new Set(roots)].sort(cmp);
    for(let i=0;i<queue.length;i++){
      const id=queue[i];if(seen.has(id)||!this.objects.has(id))continue;
      seen.add(id);for(const child of children.get(id)??[])if(!seen.has(child))queue.push(child);
    }
    return [...seen].sort(cmp);
  }
  state(roots:Iterable<string>){
    const reachable=this.reachable(roots);
    const live=new Set(reachable);
    return {objects:[...this.objects.keys()].sort(cmp).map(id=>this.stat(id)!),
      edges:[...this.edges.entries()].sort(([a],[b])=>cmp(a,b)).map(([,e])=>({...e})),
      reachable,unreachable:[...this.objects.keys()].filter(id=>!live.has(id)).sort(cmp),frontier:this.frontier()};
  }
}
