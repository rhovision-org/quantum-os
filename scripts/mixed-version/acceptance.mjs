import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { generateCapability } from '../qos-cli/zfa.mjs';
const room = generateCapability('room'), other = generateCapability('room');
const signal = 'ws://127.0.0.1:4444';
const browser = await chromium.launch({args:['--no-sandbox']});
const children = [];
async function wait(fn, label) {
  for(let i=0;i<120;i++){ if(await fn()) return; await new Promise(r=>setTimeout(r,500)); }
  throw Error('Timeout: '+label);
}
async function peer(port,name,cap) {
  const context=await browser.newContext();
  await context.addInitScript(n=>localStorage.setItem('qos-name',n),name);
  const page=await context.newPage();
  page.on('pageerror',e=>console.error(name,e.message));
  await page.goto('http://localhost:'+port+'/quantum-os/?signal='+encodeURIComponent(signal)+'#room='+encodeURIComponent(cap));
  await page.locator('#connect-btn').click();
  await wait(()=>page.locator('#msg-input').isEnabled(),name+' connected');
  return page;
}
async function cmd(p,s){await p.locator('#msg-input').fill(s);await p.locator('#msg-input').press('Enter');}
async function seen(p,s){await wait(async()=> (await p.locator('#messages').innerText()).includes(s),s);}
async function balance(p,c,n){
  const before=await p.locator('#messages').innerText();
  await cmd(p,'/note balance '+c);
  await wait(async()=>{const t=await p.locator('#messages').innerText();return t!==before && t.slice(before.length).includes(n===0?'no '+c+' notes':c+': '+n)},'balance '+c+' '+n);
}
try {
 const a=await peer(5173,'Legacy',room), b=await peer(5174,'Candidate',room), c=await peer(5174,'Remote',other);
 await wait(async()=> (await a.locator('#peer-list').innerText()).includes('Candidate') && (await b.locator('#peer-list').innerText()).includes('Legacy'),'mutual discovery');
 await cmd(a,'/note declare TESTA'); await cmd(a,'/note grant TESTA 10'); await balance(a,'TESTA',10);
 await cmd(a,'/note pass TESTA 4 Candidate'); await seen(b,'received TESTA 4'); await balance(a,'TESTA',6); await balance(b,'TESTA',4);
 await cmd(b,'/note pass TESTA 4 Legacy'); await seen(a,'received TESTA 4'); await balance(a,'TESTA',10); await balance(b,'TESTA',0);
 console.log('PASS bidirectional note conservation');
 await cmd(a,'/lemma @mixedwitness'); await wait(async()=> (await a.locator('#lemma-list').innerText()).includes('mixedwitness'),'lemma created');
 await cmd(a,'/pass mixedwitness Candidate'); await wait(async()=> !(await a.locator('#lemma-list').innerText()).includes('mixedwitness') && (await b.locator('#lemma-list').innerText()).includes('mixedwitness'),'lemma transfer');
 console.log('PASS lemma transfer');
 const bridge=spawn(process.execPath,['scripts/qos-cli/bridge.mjs','--room',room,'--room',other,'--signal',signal,'--name','WitnessBridge','--lemmas'],{stdio:'inherit'});children.push(bridge);
 await wait(async()=> (await a.locator('#peer-list').innerText()).includes('WitnessBridge') && (await c.locator('#peer-list').innerText()).includes('WitnessBridge'),'bridge discovery');
 await cmd(c,'/channel listen witness'); await cmd(a,'/channel send witness mixed-version-relay'); await seen(c,'mixed-version-relay');
 console.log('PASS actual CLI bridge unsigned channel relay');
} finally {for(const p of children)p.kill();await browser.close();}
