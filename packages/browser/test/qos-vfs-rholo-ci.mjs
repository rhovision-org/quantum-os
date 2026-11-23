// Disposable CI only: execute actual /fs commands against the real Registry.
// A separate reader restores both dyncap continuity and admission evidence;
// the publisher's byte cache is absent and the reader has no deploy key.
import assert from "node:assert/strict";
import {build} from "esbuild";
import {createHash} from "node:crypto";
import {readFile,writeFile} from "node:fs/promises";
import {dirname,join} from "node:path";
import {fileURLToPath,pathToFileURL} from "node:url";
import {DaemonMemoryByteCache} from "../../../scripts/qos-cli/memory-byte-cache.mjs";
assert.equal(process.env.GITHUB_ACTIONS,"true");
const dir=process.env.QOS_MEMORY_WITNESS_DIR,mode=process.argv[2];
assert.ok(dir&&process.env.RUNNER_TEMP&&dir.startsWith(process.env.RUNNER_TEMP+"/"));
assert.ok(mode==="publish"||mode==="recover");
const node="http://127.0.0.1:40403",status=await(await fetch(node+"/api/status",{signal:AbortSignal.timeout(5000)})).json();
assert.equal(status.shardId,"/root");
assert.ok(status.networkId);
const cfg={url:node,shard:status.shardId,phloLimit:8_000_000,phloPrice:1};
const root=join(dirname(fileURLToPath(import.meta.url)),"..");
const bundle=await build({stdin:{contents:`
 export {QosCommand} from "./src/qos-command.ts";
 export {QosMemoryBytes,objectIdentity} from "./src/qos-memory-bytes.ts";
 export {RholoRegistryMemory} from "./src/qos-memory-rholo.ts";
 export {replayQosKernel} from "./src/qos-kernel.ts";
 export {newDynCapState,serializeState,deserializeState} from "./src/dyncap.ts";
`,resolveDir:root,loader:"ts",sourcefile:"vfs-real-witness.ts"},bundle:true,format:"esm",platform:"node",write:false});
const bundlePath=join(dir,"vfs-"+mode+".mjs");
await writeFile(bundlePath,bundle.outputFiles[0].text,{mode:0o600,flag:"wx"});
const {QosCommand,QosMemoryBytes,objectIdentity,RholoRegistryMemory,replayQosKernel,newDynCapState,serializeState,deserializeState}=await import(pathToFileURL(bundlePath).href);
const configStore=new Map();
Object.defineProperty(globalThis,"localStorage",{value:{getItem:k=>configStore.get(k)??null,setItem:(k,v)=>configStore.set(k,v)}});
const roomId="cap:room:03010563656127610341634101250325",network="witness/loopback/root";
const cache=new DaemonMemoryByteCache(dir,createHash("sha256").update(roomId).digest("hex"));
const checkpoint=join(dir,"vfs-checkpoint.json");
let saved=mode==="recover"?JSON.parse(await readFile(checkpoint,"utf8")):null;
let journal=saved?.events??null,identity=mode==="recover"?await deserializeState(saved.identity):await newDynCapState(new Uint8Array(32).fill(125));
assert.ok(identity);
let reads=0,publishes=0;
let backend;
if(mode==="publish"){
 const pk=await readFile(new URL("../../../scripts/localnet/pk.txt",import.meta.url),"utf8");
 const key=pk.split("\n").find(l=>l.startsWith("deployer="))?.split("=")[1]?.trim();
 assert.match(key??"",/^[0-9a-f]{64}$/i);
 backend=new RholoRegistryMemory(network,{...cfg,key});
}else{backend=new RholoRegistryMemory(network,cfg);}
const service=new QosMemoryBytes(cache,[{
 network,async publish(bytes,id){assert.equal(mode,"publish","reader must never deploy");publishes++;return backend.publish(bytes,id);},
 async read(l){reads++;try{return await backend.read(l);}catch(e){console.error("registry read failed:",e.message);throw e;}}
}]);
const lines=[];
const command=new QosCommand({roomId,identity,transport:{broadcast:()=>{}},say:s=>lines.push(s),memory:async()=>({service,network}),
 loadJournal:()=>journal,saveJournal:events=>{journal=JSON.parse(JSON.stringify(events));}});
const replay=()=>replayQosKernel(command.room.log.events(),command.room.log.forkedSources);
const run=async s=>{await command.handle(s);assert.equal(replay().rejected.length,0,"canonical replay rejected "+JSON.stringify(replay().rejected));};
if(mode==="publish"){
 await run("start filesystem");
 const pid=command.list()[0].id;
 await run("fs init filesystem");
 const handle=replay().syscalls.at(-1).outcome.value.handle.id;
 await run("fs mkdir filesystem "+handle+" /docs");
 const text="QOS VFS durable witness "+process.env.GITHUB_RUN_ID+":"+process.env.GITHUB_RUN_ATTEMPT;
 const bytes=new TextEncoder().encode(text),id=await objectIdentity(bytes);
 await run("fs put-durable filesystem "+handle+" /docs/evidence | "+text);
 const put=replay().syscalls.find(t=>t.op==="fs_put");
 assert.ok(put?.outcome.ok,"namespace write not committed");
 assert.equal(publishes,1);assert.equal(reads,1);
 const obj=replay().kernel.memoryView().objects.find(o=>o.id===id);
 assert.ok(obj?.locators.length===1);
 assert.match(obj.locators[0].blockHash??"",/^[0-9a-f]{64}$/);
 assert.ok(replay().kernel.memoryView().reachable.includes(id),"namespace did not retain object");
 const version=replay().kernel.fsVersion(pid,handle),digest=await replay().kernel.stateDigest();
 assert.deepEqual(await cache.get(id),bytes);
 await cache.remove(id);assert.equal((await cache.keys()).length,0);
 assert.equal(await replay().kernel.stateDigest(),digest);
 await writeFile(checkpoint,JSON.stringify({events:journal,identity:serializeState(identity),pid,handle,version,digest,id,size:bytes.length,locator:obj.locators[0],networkId:status.networkId}),{mode:0o600,flag:"wx"});
 console.log("PASS: /fs put-durable committed an actual Rholo file and removed publisher cache");
}else{
 assert.equal(status.networkId,saved.networkId);
 assert.equal((await cache.keys()).length,0);
 await run("status filesystem");
 assert.equal(await replay().kernel.stateDigest(),saved.digest);
 assert.deepEqual(replay().kernel.fsVersion(saved.pid,saved.handle),saved.version);
 await run("fs cat filesystem "+saved.handle+" /docs/evidence");
 assert.equal(publishes,0);assert.equal(reads,1);
 const bytes=await cache.get(saved.id);assert.ok(bytes,"reader did not recover content");
 assert.equal(await objectIdentity(bytes),saved.id);assert.equal(bytes.length,saved.size);
 assert.ok(lines.includes(new TextDecoder().decode(bytes)),"shell did not output recovered bytes");
 assert.deepEqual(replay().kernel.fsVersion(saved.pid,saved.handle),saved.version);
 const opens=replay().syscalls.filter(t=>t.op==="fs_open");
 assert.equal(opens.length,1);assert.ok(opens[0].outcome.ok&&opens[0].outcome.value.rights===1);
 assert.ok(!replay().kernel.getProcess(saved.pid).handles.includes(opens[0].outcome.value.id));
 const evidence={schema:"qos.vfs.real-rholo-witness/1",run_id:process.env.GITHUB_RUN_ID,object_id:saved.id,size:saved.size,
   namespace_root:saved.version.root,namespace_version:saved.version.version,registry_uri:saved.locator.uri,carrying_block_hash:saved.locator.blockHash,
   checkpoint_digest:saved.digest,reader_digest:await replay().kernel.stateDigest(),
   reload_digest_match:true,root_unchanged_by_read:true,reader_cache_was_empty:true,reader_has_no_deploy_key:true,real_registry_read_count:reads,
   shell_output_hash_match:true,opened_file_read_only:true,temporary_handle_closed:true,verdict:"PASS",
   scope:"Disposable bundled loopback Rholo; Node execution of browser command adapter and filesystem cache, not live browser OPFS or public-network finality"};
 await writeFile(join(dir,"evidence.json"),JSON.stringify(evidence,null,2)+"\n",{mode:0o600,flag:"wx"});
 console.log("PASS: fresh /fs client recovered bytes from real Rholo, preserved root and restored checkpoint digest");
}
