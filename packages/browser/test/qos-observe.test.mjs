import assert from "node:assert/strict";
import {build} from "esbuild";
import {fileURLToPath} from "node:url";
import {dirname,join} from "node:path";
const root=join(dirname(fileURLToPath(import.meta.url)),"..");
const bundle=await build({stdin:{contents:`
 export {QosCommand} from "./src/qos-command.ts";
 export {QosKernel,QOS_RIGHTS,replayQosKernel,previewCanonicalSyscall} from "./src/qos-kernel.ts";
 export {QosEventLog,canonicalJson,sha256Hex} from "./src/qos-process.ts";
 export {newDynCapState} from "./src/dyncap.ts";
 export {createSnapshot,verifySnapshot,traceRows} from "./src/qos-observe.ts";
`,resolveDir:root,loader:"ts",sourcefile:"observe-test.ts"},bundle:true,format:"esm",platform:"node",write:false});
const {QosCommand,QosKernel,QOS_RIGHTS:R,replayQosKernel,previewCanonicalSyscall,QosEventLog,canonicalJson,sha256Hex,newDynCapState,createSnapshot,verifySnapshot,traceRows}=await import("data:text/javascript;base64,"+Buffer.from(bundle.outputFiles[0].text).toString("base64"));
let checks=0;const check=(name,c)=>{assert.ok(c,name);checks++;console.log("PASS: "+name);};
const roomId="cap:room:03010563656127610341634101250325",identity=await newDynCapState(new Uint8Array(32).fill(170));
let journal=null,broadcast=0,hostCalls=0;const saved=new Map(),lines=[];
const make=()=>new QosCommand({roomId,identity,transport:{broadcast:()=>{broadcast++;}},say:s=>lines.push(s),
 deviceDriver:async()=>{hostCalls++;throw Error("driver must not be invoked");},
 memory:async()=>{hostCalls++;throw Error("byte adapter must not be invoked");},
 loadJournal:()=>journal,saveJournal:e=>{journal=JSON.parse(JSON.stringify(e));},loadSnapshot:n=>saved.get(n),saveSnapshot:(n,s)=>saved.set(n,JSON.parse(JSON.stringify(s)))});
let q=make();
const replay=()=>replayQosKernel(q.room.log.events(),q.room.log.forkedSources),k=()=>replay().kernel;
const call=async(line,op)=>{
 const before=new Set(replay().syscalls.map(t=>t.resultHash));await q.handle(line);
 if(!op)return;const t=replay().syscalls.find(t=>t.op===op&&!before.has(t.resultHash));
 assert.ok(t,op+" missing "+lines.slice(-4).join("\n"));return t.outcome;
};
const val=r=>{assert.ok(r.ok,JSON.stringify(r));return r.value;};
await call("start lab");const pid=q.list()[0].id,handle=k().getProcess(pid).root;
const h=val(await call("syscall lab | cap_derive | "+JSON.stringify({handle,rights:R.READ}),"cap_derive")).id;
const refusal=await call("syscall lab | cap_derive | "+JSON.stringify({handle:h,rights:R.WRITE}),"cap_derive");
assert.equal(refusal.errno,"EACCES");
const before=await k().stateDigest(),eventsBefore=JSON.stringify(q.room.log.checkpointEvents()),b0=broadcast;
for(const c of ["top","dmesg","trace lab","stat lab"])await call(c);
check("inspection emits no journal events, host I/O or digest mutation",await k().stateDigest()===before&&JSON.stringify(q.room.log.checkpointEvents())===eventsBefore&&broadcast===b0&&hostCalls===0);
const rows=traceRows(q.room.log.events(),replay(),128);
check("canonical trace includes lifecycle, caller, handle, result and refusal errno",rows.some(x=>x.type==="process-start")&&rows.some(x=>x.op==="cap_derive"&&x.handle===h&&x.errno==="EACCES")&&rows.some(x=>x.op==="cap_derive"&&x.result?.id===h)&&rows.every((x,i)=>i===0||rows[i-1].position<x.position));
await call("snapshot cut");const snap=saved.get("cut");assert.ok(snap);
check("snapshot checksum and replay digest verify",(await verifySnapshot(snap,roomId)).digest===before);
const changed=JSON.parse(JSON.stringify(snap));changed.digest="0".repeat(64);
await assert.rejects(verifySnapshot(changed,roomId),/identity mismatch/);
const {id,...body}=changed;changed.id=await sha256Hex(canonicalJson(body));
await assert.rejects(verifySnapshot(changed,roomId),/state digest mismatch/);
check("tampered checksum and independently recomputed false digest refused",true);
await call("syscall lab | cap_close | "+JSON.stringify({handle:h}),"cap_close");
const original=JSON.stringify(q.room.log.checkpointEvents()),liveDigest=await k().stateDigest(),b1=broadcast,seq=identity.seqByRoom[roomId];
assert.notEqual(liveDigest,before);
await call("restore cut");
check("restored clean cut matches original snapshot digest",lines.some(x=>x.startsWith("restored branch cut")&&x.includes(before)));
await call("branch cut | syscall lab | cap_derive | "+JSON.stringify({handle,rights:R.READ}));
await call("branch cut | top");
check("isolated continuation executes new canonical syscall",lines.some(x=>x.startsWith("[branch cut] syscall cap_derive OK"))&&identity.seqByRoom[roomId]>seq);
await call("branch cut | dev bind lab unknown");
check("branch cannot dispatch external I/O",lines.at(-1).includes("not in isolated replay allowlist")&&hostCalls===0);
check("restore and continuation leave original journal and digest unchanged",JSON.stringify(q.room.log.checkpointEvents())===original&&await k().stateDigest()===liveDigest&&broadcast===b1);
q=make();await call("whoami");await call("restore cut");
check("saved snapshot restores after controller reload",lines.at(-1).startsWith("restored branch cut")&&lines.at(-1).includes(before));
const f=new QosEventLog(roomId);for(const e of [...snap.events].reverse())assert.ok((await f.ingest(e)).ok);
check("reverse trace replay reproduces same digest",await replayQosKernel(f.events(),f.forkedSources).kernel.stateDigest()===snap.digest);
// Focused atomic quota checks: generate real canonical journal receipts for
// a short bytes quota path, then exercise the exact kernel preview at the
// handle/call thresholds without producing hundreds of cryptographic events.
for(let i=1;i<=4;i++){
 const descriptor={id:i.toString(16).padStart(64,"0"),size:65536,locator:null};
 val(await call("syscall lab | mem_put | "+JSON.stringify({handle,descriptor}),"mem_put"));
}
const full=await k().stateDigest(),fullTable=JSON.stringify(k().list());
const overflow=await call("syscall lab | mem_put | "+JSON.stringify({handle,descriptor:{id:"5".padStart(64,"0"),size:1,locator:null}}),"mem_put");
check("byte quota ENOSPC is journaled without partial object or handle",overflow.errno==="ENOSPC"&&await k().stateDigest()===full&&JSON.stringify(k().list())===fullTable);
const direct=new QosKernel(),p=direct.createProcess({name:"quota",owner:"test",pid:"quota"}).value;
for(let i=1;i<QosKernel.QUOTA.handles;i++)assert.ok(direct.capDerive(p.pid,p.root,R.READ).ok);
const raw={schema:"qos.syscall/1",caller:p.pid,op:"cap_derive",args:{handle:p.root,rights:R.READ}};
const old=await direct.stateDigest(),result=previewCanonicalSyscall(direct,raw,p.pid,"a".repeat(64));
check("handle quota refuses allocation without changing source kernel",result.errno==="ENOSPC"&&await direct.stateDigest()===old);
const countKernel=new QosKernel();countKernel.createProcess({name:"budget",owner:"test",pid:"budget"});
for(let i=0;i<QosKernel.QUOTA.calls;i++)assert.ok(countKernel.quotaAfter(countKernel.quotaView(),"budget","cap_derive").ok);
check("committed mutation budget returns EAGAIN while cleanup remains allowed",countKernel.quotaBefore("budget","cap_derive").errno==="EAGAIN"&&countKernel.quotaBefore("budget","cap_close").ok);
console.log("PASS: qos-observe.test.mjs — "+checks+" checks");
