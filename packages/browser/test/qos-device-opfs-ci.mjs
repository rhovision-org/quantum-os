// Browser acceptance: actual /dev UI, real OPFS and passive replay.
// The room is an isolated fixed test capability, not a user's room.
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {pathToFileURL} from "node:url";
import {writeFile} from "node:fs/promises";
import {liveDevices} from "./qos-device-live-browser.mjs";
assert.equal(process.env.GITHUB_ACTIONS,"true","CI-only browser witness");
assert.ok(process.env.QOS_PLAYWRIGHT_MODULE);
const {chromium}=await import(pathToFileURL(process.env.QOS_PLAYWRIGHT_MODULE).href);
const origin="https://127.0.0.1:5173",room="cap:room:03010563656127610341634101250325";
const url=origin+"/quantum-os/?signal="+encodeURIComponent("wss://127.0.0.1:5173/signal")+"#room="+room;
const content="00ff616263",expected=Buffer.from(content,"hex");
const id=createHash("sha256").update(expected).digest("hex"),scope=createHash("sha256").update(room).digest("hex");
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
async function stored(page,device){
 return page.evaluate(async({scope,device})=>{
  const root=await navigator.storage.getDirectory(),dir=await(await root.getDirectoryHandle("qos-device-v1")).getDirectoryHandle(scope);
  const file=await(await dir.getFileHandle(device)).getFile();
  return {hex:Array.from(new Uint8Array(await file.arrayBuffer()),b=>b.toString(16).padStart(2,"0")).join(""),modified:file.lastModified};
 },{scope,device});
}
try{
 let page=await open();countRpc=true;
 await command(page,"/qos start devices","started");
 const d=receipt(await command(page,"/dev define devices opfs-block 3","syscall dev_define OK")).value;
 const grant=d.handle.id;
 const session=receipt(await command(page,"/dev open devices "+grant+" 3","syscall dev_open OK")).value.handle.id;
 stage="unbound";
 const missing=receipt(await command(page,"/dev read devices "+session+" 5","syscall dev_observe OK")).value.observation;
 check("unbound session records ENOTSUP",missing.errno==="ENOTSUP");
 await command(page,"/dev bind devices "+session,"device bound:");
 stage="actual OPFS";
 const write=receipt(await command(page,"/dev write devices "+session+" | "+content,"syscall dev_observe OK")).value.observation;
 check("write observation reports exact byte count",write.ok&&write.count===5);
 const prior=await stored(page,d.descriptor.id);
 check("real OPFS scratch block contains binary data",prior.hex===content);
 const read=receipt(await command(page,"/dev read devices "+session+" 5","syscall dev_observe OK")).value.observation;
 check("actual /dev read records exact bytes",read.ok&&read.hex===content);
 stage="reload";
 await page.close();page=await open();
 const after=await stored(page,d.descriptor.id);
 check("reload leaves external file bytes and modification time unchanged",JSON.stringify(prior)===JSON.stringify(after));
 const visible=receipt(await command(page,"/dev list devices","syscall dev_list OK")).value;
 check("replay restores logical device session",visible.some(x=>x.handle.id===session));
 const noAuto=receipt(await command(page,"/dev read devices "+session+" 5","syscall dev_observe OK")).value.observation;
 check("fresh page does not automatically attach host adapter",noAuto.errno==="ENOTSUP");
 await command(page,"/dev bind devices "+session,"device bound:");
 const rebound=receipt(await command(page,"/dev read devices "+session+" 5","syscall dev_observe OK")).value.observation;
 check("explicit rebind recovers persistent scratch bytes",rebound.ok&&rebound.hex===content);
 await command(page,"/dev close devices "+session,"syscall dev_close OK");
 const denied=receipt(await command(page,"/dev read devices "+session+" 5","syscall dev_request EBADF"));
 check("closed session refuses further reads",denied.errno==="EBADF");
 stage="ZFA";
 const z=receipt(await command(page,"/dev define devices zfa 5","syscall dev_define OK")).value;
 const zh=receipt(await command(page,"/dev open devices "+z.handle.id+" 5","syscall dev_open OK")).value.handle.id;
 await command(page,"/dev bind devices "+zh,"device bound:");
 const val=receipt(await command(page,"/dev ioctl devices "+zh+" zfa | 0001","syscall dev_observe OK")).value.observation;
 check("actual app ZFA ioctl returns closure observation",val.ok&&Buffer.from(val.hex,"hex").toString()==="true");
 await command(page,"/dev close devices "+zh,"syscall dev_close OK");
 stage="dedicated live RTC, media and mesh";
 for(const name of await liveDevices(page))check(name,true);
 check("local device operations issue zero chain RPC",rpc===0);
 await writeFile("qos283-opfs-evidence.json",JSON.stringify({schema:"qos.device.browser-witness/1",commit:process.env.GITHUB_SHA,run_id:process.env.GITHUB_RUN_ID,content_id:id,chain_rpc_attempts:rpc,checks,verdict:"PASS",scope:"actual Chromium UI, OPFS scratch, ZFA wrapper, dedicated live RTC, canvas MediaStreamTrack, PosixNet over RTC and passive replay; no physical media capture or public network"},null,2)+"\n");
}catch(e){console.error("browser device failed at "+stage+": "+e.name);throw e;}
finally{await context.close();await browser.close();}
