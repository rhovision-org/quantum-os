import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
// Execute the actual pinned implementation, with only its dependencies injected.
// This is a deterministic initialization unit witness, not a live startup race.
for (const dir of ['/tmp/legacy','/tmp/candidate']) {
 const source=readFileSync(dir+'/packages/browser/src/app.ts','utf8');
 const start=source.indexOf('function signedBroadcast(');
 const end=source.indexOf('\nfunction signedSend(',start);
 assert.ok(start>=0 && end>start);
 const fn=source.slice(start,end).replace('envelope: Record<string, unknown>): void','envelope)');
 const sent=[];
 const ctx=vm.createContext({signQueue:Promise.resolve(),qpeer:{broadcast:e=>sent.push(e)},dyncapState:null,signEnvelope:()=>{throw Error('unexpected signing');}});
 vm.runInContext(fn+'\nsignedBroadcast({kind:"lemma",name:"init-fallback"});',ctx);
 await ctx.signQueue;
 assert.equal(sent.length,1);
 assert.equal(sent[0].name,'init-fallback');
 assert.equal(sent[0].dyncap,undefined);
 console.log('PASS actual signedBroadcast fallback function: '+dir);
}
