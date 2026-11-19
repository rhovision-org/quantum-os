// #290: capture verified IDs from actual store deltas, not chat strings.
import { build } from "esbuild";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const root=join(dirname(fileURLToPath(import.meta.url)),"..");
const built=await build({stdin:{
 contents:'export {capturedIdKind,runWithStructuredId} from "./src/rhoqu-result.ts";',
 resolveDir:root,loader:"ts"},bundle:true,format:"esm",platform:"node",write:false});
const {capturedIdKind:kind,runWithStructuredId:run}=await import(
 "data:text/javascript;base64,"+Buffer.from(built.outputFiles[0].text).toString("base64"));
const ids=["poll","lemma","note","currency","rendezvous","qos","goal","group","issue"];
const inputs=[
 ["/poll new Topic","poll","poll-REAL-uuid"],
 ["/lemma @claim","lemma","claim"],
 ["/note grant USD 10","note","cap:note:actual"],
 ["/note declare USD","currency","cap:currency:actual"],
 ["/rdv swap peer USD 10 EUR 9","rendezvous","rdv-actual"],
 ["/qos start process","qos","qos-actual"],
 ["/goal add private","goal","g-3"],
 ["/gov new Council","group","grp-a"],
 ["/gov issue Charter","issue","issue-a"],
];
for(const [input,expected,actual] of inputs){
 assert.equal(kind(input),expected);
 const values=Object.fromEntries(ids.map(k=>[k,[]]));
 let hits=0;
 const receipt=await run(input,{
   snapshot:()=>Object.fromEntries(ids.map(k=>[k,[...values[k]]])),
   invoke:async()=>{hits++;values[expected].push(actual);return {ok:true,value:"ok"};},
 });
 assert.equal(receipt.ok,true,receipt.error);
 assert.equal(receipt.id,actual,"never generate an ID from the command text");
 assert.equal(hits,1,"command must execute exactly once");
}
assert.equal(kind("/poll status"),null);
const empty=Object.fromEntries(ids.map(k=>[k,[]]));
const noCreation=await run("/poll new Topic",{
 snapshot:()=>empty,invoke:async()=>({ok:true,value:"poll created"}),
});
assert.equal(noCreation.ok,false,"success-looking text without state delta is rejected");
assert.match(noCreation.error,/no unique verified/);
const duplicate=await run("/poll new Topic",{
 snapshot:()=>empty,
 invoke:async()=>{empty.poll=["poll-1","poll-2"];return {ok:true};},
});
assert.equal(duplicate.ok,false,"ambiguous multiple IDs are rejected");
const denied=await run("/poll new Topic",{
 snapshot:()=>Object.fromEntries(ids.map(k=>[k,[]])),
 invoke:async()=>({ok:false,error:"not authorized"}),
});
assert.equal(denied.ok,false);
assert.match(denied.error,/not authorized/);
const bad=Object.fromEntries(ids.map(k=>[k,[]]));
const poison=await run("/goal add X",{
 snapshot:()=>Object.fromEntries(ids.map(k=>[k,[...bad[k]]])),
 invoke:async()=>{bad.goal.push("g-1; /note pass");return {ok:true};},
});
assert.equal(poison.ok,false,"newline/semicolon command injection prohibited");
const readonly=await run("/help",{snapshot:()=>{throw new Error("snapshot not needed");},
 invoke:async()=>({ok:true,value:"usage"})});
assert.equal(readonly.ok,true);
assert.equal(readonly.id,undefined);
assert.equal(readonly.value,"usage");
console.log("PASS: #290 actual IDs across poll/lemma/note/rdv/qos/goals/groups, ambiguous/failure controls");
