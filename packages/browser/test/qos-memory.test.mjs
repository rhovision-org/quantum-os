import {build} from "esbuild";
import {fileURLToPath} from "node:url";
import {dirname,join} from "node:path";
import assert from "node:assert/strict";
import {DaemonMemoryByteCache} from "../../../scripts/qos-cli/memory-byte-cache.mjs";
import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
const root=join(dirname(fileURLToPath(import.meta.url)),"..");
const bundle=await build({stdin:{contents:`
  export {QosMemoryBytes,RoomByteCache,objectIdentity} from "./src/qos-memory-bytes.ts";
  export {memoryPublishProgram,memoryReadProgram,decodeMemoryRecord} from "./src/qos-memory-rholo.ts";
  export {replayQosKernel,previewCanonicalSyscall,QOS_RIGHTS} from "./src/qos-kernel.ts";
  export {QosEventLog,QosProcessRoom} from "./src/qos-process.ts";
  export {newDynCapState} from "./src/dyncap.ts";
`,resolveDir:root,loader:"ts",sourcefile:"memory-test-entry.ts"},bundle:true,format:"esm",platform:"node",write:false});
const {QosMemoryBytes,RoomByteCache,objectIdentity,memoryPublishProgram,memoryReadProgram,decodeMemoryRecord,replayQosKernel,previewCanonicalSyscall,QOS_RIGHTS:R,QosEventLog,QosProcessRoom,newDynCapState}=
await import("data:text/javascript;base64,"+Buffer.from(bundle.outputFiles[0].text).toString("base64"));
let checks=0;
function check(label,c){assert.ok(c,label);checks++;console.log("  ok   "+label);}
const encode=s=>new TextEncoder().encode(s);
const aBytes=encode("abc"),bBytes=encode("def");
const aId=await objectIdentity(aBytes),bId=await objectIdentity(bBytes);
check("SHA-256 known vector",aId==="ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
check("content identity distinguishes bytes",aId!==bId && aId===await objectIdentity(Uint8Array.from(aBytes)));
const registry=new Map();
const backend={network:"fixture/root",async publish(bytes,id){const uri="rho:id:"+id;registry.set(uri,Uint8Array.from(bytes));return {network:this.network,uri};},async read(l){return registry.get(l.uri)??null;}};
const cache=new RoomByteCache(), service=new QosMemoryBytes(cache,[backend]);
const aDesc=await service.prepare(aBytes,backend.network), bDesc=await service.prepare(bBytes);
check("descriptor contains only identity, size and locator",Object.keys(aDesc).sort().join(",")==="id,locator,size" && aDesc.id===aId);
const malformed={schema:"qos.memory/1",id:aId,hex:"646566"};
check("registry decoder rejects mismatched hash",await decodeMemoryRecord([JSON.stringify(malformed)])===null);
const rec=JSON.stringify({schema:"qos.memory/1",id:aId,hex:"616263"});
check("registry string readback validates content",Buffer.from(await decodeMemoryRecord([JSON.stringify(rec)],aId)).equals(Buffer.from(aBytes)));
check("registry programs use insert and lookup",memoryPublishProgram(aId,aBytes).includes("rho:registry:insertArbitrary") && memoryReadProgram(aDesc.locator.uri).includes("rho:registry:lookup"));
check("publish explicitly declares deployId system channel before emitting receipt",
  memoryPublishProgram(aId,aBytes).includes('deployId(`rho:rchain:deployId`)') &&
  memoryPublishProgram(aId,aBytes).includes("deployId!(uri)"));
check("exploratory lookup never binds deploy-only system channel",
  !memoryReadProgram(aDesc.locator.uri).includes("rho:rchain:deployId"));

const wire="qos.memory/1:"+aId+":616263";
check("Rholo wire literal is escape-free ASCII",memoryPublishProgram(aId,aBytes).includes('"'+wire+'"') && !memoryPublishProgram(aId,aBytes).includes(String.fromCharCode(92)));
check("ASCII readback validates content",Buffer.from(await decodeMemoryRecord([JSON.stringify(wire)],aId)).equals(Buffer.from(aBytes)));
check("ASCII readback refuses wrong content and malformed encoding",
  await decodeMemoryRecord([JSON.stringify("qos.memory/1:"+aId+":646566")])===null &&
  await decodeMemoryRecord([JSON.stringify("qos.memory/1:"+aId+":f")])===null &&
  await decodeMemoryRecord([JSON.stringify(wire)],bId)===null);
const empty=new Uint8Array(),emptyId=await objectIdentity(empty);
check("ASCII wire supports zero length and binary payloads",
  (await decodeMemoryRecord([JSON.stringify("qos.memory/1:"+emptyId+":")],emptyId))?.length===0 &&
  Buffer.from(await decodeMemoryRecord([JSON.stringify("qos.memory/1:"+await objectIdentity(Uint8Array.of(0,255,34,92))+":00ff225c")])).equals(Buffer.from([0,255,34,92])));
check("ambiguous registry replies refused",await decodeMemoryRecord([rec,rec])===null);

const roomId="cap:room:03010563656127610341634101250325";
const identities=await Promise.all([120,121].map(n=>newDynCapState(new Uint8Array(32).fill(n))));
identities.sort((a,b)=>a.anchor<b.anchor?-1:a.anchor>b.anchor?1:0);
const make=identity=>new QosProcessRoom({roomId,identity,transport:{broadcast:()=>{}}});
const a=make(identities[0]),b=make(identities[1]);
const x=await a.startProcess("memory-a",{entropyHex:"aa"}),y=await b.startProcess("memory-b",{entropyHex:"ab"});
await a.log.mergeFrom(b.log);await b.log.mergeFrom(a.log);
const replay=room=>replayQosKernel(room.log.events(),room.log.forkedSources);
const call=async(room,start,peer,op,input)=>{
  const k=replay(room).kernel,pid=start.processId,args={...input,memoryFrontier:k.memoryFrontier()};
  if(k.handleVersion(pid,args.handle))args.handleVersion=k.handleVersion(pid,args.handle);
  if(typeof args.targetHandle==="string")args.targetHandleVersion=k.handleVersion(pid,args.targetHandle);
  const payload={schema:"qos.syscall/1",caller:pid,op,args};
  const before=await k.stateDigest(),req=await room.emit(pid,start.event,"syscall-request",payload);
  const pending=replay(room);
  assert.ok(pending.pendingSyscalls.includes(req.hash),op+" request rejected "+JSON.stringify(pending.rejected));
  assert.equal(await pending.kernel.stateDigest(),before);
  const outcome=previewCanonicalSyscall(pending.kernel,payload,pid,req.hash);
  assert.ok(outcome);
  const result=await room.emit(pid,start.event,"syscall-result",{schema:"qos.syscall/1",requestHash:req.hash,outcome});
  await peer.log.mergeFrom(room.log);
  assert.ok(replay(peer).syscalls.some(t=>t.resultHash===result.hash),op+" replay rejected "+JSON.stringify(replay(peer).rejected));
  assert.equal(await replay(peer).kernel.stateDigest(),await replay(room).kernel.stateDigest());
  return {req,result,outcome};
};
const rootA=replay(a).kernel.getProcess(x.processId).root,rootB=replay(b).kernel.getProcess(y.processId).root;
const putA=await call(a,x,b,"mem_put",{handle:rootA,descriptor:aDesc});assert.ok(putA.outcome.ok);
const putB=await call(a,x,b,"mem_put",{handle:rootA,descriptor:bDesc});assert.ok(putB.outcome.ok);
const ha=putA.outcome.value.id,hb=putB.outcome.value.id;
service.releaseStaged(aId);service.releaseStaged(bId);
check("graph metadata has no byte payload",replay(a).kernel.memoryView().objects.every(o=>Object.keys(o).sort().join(",")==="id,locators,size"));
const foreign=await call(b,y,a,"mem_get",{handle:ha});
check("foreign handle denied in caller namespace",foreign.outcome.errno==="EBADF");
const duplicate=await call(b,y,a,"mem_put",{handle:rootB,descriptor:aDesc});assert.ok(duplicate.outcome.ok);
const h2=duplicate.outcome.value.id;
check("same content deduplicates across peers without merging handles",replay(a).kernel.memoryView().objects.length===2 && h2!==ha);
const ref=await call(a,x,b,"mem_ref",{handle:ha,rights:R.READ});assert.ok(ref.outcome.ok);
const narrowed=ref.outcome.value.id;
const denied=await call(a,x,b,"mem_ref",{handle:narrowed,rights:R.WRITE});
check("read-only handle cannot widen authority",denied.outcome.errno==="EACCES");
assert.ok((await call(a,x,b,"mem_link",{handle:ha,targetHandle:hb})).outcome.ok);
assert.ok((await call(a,x,b,"mem_link",{handle:hb,targetHandle:ha})).outcome.ok);
check("reachable cycle terminates mark traversal",replay(a).kernel.memoryView().reachable.length===2);
const beforeLoss=await replay(a).kernel.stateDigest();
await cache.remove(aId);
check("cache loss does not change machine digest",await replay(a).kernel.stateDigest()===beforeLoss);
check("durable fixture recovers bytes after local loss",Buffer.from(await service.get(()=>replay(b).kernel,y.processId,h2)).equals(Buffer.from(aBytes)));
check("foreign caller cannot fetch bytes through another process handle",await service.get(()=>replay(b).kernel,y.processId,ha)===null);
await cache.remove(aId);registry.set(aDesc.locator.uri,bBytes);
check("corrupt remote bytes never returned",await service.get(()=>replay(b).kernel,y.processId,h2)===null);
registry.set(aDesc.locator.uri,aBytes);assert.ok(await service.get(()=>replay(b).kernel,y.processId,h2));
for(const handle of [ha,hb,narrowed])assert.ok((await call(a,x,b,"mem_drop",{handle})).outcome.ok);
check("dropping local handles preserves cycle reachable from other process",replay(a).kernel.memoryView().reachable.length===2 && (await service.collect(()=>replay(a).kernel)).length===0);
assert.ok((await call(b,y,a,"mem_drop",{handle:h2})).outcome.ok);
check("orphan cycle is logically unreachable",replay(a).kernel.memoryView().unreachable.length===2);
const removed=await service.collect(()=>replay(a).kernel,()=>new Set([bId]));
check("GC honors extra local pins",removed.length===1&&removed[0]===aId && (await cache.keys()).includes(bId));
check("GC only removes cache, not registry",registry.has(aDesc.locator.uri));
check("unpin allows deterministic orphan collection",JSON.stringify(await service.collect(()=>replay(a).kernel))===JSON.stringify([bId]));
const events=a.log.events(),rev=new QosEventLog(roomId);
for(const event of [...events].reverse())assert.ok((await rev.ingest(event)).ok);
const final=replay(a),other=replayQosKernel(rev.events(),rev.forkedSources);
check("independent replay converges on graph and kernel digest",final.rejected.length===0&&other.rejected.length===0&&
  JSON.stringify(final.kernel.memoryView())===JSON.stringify(other.kernel.memoryView())&&await final.kernel.stateDigest()===await other.kernel.stateDigest());
const incomplete=replayQosKernel(events.filter(e=>e.hash!==putA.result.hash));
check("missing creation receipt blocks graph mutation",incomplete.missingDependencies.some(e=>e.kind==="memory-frontier"&&e.dependencyHash===putA.result.hash));
const tmp=await mkdtemp(join(tmpdir(),"qos-memory-"));
try{
  const d=new DaemonMemoryByteCache(tmp,aId);await d.put(aId,aBytes);
  check("daemon cache survives reopen",Buffer.from(await new DaemonMemoryByteCache(tmp,aId).get(aId)).equals(Buffer.from(aBytes)));
  check("daemon room scopes isolate cached bytes",await new DaemonMemoryByteCache(tmp,bId).get(aId)===null);
  await assert.rejects(d.put(aId,bBytes));
  check("daemon cache rejects bad content",JSON.stringify(await d.keys())===JSON.stringify([aId]));
  await d.remove(aId);check("daemon cache eviction is local",await d.get(aId)===null);
}finally{await rm(tmp,{recursive:true,force:true});}
console.log("PASS: qos-memory.test.mjs — "+checks+" checks");
