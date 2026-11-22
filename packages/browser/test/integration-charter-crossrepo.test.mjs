import assert from "node:assert/strict";
import { build } from "esbuild";
import {readFileSync} from "node:fs";
import {resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {sha256} from "@noble/hashes/sha2.js";
import {canonicalJson,signCharterAuthorization,revAddressFromPublicKey,verifyCharterAuthorizations,charterIssueTitle,inspectCharterIssue} from "../src/charter-chain.js";
const govRoot=process.env.RHOGOV_ROOT;
assert(govRoot,"set RHOGOV_ROOT to the pinned RhoGov worktree");
const bundle=await build({entryPoints:[resolve(govRoot,"src/chain/success-charter.ts")],bundle:true,platform:"node",format:"esm",write:false});
const gov=await import("data:text/javascript;base64,"+Buffer.from(bundle.outputFiles[0].text).toString("base64"));
const qosBundle=await build({entryPoints:[fileURLToPath(new URL("../src/success-charter.ts",import.meta.url))],bundle:true,platform:"node",format:"esm",write:false});
const qos=await import("data:text/javascript;base64,"+Buffer.from(qosBundle.outputFiles[0].text).toString("base64"));
const bytes=readFileSync(new URL("../../../contract/success-charter-1-vector.json",import.meta.url));
assert.deepEqual(bytes,readFileSync(resolve(govRoot,"contract/success-charter-1-vector.json")));
const vector=JSON.parse(bytes);
const key="01".repeat(32); // public disposable test key
const make=(content)=>{
 const hash=Buffer.from(sha256(new TextEncoder().encode(canonicalJson(content)))).toString("hex");
 return {...content,charterHash:hash,signatures:[signCharterAuthorization(hash,content.proposer,key)]};
};
const charter=make(vector.content);
const addr=revAddressFromPublicKey(charter.signatures[0].split(":")[2]);
assert.equal(charter.charterHash,vector.charterHash);
assert((await qos.validateSuccessCharter(charter,{requireSignatures:true})).ok);
assert(verifyCharterAuthorizations(charter,[{anchor:charter.proposer,revAddr:addr,role:"admin"}]).valid);
gov.verifyCharterSignatures(charter,[{addr,role:"admin"}]);
assert.equal(charterIssueTitle(charter),gov.encodeCharterTitle(charter));
const raw={id:vector.proposalId,gid:charter.group.id,title:charterIssueTitle(charter),mode:"approval",options:["approve","reject"],status:"open"};
for(const [status,expected] of [["open","pending"],["closed","unknown"]]){
 const item={...raw,status};
 assert.equal((await inspectCharterIssue(item,charter)).status,expected);
 assert.equal(gov.readCharterIssue(item,charter.group.id,charter.charterHash).status,expected);
}
const unbound={...charter,objectives:charter.objectives.map((obj,i)=>i===0?{...obj,extension:"synthetic"}:obj)};
assert(!(await qos.validateSuccessCharter(unbound)).ok);
assert.throws(()=>gov.encodeCharterTitle(unbound),/HASH/);
const falseSignature=make({...vector.content,members:vector.content.members.map((m,i)=>i===0?{...m,signature:"synthetic-claim"}:m)});
assert(!(await qos.validateSuccessCharter(falseSignature)).ok);
assert.throws(()=>gov.encodeCharterTitle(falseSignature),/signature/);
assert.throws(()=>gov.verifyCharterSignatures(falseSignature,[{addr,role:"admin"}]),/signature/);
console.log("PASS: actual QOS producer/validator and RhoGov consumer, byte-identical artifact, wallet authorization, open/closed status, two shared negative vectors");
