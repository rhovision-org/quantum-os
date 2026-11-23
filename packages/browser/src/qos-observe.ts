// #285: bounded inspection and verified journal snapshots. No host I/O.
import {QosEventLog,canonicalJson,sha256Hex,parseQosEvent,canonicalEventOrder,type QosEvent} from "./qos-process.js";
import {replayQosKernel,type QosKernelReplayResult} from "./qos-kernel.js";
export const MAX_TRACE=128, MAX_SNAPSHOT_BYTES=2*1024*1024;
export type KernelSnapshot={schema:"qos.snapshot/1";room:string;events:QosEvent[];digest:string;id:string};
export const recoveryName=(x:string)=>/^[a-zA-Z0-9_-]{1,40}$/.test(x);
const bounded=(x:unknown)=>new TextEncoder().encode(JSON.stringify(x)).length<=MAX_SNAPSHOT_BYTES;
export async function createSnapshot(log:QosEventLog):Promise<KernelSnapshot>{
 const events=log.checkpointEvents();
 if(!bounded(events))throw Error("snapshot exceeds byte limit");
 const verified=await readEvidence(log.roomId,events);
 const body={schema:"qos.snapshot/1" as const,room:log.roomId,events,digest:await verified.kernel.stateDigest()};
 return {...body,id:await sha256Hex(canonicalJson(body))};
}
async function readEvidence(room:string,events:QosEvent[]){
 const log=new QosEventLog(room);
 for(const input of events){
  const event=parseQosEvent(input);if(!event)throw Error("invalid snapshot event");
  const admission=await log.ingest(event);if(!admission.ok||admission.duplicate)throw Error("snapshot admission conflict or duplicate");
 }
 const result=replayQosKernel(log.events(),log.forkedSources);
 if(log.forkedSources.size||result.rejected.length||result.pendingSyscalls.length||result.missingDependencies.length||result.cyclicHashes.length)
  throw Error("snapshot is not a clean completed causal cut");
 return result;
}
export async function verifySnapshot(value:unknown,room:string):Promise<KernelSnapshot>{
 if(!value||typeof value!=="object"||Array.isArray(value)||!bounded(value))throw Error("invalid snapshot size or shape");
 const s=JSON.parse(JSON.stringify(value)) as KernelSnapshot;
 if(Object.keys(s).length!==5||s.schema!=="qos.snapshot/1"||s.room!==room||!Array.isArray(s.events)||!(/^[0-9a-f]{64}$/).test(s.id)||!(/^[0-9a-f]{64}$/).test(s.digest))throw Error("invalid snapshot envelope");
 const {id,...body}=s;if(await sha256Hex(canonicalJson(body))!==id)throw Error("snapshot identity mismatch");
 const result=await readEvidence(room,s.events);
 if(await result.kernel.stateDigest()!==s.digest)throw Error("snapshot state digest mismatch");
 return s;
}
export function traceRows(events:QosEvent[],replay:QosKernelReplayResult,limit=32,filter?:string){
 const outcomes=new Map(replay.syscalls.map(t=>[t.resultHash,t]));
 const rejected=new Map(replay.rejected.map(t=>[t.hash,t.reason]));
 const applied=new Set(replay.applied);
 return canonicalEventOrder(events).ordered.map((e,position)=>{
  const t=outcomes.get(e.hash);
  return {position,hash:e.hash,type:e.type,caller:e.process,op:t?.op??(e.type==="syscall-request"?e.payload.op:null),
   handle:t?.args.handle??null,result:t?.outcome.ok?t.outcome.value:null,errno:t&&!t.outcome.ok?t.outcome.errno:null,
   status:rejected.has(e.hash)?"rejected":applied.has(e.hash)?"applied":"other",reason:rejected.get(e.hash)??null};
 }).filter(x=>!filter||x.caller===filter).slice(-Math.max(1,Math.min(MAX_TRACE,limit)));
}
