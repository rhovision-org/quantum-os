// Browser acceptance: cross-runtime actual browser UI and independent headless Node/WASM.
// The room is an isolated fixed test capability, not a user's room.
import assert from "node:assert/strict";
import {pathToFileURL} from "node:url";
import {writeFile,readFile,mkdtemp,mkdir,rm} from "node:fs/promises";
import {join} from "node:path";
import {spawn,execFileSync} from "node:child_process";
import {createHash} from "node:crypto";
import {generateKeyPairSync,sign} from "node:crypto";
assert.equal(process.env.GITHUB_ACTIONS,"true","CI-only browser witness");
assert.ok(process.env.QOS_PLAYWRIGHT_MODULE);
const {chromium}=await import(pathToFileURL(process.env.QOS_PLAYWRIGHT_MODULE).href);
const origin="https://127.0.0.1:5173",room="cap:room:03010563656127610341634101250325";
const url=origin+"/quantum-os/?signal="+encodeURIComponent("wss://127.0.0.1:5173/signal")+"#room="+room;
const {privateKey,publicKey}=generateKeyPairSync("ed25519");
const publisher=Buffer.from(publicKey.export({format:"der",type:"spki"})).subarray(-32).toString("hex");
// Match the documented canonical JSON format independently, without importing the implementation.
const sorted=x=>Array.isArray(x)?x.map(sorted):x&&typeof x==="object"?Object.fromEntries(Object.keys(x).sort().map(k=>[k,sorted(x[k])])):x;
const make=(name,options={})=>{
 const manifest={schema:"qos.package/1",name,version:"1.0.0",publisher,capabilities:[],entrypoint:{kind:"builtin",source:"echo  ready"},dependencies:[],restart:"never",health:"true",...options};
 return {manifest,signature:sign(null,Buffer.from(JSON.stringify(sorted(manifest))),privateKey).toString("hex")};
};
const browser=await chromium.launch({headless:true,args:["--no-sandbox","--disable-dev-shm-usage"]});
const context=await browser.newContext({ignoreHTTPSErrors:true});
let rpc=0,stage="initialize";
const checks=[];
const check=(label,c)=>{assert.ok(c,label);checks.push(label);console.log("PASS: "+label);};
// All HTTP requests outside the disposable browser origin are refused. Count
// attempted RPCs during the actual local command/reload acceptance interval.
let countRpc=false;
await context.route("**/*",async route=>{
 const u=new URL(route.request().url());
 if(countRpc&&(u.pathname.includes("/api/")||u.pathname.startsWith("/rnode")))rpc++;
 if(u.protocol==="http:"||u.protocol==="https:"){
   if(u.origin!==origin){await route.abort();return;}
 }
 await route.continue();
});
async function open(){
 const page=await context.newPage();
 await page.goto(url,{waitUntil:"domcontentloaded",timeout:45000});
 await page.waitForFunction(()=>document.querySelector("#my-id")?.textContent?.startsWith("cap:peer:")??false,null,{timeout:60000});
 if(!await page.locator("#status-dot").evaluate(n=>n.classList.contains("connected"))){
   await page.locator("#connect-btn").click();
 }
 await page.waitForFunction(()=>document.querySelector("#status-dot")?.classList.contains("connected")??false,null,{timeout:30000});
 return page;
}
async function command(page,text,needle){
 const prior=await page.locator("#messages .msg").allTextContents();
 await page.locator("#msg-input").fill(text);
 await page.locator("#send-btn").click();
 await page.waitForFunction(({needle,previous})=>[...document.querySelectorAll("#messages .msg")].filter(n=>n.textContent?.includes(needle)).length>previous,
 {needle,previous:prior.filter(x=>x.includes(needle)).length},{timeout:30000});
 const lines=await page.locator("#messages .msg").allTextContents();
 return lines.filter(x=>x.includes(needle)).at(-1);
}

function receipt(line){const m=/\{.*\}(?=\s*·\s*position)/.exec(line);assert.ok(m,"missing receipt");return JSON.parse(m[0]);}

const tmp=await mkdtemp(join(process.env.RUNNER_TEMP,"qos276-private-"));
const store=join(tmp,"public"),snapshotPath=join(tmp,"snapshot.json"),roomPath=join(tmp,"room"),identityPath=join(tmp,"identity.json");
await mkdir(store,{mode:0o700});
const privateWrite=(p,s)=>writeFile(p,s,{mode:0o600,flag:"wx"});
const addr=m=>createHash("sha256").update(JSON.stringify(sorted(m))).digest("hex");
const baseArgs=(address,dir=store,snapshot=snapshotPath)=>["--store",dir,"--address",address,"--snapshot",snapshot,"--room-file",roomPath];
const lines=output=>output.trim().split("\n").flatMap(line=>{try{return [JSON.parse(line)];}catch{return [];}});
const runNode=(args,expect=true)=>{
 const child=spawn(process.execPath,["scripts/qos-cli/qos-boot.mjs",...args],{stdio:["ignore","pipe","pipe"],env:{...process.env}});
 return new Promise((resolve,reject)=>{
  let output="",error="";
  const timer=setTimeout(()=>{child.kill("SIGKILL");reject(Error("headless runtime timeout"));},60000);
  child.stdout.on("data",b=>output+=b);child.stderr.on("data",b=>error+=b);
  child.on("error",e=>{clearTimeout(timer);reject(e);});
  child.on("close",code=>{clearTimeout(timer);if((code===0)!==expect)reject(Error("unexpected native outcome: "+error.slice(0,500)));else resolve({records:lines(output),error});});
 });
};
const verifyInBrowser=(page,manifest,address,snapshot)=>page.evaluate(async({manifest,address,snapshot,room})=>{
 const {verifyBoot}=await import("/quantum-os/src/qos-boot.ts");
 const r=await verifyBoot(manifest,address,snapshot,room);
 return {digest:await r.replay.kernel.stateDigest(),services:r.replay.kernel.initView(r.pid).services};
},{manifest,address,snapshot,room});
try{
 let page=await open();countRpc=true;
 await command(page,"/qos start init","started");
 for(const pkg of [make("base"),make("child",{dependencies:["base"]})])
  await command(page,"/pkg install init | "+JSON.stringify({package:pkg,publisher,bindings:[]}),"syscall pkg_install OK");
 stage="integrated shell and filesystem";
 const ns=receipt(await command(page,"/fs init init","syscall fs_init OK")).value.handle.id;
 await command(page,"/fs mkdir init "+ns+" /docs","syscall fs_mkdir OK");
 await command(page,"/sh use init "+ns,"shell selected:");
 await command(page,"/sh echo witness | upper > /docs/output","job exit 0 · redirected");
 const payload="WITNESS\n",hash=createHash("sha256").update(payload).digest("hex");
 const file=await page.evaluate(async({room,hash})=>{
  const scope=Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(room))),b=>b.toString(16).padStart(2,"0")).join("");
  const root=await navigator.storage.getDirectory(),dir=await(await root.getDirectoryHandle("qos-memory-v1")).getDirectoryHandle(scope);
  return (await(await dir.getFileHandle(hash)).getFile()).text();
 },{room,hash});
 check("integrated pipeline creates exact persistent OPFS content",file===payload);
 await command(page,"/fs cat init "+ns+" /docs/output","WITNESS");
 const readOnly=receipt(await command(page,"/chmod init "+ns+" 49","syscall id_chmod OK")).value;
 check("namespace handle is attenuated before attempted mutation",readOnly.rights===49);
 const denied=receipt(await command(page,"/fs mkdir init "+ns+" /forbidden","syscall fs_mkdir EACCES"));
 check("read-only namespace write is denied in same journal",denied.errno==="EACCES");
 await command(page,"/spawn echo staged | upper"," queued");
 const queued=(await page.locator("#messages .msg").allTextContents()).filter(t=>t.includes(" queued")).at(-1);
 const job=queued.match(/h:job:[0-9a-f]{64}/)?.[0];assert.ok(job);
 await command(page,"/bg "+job,"background job ready");
 const ps=await page.evaluate(async({room})=>{
  const {QosEventLog}=await import("/quantum-os/src/qos-process.ts"),{replayQosKernel}=await import("/quantum-os/src/qos-kernel.ts");
  const key=Object.keys(localStorage).find(k=>k.startsWith("qos-journal-v1:")&&!k.includes(":snapshot:"));const log=new QosEventLog(room);
  for(const e of JSON.parse(localStorage.getItem(key)))await log.ingest(e);
  return replayQosKernel(log.events(),log.forkedSources).kernel.list();
 },{room});
 const pid=ps.find(p=>p.name==="echo"&&p.state==="running")?.pid;assert.ok(pid);
 const control=op=>"/qos syscall init | "+op+" | "+JSON.stringify({handle:job,target:pid});
 await command(page,control("proc_suspend"),"syscall proc_suspend OK");
 await command(page,"/jobs",job+" · suspended");
 await command(page,control("proc_resume"),"syscall proc_resume OK");
 await command(page,"/kill "+job,"syscall signal OK");
 const waited=receipt(await command(page,"/wait "+job,"syscall sh_wait OK")).value;
 check("capability suspend/resume/signal/wait/reap compose in actual shell",waited.exitCode===-15);
 await command(page,"/jobs",job+" · reaped");
 stage="integrated driver";
 const d=receipt(await command(page,"/dev define init opfs-block 3","syscall dev_define OK")).value;
 const dh=receipt(await command(page,"/dev open init "+d.handle.id+" 3","syscall dev_open OK")).value.handle.id;
 await command(page,"/dev bind init "+dh,"device bound:");
 await command(page,"/dev write init "+dh+" | 00ff","syscall dev_observe OK");
 const observed=receipt(await command(page,"/dev read init "+dh+" 2","syscall dev_observe OK")).value.observation;
 check("same journal contains actual device observation",observed.ok&&observed.hex==="00ff");
 await command(page,"/dev close init "+dh,"syscall dev_close OK");
 await command(page,"/trace init","trace digest ");
 await command(page,"/snapshot beforeboot","snapshot beforeboot ·");
 const restored=await command(page,"/restore beforeboot","restored branch beforeboot ·");
 check("same integrated state has verified isolated recovery cut",restored.includes("isolated"));
 await command(page,"/snapshot bootcut","snapshot bootcut ·");
 stage="public manifest";
 const line=await command(page,"/qos boot-manifest bootcut init child","boot manifest ");
 const match=/boot manifest ([0-9a-f]{64}) (\{.*\})/.exec(line);
 assert.ok(match,"missing manifest output");
 const address=match[1],manifest=JSON.parse(match[2]);
 const privateInputs=await page.evaluate(()=>{
  const key=Object.keys(localStorage).find(k=>k.startsWith("qos-journal-v1:")&&k.endsWith(":snapshot:bootcut"));
  return {snapshot:JSON.parse(localStorage.getItem(key)),identity:localStorage.getItem("qos-dyncap-state")};
 });
 const snapshot=privateInputs.snapshot;
 assert.ok(privateInputs.identity&&snapshot);
 check("public boot address independently recomputes",addr(manifest)===address);
 check("manifest contains no room capability, seed or event bodies",!JSON.stringify(manifest).includes(room)&&!JSON.stringify(manifest).includes("cap:")&&!JSON.stringify(manifest).includes('"events"')&&!JSON.stringify(manifest).includes('"seed"')&&!JSON.stringify(manifest).includes('"source"'));
 await writeFile(join(store,address+".json"),JSON.stringify(manifest),{mode:0o644});
 const discovery=await runNode(["discover","--store",store,"--address",address]);
 check("public discovery works by SHA-256 without private inputs",discovery.records.some(r=>r.type==="manifest"&&r.address===address));
 await privateWrite(snapshotPath,JSON.stringify(snapshot));await privateWrite(roomPath,room);await privateWrite(identityPath,privateInputs.identity);
 stage="offline native WASM";
 const browserCut=await verifyInBrowser(page,manifest,address,snapshot);
 const local=await runNode(["boot",...baseArgs(address)]);
 const localPs=local.records.find(r=>r.type==="ps");
 check("Node/WASM and Chromium replay identical verified boot cut",localPs?.digest===browserCut.digest&&browserCut.digest===manifest.stateRoot&&local.records.some(r=>r.stage==="verified"&&r.wasm===true));
 const wrong=structuredClone(manifest);wrong.packages=wrong.packages.slice(1);
 const wrongAddress=addr(wrong);await writeFile(join(store,wrongAddress+".json"),JSON.stringify(wrong));
 const rejected=await runNode(["boot",...baseArgs(wrongAddress)],false);
 check("missing package fails native boot before init",/missing init package|package set mismatch/.test(rejected.error));
 const altered=structuredClone(manifest);altered.packages[0].id="0".repeat(64);
 const alteredAddress=addr(altered);await writeFile(join(store,alteredAddress+".json"),JSON.stringify(altered));
 check("mismatched package ID fails native boot",/package set mismatch/.test((await runNode(["boot",...baseArgs(alteredAddress)],false)).error));
 stage="headless init fork";
 const out=join(tmp,"fork");
 const initialized=await runNode(["boot",...baseArgs(address),"--init","--identity",identityPath,"--out",out]);
 const boot=initialized.records.find(r=>r.stage==="isolated-init"),ps=initialized.records.find(r=>r.type==="ps");
 assert.ok(boot&&ps);
 check("headless native init starts real restricted child services and answers ps",ps.services.some(s=>s.name==="base"&&s.phase==="running")&&ps.services.some(s=>s.name==="child"&&s.phase==="running")&&ps.processes.some(p=>p.name==="child"&&p.state==="running"));
 const forkSnapshot=JSON.parse(await readFile(join(out,"snapshot.json"),"utf8")),forkManifest=JSON.parse(await readFile(join(out,boot.address+".json"),"utf8"));
 check("native init fork replays in Chromium to identical digest",(await verifyInBrowser(page,forkManifest,boot.address,forkSnapshot)).digest===ps.digest&&ps.digest===forkManifest.stateRoot);
 check("native replay-and-fork preserves original private snapshot",(await readFile(snapshotPath,"utf8"))===JSON.stringify(snapshot));
 stage="actual live QOSPeer";
 const observer=spawn(process.execPath,["scripts/qos-cli/qos-boot.mjs","boot",...baseArgs(address),"--observe-ms","12000","--signal","ws://127.0.0.1:4444"],{stdio:["ignore","pipe","pipe"]});
 let text="",error="";
 let readyResolve,readyReject;
 const ready=new Promise((resolve,reject)=>{readyResolve=resolve;readyReject=reject;});
 const timeout=setTimeout(()=>{observer.kill("SIGKILL");readyReject(Error("headless peer readiness timeout"));},30000);
 observer.stdout.on("data",b=>{text+=b;if(lines(text).some(r=>r.type==="peer-ready")){clearTimeout(timeout);readyResolve();}});
 observer.stderr.on("data",b=>error+=b);
 const closed=new Promise(resolve=>observer.on("close",code=>{clearTimeout(timeout);readyReject(Error("headless observer closed before readiness"));resolve(code);}));
 try{
  await ready;
  await command(page,'/svc boot init | {"schema":"qos-init/1","services":["child"]}',"syscall svc_boot OK");
  const statLine=await command(page,"/stat","stat {");
  const current=JSON.parse(statLine.slice(statLine.indexOf("stat {")+5));
  assert.equal(await closed,0,"headless peer failed: "+error.slice(0,300));
  const live=lines(text).find(r=>r.type==="ps");
  check("live browser event delivery reaches actual Node QOSPeer and converges digest",live?.digest===current.digest&&live.digest!==manifest.stateRoot);
 }finally{observer.kill("SIGKILL");}
 check("zero browser chain RPC across boot, init and live observation",rpc===0);
 await writeFile("qos276-opfs-evidence.json",JSON.stringify({schema:"qos.system.acceptance-witness/1",commit:process.env.GITHUB_SHA,run_id:process.env.GITHUB_RUN_ID,boot_address:address,boot_state_root:manifest.stateRoot,init_fork_address:boot.address,init_fork_digest:ps.digest,checks,chain_rpc_attempts:rpc,verdict:"PASS",scope:"actual Chromium app, native Node with required ZFA WASM, public local manifest store, isolated init fork, real Node QOSPeer observation via disposable signaling"},null,2)+"\n");
}catch(e){console.error("cross-runtime boot failed at "+stage+": "+e.name);throw e;}
finally{await context.close();await browser.close();await rm(tmp,{recursive:true,force:true});}
