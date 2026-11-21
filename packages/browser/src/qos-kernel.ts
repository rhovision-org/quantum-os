// qos-kernel.ts — QOS/1 kernel ABI v0.
//
// A pure, deterministic model of the kernel objects described in docs/os-abi.md:
// processes, capability handles, rights attenuation, signals, wait/exit, and a
// canonical state digest. It deliberately imports no DOM, storage, network, or
// app code. `qos-process.ts` remains the dyncap-attributed room-event contract; this module
// is the kernel seam that contract will call.
//
// Not implemented here (reserved by the ABI, tracked in the roadmap):
// read/write/stat/VFS, devices, services, and broader syscall
// authority. The bounded root-attributed syscall event slice is below.

import { canonicalJson, canonicalEventOrder, eventDependencies, type QosDependencyKind, brokenChainsIn, processIdFor, parseQosCapabilityScope, scopeAllows, sha256Hex, type QosEvent } from "./qos-process.js";

import { QosScheduler, SCHEDULER_OPS, MAX_SCHEDULER_FRONTIER, type SchedulerOp, type ScheduleView } from "./qos-scheduler.js";

import { QosMemoryGraph, MEMORY_OPS, MAX_MEMORY_FRONTIER, parseDescriptor, type MemoryOp, type MemoryObject, type ObjectDescriptor } from "./qos-memory.js";

import {QosVfs,VFS_OPS,type VfsOp} from "./qos-vfs.js";
import {isObjectId} from "./qos-memory.js";

import {sha256} from "@noble/hashes/sha2.js";
import {SHELL_OPS,SHELL_MAX_JOBS,CONFIG_COMMANDS,boundedText,newShellContext,parsePipeline,stageResult,shellVariable,shellPath,type ShellOp,type ShellContext,type ShellJob} from "./qos-shell.js";
const shellHash=(text:string)=>Array.from(sha256(new TextEncoder().encode(text)),b=>b.toString(16).padStart(2,"0")).join("");

import {IDENTITY_OPS,PROXY_ACTIONS,MAX_PROXIES,isUid,isProxyToken,type IdentityOp,type AuthorityProxy} from "./qos-identity.js";

import {DEVICE_OPS,DEVICE_KINDS,DEVICE_MAX_REQUESTS,DEVICE_MAX_DESCRIPTORS,deviceRequest,deviceObservation,deviceRights,deviceRight,type DeviceOp,type DeviceDescriptor,type DeviceTicket,type DeviceKind} from "./qos-device.js";

import {INIT_OPS,MAX_PACKAGES,MAX_RESTARTS,parsePackage,verifyPackage,packageIdentity,serviceIdentity,parseBindings,parseBoot,packageName,runBuiltin,type InitOp,type InstalledPackage,type ServiceRecord} from "./qos-init.js";

export const QOS_ABI_VERSION = 0;

export const QOS_RIGHTS = {
  READ: 1,
  WRITE: 2,
  EXEC: 4,
  SIGNAL: 8,
  GRANT: 16,
  REVOKE: 32,
  ADMIN: 64,
} as const;

export type QosRightName = keyof typeof QOS_RIGHTS;
export const QOS_ALL_RIGHTS =
  QOS_RIGHTS.READ | QOS_RIGHTS.WRITE | QOS_RIGHTS.EXEC | QOS_RIGHTS.SIGNAL |
  QOS_RIGHTS.GRANT | QOS_RIGHTS.REVOKE | QOS_RIGHTS.ADMIN;

export const QOS_SYSCALLS = [
  "getpid", "getppid", "spawn", "exit", "wait", "signal", "proc_suspend", "proc_resume",
  "cap_derive", "cap_revoke", "cap_close", "signal_grant", "open", ...MEMORY_OPS, ...VFS_OPS, ...SHELL_OPS, ...IDENTITY_OPS, ...DEVICE_OPS, ...INIT_OPS,
  "read", "write", "stat", "mkdir", "unlink", "rename", "mount", "unmount",
  "send", "recv", "listen", "connect", "accept",
  "svc_register", "svc_lookup", "yield", "sleep", "sched_step", "sched_priority", "sched_wake", "log",
] as const;
export type QosSyscallName = (typeof QOS_SYSCALLS)[number];

export const QOS_SIGNALS = ["SIGTERM", "SIGINT", "SIGKILL", "SIGCHLD"] as const;
export type QosSignal = (typeof QOS_SIGNALS)[number];

export type QosErrno = "EACCES" | "ENOENT" | "EBADF" | "EAGAIN" | "EINVAL" | "ENOTSUP" | "ENOSPC";

export type QosResult<T> =
  | { ok: true; value: T }
  | { ok: false; errno: QosErrno; detail?: string };

export interface QosHandle {
  readonly id: string;
  readonly object: string;
  readonly rights: number;
  readonly parent: string | null;
  revoked: boolean;
}

export type QosProcessState = "running" | "suspended" | "exited" | "reaped";

export interface QosProcess {
  readonly pid: string;
  readonly name: string;
  readonly owner: string;
  readonly parent: string | null;
  state: QosProcessState;
  exitCode: number | null;
  root: string;
  readonly handles: Map<string, QosHandle>;
  readonly pending: QosSignal[];
}

export interface QosProcessInfo {
  pid: string;
  name: string;
  owner: string;
  parent: string | null;
  state: QosProcessState;
  exitCode: number | null;
  root: string;
  handles: string[];
  pending: QosSignal[];
}

export interface QosHandleInfo {
  id: string;
  object: string;
  rights: number;
  parent: string | null;
  revoked: boolean;
}

const KNOWN_RIGHTS = QOS_ALL_RIGHTS;
const ok = <T>(value: T): QosResult<T> => ({ ok: true, value });
const err = <T = never>(errno: QosErrno, detail?: string): QosResult<T> => ({ ok: false, errno, detail });

function validRights(rights: number): boolean {
  return Number.isInteger(rights) && rights > 0 && rights <= KNOWN_RIGHTS && (rights & ~KNOWN_RIGHTS) === 0;
}

function signalExitCode(sig: QosSignal): number {
  switch (sig) {
    case "SIGKILL": return -9;
    case "SIGTERM": return -15;
    case "SIGINT": return -2;
    case "SIGCHLD": return 0;
  }
}

/** A deterministic, capability-based kernel object table. */
export class QosKernel {
  private readonly processes = new Map<string, QosProcess>();
  private scheduler = new QosScheduler();
  private memory = new QosMemoryGraph();
  private vfs = new QosVfs();
  // A quota bounds committed syscall receipts, not adversarial wire traffic.
  // Failed/refused receipts are retained for audit, with no resource mutation.
  private quotaCalls=new Map<string,number>();
  static readonly QUOTA={calls:512,handles:128,bytes:256*1024};
  quotaView(){
    return this.list().map(p=>{
      const live=this.processes.get(p.pid)!;
      const ids=new Set<string>();
      let handles=0;
      for(const h of live.handles.values())if(!h.revoked){
        handles++;
        if(h.object.startsWith("mem:"))ids.add(h.object.slice(4));
        if(h.object.startsWith("fs:"))for(const id of this.vfs.fileIds(h.object.slice(3)))ids.add(id);
      }
      let bytes=0;for(const id of ids)bytes+=this.memory.stat(id)?.size??0;
      return {pid:p.pid,calls:this.quotaCalls.get(p.pid)??0,handles,bytes,limits:{...QosKernel.QUOTA}};
    });
  }
  private quotaExempt(op:string){
    return ["getpid","getppid","mem_get","mem_stat","fs_stat","fs_ls","id_info","id_groups","id_cap","dev_list","pkg_list","svc_list","svc_status",
      "cap_close","cap_revoke","mem_drop","mem_unlink","fs_unlink","fs_unmount","dev_close","dev_observe","svc_stop","pkg_remove","sh_wait","signal"].includes(op);
  }
  quotaBefore(pid:string,op:string):QosResult<true>{
    // Cleanup remains possible at the limit.
    if(this.quotaExempt(op))return ok(true);
    return (this.quotaCalls.get(pid)??0)>=QosKernel.QUOTA.calls?err("EAGAIN","committed syscall quota exhausted"):ok(true);
  }
  quotaAfter(before:ReturnType<QosKernel["quotaView"]>,pid:string,op:string):QosResult<true>{
    const old=new Map(before.map(q=>[q.pid,q]));
    for(const q of this.quotaView()){
      const prev=old.get(q.pid);
      if(q.handles>QosKernel.QUOTA.handles&&q.handles>(prev?.handles??0))return err("ENOSPC","live handle quota");
      if(q.bytes>QosKernel.QUOTA.bytes&&q.bytes>(prev?.bytes??0))return err("ENOSPC","reachable logical object bytes quota");
    }
    if(!this.quotaExempt(op))
      this.quotaCalls.set(pid,(this.quotaCalls.get(pid)??0)+1);
    return ok(true);
  }
  private packages=new Map<string,Map<string,InstalledPackage>>();
  private services=new Map<string,Map<string,ServiceRecord>>();
  private initVersions=new Map<string,string>();
  initVersion(pid:string){return this.initVersions.get(pid)??this.processVersion(pid);}
  private initTables(pid:string){
    if(!this.packages.has(pid))this.packages.set(pid,new Map());
    if(!this.services.has(pid))this.services.set(pid,new Map());
    return {packages:this.packages.get(pid)!,services:this.services.get(pid)!};
  }
  initView(pid:string){
    const order=<T>(m:Map<string,T>|undefined)=>[...(m??new Map<string,T>())].sort(([a],[b])=>a<b?-1:a>b?1:0).map(([,v])=>v);
    return JSON.parse(JSON.stringify({packages:order(this.packages.get(pid)),services:order(this.services.get(pid))})) as {packages:InstalledPackage[];services:ServiceRecord[]};
  }
  snapshotInit():Map<string,string>{
    return new Map([...new Set([...this.packages.keys(),...this.services.keys()])].map(pid=>[pid,canonicalJson(this.initView(pid))]));
  }
  recordInit(before:Map<string,string>,hash:string){
    for(const [pid,value] of this.snapshotInit())if(before.get(pid)!==value)this.initVersions.set(pid,hash);
  }
  private packageAuthority(pid:string,pkg:InstalledPackage):boolean{
    const p=this.processes.get(pid);if(!p||p.state!=="running")return false;
    return pkg.manifest.capabilities.every(c=>{
      const b=pkg.bindings.find(x=>x.name===c.name);if(!b)return false;
      const h=this.handle(p,b.handle);
      return h.ok&&h.value.object.startsWith(c.kind+":")&&(h.value.rights&(c.rights|QOS_RIGHTS.GRANT))===(c.rights|QOS_RIGHTS.GRANT);
    });
  }
  private stopService(s:ServiceRecord,phase:ServiceRecord["phase"]="stopped",detail="stopped"){
    const child=s.pid?this.processes.get(s.pid):undefined;
    if(child&&(child.state==="running"||child.state==="suspended")){
      child.state="exited";child.exitCode=phase==="failed"?1:0;child.handles.clear();
      this.terminateShellChildren(child.pid);
    }
    s.phase=phase;s.detail=detail;
  }
  private stopDependents(pid:string,name:string){
    const pkgs=this.packages.get(pid),svcs=this.services.get(pid);if(!pkgs||!svcs)return;
    const blocked=new Set([name]);let changed=true;
    while(changed){changed=false;for(const [n,pkg] of pkgs)if(!blocked.has(n)&&pkg.manifest.dependencies.some(d=>blocked.has(d))){
      blocked.add(n);changed=true;const s=svcs.get(n);if(s&&s.phase==="running")this.stopService(s,"blocked","dependency stopped");
    }}
  }
  private stopSupervised(pid:string){for(const s of this.services.get(pid)?.values()??[])this.stopService(s);}
  private serviceReady(pid:string,name:string):boolean{
    const s=this.services.get(pid)?.get(name),pkg=this.packages.get(pid)?.get(name);
    return !!s&&!!pkg&&s.phase==="running"&&!!s.pid&&this.processes.get(s.pid)?.state==="running"&&this.packageAuthority(pid,pkg);
  }
  // Reconcile on every accepted mutation, including revocation/lifecycle
  // outside init. No hidden execution or automatic wall-clock retries.
  reconcileInit(){
    for(const [pid,svcs] of this.services){
      const owner=this.processes.get(pid);
      if(owner?.state!=="running"){this.stopSupervised(pid);continue;}
      let changed=true;
      while(changed){changed=false;for(const [name,s] of svcs){
        const pkg=this.packages.get(pid)?.get(name);
        if(s.phase==="running"&&(!this.serviceReady(pid,name)||!pkg||pkg.manifest.dependencies.some(d=>!this.serviceReady(pid,d)))){
          this.stopService(s,"blocked","runtime authority or dependency lost");changed=true;
        }
      }}
    }
  }
  executeInit(pid:string,op:InitOp,args:Record<string,unknown>,allocation?:string):QosResult<unknown>{
    const p=this.processes.get(pid);if(!p||p.state!=="running")return err("ENOENT","supervisor not running");
    const root=this.handle(p,args.handle as string);
    if(!root.ok)return root;
    if(root.value.id!==p.root||root.value.object!=="room"||
      (root.value.rights&(QOS_RIGHTS.GRANT|QOS_RIGHTS.EXEC))!==(QOS_RIGHTS.GRANT|QOS_RIGHTS.EXEC))return err("EACCES","supervisor root required");
    if(args.initVersion!==this.initVersion(pid))return err("EAGAIN","init registry changed");
    if(op==="pkg_list")return ok(this.initView(pid).packages);
    if(op==="svc_list")return ok(this.initView(pid).services);
    const name=args.name as string;
    if(op==="svc_status"){const s=this.services.get(pid)?.get(name);return s?ok({...s}):err("ENOENT","service absent");}
    const {packages,services}=this.initTables(pid);
    if(op==="pkg_install"){
      const signed=parsePackage(args.package),bindings=parseBindings(args.bindings);
      if(!signed||!bindings)return err("EINVAL","invalid package envelope");
      if(!verifyPackage(signed,args.publisher as string))return err("EACCES","signature or pinned publisher mismatch");
      const m=signed.manifest;
      if(packages.has(m.name)||packages.size>=MAX_PACKAGES)return err("EINVAL","package exists or registry full");
      if(bindings.length!==m.capabilities.length)return err("EACCES","exact capability bindings required");
      const pkg:InstalledPackage={id:packageIdentity(signed),manifest:m,signature:signed.signature,bindings};
      if(!this.packageAuthority(pid,pkg))return err("EACCES","ungranted package capability");
      packages.set(m.name,pkg);
      services.set(m.name,{id:serviceIdentity(pid,m.name),name:m.name,packageId:pkg.id,generation:0,pid:null,phase:"stopped",attempts:0,output:"",detail:"installed"});
      return ok({name:m.name,packageId:pkg.id,serviceId:services.get(m.name)!.id});
    }
    const start=(n:string,reset:boolean):QosResult<ServiceRecord>=>{
      const pkg=packages.get(n),s=services.get(n);
      if(!pkg||!s)return err("ENOENT","package absent");
      if(s.phase==="running")return ok({...s});
      if(reset)s.attempts=0;
      s.output="";
      if(pkg.manifest.dependencies.some(d=>!this.serviceReady(pid,d))){s.phase="blocked";s.detail="dependency not ready";return ok({...s});}
      if(!this.packageAuthority(pid,pkg)){s.phase="blocked";s.detail="capability unavailable";return ok({...s});}
      if(!allocation||s.generation>=1024)return err("EINVAL","service generation limit");
      s.generation++;s.attempts++;
      s.pid="svc:"+s.id+":"+s.generation+":"+allocation;
      const rh="h:svc:"+allocation+":"+s.id;
      const childRoot=this.makeHandle("service:image:"+pkg.id,QOS_RIGHTS.EXEC,root.value.id,rh);
      const child:QosProcess={pid:s.pid,name:n,owner:p.owner,parent:pid,state:"running",exitCode:null,root:rh,handles:new Map([[rh,childRoot]]),pending:[]};
      for(const c of pkg.manifest.capabilities){
        const b=pkg.bindings.find(b=>b.name===c.name)!,h=p.handles.get(b.handle)!;
        const grant=this.makeHandle(h.object,c.rights,h.id,rh+":"+c.name);child.handles.set(grant.id,grant);
      }
      this.processes.set(child.pid,child);
      const started=pkg.manifest.entrypoint.kind==="builtin"?runBuiltin(pkg.manifest.entrypoint.source):{code:127,output:""};
      s.output=started.output;s.phase="running";s.detail="ready";
      if(started.code||runBuiltin(pkg.manifest.health).code)this.stopService(s,"failed",started.code?"entrypoint failed or no authorized runtime":"health check failed");
      return ok({...s});
    };
    if(op==="svc_boot"){
      const names=parseBoot(args.manifest);if(!names)return err("EINVAL","invalid init manifest");
      const order:string[]=[],visited=new Set<string>(),visiting=new Set<string>(),cycles=new Set<string>();
      const visit=(n:string)=>{
        if(visiting.has(n)){for(const v of visiting)cycles.add(v);return;}
        if(visited.has(n))return;
        visiting.add(n);for(const dep of packages.get(n)?.manifest.dependencies??[])visit(dep);
        visiting.delete(n);visited.add(n);order.push(n);
      };
      for(const n of names)visit(n);
      const results=[];
      for(const n of order){
        const s=services.get(n);
        if(cycles.has(n)&&s){this.stopService(s,"blocked","dependency cycle");results.push({name:n,phase:s.phase,detail:s.detail});continue;}
        const r=start(n,true);results.push(r.ok?{name:n,phase:r.value.phase,detail:r.value.detail}:{name:n,phase:"missing",detail:r.detail});
      }
      return ok({order,results});
    }
    const s=services.get(name),pkg=packages.get(name);
    if(!s||!pkg)return err("ENOENT","service absent");
    if(op==="pkg_remove"){this.stopService(s);this.stopDependents(pid,name);services.delete(name);packages.delete(name);return ok({name,removed:true});}
    if(op==="svc_stop"){this.stopService(s);this.stopDependents(pid,name);return ok({...s});}
    if(op==="svc_start")return start(name,true);
    if(op==="svc_restart"){this.stopService(s);this.stopDependents(pid,name);return start(name,true);}
    if(op==="svc_health"){
      if(s.phase==="running"&&runBuiltin(pkg.manifest.health).code===0)return ok({...s});
      if(s.phase==="running"){this.stopService(s,"failed","health check failed");this.stopDependents(pid,name);}
      if(s.phase==="failed"&&pkg.manifest.restart==="on-failure"&&s.attempts<=MAX_RESTARTS)return start(name,false);
      return ok({...s});
    }
    return err("EINVAL","unknown init operation");
  }
  private devices=new Map<string,DeviceDescriptor>();
  private deviceTickets=new Map<string,DeviceTicket>();
  deviceDescriptor(id:string){const d=this.devices.get(id);return d?{...d}:null;}
  deviceTicket(id:string){const r=this.deviceTickets.get(id);return r?JSON.parse(JSON.stringify(r)) as DeviceTicket:null;}
  deviceSession(pid:string,handle:string){
    const p=this.processes.get(pid);if(!p||p.state!=="running")return null;
    const h=this.handle(p,handle);if(!h.ok||!h.value.object.startsWith("dev:")||!h.value.rights)return null;
    const d=this.devices.get(h.value.object.slice(4));if(!d)return null;
    return {descriptor:{...d},rights:h.value.rights,version:this.handleVersion(pid,handle)};
  }
  deviceAuthorized(pid:string,ticket:string){
    const t=this.deviceTickets.get(ticket);
    if(!t||t.pid!==pid||t.observation!==null)return false;
    const session=this.deviceSession(pid,t.handle);
    return !!session&&session.descriptor.id===t.device&&session.version===t.handleVersion&&(session.rights&deviceRight(t.request))===deviceRight(t.request);
  }
  recordDevice(op:QosCanonicalSyscallRequest["op"],outcome:QosResult<unknown>,hash:string){
    if(op==="dev_request"&&outcome.ok){
      const t=this.deviceTickets.get((outcome.value as {id:string}).id);if(t)t.version=hash;
    }
  }
  executeDevice(pid:string,op:DeviceOp,args:Record<string,unknown>,allocation?:string):QosResult<unknown>{
    const p=this.processes.get(pid);if(!p||p.state!=="running")return err("ENOENT","process not running");
    if(op==="dev_list"){
      const visible=[...p.handles.values()].filter(h=>!h.revoked&&(h.object.startsWith("dev:")||h.object.startsWith("devgrant:")));
      return ok(visible.sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0).map(h=>({handle:this.handleInfo(h),descriptor:this.deviceDescriptor(h.object.slice(h.object.indexOf(":")+1))})));
    }
    if(op==="dev_observe"){
      const t=this.deviceTickets.get(args.ticket as string);
      if(!t||t.pid!==pid)return err("EACCES","ticket not owned");
      if(t.observation!==null)return err("EINVAL","observation already committed");
      const observation=deviceObservation(args.observation,t.request);
      if(!observation)return err("EINVAL","invalid observation schema");
      if(observation.ok&&!this.deviceAuthorized(pid,t.id))return err("EACCES","device authority changed before observation");
      t.observation=observation;
      return ok({id:t.id,observation});
    }
    const h=this.handle(p,args.handle as string);if(!h.ok)return h;
    const id="h:device:"+allocation;
    if(op==="dev_define"){
      const kind=args.kind as DeviceKind,rights=args.rights as number;
      if(h.value.id!==p.root||(h.value.rights&(QOS_RIGHTS.GRANT|QOS_RIGHTS.REVOKE))!==(QOS_RIGHTS.GRANT|QOS_RIGHTS.REVOKE)||!allocation||this.devices.size>=DEVICE_MAX_DESCRIPTORS||
         !validRights(rights)||(rights&~deviceRights(kind))!==0||(rights&~h.value.rights)!==0||this.lineage.has(id))return err("EACCES","descriptor registration refused");
      // Logical descriptor registration is not a host resource grant. The
      // adapter must independently bind an explicitly selected resource.
      const d:DeviceDescriptor={id:allocation,kind,owner:p.owner,rights};
      this.devices.set(d.id,d);
      const grant=this.makeHandle("devgrant:"+d.id,rights|QOS_RIGHTS.GRANT|QOS_RIGHTS.REVOKE,h.value.id,id);
      p.handles.set(grant.id,grant);return ok({descriptor:d,handle:this.handleInfo(grant)});
    }
    if(op==="dev_close"){
      if(!h.value.object.startsWith("dev:"))return err("EINVAL","not a device session");
      return this.capClose(pid,h.value.id);
    }
    if(op==="dev_grant"||op==="dev_open"){
      if(!h.value.object.startsWith("devgrant:")||!allocation||this.lineage.has(id))return err("EACCES","explicit device grant required");
      const d=this.devices.get(h.value.object.slice(9)),rights=args.rights as number;
      if(!d||!validRights(rights)||(rights&~h.value.rights)!==0)return err("EACCES","device rights cannot widen");
      if(op==="dev_grant"){
        const target=this.processes.get(args.target as string);
        if(!target||target.state!=="running")return err("ENOENT","recipient unavailable");
        if(!(h.value.rights&QOS_RIGHTS.GRANT)||(rights&deviceRights(d.kind))===0||(rights&~(d.rights|QOS_RIGHTS.GRANT|QOS_RIGHTS.REVOKE))!==0)return err("EACCES","grant refused");
        const g=this.makeHandle(h.value.object,rights,h.value.id,id);target.handles.set(g.id,g);
        return ok(this.handleInfo(g));
      }
      if((rights&~d.rights)!==0)return err("EACCES","open rights exceed descriptor");
      const opened=this.makeHandle("dev:"+d.id,rights,h.value.id,id);p.handles.set(id,opened);
      return ok({descriptor:{...d},handle:this.handleInfo(opened)});
    }
    if(op!=="dev_request")return err("EINVAL","unsupported device operation");
    const session=this.deviceSession(pid,h.value.id);
    if(!session)return err("EACCES","open device session required");
    const request=deviceRequest(args.request,session.descriptor.kind);
    if(!request)return err("EINVAL","ioctl or device request outside ABI");
    if((session.rights&deviceRight(request))!==deviceRight(request))return err("EACCES","device right missing");
    if(!allocation||!session.version||this.deviceTickets.size>=DEVICE_MAX_REQUESTS||this.deviceTickets.has(allocation)||
      [...this.deviceTickets.values()].some(t=>t.handle===h.value.id&&t.observation===null))return err("EAGAIN","pending request or device journal limit");
    const t:DeviceTicket={id:allocation,pid,handle:h.value.id,handleVersion:session.version,device:session.descriptor.id,request,version:"",observation:null};
    this.deviceTickets.set(t.id,t);return ok({id:t.id,device:t.device,request:t.request});
  }
  private proxies=new Map<string,AuthorityProxy>();
  private proxyUses=new Map<string,Set<string>>();
  proxyObservedUses(token:string){return [...(this.proxyUses.get(token)??[])].sort();}
  proxyUseKnown(token:string,hash:string){return this.proxyUses.get(token)?.has(hash)??false;}
  handleFrontier(pid:string,root?:string){
    const p=this.processes.get(pid);
    if(!p)return [];
    const affected=new Set(root?[root]:[...p.handles.keys()]);
    if(root){
      let changed=true;while(changed){changed=false;for(const [id,parent] of this.lineage)if(parent&&affected.has(parent)&&!affected.has(id)){affected.add(id);changed=true;}}
    }
    return [...new Set([...affected].flatMap(id=>{const v=this.versions.get(id);return v?[v.hash]:[];}))].sort();
  }
  proxyVersion(token:string){return this.proxies.get(token)?.version;}
  proxyState(){return [...this.proxies.values()].sort((a,b)=>a.token<b.token?-1:a.token>b.token?1:0).map(p=>({...p}));}
  private proxyTarget(pid:string,handle:string,rights:number):QosResult<QosHandle>{
    const p=this.processes.get(pid);
    if(!p||p.state!=="running")return err("ENOENT","resource caretaker unavailable");
    const h=this.handle(p,handle);if(!h.ok)return h;
    const object=h.value.object;
    const ownSignalRevoker=object==="proc:"+pid&&rights===QOS_RIGHTS.SIGNAL&&
      (h.value.rights&(QOS_RIGHTS.SIGNAL|QOS_RIGHTS.REVOKE))===(QOS_RIGHTS.SIGNAL|QOS_RIGHTS.REVOKE);
    if((!(h.value.rights&QOS_RIGHTS.GRANT)&&!ownSignalRevoker)||(rights&~h.value.rights)!==0)return err("EACCES","target lacks grant or requested rights");
    const allowed=h.value.object.startsWith("fs:")?QOS_RIGHTS.READ|QOS_RIGHTS.WRITE:
      h.value.object.startsWith("mem:")?QOS_RIGHTS.READ:h.value.object.startsWith("proc:")?QOS_RIGHTS.SIGNAL:0;
    if(!rights||(rights&~allowed)!==0)return err("EACCES","unsupported proxy target or rights");
    return h;
  }
  proxyObservation(pid:string,token:string){
    const p=this.processes.get(pid),proxy=this.proxies.get(token);
    if(!p||!proxy||p.owner!==proxy.holder)return null;
    const owner=this.processes.get(proxy.ownerPid),h=owner?.handles.get(proxy.targetHandle);
    const n=h?.object.startsWith("fs:")?this.vfs.get(h.object.slice(3)):null;
    const target=h?.object.startsWith("proc:")?h.object.slice(5):null;
    return {proxyVersion:proxy.version,caretakerVersion:this.processVersion(proxy.ownerPid)??null,
      resourceVersion:this.handleVersion(proxy.ownerPid,proxy.targetHandle)??null,
      baseRoot:n?.root??null,rootVersion:n?.version??null,targetProcessVersion:target?this.processVersion(target)??null:null};
  }
  proxyReadDescriptor(pid:string,token:string,path:string,version:string):QosResult<MemoryObject>{
    const p=this.processes.get(pid),proxy=this.proxies.get(token);
    if(!p||p.state!=="running"||!proxy||proxy.holder!==p.owner||!proxy.enabled||proxy.version!==version||!(proxy.rights&QOS_RIGHTS.READ))
      return err("EACCES","proxy read not authorized");
    const target=this.proxyTarget(proxy.ownerPid,proxy.targetHandle,proxy.rights);if(!target.ok)return target;
    if(target.value.object.startsWith("mem:"))return this.memoryStat(proxy.ownerPid,target.value.id);
    if(!target.value.object.startsWith("fs:"))return err("EACCES","not a byte resource");
    const file=this.vfs.file(target.value.object.slice(3),path);if(!file.ok)return file;
    const meta=this.memory.stat(file.value);
    return meta?ok(meta):err("ENOENT","file metadata absent");
  }
  recordIdentity(op:QosCanonicalSyscallRequest["op"],outcome:QosResult<unknown>,eventHash:string,args:Record<string,unknown>){
    if(!outcome.ok)return;
    if(op==="proxy_create"||op==="proxy_set"){
      const p=this.proxies.get((outcome.value as {token:string}).token);if(p)p.version=eventHash;
    }else if(op==="proxy_use"&&["mkdir","unlink","put","signal"].includes(args.action as string)){
      const token=args.token as string;
      const uses=this.proxyUses.get(token)??new Set<string>();uses.add(eventHash);this.proxyUses.set(token,uses);
    }
  }
  executeIdentity(pid:string,op:IdentityOp,args:Record<string,unknown>,allocation?:string):QosResult<unknown>{
    const p=this.processes.get(pid);
    if(!p||p.state!=="running")return err("ENOENT","caller is not running");
    if(op==="id_info")return ok({uid:p.owner,pid,trust:"dyncap-tofu-continuity",superuser:false});
    if(op==="id_groups")return ok({verifiedGroups:[],status:"group quorum contract unavailable (#103)"});
    if(op==="group_action")return err("ENOTSUP","group actions require verified #103 membership snapshot and quorum");
    if(op==="id_cap")return ok([...p.handles.values()].sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0).map(h=>this.handleInfo(h)));
    if(op==="id_chmod"||op==="id_chown"){
      const h=this.handle(p,args.handle as string);if(!h.ok)return h;
      if(h.value.id===p.root||h.value.object==="room")return err("EACCES","process root is not transferable or chmod-able");
      if(!(h.value.rights&QOS_RIGHTS.REVOKE))return err("EACCES","handle requires REVOKE");
      if(op==="id_chmod"){
        const rights=args.rights as number;
        if(!validRights(rights)||(rights&~h.value.rights)!==0)return err("EACCES","cannot widen rights");
        const affected=new Set([h.value.id]);
        let changed=true;while(changed){changed=false;for(const [id,parent] of this.lineage)if(parent&&affected.has(parent)&&!affected.has(id)){affected.add(id);changed=true;}}
        for(const proc of this.processes.values())for(const [id,child] of proc.handles)if(affected.has(id)){
          const narrowed=child.rights&rights;
          proc.handles.set(id,{...child,rights:narrowed,revoked:child.revoked||narrowed===0});
        }
        return ok(this.handleInfo(p.handles.get(h.value.id)!));
      }
      const target=this.processes.get(args.target as string);
      if(!target||target.state!=="running")return err("ENOENT","recipient unavailable");
      if(target.pid===pid||!(h.value.rights&QOS_RIGHTS.GRANT)||!["fs:","mem:"].some(prefix=>h.value.object.startsWith(prefix)))return err("EACCES","transfer requires a grantable non-root resource handle");
      // Move exactly this handle (not object ownership or existing grants).
      // The ancestry remains intact; the former holder loses the handle.
      p.handles.delete(h.value.id);target.handles.set(h.value.id,h.value);
      return ok({handle:this.handleInfo(h.value),uid:target.owner,pid:target.pid});
    }
    if(op==="proxy_create"){
      if(!allocation||this.proxies.size>=MAX_PROXIES)return err("EINVAL","proxy quota or allocation");
      const rights=args.rights as number,holder=args.holder;
      if(!isUid(holder)||!validRights(rights))return err("EINVAL","invalid proxy holder or mask");
      const target=this.proxyTarget(pid,args.handle as string,rights);if(!target.ok)return target;
      const token="proxy:"+allocation;
      if(this.proxies.has(token))return err("EINVAL","proxy already allocated");
      this.proxies.set(token,{token,owner:p.owner,ownerPid:pid,targetHandle:target.value.id,holder,rights,ceiling:rights,enabled:true,version:""});
      // The holder receives only this indirection, never a raw target handle.
      return ok({token,holder,rights});
    }
    const token=args.token as string,proxy=this.proxies.get(token);
    if(!proxy)return err("ENOENT","proxy gone");
    if(proxy.version!==args.proxyVersion)return err("EAGAIN","proxy version changed");
    if(op==="proxy_set"){
      if(proxy.owner!==p.owner||proxy.ownerPid!==pid)return err("EACCES","only proxy caretaker can change proxy");
      const rights=args.rights as number;
      if(!validRights(rights)||(rights&~proxy.rights)!==0)return err("EACCES","proxy rights can only narrow");
      if(args.enabled===true){
        const target=this.proxyTarget(pid,args.handle as string,rights);if(!target.ok)return target;
      }
      if(args.enabled===true)proxy.targetHandle=args.handle as string;
      proxy.rights=rights;proxy.enabled=args.enabled as boolean;
      return ok({token,enabled:proxy.enabled,rights});
    }
    if(op!=="proxy_use")return err("EINVAL","unsupported identity operation");
    if(p.owner!==proxy.holder)return err("EACCES","proxy holder UID mismatch");
    if(!proxy.enabled)return err("EACCES","proxy revoked");
    const observation=this.proxyObservation(pid,token);
    if(!observation||Object.entries(observation).some(([key,value])=>args[key]!==value))return err("EAGAIN","resource observation changed");
    const target=this.proxyTarget(proxy.ownerPid,proxy.targetHandle,proxy.rights);if(!target.ok)return target;
    const action=args.action;
    if(["mkdir","unlink","put","signal"].includes(action as string)&&(this.proxyUses.get(token)?.size??0)>=4096)return err("EINVAL","proxy mutation history limit");
    if(action==="read")return this.proxyReadDescriptor(pid,token,args.path as string,proxy.version);
    if(action==="signal"){
      if(!(proxy.rights&QOS_RIGHTS.SIGNAL)||!target.value.object.startsWith("proc:"))return err("EACCES","proxy lacks SIGNAL");
      // Resource-side forwarding, not a copied handle. Never delegate KILL.
      if(args.signal==="SIGKILL")return err("EACCES","SIGKILL not forwarded by proxy");
      return this.signal(proxy.ownerPid,target.value.object.slice(5),args.signal as QosSignal,target.value.id);
    }
    if(target.value.object.startsWith("mem:")){
      if(action!=="stat"||!(proxy.rights&QOS_RIGHTS.READ))return err("EACCES","memory proxy supports metadata read only");
      return this.memoryStat(proxy.ownerPid,target.value.id);
    }
    if(!target.value.object.startsWith("fs:")||!(proxy.rights&QOS_RIGHTS.READ))return err("EACCES","namespace READ required");
    const namespace=target.value.object.slice(3),n=this.vfs.get(namespace);
    if(!n)return err("ENOENT","namespace absent");
    if(action==="stat"||action==="ls")return this.vfs.inspect(namespace,args.path as string,action==="ls");
    if(!(proxy.rights&QOS_RIGHTS.WRITE))return err("EACCES","proxy lacks WRITE");
    const vop=action==="mkdir"?"fs_mkdir":action==="unlink"?"fs_unlink":action==="put"?"fs_put":null;
    if(!vop)return err("EINVAL","unsupported proxy action");
    let id:string|undefined;
    if(action==="put"){
      const data=this.memoryStat(pid,args.dataHandle as string);
      if(!data.ok)return data;id=data.value.id;
    }
    const changed=this.vfs.mutate(namespace,n.root,n.version,vop,args.path as string,id);
    return changed.ok?ok({namespace,root:changed.value.root}):changed;
  }
  private shellContexts=new Map<string,ShellContext>();
  private shellJobs=new Map<string,ShellJob>();
  shellContext(pid:string):ShellContext {
    const c=this.shellContexts.get(pid)??newShellContext(this.processVersion(pid)??"");
    return {...c,env:{...c.env}};
  }
  shellJob(pid:string,handle:string):ShellJob|null{
    const p=this.processes.get(pid);
    if(!p)return null;
    const h=this.handle(p,handle);
    if(!h.ok||!(h.value.rights&QOS_RIGHTS.READ)||!h.value.object.startsWith("proc:"))return null;
    const j=this.shellJobs.get(h.value.object.slice(5));
    return j&&j.parent===pid?JSON.parse(JSON.stringify(j)) as ShellJob:null;
  }
  shellList(pid:string){
    const p=this.processes.get(pid);if(!p)return [];
    return [...p.handles.keys()].sort().flatMap(h=>{const j=this.shellJob(pid,h);return j&&j.handle===h?[{...j,state:this.getProcess(j.pid)?.state,exitCode:this.getProcess(j.pid)?.exitCode}]:[];});
  }
  private terminateShellChildren(pid:string){
    for(const j of this.shellJobs.values())if(j.parent===pid){
      const child=this.processes.get(j.pid);
      if(child&&(child.state==="running"||child.state==="suspended")){
        child.state="exited";child.exitCode=-15;child.handles.clear();
      }
    }
  }
  recordShell(pid:string,op:QosCanonicalSyscallRequest["op"],outcome:QosResult<unknown>,eventHash:string){
    if(!outcome.ok||!SHELL_OPS.includes(op as ShellOp))return;
    if(op==="sh_config"){
      const ctx=this.shellContexts.get(pid);if(ctx)ctx.version=eventHash;
    }else{
      const value=outcome.value as {pid?:string};
      const j=value.pid?this.shellJobs.get(value.pid):undefined;
      if(j)j.version=eventHash;
    }
  }
  executeShell(pid:string,op:ShellOp,args:Record<string,unknown>,allocation?:string):QosResult<unknown>{
    const p=this.processes.get(pid);
    if(!p||p.state!=="running")return err("ENOENT","shell parent is not running");
    const handle=args.handle as string,h=this.handle(p,handle);
    if(!h.ok)return h;
    const ctx=this.shellContext(pid);
    if(op==="sh_config"||op==="sh_spawn"){
      if(p.root!==handle)return err("EACCES","shell process root required");
      const needed=QOS_RIGHTS.READ|QOS_RIGHTS.EXEC|QOS_RIGHTS.GRANT|QOS_RIGHTS.SIGNAL|QOS_RIGHTS.REVOKE;
      if((h.value.rights&needed)!==needed)return err("EACCES","shell root lacks authority");
      if(ctx.version!==args.shellVersion)return err("EAGAIN","shell context changed");
      const namespaceHandle=args.namespaceHandle as string;
      const ns=this.fsHandle(pid,namespaceHandle,QOS_RIGHTS.READ);if(!ns.ok)return ns;
      const namespace=ns.value.object.slice(3),n=this.vfs.get(namespace);
      if(!n||n.root!==args.baseRoot||n.version!==args.rootVersion)return err("EAGAIN","namespace changed");
      let plan;try{plan=parsePipeline(args.source as string,ctx);}catch(e){return err("EINVAL",(e as Error).message);}
      const [command,...argv]=plan.stages[0];
      if(op==="sh_config"){
        if(plan.stages.length!==1||plan.input||plan.output||!CONFIG_COMMANDS.includes(command as typeof CONFIG_COMMANDS[number]))return err("EINVAL","standalone configuration command required");
        switch(command){
          case "cd":{
            if(argv.length!==1)return err("EINVAL","cd needs one path");
            let path:string;try{path=shellPath(ctx.cwd,argv[0]);}catch{return err("EACCES","path escapes shell root");}
            const info=this.vfs.inspect(namespace,path);
            if(!info.ok)return info;
            if((info.value as {kind:string}).kind==="file")return err("EINVAL","not a directory");
            ctx.cwd=path;break;
          }
          case "set":case "export":{
            if(argv.length!==1)return err("EINVAL","set NAME=value");
            const at=argv[0].indexOf("="),key=argv[0].slice(0,at),value=argv[0].slice(at+1);
            if(at<1||!shellVariable(key)||!boundedText(value)||new TextEncoder().encode(value).length>256)return err("EINVAL","invalid environment assignment");
            if(!Object.hasOwn(ctx.env,key)&&Object.keys(ctx.env).length>=16)return err("EINVAL","environment limit");
            ctx.env[key]=value;break;
          }
          case "unset":
            if(argv.length!==1||!shellVariable(argv[0]))return err("EINVAL","unset needs one variable");
            delete ctx.env[argv[0]];break;
          case "exit":{
            const code=argv.length===0?0:Number(argv[0]);
            if(argv.length>1||!Number.isInteger(code)||code<0||code>255)return err("EINVAL","exit code must be 0..255");
            const done=this.exit(pid,code);if(!done.ok)return done;break;
          }
        }
        this.shellContexts.set(pid,ctx);return ok({cwd:ctx.cwd,env:{...ctx.env}});
      }
      if(!allocation||[...this.shellJobs.values()].filter(j=>j.parent===pid).length>=SHELL_MAX_JOBS)return err("EINVAL","job allocation or quota");
      if(plan.stages.some(s=>CONFIG_COMMANDS.includes(s[0] as typeof CONFIG_COMMANDS[number])))return err("EINVAL","configuration commands cannot be piped or spawned");
      if(plan.output&&!this.fsCanPut(pid,namespaceHandle,plan.output.path))return err("EACCES","redirection destination is not writable");
      const checkInput=(path:string|null,text:unknown,readHandle:unknown,optional:boolean):QosResult<true>=>{
        if(!boundedText(text))return err("EINVAL","input exceeds text bound");
        if(path===null)return text===""&&readHandle===null?ok(true):err("EINVAL","unexpected input observation");
        const file=this.vfs.file(namespace,path);
        if(!file.ok)return optional&&file.errno==="ENOENT"&&text===""&&readHandle===null?ok(true):file;
        if(typeof readHandle!=="string")return err("EACCES","verified file handle required");
        const meta=this.memoryStat(pid,readHandle);
        return meta.ok&&meta.value.id===file.value&&meta.value.id===shellHash(text)&&meta.value.size===new TextEncoder().encode(text).length
          ?ok(true):err("EACCES","input content does not match authorized file object");
      };
      const input=checkInput(plan.input,args.input,args.inputHandle,false);if(!input.ok)return input;
      const append=checkInput(plan.output?.append?plan.output.path:null,args.append,args.appendHandle,true);if(!append.ok)return append;
      const childPid="job:"+allocation,jobHandle="h:job:"+allocation,childRoot="h:job-root:"+allocation;
      if(this.processes.has(childPid)||this.lineage.has(jobHandle)||this.lineage.has(childRoot))return err("EINVAL","job already allocated");
      const root=this.makeHandle("shell:image",QOS_RIGHTS.EXEC,handle,childRoot);
      const control=this.makeHandle("proc:"+childPid,QOS_RIGHTS.READ|QOS_RIGHTS.EXEC|QOS_RIGHTS.SIGNAL|QOS_RIGHTS.REVOKE,handle,jobHandle);
      const child:QosProcess={pid:childPid,name:command,owner:p.owner,parent:pid,state:"suspended",exitCode:null,root:root.id,handles:new Map([[root.id,root]]),pending:[]};
      p.handles.set(control.id,control);this.processes.set(childPid,child);
      const job:ShellJob={id:allocation,parent:pid,pid:childPid,handle:control.id,namespace,namespaceHandle,baseRoot:n.root,rootVersion:n.version,
        plan,context:ctx,mode:"queued",stage:0,statuses:[],output:args.input as string,append:args.append as string,version:""};
      this.shellJobs.set(childPid,job);return ok({pid:childPid,handle:this.handleInfo(control),stages:plan.stages.length});
    }
    const j=h.value.object.startsWith("proc:")?this.shellJobs.get(h.value.object.slice(5)):undefined;
    if(!j||j.parent!==pid||j.version!==args.jobVersion)return err("EACCES","job capability or version missing");
    const child=this.processes.get(j.pid);
    if(!child)return err("ENOENT","job process absent");
    if(op==="sh_wait"){
      if(!(h.value.rights&QOS_RIGHTS.READ))return err("EACCES","job handle lacks READ");
      const result=this.wait(pid,j.pid);return result.ok?ok({pid:j.pid,exitCode:result.value}):result;
    }
    if((h.value.rights&QOS_RIGHTS.EXEC)===0)return err("EACCES","job handle lacks EXEC");
    if(op==="sh_control"){
      if(!(h.value.rights&QOS_RIGHTS.SIGNAL))return err("EACCES","job handle lacks SIGNAL");
      if(child.state!=="running"&&child.state!=="suspended")return err("EINVAL","job already complete");
      const mode=args.mode as ShellJob["mode"];j.mode=mode;
      child.state=mode==="queued"?"suspended":"running";
      return ok({pid:j.pid,mode});
    }
    if(child.state!=="running")return err("EAGAIN","job is not running");
    if(op==="sh_step"){
      if(j.stage>=j.plan.stages.length)return err("EINVAL","all stages complete; finish required");
      const result=stageResult(j.plan.stages[j.stage],j.output,j.context);
      j.stage++;j.statuses.push(result.code);j.output=result.output;
      return ok({pid:j.pid,stage:j.stage,code:result.code,output:result.output});
    }
    if(op!=="sh_finish"||j.stage!==j.plan.stages.length)return err("EAGAIN","pipeline not complete");
    let code=j.statuses.find(c=>c!==0)??0,detail="completed";
    const output=j.append+j.output;
    if(j.plan.output){
      const d=parseDescriptor(args.descriptor);
      const authority=this.fsHandle(pid,j.namespaceHandle,QOS_RIGHTS.READ|QOS_RIGHTS.WRITE);
      const n=this.vfs.get(j.namespace);
      if(!boundedText(output)||!d||d.locator!==null||d.id!==shellHash(output)||d.size!==new TextEncoder().encode(output).length){code=74;detail="redirection output unavailable or invalid";}
      else if(!authority.ok||authority.value.object!=="fs:"+j.namespace){code=13;detail="namespace right lost";}
      else if(!n||n.root!==j.baseRoot||n.version!==j.rootVersion){code=11;detail="redirection root conflict";}
      else if(this.memory.stat(d.id)&&this.memory.stat(d.id)!.size!==d.size){code=74;detail="content metadata conflict";}
      else{
        const changed=this.vfs.mutate(j.namespace,j.baseRoot,j.rootVersion,"fs_put",j.plan.output.path,d.id);
        if(!changed.ok){code=13;detail=changed.detail;}
        else{
          this.memory.put(d);
          // Root stamp is applied after the verified result, not supplied by caller.
          detail="redirected";
        }
      }
    }else if(args.descriptor!==null)return err("EINVAL","unexpected redirection descriptor");
    const done=this.exit(j.pid,code);if(!done.ok)return done;
    return ok({pid:j.pid,exitCode:code,detail,namespace:detail==="redirected"?j.namespace:null,output:j.plan.output?null:j.output,statuses:[...j.statuses]});
  }


  private fsHandle(pid:string,id:string,right:number):QosResult<QosHandle>{
    const p=this.processes.get(pid);
    if(!p||p.state!=="running")return err("ENOENT","caller is not running");
    const h=this.handle(p,id);if(!h.ok)return h;
    if(!h.value.object.startsWith("fs:")||(h.value.rights&right)!==right)return err("EACCES","namespace capability or right missing");
    return h;
  }
  fsVersion(pid:string,handle:string){
    const h=this.fsHandle(pid,handle,QOS_RIGHTS.READ);
    if(!h.ok)return null;
    const n=this.vfs.get(h.value.object.slice(3));
    return n?{root:n.root,version:n.version}:null;
  }
  fsState(){return this.vfs.state();}
  fsCanPut(pid:string,handle:string,path:string){
    const h=this.fsHandle(pid,handle,QOS_RIGHTS.READ|QOS_RIGHTS.WRITE);
    if(!h.ok)return false;
    const id=h.value.object.slice(3),n=this.vfs.get(id);
    return !!n&&this.vfs.clone().mutate(id,n.root,n.version,"fs_put",path,"0".repeat(64)).ok;
  }
  recordVfs(op:QosCanonicalSyscallRequest["op"],outcome:QosResult<unknown>,eventHash:string){
    if(!outcome.ok)return;
    if(op==="sh_finish"||op==="proxy_use"){
      const namespace=(outcome.value as {namespace?:string|null})?.namespace;
      if(namespace)this.vfs.stamp(namespace,eventHash);
      return;
    }
    if(!["fs_init","fs_put","fs_mkdir","fs_unlink","fs_rename","fs_mount","fs_unmount"].includes(op))return;
    const v=outcome.value as {namespace:string};
    this.vfs.stamp(v.namespace,eventHash);
  }
  executeVfs(pid:string,op:VfsOp,args:Record<string,unknown>,allocation?:string):QosResult<unknown>{
    const p=this.processes.get(pid);
    if(!p||p.state!=="running")return err("ENOENT","caller is not running");
    const handle=args.handle as string, allocated=`h:vfs:${allocation}`;
    const all=QOS_RIGHTS.READ|QOS_RIGHTS.WRITE|QOS_RIGHTS.GRANT|QOS_RIGHTS.REVOKE;
    if(op==="fs_init"){
      if(!allocation||p.root!==handle)return err("EACCES","process root required");
      const h=this.handle(p,handle);if(!h.ok)return h;
      if((h.value.rights&all)!==all||this.lineage.has(allocated))return err("EACCES","namespace creation denied");
      const n=this.vfs.create(allocation);if(!n.ok)return n;
      const opened=this.makeHandle("fs:"+allocation,all,handle,allocated);p.handles.set(opened.id,opened);
      return ok({namespace:allocation,root:n.value.root,handle:this.handleInfo(opened)});
    }
    const mutation=["fs_put","fs_mkdir","fs_unlink","fs_rename","fs_mount","fs_unmount"].includes(op);
    const h=this.fsHandle(pid,handle,QOS_RIGHTS.READ|(mutation?QOS_RIGHTS.WRITE:0));
    if(!h.ok)return h;
    const namespace=h.value.object.slice(3),n=this.vfs.get(namespace);
    if(!n)return err("ENOENT","namespace absent");
    if(n.root!==args.baseRoot||n.version!==args.rootVersion)return err("EAGAIN","namespace base root/version conflict");
    const path=args.path as string;
    if(op==="fs_stat"||op==="fs_ls")return this.vfs.inspect(namespace,path,op==="fs_ls");
    if(op==="fs_open"){
      const file=this.vfs.file(namespace,path);if(!file.ok)return file;
      if(!allocation||this.lineage.has(allocated)||!this.memory.stat(file.value))return err("EINVAL","file object or allocation invalid");
      // Open returns a read-only immutable byte handle; writing is a COW namespace mutation.
      const opened=this.makeHandle("mem:"+file.value,QOS_RIGHTS.READ,handle,allocated);p.handles.set(opened.id,opened);
      return ok(this.handleInfo(opened));
    }
    if(op==="fs_grant"){
      const rights=args.rights as number,recipient=this.processes.get(args.target as string);
      if(!recipient||recipient.state!=="running")return err("ENOENT","recipient not running");
      if(!allocation||this.lineage.has(allocated)||!validRights(rights)||!(rights&QOS_RIGHTS.READ)||
        (rights&~all)!==0||!(h.value.rights&QOS_RIGHTS.GRANT)||(rights&~h.value.rights)!==0)return err("EACCES","cannot grant requested namespace rights");
      const opened=this.makeHandle(h.value.object,rights,handle,allocated);recipient.handles.set(opened.id,opened);
      return ok(this.handleInfo(opened));
    }
    let extra=args.destination as string|undefined,source:string|undefined;
    if(op==="fs_put"){
      const file=this.memoryHandle(pid,args.targetHandle as string,QOS_RIGHTS.READ);
      if(!file.ok)return file;
      extra=file.value.object.slice(4);
      if(!this.memory.stat(extra))return err("ENOENT","file object absent");
    }
    if(op==="fs_mount"){
      const mount=this.fsHandle(pid,args.targetHandle as string,QOS_RIGHTS.READ|QOS_RIGHTS.GRANT);
      if(!mount.ok)return mount;
      source=mount.value.object.slice(3);
      const src=this.vfs.get(source);
      if(!src||src.root!==args.sourceRoot||src.version!==args.sourceVersion)return err("EAGAIN","mount source version conflict");
    }
    const changed=this.vfs.mutate(namespace,n.root,n.version,op,path,extra,source);
    return changed.ok?ok({namespace,root:changed.value.root}):changed;
  }

  private memoryRoots(): string[] {
    const roots = new Set<string>();
    for (const p of this.processes.values()) for (const h of p.handles.values())
      if (!h.revoked && h.object.startsWith("mem:")) roots.add(h.object.slice(4));
      else if(!h.revoked&&h.object.startsWith("fs:"))for(const id of this.vfs.fileIds(h.object.slice(3)))roots.add(id);
    return [...roots].sort();
  }
  memoryView() { return this.memory.state(this.memoryRoots()); }
  memoryFrontier(): string[] { return this.memory.frontier(); }
  recordMemory(before: string, eventHash:string, operation?: MemoryOp):void {
    if (operation && operation !== "mem_get" && operation !== "mem_stat") this.memory.commit(eventHash);
    else if (before !== canonicalJson(this.memoryRoots())) this.memory.observe(eventHash);
  }
  memoryRootSnapshot():string { return canonicalJson(this.memoryRoots()); }

  /** A put declares immutable content metadata; it does not certify byte availability. */
  memoryPut(pid:string, rootId:string, descriptor:ObjectDescriptor, allocation:string):QosResult<QosHandleInfo> {
    const caller=this.processes.get(pid);
    if (!caller || caller.state!=="running") return err("ENOENT","caller is not running");
    if (caller.root!==rootId) return err("EACCES","namespace root required");
    const root=this.handle(caller,rootId);
    if (!root.ok) return root;
    const rights=QOS_RIGHTS.READ|QOS_RIGHTS.WRITE|QOS_RIGHTS.GRANT|QOS_RIGHTS.REVOKE;
    if ((root.value.rights & rights)!==rights) return err("EACCES","root lacks memory rights");
    const id=`h:memory:${allocation}`;
    if (this.lineage.has(id)) return err("EINVAL","handle already allocated");
    const validated=parseDescriptor(descriptor);
    if (!validated || !this.memory.put(validated)) return err("EINVAL","invalid or conflicting content descriptor");
    const h=this.makeHandle("mem:"+descriptor.id,rights,rootId,id);
    caller.handles.set(h.id,h);
    return ok(this.handleInfo(h));
  }

  private memoryHandle(pid:string,id:string,right:number):QosResult<QosHandle> {
    const caller=this.processes.get(pid);
    if (!caller || caller.state!=="running") return err("ENOENT","caller is not running");
    const h=this.handle(caller,id);
    if(!h.ok)return h;
    if(!h.value.object.startsWith("mem:") || (h.value.rights & right)!==right) return err("EACCES","memory handle or right missing");
    return h;
  }
  memoryStat(pid:string,id:string):QosResult<MemoryObject> {
    const h=this.memoryHandle(pid,id,QOS_RIGHTS.READ);
    if(!h.ok)return h;
    const d=this.memory.stat(h.value.object.slice(4));
    return d?ok(d):err("ENOENT","object metadata absent");
  }
  memoryRef(pid:string,id:string,rights:number,allocation:string):QosResult<QosHandleInfo> {
    const h=this.memoryHandle(pid,id,QOS_RIGHTS.GRANT);
    return h.ok?this.capDerive(pid,id,rights,`h:memory:${allocation}`):h;
  }
  memoryDrop(pid:string,id:string):QosResult<true> {
    const h=this.memoryHandle(pid,id,0);
    return h.ok?this.capClose(pid,id):h;
  }
  memoryLink(pid:string,from:string,to:string,remove:boolean):QosResult<true> {
    const a=this.memoryHandle(pid,from,QOS_RIGHTS.WRITE),b=this.memoryHandle(pid,to,QOS_RIGHTS.READ);
    if(!a.ok)return a;if(!b.ok)return b;
    return this.memory.link(pid,a.value.object.slice(4),b.value.object.slice(4),remove)?ok(true):err("ENOENT","object metadata absent");
  }

  scheduleView(): ScheduleView { return this.scheduler.view(); }
  schedulerFrontier(): string[] { return this.scheduler.frontier(); }
  schedulerTurn(pid: string, op: SchedulerOp, amount?: number): QosResult<ScheduleView> {
    return this.scheduler.turn(pid, op, amount);
  }
  recordScheduler(eventHash: string, turn = false): void {
    const changed = this.scheduler.sync(this.list());
    if (turn) this.scheduler.commitTurn(eventHash);
    else if (changed) this.scheduler.observe(eventHash);
  }

  private nextPid = 1;
  private nextHandle = 1;
  // Closed handles are removed from the live table but their ancestry remains
  // part of the replay state; a close must not cut a revocation path.
  private readonly lineage = new Map<string, string | null>();
  // Version stamps are canonical event hashes, including tombstone versions.
  private readonly versions = new Map<string, { pid: string; hash: string }>();
  private readonly processVersions = new Map<string, string>();

  processVersion(pid: string): string | undefined { return this.processVersions.get(pid); }

  snapshotProcessState(): Map<string, string> {
    return new Map([...this.processes].map(([pid, p]) =>
      [pid, canonicalJson([p.state, p.exitCode, p.pending])]));
  }

  recordProcessVersions(before: Map<string, string>, eventHash: string): void {
    for (const [pid, value] of this.snapshotProcessState())
      if (before.get(pid) !== value) this.processVersions.set(pid, eventHash);
  }

  /** Do not expose another process's handle version through this lookup. */
  handleVersion(pid: string, handle: string): string | undefined {
    const version = this.versions.get(handle);
    return version?.pid === pid ? version.hash : undefined;
  }

  snapshotLiveHandles(): Map<string, { pid: string; revoked: boolean; rights:number }> {
    const out = new Map<string, { pid: string; revoked: boolean; rights:number }>();
    for (const p of this.processes.values()) for (const h of p.handles.values())
      out.set(h.id, { pid: p.pid, revoked: h.revoked, rights:h.rights });
    return out;
  }

  /** Stamp creations, closures and revocations only after verified replay. */
  recordHandleVersions(before: Map<string, { pid: string; revoked: boolean; rights:number }>, eventHash: string): void {
    const after = this.snapshotLiveHandles();
    for (const [id, current] of after) {
      const prior = before.get(id);
      if (!prior || prior.pid !== current.pid || prior.revoked !== current.revoked || prior.rights!==current.rights)
        this.versions.set(id, { pid: current.pid, hash: eventHash });
    }
    for (const [id, prior] of before) if (!after.has(id))
      this.versions.set(id, { pid: prior.pid, hash: eventHash });
  }

  /** Bootstrap a process. The caller supplies the owner identity; this is the
   *  equivalent of the room admitting the initial process, not a syscall. */
  createProcess(input: { name: string; owner: string; parent?: string | null; pid?: string; rootId?: string }): QosResult<QosProcessInfo> {
    const name = String(input.name ?? "").trim();
    const owner = String(input.owner ?? "").trim();
    if (!name || !owner) return err("EINVAL", "name and owner are required");

    let parent: string | null = input.parent ?? null;
    if (parent !== null) {
      const p = this.processes.get(parent);
      if (!p || p.state !== "running") return err("ENOENT", "parent process is not running");
    }

    const pid = input.pid ?? this.allocatePid();
    if (this.processes.has(pid)) return err("EINVAL", "pid already exists");

    if (input.rootId !== undefined && this.lineage.has(input.rootId)) return err("EINVAL", "handle ID already allocated");
    const rootHandle = this.makeHandle("room", QOS_ALL_RIGHTS, null, input.rootId);
    const proc: QosProcess = {
      pid, name, owner, parent, state: "running", exitCode: null, root: rootHandle.id, handles: new Map(), pending: [],
    };
    proc.handles.set(rootHandle.id, rootHandle);
    this.processes.set(pid, proc);
    return ok(this.info(proc));
  }

  getpid(pid: string): QosResult<string> {
    const p = this.processes.get(pid);
    return p ? ok(p.pid) : err("ENOENT");
  }

  getppid(pid: string): QosResult<string | null> {
    const p = this.processes.get(pid);
    return p ? ok(p.parent) : err("ENOENT");
  }

  /** Spawn a child from an executable image handle. Requires EXEC + GRANT. */
  spawn(callerPid: string, imageHandleId: string, name: string): QosResult<QosProcessInfo> {
    const caller = this.processes.get(callerPid);
    if (!caller || caller.state !== "running") return err("ENOENT", "caller is not running");
    const image = this.handle(caller, imageHandleId);
    if (!image.ok) return image;
    if (!(image.value.rights & QOS_RIGHTS.EXEC)) return err("EACCES", "image lacks EXEC");
    if (!(image.value.rights & QOS_RIGHTS.GRANT)) return err("EACCES", "image lacks GRANT");
    const label = String(name ?? "").trim();
    if (!label) return err("EINVAL", "name is required");

    const pid = this.allocatePid();
    // The child's root is a derived image capability, never broader than the image.
    const rootHandle = this.makeHandle(image.value.object, image.value.rights, image.value.id);
    const child: QosProcess = {
      pid, name: label, owner: caller.owner, parent: caller.pid,
      state: "running", exitCode: null, root: rootHandle.id, handles: new Map(), pending: [],
    };
    child.handles.set(rootHandle.id, rootHandle);
    this.processes.set(pid, child);
    return ok(this.info(child));
  }

  /** Open a new object handle under a parent handle (default: the root). */
  open(callerPid: string, object: string, rights: number, parentHandleId?: string): QosResult<QosHandleInfo> {
    const caller = this.processes.get(callerPid);
    if (!caller || caller.state !== "running") return err("ENOENT", "caller is not running");
    const obj = String(object ?? "").trim();
    if (!obj) return err("EINVAL", "object is required");
    if (!validRights(rights)) return err("EINVAL", "rights must be a non-empty known mask");
    const parent = this.handle(caller, parentHandleId ?? caller.root);
    if (!parent.ok) return parent;
    if (!(parent.value.rights & QOS_RIGHTS.GRANT)) return err("EACCES", "parent lacks GRANT");
    if ((rights & ~parent.value.rights) !== 0) return err("EACCES", "cannot widen rights");

    const h = this.makeHandle(obj, rights, parent.value.id);
    caller.handles.set(h.id, h);
    return ok(this.handleInfo(h));
  }

  /** Derive a narrower handle from an existing one. */
  capDerive(callerPid: string, handleId: string, rights: number, allocatedId?: string): QosResult<QosHandleInfo> {
    const caller = this.processes.get(callerPid);
    if (!caller || caller.state !== "running") return err("ENOENT", "caller is not running");
    if (!validRights(rights)) return err("EINVAL", "rights must be a non-empty known mask");
    const parent = this.handle(caller, handleId);
    if (!parent.ok) return parent;
    if (parent.value.object.startsWith("dev:") || !(parent.value.rights & QOS_RIGHTS.GRANT)) return err("EACCES", "handle lacks GRANT or is an open device session");
    if ((rights & ~parent.value.rights) !== 0) return err("EACCES", "cannot widen rights");
    if (allocatedId !== undefined && this.lineage.has(allocatedId)) return err("EINVAL", "handle ID already allocated");
    const h = this.makeHandle(parent.value.object, rights, parent.value.id, allocatedId);
    caller.handles.set(h.id, h);
    return ok(this.handleInfo(h));
  }

  /** Close a non-root handle. A closed handle is `EBADF` forever. */
  capClose(callerPid: string, handleId: string): QosResult<true> {
    const caller = this.processes.get(callerPid);
    if (!caller || caller.state !== "running") return err("ENOENT", "caller is not running");
    if (handleId === caller.root) return err("EINVAL", "cannot close the root handle");
    const h = caller.handles.get(handleId);
    if (!h) return err("EBADF", "unknown handle");
    if (h.revoked) return err("EACCES", "handle is revoked");
    caller.handles.delete(handleId);
    return ok(true);
  }

  /** Revoke a handle and every descendant handle in every process table. */
  capRevoke(callerPid: string, handleId: string): QosResult<number> {
    const caller = this.processes.get(callerPid);
    if (!caller || caller.state !== "running") return err("ENOENT", "caller is not running");
    if (handleId === caller.root) return err("EINVAL", "cannot revoke the root handle");
    const target = caller.handles.get(handleId);
    if (!target) return err("EBADF", "unknown handle");
    if (target.revoked) return err("EACCES", "handle is revoked");
    if (!(target.rights & QOS_RIGHTS.REVOKE)) {
      return err("EACCES", "handle lacks REVOKE");
    }

    const children = new Map<string, string[]>();
    for (const [id, parent] of this.lineage) {
      if (parent === null) continue;
      const siblings = children.get(parent) ?? [];
      siblings.push(id);
      children.set(parent, siblings);
    }
    const affected = new Set<string>([handleId]);
    const queue = [handleId];
    for (let i = 0; i < queue.length; i++) {
      for (const child of children.get(queue[i]) ?? []) {
        if (!affected.has(child)) { affected.add(child); queue.push(child); }
      }
    }
    let count = 0;
    for (const proc of this.processes.values()) {
      for (const id of affected) {
        const h = proc.handles.get(id);
        if (h && !h.revoked) { h.revoked = true; count++; }
      }
    }
    return ok(count);
  }

  /** Apply a trusted, already-validated journal lifecycle transition during replay.
   * This is not a syscall: event admission and authority validation belong to QosEventLog.
   */
  replayLifecycle(pid: string, transition: "suspend" | "resume" | "terminate"): QosResult<true> {
    const target = this.processes.get(pid);
    if (!target) return err("ENOENT", "target does not exist");
    if (transition === "suspend") {
      if (target.state !== "running") return err("EINVAL", "target is not running");
      target.state = "suspended";
      this.reconcileInit();
      return ok(true);
    }
    if (transition === "resume") {
      if (target.state !== "suspended") return err("EINVAL", "target is not suspended");
      target.state = "running";
      return ok(true);
    }
    if (target.state !== "running" && target.state !== "suspended") return err("EINVAL", "target is not active");
    target.state = "exited";
    target.exitCode = 0;
    target.handles.clear();
    this.terminateShellChildren(pid);
    this.reconcileInit();
    return ok(true);
  }

  /** #325 reconciled with the canonical kernel: explicit target handle at
   * the syscall boundary; model-only callers may use their existing table. */
  suspend(callerPid:string,targetPid:string,explicitHandle?:string):QosResult<true>{
    return this.controlProcess(callerPid,targetPid,"suspend",explicitHandle);
  }
  resume(callerPid:string,targetPid:string,explicitHandle?:string):QosResult<true>{
    return this.controlProcess(callerPid,targetPid,"resume",explicitHandle);
  }
  private controlProcess(callerPid:string,targetPid:string,transition:"suspend"|"resume",explicitHandle?:string):QosResult<true>{
    const caller=this.processes.get(callerPid),target=this.processes.get(targetPid);
    if(!caller||caller.state!=="running"||!target)return err("ENOENT","caller or target unavailable");
    if(callerPid===targetPid)return err("EINVAL","cannot control self through another process handle");
    const candidates=explicitHandle===undefined?[...caller.handles.values()]:[caller.handles.get(explicitHandle)];
    if(!candidates.some(h=>h&&!h.revoked&&(h.rights&QOS_RIGHTS.SIGNAL)&&h.object==="proc:"+targetPid))return err("EACCES","no SIGNAL handle for target");
    // Queued shell processes must be activated by sh_control, which also
    // records job mode. Do not bypass the shell's start boundary.
    if(transition==="resume"&&this.shellJobs.get(targetPid)?.mode==="queued")return err("EINVAL","queued shell job requires sh_control");
    return this.replayLifecycle(targetPid,transition);
  }

  /** Target-owner consent: grant only SIGNAL over oneself, with a revoker
   * retained by the target. No generic room-root open is exposed by replay. */
  grantSignal(targetPid: string, rootId: string, recipientPid: string, allocation: string): QosResult<{ revoker: QosHandleInfo; handle: QosHandleInfo }> {
    const target = this.processes.get(targetPid), recipient = this.processes.get(recipientPid);
    if (!target || target.state !== "running" || !recipient || recipient.state !== "running")
      return err("ENOENT", "grant requires two running processes");
    if (targetPid === recipientPid) return err("EINVAL", "recipient must be another process");
    if (target.root !== rootId) return err("EACCES", "target root required");
    const root = this.handle(target, rootId);
    if (!root.ok) return root;
    if ((root.value.rights & (QOS_RIGHTS.GRANT | QOS_RIGHTS.SIGNAL | QOS_RIGHTS.REVOKE)) !==
        (QOS_RIGHTS.GRANT | QOS_RIGHTS.SIGNAL | QOS_RIGHTS.REVOKE))
      return err("EACCES", "root lacks grant authority");
    const revokerId = `h:signal-revoker:${allocation}`, handleId = `h:signal:${allocation}`;
    if (this.lineage.has(revokerId) || this.lineage.has(handleId)) return err("EINVAL", "grant already allocated");
    const object = `proc:${targetPid}`;
    const revoker = this.makeHandle(object, QOS_RIGHTS.SIGNAL | QOS_RIGHTS.REVOKE, rootId, revokerId);
    const handle = this.makeHandle(object, QOS_RIGHTS.SIGNAL, revoker.id, handleId);
    target.handles.set(revoker.id, revoker);
    recipient.handles.set(handle.id, handle);
    return ok({ revoker: this.handleInfo(revoker), handle: this.handleInfo(handle) });
  }

  /** Send a signal. Self-signalling is allowed; another process requires a
   *  live handle to `proc:<target>` carrying SIGNAL. */
  signal(callerPid: string, targetPid: string, sig: QosSignal, explicitHandle?: string): QosResult<true> {
    const caller = this.processes.get(callerPid);
    if (!caller || caller.state !== "running") return err("ENOENT", "caller is not running");
    const target = this.processes.get(targetPid);
    if (!target) return err("ENOENT", "target does not exist");
    if (target.state !== "running" && target.state !== "suspended") return err("EINVAL", "target is not active");
    if (!QOS_SIGNALS.includes(sig)) return err("EINVAL", "unknown signal");
    if (sig === "SIGKILL" && caller.owner !== target.owner) return err("EACCES", "SIGKILL is target-owner only");

    if (callerPid === targetPid && explicitHandle !== undefined) {
      const h = this.handle(caller, explicitHandle);
      if (!h.ok || !(h.value.rights & QOS_RIGHTS.SIGNAL)) return err("EACCES", "self signal requires live SIGNAL authority");
    }
    if (callerPid !== targetPid) {
      const candidates = explicitHandle === undefined ? [...caller.handles.values()] : [caller.handles.get(explicitHandle)];
      const hasSignal = candidates.some(
        (h) => h && !h.revoked && (h.rights & QOS_RIGHTS.SIGNAL) && h.object === `proc:${targetPid}`,
      );
      if (!hasSignal) return err("EACCES", "no SIGNAL handle for target");
    }

    target.pending.push(sig);
    if (sig !== "SIGCHLD") {
      target.state = "exited";
      target.exitCode = signalExitCode(sig);
      target.handles.clear();
      this.terminateShellChildren(targetPid);
    }
    return ok(true);
  }

  /** Wait for a direct child. Running → EAGAIN; already reaped → ENOENT. */
  wait(callerPid: string, childPid: string): QosResult<number> {
    const caller = this.processes.get(callerPid);
    if (!caller || caller.state !== "running") return err("ENOENT", "caller is not running");
    const child = this.processes.get(childPid);
    if (!child) return err("ENOENT", "child does not exist");
    if (child.parent !== callerPid) return err("EACCES", "not the parent");
    if (child.state === "reaped") return err("ENOENT", "child already reaped");
    if (child.state === "running" || child.state === "suspended") return err("EAGAIN", "child still active");
    const code = child.exitCode ?? 0;
    child.state = "reaped";
    child.handles.clear();
    return ok(code);
  }

  /** Exit the caller. Its handles do not outlive it. */
  exit(callerPid: string, code = 0): QosResult<true> {
    const p = this.processes.get(callerPid);
    if (!p) return err("ENOENT", "process does not exist");
    if (p.state !== "running") return err("EINVAL", "process is not running");
    if (!Number.isInteger(code)) return err("EINVAL", "exit code must be an integer");
    p.state = "exited";
    p.exitCode = code;
    p.handles.clear();
    this.terminateShellChildren(callerPid);
    return ok(true);
  }

  getProcess(pid: string): QosProcessInfo | null {
    const p = this.processes.get(pid);
    return p ? this.info(p) : null;
  }

  list(): QosProcessInfo[] {
    return [...this.processes.values()].map((p) => this.info(p)).sort((a, b) => a.pid < b.pid ? -1 : a.pid > b.pid ? 1 : 0);
  }

  /** Copy every replay-relevant field, including allocation counters.
   * A speculative operation must never mutate the committed kernel. */
  cloneForReplay(): QosKernel {
    const copy = new QosKernel();
    copy.scheduler = this.scheduler.clone();
    copy.memory = this.memory.clone();
    copy.vfs = this.vfs.clone();
    copy.quotaCalls=new Map(this.quotaCalls);
    copy.packages=new Map([...this.packages].map(([pid,m])=>[pid,new Map([...m].map(([n,v])=>[n,JSON.parse(JSON.stringify(v)) as InstalledPackage]))]));
    copy.services=new Map([...this.services].map(([pid,m])=>[pid,new Map([...m].map(([n,v])=>[n,{...v}]))]));
    copy.initVersions=new Map(this.initVersions);
    copy.devices=new Map([...this.devices].map(([id,d])=>[id,{...d}]));
    copy.deviceTickets=new Map([...this.deviceTickets].map(([id,t])=>[id,JSON.parse(JSON.stringify(t)) as DeviceTicket]));
    copy.proxies=new Map([...this.proxies].map(([id,p])=>[id,{...p}]));
    copy.proxyUses=new Map([...this.proxyUses].map(([id,uses])=>[id,new Set(uses)]));
    copy.shellContexts=new Map([...this.shellContexts].map(([pid,c])=>[pid,{...c,env:{...c.env}}]));
    copy.shellJobs=new Map([...this.shellJobs].map(([pid,j])=>[pid,JSON.parse(JSON.stringify(j)) as ShellJob]));
    copy.nextPid = this.nextPid;
    copy.nextHandle = this.nextHandle;
    for (const [id, parent] of this.lineage) copy.lineage.set(id, parent);
    for (const [id, version] of this.versions) copy.versions.set(id, { ...version });
    for (const [pid, version] of this.processVersions) copy.processVersions.set(pid, version);
    for (const [pid, proc] of this.processes) {
      copy.processes.set(pid, {
        ...proc,
        pending: [...proc.pending],
        handles: new Map([...proc.handles].map(([id, handle]) => [id, { ...handle }])),
      });
    }
    return copy;
  }

  /** Canonical state used by the digest. Only stable, sorted data. */
  state(): Record<string, unknown> {
    return {
      abi: QOS_ABI_VERSION,
      quota:this.quotaView(),
      scheduler: this.scheduler.state(),
      memory: this.memoryView(),
      vfs: this.fsState(),
      init:[...new Set([...this.packages.keys(),...this.services.keys()])].sort().map(pid=>[pid,this.initView(pid)]),
      initVersions:[...this.initVersions.entries()].sort(([a],[b])=>a<b?-1:a>b?1:0),
      devices:[...this.devices.values()].sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0),
      deviceTickets:[...this.deviceTickets.values()].sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0),
      proxies:this.proxyState(),
      proxyUses:[...this.proxyUses.entries()].sort(([a],[b])=>a<b?-1:a>b?1:0).map(([id,uses])=>[id,[...uses].sort()]),
      shellContexts:[...this.shellContexts.entries()].sort(([a],[b])=>a<b?-1:a>b?1:0),
      shellJobs:[...this.shellJobs.values()].sort((a,b)=>a.pid<b.pid?-1:a.pid>b.pid?1:0),
      nextPid: this.nextPid,
      nextHandle: this.nextHandle,
      processVersions: [...this.processVersions.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0),
      versions: [...this.versions.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([id, v]) => [id, { ...v }]),
      lineage: [...this.lineage.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0),
      processes: [...this.processes.values()]
        .sort((a, b) => a.pid < b.pid ? -1 : a.pid > b.pid ? 1 : 0)
        .map((p) => ({
          pid: p.pid,
          name: p.name,
          owner: p.owner,
          parent: p.parent,
          state: p.state,
          exitCode: p.exitCode,
          root: p.root,
          pending: [...p.pending],
          handles: [...p.handles.values()]
            .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
            .map((h) => ({ id: h.id, object: h.object, rights: h.rights, parent: h.parent, revoked: h.revoked })),
        })),
    };
  }

  async stateDigest(): Promise<string> {
    return sha256Hex(canonicalJson(this.state()));
  }

  private allocatePid(): string {
    let pid: string;
    do { pid = `proc:${this.nextPid++}`; } while (this.processes.has(pid));
    return pid;
  }

  private makeHandle(object: string, rights: number, parent: string | null, stableId?: string): QosHandle {
    let id: string;
    if (stableId !== undefined) id = stableId;
    else { do { id = `h:${this.nextHandle++}`; } while (this.lineage.has(id)); }
    this.lineage.set(id, parent);
    return { id, object, rights, parent, revoked: false };
  }

  private handle(proc: QosProcess, id: string): QosResult<QosHandle> {
    const h = proc.handles.get(id);
    if (!h) return err("EBADF", "unknown handle");
    if (h.revoked) return err("EACCES", "handle is revoked");
    return ok(h);
  }

  private handleInfo(h: QosHandle): QosHandleInfo {
    return { id: h.id, object: h.object, rights: h.rights, parent: h.parent, revoked: h.revoked };
  }

  private info(p: QosProcess): QosProcessInfo {
    return {
      pid: p.pid,
      name: p.name,
      owner: p.owner,
      parent: p.parent,
      state: p.state,
      exitCode: p.exitCode,
      root: p.root,
      handles: [...p.handles.keys()].sort((a, b) => a < b ? -1 : a > b ? 1 : 0),
      pending: [...p.pending],
    };
  }
}

/** Embedded payload only; no independent syscall stream. */
export type QosCanonicalSyscallRequest = {
  schema: "qos.syscall/1";
  caller: string;
  op: "getpid" | "getppid" | "cap_derive" | "cap_close" | "cap_revoke" | "signal_grant" | "signal" | "proc_suspend" | "proc_resume" | SchedulerOp | MemoryOp | VfsOp | ShellOp | IdentityOp | DeviceOp | InitOp;
  args: Record<string, unknown>;
  observed?:string[];
};
export type QosCanonicalSyscallTrace = {
  requestHash: string;
  resultHash: string;
  caller: string;
  op: QosCanonicalSyscallRequest["op"];
  args: Record<string, unknown>;
  outcome: QosResult<unknown>;
  position: number;
};
function exactKeys(value: unknown, keys: string[]): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
function parseSyscallRequest(payload: Record<string, unknown>, pid: string): QosCanonicalSyscallRequest | null {
  const keys=["schema","caller","op","args"];
  if(Object.hasOwn(payload,"observed"))keys.push("observed");
  if (!exactKeys(payload,keys) || payload.schema !== "qos.syscall/1" || payload.caller !== pid) return null;
  if(keys.includes("observed")&&(!Array.isArray(payload.observed)||payload.observed.length>4096||
    !payload.observed.every((h,i,a)=>isObjectId(h)&&(i===0||a[i-1]<h))))return null;
  const args = payload.args;
  switch (payload.op) {
    case "getpid": case "getppid":
      if (!exactKeys(args, [])) return null;
      break;
    case "cap_close": case "cap_revoke":
    case "cap_derive": {
      const keys = payload.op === "cap_derive" ? ["handle", "rights"] : ["handle"];
      if (args && typeof args === "object" && Object.hasOwn(args, "handleVersion")) keys.push("handleVersion");
      if (!exactKeys(args, keys) || typeof args.handle !== "string") return null;
      if (keys.includes("handleVersion") && (typeof args.handleVersion !== "string" || !/^[0-9a-f]{64}$/.test(args.handleVersion))) return null;
      if (payload.op === "cap_derive" && (typeof args.rights !== "number" || !Number.isSafeInteger(args.rights))) return null;
      break;
    }
    case "proc_suspend":case "proc_resume":{
      const keys=["handle","target","targetVersion"];
      if(args&&typeof args==="object"&&Object.hasOwn(args,"handleVersion"))keys.push("handleVersion");
      if(!exactKeys(args,keys)||typeof args.handle!=="string"||typeof args.target!=="string"||!isObjectId(args.targetVersion)||
        (keys.includes("handleVersion")&&!isObjectId(args.handleVersion)))return null;
      break;
    }
    case "signal_grant":
    case "signal": {
      const keys = payload.op === "signal_grant"
        ? ["handle", "handleVersion", "target", "targetVersion"]
        : ["handle", "target", "targetVersion", "signal"];
      if (payload.op === "signal" && args && typeof args === "object" && Object.hasOwn(args, "handleVersion")) keys.push("handleVersion");
      if (!exactKeys(args, keys) || typeof args.handle !== "string" ||
          typeof args.target !== "string" || typeof args.targetVersion !== "string" ||
          !/^[0-9a-f]{64}$/.test(args.targetVersion)) return null;
      if (keys.includes("handleVersion") && (typeof args.handleVersion !== "string" || !/^[0-9a-f]{64}$/.test(args.handleVersion))) return null;
      if (payload.op === "signal" && !QOS_SIGNALS.includes(args.signal as QosSignal)) return null;
      break;
    }
    case "sched_step": case "yield": case "sleep": case "sched_priority": case "sched_wake": {
      const keys = ["scheduleFrontier"];
      if (payload.op === "sleep") keys.push("ticks");
      if (payload.op === "sched_priority") keys.push("priority");
      if (!exactKeys(args, keys) || !Array.isArray(args.scheduleFrontier) ||
          args.scheduleFrontier.length === 0 || args.scheduleFrontier.length > MAX_SCHEDULER_FRONTIER ||
          !args.scheduleFrontier.every((v,i,a) => typeof v === "string" && /^[0-9a-f]{64}$/.test(v) && (i === 0 || a[i-1] < v))) return null;
      if (payload.op === "sleep" && (typeof args.ticks !== "number" || !Number.isSafeInteger(args.ticks))) return null;
      if (payload.op === "sched_priority" && (typeof args.priority !== "number" || !Number.isSafeInteger(args.priority))) return null;
      break;
    }
    case "mem_put": case "mem_get": case "mem_stat": case "mem_ref": case "mem_drop": case "mem_link": case "mem_unlink": {
      const keys=["handle","memoryFrontier"];
      if(args && typeof args==="object" && Object.hasOwn(args,"handleVersion"))keys.push("handleVersion");
      if(payload.op==="mem_put")keys.push("descriptor");
      if(payload.op==="mem_ref")keys.push("rights");
      if(payload.op==="mem_link"||payload.op==="mem_unlink")keys.push("targetHandle","targetHandleVersion");
      if(!exactKeys(args,keys)||typeof args.handle!=="string"||
         !Array.isArray(args.memoryFrontier)||args.memoryFrontier.length>MAX_MEMORY_FRONTIER||
         !args.memoryFrontier.every((v,i,a)=>typeof v==="string"&&/^[0-9a-f]{64}$/.test(v)&&(i===0||a[i-1]<v)))return null;
      if(keys.includes("handleVersion")&&(typeof args.handleVersion!=="string"||!/^[0-9a-f]{64}$/.test(args.handleVersion)))return null;
      if(payload.op==="mem_put"&&!parseDescriptor(args.descriptor))return null;
      if(payload.op==="mem_ref"&&(typeof args.rights!=="number"||!Number.isSafeInteger(args.rights)))return null;
      if(keys.includes("targetHandle")&&(typeof args.targetHandle!=="string"||typeof args.targetHandleVersion!=="string"||!/^[0-9a-f]{64}$/.test(args.targetHandleVersion)))return null;
      break;
    }
    case "fs_init": case "fs_stat": case "fs_ls": case "fs_open": case "fs_put": case "fs_mkdir":
    case "fs_unlink": case "fs_rename": case "fs_mount": case "fs_unmount": case "fs_grant": {
      const keys=["handle"];
      if(args&&typeof args==="object"&&Object.hasOwn(args,"handleVersion"))keys.push("handleVersion");
      if(payload.op!=="fs_init")keys.push("baseRoot","rootVersion");
      if(payload.op!=="fs_init"&&payload.op!=="fs_grant")keys.push("path");
      if(payload.op==="fs_rename")keys.push("destination");
      if(payload.op==="fs_put"||payload.op==="fs_mount")keys.push("targetHandle","targetHandleVersion");
      if(payload.op==="fs_mount")keys.push("sourceRoot","sourceVersion");
      if(payload.op==="fs_grant")keys.push("target","targetVersion","rights");
      if(!exactKeys(args,keys)||typeof args.handle!=="string"||args.handle.length>256)return null;
      for(const k of ["handleVersion","baseRoot","rootVersion","targetVersion","targetHandleVersion","sourceRoot","sourceVersion"])
        if(keys.includes(k)&&!isObjectId(args[k]))return null;
      for(const k of ["path","destination","targetHandle","target"])
        if(keys.includes(k)&&(typeof args[k]!=="string"||(args[k] as string).length>1024))return null;
      if(keys.includes("rights")&&(typeof args.rights!=="number"||!Number.isSafeInteger(args.rights)))return null;
      break;
    }
    case "sh_config": case "sh_spawn": case "sh_control": case "sh_step": case "sh_finish": case "sh_wait": {
      const keys=["handle"];
      if(args&&typeof args==="object"&&Object.hasOwn(args,"handleVersion"))keys.push("handleVersion");
      const starting=payload.op==="sh_config"||payload.op==="sh_spawn";
      if(starting)keys.push("namespaceHandle","namespaceVersion","baseRoot","rootVersion","shellVersion","source");
      else keys.push("jobVersion","target","targetVersion");
      if(payload.op==="sh_spawn")keys.push("input","inputHandle","inputVersion","append","appendHandle","appendVersion");
      if(payload.op==="sh_control")keys.push("mode");
      if(payload.op==="sh_finish")keys.push("descriptor","memoryFrontier");
      if(!exactKeys(args,keys)||typeof args.handle!=="string"||args.handle.length>256)return null;
      for(const k of ["handleVersion","namespaceVersion","baseRoot","rootVersion","shellVersion","jobVersion","targetVersion"])
        if(keys.includes(k)&&!isObjectId(args[k]))return null;
      if(starting&&(typeof args.namespaceHandle!=="string"||args.namespaceHandle.length>256||!boundedText(args.source)))return null;
      if(!starting&&(typeof args.target!=="string"||args.target.length>256))return null;
      if(payload.op==="sh_spawn"){
        for(const name of ["input","append"]){
          if(!boundedText(args[name]))return null;
          const h=args[name+"Handle"],v=args[name+"Version"];
          if(h===null?v!==null:(typeof h!=="string"||h.length>256||!isObjectId(v)))return null;
        }
      }
      if(payload.op==="sh_control"&&!["queued","foreground","background"].includes(args.mode as string))return null;
      if(payload.op==="sh_finish"&&((args.descriptor!==null&&!parseDescriptor(args.descriptor))||
        !Array.isArray(args.memoryFrontier)||args.memoryFrontier.length>MAX_MEMORY_FRONTIER||
        !args.memoryFrontier.every((v,i,a)=>isObjectId(v)&&(i===0||a[i-1]<v))))return null;
      break;
    }
    case "id_info":case "id_groups":case "group_action":
      if(!exactKeys(args,[]))return null;break;
    case "id_cap":
      if(!exactKeys(args,["authorityFrontier"])||!Array.isArray(args.authorityFrontier)||args.authorityFrontier.length>4096||
          !args.authorityFrontier.every((v,i,a)=>isObjectId(v)&&(i===0||a[i-1]<v)))return null;
      break;
    case "id_chmod":case "id_chown":case "proxy_create":case "proxy_set":{
      const disabled=payload.op==="proxy_set"&&!!args&&typeof args==="object"&&(args as Record<string,unknown>).enabled===false;
      const keys=disabled?[]:["handle","handleVersion"];
      if(payload.op==="id_chmod")keys.push("rights","authorityFrontier");
      if(payload.op==="id_chown")keys.push("target","targetVersion");
      if(payload.op==="proxy_create")keys.push("rights","holder");
      if(payload.op==="proxy_set")keys.push("rights","token","proxyVersion","enabled","observedUses");
      if(!exactKeys(args,keys)||(!disabled&&(typeof args.handle!=="string"||args.handle.length>256||!isObjectId(args.handleVersion))))return null;
      if(keys.includes("rights")&&(typeof args.rights!=="number"||!validRights(args.rights)))return null;
      if(payload.op==="id_chown"&&(typeof args.target!=="string"||args.target.length>256||!isObjectId(args.targetVersion)))return null;
      if(payload.op==="proxy_create"&&!isUid(args.holder))return null;
      if(payload.op==="proxy_set"&&(!isProxyToken(args.token)||!isObjectId(args.proxyVersion)||typeof args.enabled!=="boolean"))return null;
      for(const key of ["authorityFrontier","observedUses"]){
        if(keys.includes(key)&&(!Array.isArray(args[key])||args[key].length>4096||!args[key].every((v,i,a)=>isObjectId(v)&&(i===0||a[i-1]<v))))return null;
      }
      break;
    }
    case "proxy_use":{
      const keys=["token","action","proxyVersion","caretakerVersion","resourceVersion","baseRoot","rootVersion","targetProcessVersion"];
      if(!args||typeof args!=="object"||Array.isArray(args))return null;
      const a=args as Record<string,unknown>;
      if(a.action==="signal")keys.push("signal");
      else keys.push("path");
      if(a.action==="put")keys.push("dataHandle","dataVersion");
      if(!exactKeys(args,keys)||!isProxyToken(args.token)||!PROXY_ACTIONS.includes(args.action as typeof PROXY_ACTIONS[number])||!isObjectId(args.proxyVersion))return null;
      for(const key of ["caretakerVersion","resourceVersion","baseRoot","rootVersion","targetProcessVersion"])
        if(args[key]!==null&&!isObjectId(args[key]))return null;
      if(keys.includes("path")&&(typeof args.path!=="string"||args.path.length>1024))return null;
      if(keys.includes("signal")&&!QOS_SIGNALS.includes(args.signal as QosSignal))return null;
      if(keys.includes("dataHandle")&&(typeof args.dataHandle!=="string"||args.dataHandle.length>256||!isObjectId(args.dataVersion)))return null;
      break;
    }
    case "dev_list":
      if(!exactKeys(args,["authorityFrontier"])||!Array.isArray(args.authorityFrontier)||args.authorityFrontier.length>4096||
        !args.authorityFrontier.every((v,i,a)=>isObjectId(v)&&(i===0||a[i-1]<v)))return null;
      break;
    case "dev_observe":
      if(!exactKeys(args,["ticket","ticketVersion","observation"])||!isObjectId(args.ticket)||!isObjectId(args.ticketVersion)||
        !args.observation||typeof args.observation!=="object")return null;
      // Strict request-specific observation validation is in executeDevice.
      if(JSON.stringify(args.observation).length>9000)return null;
      break;
    case "dev_define":case "dev_grant":case "dev_open":case "dev_close":case "dev_request":{
      const keys=["handle"];
      if(args&&typeof args==="object"&&Object.hasOwn(args,"handleVersion"))keys.push("handleVersion");
      if(["dev_define","dev_grant","dev_open"].includes(payload.op))keys.push("rights");
      if(payload.op==="dev_define")keys.push("kind");
      if(payload.op==="dev_grant")keys.push("target","targetVersion");
      if(payload.op==="dev_request")keys.push("request");
      if(!exactKeys(args,keys)||typeof args.handle!=="string"||args.handle.length>256)return null;
      if(keys.includes("handleVersion")&&!isObjectId(args.handleVersion))return null;
      if(keys.includes("rights")&&(typeof args.rights!=="number"||!validRights(args.rights)))return null;
      if(payload.op==="dev_define"&&!DEVICE_KINDS.includes(args.kind as DeviceKind))return null;
      if(payload.op==="dev_grant"&&(typeof args.target!=="string"||args.target.length>256||!isObjectId(args.targetVersion)))return null;
      if(payload.op==="dev_request"&&!deviceRequest(args.request))return null;
      break;
    }
    case "pkg_install":case "pkg_list":case "pkg_remove":case "svc_boot":case "svc_list":case "svc_status":case "svc_start":case "svc_stop":case "svc_restart":case "svc_health":{
      const keys=["handle","handleVersion","initVersion","authorityFrontier"];
      if(payload.op==="pkg_install")keys.push("package","publisher","bindings");
      else if(payload.op==="svc_boot")keys.push("manifest");
      else if(!["pkg_list","svc_list"].includes(payload.op))keys.push("name");
      if(!exactKeys(args,keys)||typeof args.handle!=="string"||args.handle.length>256||!isObjectId(args.handleVersion)||!isObjectId(args.initVersion)||
        !Array.isArray(args.authorityFrontier)||args.authorityFrontier.length>4096||!args.authorityFrontier.every((v,i,a)=>isObjectId(v)&&(i===0||a[i-1]<v)))return null;
      if(keys.includes("package")&&(!parsePackage(args.package)||!isObjectId(args.publisher)||!parseBindings(args.bindings)))return null;
      if(keys.includes("manifest")&&!parseBoot(args.manifest))return null;
      if(keys.includes("name")&&!packageName(args.name))return null;
      break;
    }
    default: return null;
  }
  return payload as QosCanonicalSyscallRequest;
}
function executeCanonicalSyscall(kernel: QosKernel, request: QosCanonicalSyscallRequest, requestHash?: string): QosResult<unknown> {
  const allowed=kernel.quotaBefore(request.caller,request.op);if(!allowed.ok)return allowed;
  const before=kernel.quotaView();
  const result=executeUnmeteredSyscall(kernel,request,requestHash);
  if(!result.ok)return result;
  const quota=kernel.quotaAfter(before,request.caller,request.op);
  return quota.ok?result:quota;
}
function executeUnmeteredSyscall(kernel: QosKernel, request: QosCanonicalSyscallRequest, requestHash?: string): QosResult<unknown> {
  const pid = request.caller;
  if (kernel.getProcess(pid)?.state !== "running") return err("ENOENT", "caller is not running");
  switch (request.op) {
    case "sched_step": case "yield": case "sched_wake": return kernel.schedulerTurn(pid, request.op);
    case "sleep": return kernel.schedulerTurn(pid, request.op, request.args.ticks as number);
    case "sched_priority": return kernel.schedulerTurn(pid, request.op, request.args.priority as number);
    case "mem_put": return requestHash===undefined?err("EINVAL","request hash required"):kernel.memoryPut(pid,request.args.handle as string,parseDescriptor(request.args.descriptor)!,requestHash);
    case "mem_get": case "mem_stat": return kernel.memoryStat(pid,request.args.handle as string);
    case "mem_ref": return requestHash===undefined?err("EINVAL","request hash required"):kernel.memoryRef(pid,request.args.handle as string,request.args.rights as number,requestHash);
    case "mem_drop": return kernel.memoryDrop(pid,request.args.handle as string);
    case "mem_link": case "mem_unlink": return kernel.memoryLink(pid,request.args.handle as string,request.args.targetHandle as string,request.op==="mem_unlink");
    case "fs_init": case "fs_stat": case "fs_ls": case "fs_open": case "fs_put": case "fs_mkdir": case "fs_unlink": case "fs_rename": case "fs_mount": case "fs_unmount": case "fs_grant":
      return kernel.executeVfs(pid,request.op,request.args,requestHash);
    case "sh_config": case "sh_spawn": case "sh_control": case "sh_step": case "sh_finish": case "sh_wait":
      return kernel.executeShell(pid,request.op,request.args,requestHash);
    case "id_info":case "id_groups":case "id_cap":case "id_chmod":case "id_chown":case "proxy_create":case "proxy_set":case "proxy_use":case "group_action":
      return kernel.executeIdentity(pid,request.op,request.args,requestHash);
    case "dev_define":case "dev_grant":case "dev_open":case "dev_close":case "dev_list":case "dev_request":case "dev_observe":
      return kernel.executeDevice(pid,request.op,request.args,requestHash);
    case "pkg_install":case "pkg_list":case "pkg_remove":case "svc_boot":case "svc_list":case "svc_status":case "svc_start":case "svc_stop":case "svc_restart":case "svc_health":
      return kernel.executeInit(pid,request.op,request.args,requestHash);
    case "getpid": return kernel.getpid(pid);
    case "getppid": return kernel.getppid(pid);
    case "cap_derive": return kernel.capDerive(pid, request.args.handle as string, request.args.rights as number, requestHash === undefined ? undefined : `h:request:${requestHash}`);
    case "cap_close": return kernel.capClose(pid, request.args.handle as string);
    case "cap_revoke": return kernel.capRevoke(pid, request.args.handle as string);
    case "proc_suspend": return kernel.suspend(pid,request.args.target as string,request.args.handle as string);
    case "proc_resume": return kernel.resume(pid,request.args.target as string,request.args.handle as string);
    case "signal_grant": return requestHash === undefined ? err("EINVAL", "request hash required") :
      kernel.grantSignal(pid, request.args.handle as string, request.args.target as string, requestHash);
    case "signal": {
      const target = request.args.target as string;
      // Canonical self-signals use the caller root, never a guessed handle.
      if (target === pid && request.args.handle !== kernel.getProcess(pid)?.root)
        return err("EACCES", "self signal requires root");
      return kernel.signal(pid, target, request.args.signal as QosSignal, request.args.handle as string);
    }
  }
}
function syscallVersionsMatch(kernel: QosKernel, request: QosCanonicalSyscallRequest): boolean {
  const args = request.args, pid = request.caller;
  if (SCHEDULER_OPS.includes(request.op as SchedulerOp))
    return canonicalJson(args.scheduleFrontier) === canonicalJson(kernel.schedulerFrontier());
  if (typeof args.handle === "string" && args.handleVersion !== kernel.handleVersion(pid, args.handle)) return false;
  if(MEMORY_OPS.includes(request.op as MemoryOp)){
    if(canonicalJson(args.memoryFrontier)!==canonicalJson(kernel.memoryFrontier()))return false;
    if(typeof args.targetHandle==="string"&&args.targetHandleVersion!==kernel.handleVersion(pid,args.targetHandle))return false;
  }
  if(VFS_OPS.includes(request.op as VfsOp)){
    if(typeof args.targetHandle==="string"&&args.targetHandleVersion!==kernel.handleVersion(pid,args.targetHandle))return false;
    if(request.op==="fs_grant"&&args.targetVersion!==kernel.processVersion(args.target as string))return false;
  }
  if(SHELL_OPS.includes(request.op as ShellOp)){
    if(request.op==="sh_config"||request.op==="sh_spawn"){
      if(args.namespaceVersion!==kernel.handleVersion(pid,args.namespaceHandle as string)||args.shellVersion!==kernel.shellContext(pid).version)return false;
      for(const name of ["input","append"])if(typeof args[name+"Handle"]==="string"&&args[name+"Version"]!==kernel.handleVersion(pid,args[name+"Handle"] as string))return false;
    }else{
      const job=kernel.shellJob(pid,args.handle as string);
      if(!job||job.pid!==args.target||job.version!==args.jobVersion||args.targetVersion!==kernel.processVersion(job.pid))return false;
      if(request.op==="sh_finish"&&canonicalJson(args.memoryFrontier)!==canonicalJson(kernel.memoryFrontier()))return false;
    }
  }
  if(INIT_OPS.includes(request.op as InitOp)){
    if(args.initVersion!==kernel.initVersion(pid)||canonicalJson(args.authorityFrontier)!==canonicalJson(kernel.handleFrontier(pid)))return false;
    if(request.op==="pkg_install")for(const b of parseBindings(args.bindings)??[])if(b.version!==kernel.handleVersion(pid,b.handle))return false;
  }
  if(request.op==="dev_list")return canonicalJson(args.authorityFrontier)===canonicalJson(kernel.handleFrontier(pid));
  if(request.op==="dev_grant")return args.targetVersion===kernel.processVersion(args.target as string);
  if(request.op==="dev_observe")return args.ticketVersion===kernel.deviceTicket(args.ticket as string)?.version;
  if(request.op==="id_cap"||request.op==="id_chmod")
    return canonicalJson(args.authorityFrontier)===canonicalJson(kernel.handleFrontier(pid,request.op==="id_chmod"?args.handle as string:undefined));
  if(request.op==="id_chown")return args.targetVersion===kernel.processVersion(args.target as string);
  if(request.op==="proxy_set")return args.proxyVersion===kernel.proxyVersion(args.token as string)&&
    (args.observedUses as string[]).every(hash=>kernel.proxyUseKnown(args.token as string,hash));
  if(request.op==="proxy_use"){
    if(args.proxyVersion!==kernel.proxyVersion(args.token as string))return false;
    const observed=kernel.proxyObservation(pid,args.token as string);
    if(observed&&Object.entries(observed).some(([k,v])=>args[k]!==v))return false;
    if(typeof args.dataHandle==="string"&&args.dataVersion!==kernel.handleVersion(pid,args.dataHandle))return false;
  }
  if (request.op === "signal" || request.op === "signal_grant" || request.op==="proc_suspend" || request.op==="proc_resume")
    return args.targetVersion === kernel.processVersion(args.target as string);
  return true;
}

/** Preflight for the command adapter; malformed/stale requests must not poison its chain. */
export function canonicalSyscallReady(kernel: QosKernel, payload: Record<string, unknown>, pid: string): boolean {
  const request = parseSyscallRequest(payload, pid);
  return request !== null && syscallVersionsMatch(kernel, request);
}

/** Predict the outcome without changing the source kernel. */
export function previewCanonicalSyscall(kernel: QosKernel, payload: Record<string, unknown>, pid: string, requestHash?: string): QosResult<unknown> | null {
  const request = parseSyscallRequest(payload, pid);
  return request ? executeCanonicalSyscall(kernel.cloneForReplay(), request, requestHash) : null;
}

export interface QosKernelReplayResult {
  kernel: QosKernel;
  applied: string[];
  rejected: { hash: string; reason: string }[];
  missingDependencies: { eventHash: string; dependencyHash: string; kind: QosDependencyKind }[];
  cyclicHashes: string[];
  syscalls: QosCanonicalSyscallTrace[];
  pendingSyscalls: string[];
}

/** Reconstruct the kernel process table from a verified qos.event/1 event set.
 * Input admission (hash/dyncap/fork verification) must happen before this call.
 * The replay is deterministic for any delivery permutation of the same event set.
 */
export function replayQosKernel(events: QosEvent[], forkedSources: Iterable<string> = []): QosKernelReplayResult {
  const forked = new Set(forkedSources);
  const admitted = events.filter((event) => !forked.has(event.source));
  const order = canonicalEventOrder(admitted);
  const broken = brokenChainsIn(admitted);
  let kernel = new QosKernel();
  const starts = new Map<string, QosEvent>();
  const invalidEventHashes = new Set(order.missingDependencies.map((item) => item.eventHash));
  for (const hash of order.cyclicHashes) invalidEventHashes.add(hash);
  // Fail closed transitively: an event whose prev/grant points to an invalid
  // event is itself invalid, even if its direct references are present.
  let changed = true;
  while (changed) {
    changed = false;
    for (const event of order.ordered) {
      if (invalidEventHashes.has(event.hash)) continue;
      const refs = eventDependencies(event).map(ref => ref.hash);
      if (refs.some((ref) => invalidEventHashes.has(ref))) {
        invalidEventHashes.add(event.hash);
        changed = true;
      }
    }
  }
  const applied: string[] = [];
  const syscalls: QosCanonicalSyscallTrace[] = [];
  const requests = new Map<string, { event: QosEvent; request: QosCanonicalSyscallRequest }>();
  const consumed = new Set<string>();
  const startCounts = new Map<string, number>();
  for (const event of order.ordered) {
    if (event.type === "process-start") startCounts.set(event.process, (startCounts.get(event.process) ?? 0) + 1);
  }
  const rejected: { hash: string; reason: string }[] = [];
  const rejectSyscall = (event: QosEvent, reason: string) => {
    invalidEventHashes.add(event.hash);
    rejected.push({ hash: event.hash, reason });
  };
  for (const [position, event] of order.ordered.entries()) {
    if (invalidEventHashes.has(event.hash) || eventDependencies(event).some(ref => invalidEventHashes.has(ref.hash))) {
      invalidEventHashes.add(event.hash);
      rejected.push({ hash: event.hash, reason: "event has unresolved or cyclic causal dependencies" });
      continue;
    }
    if (event.type === "process-start") {
      const name = event.payload.name;
      const scope = parseQosCapabilityScope(event.payload.scope);
      if (startCounts.get(event.process) !== 1 || event.prev !== "genesis" || event.grant !== "root" ||
          typeof name !== "string" || event.payload.rootCapability !== event.capability ||
          processIdFor(name, event.capability) !== event.process || !scope || scope.process !== event.process) {
        rejectSyscall(event, "conflicting or invalid process-start"); continue;
      }
      const before = kernel.snapshotLiveHandles();
      const beforeMemory = kernel.memoryRootSnapshot();
      const beforeProcesses = kernel.snapshotProcessState();
      const result = kernel.createProcess({ name, owner: event.source, pid: event.process, rootId: `h:start:${event.hash}` });
      if (!result.ok) rejectSyscall(event, result.detail ?? result.errno);
      else { kernel.recordHandleVersions(before, event.hash); kernel.recordProcessVersions(beforeProcesses, event.hash); kernel.recordScheduler(event.hash); kernel.recordMemory(beforeMemory,event.hash); starts.set(event.process, event); applied.push(event.hash); }
      continue;
    }
    if (event.type === "syscall-request" || event.type === "syscall-result") {
      const start = starts.get(event.process);
      const scope = start?.payload.scope as { process?: unknown; events?: unknown } | undefined;
      if (!start || startCounts.get(event.process) !== 1 || event.grant !== "root" ||
          broken.some(chain => chain.process === event.process && chain.source === event.source) ||
          event.source !== start.source || event.capability !== start.capability ||
          start.payload.rootCapability !== start.capability || scope?.process !== event.process ||
          !Array.isArray(scope.events) || !scope.events.includes(event.type)) {
        rejectSyscall(event, "syscall event lacks explicit process-root authority"); continue;
      }
      if (event.type === "syscall-request") {
        const request = parseSyscallRequest(event.payload, event.process);
        if (!request) { rejectSyscall(event, "invalid or unsupported syscall payload"); continue; }
        if (!syscallVersionsMatch(kernel, request)) {
          rejectSyscall(event, "missing, stale or foreign handle/process/scheduler/memory version"); continue;
        }
        requests.set(event.hash, { event, request });
        applied.push(event.hash);
        continue;
      }
      const payload = event.payload;
      const requestHash = payload.requestHash;
      const pending = typeof requestHash === "string" ? requests.get(requestHash) : undefined;
      if (!exactKeys(payload, ["schema", "requestHash", "outcome"]) ||
          payload.schema !== "qos.syscall/1" || typeof requestHash !== "string" ||
          requestHash !== event.prev || !pending || consumed.has(requestHash) ||
          pending.event.process !== event.process || pending.event.source !== event.source ||
          pending.event.capability !== event.capability) {
        rejectSyscall(event, "unmatched or repeated syscall result"); continue;
      }
      if (!syscallVersionsMatch(kernel, pending.request)) {
        rejectSyscall(event, "handle/process/scheduler/memory version changed before result"); continue;
      }
      const before = kernel.snapshotLiveHandles();
      const beforeMemory = kernel.memoryRootSnapshot();
      const beforeProcesses = kernel.snapshotProcessState();
      const trial = kernel.cloneForReplay();
      const outcome = executeCanonicalSyscall(trial, pending.request, requestHash);
      if (canonicalJson(outcome) !== canonicalJson(payload.outcome)) {
        rejectSyscall(event, VFS_OPS.includes(pending.request.op as VfsOp)&&!outcome.ok&&outcome.errno==="EAGAIN"?"VFS conflict: "+outcome.detail:"syscall outcome differs from deterministic execution"); continue;
      }
      // Refusals are traceable but cannot publish speculative mutation.
      if (outcome.ok) { trial.reconcileInit(); trial.recordInit(kernel.snapshotInit(),event.hash); trial.recordVfs(pending.request.op,outcome,event.hash); trial.recordShell(event.process,pending.request.op,outcome,event.hash); trial.recordIdentity(pending.request.op,outcome,event.hash,pending.request.args); trial.recordDevice(pending.request.op,outcome,event.hash); trial.recordHandleVersions(before, event.hash); trial.recordProcessVersions(beforeProcesses, event.hash); trial.recordScheduler(event.hash, SCHEDULER_OPS.includes(pending.request.op as SchedulerOp)); trial.recordMemory(beforeMemory,event.hash,MEMORY_OPS.includes(pending.request.op as MemoryOp)?pending.request.op as MemoryOp:pending.request.op==="sh_finish"&&(outcome.value as {namespace?:string}).namespace?"mem_put":undefined); kernel = trial; }
      consumed.add(requestHash);
      syscalls.push({ requestHash, resultHash: event.hash, caller: event.process, op: pending.request.op,
                      args: { ...pending.request.args }, outcome, position });
      applied.push(event.hash);
      continue;
    }
    if (event.type !== "process-suspend" && event.type !== "process-resume" && event.type !== "process-terminate") continue;
    const start = starts.get(event.process);
    if (!start) { rejected.push({ hash: event.hash, reason: "lifecycle event precedes or lacks process-start" }); continue; }
    const scope = parseQosCapabilityScope(start.payload.scope);
    if (event.source !== start.source || event.capability !== start.capability ||
        event.grant !== "root" || !scope || !scopeAllows(scope, event.type)) {
      rejected.push({ hash: event.hash, reason: "lifecycle event is not root-attributed or lacks scope" });
      continue;
    }
    const transition = event.type === "process-suspend" ? "suspend" : event.type === "process-resume" ? "resume" : "terminate";
    const before = kernel.snapshotLiveHandles();
    const beforeMemory = kernel.memoryRootSnapshot();
    const beforeProcesses = kernel.snapshotProcessState();
    const beforeInit=kernel.snapshotInit();
    const result = kernel.replayLifecycle(event.process, transition);
    if (!result.ok) rejected.push({ hash: event.hash, reason: result.detail ?? result.errno });
    else { kernel.reconcileInit();kernel.recordInit(beforeInit,event.hash);kernel.recordHandleVersions(before, event.hash); kernel.recordProcessVersions(beforeProcesses, event.hash); kernel.recordScheduler(event.hash); kernel.recordMemory(beforeMemory,event.hash); applied.push(event.hash); }
  }
  return { kernel, applied, rejected, missingDependencies: order.missingDependencies, cyclicHashes: order.cyclicHashes, syscalls, pendingSyscalls: [...requests.keys()].filter(hash => !consumed.has(hash)) };
}
