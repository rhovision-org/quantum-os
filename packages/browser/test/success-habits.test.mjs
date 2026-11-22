// #289: private habit cadence/check-ins and review journal; v1 migration.
import { build } from "esbuild";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root=join(dirname(fileURLToPath(import.meta.url)),"..");
const b=await build({stdin:{contents:'export {GoalStore} from "./src/goal-store.ts";',
 resolveDir:root,loader:"ts"},bundle:true,platform:"node",format:"esm",write:false});
const {GoalStore}=await import("data:text/javascript;base64,"+Buffer.from(b.outputFiles[0].text).toString("base64"));
class Storage {
  constructor(){this.items=new Map();this.writes=[];}
  getItem(k){return this.items.get(k)??null;}
  setItem(k,v){this.writes.push([k,v]);this.items.set(k,String(v));}
}
const storage=new Storage(), alice="cap:peer/dyn:alice", bob="cap:peer/dyn:bob";
storage.setItem(GoalStore.keyFor(alice),JSON.stringify({
 v:1, goals:[{id:"g-7",text:"old goal",priority:"important",status:"open",createdAt:1}],
}));
const day=Date.UTC(2026,10,19);
let now=day;
const a=new GoalStore(storage,alice,()=>now);
assert.equal(a.list().length,1,"v1 goals preserved");
assert.equal(a.listHabits().length,0);
assert.equal(a.add("new goal").id,"g-8","v1 IDs continue");
const h=a.addHabit("  Read & reflect  ","daily");
assert.deepEqual(h,{id:"h-1",text:"Read & reflect",cadence:"daily",createdAt:day,checkIns:[]});
assert.throws(()=>a.addHabit("bad","monthly"));
assert.throws(()=>a.addHabit(" "));
assert.throws(()=>a.checkInHabit(h.id,"2026-02-31"),"invalid dates rejected");
assert.deepEqual(a.checkInHabit(h.id).checkIns,["2026-11-19"]);
assert.deepEqual(a.checkInHabit(h.id).checkIns,["2026-11-19"],"double tick is idempotent");
assert.equal(a.checkInHabit("h-unknown"),null);
now+=86400000;
assert.deepEqual(a.checkInHabit(h.id).checkIns,["2026-11-19","2026-11-20"]);
const review=a.recordReview("A <script> private note");
assert.equal(review.open,2);
assert.equal(review.done,0);
assert.equal(review.habitsChecked,1);
assert.equal(review.text,"A <script> private note");
assert.equal(a.listReviews().length,1);
a.listHabits()[0].checkIns.push("1999-01-01");
a.listReviews()[0].text="modified";
assert.equal(a.listHabits()[0].checkIns.length,2,"snapshots cannot alter store");
assert.equal(a.listReviews()[0].text,review.text);
const reloaded=new GoalStore(storage,alice,()=>now);
assert.equal(reloaded.list()[0].text,"old goal");
assert.equal(reloaded.listHabits()[0].checkIns.length,2);
assert.equal(reloaded.listReviews()[0].text,review.text);
assert.equal(reloaded.addHabit("Practice","weekly").id,"h-2");
assert.equal(reloaded.recordReview("second").id,"r-2");
assert.equal(new GoalStore(storage,bob,()=>now).listHabits().length,0,"different anchor isolated");
assert.equal(new GoalStore(storage,bob,()=>now).listReviews().length,0);
assert.equal(storage.writes.every(([key])=>key===GoalStore.keyFor(alice)),true,
 "only the owner identity localStorage key may be written");
assert.ok(!JSON.stringify(reloaded.share("g-7")).includes("A <script>"),
 "explicit goal share never includes private habit or journal content");
assert.equal(reloaded.removeHabit(h.id),true);
assert.equal(reloaded.removeHabit(h.id),false);
for(let i=0;i<105;i++)reloaded.recordReview("log "+i);
assert.equal(reloaded.listReviews().length,100,"journal storage is bounded");
assert.throws(()=>reloaded.recordReview("x".repeat(2001)));
console.log("PASS: #289 v1->v2 migration, identity isolation, habits, idempotent UTC check-ins, bounded private review log");
