// #284: signed immutable packages and deterministic init metadata.
import {ed25519} from "@noble/curves/ed25519.js";
import {sha256} from "@noble/hashes/sha2.js";
import {canonicalJson} from "./qos-process.js";
import {parsePipeline,newShellContext,stageResult,boundedText} from "./qos-shell.js";
export const INIT_OPS=["pkg_install","pkg_list","pkg_remove","svc_boot","svc_list","svc_status","svc_start","svc_stop","svc_restart","svc_health"] as const;
export type InitOp=typeof INIT_OPS[number];
export const MAX_PACKAGES=32, MAX_RESTARTS=4;
export const packageName=(x:unknown):x is string=>typeof x==="string"&&/^[a-z][a-z0-9-]{0,39}$/.test(x);
const hex=(x:unknown,n:number):x is string=>typeof x==="string"&&x.length===n&&/^[0-9a-f]+$/.test(x);
const unhex=(x:string)=>Uint8Array.from(x.match(/../g)!,b=>parseInt(b,16));
const encode=(x:unknown)=>new TextEncoder().encode(canonicalJson(x));
const digest=(x:unknown)=>Array.from(sha256(encode(x)),b=>b.toString(16).padStart(2,"0")).join("");
const exact=(x:unknown,k:string[]):x is Record<string,unknown>=>!!x&&typeof x==="object"&&!Array.isArray(x)&&Object.keys(x).length===k.length&&k.every(key=>Object.hasOwn(x,key));
export type CapabilityRequest={name:string;kind:"fs"|"mem"|"devgrant";rights:number};
export type PackageManifest={schema:"qos.package/1";name:string;version:string;publisher:string;
 capabilities:CapabilityRequest[];entrypoint:{kind:"builtin"|"agent"|"macro"|"contract";source:string};
 dependencies:string[];restart:"never"|"on-failure";health:string};
export type SignedPackage={manifest:PackageManifest;signature:string};
export type PackageBinding={name:string;handle:string;version:string};
export type InstalledPackage={id:string;manifest:PackageManifest;signature:string;bindings:PackageBinding[]};
export type ServiceRecord={id:string;name:string;packageId:string;generation:number;pid:string|null;phase:"stopped"|"running"|"failed"|"blocked";attempts:number;output:string;detail:string};
export function parsePackage(x:unknown):SignedPackage|null{
 if(!exact(x,["manifest","signature"])||!hex(x.signature,128))return null;
 const m=x.manifest;
 if(!exact(m,["schema","name","version","publisher","capabilities","entrypoint","dependencies","restart","health"])||
 m.schema!=="qos.package/1"||!packageName(m.name)||typeof m.version!=="string"||!/^\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(m.version)||!hex(m.publisher,64)||
 !Array.isArray(m.capabilities)||m.capabilities.length>8||!Array.isArray(m.dependencies)||m.dependencies.length>16||
 !m.dependencies.every(packageName)||new Set(m.dependencies).size!==m.dependencies.length||m.dependencies.includes(m.name)||
 !["never","on-failure"].includes(m.restart as string)||!boundedText(m.health)||!m.health)return null;
 if(!m.capabilities.every(c=>exact(c,["name","kind","rights"])&&packageName(c.name)&&
 ["fs","mem","devgrant"].includes(c.kind as string)&&typeof c.rights==="number"&&Number.isSafeInteger(c.rights)&&c.rights>=1&&c.rights<=7&&
 (c.kind==="mem"?c.rights===1:c.kind==="fs"?(c.rights&~3)===0:true))||
 new Set(m.capabilities.map(c=>c.name)).size!==m.capabilities.length)return null;
 if(!exact(m.entrypoint,["kind","source"])||!["builtin","agent","macro","contract"].includes(m.entrypoint.kind as string)||!boundedText(m.entrypoint.source)||!m.entrypoint.source)return null;
 if(encode(m).length>10000)return null;
 return JSON.parse(JSON.stringify(x)) as SignedPackage;
}
export function verifyPackage(p:SignedPackage,expectedPublisher:string):boolean{
 if(p.manifest.publisher!==expectedPublisher)return false;
 try{return ed25519.verify(unhex(p.signature),encode(p.manifest),unhex(expectedPublisher),{zip215:false});}catch{return false;}
}
export const packageIdentity=(p:SignedPackage)=>digest(p.manifest);
export const serviceIdentity=(owner:string,name:string)=>digest({schema:"qos.service/1",owner,name});
export function parseBindings(x:unknown):PackageBinding[]|null{
 if(!Array.isArray(x)||x.length>8||!x.every(b=>exact(b,["name","handle","version"])&&packageName(b.name)&&typeof b.handle==="string"&&b.handle.length<=256&&hex(b.version,64))||new Set(x.map(b=>b.name)).size!==x.length)return null;
 return x.map(b=>({...b}));
}
// Deliberately bounded builtin execution. Agent/macro/contract source is
// signed inert package data until a dedicated authorized runtime is bound.
export function runBuiltin(source:string):{code:number;output:string}{
 try{
  const ctx=newShellContext(),plan=parsePipeline(source,ctx);
  if(plan.input||plan.output)return {code:2,output:""};
  let code=0,output="";
  for(const argv of plan.stages){const r=stageResult(argv,output,ctx);if(!code)code=r.code;output=r.output;}
  return {code,output};
 }catch{return {code:2,output:""};}
}
export const parseBoot=(x:unknown):string[]|null=>{
 if(!exact(x,["schema","services"])||x.schema!=="qos-init/1"||!Array.isArray(x.services)||x.services.length>MAX_PACKAGES||!x.services.every(packageName)||new Set(x.services).size!==x.services.length)return null;
 return [...x.services];
};
