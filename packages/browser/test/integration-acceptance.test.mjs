import { build } from "esbuild";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {dirname,join} from "node:path";
const here=dirname(fileURLToPath(import.meta.url));
const bundle=await build({stdin:{contents:'export {transpileProcess} from "./src/rhoqu.ts"; export {flatPreviewCommands,RhoQuPreviewStore} from "./src/rhoqu-preview.ts";',resolveDir:join(here,".."),loader:"ts"},bundle:true,platform:"node",format:"esm",write:false});
const {transpileProcess,flatPreviewCommands,RhoQuPreviewStore}=await import("data:text/javascript;base64,"+Buffer.from(bundle.outputFiles[0].text).toString("base64"));
const handlers=[];
const ctx={registerOnHandler:h=>handlers.push(h)};
const compile=s=>transpileProcess(s,ctx);
assert.deepEqual(flatPreviewCommands(compile("/help; /qucalc ^v;")),["/help","/qucalc ^v"]);
for(const source of [
 "when connected() { /help; } else { /qucalc ^v; }",
 "parallel { /help; /qucalc ^v; }",
 "/qucalc $LAST_ID;",
]) assert.throws(()=>flatPreviewCommands(compile(source)),/typed runtime effects/);
assert.throws(()=>flatPreviewCommands({kind:"command",command:"/help",bind:"id"}),/typed runtime effects/);
assert.throws(()=>compile("when connected() { on a(msg) { /qucalc ^v; } }"),/runtime when/);
assert.equal(handlers.length,0);
const store=new RhoQuPreviewStore(()=>1,n=>new Uint8Array(n).fill(1));
const plan=store.prepare("/help;",flatPreviewCommands(compile("/help;")),[],"room","anchor","snapshot");
assert.deepEqual(store.take(plan.token,"room","anchor","snapshot").commands,["/help"]);
assert.throws(()=>store.take(plan.token,"room","anchor","snapshot"),/no pending/);
const app=readFileSync(join(here,"../src/app.ts"),"utf8");
assert.match(app,/if \(!directUserInput\) \{ sys\("approval requires direct user input/);
assert.match(app,/if \(!directUserInput\) \{ sys\("charter handoff requires direct user input/);
assert.match(app,/commands.some\(requiresInteractiveApproval\)/);
assert.match(app,/if \(handlers.length\) throw new Error\("preview does not authorize persistent handlers/);
console.log("PASS: integration candidate, typed compiler / conservative flat approval / replay / direct-input guards");
