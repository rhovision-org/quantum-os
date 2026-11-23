// Disposable bundled Rholo only. No deploy capability, key, eval or writes.
// Fresh independent reader is prohibited from any host I/O during replay.
import assert from "node:assert/strict";
import {build} from "esbuild";
import {readFile,writeFile} from "node:fs/promises";
import {dirname,join} from "node:path";
import {fileURLToPath,pathToFileURL} from "node:url";
assert.equal(process.env.GITHUB_ACTIONS,"true");
const dir=process.env.QOS_MEMORY_WITNESS_DIR,mode=process.argv[2];
assert.ok(dir&&process.env.RUNNER_TEMP&&dir.startsWith(process.env.RUNNER_TEMP+"/"));
assert.ok(mode==="publish"||mode==="recover");
const root=join(dirname(fileURLToPath(import.meta.url)),"..");
const bundle=await build({stdin:{contents:`
 export {QosCommand} from "./src/qos-command.ts";
 export {QosEventLog} from "./src/qos-process.ts";
 export {replayQosKernel} from "./src/qos-kernel.ts";
 export {newDynCapState} from "./src/dyncap.ts";
 export {rholoStatusDriver} from "./src/qos-device-host.ts";
`,resolveDir:root,loader:"ts",sourcefile:"device-rholo-witness.ts"},bundle:true,format:"esm",platform:"node",write:false});
const path=join(dir,"device-"+mode+".mjs");await writeFile(path,bundle.outputFiles[0].text,{mode:0o600,flag:"wx"});
const {QosCommand,QosEventLog,replayQosKernel,newDynCapState,rholoStatusDriver}=await import(pathToFileURL(path).href);
const endpoint="http://127.0.0.1:40403",roomId="cap:room:03010563656127610341634101250325";
const realFetch=globalThis.fetch,requests=[];
globalThis.fetch=async(input,init)=>{
 const url=typeof input==="string"?input:input instanceof URL?input.href:input.url;
 const method=init?.method??"GET";
 assert.equal(mode,"publish","replay attempted external I/O");
 assert.equal(url,endpoint+"/api/status");assert.equal(method,"GET");
 assert.equal(init?.credentials,"omit");assert.equal(init?.redirect,"error");
 requests.push({method,path:"/api/status"});return realFetch(input,init);
};
const checkpoint=join(dir,"device-checkpoint.json");
if(mode==="publish"){
 const status=await(await realFetch(endpoint+"/api/status")).json();
 assert.equal(status.shardId,"/root");assert.ok(status.networkId);
 const identity=await newDynCapState(new Uint8Array(32).fill(154));
 let events;
 const q=new QosCommand({roomId,identity,transport:{broadcast:()=>{}},say:()=>{},
   deviceDriver:async d=>d.kind==="rholo-status"?rholoStatusDriver(endpoint):null,
   saveJournal:e=>{events=e;}});
 const replay=()=>replayQosKernel(q.room.log.events(),q.room.log.forkedSources);
 const run=async(line,op)=>{
   const before=new Set(replay().syscalls.map(t=>t.resultHash));await q.handle(line);
   if(!op)return;
   const t=replay().syscalls.find(t=>t.op===op&&!before.has(t.resultHash));assert.ok(t,op);
   return t.outcome;
 };
 await run("start node");
 const d=await run("dev define node rholo-status 1","dev_define");assert.ok(d.ok);
 const opened=await run("dev open node "+d.value.handle.id+" 1","dev_open");assert.ok(opened.ok);
 const handle=opened.value.handle.id;
 await run("dev bind node "+handle);
 const write=await run("dev write node "+handle+" | 00","dev_request");assert.ok(!write.ok);assert.equal(requests.length,0);
 const read=await run("dev ioctl node "+handle+" status","dev_observe");
 assert.ok(read.ok&&read.value.observation.ok,JSON.stringify(read));
 const observed=JSON.parse(Buffer.from(read.value.observation.hex,"hex").toString());
 assert.equal(observed.networkId,status.networkId);assert.equal(observed.shardId,status.shardId);
 assert.equal(requests.length,1);
 await run("dev close node "+handle,"dev_close");
 assert.equal(replay().rejected.length,0);
 await writeFile(checkpoint,JSON.stringify({events,digest:await replay().kernel.stateDigest(),observation:read.value.observation,networkId:status.networkId,shardId:status.shardId,requests}),{mode:0o600,flag:"wx"});
 console.log("PASS: capability-gated actual Rholo GET status; write refused before dispatch");
}else{
 const saved=JSON.parse(await readFile(checkpoint,"utf8"));
 const log=new QosEventLog(roomId);
 for(const e of [...saved.events].reverse())assert.ok((await log.ingest(e)).ok);
 const result=replayQosKernel(log.events(),log.forkedSources);
 assert.equal(result.rejected.length,0);assert.equal(await result.kernel.stateDigest(),saved.digest);
 const t=result.syscalls.find(t=>t.op==="dev_observe");
 assert.deepEqual(t.outcome.value.observation,saved.observation);assert.equal(requests.length,0);
 await writeFile(join(dir,"evidence.json"),JSON.stringify({schema:"qos.device.rholo-witness/1",run_id:process.env.GITHUB_RUN_ID,network_id:saved.networkId,shard_id:saved.shardId,observation:saved.observation,recorded_requests:saved.requests,reader_rpc_count:0,reverse_replay_digest_match:true,write_refused:true,verdict:"PASS",scope:"Disposable bundled Rholo read-only /api/status; no arbitrary deploy/eval or public network"},null,2)+"\n",{mode:0o600,flag:"wx"});
 console.log("PASS: independent reverse replay matches observation and digest with zero RPC");
}
