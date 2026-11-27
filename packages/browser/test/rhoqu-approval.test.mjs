// Exercise the exact production confirmation function and command entry guard
// with a minimal DOM double. Native browser keyboard activation is not emulated.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { transform } from "esbuild";
const app = readFileSync(new URL("../src/app.ts", import.meta.url), "utf8");
const start = app.indexOf("function confirmDialog(");
const end = app.indexOf("\nfunction secureDialog(", start);
assert(start >= 0 && end > start);
const dialog = app.slice(start, end);
const clearStart = app.indexOf('if (src === "clear") {', app.indexOf('case "rhoqu": {'));
const clearEnd = app.indexOf('\n      if (!src)', clearStart);
assert(clearStart >= 0 && clearEnd > clearStart);
const source = `${dialog}\nexport { confirmDialog };\nexport function clearHandlers(directInput: boolean, rhoquHandlers: unknown[]) { const commandOptions = { directInput }; const activeRoom = {rhoquHandlers}; const src = "clear"; const lines: string[] = []; const sys = (line: string) => lines.push(line); switch ("rhoqu") { case "rhoqu": { ${app.slice(clearStart, clearEnd)} } } return lines; }`;
const { code } = await transform(source, {loader:"ts",format:"esm"});
const {confirmDialog,clearHandlers} = await import("data:text/javascript;base64,"+Buffer.from(code).toString("base64"));
const keys = new Set();
let focused;
class Element {
  constructor(tag) { this.tag = tag; this.dataset={}; this.style={}; this.children=[]; this.listeners=new Map(); }
  append(...children) { for (const c of children) this.appendChild(c); }
  appendChild(c) { c.parent=this; this.children.push(c); return c; }
  remove() { this.parent.children=this.parent.children.filter(c=>c!==this); }
  addEventListener(type, fn) { this.listeners.set(type, fn); }
  focus() { focused=this; }
  click() { this.listeners.get("click")?.({target:this}); }
}
const body=new Element("body");
globalThis.document={body,createElement:tag=>new Element(tag),querySelectorAll:()=>body.children.filter(c=>c.dataset.confirmDialog==="true"),addEventListener:(type,fn)=>keys.add(fn),removeEventListener:(type,fn)=>keys.delete(fn)};
function key(name,target) { const e={key:name,target,preventDefault(){this.prevented=true;},stopImmediatePropagation(){this.stopped=true;}}; for (const fn of [...keys]) fn(e); return e; }
function buttons(overlay) { return overlay.children[0].children[2].children; }
const tick=()=>new Promise(r=>setTimeout(r,0));
let first, second;
const a=confirmDialog("Old","one").then(v=>first=v);
const b=confirmDialog("Review RhoQu program","two","Run program",true).then(v=>second=v);
await tick();
const [lower,upper]=body.children;
const [cancel,run]=buttons(upper);
assert.equal(focused,cancel,"RhoQu must focus cancel by default");
const unrelated = key("Enter",body); assert(unrelated.prevented && unrelated.stopped); await tick(); assert.equal(first,undefined); assert.equal(second,undefined);
buttons(lower)[1].click(); await tick(); assert.equal(first,undefined,"covered confirm cannot approve");
run.click(); await b; assert.equal(second,true); assert.equal(first,undefined);
key("Enter",body); await a; assert.equal(first,true,"legacy topmost Enter remains supported");
const c=confirmDialog("Review RhoQu program","three","Run program",true); buttons(body.children[0])[0].click(); assert.equal(await c,false);
const d=confirmDialog("Review RhoQu program","four","Run program",true); key("Escape",body); assert.equal(await d,false);
assert.equal(keys.size,0); assert.equal(body.children.length,0);
const handlers=[{channel:"feedback"}];
assert.match(clearHandlers(false,handlers)[0],/directly/); assert.equal(handlers.length,1);
clearHandlers(true,handlers); assert.equal(handlers.length,0);
console.log("PASS: RhoQu approval dialog and direct clear guard (production source, DOM double)");
