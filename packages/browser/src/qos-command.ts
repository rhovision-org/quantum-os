// qos-command.ts — the room-facing `/qos` surface over `qos-process.ts`.
//
// `QosProcessRoom` already matches the browser's `QOSPeer.broadcast` /
// `onMessage` shape; this module supplies the part a person actually types:
// start / status / suspend / resume / terminate, process-name resolution, and
// the chat lines a room sees when a process changes state.
//
// It stays deliberately thin. It does not sign anything itself, does not
// change `/poll` or `/gov`, and does not call a chain. Every lifecycle
// transition is the dyncap-attributed event `QosProcessRoom` already knows how to make.

import { DEVICE_OPS,DEVICE_KINDS,deviceRequest,type DeviceOp,type DeviceDescriptor } from "./qos-device.js";
import { DeviceBroker,deviceFailure,type DeviceDriver } from "./qos-device-host.js";
import { IDENTITY_OPS,PROXY_ACTIONS,type IdentityOp } from "./qos-identity.js";
import { SHELL_OPS,CONFIG_COMMANDS,splitShell,parsePipeline,boundedText,type ShellOp } from "./qos-shell.js";
import { VFS_OPS, type VfsOp } from "./qos-vfs.js";
import type { QosMemoryBytes } from "./qos-memory-bytes.js";
import { MEMORY_OPS, type MemoryOp } from "./qos-memory.js";
import { SCHEDULER_OPS, type SchedulerOp } from "./qos-scheduler.js";
import type { DynCapState } from "./dyncap.js";
import { replayQosKernel, previewCanonicalSyscall, canonicalSyscallReady, type QosCanonicalSyscallTrace } from "./qos-kernel.js";
import {
  QosProcessRoom,
  parseQosEvent,
  type QosEvent,
  type QosProcessView,
  type QosTransport,
} from "./qos-process.js";

export interface QosCommandHost {
  roomId: string;
  identity: DynCapState;
  transport: QosTransport;
  /** Say a line in the room (the app supplies its system-message sink). */
  say: (text: string) => void;
  /** Another peer's display label, for the "who did it" part of a line. */
  label?: (source: string) => string;
  /** Persist the dyncap sequence after a locally dyncap-attributed event. */
  onSigned?: () => void;
  memory?: () => Promise<{service:QosMemoryBytes;network?:string}>;
  deviceDriver?: (descriptor:DeviceDescriptor)=>Promise<DeviceDriver|null>;
  loadJournal?: () => unknown;
  saveJournal?: (events:QosEvent[]) => void;
}

interface TrackedProcess {
  id: string;
  name: string;
  start: QosEvent;
  /** Peer id for an inbound start, or "you" for a locally started process. */
  owner: string;
  /** Dyncap anchor on the start event (the process's authority root). */
  ownerAnchor: string;
}

const short = (hash: string): string => `${hash.slice(0, 12)}…`;

const USAGE = [
  "QOS processes — named, capability-guarded continuations in this room:",
  "  /qos start <name> [| <question>]  — start a process you own",
  "  /qos syscall <name|id> | <op> | <JSON args> — bounded owner syscall",
  "  /qos ps                          — process table: pid · name · state · owner",
  "  /qos status [name|id]             — list, or show one process and its digest",
  "  /qos suspend <name|id> [| reason] — owner pauses it",
  "  /qos resume <name|id> [| reason]  — owner resumes it",
  "  /qos terminate <name|id> [| reason] — owner ends it",
  "  /qos kill <name|id> [| reason]    — alias for terminate (owner only)",
  "The events are dyncap-attributed and broadcast; every peer recomputes the same digest.",
];

export class QosCommand {
  readonly room: QosProcessRoom;
  private readonly byId = new Map<string, TrackedProcess>();
  private readonly byName = new Map<string, string>();
  private commandQueue: Promise<void> = Promise.resolve();
  private readonly deviceBroker=new DeviceBroker();
  private deviceEpoch=0;
  private shellSelection:{pid:string;namespace:string}|null=null;
  private readonly restored:Promise<void>;
  private saveJournal():void {
    try{this.host.saveJournal?.(this.room.log.checkpointEvents());}
    catch{this.host.say("local QOS journal persistence failed; current room history remains in memory");}
  }
  private async restoreJournal():Promise<void>{
    const saved=this.host.loadJournal?.();
    if(saved===undefined||saved===null)return;
    if(!Array.isArray(saved))throw new Error("invalid saved QOS journal");
    for(const input of saved){
      const event=parseQosEvent(input);
      if(!event)throw new Error("saved QOS journal failed shape validation");
      const admitted=await this.room.log.ingest(event);
      if(!admitted.ok&&!admitted.fork)throw new Error("saved QOS journal failed admission");
      if(admitted.ok)this.track(event,event.source===this.host.identity.anchor?"you":event.source);
    }
  }

  constructor(private readonly host: QosCommandHost) {
    this.room = new QosProcessRoom({
      roomId: host.roomId,
      identity: host.identity,
      transport: host.transport,
    });
    this.restored=this.restoreJournal();
    void this.restored.catch(()=>{});
  }

  /** Processes this peer has seen start, oldest first. */
  list(): { id: string; name: string; start: QosEvent; owner: string; ownerAnchor: string }[] {
    return [...this.byId.values()].map((p) => ({
      id: p.id, name: p.name, start: p.start, owner: p.owner, ownerAnchor: p.ownerAnchor,
    }));
  }

  /** The current view of a tracked process, or null when it is unknown. */
  async view(ref: string): Promise<QosProcessView | null> {
    const entry = this.resolve(ref);
    return entry ? this.room.view(entry.id) : null;
  }

  /** Feed one inbound QOS envelope. Returns true when it was accepted or known. */
  async ingest(from: string, data: unknown): Promise<boolean> {
    await this.restored;
    const event = parseQosEvent(data);
    if (!event) return false;
    const result = await this.room.log.ingest(event);
    if (!result.ok) {if(result.fork){this.saveJournal();await this.reconcileDevices();}return false;}
    if (result.duplicate) return true;

    this.saveJournal();
    await this.reconcileDevices();
    const entry = this.track(event, from);
    if (event.type === "process-start" && entry) {
      this.host.say(`🧩 ${this.label(from)} started **${entry.name}** — \`/qos status ${entry.name}\``);
    } else if (event.type === "process-suspend" || event.type === "process-resume" || event.type === "process-terminate") {
      const name = this.byId.get(event.process)?.name ?? event.process;
      const verb = event.type === "process-suspend" ? "suspended"
        : event.type === "process-resume" ? "resumed" : "terminated";
      const icon = event.type === "process-suspend" ? "⏸" : event.type === "process-resume" ? "▶" : "⏹";
      this.host.say(`${icon} **${name}** ${verb} by ${this.label(from)}`);
    }
    return true;
  }

  /** Handle the argument after `/qos` (no leading command). */
  async handle(raw: string): Promise<void> {
    const run = this.commandQueue.then(async () => {await this.restored;try{await this.dispatch(raw);}finally{await this.reconcileDevices();}});
    this.commandQueue = run.then(() => undefined, () => undefined);
    return run;
  }

  private async dispatch(raw: string): Promise<void> {
    const text = raw.trim();
    const sub = (text.split(/\s+/, 1)[0] || "status").toLowerCase();
    const rest = text.slice(sub.length).trim();

    switch (sub) {
      case "help":
        for (const line of USAGE) this.host.say(line);
        return;
      case "start":
        return this.start(rest);
      case "status":
      case "list":
        return this.status(rest);
      case "ps":
        return this.ps();
      case "syscall":
        await this.syscall(rest);return;
      case "fs":
        return this.fs(rest);
      case "dev":return this.deviceCommand(rest);
      case "whoami":case "id":
        if(!rest){this.host.say("UID "+this.host.identity.anchor+" · dyncap TOFU continuity; no superuser");return;}
        return this.identityCommand("id_info",rest);
      case "groups":return this.identityCommand("id_groups",rest);
      case "cap":return this.identityCommand("id_cap",rest);
      case "chmod":return this.identityCommand("id_chmod",rest);
      case "chown":return this.identityCommand("id_chown",rest);
      case "proxy":return this.proxyCommand(rest);
      case "sh": return this.shell(rest);
      case "spawn": return this.shell(rest,true);
      case "exec": case "wait": case "jobs": case "fg": case "bg":
        return this.jobCommand(sub,rest);

      case "suspend":
      case "resume":
      case "terminate":
        return this.lifecycle(sub,rest);
      case "kill":
        return rest.startsWith("h:job:")?this.jobCommand("kill",rest):this.lifecycle("terminate",rest);
      default:
        this.host.say(`unknown /qos subcommand: ${sub}`);
        for (const line of USAGE) this.host.say(line);
    }
  }

  private async start(rest: string): Promise<void> {
    const [namePart, ...questionParts] = rest.split("|");
    const name = namePart.trim();
    if (!name) {
      this.host.say("usage: /qos start <name> [| <question>]");
      return;
    }
    if (this.byName.has(name)) {
      this.host.say(`a process named **${name}** already exists — \`/qos status ${name}\``);
      return;
    }
    const question = questionParts.join("|").trim() || name;
    const started = await this.room.startProcess(name, { question });
    this.host.onSigned?.();
    this.track(started.event, "you");
    this.saveJournal();
    const view = await this.room.view(started.processId);
    this.host.say(`🧩 started **${name}** — ${view.status} · ${started.processId} · digest ${short(view.stateDigest)}`);
  }

  private async status(rest: string): Promise<void> {
    if (this.byId.size === 0) {
      this.host.say("no QOS processes in this room — start one with `/qos start <name>`");
      return;
    }
    if (rest) {
      const entry = this.resolve(rest);
      if (!entry) {
        this.host.say(`no process named or identified by **${rest}** — \`/qos status\``);
        return;
      }
      const view = await this.room.view(entry.id);
      const kernel = replayQosKernel(this.room.log.events(), this.room.log.forkedSources);
      const process = kernel.kernel.getProcess(entry.id);
      this.host.say(`**${entry.name}** — kernel: ${process?.state ?? "unavailable"} · orchestration: ${view.status}/${view.phase}`);
      this.host.say(`  process: ${entry.id}`);
      this.host.say(`  owner: ${this.ownerLabel(entry)}`);
      this.host.say(`  events: ${view.eventCount} · quorum ${view.quorum.required}${view.quorum.met ? " met" : ` missing ${view.quorum.missing.length}`}`);
      if (view.nominations.length) {
        this.host.say(`  nominations: ${view.nominations.map((n) => `${n.text} (${n.by.length})`).join(" · ")}`);
      }
      if (view.poll) {
        this.host.say(`  poll: ${view.poll.ballotCount} ballot(s), ${view.poll.optionIds.length} option(s)${view.result ? ` — ${view.winnerTexts.join(" / ")}` : ""}`);
      }
      if (view.rejected.length || view.conflictedSources.length) {
        this.host.say(`  rejected ${view.rejected.length} · conflicted ${view.conflictedSources.length} · broken chains ${view.brokenChains.length}`);
      }
      this.host.say(`  state digest: ${view.stateDigest}`);
      this.host.say(`  kernel digest: ${await kernel.kernel.stateDigest()}`);
      const memory=kernel.kernel.memoryView();
      this.host.say(`  memory objects: ${memory.objects.length} · reachable: ${memory.reachable.length} · logically unreferenced: ${memory.unreachable.length}`);
      this.host.say(`  scheduler: ${JSON.stringify(kernel.kernel.scheduleView())}`);
      this.host.say(`  shell jobs: ${kernel.kernel.shellList(entry.id).length}`);
      this.host.say(`  canonical syscalls: ${kernel.syscalls.filter(item => item.caller === entry.id).length}`);
      if (view.finalDigest) this.host.say(`  final digest: ${view.finalDigest}`);
      return;
    }

    this.host.say(`QOS processes (${this.byId.size}):`);
    const replay = replayQosKernel(this.room.log.events(), this.room.log.forkedSources);
    for (const entry of this.list()) {
      const view = await this.room.view(entry.id);
      const state = replay.kernel.getProcess(entry.id)?.state ?? "unavailable";
      this.host.say(`  ${state === "running" ? "●" : state === "exited" ? "✓" : "○"} ${entry.name}  kernel:${state} orchestration:${view.status}/${view.phase}  ${view.eventCount} events  ${short(view.stateDigest)}  ${entry.id}`);
    }
  }

  private async syscall(rest: string): Promise<QosCanonicalSyscallTrace|undefined> {
    const [reference, operation, ...argParts] = rest.split("|");
    const entry = this.resolve(reference.trim());
    if (!entry || !operation) {
      this.host.say("usage: /qos syscall <name|id> | <op> | <JSON args>");
      return;
    }
    if (entry.ownerAnchor !== this.host.identity.anchor) {
      this.host.say("only the process owner can issue a canonical syscall");
      return;
    }
    const scope = entry.start.payload.scope as { events?: unknown } | undefined;
    if (!Array.isArray(scope?.events) || !scope.events.includes("syscall-request") || !scope.events.includes("syscall-result")) {
      this.host.say("process root scope does not authorize syscalls");
      return;
    }
    let args: unknown;
    try { args = JSON.parse(argParts.join("|").trim() || "{}"); }
    catch { this.host.say("invalid syscall JSON arguments"); return; }
    const payload = { schema: "qos.syscall/1", caller: entry.id, op: operation.trim(), args };
    const current = () => replayQosKernel(this.room.log.events(), this.room.log.forkedSources);
    const before = current();
    // The application has seen these admitted chain tips. Preserve causality
    // across different peer/process chains instead of letting a later revoke
    // or proxy-set retroactively precede an already-observed receipt.
    const admitted=new Set(before.applied),tips=new Map<string,QosEvent>();
    for(const e of this.room.log.events())if(admitted.has(e.hash)){
      const key=e.source+"\u0000"+e.process,previous=tips.get(key);
      if(!previous||e.seq>previous.seq)tips.set(key,e);
    }
    if(tips.size>4096){this.host.say("observed journal frontier exceeds limit");return;}
    Object.assign(payload,{observed:[...new Set([...tips.values()].map(e=>e.hash))].sort()});
    if (args && typeof args === "object" && !Array.isArray(args) &&
        "handle" in args && typeof args.handle === "string" && !Object.hasOwn(args, "handleVersion")) {
      const version = before.kernel.handleVersion(entry.id, args.handle);
      if (version !== undefined) Object.assign(args, { handleVersion: version });
    }
    if (args && typeof args === "object" && !Array.isArray(args) &&
        "target" in args && typeof args.target === "string" && !Object.hasOwn(args, "targetVersion")) {
      const version = before.kernel.processVersion(args.target);
      if (version !== undefined) Object.assign(args, { targetVersion: version });
    }
    if (args && typeof args === "object" && !Array.isArray(args) &&
        SCHEDULER_OPS.includes(operation.trim() as SchedulerOp) && !Object.hasOwn(args,"scheduleFrontier"))
      Object.assign(args,{scheduleFrontier:before.kernel.schedulerFrontier()});
    if(args && typeof args==="object" && !Array.isArray(args) && MEMORY_OPS.includes(operation.trim() as MemoryOp)){
      if(!Object.hasOwn(args,"memoryFrontier"))Object.assign(args,{memoryFrontier:before.kernel.memoryFrontier()});
      if("targetHandle" in args && typeof args.targetHandle==="string" && !Object.hasOwn(args,"targetHandleVersion")){
        const version=before.kernel.handleVersion(entry.id,args.targetHandle);
        if(version!==undefined)Object.assign(args,{targetHandleVersion:version});
      }
    }
    if(args&&typeof args==="object"&&!Array.isArray(args)&&VFS_OPS.includes(operation.trim() as VfsOp)){
      if("handle" in args&&typeof args.handle==="string"&&operation.trim()!=="fs_init"){
        const version=before.kernel.fsVersion(entry.id,args.handle);
        if(version){
          if(!Object.hasOwn(args,"baseRoot"))Object.assign(args,{baseRoot:version.root});
          if(!Object.hasOwn(args,"rootVersion"))Object.assign(args,{rootVersion:version.version});
        }
      }
      if("targetHandle" in args&&typeof args.targetHandle==="string"){
        const version=before.kernel.handleVersion(entry.id,args.targetHandle);
        if(version&&!Object.hasOwn(args,"targetHandleVersion"))Object.assign(args,{targetHandleVersion:version});
        if(operation.trim()==="fs_mount"){
          const source=before.kernel.fsVersion(entry.id,args.targetHandle);
          if(source){
            if(!Object.hasOwn(args,"sourceRoot"))Object.assign(args,{sourceRoot:source.root});
            if(!Object.hasOwn(args,"sourceVersion"))Object.assign(args,{sourceVersion:source.version});
          }
        }
      }
    }
    if(args&&typeof args==="object"&&!Array.isArray(args)&&SHELL_OPS.includes(operation.trim() as ShellOp)){
      const a=args as Record<string,unknown>,op=operation.trim();
      if(op==="sh_config"||op==="sh_spawn"){
        if(!Object.hasOwn(a,"shellVersion"))a.shellVersion=before.kernel.shellContext(entry.id).version;
        if(typeof a.namespaceHandle==="string"){
          const version=before.kernel.handleVersion(entry.id,a.namespaceHandle);
          if(!Object.hasOwn(a,"namespaceVersion")&&version)a.namespaceVersion=version;
          const ns=before.kernel.fsVersion(entry.id,a.namespaceHandle);
          if(ns){
            if(!Object.hasOwn(a,"baseRoot"))a.baseRoot=ns.root;
            if(!Object.hasOwn(a,"rootVersion"))a.rootVersion=ns.version;
          }
        }
        for(const name of ["input","append"]){
          const handle=a[name+"Handle"];
          if(typeof handle==="string"&&!Object.hasOwn(a,name+"Version"))a[name+"Version"]=before.kernel.handleVersion(entry.id,handle);
        }
      }else if(typeof a.handle==="string"){
        const job=before.kernel.shellJob(entry.id,a.handle);
        if(job){
          if(!Object.hasOwn(a,"jobVersion"))a.jobVersion=job.version;
          if(!Object.hasOwn(a,"target"))a.target=job.pid;
          if(!Object.hasOwn(a,"targetVersion"))a.targetVersion=before.kernel.processVersion(job.pid);
        }
        if(op==="sh_finish"&&!Object.hasOwn(a,"memoryFrontier"))a.memoryFrontier=before.kernel.memoryFrontier();
      }
    }
    if(args&&typeof args==="object"&&!Array.isArray(args)&&IDENTITY_OPS.includes(operation.trim() as IdentityOp)){
      const a=args as Record<string,unknown>,op=operation.trim();
      if(op==="id_cap"||op==="id_chmod"){
        if(!Object.hasOwn(a,"authorityFrontier"))a.authorityFrontier=before.kernel.handleFrontier(entry.id,op==="id_chmod"?a.handle as string:undefined);
      }
      if(op==="proxy_set"&&typeof a.token==="string"){
        if(!Object.hasOwn(a,"proxyVersion"))a.proxyVersion=before.kernel.proxyVersion(a.token);
        if(!Object.hasOwn(a,"observedUses"))a.observedUses=before.kernel.proxyObservedUses(a.token);
      }
      if(op==="proxy_use"&&typeof a.token==="string"){
        const observation=before.kernel.proxyObservation(entry.id,a.token);
        if(observation)for(const [key,value] of Object.entries(observation))if(!Object.hasOwn(a,key))a[key]=value;
        if(typeof a.dataHandle==="string"&&!Object.hasOwn(a,"dataVersion"))a.dataVersion=before.kernel.handleVersion(entry.id,a.dataHandle);
      }
    }
    if(args&&typeof args==="object"&&!Array.isArray(args)&&DEVICE_OPS.includes(operation.trim() as DeviceOp)){
      const a=args as Record<string,unknown>,op=operation.trim();
      if(op==="dev_list"&&!Object.hasOwn(a,"authorityFrontier"))a.authorityFrontier=before.kernel.handleFrontier(entry.id);
      if(op==="dev_observe"&&typeof a.ticket==="string"&&!Object.hasOwn(a,"ticketVersion"))a.ticketVersion=before.kernel.deviceTicket(a.ticket)?.version;
    }
    if (!canonicalSyscallReady(before.kernel, payload, entry.id)) {
      this.host.say("invalid, unsupported or stale canonical syscall");
      return;
    }
    const request = await this.room.emit(entry.id, entry.start, "syscall-request", payload);
    this.host.onSigned?.();
    this.saveJournal();
    const requested = current();
    const outcome = previewCanonicalSyscall(requested.kernel, payload, entry.id, request.hash);
    if (!requested.pendingSyscalls.includes(request.hash) || outcome === null) {
      this.host.say("syscall request rejected by canonical replay");
      return;
    }
    const result = await this.room.emit(entry.id, entry.start, "syscall-result", {
      schema: "qos.syscall/1", requestHash: request.hash, outcome,
    });
    this.host.onSigned?.();
    this.saveJournal();
    const after = current();
    const trace = after.syscalls.find(item => item.resultHash === result.hash);
    if (!trace) { this.host.say("syscall result rejected by canonical replay: "+(after.rejected.find(r=>r.hash===result.hash)?.reason??"unknown reason")); return; }
    this.host.say(`syscall ${trace.op} ${trace.outcome.ok ? "OK" : trace.outcome.errno} · ${JSON.stringify(trace.outcome)} · position ${trace.position} · kernel digest ${await after.kernel.stateDigest()}`);
    return trace;
  }
  private async fs(rest:string):Promise<void>{
    const [head,...body]=rest.split("|");
    const [op,ref,handle,path,destination,...extra]=head.trim().split(/\s+/);
    const entry=ref?this.resolve(ref):null;
    const current=()=>replayQosKernel(this.room.log.events(),this.room.log.forkedSources).kernel;
    const say=(s:string)=>this.host.say(s);
    const usage="usage: /fs init <process> | /fs ls|stat|cat|mkdir|rm|put|put-durable|rename|mount|unmount <process> <namespace-handle> <path> [destination|source-handle] | /fs put ... | text";
    if(!entry||entry.ownerAnchor!==this.host.identity.anchor||extra.length){say(usage);return;}
    const call=(operation:string,args:Record<string,unknown>)=>this.syscall(entry.id+" | "+operation+" | "+JSON.stringify(args));
    const root=current().getProcess(entry.id)?.root;
    if(op==="init"){if(!root||handle||body.length){say(usage);return;}await call("fs_init",{handle:root});return;}
    if(!handle||!path){say(usage);return;}
    const version=current().fsVersion(entry.id,handle);
    if(!version){say("namespace handle unavailable or not readable");return;}
    const args={handle,path,baseRoot:version.root,rootVersion:version.version};
    const simple:Record<string,string>={ls:"fs_ls",stat:"fs_stat",mkdir:"fs_mkdir",rm:"fs_unlink",unmount:"fs_unmount"};
    if(Object.hasOwn(simple,op)){if(destination||body.length){say(usage);return;}await call(simple[op],args);return;}
    if(op==="rename"||op==="mount"){
      if(!destination||body.length){say(usage);return;}
      await call(op==="rename"?"fs_rename":"fs_mount",{...args,...(op==="rename"?{destination}:{targetHandle:destination})});return;
    }
    if(op==="grant"){
      // /fs grant <process> <handle> <recipient-pid> <numeric-rights>
      if(!destination||body.length){say(usage);return;}
      await call("fs_grant",{handle,baseRoot:version.root,rootVersion:version.version,target:path,rights:Number(destination)});return;
    }
    if(!this.host.memory){say("byte availability adapter not configured");return;}
    if(op==="cat"){
      if(destination||body.length){say(usage);return;}
      const opened=await call("fs_open",args);
      if(!opened?.outcome.ok)return;
      const file=(opened.outcome.value as {id:string}).id;
      try{
        const {service}=await this.host.memory();
        const bytes=await service.get(current,entry.id,file);
        if(!bytes){say("file bytes unavailable or hash verification failed");return;}
        say(new TextDecoder().decode(bytes));
      }finally{await call("mem_drop",{handle:file});}
      return;
    }
    if(op!=="put"&&op!=="put-durable"){say(usage);return;}
    if(destination||!body.length||!root){say(usage);return;}
    // Check namespace WRITE before any durable publication. Concurrent root
    // changes can still leave an explicitly published unreferenced object.
    const rights=current().fsCanPut(entry.id,handle,path);
    if(!rights){say("file destination is not writable or is invalid");return;}
    const {service,network}=await this.host.memory();
    if(op==="put-durable"&&!network){say("durable backend not configured");return;}
    const bytes=new TextEncoder().encode(body.join("|").replace(/^ /,""));
    const descriptor=await service.prepare(bytes,op==="put-durable"?network:undefined);
    let file:string|undefined;
    try{
      const receipt=await call("mem_put",{handle:root,descriptor});
      if(!receipt?.outcome.ok)return;
      file=(receipt.outcome.value as {id:string}).id;
      const changed=await call("fs_put",{...args,targetHandle:file});
      if(changed?.outcome.ok)say("file committed: "+descriptor.id+(descriptor.locator?" · "+descriptor.locator.uri:" · local cache"));
    }finally{
      service.releaseStaged(descriptor.id);
      if(file)await call("mem_drop",{handle:file});
    }
  }


  /** An embedding host explicitly transfers a dedicated, already-authorized
   * resource. Factory is never invoked on an invalid handle or wrong kind. */
  async attachDevice(ref:string,handle:string,kind:DeviceDescriptor["kind"],factory:()=>DeviceDriver):Promise<boolean>{
    const epoch=this.deviceEpoch;
    await this.restored;
    const entry=this.resolve(ref),k=()=>this.shellKernel();
    if(epoch!==this.deviceEpoch||!entry||entry.ownerAnchor!==this.host.identity.anchor||this.deviceBroker.hasLease(handle))return false;
    const session=k().deviceSession(entry.id,handle);
    if(!session||session.descriptor.kind!==kind)return false;
    const driver=factory();
    if(this.deviceBroker.bind(k,entry.id,handle,driver))return true;
    await driver.close();return false;
  }
  /** Shutdown host effects, not journal state. Reconnection requires rebind. */
  async releaseDevices():Promise<void>{
    this.deviceEpoch++;
    try{await this.deviceBroker.releaseAll();}
    catch{this.host.say("device resource release failed at host boundary");}
  }

  private async reconcileDevices(){
    try{await this.deviceBroker.reconcile(()=>this.shellKernel());}
    catch{this.host.say("device resource release failed at host boundary");}
  }
  private async deviceCommand(rest:string):Promise<void>{
    const [head,...body]=rest.split("|");
    const [op,ref,handle,arg,mask,...extra]=head.trim().split(/\s+/),entry=this.resolve(ref);
    const say=(s:string)=>this.host.say(s);
    const usage="usage: /dev list <process> | define <process> <kind> <rights> | grant <process> <grant> <target-pid> <rights> | open <process> <grant> <rights> | bind|close <process> <session> | read <process> <session> <limit> | write <process> <session> | hex; ioctl <process> <session> status|zfa | hex; abandon <process> <ticket>";
    if(!entry||entry.ownerAnchor!==this.host.identity.anchor||extra.length){say(usage);return;}
    const pid=entry.id,k=()=>this.shellKernel(),call=(operation:string,args:Record<string,unknown>)=>this.syscall(pid+" | "+operation+" | "+JSON.stringify(args));
    if(op==="list"&&!handle&&!body.length){await call("dev_list",{});return;}
    if(op==="define"&&DEVICE_KINDS.includes(handle as typeof DEVICE_KINDS[number])&&arg&&!mask&&!body.length){
      const root=k().getProcess(pid)?.root;if(root)await call("dev_define",{handle:root,kind:handle,rights:Number(arg)});return;
    }
    if(!handle){say(usage);return;}
    if(op==="grant"&&arg&&mask&&!body.length){await call("dev_grant",{handle,target:this.resolve(arg)?.id??arg,rights:Number(mask)});return;}
    if(op==="open"&&arg&&!mask&&!body.length){await call("dev_open",{handle,rights:Number(arg)});return;}
    if(op==="close"&&!arg&&!body.length){await call("dev_close",{handle});return;}
    if(op==="bind"&&!arg&&!body.length){
      const epoch=this.deviceEpoch,session=k().deviceSession(pid,handle);
      if(this.deviceBroker.hasLease(handle)){say("device already bound");return;}
      if(!session||!this.host.deviceDriver){say("no live device session or explicit host adapter");return;}
      const driver=await this.host.deviceDriver(session.descriptor);
      if(!driver){say("explicit resource binding unavailable for this device kind");return;}
      if(epoch!==this.deviceEpoch||!this.deviceBroker.bind(k,pid,handle,driver)){await driver.close();say("device binding refused");return;}
      say("device bound: "+handle);return;
    }
    if(op==="abandon"&&!arg&&!body.length){
      await call("dev_observe",{ticket:handle,observation:deviceFailure("EINTR","unknown")});return;
    }
    let request:unknown;
    if(op==="read"&&arg&&!mask&&!body.length)request={action:"read",limit:Number(arg)};
    else if(op==="write"&&!arg&&body.length===1)request={action:"write",hex:body[0].trim()};
    else if(op==="ioctl"&&arg&&!mask&&body.length<=1)request={action:"ioctl",code:arg,hex:body[0]?.trim()??""};
    else{say(usage);return;}
    if(!deviceRequest(request)){say("invalid device request");return;}
    const receipt=await call("dev_request",{handle,request});
    if(!receipt?.outcome.ok)return;
    const ticket=(receipt.outcome.value as {id:string}).id;
    // Only a freshly committed request from this command can dispatch. A
    // restored pending ticket is never re-executed; abandon records uncertainty.
    const observation=await this.deviceBroker.perform(k,pid,ticket);
    await call("dev_observe",{ticket,observation});
  }

  private async identityCommand(op:string,rest:string):Promise<void>{
    const [ref,handle,arg,...extra]=rest.trim().split(/\s+/),entry=this.resolve(ref);
    if(!entry||extra.length||entry.ownerAnchor!==this.host.identity.anchor){this.host.say("usage: /qos whoami|id|groups|cap <owned-process>; /qos chmod <process> <handle> <rights>; /qos chown <process> <handle> <recipient-pid>");return;}
    const args:Record<string,unknown>={};
    if(op==="id_chmod"||op==="id_chown"){
      if(!handle||!arg){this.host.say("handle and rights or recipient required");return;}
      Object.assign(args,op==="id_chmod"?{handle,rights:Number(arg)}:{handle,target:this.resolve(arg)?.id??arg});
    }else if(handle){this.host.say("unexpected arguments");return;}
    await this.syscall(entry.id+" | "+op+" | "+JSON.stringify(args));
  }
  private async proxyCommand(rest:string):Promise<void>{
    const [op,ref,first,second,third,fourth,...extra]=rest.trim().split(/\s+/),entry=this.resolve(ref);
    const say=(t:string)=>this.host.say(t);
    const usage="usage: /qos proxy create <process> <handle> <holder-uid> <rights> | set <process> <token> <handle> <rights> on|off | use <process> <token> stat|ls|read|mkdir|unlink|put|signal <path|signal> [data-handle]";
    if(!entry||entry.ownerAnchor!==this.host.identity.anchor||extra.length){say(usage);return;}
    const call=(operation:string,args:Record<string,unknown>)=>this.syscall(entry.id+" | "+operation+" | "+JSON.stringify(args));
    if(op==="create"&&first&&second&&third&&!fourth){await call("proxy_create",{handle:first,holder:second,rights:Number(third)});return;}
    // set has five arguments after op: process, token, handle, mask, state.
    if(op==="set"&&first&&second&&third&&["on","off"].includes(fourth)){
      await call("proxy_set",{token:first,...(fourth==="on"?{handle:second}:{}),rights:Number(third),enabled:fourth==="on"});return;
    }
    if(op!=="use"||!first||!PROXY_ACTIONS.includes(second as typeof PROXY_ACTIONS[number])||!third){say(usage);return;}
    if(second==="put"?!fourth:!!fourth){say(usage);return;}
    const args:Record<string,unknown>={token:first,action:second,...(second==="signal"?{signal:third}:{path:third}),...(second==="put"?{dataHandle:fourth}:{})};
    const receipt=await call("proxy_use",args);
    if(second==="read"&&receipt?.outcome.ok){
      if(!this.host.memory){say("byte service unavailable");return;}
      const meta=receipt.outcome.value as {id:string};
      const {service}=await this.host.memory();
      const bytes=await service.getProxy(()=>this.shellKernel(),entry.id,first,third,receipt.args.proxyVersion as string,meta.id);
      if(!bytes){say("proxy read refused or bytes unavailable");return;}
      say(new TextDecoder().decode(bytes));
    }
  }

  private shellKernel(){return replayQosKernel(this.room.log.events(),this.room.log.forkedSources).kernel;}
  private shellCall(pid:string,op:string,args:Record<string,unknown>){
    return this.syscall(pid+" | "+op+" | "+JSON.stringify(args));
  }
  private selectedShell(){
    const s=this.shellSelection;
    if(!s)return null;
    const entry=this.byId.get(s.pid),k=this.shellKernel(),p=k.getProcess(s.pid);
    return entry?.ownerAnchor===this.host.identity.anchor&&p?.state==="running"&&k.fsVersion(s.pid,s.namespace)?{...s,root:p.root}:null;
  }
  private async shell(rest:string,spawnOnly=false):Promise<void>{
    const say=(text:string)=>this.host.say(text);
    if(!spawnOnly&&rest.startsWith("use ")){
      const [ref,namespace,...extra]=rest.slice(4).trim().split(/\s+/);
      const entry=this.resolve(ref),k=this.shellKernel();
      if(!entry||!namespace||extra.length||entry.ownerAnchor!==this.host.identity.anchor||!k.fsVersion(entry.id,namespace)){
        say("usage: /sh use <owned-process> <namespace-handle>");return;
      }
      this.shellSelection={pid:entry.id,namespace};say("shell selected: "+entry.name+" · "+namespace);return;
    }
    const selection=this.selectedShell();
    if(!selection){say("select an owned shell first: /sh use <process> <namespace-handle>");return;}
    const {pid,root,namespace}=selection;
    try{
      const segments=splitShell(rest);
      if(spawnOnly&&segments.length!==1)throw Error("/spawn accepts one pipeline");
      for(const source of segments){
        const k=this.shellKernel();
        if(k.getProcess(pid)?.state!=="running")break;
        const ctx=k.shellContext(pid),version=k.fsVersion(pid,namespace);
        if(!version)throw Error("namespace capability unavailable");
        const plan=parsePipeline(source,ctx),base={handle:root,namespaceHandle:namespace,baseRoot:version.root,rootVersion:version.version,shellVersion:ctx.version,source};
        if(CONFIG_COMMANDS.includes(plan.stages[0][0] as typeof CONFIG_COMMANDS[number])){
          if(spawnOnly)throw Error("configuration command cannot be spawned");
          const result=await this.shellCall(pid,"sh_config",base);
          if(!result?.outcome.ok)throw Error("shell configuration refused");
          continue;
        }
        const handles:string[]=[];
        const read=async(path:string|null,optional:boolean)=>{
          if(path===null)return {text:"",handle:null,version:null};
          // Verify the namespace snapshot and obtain an immutable read handle.
          const info=await this.shellCall(pid,"fs_stat",{handle:namespace,path,baseRoot:version.root,rootVersion:version.version});
          if(optional&&info?.outcome.ok===false&&info.outcome.errno==="ENOENT")return {text:"",handle:null,version:null};
          if(!info?.outcome.ok||(info.outcome.value as {kind:string}).kind!=="file")throw Error("input path absent or not a file");
          const opened=await this.shellCall(pid,"fs_open",{handle:namespace,path,baseRoot:version.root,rootVersion:version.version});
          if(!opened?.outcome.ok)throw Error("input open refused");
          const handle=(opened.outcome.value as {id:string}).id;handles.push(handle);
          if(!this.host.memory)throw Error("byte adapter unavailable");
          const {service}=await this.host.memory();
          const bytes=await service.get(()=>this.shellKernel(),pid,handle);
          if(!bytes)throw Error("input bytes unavailable");
          const text=new TextDecoder("utf-8",{fatal:true,ignoreBOM:true}).decode(bytes);
          if(!boundedText(text))throw Error("shell input exceeds byte limit");
          return {text,handle,version:this.shellKernel().handleVersion(pid,handle)??null};
        };
        let jobHandle:string|undefined;
        try{
          const input=await read(plan.input,false),append=await read(plan.output?.append?plan.output.path:null,true);
          const result=await this.shellCall(pid,"sh_spawn",{...base,input:input.text,inputHandle:input.handle,inputVersion:input.version,
            append:append.text,appendHandle:append.handle,appendVersion:append.version});
          if(!result?.outcome.ok)throw Error("spawn refused");
          jobHandle=(result.outcome.value as {handle:{id:string}}).handle.id;
        }finally{
          for(const handle of handles)await this.shellCall(pid,"mem_drop",{handle});
        }
        if(!jobHandle)throw Error("job allocation failed");
        say("job "+jobHandle+" queued");
        if(!spawnOnly)await this.jobCommand("fg",jobHandle);
      }
    }catch(e){say("shell: "+(e as Error).message);}
  }

  private async jobCommand(op:string,rest:string):Promise<void>{
    const say=(text:string)=>this.host.say(text),s=this.selectedShell();
    if(!s){say("select an owned shell first: /sh use <process> <namespace-handle>");return;}
    const pid=s.pid;
    if(op==="jobs"){
      if(rest){say("usage: /jobs");return;}
      for(const j of this.shellKernel().shellList(pid))say(j.handle+" · "+j.state+" · "+j.mode+" · stage "+j.stage+"/"+j.plan.stages.length+" · exit "+(j.exitCode??"-"));
      return;
    }
    const [handle,...extra]=rest.trim().split(/\s+/);
    if(!handle||extra.length){say("usage: /"+op+" <job-handle>");return;}
    let job=this.shellKernel().shellJob(pid,handle);
    if(!job){say("job missing or no live job capability");return;}
    if(op==="kill"){
      await this.shellCall(pid,"signal",{handle,target:job.pid,signal:"SIGTERM"});return;
    }
    if(op==="wait"){
      const receipt=await this.shellCall(pid,"sh_wait",{handle});
      if(receipt?.outcome.ok)say("job exit "+(receipt.outcome.value as {exitCode:number}).exitCode);
      return;
    }
    if(op==="bg"||op==="fg"){
      const result=await this.shellCall(pid,"sh_control",{handle,mode:op==="bg"?"background":"foreground"});
      if(!result?.outcome.ok)return;
      if(op==="bg"){say("background job ready; /exec "+handle+" advances one cooperative stage");return;}
    }
    if(op!=="fg"&&op!=="exec")return;
    const limit=op==="fg"?9:1;
    for(let i=0;i<limit;i++){
      job=this.shellKernel().shellJob(pid,handle);
      if(!job||this.shellKernel().getProcess(job.pid)?.state!=="running"){say("job is not running");return;}
      if(job.stage<job.plan.stages.length){
        const result=await this.shellCall(pid,"sh_step",{handle});
        if(!result?.outcome.ok)return;
        if(op==="exec")return;
        continue;
      }
      let descriptor=null,service:QosMemoryBytes|undefined;
      if(job.plan.output&&this.host.memory&&boundedText(job.append+job.output)){
        try{service=(await this.host.memory()).service;descriptor=await service.prepare(new TextEncoder().encode(job.append+job.output));}
        catch{say("redirection bytes unavailable; recording failure");}
      }
      try{
        const receipt=await this.shellCall(pid,"sh_finish",{handle,descriptor});
        if(receipt?.outcome.ok){
          const value=receipt.outcome.value as {output:string|null;exitCode:number;detail:string};
          if(value.output!==null&&value.output!=="")say(value.output);
          say("job exit "+value.exitCode+" · "+value.detail);
        }
      }finally{if(descriptor&&service)service.releaseStaged(descriptor.id);}
      return;
    }
  }

  /** OS-style process table is reconstructed from the canonical kernel replay. */
  private async ps(): Promise<void> {
    const replay = replayQosKernel(this.room.log.events(), this.room.log.forkedSources);
    const processes = replay.kernel.list();
    if (processes.length === 0) {
      this.host.say("no replayable QOS processes in this room — start one with `/qos start <name>`");
      if (replay.rejected.length) this.host.say(`  replay rejected ${replay.rejected.length} event(s)`);
      return;
    }
    this.host.say(`QOS process table (${processes.length}) — kernel replay:`);
    this.host.say("  PID | NAME | STATE | EVENTS | OWNER");
    for (const process of processes) {
      const entry = this.byId.get(process.pid);
      const events = this.room.log.eventsFor(process.pid).length;
      const owner = entry ? this.ownerLabel(entry) : process.owner;
      this.host.say(`  ${short(process.pid)} | ${process.name} | ${process.state} | ${events} | ${owner}`);
    }
    if (replay.rejected.length) this.host.say(`  replay rejected ${replay.rejected.length} event(s)`);
    this.host.say("  `/qos kill <name|id>` terminates (owner only).");
  }

  private async lifecycle(verb: "suspend" | "resume" | "terminate", rest: string): Promise<void> {
    const [refPart, ...reasonParts] = rest.split("|");
    const ref = refPart.trim();
    if (!ref) {
      this.host.say(`usage: /qos ${verb} <name|id> [| reason]`);
      return;
    }
    const entry = this.resolve(ref);
    if (!entry) {
      this.host.say(`no process named or identified by **${ref}** — \`/qos status\``);
      return;
    }
    const before = replayQosKernel(this.room.log.events(), this.room.log.forkedSources).kernel.getProcess(entry.id);
    const state = before?.state ?? "unknown";
    const displayState = state === "exited" || state === "reaped" ? "terminated" : state;
    const allowed = verb === "suspend" ? state === "running"
      : verb === "resume" ? state === "suspended"
      : state === "running" || state === "suspended";
    if (!allowed) {
      this.host.say(`cannot ${verb} **${entry.name}** from ${displayState}`);
      return;
    }
    const grant = this.room.findGrant(entry.id, this.host.identity.anchor);
    if (!grant) {
      this.host.say(`only the process owner can ${verb} **${entry.name}**`);
      return;
    }
    const reason = reasonParts.join("|").trim();
    const event = verb === "suspend"
      ? await this.room.suspend(entry.id, grant, reason || undefined)
      : verb === "resume"
        ? await this.room.resume(entry.id, grant, reason || undefined)
        : await this.room.terminate(entry.id, grant, reason || undefined);
    this.host.onSigned?.();
    this.saveJournal();
    const after = await this.room.view(entry.id);
    const done = verb === "suspend" ? "suspended" : verb === "resume" ? "resumed" : "terminated";
    this.host.say(`✓ **${entry.name}** ${done} — ${after.status} · ${event.hash.slice(0, 12)}… · digest ${short(after.stateDigest)}`);
  }

  private track(event: QosEvent, owner = event.source): TrackedProcess | null {
    if (event.type !== "process-start") return null;
    const existing = this.byId.get(event.process);
    if (existing) return existing;
    const name = typeof event.payload.name === "string" ? event.payload.name : event.process;
    const entry: TrackedProcess = {
      id: event.process, name, start: event, owner, ownerAnchor: event.source,
    };
    this.byId.set(entry.id, entry);
    if (!this.byName.has(name)) this.byName.set(name, entry.id);
    return entry;
  }

  private resolve(ref: string): TrackedProcess | null {
    const id = this.byId.has(ref) ? ref : this.byName.get(ref);
    return id ? this.byId.get(id) ?? null : null;
  }

  private ownerLabel(entry: TrackedProcess): string {
    return entry.owner === "you" ? "you" : this.label(entry.owner);
  }

  private label(source: string): string {
    return this.host.label?.(source) ?? `${source.slice(0, 12)}…`;
  }
}
