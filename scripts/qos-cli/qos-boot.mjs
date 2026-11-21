#!/usr/bin/env node
// Local headless boot using the same TS kernel and actual ZFA WASM.
// Public manifest store contains ONLY canonical manifests. Private inputs
// are passed as files, never room capabilities or seed material on argv.
import {createRequire} from "node:module";
import {readFile,writeFile,mkdtemp,rm,stat,mkdir} from "node:fs/promises";
import {tmpdir} from "node:os";
import {resolve,dirname,join} from "node:path";
import {fileURLToPath,pathToFileURL} from "node:url";
const repo=resolve(dirname(fileURLToPath(import.meta.url)),"../..");
const require=createRequire(join(repo,"packages/browser/package.json"));
const usage="qos-boot.mjs discover --store DIR --address SHA256 | boot --store DIR --address SHA256 --snapshot PRIVATE_JSON --room-file PRIVATE_FILE [--identity PRIVATE_JSON --init --out NEW_PRIVATE_SNAPSHOT] [--observe-ms N --signal ws://...]";
const args=process.argv.slice(2),mode=args.shift(),opts={};
const flags=new Set(["init"]);
for(let i=0;i<args.length;i++){
 const k=args[i];if(!k.startsWith("--")||Object.hasOwn(opts,k.slice(2)))throw Error(usage);
 const key=k.slice(2);if(flags.has(key)){opts[key]=true;continue;}
 const value=args[++i];if(!value||value.startsWith("--"))throw Error(usage);opts[key]=value;
}
const allowed=new Set(["store","address","snapshot","room-file","identity","init","out","observe-ms","signal"]);
if(!["discover","boot"].includes(mode)||Object.keys(opts).some(k=>!allowed.has(k))||!opts.store||!/^[0-9a-f]{64}$/.test(opts.address??""))throw Error(usage);
const temp=await mkdtemp(join(tmpdir(),"qos-boot-"));
let peer;
const emit=(type,value)=>console.log(JSON.stringify({type,...value}));
const readBounded=async(path,max=2*1024*1024)=>{if((await stat(path)).size>max)throw Error("input exceeds size limit");return readFile(path,"utf8");};
const readPrivate=async(path,max)=>{const s=await stat(path);if(!s.isFile()||(s.mode&0o077)!==0)throw Error("private input must be a regular file with mode 0600");return readBounded(path,max);};
try{
 const {build}=require("esbuild");
 const output=join(temp,"runtime.mjs");
 await build({stdin:{contents:`
 export * from "./src/qos-boot.ts";
 export {createSnapshot} from "./src/qos-observe.ts";
 export {QosCommand} from "./src/qos-command.ts";
 export {newDynCapState,deserializeState,serializeState} from "./src/dyncap.ts";
 export {replayQosKernel} from "./src/qos-kernel.ts";
 export {loadZfa} from "./src/zfa.ts";
 export {parseQosEvent} from "./src/qos-process.ts";
 `,resolveDir:join(repo,"packages/browser"),loader:"ts",sourcefile:"native-boot.ts"},bundle:true,format:"esm",platform:"node",outfile:output});
 const api=await import(pathToFileURL(output).href);
 const manifest=await api.discoverBoot(opts.address,async address=>JSON.parse(await readBounded(join(resolve(opts.store),address+".json"),128*1024)));
 if(mode==="discover"){
  emit("manifest",{address:opts.address,manifest});
 }else{
  if(!opts.snapshot||!opts["room-file"]||(opts.init&&(!opts.identity||!opts.out))||(!opts.init&&(opts.identity||opts.out)))throw Error(usage);
  const room=(await readPrivate(opts["room-file"],4096)).trim();
  const snapshot=JSON.parse(await readPrivate(opts.snapshot,2*1024*1024));
  // Require actual WASM in native mode; never silently downgrade.
  await api.loadZfa(new Uint8Array(await readFile(join(repo,"packages/zfa-core-wasm/zfa_core_bg.wasm"))),true);
  const boot=await api.verifyBoot(manifest,opts.address,snapshot,room);
  emit("dmesg",{stage:"verified",address:opts.address,digest:manifest.stateRoot,wasm:true});
  let current=boot.replay;
  if(opts.init){
   // Explicit local-only continuation; never connect or publish this branch.
   if(opts["observe-ms"]||opts.signal)throw Error("init fork cannot join live room");
   const raw=await readPrivate(opts.identity,65536),identity=await api.deserializeState(raw,room);
   if(!identity||identity.anchor!==(await api.newDynCapState(identity.seed)).anchor||identity.anchor!==current.kernel.getProcess(boot.pid)?.owner)
    throw Error("supervisor identity mismatch");
   const max=Math.max(0,...snapshot.events.filter(e=>e.source===identity.anchor).map(e=>e.seq));
   if(!Number.isSafeInteger(identity.seqByRoom[room])||identity.seqByRoom[room]<max)throw Error("identity counter is stale");
   // Keep an exclusive private continuation output directory. Persist the
   // advanced counter separately, not over the live identity. Neither file
   // is suitable for merging back into the original room.
   const out=resolve(opts.out);
   await mkdir(out,{mode:0o700});
   const q=new api.QosCommand({roomId:room,identity,isolated:true,transport:{broadcast:()=>{}},say:()=>{},loadJournal:()=>snapshot.events});
   await q.handle("svc boot "+boot.pid+" | "+JSON.stringify({schema:"qos-init/1",services:manifest.init.services}));
   current=api.replayQosKernel(q.room.log.events(),q.room.log.forkedSources);
   const services=current.kernel.initView(boot.pid).services;
   if(current.rejected.length||!manifest.init.services.every(n=>services.some(s=>s.name===n&&s.phase==="running")))throw Error("init did not start every requested service");
   const next=await api.createSnapshot(q.room.log),nextManifest=await api.createBootManifest(next,room,boot.pid,manifest.init.services);
   await writeFile(join(out,"snapshot.json"),JSON.stringify(next),{mode:0o600,flag:"wx"});
   await writeFile(join(out,"identity.json"),api.serializeState(identity),{mode:0o600,flag:"wx"});
   const address=await api.bootAddress(nextManifest);
   await writeFile(join(out,address+".json"),JSON.stringify(nextManifest),{mode:0o600,flag:"wx"});
   emit("dmesg",{stage:"isolated-init",address,digest:next.digest,services:services.map(s=>({name:s.name,phase:s.phase,generation:s.generation}))});
  }
  if(opts["observe-ms"]||opts.signal){
   // Observing a live continuation starts from the verified original cut,
   // never from a locally forked branch and never authors kernel events.
   const ms=Number(opts["observe-ms"]);
   if(!opts.signal||!Number.isSafeInteger(ms)||ms<100||ms>60000||!/^wss?:\/\//.test(opts.signal))throw Error("invalid observation options");
   const {QOSPeer}=await import("./qospeer.mjs"),{generateCapability}=await import("./zfa.mjs");
   let pending=Promise.resolve(),failure=false;
   peer=new QOSPeer({roomId:room,peerId:generateCapability("peer"),signalingUrl:opts.signal,iceServers:[],
    onPeerReady:()=>emit("peer-ready",{}),
    onMessage:(_from,data)=>{const event=api.parseQosEvent(data);if(event)pending=pending.then(async()=>{const admitted=await boot.log.ingest(event);if(!admitted.ok&&!admitted.fork)failure=true;});}});
   await peer.connect();await new Promise(r=>setTimeout(r,ms));peer.disconnect();peer=null;
   await pending;if(failure)throw Error("live event admission failed");
   current=api.replayQosKernel(boot.log.events(),boot.log.forkedSources);
   if(boot.log.forkedSources.size||current.rejected.length||current.pendingSyscalls.length||current.missingDependencies.length||current.cyclicHashes.length)throw Error("live continuation incomplete or rejected");
   emit("dmesg",{stage:"observed",digest:await current.kernel.stateDigest()});
  }
  emit("ps",{digest:await current.kernel.stateDigest(),processes:current.kernel.list(),services:current.kernel.initView(boot.pid).services});
 }
}catch(e){console.error("qos-boot refused: "+(e instanceof Error?e.message:"unknown error"));process.exitCode=1;}
finally{peer?.disconnect();await rm(temp,{recursive:true,force:true});}
