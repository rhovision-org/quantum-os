// Real bundled Rholo witness, restricted to a fresh GitHub runner and loopback.
// The second invocation has neither the source bytes nor the publisher's RAM.
import {build} from "esbuild";
import {fileURLToPath,pathToFileURL} from "node:url";
import {dirname,join} from "node:path";
import {readFile,writeFile} from "node:fs/promises";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {DaemonMemoryByteCache} from "../../../scripts/qos-cli/memory-byte-cache.mjs";
assert.equal(process.env.GITHUB_ACTIONS,"true","CI-only");
const dir=process.env.QOS_MEMORY_WITNESS_DIR;
assert.ok(dir && process.env.RUNNER_TEMP && dir.startsWith(process.env.RUNNER_TEMP+"/"),"runner-local witness directory required");
const mode=process.argv[2];
assert.ok(mode==="publish"||mode==="recover");
const NODE="http://127.0.0.1:40403";
const status=await (await fetch(NODE+"/api/status",{signal:AbortSignal.timeout(5000)})).json();
assert.ok(status.shardId && status.networkId,"missing node identity");
assert.equal(status.shardId,"/root","unexpected disposable shard");
const network="witness/loopback/root";
const root=join(dirname(fileURLToPath(import.meta.url)),"..");
const bundle=await build({stdin:{contents:`
 export {QosMemoryBytes,objectIdentity} from "./src/qos-memory-bytes.ts";
 export {RholoRegistryMemory} from "./src/qos-memory-rholo.ts";
 export {replayQosKernel,previewCanonicalSyscall} from "./src/qos-kernel.ts";
 export {QosEventLog,QosProcessRoom} from "./src/qos-process.ts";
 export {newDynCapState} from "./src/dyncap.ts";
`,resolveDir:root,loader:"ts",sourcefile:"rholo-memory-witness.ts"},bundle:true,format:"esm",platform:"node",write:false});
// A named bundle keeps subsequent stack traces short and preserves the reason.
const bundlePath=join(dir,"witness-"+mode+".mjs");
await writeFile(bundlePath,bundle.outputFiles[0].text,{mode:0o600,flag:"wx"});
const {QosMemoryBytes,objectIdentity,RholoRegistryMemory,replayQosKernel,previewCanonicalSyscall,QosEventLog,QosProcessRoom,newDynCapState}=await import(pathToFileURL(bundlePath).href);
// Browser transport retains the nonce in localStorage; this process-private
// shim performs no persistence and does not print the disposable key.
const configStore=new Map();
Object.defineProperty(globalThis,"localStorage",{value:{getItem:k=>configStore.get(k)??null,setItem:(k,v)=>configStore.set(k,v)}});
const roomId="cap:room:03010563656127610341634101250325";
const scope=createHash("sha256").update(roomId).digest("hex");
const cache=new DaemonMemoryByteCache(dir,scope);
const cfg={url:NODE,shard:status.shardId,phloLimit:8_000_000,phloPrice:1};
const replay=log=>replayQosKernel(log.events(),log.forkedSources);
const checkpoint=join(dir,"journal.json");
if(mode==="publish"){
  const pk=await readFile(new URL("../../../scripts/localnet/pk.txt",import.meta.url),"utf8");
  const key=pk.split("\n").find(l=>l.startsWith("deployer="))?.split("=")[1]?.trim();
  assert.match(key??"",/^[0-9a-f]{64}$/i);
  const backend=new RholoRegistryMemory(network,{...cfg,key});
  const bytes=new TextEncoder().encode("QOS #279 immutable disposable CI witness: "+process.env.GITHUB_RUN_ID+":"+process.env.GITHUB_RUN_ATTEMPT);
  const identity=await objectIdentity(bytes);
  const service=new QosMemoryBytes(cache,[backend]);
  const descriptor=await service.prepare(bytes,network);
  assert.equal(descriptor.id,identity);
  assert.ok(descriptor.locator && descriptor.locator.uri.startsWith("rho:id:"));
  const room=new QosProcessRoom({roomId,identity:await newDynCapState(new Uint8Array(32).fill(123)),transport:{broadcast:()=>{}}});
  const start=await room.startProcess("durable-memory",{entropyHex:"aa"}), pid=start.processId;
  const current=()=>replay(room.log).kernel;
  const handle=current().getProcess(pid).root;
  const payload={schema:"qos.syscall/1",caller:pid,op:"mem_put",args:{handle,handleVersion:current().handleVersion(pid,handle),memoryFrontier:current().memoryFrontier(),descriptor}};
  const req=await room.emit(pid,start.event,"syscall-request",payload);
  assert.ok(replay(room.log).pendingSyscalls.includes(req.hash));
  const outcome=previewCanonicalSyscall(current(),payload,pid,req.hash);
  assert.ok(outcome?.ok);
  const result=await room.emit(pid,start.event,"syscall-result",{schema:"qos.syscall/1",requestHash:req.hash,outcome});
  assert.ok(replay(room.log).syscalls.some(t=>t.resultHash===result.hash));
  const digest=await current().stateDigest();
  service.releaseStaged(identity);
  assert.deepEqual(await cache.get(identity),bytes);
  await cache.remove(identity);
  assert.equal(await cache.get(identity),null);
  assert.equal((await cache.keys()).length,0);
  assert.equal(await current().stateDigest(),digest);
  await writeFile(checkpoint,JSON.stringify({events:room.log.events(),pid,handle:outcome.value.id,descriptor,digest,networkId:status.networkId,shardId:status.shardId}),{mode:0o600,flag:"wx"});
  console.log("PASS: signed registry publication, verified readback, journal commit and complete local-cache loss");
}else{
  const saved=JSON.parse(await readFile(checkpoint,"utf8"));
  assert.equal(saved.networkId,status.networkId);
  assert.equal(saved.shardId,status.shardId);
  assert.equal((await cache.keys()).length,0,"fresh reader must start with empty cache");
  const log=new QosEventLog(roomId);
  for(const e of [...saved.events].reverse())assert.ok((await log.ingest(e)).ok);
  const current=()=>replay(log).kernel;
  assert.equal(await current().stateDigest(),saved.digest);
  const d=current().memoryStat(saved.pid,saved.handle);
  assert.ok(d.ok && d.value.id===saved.descriptor.id);
  assert.deepEqual(d.value.locators,[saved.descriptor.locator]);
  const backend=new RholoRegistryMemory(network,cfg);
  let reads=0;
  const service=new QosMemoryBytes(cache,[{
    network,async publish(){throw new Error("reader must never deploy");},
    async read(l){reads++;return backend.read(l);}
  }]);
  assert.equal(await service.get(current,"foreign-pid",saved.handle),null);
  assert.equal(reads,0,"unauthorized read touched durable storage");
  const recovered=await service.get(current,saved.pid,saved.handle);
  assert.ok(recovered,"no bytes recovered through the real registry");
  assert.equal(reads,1,"expected one real registry lookup");
  assert.equal(recovered.byteLength,saved.descriptor.size);
  assert.equal(await objectIdentity(recovered),saved.descriptor.id);
  assert.deepEqual(await cache.get(saved.descriptor.id),recovered);
  assert.equal(await current().stateDigest(),saved.digest);
  const evidence={schema:"qos.memory.real-rholo-witness/1",git_commit:process.env.GITHUB_SHA,run_id:process.env.GITHUB_RUN_ID,
    network_id:status.networkId,shard_id:status.shardId,object_id:saved.descriptor.id,byte_length:recovered.length,
    registry_uri:saved.descriptor.locator.uri,kernel_digest:saved.digest,canonical_event_count:saved.events.length,
    fresh_reader:true,local_cache_empty_before:true,unauthorized_lookup_count:0,real_registry_lookup_count:reads,
    recovered_sha256_match:true,recached:true,digest_unchanged:true,verdict:"PASS",
    scope:"Disposable bundled loopback Rholo; no claim of public-network finality or global GC"};
  await writeFile(join(dir,"evidence.json"),JSON.stringify(evidence,null,2)+"\n",{mode:0o600,flag:"wx"});
  console.log("PASS: independent process replay, real Rholo lookup, SHA-256 match and unchanged digest");
}
