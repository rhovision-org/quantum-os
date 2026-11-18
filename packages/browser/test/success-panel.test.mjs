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
console.log("PASS: #289 success panel model, privacy, safe DOM, and actions");
