// #290 — serializable RhoQu surface IR, deterministic compatibility lowering.
import { build } from "esbuild";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here=dirname(fileURLToPath(import.meta.url));
const b=await build({
 stdin:{contents:'export {transpile,compileRhoQuSurfaceIR,lowerRhoQuSurfaceIR,validateRhoQuSurfaceIR} from "./src/rhoqu.ts";',
 resolveDir:join(here,".."),loader:"ts"},
 bundle:true,format:"esm",platform:"node",write:false,
});
const api=await import("data:text/javascript;base64,"+Buffer.from(b.outputFiles[0].text).toString("base64"));
const {transpile,compileRhoQuSurfaceIR:compile,lowerRhoQuSurfaceIR:lower,validateRhoQuSurfaceIR:validate}=api;
const ctx=()=>({hasLemma:()=>false,balance:()=>0,isCurrencyDeclared:()=>false,peerCount:()=>3,isConnected:()=>true,myCurrentSeq:()=>0});
const samples=[
 "/grant alpha; /lemma beta;",
 "process P(x) { /lemma $x; } P(yes);",
 "new alpha beta;",
 "parallel { /grant alpha; /grant beta; }",
 "if connected() { /lemma yes; } else { /lemma no; }",
 "process P(x) { /lemma $x; } process Q(y) { P(mark); } Q(other);",
 "if peers() >= 2 { /lemma enough; } else { /lemma not-enough; }",
];
for(const source of samples){
 let a;
 try { a=compile(source); }
 catch(e) { console.error("INVALID SAMPLE:",source,"ERROR:",e.message); process.exit(2); }
 assert.equal(a.schema,"rhoqu.surface.ir/1");
 assert.equal(a.execution,"compat-sequential");
 assert.equal(JSON.stringify(a),JSON.stringify(compile(source)),"deterministic IR");
 const restored=JSON.parse(JSON.stringify(a));
 validate(restored);
 assert.deepEqual(lower(restored,ctx()),transpile(source,ctx()),"JSON round trip retains command sequence");
}
const p=compile("parallel { /grant alpha; /grant beta; }");
assert.deepEqual(lower(p),["/grant alpha","/grant beta"],"legacy parallel still sequential");
let registered=[];
const onSource="on news(msg) { /lemma $msg; }";
const handlerPlan=compile(onSource);
assert.equal(registered.length,0,"compilation cannot register a handler");
lower(JSON.parse(JSON.stringify(handlerPlan)),{...ctx(),registerOnHandler:x=>registered.push(x)});
assert.equal(registered.length,1,"lowering preserves handler registration");
assert.deepEqual(registered[0].trigger("report"),["/lemma report"]);
const throws=(plan,label)=>{
 assert.throws(()=>lower(plan,ctx()),undefined,label);
};
throws({...p,schema:"rhoqu.surface.ir/2"},"unknown schema");
throws({...p,execution:"concurrent"},"no silent parallel promotion");
throws({...p,top:[{kind:"raw-eval",source:"bad"}]},"unknown statement");
throws({...p,top:[{kind:"cmd",text:"arbitrary text"}]},"command prefix fail-closed");
throws({...p,definitions:[{name:"P",params:[],body:[]},{name:"P",params:[],body:[]}]},"duplicate process");
const deep={kind:"parallel",body:[]}; let cursor=deep;
for(let i=0;i<70;i++){const child={kind:"parallel",body:[]};cursor.body=[child];cursor=child;}
throws({...p,top:[deep]},"depth guard");
const valid=compile("if connected() { /lemma yes; } else { /lemma no; }");
const nowOff={...ctx(),isConnected:()=>false};
assert.deepEqual(lower(valid,nowOff),["/lemma no"],"compile-time condition samples the supplied context at lowering");
console.log("PASS: #290 surface IR, serialized replay, legacy golden equivalence, handler isolation, fail-closed validation");
