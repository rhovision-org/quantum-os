// Real Chromium, isolated browser identities and local signaling only.
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
assert.equal(process.env.GITHUB_ACTIONS,'true');
const {chromium}=await import(pathToFileURL(process.env.QOS_PLAYWRIGHT_MODULE).href);
const origin='https://127.0.0.1:5173';
const url=origin+'/quantum-os/?signal='+encodeURIComponent('wss://127.0.0.1:5173/signal')+'#room=cap:room:03010563656127610341634101250325';
const browser=await chromium.launch({headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
const checks=[]; const pass=label=>{checks.push(label);console.log('PASS: '+label);};
let stage='initialize';
async function open(){
 const context=await browser.newContext({ignoreHTTPSErrors:true});
 await context.route('**/*',async route=>{const u=new URL(route.request().url());if(['http:','https:'].includes(u.protocol)&&u.origin!==origin)return route.abort();return route.continue();});
 const page=await context.newPage();
 await page.goto(url,{waitUntil:'domcontentloaded',timeout:45000});
 await page.waitForFunction(()=>document.querySelector('#my-id')?.textContent?.startsWith('cap:peer:'),null,{timeout:60000});
 if(!await page.locator('#status-dot').evaluate(n=>n.classList.contains('connected')))await page.locator('#connect-btn').click();
 await page.waitForFunction(()=>document.querySelector('#status-dot')?.classList.contains('connected'),null,{timeout:30000});
 return page;
}
const dialog=p=>p.locator('[data-confirm-dialog="true"]').last();
async function send(p,text){await p.locator('#msg-input').fill(text);await p.locator('#send-btn').click();}
async function waitLine(p,needle){await p.waitForFunction(n=>[...document.querySelectorAll('#messages .msg')].some(x=>x.textContent?.includes(n)),needle,{timeout:30000});}
async function goals(p){return p.evaluate(()=>Object.entries(localStorage).filter(([k])=>k.startsWith('qos-goals:')).flatMap(([,v])=>JSON.parse(v).goals.map(g=>g.text)).sort());}
async function review(p,source){await send(p,'/rhoqu '+source);await dialog(p).getByText('Review RhoQu program',{exact:true}).waitFor();}
async function noDialogs(p){await p.waitForFunction(()=>!document.querySelector('[data-confirm-dialog="true"]'));}
try{
 const p=await open(),peer=await open();
 assert.deepEqual(await goals(p),[]);
 stage='cancel and background keyboard';
 await review(p,'/goal add cancelled-goal;');
 await dialog(p).getByRole('button',{name:'Cancel',exact:true}).waitFor();
 await p.waitForFunction(()=>document.activeElement?.textContent==='Cancel');
 assert.deepEqual(await goals(p),[]);pass('preview has no goal mutation');
 // Focus the real chat input programmatically to simulate misplaced focus;
 // a trusted keyboard event must not approve or submit the background command.
 await p.locator('#msg-input').evaluate(el=>{el.value='/goal add background-goal';el.focus();});
 await p.keyboard.press('Enter');
 assert.equal(await dialog(p).count(),1);assert.deepEqual(await goals(p),[]);
 assert.equal(await p.locator('#msg-input').inputValue(),'/goal add background-goal');pass('background Enter neither approves nor dispatches chat');
 await dialog(p).getByRole('button',{name:'Cancel',exact:true}).click();await noDialogs(p);assert.deepEqual(await goals(p),[]);pass('cancel leaves goal storage unchanged');
 stage='explicit keyboard approval';
 await review(p,'/goal add approved-goal;');
 await dialog(p).getByRole('button',{name:'Run program',exact:true}).focus();await p.keyboard.press('Enter');await noDialogs(p);
 await waitLine(p,'RhoQu: 1/1 dispatched');assert.deepEqual(await goals(p),['approved-goal']);pass('focused Run program button executes exactly one local goal');
 stage='script and peer chat';
 await send(p,'/script /rhoqu /goal add indirect-goal');await waitLine(p,'Enter the RhoQu program directly');assert.deepEqual(await goals(p),['approved-goal']);pass('script entry cannot dispatch a RhoQu program');
 await send(peer,'//rhoqu /goal add peer-draft-goal;');await waitLine(p,'/rhoqu /goal add peer-draft-goal;');assert.equal(await dialog(p).count(),0);assert.deepEqual(await goals(p),['approved-goal']);pass('received command-shaped peer chat remains inert');
 stage='channel handler authority';
 await review(p,'on authcheck(msg) { /goal add channel-denied; }');
 await dialog(p).getByRole('button',{name:'Run program',exact:true}).click();await noDialogs(p);await waitLine(p,'1 channel handlers registered');
 await send(p,'/script /rhoqu clear');await waitLine(p,'Enter /rhoqu clear directly');
 await send(peer,'/channel send authcheck fixture');await waitLine(p,"on-handler blocked '/goal add channel-denied'");assert.deepEqual(await goals(p),['approved-goal']);pass('registered channel handler denies local goal mutation after indirect clear refusal');
 await send(p,'/rhoqu clear');await waitLine(p,'cleared 1 rhoqu on-handler');pass('direct clear removes the registered handler');
 stage='write evidence';
 const report={schema:'rhoqu-approval-browser/1',source:process.env.GITHUB_SHA,scope:'two real Chromium clients; local signaling; synthetic peer chat, not actual model inference',checks,goals:await goals(p)};
 const bytes=JSON.stringify(report,null,2)+'\n';await writeFile('rhoqu-approval-evidence.json',bytes);await writeFile('rhoqu-approval-evidence.SHA256SUMS',createHash('sha256').update(bytes).digest('hex')+'  rhoqu-approval-evidence.json\n');
}catch(e){console.error('Failed stage:',stage);throw e;}finally{await browser.close();}
