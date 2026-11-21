import assert from "node:assert/strict";
import {build} from "esbuild";
import {fileURLToPath} from "node:url";
import {dirname,join} from "node:path";
const root=join(dirname(fileURLToPath(import.meta.url)),"..");
const bundle=await build({stdin:{contents:`
 export {QosCommand} from "./src/qos-command.ts";
 export {QOS_RIGHTS,replayQosKernel} from "./src/qos-kernel.ts";
 export {QosEventLog} from "./src/qos-process.ts";
 export {newDynCapState} from "./src/dyncap.ts";
 export {DeviceBroker,bytesObservation,hexBytes,meshSocketDriver,zfaDriver,deviceFailure} from "./src/qos-device-host.ts";
 export {deviceRequest,deviceObservation} from "./src/qos-device.ts";
`,resolveDir:root,loader:"ts",sourcefile:"device-test.ts"},bundle:true,format:"esm",platform:"node",write:false});
const {QosCommand,QOS_RIGHTS:R,replayQosKernel,QosEventLog,newDynCapState,DeviceBroker,bytesObservation,hexBytes,meshSocketDriver,zfaDriver,deviceFailure,deviceRequest,deviceObservation}=await import("data:text/javascript;base64,"+Buffer.from(bundle.outputFiles[0].text).toString("base64"));
const roomId="cap:room:03010563656127610341634101250325";
const ia=await newDynCapState(new Uint8Array(32).fill(150)),ib=await newDynCapState(new Uint8Array(32).fill(151));
let calls=0,closes=0,fail=false,contents=new Uint8Array(),delayed=null;
const makeBlock=()=>({kind:"opfs-block",async perform(r,signal){
 calls++;
 if(delayed){delayed.enter();await delayed.gate;}
 if(signal.aborted)return deviceFailure("EINTR");
 if(fail)throw Error("injected device failure");
 if(r.action==="read")return bytesObservation(contents.slice(0,r.limit),"opaque-camera-clock:123");
 if(r.action==="write"){contents=hexBytes(r.hex);return {ok:true,hex:"",count:contents.length,timestamp:null};}
 return bytesObservation(new TextEncoder().encode("ready"));
},close(){closes++;}});
const saved={a:null,b:null},lines={a:[],b:[]};
const make=(tag,identity,enabled=true)=>new QosCommand({roomId,identity,transport:{broadcast:()=>{}},say:s=>lines[tag].push(s),
 deviceDriver:async d=>enabled&&d.kind==="opfs-block"?makeBlock():null,
 loadJournal:()=>saved[tag],saveJournal:events=>{saved[tag]=JSON.parse(JSON.stringify(events));}});
let a=make("a",ia),b=make("b",ib);
const replay=c=>replayQosKernel(c.room.log.events(),c.room.log.forkedSources),k=c=>replay(c).kernel;
const sync=async(src,dst)=>{for(const e of src.room.log.checkpointEvents())await dst.ingest("peer",e);};
const both=async()=>{await sync(a,b);await sync(b,a);};
const run=async(c,line,op)=>{
 const before=new Set(replay(c).syscalls.map(t=>t.resultHash));
 await c.handle(line);
 const fresh=replay(c).syscalls.filter(t=>!before.has(t.resultHash));
 if(op){const t=fresh.find(x=>x.op===op);assert.ok(t,op+" missing: "+lines.a.concat(lines.b).slice(-8).join("\n"));return t;}
 return fresh;
};
const q=(c,ref,op,args)=>run(c,"syscall "+ref+" | "+op+" | "+JSON.stringify(args),op);
const val=t=>{assert.ok(t.outcome.ok,JSON.stringify(t.outcome));return t.outcome.value;};
let count=0;
function check(name,c){assert.ok(c,name);count++;console.log("PASS: "+name);}
await a.handle("start alice");await b.handle("start bob");await both();
const pa=a.list().find(p=>p.name==="alice"),pb=b.list().find(p=>p.name==="bob"),pid=pa.id,bid=pb.id;
const bad=await run(b,"dev open bob "+k(b).getProcess(bid).root+" 1","dev_open");
check("ambient root is not a device grant",bad.outcome.errno==="EACCES"&&calls===0);
await both();
const defined=val(await run(a,"dev define alice opfs-block 3","dev_define")),grant=defined.handle.id;
await both();
const foreign=await run(b,"dev open bob "+grant+" 1","dev_open");
check("known foreign grant cannot be opened",!foreign.outcome.ok&&calls===0);
await both();
const ro=val(await run(a,"dev grant alice "+grant+" "+bid+" 1","dev_grant")).id;
await both();
const denied=await run(b,"dev open bob "+ro+" 3","dev_open");
check("grant cannot be widened on open",denied.outcome.errno==="EACCES");
const bs=val(await run(b,"dev open bob "+ro+" 1","dev_open")).handle.id;
const writeDenied=await run(b,"dev write bob "+bs+" | 00","dev_request");
check("read-only session cannot dispatch write",writeDenied.outcome.errno==="EACCES"&&calls===0);
await both();
const as=val(await run(a,"dev open alice "+grant+" 3","dev_open")).handle.id;
const unbound=val(await run(a,"dev read alice "+as+" 8","dev_observe"));
check("unbound device produces recorded errno",unbound.observation.errno==="ENOTSUP"&&calls===0);
await run(a,"dev bind alice "+as);
check("host binding is explicit and not a driver invocation",calls===0);
const beforeTick=k(a).scheduleView().tick;
const written=val(await run(a,"dev write alice "+as+" | 00ff6162","dev_observe"));
check("actual driver consumes bounded binary request once",written.observation.ok&&written.observation.count===4&&calls===1);
const read=val(await run(a,"dev read alice "+as+" 4","dev_observe"));
check("raw byte observation recorded after driver request",read.observation.hex==="00ff6162"&&calls===2);
check("opaque device timestamp does not advance logical scheduler",read.observation.timestamp==="opaque-camera-clock:123"&&beforeTick===k(a).scheduleView().tick);
const repeat=await q(a,"alice","dev_observe",{ticket:read.id,observation:read.observation});
check("duplicate observation cannot commit",repeat.outcome.errno==="EINVAL");
fail=true;
const failed=val(await run(a,"dev read alice "+as+" 4","dev_observe"));
check("driver failure recorded as errno, no local-only crash",failed.observation.errno==="EIO"&&failed.observation.effect==="unknown");
fail=false;
const pending=val(await q(a,"alice","dev_request",{handle:as,request:{action:"read",limit:4}}));
const digest=await k(a).stateDigest(),countBefore=calls;
a=make("a",ia,false);await a.handle("whoami");
check("reload does not dispatch historical or pending I/O",calls===countBefore&&await k(a).stateDigest()===digest);
const busy=await run(a,"dev read alice "+as+" 4","dev_request");
check("unresolved request blocks another dispatch on same session",busy.outcome.errno==="EAGAIN");
const abandoned=val(await run(a,"dev abandon alice "+pending.id,"dev_observe"));
check("lost request is explicitly unknown, not retried",abandoned.observation.errno==="EINTR"&&abandoned.observation.effect==="unknown"&&calls===countBefore);
// Fresh local adapter, then close; resource release is separate from pure replay.
a=make("a",ia,true);await run(a,"dev bind alice "+as);
await run(a,"dev close alice "+as,"dev_close");
check("logical close releases bound driver exactly once",closes===1&&!k(a).deviceSession(pid,as));
await both();
// Revocation of grant invalidates the open descendant on the other peer.
await run(b,"dev bind bob "+bs);const priorClose=closes;
val(await q(a,"alice","cap_revoke",{handle:grant}));await both();
check("cross-peer kernel revocation releases donated driver",closes===priorClose+1&&!k(b).deviceSession(bid,bs));
const events=a.room.log.checkpointEvents(),f=new QosEventLog(roomId),r=new QosEventLog(roomId);
for(const e of events)assert.ok((await f.ingest(e)).ok);
for(const e of [...events].reverse())assert.ok((await r.ingest(e)).ok);
const cf=replayQosKernel(f.events(),f.forkedSources),cr=replayQosKernel(r.events(),r.forkedSources);
check("reverse replay requires no driver and preserves digest and observations",await cf.kernel.stateDigest()===await cr.kernel.stateDigest()&&calls===countBefore&&JSON.stringify(cf.rejected)===JSON.stringify(cr.rejected));
check("ioctl validation bounds opcodes, input and observation bytes",
 !deviceRequest({action:"ioctl",code:"execute",hex:"00"})&&!deviceRequest({action:"read",limit:4097})&&!deviceObservation({ok:true,hex:"0001",count:2,timestamp:null},{action:"read",limit:1}));
const frames=[];let socketClosed=0;
const socket={connId:"s",peerId:"other",type:"stream",port:7,onData:null,onClose:null,send(x){frames.push(x);return true;},close(){socketClosed++;}};
const stream=meshSocketDriver(socket);
const signal=new AbortController().signal;
const sw=await stream.perform({action:"write",hex:"00ff"},signal);
socket.onData("abcdef");const sr=await stream.perform({action:"read",limit:3},signal);
check("mesh stream adapter uses same byte observation contract",sw.ok&&sw.count===2&&frames[0]==="00ff"&&sr.hex==="abcdef");
stream.close();check("stream lease releases socket callbacks",socketClosed===1&&socket.onData===null&&socket.onClose===null);
const z=zfaDriver(b=>b.length===2&&b[0]===0&&b[1]===1);
const zr=await z.perform({action:"ioctl",code:"zfa",hex:"0001"},signal);
check("ZFA ioctl passes bounded twists to explicit evaluator",zr.ok&&new TextDecoder().decode(hexBytes(zr.hex))==="true");
console.log("PASS: qos-device.test.mjs — "+count+" checks");
