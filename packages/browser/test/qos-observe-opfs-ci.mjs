// Browser acceptance: actual app /qos + /fs UI, real OPFS, fresh page heap.
// The room is an isolated fixed test capability, not a user's room.
import assert from "node:assert/strict";
import {pathToFileURL} from "node:url";
import {writeFile} from "node:fs/promises";
assert.equal(process.env.GITHUB_ACTIONS,"true","CI-only browser witness");
assert.ok(process.env.QOS_PLAYWRIGHT_MODULE);
const {chromium}=await import(pathToFileURL(process.env.QOS_PLAYWRIGHT_MODULE).href);
const origin="https://127.0.0.1:5173",room="cap:room:03010563656127610341634101250325";
const url=origin+"/quantum-os/?signal="+encodeURIComponent("wss://127.0.0.1:5173/signal")+"#room="+room;


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

const journal=page=>page.evaluate(()=>{
 const key=Object.keys(localStorage).find(k=>k.startsWith("qos-journal-v1:")&&!k.includes(":snapshot:"));
 if(!key)throw Error("kernel journal not persisted");
 return {key,raw:localStorage.getItem(key)};
});
function receipt(line){const m=/\{.*\}(?=\s*·\s*position)/.exec(line);assert.ok(m,"missing receipt");return JSON.parse(m[0]);}
async function stat(page){
 const line=await command(page,"/stat","stat {");
 const index=line.indexOf("stat {");return JSON.parse(line.slice(index+5));
}
try{
 let page=await open();countRpc=true;
 await command(page,"/qos start recover","started");
 const ns=receipt(await command(page,"/fs init recover","syscall fs_init OK")).value.handle.id;
 stage="inspection";
 const before=await journal(page),base=await stat(page);
 await command(page,"/top","top {");
 await command(page,"/trace recover","trace digest ");
 await command(page,"/dmesg","dmesg digest ");
 check("actual inspection leaves persisted journal unchanged",(await journal(page)).raw===before.raw);
 stage="snapshot";
 const shot=await command(page,"/snapshot checkpoint","snapshot checkpoint ·");
 check("snapshot reports exact current digest",shot.includes(base.digest));
 await command(page,"/fs mkdir recover "+ns+" /new","syscall fs_mkdir OK");
 const live=await stat(page),after=await journal(page);
 check("live room advances after snapshot",live.digest!==base.digest&&after.raw!==before.raw);
 stage="restore";
 await command(page,"/restore checkpoint","restored branch checkpoint ·");
 await command(page,"/branch checkpoint | stat","[branch checkpoint] stat {");
 const branchLine=(await page.locator("#messages .msg").allTextContents()).filter(x=>x.includes("[branch checkpoint] stat {")).at(-1);
 check("actual restored branch starts at original digest",branchLine.includes(base.digest));
 await command(page,"/branch checkpoint | syscall recover | fs_mkdir | "+JSON.stringify({handle:ns,path:"/branch"}),"[branch checkpoint] syscall fs_mkdir OK");
 check("branch makes a separate canonical continuation",(await journal(page)).raw===after.raw);
 check("branch does not change live room digest",(await stat(page)).digest===live.digest);
 await command(page,"/branch checkpoint | dev bind recover unknown","recovery refused:");
 stage="reload";
 await page.close();page=await open();
 check("fresh page reloads original room not branch",(await stat(page)).digest===live.digest);
 const restored=await command(page,"/restore checkpoint","restored branch checkpoint ·");
 check("snapshot persists and verifies across page destruction",restored.includes(base.digest));
 check("restore never replaces original persisted history",(await journal(page)).raw===after.raw);
 check("inspection and isolated recovery issue zero chain RPC",rpc===0);
 await writeFile("qos285-opfs-evidence.json",JSON.stringify({schema:"qos.recovery.browser-witness/1",commit:process.env.GITHUB_SHA,run_id:process.env.GITHUB_RUN_ID,
 base_digest:base.digest,live_digest:live.digest,chain_rpc_attempts:rpc,checks,verdict:"PASS",scope:"actual browser snapshot and local isolated replay continuation; original journal preserved"},null,2)+"\n");
}catch(e){console.error("browser recovery failed at "+stage+": "+e.name);throw e;}
finally{await context.close();await browser.close();}
