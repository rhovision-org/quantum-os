// #290: structured results are measured from the application's actual state,
// never parsed from a success-looking chat line or synthesized from time.
import type {RhoCommandResult} from "./rhoqu-process.js";

export type RhoIdKind="poll"|"lemma"|"note"|"currency"|"rendezvous"|"qos"|
  "goal"|"group"|"issue";

export type RhoIdSnapshot=Record<RhoIdKind,readonly string[]>;

export interface RhoResultAdapter {
  snapshot():RhoIdSnapshot | Promise<RhoIdSnapshot>;
  /** Must use the ordinary /command implementation; never bypass permission. */
  invoke(command:string):Promise<{ok:boolean;error?:string;value?:unknown}>;
}

export function capturedIdKind(command:string):RhoIdKind|null {
  const text=command.trim();
  if(/^\/poll\s+new(?:\s|$)/i.test(text))return "poll";
  if(/^\/lemma\s+\S/i.test(text))return "lemma";
  if(/^\/note\s+grant(?:\s|$)/i.test(text))return "note";
  if(/^\/note\s+declare(?:\s|$)/i.test(text))return "currency";
  if(/^\/rdv\s+swap(?:\s|$)/i.test(text))return "rendezvous";
  if(/^\/qos\s+start(?:\s|$)/i.test(text))return "qos";
  if(/^\/goal\s+add(?:\s|$)/i.test(text))return "goal";
  if(/^\/gov\s+new(?:\s|$)/i.test(text))return "group";
  if(/^\/gov\s+issue(?:\s|$)/i.test(text))return "issue";
  return null;
}

/** A failed/ambiguous mutation MUST NOT produce a binding. */
export async function runWithStructuredId(
  command:string,host:RhoResultAdapter,
):Promise<RhoCommandResult> {
  const kind=capturedIdKind(command);
  const before=kind?await host.snapshot():null;
  let result:{ok:boolean;error?:string;value?:unknown};
  try {result=await host.invoke(command);}
  catch(error){
    return {ok:false,error:error instanceof Error?error.message:String(error)};
  }
  if(!result.ok)return {ok:false,error:result.error||"command refused"};
  if(!kind)return {ok:true,value:result.value};
  const after=await host.snapshot();
  const seen=new Set(before?.[kind]??[]);
  const added=after[kind].filter(id=>!seen.has(id));
  if(added.length!==1 || typeof added[0]!=="string" || !added[0]) {
    return {ok:false,error:"no unique verified "+kind+" ID produced; mutation is ambiguous"};
  }
  if(/[\r\n;|]/.test(added[0]) || /cap:room:/i.test(added[0])) {
    return {ok:false,error:"unsafe ID emitted by command; refusing binding"};
  }
  return {ok:true,id:added[0],value:result.value};
}
