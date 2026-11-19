// #290 process package: deterministic content addressing, Ed25519
// signing, pinned dyncap attribution and no ambient execution.
import { build } from "esbuild";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const root=join(dirname(fileURLToPath(import.meta.url)),"..");
const built=await build({stdin:{
 contents:'export {compileRhoProcessIR} from "./src/rhoqu-process.ts"; export {exportRhoProcessPackage,verifyRhoProcessPackage,canonicalRhoPackageJson,serializeRhoProcessPackage,parseRhoProcessPackage} from "./src/rhoqu-package.ts"; export {deriveAnchor} from "./src/dyncap.ts";',
 resolveDir:root,loader:"ts"
},bundle:true,platform:"node",format:"esm",write:false});
const api=await import("data:text/javascript;base64,"+Buffer.from(built.outputFiles[0].text).toString("base64"));
const {compileRhoProcessIR:compile,exportRhoProcessPackage:sign,
 verifyRhoProcessPackage:verify,serializeRhoProcessPackage:encode,
 parseRhoProcessPackage:decode,deriveAnchor}=api;
const seed=new Uint8Array(32).fill(13),anchor=await deriveAnchor(seed);
const id={seed,anchor,seqByRoom:{}};
const ctx={
 hasLemma:()=>false,balance:()=>0,isCurrencyDeclared:()=>false,peerCount:()=>1,
 isConnected:()=>true,myCurrentSeq:()=>0,
};
const source="let id = /poll new Charter; /poll status $id;";
const plan=compile(source,ctx);
const p=await sign(source,plan,id);
assert.match(p.sha256,/^[0-9a-f]{64}$/);
assert.match(p.signature,/^[0-9a-f]{128}$/);
assert.equal(p.payload.issuer.dyncapAnchor,anchor);
assert.ok(!encode(p).includes(Array.from(seed).join(",")),"no raw seed");
assert.deepEqual(p,await sign(source,plan,id),"content-addressing is deterministic");
const first=await verify(p);
assert.equal(first.ok,true,first.errors.join(","));
assert.equal(first.attribution,"tofu","key cannot self-certify claimed dyncap anchor");
assert.equal((await verify(p,{trustedKeys:new Map([[anchor,p.payload.issuer.signerPublicKey]])})).attribution,"pinned");
assert.equal((await verify(p,{expectedAnchor:anchor})).ok,true);
assert.equal((await verify(p,{expectedAnchor:"f".repeat(64)})).ok,false);
assert.equal((await verify(p,{trustedKeys:new Map([[anchor,"e".repeat(64)]])})).ok,false,
 "invalid signer key for known dyncap anchor rejected");
const raw=encode(p);
assert.deepEqual(decode(raw),p);
assert.equal((await verify(decode(raw))).ok,true);
const copy=()=>JSON.parse(encode(p));
let mutant=copy();
mutant.payload.source="let id = /poll new Changed;";
assert.equal((await verify(mutant)).ok,false,"source tampering changes digest");
mutant=copy();
mutant.payload.process.nodes[0].command="/poll new Changed";
assert.equal((await verify(mutant)).ok,false,"IR tampering changes digest");
mutant=copy();mutant.signature="f".repeat(128);
assert.equal((await verify(mutant)).ok,false,"signature corruption rejected");
mutant=copy();mutant.payload.requestedCapabilities=[];
assert.equal((await verify(mutant)).ok,false,"underdeclared capability request rejected");
mutant=copy();mutant.payload.process.verification="lean-verified";
assert.equal((await verify(mutant)).ok,false,"unearned verified promotion rejected");
mutant=copy();mutant.payload.source="/help cap:room:bearer;";
assert.equal((await verify(mutant)).ok,false,"room bearer capability rejected");
assert.equal((await verify(null)).ok,false);
assert.rejects(()=>sign(source,plan,{...id,anchor:"f".repeat(64)}),/seed does not match/);
assert.throws(()=>decode("{bad json"));
console.log("PASS: #290 package canonical replay, Ed25519 integrity, TOFU/pinned attribution, hash/capability mutation controls");
