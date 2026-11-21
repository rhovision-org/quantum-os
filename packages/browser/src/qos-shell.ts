// #281 — a bounded, deterministic interpreter. No host execution, I/O or clocks.
import {vfsPath} from "./qos-vfs.js";
export const SHELL_OPS=["sh_config","sh_spawn","sh_control","sh_step","sh_finish","sh_wait"] as const;
export type ShellOp=typeof SHELL_OPS[number];
export const SHELL_MAX_TEXT=4096, SHELL_MAX_STAGES=8, SHELL_MAX_JOBS=128;
export type ShellContext={cwd:string;env:Record<string,string>;version:string};
export type Pipeline={stages:string[][];input:string|null;output:{path:string;append:boolean}|null};
export type ShellJob={id:string;parent:string;pid:string;handle:string;namespace:string;namespaceHandle:string;baseRoot:string;rootVersion:string;
  plan:Pipeline;context:ShellContext;mode:"queued"|"background"|"foreground";stage:number;statuses:number[];output:string;append:string;version:string};
type Tok={kind:"word"|"op";value:string};
const encoder=new TextEncoder();
export const boundedText=(x:unknown):x is string=>typeof x==="string"&&encoder.encode(x).length<=SHELL_MAX_TEXT;
const variable=/^[A-Za-z_][A-Za-z0-9_]{0,31}$/;
export const shellVariable=(s:string)=>variable.test(s)&&!["__proto__","constructor","prototype"].includes(s);
export function newShellContext(version=""):ShellContext{return {cwd:"/",env:{},version};}
export function shellPath(cwd:string,path:string):string{
  const r=vfsPath(path.startsWith("/")?path:cwd+"/"+path);if(!r.ok)throw Error(r.detail);return r.value;
}
// Split only unquoted semicolons. Keep original text for expansion against the
// context in effect when that particular pipeline is issued.
export function splitShell(source:string):string[]{
  if(!boundedText(source))throw Error("shell source exceeds byte limit");
  const parts:string[]=[];let start=0,q="",escaped=false;
  for(let i=0;i<source.length;i++){
    const c=source[i];
    if(escaped){escaped=false;continue;}
    if(c==="\\"&&q!=="'"){escaped=true;continue;}
    if(q){if(c===q)q="";continue;}
    if(c==="'"||c==='"'){q=c;continue;}
    if(c===";"){const part=source.slice(start,i).trim();if(!part)throw Error("empty command");parts.push(part);start=i+1;}
  }
  if(q||escaped)throw Error("unterminated quote or escape");
  const last=source.slice(start).trim();if(last)parts.push(last);
  if(!parts.length||parts.length>SHELL_MAX_STAGES)throw Error("empty or excessive command sequence");
  return parts;
}
function tokens(source:string,ctx:ShellContext):Tok[]{
  if(splitShell(source).length!==1)throw Error("one pipeline required");
  const out:Tok[]=[];let word="",started=false,q="";
  const flush=()=>{if(started){if(!boundedText(word))throw Error("expanded word exceeds limit");out.push({kind:"word",value:word});word="";started=false;}};
  for(let i=0;i<source.length;i++){
    const c=source[i];
    if(c==="\\"&&q!=="'"){if(++i===source.length)throw Error("incomplete escape");word+=source[i];started=true;continue;}
    if(q&&c===q){q="";continue;}
    if(!q&&(c==="'"||c==='"')){q=c;started=true;continue;}
    if(c==="$"&&q!=="'"){
      const m=/^([A-Za-z_][A-Za-z0-9_]*)/.exec(source.slice(i+1));
      if(m){word+=Object.hasOwn(ctx.env,m[1])?ctx.env[m[1]]:"";started=true;i+=m[1].length;continue;}
    }
    if(!q&&/\s/.test(c)){flush();continue;}
    if(!q&&"|<>;".includes(c)){
      flush();let value=c;
      if(c===">"&&source[i+1]===">"){value=">>";i++;}
      if(value===";")throw Error("unexpected command separator");
      out.push({kind:"op",value});continue;
    }
    word+=c;started=true;
  }
  if(q)throw Error("unterminated quote");flush();
  if(out.length>128)throw Error("token limit");
  return out;
}
export function parsePipeline(source:string,ctx:ShellContext):Pipeline{
  const ts=tokens(source,ctx),stages:string[][]=[[]];let input:string|null=null,output:Pipeline["output"]=null;
  for(let i=0;i<ts.length;i++){
    const t=ts[i];
    if(t.kind==="word"){stages.at(-1)!.push(t.value);continue;}
    if(t.value==="|"){if(output||!stages.at(-1)!.length)throw Error("invalid pipe");stages.push([]);continue;}
    const target=ts[++i];
    if(!target||target.kind!=="word"||!target.value)throw Error("redirection needs a path");
    const path=shellPath(ctx.cwd,target.value);
    if(t.value==="<"){if(input!==null||stages.length!==1)throw Error("input redirection belongs to first stage");input=path;}
    else{if(output)throw Error("duplicate output redirection");output={path,append:t.value===">>"};}
  }
  if(stages.length>SHELL_MAX_STAGES||stages.some(s=>!s.length||!s[0]||s.length>32))throw Error("empty or excessive pipeline");
  const size=encoder.encode(JSON.stringify(stages)).length;
  if(size>SHELL_MAX_TEXT)throw Error("expanded pipeline exceeds byte limit");
  return {stages,input,output};
}
export const CONFIG_COMMANDS=["cd","set","export","unset","exit"] as const;
export function stageResult(argv:string[],input:string,ctx:ShellContext):{code:number;output:string}{
  const [op,...args]=argv;
  let output="",code=0;
  switch(op){
    case "echo":output=args.join(" ")+"\n";break;
    case "cat":if(args.length)code=2;else output=input;break; // file reads use < path
    case "upper":if(args.length)code=2;else output=input.toUpperCase();break;
    case "lower":if(args.length)code=2;else output=input.toLowerCase();break;
    case "wc":if(args.length)code=2;else output=String(encoder.encode(input).length)+"\n";break;
    case "pwd":if(args.length)code=2;else output=ctx.cwd+"\n";break;
    case "env":if(args.length)code=2;else output=Object.keys(ctx.env).sort().map(k=>k+"="+ctx.env[k]+"\n").join("");break;
    case "true":code=args.length?2:0;break;
    case "false":code=args.length?2:1;break;
    default:code=127;
  }
  return boundedText(output)?{code,output}:{code:75,output:""};
}
