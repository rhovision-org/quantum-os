// quantum-os#290 — content-addressed, explicitly exportable RhoQu process
// package. Integrity: Ed25519 signature over a canonical SHA-256 digest.
// Attribution: dyncap anchor claim + optional independently pinned public
// key (TOFU). The anchor-to-key relation is not a zero-knowledge seed proof.
// Importing a package is ALWAYS data-only; execution requires preview/approval.
import {ed25519} from "@noble/curves/ed25519.js";
import {deriveAnchor, toHex, fromHex, type DynCapState} from "./dyncap.js";
import {validateRhoProcessIR, type RhoProcessIR, type RhoRequirement} from "./rhoqu-process.js";

export const RHO_PACKAGE_SCHEMA="rhoqu.process.package/1";
const HEX64=/^[a-f0-9]{64}$/;
const HEX128=/^[a-f0-9]{128}$/;
const ROOM_CAP=/cap:room:/i;
const DOMAIN="QuantumOS/RhoQuProcessPackage/Ed25519/v1";
const LIMIT=160_000;

export interface RhoProcessPackagePayload {
  schema:typeof RHO_PACKAGE_SCHEMA;
  issuer: {dyncapAnchor:string;signerPublicKey:string};
  source:string;
  process:RhoProcessIR;
  requestedCapabilities:RhoRequirement[];
}
export interface RhoProcessPackage {
  payload:RhoProcessPackagePayload;
  sha256:string;
  signature:string;
}
export interface PackageVerification {
  ok:boolean;
  attribution:"pinned"|"tofu"|"invalid";
  errors:string[];
  sha256?:string;
  package?:RhoProcessPackage;
}

function canonical(value:unknown):string {
  const visit=(x:unknown):string=>{
    if(x===null || typeof x==="boolean" || typeof x==="string")
      return JSON.stringify(x);
    if(typeof x==="number") {
      if(!Number.isFinite(x))throw new Error("invalid non-finite JSON number");
      return JSON.stringify(x);
    }
    if(Array.isArray(x))return "["+x.map(visit).join(",")+"]";
    if(x&&typeof x==="object") {
      const obj=x as Record<string,unknown>;
      const keys=Object.keys(obj).sort();
      if(keys.some(k=>k==="__proto__"||k==="constructor"))
        throw new Error("forbidden JSON key in RhoQu package");
      return "{"+keys.filter(k=>obj[k]!==undefined).map(k=>
        JSON.stringify(k)+":"+visit(obj[k])).join(",")+"}";
    }
    throw new Error("unsupported JSON value in RhoQu package");
  };
  return visit(value);
}
export function canonicalRhoPackageJson(payload:RhoProcessPackagePayload):string {
  validateRhoProcessIR(payload.process);
  if(typeof payload.source!=="string" || !payload.source.trim() ||
    payload.source.length>32_768 || ROOM_CAP.test(payload.source))
    throw new Error("invalid source or forbidden room bearer capability");
  const need=capabilitiesOf(payload.process);
  if(JSON.stringify(payload.requestedCapabilities)!==JSON.stringify(need))
    throw new Error("package capability manifest does not match executable IR");
  if(!HEX64.test(payload.issuer?.dyncapAnchor) ||
     !HEX64.test(payload.issuer?.signerPublicKey))
    throw new Error("invalid dyncap attribution fields");
  if(payload.schema!==RHO_PACKAGE_SCHEMA)throw new Error("unknown RhoQu package schema");
  const value=canonical(payload);
  if(value.length>LIMIT)throw new Error("package exceeds size budget");
  return value;
}

export function capabilitiesOf(plan:RhoProcessIR):RhoRequirement[] {
  validateRhoProcessIR(plan);
  const set=new Set<RhoRequirement>();
  const visit=(nodes:RhoProcessIR["nodes"]):void=>{
    for(const n of nodes) {
      if(n.kind==="command")for(const r of n.requires)set.add(r);
      else if(n.kind==="when") {visit(n.then);visit(n.else);}
      else if(n.kind==="concurrent") for(const branch of n.branches)visit(branch);
    }
  };
  visit(plan.nodes);
  const order:RhoRequirement[]=["room-read","room-write","wallet-authorization"];
  return order.filter(x=>set.has(x));
}

async function sha(data:Uint8Array):Promise<Uint8Array> {
  if(!globalThis.crypto?.subtle)throw new Error("Web Crypto unavailable; secure origin required");
  return new Uint8Array(await crypto.subtle.digest("SHA-256",data as BufferSource));
}
function bytes(s:string):Uint8Array{return new TextEncoder().encode(s);}
async function digest(payload:RhoProcessPackagePayload):Promise<Uint8Array>{
  return sha(bytes(canonicalRhoPackageJson(payload)));
}
async function secretFor(identity:DynCapState):Promise<Uint8Array>{
  const domain=bytes(DOMAIN+"\x00"),inp=new Uint8Array(domain.length+identity.seed.length);
  inp.set(domain);inp.set(identity.seed,domain.length);
  return sha(inp);
}

/** Deterministic export for the SAME source, IR and dyncap seed. */
export async function exportRhoProcessPackage(
  source:string,process:RhoProcessIR,identity:DynCapState,
):Promise<RhoProcessPackage> {
  if(!(identity.seed instanceof Uint8Array)||identity.seed.length!==32||
    !HEX64.test(identity.anchor)||await deriveAnchor(identity.seed)!==identity.anchor)
    throw new Error("signer seed does not match the claimed dyncap anchor");
  const privateKey=await secretFor(identity);
  const pubKey=toHex(ed25519.getPublicKey(privateKey));
  const payload:RhoProcessPackagePayload={
    schema:RHO_PACKAGE_SCHEMA,
    issuer:{dyncapAnchor:identity.anchor,signerPublicKey:pubKey},
    source,process,requestedCapabilities:capabilitiesOf(process),
  };
  const hash=await digest(payload);
  const signature=ed25519.sign(hash,privateKey);
  return {payload,sha256:toHex(hash),signature:toHex(signature)};
}

/**
 * Cryptographic integrity is independent of attribution.
 * A new key is marked TOFU, not verified dyncap identity. A previously pinned
 * anchor-key relation is required to mark the package as pinned. A mismatch
 * refuses import even if the package signature is otherwise valid.
 */
export async function verifyRhoProcessPackage(
  raw:unknown,opts:{
    expectedAnchor?:string;
    trustedKeys?:ReadonlyMap<string,string>;
  }={},
):Promise<PackageVerification> {
  const errors:string[]=[];
  try {
    if(!raw || typeof raw!=="object" || Array.isArray(raw))
      throw new Error("package must be an object");
    const pkg=raw as Record<string,unknown>;
    if(!pkg.payload || typeof pkg.payload!=="object" || Array.isArray(pkg.payload))
      throw new Error("missing package payload");
    const payload=pkg.payload as RhoProcessPackagePayload;
    const hash=await digest(payload);
    const hashHex=toHex(hash);
    if(typeof pkg.sha256!=="string" || !HEX64.test(pkg.sha256) ||
       hashHex!==pkg.sha256) throw new Error("package SHA-256 mismatch");
    if(typeof pkg.signature!=="string" || !HEX128.test(pkg.signature))
      throw new Error("invalid Ed25519 signature encoding");
    if(!ed25519.verify(fromHex(pkg.signature),hash,
      fromHex(payload.issuer.signerPublicKey)))
      throw new Error("package Ed25519 signature verification failed");
    if(opts.expectedAnchor!==undefined &&
       payload.issuer.dyncapAnchor!==opts.expectedAnchor)
      throw new Error("package dyncap anchor mismatch");
    const pinned=opts.trustedKeys?.get(payload.issuer.dyncapAnchor);
    if(pinned!==undefined && pinned!==payload.issuer.signerPublicKey)
      throw new Error("package signer key conflicts with pinned dyncap attribution");
    return {ok:true,attribution:pinned?"pinned":"tofu",errors:[],
      sha256:hashHex,package:{payload,sha256:hashHex,signature:pkg.signature}};
  }catch(error){
    errors.push(error instanceof Error?error.message:String(error));
    return {ok:false,attribution:"invalid",errors};
  }
}

export function serializeRhoProcessPackage(pkg:RhoProcessPackage):string {
  const src=canonical(pkg);
  if(src.length>LIMIT)throw new Error("encoded package exceeds size budget");
  return src;
}
export function parseRhoProcessPackage(text:string):unknown {
  if(text.length>LIMIT)throw new Error("oversized RhoQu package");
  return JSON.parse(text) as unknown;
}

/** Clipboard-friendly single-token encoding: no whitespace in /rhoqu input. */
export function packageToToken(pkg:RhoProcessPackage):string {
  const bytes=new TextEncoder().encode(serializeRhoProcessPackage(pkg));
  let binary="";
  for(let i=0;i<bytes.length;i+=8192) {
    binary+=String.fromCharCode(...bytes.slice(i,i+8192));
  }
  return btoa(binary).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
}

export function packageFromToken(token:string):unknown {
  if(!/^[A-Za-z0-9_-]+$/.test(token)||token.length>LIMIT*2)
    throw new Error("invalid or oversized package token");
  const b64=token.replace(/-/g,"+").replace(/_/g,"/");
  const binary=atob(b64+"=".repeat((4-b64.length%4)%4));
  const raw=Uint8Array.from(binary,c=>c.charCodeAt(0));
  return parseRhoProcessPackage(new TextDecoder("utf-8",{fatal:true}).decode(raw));
}
