// CI-only validation: independent pure scheduler model + canonical room replay.
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bundle = await build({
  stdin:{contents:`
    export { QosScheduler, MAX_PRIORITY } from "./src/qos-scheduler.ts";
    export { replayQosKernel, previewCanonicalSyscall } from "./src/qos-kernel.ts";
    export { QosProcessRoom, QosEventLog } from "./src/qos-process.ts";
    export { newDynCapState } from "./src/dyncap.ts";
  `,resolveDir:root,loader:"ts",sourcefile:"scheduler-test-entry.ts"},
  bundle:true,format:"esm",platform:"node",write:false
});
const {QosScheduler, MAX_PRIORITY, replayQosKernel, previewCanonicalSyscall, QosProcessRoom,QosEventLog,newDynCapState} =
  await import("data:text/javascript;base64,"+Buffer.from(bundle.outputFiles[0].text).toString("base64"));
let checks=0;
function check(label, condition) { assert.ok(condition,label); checks++; console.log("  ok   "+label); }
const task=(pid,state="running")=>({pid,state});
{
  const s=new QosScheduler();
  s.sync([task("high"),task("low"),task("mid")]);
  check("initial admission orders simultaneous PIDs",s.view().running==="high" && s.view().ready.join(",")==="low,mid");
  assert.ok(s.turn("high","sched_priority",MAX_PRIORITY).ok);
  assert.ok(s.turn("low","sched_priority",0).ok);
  assert.ok(s.turn("mid","sched_priority",1).ok);
  const visits=[], last=new Map(), maxGap=new Map();
  for(let i=0;i<140;i++){
    const pid=s.view().running;
    visits.push(pid);
    if(last.has(pid))maxGap.set(pid,Math.max(maxGap.get(pid)??0,i-last.get(pid)));
    last.set(pid,i);
    assert.ok(s.turn(pid,"sched_step").ok);
  }
  check("weighted round robin gives all priorities CPU turns",["high","low","mid"].every(p=>visits.includes(p)));
  check("low priority has bounded inter-service gap",maxGap.get("low")<=7);
  check("weighted schedule allocates 4:1:2 quanta",visits.filter(p=>p==="high").length===80 && visits.filter(p=>p==="low").length===20 && visits.filter(p=>p==="mid").length===40);
  const before=JSON.stringify(s.state());
  const other=s.view().ready[0];
  check("nonselected process cannot advance logical time",s.turn(other,"sched_step").errno==="EAGAIN" && JSON.stringify(s.state())===before);
  check("invalid sleep and priority are atomic",s.turn(s.view().running,"sleep",0).errno==="EINVAL" && s.turn(s.view().running,"sched_priority",4).errno==="EINVAL" && JSON.stringify(s.state())===before);
  const clone=s.clone();
  assert.ok(clone.turn(clone.view().running,"yield").ok);
  check("speculative scheduler clone isolates queue and clock",JSON.stringify(s.state())===before && clone.view().tick===s.view().tick+1);
}
{
  const s=new QosScheduler();
  s.sync([task("a"),task("b")]);
  assert.ok(s.turn("a","sleep",5).ok);
  assert.ok(s.turn("b","sleep",4).ok);
  check("sleep blocks both processes and leaves idle scheduler",s.view().running===null && s.view().tick===2 && s.view().tasks.every(t=>t.state==="blocked"));
  assert.ok(s.turn("b","sched_wake").ok);
  check("idle wake jumps exactly to earliest deadline",s.view().tick===5 && s.view().running==="a" && s.view().ready.join(",")==="b");
  s.sync([task("a","suspended"),task("b")]);
  check("suspend removes current task without losing next runnable",s.view().running==="b" && s.view().tasks[0].state==="blocked");
  s.sync([task("a"),task("b","exited")]);
  check("resume requeues and exited task is zombie",s.view().running==="a" && s.view().tasks[1].state==="zombie" && s.view().ready.length===0);
}
{
  const roomId="cap:room:03010563656127610341634101250325";
  const identities=await Promise.all([110,111].map(n=>newDynCapState(new Uint8Array(32).fill(n))));
  identities.sort((a,b)=>a.anchor<b.anchor?-1:a.anchor>b.anchor?1:0);
  const make=identity=>new QosProcessRoom({roomId,identity,transport:{broadcast:()=>{}}});
  const a=make(identities[0]),b=make(identities[1]);
  const x=await a.startProcess("scheduler-a",{entropyHex:"aa"}),y=await b.startProcess("scheduler-b",{entropyHex:"ab"});
  await a.log.mergeFrom(b.log); await b.log.mergeFrom(a.log);
  const replay=room=>replayQosKernel(room.log.events(),room.log.forkedSources);
  const entries=new Map([[x.processId,[a,x,b]],[y.processId,[b,y,a]]]);
  const call=async(op,args={})=>{
    const [room,start,peer]=entries.get(replay(a).kernel.scheduleView().running ?? y.processId);
    const pid=start.processId;
    const payload={schema:"qos.syscall/1",caller:pid,op,args:{...args,scheduleFrontier:replay(room).kernel.schedulerFrontier()}};
    const before=await replay(room).kernel.stateDigest();
    const req=await room.emit(pid,start.event,"syscall-request",payload);
    const pending=replay(room);
    assert.ok(pending.pendingSyscalls.includes(req.hash),op+" request rejected");
    assert.equal(await pending.kernel.stateDigest(),before,"request alone mutated state");
    const outcome=previewCanonicalSyscall(pending.kernel,payload,pid,req.hash);
    assert.ok(outcome?.ok,op+" preview refused "+JSON.stringify(outcome));
    const result=await room.emit(pid,start.event,"syscall-result",{schema:"qos.syscall/1",requestHash:req.hash,outcome});
    await peer.log.mergeFrom(room.log);
    const after=replay(peer);
    assert.ok(after.syscalls.some(t=>t.resultHash===result.hash),op+" result rejected "+JSON.stringify(after.rejected));
    assert.equal(await after.kernel.stateDigest(),await replay(room).kernel.stateDigest());
    return {req,result,outcome};
  };
  const first=await call("sched_priority",{priority:3});
  await call("sched_step");
  await call("sleep",{ticks:5});
  await call("sleep",{ticks:4});
  check("canonical sleep transitions to idle",replay(a).kernel.scheduleView().running===null);
  const wake=await call("sched_wake");
  check("canonical idle wake restores ready task",wake.outcome.value.tick===7 && wake.outcome.value.running!==null);
  await call("yield");
  const events=a.log.events(), expected=replay(a);
  check("canonical scheduler result is not a second journal",expected.syscalls.length===6 && expected.rejected.length===0 && expected.kernel.schedulerFrontier().length===1);
  const shuffled=new QosEventLog(roomId);
  // Fixed permutation, independent delivery, no random source.
  for(const e of [...events.filter((_,i)=>i%2),...events.filter((_,i)=>i%2===0).reverse()])assert.ok((await shuffled.ingest(e)).ok);
  const other=replayQosKernel(shuffled.events(),shuffled.forkedSources);
  check("independent peer converges on journal, schedule, trace and digest",
    JSON.stringify(shuffled.events().map(e=>e.hash))===JSON.stringify(events.map(e=>e.hash)) &&
    JSON.stringify(other.kernel.scheduleView())===JSON.stringify(expected.kernel.scheduleView()) &&
    JSON.stringify(other.syscalls)===JSON.stringify(expected.syscalls) &&
    await other.kernel.stateDigest()===await expected.kernel.stateDigest());
  const missing=replayQosKernel(events.filter(e=>e.hash!==first.result.hash));
  check("missing scheduler frontier receipt blocks dependent turns",missing.missingDependencies.some(e=>e.kind==="scheduler-frontier" && e.dependencyHash===first.result.hash) && missing.kernel.scheduleView().tick===0);
  const selected=expected.kernel.scheduleView().running;
  const [room,start]=entries.get(selected);
  const stale=await room.emit(selected,start.event,"syscall-request",{schema:"qos.syscall/1",caller:selected,op:"sched_step",args:{scheduleFrontier:[first.result.hash]}});
  const rejected=replay(room);
  check("stale scheduler frontier cannot mutate state",rejected.rejected.some(e=>e.hash===stale.hash && e.reason.includes("stale")) && await rejected.kernel.stateDigest()===await expected.kernel.stateDigest());
}
console.log("PASS: qos-scheduler.test.mjs — "+checks+" checks");
