import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { QOSPeer } from '../qos-cli/qospeer.mjs';
import { spawn } from 'node:child_process';
import { generateCapability } from '../qos-cli/zfa.mjs';
const room = generateCapability('room'), other = generateCapability('room');
const signal = 'ws://127.0.0.1:4444';
const browser = await chromium.launch({args:['--no-sandbox']});
const children = [];
const pages=[];
const transportIds=new Map();
let injector;
async function wait(fn, label) {
  for(let i=0;i<120;i++){ if(await fn()) return; await new Promise(r=>setTimeout(r,500)); }
  throw Error('Timeout: '+label);
}
async function peer(port,name,cap) {
  const context=await browser.newContext();
  await context.addInitScript(n=>localStorage.setItem('qos-name',n),name);
  const page=await context.newPage(); pages.push({name,page});
  page.on('pageerror',e=>console.error(name,e.message));
 page.on('websocket',ws=>{
   if(ws.url()!==signal && ws.url()!==signal+'/') return;
   ws.on('framesent',({payload})=>{
     try {const d=JSON.parse(payload.toString()); if(d.type==='join') transportIds.set(name,d.peerId);} catch {}
   });
 });

  await page.goto('http://localhost:'+port+'/quantum-os/?signal='+encodeURIComponent(signal)+'#room='+encodeURIComponent(cap));
  await page.locator('#stun-url').evaluate(el=>{el.value='';});
  await page.locator('#connect-btn').click();
  await wait(()=>page.locator('#msg-input').isEnabled(),name+' connected');
  return page;
}
async function cmd(p,s){await p.locator('#msg-input').fill(s);await p.locator('#msg-input').press('Enter');}
async function seen(p,s){await wait(async()=> (await p.locator('#messages').innerText()).includes(s),s);}
async function balance(p,c,n){
  await wait(async()=> (await p.evaluate(({room,c})=>Object.values(JSON.parse(localStorage.getItem('qos-notes-'+room)||'{}')).filter(x=>x.currency===c).reduce((n,x)=>n+x.denomination,0),{room,c}))===n,'balance '+c+' '+n);
}
try {
 const a=await peer(5173,'Legacy',room), b=await peer(5174,'Candidate',room), c=await peer(5174,'Remote',other);
 await wait(async()=> (await a.locator('#peer-list').innerText()).includes('Candidate') && (await b.locator('#peer-list').innerText()).includes('Legacy'),'mutual discovery');
 await cmd(a,'/note declare TESTA'); await cmd(a,'/note grant TESTA 10'); await balance(a,'TESTA',10);
 await cmd(a,'/note pass TESTA 4 Candidate'); await seen(b,'received TESTA 4'); await balance(a,'TESTA',6); await balance(b,'TESTA',4);
 const wallet=async()=>b.evaluate(room=>JSON.parse(localStorage.getItem('qos-notes-'+room)||'{}'),room);
 const initial=Object.values(await wallet()).filter(n=>n.currency==='TESTA');
 assert.equal(initial.length,1); assert.equal(initial[0].denomination,4);
 const token=initial[0].token;
 assert.ok(token?.startsWith('cap:'));
 await wait(()=>transportIds.has('Candidate'),'candidate outbound signaling join captured');
 const bid=transportIds.get('Candidate');
 const injectorId=generateCapability('peer');
 injector=new QOSPeer({signalingUrl:signal,roomId:room,peerId:injectorId,iceServers:[],
   onPeerReady:id=>{injector.send(id,{kind:'name',name:'WitnessInjector'});},
   onError:e=>console.error('injector',e.message)});
 await injector.connect();
 await wait(()=>injector.roster.has(bid),'candidate present in injector signaling roster');
 await wait(async()=> (await b.locator('#peer-list').innerText()).includes('WitnessInjector'),'injector name received');
 assert.ok(injector.send(bid,{kind:'note-pass',currency:'TESTA',denomination:4,token}));
 // Same token, different known sender: persisted receivedFrom proves that the
 // duplicate reached the application's acceptance handler, not just the relay.
 await wait(async()=> (await wallet())[token]?.receivedFrom==='WitnessInjector','duplicate note handler updated receipt provenance');
 const after=Object.values(await wallet()).filter(n=>n.currency==='TESTA');
 assert.equal(after.length,1); assert.equal(after[0].token,token);
 assert.equal(after[0].denomination,4);
 await balance(b,'TESTA',4);
 console.log('PASS duplicate delivery while token held');
 await cmd(b,'/note pass TESTA 4 Legacy'); await seen(a,'received TESTA 4'); await balance(a,'TESTA',10); await balance(b,'TESTA',0);
 console.log('PASS bidirectional note conservation');
 await cmd(a,'/lemma @mixedwitness | ^v'); await wait(async()=> (await a.locator('#lemma-list').innerText()).includes('mixedwitness'),'lemma created');
 await wait(async()=> (await b.locator('#lemma-list').innerText()).includes('mixedwitness'),'lemma announcement received');
 const lemmaTitle=await a.locator('#lemma-list li').filter({hasText:'mixedwitness'}).getAttribute('title');
 await cmd(a,'/pass mixedwitness Candidate'); await seen(b,'@mixedwitness received from'); await wait(async()=> !(await a.locator('#lemma-list').innerText()).includes('mixedwitness') && (await b.locator('#lemma-list').innerText()).includes('mixedwitness'),'lemma transfer');
 assert.equal((await b.locator('#lemma-list li').filter({hasText:'mixedwitness'}).getAttribute('title')).split('  (by ')[0],lemmaTitle.split('  (by ')[0]);
 console.log('PASS legacy-to-candidate lemma transfer');
 await cmd(b,'/pass mixedwitness Legacy');
 await seen(a,'@mixedwitness received from');
 await wait(async()=> !(await b.locator('#lemma-list').innerText()).includes('mixedwitness') && (await a.locator('#lemma-list').innerText()).includes('mixedwitness'),'reverse lemma transfer');
 assert.equal((await a.locator('#lemma-list li').filter({hasText:'mixedwitness'}).getAttribute('title')).split('  (by ')[0],lemmaTitle.split('  (by ')[0]);
 console.log('PASS candidate-to-legacy lemma transfer');
 await cmd(b,'/note declare TESTB'); await cmd(b,'/note grant TESTB 7'); await balance(b,'TESTB',7);
 await cmd(a,'/rdv swap TESTA 3 TESTB 2 Candidate');
 await seen(b,'proposes rendezvous');
 const rdv=(await b.locator('#messages').innerText()).match(/proposes rendezvous ([a-zA-Z0-9]+)/);
 assert.ok(rdv,'proposal id surfaced');
 await cmd(b,'/rdv accept '+rdv[1]);
 await seen(b,'rdv '+rdv[1]+' settled');
 await balance(a,'TESTA',7); await balance(a,'TESTB',2); await balance(b,'TESTA',3); await balance(b,'TESTB',5);
 console.log('PASS rendezvous settlement and conservation');
 const invalid={kind:'lemma',name:'invalidwitness',twists:'^v',dyncap:{anchor:'bad',seq:1,witness:'bad'}};
 injector.broadcast(invalid);
 await seen(b,'refused: invalid dyncap');
 assert.ok(!(await b.locator('#lemma-list').innerText()).includes('invalidwitness'));
 console.log('PASS malformed dyncap refusal (shape control, not cryptographic authentication)');
 await cmd(a,'/lemma @bridgehistory');

 await wait(async()=> (await a.locator('#lemma-list').innerText()).includes('bridgehistory'),'legacy history created');
 const bridge=spawn(process.execPath,['scripts/qos-cli/bridge.mjs','--room',room,'--room',other,'--signal',signal,'--name','WitnessBridge','--lemmas'],{stdio:'inherit'});children.push(bridge);
 await wait(async()=> (await a.locator('#peer-list').innerText()).includes('WitnessBridge') && (await c.locator('#peer-list').innerText()).includes('WitnessBridge'),'bridge discovery');
 await wait(async()=> (await c.locator('#lemma-list').innerText()).includes('bridgehistory'),'CLI bridge historical lemma import');
 const historical=await a.evaluate(room=>JSON.parse(localStorage.getItem('qos-lemmas-'+room)||'{}').bridgehistory,room);
 assert.ok(historical?.twists && historical?.cap,'balanced historical lemma fixture');
 assert.ok(injector.send(bid,{kind:'sync-lemmas',entries:[{name:'unsignedhistory',twists:historical.twists,who:'WitnessInjector'}]}));
 await wait(async()=> (await b.locator('#lemma-list').innerText()).includes('unsignedhistory'),'unsigned legacy sync-lemmas import');
 console.log('PASS unsigned sync-lemmas import');
 console.log('PASS CLI bridge historical lemma import');
 await cmd(c,'/channel listen witness'); await cmd(a,'/channel send witness mixed-version-relay'); await seen(c,'mixed-version-relay');
 console.log('PASS actual CLI bridge unsigned channel relay');
} catch(e) {
 for(const {name,page} of pages) console.error(name,await page.locator('#messages').innerText().catch(()=>''));
 throw e;
} finally {injector?.disconnect();for(const p of children)p.kill();await browser.close();}
