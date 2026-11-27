// Browser acceptance: actual /pkg and /svc UI, real signatures and passive replay.
// The room is an isolated fixed test capability, not a user's room.
import assert from "node:assert/strict";
import {pathToFileURL} from "node:url";
import {writeFile} from "node:fs/promises";
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

try{
 let page=await open();countRpc=true;
 await command(page,"/qos start init","started");
 const install=async(pkg,expected="OK",bindings=[])=>receipt(await command(page,"/pkg install init | "+JSON.stringify({package:pkg,publisher,bindings}),"syscall pkg_install "+expected));
 stage="real Ed25519";
 const tampered=make("tampered");tampered.manifest.entrypoint.source="echo tampered";
 check("actual UI rejects altered signed manifest",(await install(tampered,"EACCES")).errno==="EACCES");
 const need=make("need-storage",{capabilities:[{name:"data",kind:"fs",rights:1}]});
 check("actual UI rejects missing explicit grant",(await install(need,"EACCES")).errno==="EACCES");
 const installed=await install(make("base"));
 check("independently signed manifest accepted by browser",installed.ok);
 await install(make("child",{dependencies:["base"]}));
 await install(make("missing",{dependencies:["not-installed"]}));
 stage="boot";
 const boot=receipt(await command(page,'/svc boot init | {"schema":"qos-init/1","services":["child","missing"]}',"syscall svc_boot OK")).value;
 check("browser boot orders dependencies and blocks missing ones",boot.order.indexOf("base")<boot.order.indexOf("child")&&boot.results.some(x=>x.name==="missing"&&x.phase==="blocked"));
 const status=async n=>receipt(await command(page,"/svc status init "+n,"syscall svc_status OK")).value;
 const original=await status("base");
 const restarted=receipt(await command(page,"/svc restart init base","syscall svc_restart OK")).value;
 check("stable service identity and fresh process generation",original.id===restarted.id&&original.pid!==restarted.pid&&restarted.generation===original.generation+1);
 check("restart stops dependent instance",(await status("child")).phase==="blocked");
 await command(page,"/svc start init child","syscall svc_start OK");
 stage="fresh page";
 await page.close();page=await open();
 const current=await status("base");
 check("fresh page restores service metadata and generation",JSON.stringify(current)===JSON.stringify(restarted));
 check("fresh page restores running dependency",(await status("child")).phase==="running");
 await command(page,"/pkg remove init base","syscall pkg_remove OK");
 check("removing package blocks dependent service",(await status("child")).phase==="blocked");
 const list=receipt(await command(page,"/pkg list init","syscall pkg_list OK")).value;
 check("removed package absent from registry",!list.some(x=>x.manifest.name==="base"));
 check("local package operations and reload issue no chain RPC",rpc===0);
 await writeFile("qos284-opfs-evidence.json",JSON.stringify({schema:"qos.init.browser-witness/1",commit:process.env.GITHUB_SHA,run_id:process.env.GITHUB_RUN_ID,
 checks,chain_rpc_attempts:rpc,verdict:"PASS",scope:"actual /pkg and /svc UI, independently signed Ed25519 manifests, builtin service registry, fresh page replay"},null,2)+"\n");
}catch(e){console.error("browser init failed at "+stage+": "+e.name);throw e;}
finally{await context.close();await browser.close();}
