// quantum-os#290 — v2 runtime IR: actual IDs, execution-time state, effects,
// explicit read-only concurrency and fail-closed import validation.
import { build } from "esbuild";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const root=join(dirname(fileURLToPath(import.meta.url)),"..");
const b=await build({stdin:{
 contents:'export {compileRhoProcessIR,validateRhoProcessIR,runRhoProcessIR,interpolateRuntime,effectsOf} from "./src/rhoqu-process.ts"; export {transpile} from "./src/rhoqu.ts";',
 resolveDir:root,loader:"ts"},bundle:true,format:"esm",platform:"node",write:false});
const api=await import("data:text/javascript;base64,"+Buffer.from(b.outputFiles[0].text).toString("base64"));
const {compileRhoProcessIR:compile,validateRhoProcessIR:validate,
 runRhoProcessIR:run,interpolateRuntime:interpolate,effectsOf,transpile}=api;
let peers=1, connected=true;
const context=()=>({
 hasLemma:()=>false,balance:()=>0,isCurrencyDeclared:()=>false,
 peerCount:()=>peers,isConnected:()=>connected,myCurrentSeq:()=>0,
});
const host=(exec=async c=>({ok:true}))=>({
 context,authorize:()=>true,execute:exec,
});
const p=compile("let poll = /poll new Charter; /poll add $poll yes; /poll status $LAST_ID;",context());
assert.equal(p.schema,"rhoqu.process.ir/1");
assert.equal(p.verification,"unverified");
assert.equal(p.nodes[0].bind,"poll");
assert.equal(p.nodes[0].command,"/poll new Charter");
assert.equal(p.nodes[1].command,"/poll add $poll yes");
assert.equal(JSON.stringify(p),JSON.stringify(compile("let poll = /poll new Charter; /poll add $poll yes; /poll status $LAST_ID;",context())));
validate(JSON.parse(JSON.stringify(p)));
const actualId="poll-live-2abf";
const calls=[];
const r=await run(p,host(async cmd=>{
 calls.push(cmd);
 return cmd==="/poll new Charter"?{ok:true,id:actualId}:{ok:true};
}));
assert.equal(r.ok,true,r.error);
assert.deepEqual(calls,["/poll new Charter","/poll add "+actualId+" yes","/poll status "+actualId],
 "no guessed result ID; bind uses the actual host-returned value");
assert.equal(r.bindings.poll,actualId);
assert.equal(r.receipts[0].id,actualId);
const missing=await run(p,host(async()=>({ok:true})));
assert.equal(missing.ok,false);
assert.match(missing.error,/no verified result ID/);
assert.equal(missing.receipts.length,1,"fail closed before using a missing ID");

const when=compile("when peers() >= 2 { /lemma enough; } else { /lemma lacking; }",context());
peers=3;
const w=await run(when,host(async c=>({ok:c==="/lemma enough"})));
assert.equal(w.ok,true,w.error);
assert.equal(w.receipts[0].command,"/lemma enough","branch uses execution-time context");
peers=1;
const w2=await run(when,host(async c=>({ok:c==="/lemma lacking"})));
assert.equal(w2.ok,true);
assert.equal(w2.receipts[0].command,"/lemma lacking");
const compileTime=compile("if peers() >= 2 { /lemma enough; } else { /lemma lacking; }",context());
peers=10;
const ct=await run(compileTime,host(async c=>({ok:c==="/lemma lacking"})));
assert.equal(ct.ok,true,"legacy if is still compile-time");

connected=false;
const gate=compile("require connected(); /lemma next;",context());
assert.equal((await run(gate,host())).ok,false,"closure requirement fails before command");
connected=true;
assert.equal((await run(gate,host())).ok,true);
const absent=await run(compile("/goal add Some goal;",context()),{
 ...host(),authorize:()=>false,
});
assert.equal(absent.ok,false);
assert.equal(absent.receipts.length,0,"authorization happens before dispatch");
const stopped=new AbortController();stopped.abort();
assert.equal((await run(compile("/help;",context()),host(),stopped.signal)).ok,false);

const legacy="/grant alpha; /lemma beta;";
const golden=compile(legacy,context());
assert.deepEqual(golden.nodes.map(x=>x.command),transpile(legacy,context()),
 "backwards-compatible flat lowering");
const defined=compile("process P(x) { /lemma $x; } P(ready);",context());
assert.deepEqual(defined.nodes.map(x=>x.command),["/lemma ready"]);
assert.throws(()=>compile("process P() { P(); } P();",context()),/recursive/);

const parallel=compile("parallel { /grant a; /grant b; }",context());
assert.deepEqual(parallel.nodes.map(x=>x.command),["/grant a","/grant b"],
 "legacy parallel retains sequential compatibility");
let active=0,overlap=0;
const concurrency=compile("concurrent { /help; /goal list; }",context());
const runParallel=await run(concurrency,host(async command=>{
 active++;overlap=Math.max(overlap,active);
 await new Promise(resolve=>setTimeout(resolve,10));
 active--;
 return {ok:true,value:command};
}));
assert.equal(runParallel.ok,true,runParallel.error);
assert.equal(overlap,2,"v2 concurrent read-only branches genuinely overlap");
assert.deepEqual(runParallel.receipts.map(x=>x.command),["/help","/goal list"],
 "receipts remain author-order deterministic");
assert.throws(()=>compile("concurrent { /goal add x; /help; }",context()),/read-only/);
assert.throws(()=>compile("concurrent { let p = /poll new y; /help; }",context()),/read-only/);
assert.throws(()=>compile("on feedback(msg) { /lemma feedback; }",context()),/on-handler/);

const tampered=JSON.parse(JSON.stringify(golden));
tampered.nodes[0].effect="read";
assert.throws(()=>validate(tampered),/forged/);
const tamperedVerify=JSON.parse(JSON.stringify(golden));
tamperedVerify.verification="lean-verified";
assert.throws(()=>validate(tamperedVerify),/unsupported/);
assert.throws(()=>compile("/help cap:room:secret;",context()),/invalid or overly long/);
assert.equal((await run(compile("/goal done $missing;",context()),host())).ok,false,
 "unresolved variable cannot become a silently literal token");
assert.equal(interpolate("$$USD and $X",new Map([["X","id-a"]]),undefined),
 "$USD and id-a");
assert.equal(effectsOf("/rholang deploy ...").effect,"chain-write");
assert.equal(effectsOf("/help").effect,"read");
console.log("PASS: #290 runtime binding, real returned IDs, live control flow, closure gate, safe concurrency, tamper rejection");
