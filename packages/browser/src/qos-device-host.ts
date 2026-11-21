// Live host boundary: imported by command adapters, never by replay/kernel.
import {DEVICE_MAX_BYTES,deviceObservation,type DeviceRequest,type DeviceObservation,type DeviceKind} from "./qos-device.js";
import type {QosKernel} from "./qos-kernel.js";
import type {QosSocket} from "./posix-net.js";
export interface DeviceDriver {
 readonly kind:DeviceKind;
 perform(request:DeviceRequest,signal:AbortSignal):Promise<DeviceObservation>;
 close():void|Promise<void>;
}
export const deviceFailure=(errno:Extract<DeviceObservation,{ok:false}>["errno"],effect:"none"|"unknown"="none"):DeviceObservation=>({ok:false,errno,effect});
export const hexBytes=(hex:string)=>Uint8Array.from(hex.match(/../g)??[],n=>parseInt(n,16));
export const bytesHex=(bytes:Uint8Array)=>Array.from(bytes,b=>b.toString(16).padStart(2,"0")).join("");
export const bytesObservation=(bytes:Uint8Array,timestamp:string|null=null):DeviceObservation=>({ok:true,hex:bytesHex(bytes),count:bytes.length,timestamp});
const textBytes=(s:string)=>new TextEncoder().encode(s);
const textResult=(s:string,limit=DEVICE_MAX_BYTES)=>bytesObservation(textBytes(s).slice(0,limit));
type Lease={pid:string;handle:string;version:string;driver:DeviceDriver;abort:AbortController};
/** Local explicit binding, one lease per open handle. No auto-mount on replay. */
export class DeviceBroker{
 private leases=new Map<string,Lease>();
 private attempted=new Set<string>();
 hasLease(handle:string){return this.leases.has(handle);}
 async releaseAll(){
  const results=await Promise.allSettled([...this.leases.keys()].map(h=>this.release(h)));
  if(results.some(r=>r.status==="rejected"))throw Error("one or more device leases failed to close");
 }
 bind(current:()=>QosKernel,pid:string,handle:string,driver:DeviceDriver){
  const session=current().deviceSession(pid,handle);
  if(!session||!session.version||session.descriptor.kind!==driver.kind||this.leases.has(handle))return false;
  this.leases.set(handle,{pid,handle,version:session.version,driver,abort:new AbortController()});return true;
 }
 async release(handle:string){
  const lease=this.leases.get(handle);if(!lease)return;
  this.leases.delete(handle);lease.abort.abort();
  // Close must release the acquired resource. A driver close error is local;
  // do not claim the resource was released when the underlying host failed.
  await lease.driver.close();
 }
 async reconcile(current:()=>QosKernel){
  const stale=[...this.leases].filter(([handle,l])=>{const session=current().deviceSession(l.pid,handle);return !session||session.version!==l.version;});
  const results=await Promise.allSettled(stale.map(([handle])=>this.release(handle)));
  if(results.some(r=>r.status==="rejected"))throw Error("device release failed");
 }
 async perform(current:()=>QosKernel,pid:string,ticketId:string):Promise<DeviceObservation>{
  const ticket=current().deviceTicket(ticketId);
  if(!ticket||!current().deviceAuthorized(pid,ticketId))return deviceFailure("EACCES");
  if(this.attempted.has(ticketId))return deviceFailure("EINTR","unknown");
  this.attempted.add(ticketId);
  const lease=this.leases.get(ticket.handle);
  if(!lease||lease.pid!==pid||lease.version!==ticket.handleVersion)return deviceFailure("ENOTSUP");
  if(lease.abort.signal.aborted)return deviceFailure("EINTR");
  let result:DeviceObservation;
  try{
   const timeout=new AbortController();
   let timer:ReturnType<typeof setTimeout>|undefined;
   let onAbort:(()=>void)|undefined;
   try{
    const raw=await Promise.race([
      lease.driver.perform(ticket.request,AbortSignal.any([lease.abort.signal,timeout.signal])),
      new Promise<DeviceObservation>(resolve=>{onAbort=()=>resolve(deviceFailure("EINTR","unknown"));lease.abort.signal.addEventListener("abort",onAbort,{once:true});if(lease.abort.signal.aborted)onAbort();}),
      new Promise<DeviceObservation>(resolve=>{timer=setTimeout(()=>{timeout.abort();resolve(deviceFailure("EINTR","unknown"));},15000);})
    ]);
    result=deviceObservation(raw,ticket.request)??deviceFailure("EIO","unknown");
   }finally{if(timer!==undefined)clearTimeout(timer);if(onAbort)lease.abort.signal.removeEventListener("abort",onAbort);}
   if(timeout.signal.aborted){await this.release(ticket.handle).catch(()=>{});return deviceFailure("EINTR","unknown");}
  }catch{result=deviceFailure("EIO","unknown");}
  if(!current().deviceAuthorized(pid,ticketId)||lease.abort.signal.aborted)return deviceFailure("EACCES","unknown");
  return result;
 }
}
function countWritten(count:number):DeviceObservation{return {ok:true,hex:"",count,timestamp:null};}
/** Own one dedicated scratch file; never accepts host paths or existing file names. */
export function opfsBlockDriver(scope:string,deviceId:string):DeviceDriver{
 if(!/^[0-9a-f]{64}$/.test(scope)||!/^[0-9a-f]{64}$/.test(deviceId))throw Error("invalid OPFS device scope");
 let closed=false;
 return {kind:"opfs-block",close(){closed=true;},async perform(r,signal){
  if(closed||signal.aborted)return deviceFailure("EINTR");
  if(r.action==="ioctl")return r.code==="status"?textResult("opfs-block"):deviceFailure("ENOTSUP");
  const root=await navigator.storage.getDirectory();
  const room=await(await root.getDirectoryHandle("qos-device-v1",{create:true})).getDirectoryHandle(scope,{create:true});
  if(closed||signal.aborted)return deviceFailure("EINTR");
  if(r.action==="read"){
   try{const f=await(await room.getFileHandle(deviceId)).getFile();return bytesObservation(new Uint8Array(await f.slice(0,r.limit).arrayBuffer()));}
   catch(e){if((e as Error).name==="NotFoundError")return bytesObservation(new Uint8Array());throw e;}
  }
  const data=hexBytes(r.hex),file=await room.getFileHandle(deviceId,{create:true}),writer=await file.createWritable();
  try{
   if(closed||signal.aborted){await writer.abort();return deviceFailure("EINTR");}
   await writer.write(new Blob([Uint8Array.from(data)]));
   if(closed||signal.aborted){await writer.abort();return deviceFailure("EINTR");}
   await writer.close();return countWritten(data.length);
  }catch(e){await writer.abort().catch(()=>{});throw e;}
 }};
}
/** Explicitly supplied actual WASM or wrapper function; provenance stays in host observation. */
export function zfaDriver(evaluate:(bytes:Uint8Array)=>boolean,implementation="zfa-wrapper"):DeviceDriver{
 let closed=false;
 return {kind:"zfa",close(){closed=true;},async perform(r,signal){
  if(closed||signal.aborted)return deviceFailure("EINTR");
  if(r.action!=="ioctl")return deviceFailure("ENOTSUP");
  return r.code==="status"?textResult(implementation):textResult(evaluate(hexBytes(r.hex))?"true":"false");
 }};
}
/** Read-only status adapter. Constructor receives an explicitly selected URL;
 * no deploy key, write, arbitrary eval, or user-selected RPC method. */
export function rholoStatusDriver(url:string):DeviceDriver{
 const base=new URL(url);
 if(!["http:","https:"].includes(base.protocol)||base.username||base.password||base.search||base.hash)throw Error("invalid node endpoint");
 let closed=false;
 return {kind:"rholo-status",close(){closed=true;},async perform(r,signal){
  if(closed||signal.aborted)return deviceFailure("EINTR");
  if(r.action==="write"||r.action==="ioctl"&&r.code!=="status")return deviceFailure("ENOTSUP");
  const response=await fetch(base.toString().replace(/\/+$/,"")+"/api/status",{signal,redirect:"error",credentials:"omit"});
  if(!response.ok||!response.body)return deviceFailure("EIO");
  const reader=response.body.getReader();let total=0;const chunks:Uint8Array[]=[];
  try{while(true){const next=await reader.read();if(next.done)break;total+=next.value.length;if(total>16384){await reader.cancel();return deviceFailure("EIO");}chunks.push(next.value);}}
  finally{reader.releaseLock();}
  const bytes=new Uint8Array(total);let offset=0;for(const part of chunks){bytes.set(part,offset);offset+=part.length;}
  const status=JSON.parse(new TextDecoder().decode(bytes)) as Record<string,unknown>;
  const selected:Record<string,unknown>={};
  for(const k of ["networkId","shardId","latestBlockNumber","peers"]){const v=status[k];if(typeof v==="number"||typeof v==="string"&&v.length<=128)selected[k]=v;}
  return textResult(JSON.stringify(selected),r.action==="read"?r.limit:DEVICE_MAX_BYTES);
 }};
}
/** A donated, dedicated RTC data channel. Never opens one from a room address. */
export function dataChannelDriver(channel:RTCDataChannel):DeviceDriver{
 let closed=false,overflow=false;const queue:Uint8Array[]=[];
 const receive=(event:MessageEvent)=>{
  const b=typeof event.data==="string"?textBytes(event.data):event.data instanceof ArrayBuffer?new Uint8Array(event.data):null;
  if(!b||b.length>DEVICE_MAX_BYTES||queue.length>=16){overflow=true;return;}queue.push(Uint8Array.from(b));
 };
 channel.binaryType="arraybuffer";channel.addEventListener("message",receive);
 return {kind:"data-channel",close(){if(closed)return;closed=true;channel.removeEventListener("message",receive);queue.length=0;channel.close();},async perform(r,signal){
  if(closed||signal.aborted)return deviceFailure("EINTR");
  if(r.action==="ioctl")return r.code==="status"?textResult(channel.readyState):deviceFailure("ENOTSUP");
  if(r.action==="write"){if(channel.readyState!=="open"||channel.bufferedAmount>65536)return deviceFailure("EAGAIN");const b=hexBytes(r.hex);channel.send(Uint8Array.from(b));return countWritten(b.length);}
  if(overflow){overflow=false;return deviceFailure("EIO");}
  const b=queue[0];if(!b)return deviceFailure("EAGAIN");if(b.length>r.limit)return deviceFailure("EINVAL");queue.shift();return bytesObservation(b);
 }};
}
/** Ownership of this pre-authorized track is transferred to the lease. Metadata only, no capture prompt. */
export function mediaTrackDriver(track:MediaStreamTrack):DeviceDriver{
 let closed=false;
 return {kind:"media-track",close(){if(!closed){closed=true;track.stop();}},async perform(r,signal){
  if(closed||signal.aborted)return deviceFailure("EINTR");
  if(r.action==="write"||r.action==="ioctl"&&r.code!=="status")return deviceFailure("ENOTSUP");
  const s=track.getSettings();
  return textResult(JSON.stringify({kind:track.kind,readyState:track.readyState,enabled:track.enabled,muted:track.muted,
    width:s.width??null,height:s.height??null,sampleRate:s.sampleRate??null}),r.action==="read"?r.limit:DEVICE_MAX_BYTES);
 }};
}
/** Dedicated existing POSIX-style mesh socket, not an ambient host socket. */
export function meshSocketDriver(socket:QosSocket):DeviceDriver{
 let closed=false,ended=false,overflow=false;const queue:Uint8Array[]=[];
 if(socket.onData||socket.onClose)throw Error("socket already owned");
 socket.onData=payload=>{if(!/^(?:[0-9a-f]{2})*$/.test(payload)||payload.length>DEVICE_MAX_BYTES*2||queue.length>=16){overflow=true;return;}queue.push(hexBytes(payload));};
 socket.onClose=()=>{ended=true;};
 return {kind:"mesh-socket",close(){if(!closed){closed=true;socket.onData=null;socket.onClose=null;queue.length=0;socket.close();}},async perform(r,signal){
  if(closed||signal.aborted)return deviceFailure("EINTR");
  if(r.action==="ioctl")return r.code==="status"?textResult(ended?"closed":"open"):deviceFailure("ENOTSUP");
  if(r.action==="write"){if(ended||!socket.send(r.hex))return deviceFailure("EAGAIN");return countWritten(r.hex.length/2);}
  if(overflow){overflow=false;return deviceFailure("EIO");}
  const b=queue[0];if(!b)return ended?bytesObservation(new Uint8Array()):deviceFailure("EAGAIN");
  if(b.length>r.limit)return deviceFailure("EINVAL");queue.shift();return bytesObservation(b);
 }};
}
