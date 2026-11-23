// Browser acceptance: actual app /qos + /fs UI, real OPFS, fresh page heap.
// The room is an isolated fixed test capability, not a user's room.
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {pathToFileURL} from "node:url";
import {writeFile} from "node:fs/promises";
assert.equal(process.env.GITHUB_ACTIONS,"true","CI-only browser witness");
assert.ok(process.env.QOS_PLAYWRIGHT_MODULE);
const {chromium}=await import(pathToFileURL(process.env.QOS_PLAYWRIGHT_MODULE).href);
const origin="https://127.0.0.1:5173",room="cap:room:03010563656127610341634101250325";
const url=origin+"/quantum-os/?signal="+encodeURIComponent("wss://127.0.0.1:5173/signal")+"#room="+room;
const content="QOS local OPFS VFS witness "+process.env.GITHUB_RUN_ID+":"+process.env.GITHUB_RUN_ATTEMPT;
const id=createHash("sha256").update(content).digest("hex"),scope=createHash("sha256").update(room).digest("hex");
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
async function opfs(page){
 return page.evaluate(async({scope,id})=>{
   if(typeof navigator.storage.getDirectory!=="function")return null;
   const origin=await navigator.storage.getDirectory();
   const rooms=await origin.getDirectoryHandle("qos-memory-v1");
   const folder=await rooms.getDirectoryHandle(scope);
   const file=await(await folder.getFileHandle(id)).getFile();
   const bytes=new Uint8Array(await file.arrayBuffer());
   const hash=Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",bytes)),b=>b.toString(16).padStart(2,"0")).join("");
   return {hash,text:new TextDecoder().decode(bytes)};
 },{scope,id});
}
async function namespace(page,handle){
 const line=await command(page,"/fs stat filesystem "+handle+" /","syscall fs_stat OK");
 // The system message includes the exact JSON receipt, without a second
 // independent namespace representation in the UI.
 const m=/\{.*\}(?=\s*·\s*position)/.exec(line);
 assert.ok(m,"missing stat receipt");
 const value=JSON.parse(m[0]).value;
 assert.match(value.root,/^[0-9a-f]{64}$/);assert.match(value.version,/^[0-9a-f]{64}$/);
 return {root:value.root,version:value.version};
}
try{
 let page=await open();
 countRpc=true;
 stage="new namespace";
 await command(page,"/qos start filesystem","started");
 const init=await command(page,"/fs init filesystem","syscall fs_init OK");
 const handle=init.match(/h:vfs:[0-9a-f]{64}/)?.[0];assert.ok(handle,"namespace handle absent");
 await command(page,"/fs mkdir filesystem "+handle+" /docs","syscall fs_mkdir OK");
 stage="local file write";
 const result=await command(page,"/fs put filesystem "+handle+" /docs/evidence | "+content,"file committed: "+id);
 check("actual browser /fs put committed the known content hash",result.includes(id));
 stage="real OPFS";
 const before=await opfs(page);
 check("real origin-private filesystem holds exact bytes",before?.hash===id&&before.text===content);
 const root=await namespace(page,handle);
 stage="fresh page";
 await page.close();
 page=await open();
 // No retention of QosCommand, QosEventLog, or RAM cache in the JS heap.
 const afterRoot=await namespace(page,handle);
 check("fresh browser page replays same namespace root and version",JSON.stringify(root)===JSON.stringify(afterRoot));
 const after=await opfs(page);
 check("OPFS file survives browser page destruction",after?.hash===id&&after.text===content);
 stage="local read after reload";
 await command(page,"/fs cat filesystem "+handle+" /docs/evidence",content);
 check("actual browser /fs cat retrieves the persisted file",true);
 check("file read preserves namespace root",JSON.stringify(await namespace(page,handle))===JSON.stringify(root));
 check("local VFS operations and reload issue no chain RPC",rpc===0);
 await writeFile("qos280-opfs-evidence.json",JSON.stringify({
  schema:"qos.vfs.browser-opfs-witness/1",commit:process.env.GITHUB_SHA,run_id:process.env.GITHUB_RUN_ID,
  content_id:id,namespace_root:root.root,namespace_version:root.version,chain_rpc_attempts:rpc,
  fresh_page:true,real_opfs:true,checks,verdict:"PASS",scope:"actual browser application on isolated signaling, local VFS only"
 },null,2)+"\n");
}catch(error){console.error("browser VFS failed at "+stage+": "+error.name);throw error;}
finally{await context.close();await browser.close();}
