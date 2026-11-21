// Disposable Chromium: exercise the actual shell UI and OPFS, not a second interpreter.
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {pathToFileURL} from "node:url";
import {writeFile} from "node:fs/promises";
assert.equal(process.env.GITHUB_ACTIONS,"true");
assert.ok(process.env.QOS_PLAYWRIGHT_MODULE);
const {chromium}=await import(pathToFileURL(process.env.QOS_PLAYWRIGHT_MODULE).href);
const origin="https://127.0.0.1:5173",room="cap:room:03010563656127610341634101250325";
const url=origin+"/quantum-os/?signal="+encodeURIComponent("wss://127.0.0.1:5173/signal")+"#room="+room;
const expected="ALPHA  | BETA\ntail\n",id=createHash("sha256").update(expected).digest("hex");
const scope=createHash("sha256").update(room).digest("hex");
const browser=await chromium.launch({headless:true,args:["--no-sandbox","--disable-dev-shm-usage"]});
const context=await browser.newContext({ignoreHTTPSErrors:true});
let rpc=0,countRpc=false,stage="initialize";
const checks=[];
const check=(label,c)=>{assert.ok(c,label);checks.push(label);console.log("PASS: "+label);};
await context.route("**/*",async route=>{
 const u=new URL(route.request().url());
 if(countRpc&&(u.pathname.includes("/api/")||u.pathname.startsWith("/rnode")))rpc++;
 if((u.protocol==="http:"||u.protocol==="https:")&&u.origin!==origin){await route.abort();return;}
 await route.continue();
});
async function open(){
 const page=await context.newPage();await page.goto(url,{waitUntil:"domcontentloaded",timeout:45000});
 await page.waitForFunction(()=>document.querySelector("#my-id")?.textContent?.startsWith("cap:peer:")??false,null,{timeout:60000});
 if(!await page.locator("#status-dot").evaluate(n=>n.classList.contains("connected")))await page.locator("#connect-btn").click();
 await page.waitForFunction(()=>document.querySelector("#status-dot")?.classList.contains("connected")??false,null,{timeout:30000});
 return page;
}
async function command(page,text,needle){
 const prior=await page.locator("#messages .msg").allTextContents();
 await page.locator("#msg-input").fill(text);await page.locator("#send-btn").click();
 await page.waitForFunction(({needle,previous})=>[...document.querySelectorAll("#messages .msg")].filter(n=>n.textContent?.includes(needle)).length>previous,
 {needle,previous:prior.filter(x=>x.includes(needle)).length},{timeout:30000});
 return (await page.locator("#messages .msg").allTextContents()).filter(x=>x.includes(needle)).at(-1);
}
async function hashInOpfs(page){
 return page.evaluate(async({scope,id})=>{
  const root=await navigator.storage.getDirectory();
  const dir=await(await root.getDirectoryHandle("qos-memory-v1")).getDirectoryHandle(scope);
  const file=await(await dir.getFileHandle(id)).getFile();
  const bytes=new Uint8Array(await file.arrayBuffer());
  return {hash:Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",bytes)),b=>b.toString(16).padStart(2,"0")).join(""),text:new TextDecoder().decode(bytes)};
 },{scope,id});
}
try{
 let page=await open();countRpc=true;
 await command(page,"/qos start workspace","started");
 const init=await command(page,"/fs init workspace","syscall fs_init OK");
 const ns=init.match(/h:vfs:[0-9a-f]{64}/)?.[0];assert.ok(ns);
 await command(page,"/fs mkdir workspace "+ns+" /docs","syscall fs_mkdir OK");
 await command(page,"/sh use workspace "+ns,"shell selected:");
 stage="pipeline";
 await command(page,"/sh set X='alpha  | beta'; cd /docs","cwd");
 await command(page,'/sh echo "$X" | upper > output.txt',"job exit 0 · redirected");
 await command(page,"/sh echo tail >> output.txt","job exit 0 · redirected");
 const stored=await hashInOpfs(page);
 check("actual shell pipeline and append produce exact OPFS content",stored.hash===id&&stored.text===expected);
 const r=await command(page,"/sh cat < output.txt | lower","job exit 0 · completed");
 check("actual shell reads VFS input",r.includes("job exit 0"));
 const failure=await command(page,"/sh false | echo done","job exit 1 · completed");
 check("UI reports nonzero pipefail status",failure.includes("job exit 1"));
 stage="in-flight job";
 const queued=await command(page,"/spawn echo staged | upper"," queued");
 const handle=queued.match(/h:job:[0-9a-f]{64}/)?.[0];assert.ok(handle);
 await command(page,"/bg "+handle,"background job ready");
 await command(page,"/exec "+handle,"syscall sh_step OK");
 const status=await command(page,"/jobs",handle+" · running · background · stage 1/2");
 check("cooperative job is running at exact stage boundary",status.includes("stage 1/2"));
 stage="reload";
 await page.close();page=await open();
 await command(page,"/sh use workspace "+ns,"shell selected:");
 await command(page,"/jobs",handle+" · running · background · stage 1/2");
 check("fresh page rebuilds in-flight job from journal",true);
 await command(page,"/fg "+handle,"job exit 0 · completed");
 const text=(await page.locator("#messages .msg").allTextContents()).join("\n");
 check("foreground resumes pending stage and emits result",text.includes("STAGED"));
 await command(page,"/wait "+handle,"job exit 0");
 await command(page,"/jobs",handle+" · reaped");
 check("wait reaps real child",true);
 check("OPFS result survives reload",(await hashInOpfs(page)).hash===id);
 check("whole local shell witness issues zero chain RPC",rpc===0);
 await writeFile("qos281-opfs-evidence.json",JSON.stringify({schema:"qos.shell.browser-witness/1",commit:process.env.GITHUB_SHA,run_id:process.env.GITHUB_RUN_ID,
 content_id:id,chain_rpc_attempts:rpc,checks,verdict:"PASS",scope:"Actual browser UI, isolated signaling, cooperative shell, OPFS and fresh page replay"},null,2)+"\n");
}catch(e){console.error("browser shell failed at "+stage+": "+e.name);throw e;}
finally{await context.close();await browser.close();}
