// #289 — deterministic, private view-model + safe DOM actions.
import { build } from "esbuild";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const result = await build({
  stdin: {
    contents: 'export {successSnapshot,renderSuccessPanel} from "./src/success-panel.ts";',
    resolveDir: join(here, ".."),
    loader: "ts",
  },
  bundle: true, format: "esm", platform: "node", write: false,
});
const { successSnapshot, renderSuccessPanel } = await import(
  "data:text/javascript;base64," + Buffer.from(result.outputFiles[0].text).toString("base64")
);
const goals = [
  {id:"g-1",text:"secret <script>alert(1)</script>",priority:"urgent-important",status:"open",createdAt:1},
  {id:"g-2",text:"completed",priority:"neither",status:"done",createdAt:2},
];
const groups = [
  {id:"z",name:"Zeta <img src=x>",members:{a:{},b:{}},issues:[{id:"i",title:"Vote",status:"open",pollId:"poll"}],vaults:{secret:"SECRET"},chain:{group:"rho:id:foo"}},
  {id:"a",name:"Alpha",members:{a:{}},issues:[]},
];
const s = successSnapshot(goals, groups);
assert.equal(s.open.length, 1);
assert.equal(s.done.length, 1);
assert.equal(s.buckets[0].goals.length, 1);
assert.deepEqual(s.groups.map(x => x.id), ["a","z"]);
assert.equal(s.groups[1].issues[0].hasPoll, true);
assert.equal(s.groups[1].hasChainReference, true);
assert.ok(!JSON.stringify(s.groups).includes("SECRET"), "private group fields never copied");
s.open[0].text = "tampered";
assert.equal(goals[0].text, "secret <script>alert(1)</script>");

class E {
  constructor(tag){this.tag=tag;this.children=[];this.events={};this.textContent="";}
  append(...a){this.children.push(...a);}
  appendChild(x){this.children.push(x);return x;}
  replaceChildren(...a){this.children=a;}
  setAttribute(k,v){(this.attrs??={})[k]=v;}
  addEventListener(k,fn){this.events[k]=fn;}
}
globalThis.document={createElement:t=>new E(t)};
const host=new E("main");
const actions=[];
renderSuccessPanel(host,successSnapshot(goals,groups),{
  addGoal:(t,p)=>actions.push(["add",t,p]),
  completeGoal:id=>actions.push(["done",id]),
  openGroup:id=>actions.push(["group",id]),
});
const walk=n=>[n,...n.children.flatMap(walk)];
const nodes=walk(host);
assert.ok(nodes.some(n=>n.textContent==="secret <script>alert(1)</script>"),"untrusted text stays text");
assert.ok(!nodes.some(n=>"innerHTML" in n),"no unsafe HTML parsing");
const f=nodes.find(n=>n.tag==="form");
f.children.find(n=>n.tag==="input").value=" New goal ";
f.children.find(n=>n.tag==="select").value="urgent";
f.events.submit({preventDefault(){}});
assert.deepEqual(actions.pop(),["add","New goal","urgent"]);
nodes.find(n=>n.tag==="button"&&n.textContent==="Complete").events.click();
assert.deepEqual(actions.pop(),["done","g-1"]);
nodes.find(n=>n.tag==="button"&&n.textContent==="View group").events.click();
assert.deepEqual(actions.pop(),["group","a"]);
const habits=[{id:"h-1",text:"Private ritual",cadence:"daily",checkIns:[],createdAt:1}];
const reviews=[{id:"r-1",at:Date.UTC(2026,10,19),text:"<b>Private notes</b>",
  open:1,done:1,habitsChecked:0}];
const expanded=successSnapshot(goals,groups,habits,reviews);
expanded.habits[0].checkIns.push("2000-01-01");
assert.equal(habits[0].checkIns.length,0,"habit snapshot is detached");
assert.equal(expanded.reviews[0].text,reviews[0].text);
const host2=new E("main"),actions2=[];
renderSuccessPanel(host2,successSnapshot(goals,groups,habits,reviews),{
  addGoal:()=>{}, completeGoal:()=>{},openGroup:()=>{},
  addHabit:(t,c)=>actions2.push(["habit",t,c]),
  tickHabit:id=>actions2.push(["tick",id]),
  recordReview:t=>actions2.push(["review",t]),
});
const nodes2=walk(host2);
assert.ok(nodes2.some(n=>n.textContent.includes("<b>Private notes</b>")),"journal text is safe DOM text");
assert.ok(!nodes2.some(n=>"innerHTML" in n));
const habitForm=nodes2.find(n=>n.tag==="form" &&
  n.children.some(c=>c.tag==="button"&&c.textContent==="Add habit"));
habitForm.children.find(n=>n.tag==="input").value=" Walk ";
habitForm.children.find(n=>n.tag==="select").value="weekly";
habitForm.events.submit({preventDefault(){}});
assert.deepEqual(actions2.pop(),["habit","Walk","weekly"]);
nodes2.find(n=>n.tag==="button"&&n.textContent==="Check in").events.click();
assert.deepEqual(actions2.pop(),["tick","h-1"]);
const reviewForm=nodes2.find(n=>n.tag==="form"&&
  n.children.some(c=>c.tag==="button"&&c.textContent==="Record review"));
reviewForm.children.find(n=>n.tag==="input").value=" Reflect ";
reviewForm.events.submit({preventDefault(){}});
assert.deepEqual(actions2.pop(),["review","Reflect"]);
console.log("PASS: #289 success panel model, privacy, safe DOM, and actions");

// Integration contract: direct private goal input bypasses shared room/history
// sinks; dispatcher output uses the private, nonpersisted DOM path.
const {readFileSync}=await import("node:fs");
const app=readFileSync(join(here,"../src/app.ts"),"utf8");
const sendBody=app.slice(app.indexOf("function send(): void"),app.indexOf("// Share link",app.indexOf("function send(): void")));
assert.match(sendBody,/if \(isPrivateGoalCommand\(text\)\) \{[\s\S]*?handleCommand\(text, \{ directInput: true \}\);[\s\S]*?return;[\s\S]*?pushHistory\(text\)/);
assert.match(app,/if \(cmd === "goal"\) \{[\s\S]*?showPrivateGoalOutput\(text\);[\s\S]*?return;[\s\S]*?addMessage\("", text, "system"\)/);
const privateOutput=app.slice(app.indexOf("function showPrivateGoalOutput"),app.indexOf("function addMessage("));
assert.ok(privateOutput.includes("textContent = text"));
assert.ok(!/chatLog|saveChat|innerHTML|sessionLog|broadcast/.test(privateOutput));
assert.match(app,/if \(!commandOptions\.directInput\) \{ sys\("share requires direct \/goal share/);
const restoreStart = app.indexOf("const restored = await deserializeState(parsed.state");
const restoreEnd = app.indexOf("qosCommands.clear()", restoreStart);
assert.ok(restoreStart >= 0 && restoreEnd > restoreStart);
assert.match(app.slice(restoreStart, restoreEnd), /clearPrivateGoalOutput\(\);[\s\S]*?dyncapState = restored;/);
console.log("PASS: private command routing, ephemeral output, direct-only share and identity-switch cleanup integration");
