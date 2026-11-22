// #289: preflight has no dispatch, expires, binds to identity + room + state,
// is single-use, rejects a bearer room capability and untrusted oversized code.
import { build } from "esbuild";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const root=join(dirname(fileURLToPath(import.meta.url)),"..");
const b=await build({stdin:{contents:'export {RhoQuPreviewStore,isHighImpactCommand} from "./src/rhoqu-preview.ts";',
 resolveDir:root,loader:"ts"},bundle:true,platform:"node",format:"esm",write:false});
const {RhoQuPreviewStore,isHighImpactCommand}=await import(
 "data:text/javascript;base64,"+Buffer.from(b.outputFiles[0].text).toString("base64"));
let now=1000, n=1;
const store=new RhoQuPreviewStore(()=>now,k=>new Uint8Array(k).fill(n++));
assert.equal(isHighImpactCommand("/help"),false);
assert.equal(isHighImpactCommand("/poll status"),false);
assert.equal(isHighImpactCommand("/goal review"),false);
assert.equal(isHighImpactCommand("/goal add something"),true);
assert.equal(isHighImpactCommand("/gov chain install"),true);
assert.equal(isHighImpactCommand("/rholang deploy (0)"),true);
assert.equal(isHighImpactCommand("not-a-command"),true);
const plan=store.prepare("/poll new Q; /poll status;",["/poll new Q","/poll status"],[],
  "room1","anchor1","state1");
assert.equal(plan.commands.length,2);
assert.equal(plan.highImpact,true);
assert.equal(store.pending("room1"),1);
assert.throws(()=>store.take(plan.token,"room2","anchor1","state1"),/room or identity/);
assert.throws(()=>store.take(plan.token,"room1","anchor1","state1"),/no pending/,"wrong room consumes token");
const p2=store.prepare("/help;",["/help"],[],"room1","anchor1","state1");
assert.equal(p2.highImpact,false);
assert.throws(()=>store.take(p2.token,"room1","anchor1","state2"),/state changed/);
assert.throws(()=>store.take(p2.token,"room1","anchor1","state1"),/no pending/);
const p3=store.prepare("/help;",["/help"],[{channel:"news"}],"room1","anchor1","state1");
assert.equal(p3.highImpact,true,"handlers are stateful");
const accepted=store.take(p3.token,"room1","anchor1","state1");
assert.deepEqual(accepted.handlers,[{channel:"news"}]);
assert.equal(store.pending("room1"),0);
assert.throws(()=>store.take(p3.token,"room1","anchor1","state1"),/no pending/);
const p4=store.prepare("/help;",["/help"],[],"room1","anchor1","state1");
now+=600001;
assert.throws(()=>store.take(p4.token,"room1","anchor1","state1"),/expired/);
assert.throws(()=>store.prepare("/share cap:room:private;",["/help"],[],"room1","a","state"),/room bearer/);
assert.throws(()=>store.prepare("/help;",["/help cap:room:secret"],[],"room1","a","state"),/room bearer/);
assert.throws(()=>store.prepare(" ",["/help"],[],"room1","a","state"),/empty/);
assert.throws(()=>store.prepare("/help;",Array(201).fill("/help"),[],"room1","a","state"),/budget/);
assert.throws(()=>store.prepare("/help;",["bad"],[],"room1","a","state"),/invalid command/);
const old=store.prepare("/help;",["/help"],[],"room1","a","state");
const fresh=store.prepare("/help;",["/help"],[],"room1","a","state");
assert.throws(()=>store.take(old.token,"room1","a","state"),/no pending/,"new preview supersedes old one");
assert.equal(store.cancel(fresh.token),true);
assert.equal(store.cancel(fresh.token),false);
console.log("PASS: #289 preview one-use consent token, context drift/expiration, no raw room cap, bounded effects");
