// #286: public boot identity, private journal evidence, common replay contract.
// The manifest deliberately contains no room capability, event body, key,
// endpoint, runtime secret or serialized host binding.
import {QOS_ABI_VERSION,replayQosKernel} from "./qos-kernel.js";
import {QosEventLog,canonicalJson,sha256Hex} from "./qos-process.js";
import {verifySnapshot,type KernelSnapshot} from "./qos-observe.js";
import {packageName,parsePackage,verifyPackage,packageIdentity} from "./qos-init.js";
import {DEVICE_KINDS,deviceRights,type DeviceKind} from "./qos-device.js";
export const BOOT_KERNEL="qos.kernel/1";
const isHash=(x:unknown):x is string=>typeof x==="string"&&/^[0-9a-f]{64}$/.test(x);
const exact=(x:unknown,keys:string[]):x is Record<string,unknown>=>!!x&&typeof x==="object"&&!Array.isArray(x)&&Object.keys(x).length===keys.length&&keys.every(k=>Object.hasOwn(x,k));
const cmp=(a:string,b:string)=>a<b?-1:a>b?1:0;
export type BootPackage={supervisor:string;name:string;id:string;publisher:string};
export type BootDevice={id:string;kind:DeviceKind;rights:number;binding:"explicit"};
export type BootManifest={schema:"qos.boot/1";kernel:{contract:typeof BOOT_KERNEL;abi:number};
 init:{supervisor:string;services:string[]};packages:BootPackage[];devices:BootDevice[];
 stateRoot:string;snapshot:string};
export function parseBootManifest(x:unknown):BootManifest{
 if(!exact(x,["schema","kernel","init","packages","devices","stateRoot","snapshot"])||x.schema!=="qos.boot/1"||
 !exact(x.kernel,["contract","abi"])||x.kernel.contract!==BOOT_KERNEL||x.kernel.abi!==QOS_ABI_VERSION||
 !exact(x.init,["supervisor","services"])||!isHash(x.init.supervisor)||!Array.isArray(x.init.services)||
 !x.init.services.length||x.init.services.length>32||!x.init.services.every(packageName)||new Set(x.init.services).size!==x.init.services.length||
 !isHash(x.stateRoot)||!isHash(x.snapshot)||!Array.isArray(x.packages)||x.packages.length>1024||!Array.isArray(x.devices)||x.devices.length>128)
 throw Error("invalid or unsupported boot manifest");
 const packages=x.packages;
 if(!packages.every(p=>exact(p,["supervisor","name","id","publisher"])&&isHash(p.supervisor)&&packageName(p.name)&&isHash(p.id)&&isHash(p.publisher)))
 throw Error("invalid boot package set");
 const keys=packages.map(p=>p.supervisor+":"+p.name);
 if(keys.some((k,i)=>i>0&&keys[i-1]>=k))throw Error("boot packages must be unique and sorted");
 const devices=x.devices;
 if(!devices.every(d=>exact(d,["id","kind","rights","binding"])&&isHash(d.id)&&DEVICE_KINDS.includes(d.kind as DeviceKind)&&
 typeof d.rights==="number"&&Number.isSafeInteger(d.rights)&&d.rights>0&&(d.rights&~deviceRights(d.kind as DeviceKind))===0&&d.binding==="explicit"))
 throw Error("invalid boot device bindings");
 if(devices.some((d,i)=>i>0&&devices[i-1].id>=d.id))throw Error("boot devices must be unique and sorted");
 if(x.init.services.some(n=>!packages.some(p=>p.supervisor===x.init.supervisor&&p.name===n)))throw Error("missing init package");
 return JSON.parse(JSON.stringify(x)) as BootManifest;
}
export async function bootAddress(value:unknown):Promise<string>{return sha256Hex(canonicalJson(parseBootManifest(value)));}
export async function discoverBoot(address:string,read:(address:string)=>Promise<unknown>):Promise<BootManifest>{
 if(!isHash(address))throw Error("invalid boot content address");
 const m=parseBootManifest(await read(address));
 if(await bootAddress(m)!==address)throw Error("boot manifest content address mismatch");
 return m;
}
const supervisorId=(pid:string)=>sha256Hex("qos.boot.supervisor/1:"+pid);
async function evidence(snapshot:unknown,room:string){
 const s=await verifySnapshot(snapshot,room),log=new QosEventLog(room);
 for(const event of s.events){const result=await log.ingest(event);if(!result.ok)throw Error("boot evidence rejected");}
 const replay=replayQosKernel(log.events(),log.forkedSources);
 return {s,replay,log};
}
async function describe(snapshot:KernelSnapshot,replay:ReturnType<typeof replayQosKernel>,pid:string,services:string[]):Promise<BootManifest>{
 const k=replay.kernel,supervisor=await supervisorId(pid);
 if(k.getProcess(pid)?.state!=="running")throw Error("boot supervisor is absent or not running");
 const packages:BootPackage[]=[];
 for(const proc of k.list()){
  for(const entry of k.initView(proc.pid).packages){
   const signed=parsePackage({manifest:entry.manifest,signature:entry.signature});
   if(!signed||!verifyPackage(signed,entry.manifest.publisher)||packageIdentity(signed)!==entry.id)throw Error("installed package identity or signature mismatch");
   packages.push({supervisor:await supervisorId(proc.pid),name:entry.manifest.name,id:entry.id,publisher:entry.manifest.publisher});
  }
 }
 packages.sort((a,b)=>cmp(a.supervisor+":"+a.name,b.supervisor+":"+b.name));
 const devices=(k.state().devices as {id:string;kind:DeviceKind;rights:number}[]).map(d=>({id:d.id,kind:d.kind,rights:d.rights,binding:"explicit" as const}));
 // Verify the transitive dependency closure before declaring the boot image.
 const registry=new Map(k.initView(pid).packages.map(p=>[p.manifest.name,p]));
 const visiting=new Set<string>(),done=new Set<string>();
 const visit=(n:string)=>{
  if(visiting.has(n))throw Error("boot dependency cycle: "+n);
  if(done.has(n))return;
  const p=registry.get(n);if(!p)throw Error("missing boot package: "+n);
  visiting.add(n);for(const d of p.manifest.dependencies)visit(d);visiting.delete(n);done.add(n);
 };
 for(const n of services)visit(n);
 return parseBootManifest({schema:"qos.boot/1",kernel:{contract:BOOT_KERNEL,abi:QOS_ABI_VERSION},
 init:{supervisor,services:[...services]},packages,devices,stateRoot:snapshot.digest,snapshot:snapshot.id});
}
export async function createBootManifest(snapshot:unknown,room:string,pid:string,services:string[]):Promise<BootManifest>{
 const {s,replay}=await evidence(snapshot,room);
 return describe(s,replay,pid,services);
}
export async function verifyBoot(manifest:unknown,address:string,snapshot:unknown,room:string){
 const m=await discoverBoot(address,async()=>manifest);
 const {s,replay,log}=await evidence(snapshot,room);
 if(s.id!==m.snapshot||s.digest!==m.stateRoot)throw Error("boot snapshot or state root mismatch");
 const pids:string[]=[];
 for(const p of replay.kernel.list())if(await supervisorId(p.pid)===m.init.supervisor)pids.push(p.pid);
 if(pids.length!==1)throw Error("boot supervisor identity mismatch");
 const pid=pids[0],actual=await describe(s,replay,pid,m.init.services);
 if(canonicalJson(actual.packages)!==canonicalJson(m.packages))throw Error("boot package set mismatch");
 if(canonicalJson(actual.devices)!==canonicalJson(m.devices))throw Error("boot device set mismatch");
 return {manifest:m,snapshot:s,replay,log,pid};
}
