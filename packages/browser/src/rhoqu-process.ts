// RhoQu v2 / quantum-os#290: effect-typed runtime orchestration.
//
// This is an opt-in executor. Legacy /rhoqu continues to transpile as before.
// The v2 plan is data, never a capability: the app must require an explicit
// human preview/approval and pass every command through its original handler.
import {
  compileRhoQuSurfaceIR, validateRhoQuSurfaceIR, evaluateRhoQuCondition,
  substituteRhoQuArgs, type Stmt, type Expr, type RhoQuContext,
} from "./rhoqu.js";

export const RHO_PROCESS_SCHEMA = "rhoqu.process.ir/1";
export type RhoEffect = "read" | "room-write" | "value-write" | "chain-write";
export type RhoRequirement = "room-read" | "room-write" | "wallet-authorization";

export interface RhoCommandResult {
  ok: boolean;
  id?: string;
  value?: unknown;
  error?: string;
}

export type RhoProcessNode =
  | { kind: "command"; command: string; effect: RhoEffect; requires: RhoRequirement[]; bind?: string }
  | { kind: "when"; condition: Expr; then: RhoProcessNode[]; else: RhoProcessNode[] }
  | { kind: "require"; condition: Expr }
  | { kind: "concurrent"; mode: "parallel-read"; branches: RhoProcessNode[][] };

export interface RhoProcessIR {
  schema: typeof RHO_PROCESS_SCHEMA;
  execution: "explicit-approval";
  /** This field cannot be promoted to verified on an untrusted import. */
  verification: "unverified";
  nodes: RhoProcessNode[];
}

const VALID_BINDING = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
const VALID_COMMAND = /^\/[A-Za-z][A-Za-z0-9-]*(?:\s|$)/;
const ROOM_CAP = /cap:room:/i;
const MAX_NODES = 500;
const MAX_DEPTH = 32;

function commandWord(command: string): { verb: string; sub: string } {
  const parts = command.trim().slice(1).split(/\s+/, 3);
  return {verb: parts[0]?.toLowerCase() ?? "", sub: parts[1]?.toLowerCase() ?? ""};
}

/** Conservative effects. No unknown command is classified read-only. */
export function effectsOf(command: string): { effect: RhoEffect; requires: RhoRequirement[] } {
  const {verb, sub} = commandWord(command);
  const localReads = new Set([
    "help","id","zfa","zfa-check","braket","qucalc","conj",
    "freq","coupling","search","solve","dump",
  ]);
  if (localReads.has(verb) ||
    (verb === "goal" && (sub === "list" ||
      sub === "review" && !/^\/goal\s+review\s+note\b/i.test(command) ||
      sub === "habit" && /^\/goal\s+habit\s+list\b/i.test(command))) ||
    (verb === "poll" && ["list","status"].includes(sub)) ||
    (verb === "gov" && ["list","status"].includes(sub)) ||
    (verb === "note" && ["list","balance"].includes(sub)) ||
    (verb === "qos" && ["ps","status","list"].includes(sub)) ||
    (verb === "probe" && sub === "status") ||
    (verb === "rdv" && sub === "list") ||
    (verb === "channel" && sub === "list")) {
    return {effect: "read", requires: ["room-read"]};
  }
  if (verb === "rholang" && ["deploy","install"].includes(sub) ||
      verb === "gov" && sub === "chain" ||
      verb === "note" && ["grant","pass","redeem","split","merge"].includes(sub)) {
    if (verb === "note") return {effect: "value-write", requires: ["wallet-authorization"]};
    return {effect: "chain-write", requires: ["wallet-authorization"]};
  }
  if (verb === "rdv" && sub !== "list")
    return {effect: "value-write", requires: ["wallet-authorization"]};
  return {effect: "room-write", requires: ["room-write"]};
}

function commandNode(command: string, bind?: string): RhoProcessNode {
  const c=command.trim();
  if (!VALID_COMMAND.test(c) || c.length > 8192 || ROOM_CAP.test(c)) {
    throw new Error("invalid RhoQu command or room capability in process");
  }
  if (bind !== undefined && !VALID_BINDING.test(bind)) throw new Error("invalid binding identifier");
  if (bind !== undefined && effectsOf(c).effect === "read")
    throw new Error("a read-only command cannot be used for ID capture");
  const {effect,requires}=effectsOf(c);
  return {kind:"command",command:c,effect,requires,...(bind?{bind}:{})};
}

function cleanStatic(value: string): string {
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'")))) return value.slice(1,-1);
  return value;
}

function resolveExpr(e: Expr, env: ReadonlyMap<string,string>): Expr {
  if (e.kind === "var" && env.has(e.name)) return {kind:"str",value:env.get(e.name) ?? ""};
  if (e.kind === "binop") return { ...e,
    left:resolveExpr(e.left,env),right:resolveExpr(e.right,env) };
  if (e.kind === "unop") return { ...e,expr:resolveExpr(e.expr,env) };
  if (e.kind === "call") return { ...e,args:e.args.map(a=>resolveExpr(a,env)) };
  return {...e};
}

/**
 * Source -> versioned execution IR. Old "if" stays compile-time; new "when"
 * is evaluated when reached. Old "parallel" stays ordered; new "concurrent"
 * explicitly starts read-only branches together. There is NO Lean claim.
 */
export function compileRhoProcessIR(source: string, context: RhoQuContext): RhoProcessIR {
  if (!source.trim() || source.length > 32_768 || ROOM_CAP.test(source))
    throw new Error("invalid or overly long RhoQu source");
  const surface=compileRhoQuSurfaceIR(source);
  validateRhoQuSurfaceIR(surface);
  const defs=new Map(surface.definitions.map(d=>[d.name,d]));
  let budget=MAX_NODES;
  const nodesFor=(statements: readonly Stmt[], env: Map<string,string>, path: string[], depth: number): RhoProcessNode[]=>{
    if (depth>MAX_DEPTH) throw new Error("RhoProcess nesting budget exceeded");
    const nodes:RhoProcessNode[]=[];
    for (const s of statements) {
      if (--budget<0) throw new Error("RhoProcess instruction budget exceeded");
      switch(s.kind) {
        case "cmd":
          nodes.push(commandNode(substituteRhoQuArgs(s.text,env)));
          break;
        case "let":
          nodes.push(commandNode(substituteRhoQuArgs(s.text,env),s.name));
          break;
        case "new":
          for(const name of s.names) nodes.push(commandNode("/grant "+substituteRhoQuArgs(name,env)));
          break;
        case "parallel":
          nodes.push(...nodesFor(s.body,new Map(env),path,depth+1)); // legacy ordered
          break;
        case "if": {
          const chosen=evaluateRhoQuCondition(resolveExpr(s.cond,env),new Map(),context)
            ? s.then:s.else;
          nodes.push(...nodesFor(chosen,new Map(env),path,depth+1));
          break;
        }
        case "when":
          nodes.push({kind:"when",condition:resolveExpr(s.cond,env),
            then:nodesFor(s.then,new Map(env),path,depth+1),
            else:nodesFor(s.else,new Map(env),path,depth+1)});
          break;
        case "require":
          nodes.push({kind:"require",condition:resolveExpr(s.cond,env)});
          break;
        case "concurrent": {
          const branches=s.branches.map(b=>nodesFor(b,new Map(env),path,depth+1));
          if (branches.length > 32 || !branches.length ||
              !branches.every(branch=>branch.every(readOnlyNode))) {
            throw new Error("concurrent requires independently read-only branches");
          }
          nodes.push({kind:"concurrent",mode:"parallel-read",branches});
          break;
        }
        case "call": {
          const def=defs.get(s.name);
          if(!def) throw new Error("unknown RhoQu process "+s.name);
          if(path.includes(s.name)) throw new Error("recursive process call "+s.name);
          if(s.args.length!==def.params.length) throw new Error("process argument count mismatch");
          const child=new Map(env);
          for(let i=0;i<s.args.length;i++) {
            child.set(def.params[i],cleanStatic(substituteRhoQuArgs(s.args[i],env)));
          }
          nodes.push(...nodesFor(def.body,child,[...path,s.name],depth+1));
          break;
        }
        case "on":
          // The legacy on-handler remains handled by the original /rhoqu
          // pathway. Treating it as a runtime read-only process would silently
          // change signed inbound-event semantics.
          throw new Error("v2 on-handler requires explicit runtime channel adapter; use legacy /rhoqu");
      }
    }
    return nodes;
  };
  const out:RhoProcessIR={
    schema:RHO_PROCESS_SCHEMA,execution:"explicit-approval",
    verification:"unverified",nodes:nodesFor(surface.top,new Map(),[],0),
  };
  validateRhoProcessIR(out);
  return out;
}

function readOnlyNode(n:RhoProcessNode):boolean {
  if(n.kind==="command") return n.effect==="read" && !n.bind;
  if(n.kind==="when")return n.then.every(readOnlyNode)&&n.else.every(readOnlyNode);
  if(n.kind==="require")return true;
  if(n.kind==="concurrent")return n.branches.every(b=>b.every(readOnlyNode));
  return false;
}

/** Untrusted JSON is never executed without structural validation. */
export function validateRhoProcessIR(value:unknown): asserts value is RhoProcessIR {
  const obj=(v:unknown): v is Record<string,unknown> =>
    !!v && typeof v==="object" && !Array.isArray(v);
  const array=(v:unknown): v is unknown[]=>Array.isArray(v);
  if(!obj(value) || value.schema!==RHO_PROCESS_SCHEMA ||
     value.execution!=="explicit-approval" || value.verification!=="unverified")
    throw new Error("unsupported RhoProcess schema/semantics/verification claim");
  let budget=MAX_NODES;
  const expression=(x:unknown,depth:number):void=>{
    if(--budget<0 || depth>MAX_DEPTH || !obj(x))throw new Error("invalid RhoProcess condition");
    switch(x.kind){
      case "num":
        if(typeof x.value==="number" && Number.isFinite(x.value))return;
        break;
      case "str":
        if(typeof x.value==="string")return;
        break;
      case "var":
      case "lemma":
        if(typeof x.name==="string")return;
        break;
      case "unop":
        if(x.op==="not"){expression(x.expr,depth+1);return;}
        break;
      case "binop":
        if(["eq","ne","lt","le","gt","ge","and","or"].includes(String(x.op))){
          expression(x.left,depth+1);expression(x.right,depth+1);return;
        }
        break;
      case "call":
        if(typeof x.name==="string"&&array(x.args)){
          for(const arg of x.args)expression(arg,depth+1);return;
        }
        break;
    }
    throw new Error("invalid RhoProcess expression");
  };
  const check=(nodes:unknown,depth:number):void=>{
    if(!array(nodes)||depth>MAX_DEPTH)throw new Error("invalid RhoProcess nodes");
    for(const n of nodes){
      if(--budget<0||!obj(n))throw new Error("RhoProcess budget or node violation");
      if(n.kind==="command"){
        if(typeof n.command!=="string"||!VALID_COMMAND.test(n.command)||
          n.command.length>8192||ROOM_CAP.test(n.command))throw new Error("invalid command");
        const canonical=effectsOf(n.command);
        if(n.effect!==canonical.effect ||JSON.stringify(n.requires)!==JSON.stringify(canonical.requires))
          throw new Error("forged command effect/capability annotation");
        if(n.bind!==undefined&&(!VALID_BINDING.test(String(n.bind))||
          n.effect==="read"))throw new Error("invalid bound command");
      }else if(n.kind==="when"){
        expression(n.condition,depth+1);check(n.then,depth+1);check(n.else,depth+1);
      }else if(n.kind==="require"){
        expression(n.condition,depth+1);
      }else if(n.kind==="concurrent"){
        if(n.mode!=="parallel-read"||!array(n.branches)||
          n.branches.length<1||n.branches.length>32)
          throw new Error("invalid concurrent branches");
        for(const branch of n.branches)check(branch,depth+1);
        if(!(n.branches as RhoProcessNode[][]).every(b=>b.every(readOnlyNode)))
          throw new Error("concurrent write/capture not permitted");
      }else{
        throw new Error("unknown RhoProcess instruction");
      }
    }
  };
  check(value.nodes,0);
}

export function interpolateRuntime(
  template:string, bindings:ReadonlyMap<string,string>,lastId:string|undefined,
):string {
  let out="";
  for(let i=0;i<template.length;){
    if(template[i]!=="$"){out+=template[i++];continue;}
    if(template[i+1]==="$"){out+="$";i+=2;continue;}
    let j=i+1;
    while(j<template.length && /[A-Za-z0-9_-]/.test(template[j]))j++;
    const name=template.slice(i+1,j);
    if(!name) {out+="$";i++;continue;}
    const value=name==="LAST_ID"?lastId:bindings.get(name);
    if(value===undefined)throw new Error("unbound RhoQu result variable $"+name);
    out+=value;i=j;
  }
  if(ROOM_CAP.test(out))throw new Error("refusing bearer room capability in expanded command");
  return out;
}

export interface RhoProcessHost {
  /** A fresh snapshot each time the runner reaches a when/require gate. */
  context():RhoQuContext;
  /** Must enforce local user consent and the ordinary command's capabilities. */
  authorize(command:string,effect:RhoEffect,requires:readonly RhoRequirement[]):boolean|Promise<boolean>;
  /** Must return the ACTUAL ID assigned by a successful command, never guess. */
  execute(command:string, signal?:AbortSignal):Promise<RhoCommandResult>;
}

export interface RhoProcessReceipt {
  command:string; effect:RhoEffect; ok:boolean; id?:string; error?:string;
}
export interface RhoProcessReport {
  ok:boolean;
  receipts:RhoProcessReceipt[];
  bindings:Record<string,string>;
  error?:string;
}

export async function runRhoProcessIR(
  plan:RhoProcessIR, host:RhoProcessHost, signal?:AbortSignal,
):Promise<RhoProcessReport> {
  validateRhoProcessIR(plan);
  const receipts:RhoProcessReceipt[]=[];
  const bindings=new Map<string,string>();
  let lastId:string|undefined;
  let remaining=MAX_NODES;
  const checkSignal=()=>{
    if(signal?.aborted)throw new Error("RhoProcess aborted");
    if(--remaining<0)throw new Error("RhoProcess step budget exceeded");
  };
  const runCommand=async(n:Extract<RhoProcessNode,{kind:"command"}>,
    local:Map<string,string>,id:string|undefined,
    target:RhoProcessReceipt[]):Promise<string|undefined>=>{
    checkSignal();
    const command=interpolateRuntime(n.command,local,id);
    if(!VALID_COMMAND.test(command)||effectsOf(command).effect!==n.effect)
      throw new Error("expanded command changed its declared effect");
    if(!(await host.authorize(command,n.effect,n.requires)))
      throw new Error("command authorization refused: "+commandWord(command).verb);
    const result=await host.execute(command,signal);
    target.push({command,effect:n.effect,ok:result.ok,
      ...(result.id?{id:result.id}:{}),...(result.error?{error:result.error}:{})});
    if(!result.ok)throw new Error("command failed: "+(result.error||command));
    if(n.bind){
      if(typeof result.id!=="string" || !result.id)
        throw new Error("command provided no verified result ID for $"+n.bind);
      local.set(n.bind,result.id);
    }
    return result.id || id;
  };
  const runNodes=async(nodes:readonly RhoProcessNode[],local:Map<string,string>,
    localLast:string|undefined,target:RhoProcessReceipt[]):Promise<string|undefined>=>{
    for(const n of nodes){
      checkSignal();
      if(n.kind==="command") {
        localLast=await runCommand(n,local,localLast,target);
      }else if(n.kind==="when"){
        const selected=evaluateRhoQuCondition(n.condition,local,host.context())?n.then:n.else;
        localLast=await runNodes(selected,local,localLast,target);
      }else if(n.kind==="require"){
        if(!evaluateRhoQuCondition(n.condition,local,host.context()))
          throw new Error("RhoProcess closure gate refused");
      }else if(n.kind==="concurrent"){
        // Pre-authorize all commands before scheduling *any* branch. Every
        // branch must be read-only; no shared binding/write race is permitted.
        const jobs:narrowParallel[]=[];
        for(const branch of n.branches){
          const checks:RhoProcessNode[]=[];
          const walk=(xs:readonly RhoProcessNode[]):void=>{
            for(const child of xs){
              if(child.kind==="command")checks.push(child);
              else if(child.kind==="when"){walk(child.then);walk(child.else);}
              else if(child.kind==="concurrent")for(const b of child.branches)walk(b);
            }
          };
          walk(branch);
          for(const item of checks){
            if(item.kind!=="command")continue;
            const cmd=interpolateRuntime(item.command,local,localLast);
            if(!(await host.authorize(cmd,item.effect,item.requires)))
              throw new Error("parallel branch authorization refused");
          }
          jobs.push({nodes:branch,receipts:[]});
        }
        const results=await Promise.allSettled(jobs.map(async(job)=>
          runNodes(job.nodes,new Map(local),localLast,job.receipts)));
        // Report order follows authored branch order, not scheduler timing.
        for(const job of jobs)target.push(...job.receipts);
        const error=results.find(r=>r.status==="rejected");
        if(error?.status==="rejected")throw error.reason;
        // Read-only branches cannot produce new IDs or modify bindings.
      }
    }
    return localLast;
  };
  interface narrowParallel { nodes:RhoProcessNode[];receipts:RhoProcessReceipt[] }
  try{
    lastId=await runNodes(plan.nodes,bindings,lastId,receipts);
    return {ok:true,receipts,bindings:Object.fromEntries(bindings)};
  }catch(error){
    return {ok:false,receipts,bindings:Object.fromEntries(bindings),
      error:error instanceof Error?error.message:String(error)};
  }
}
