// #291: shared content-addressed RhoGov Issue/4 handoff contract, no network.
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { charterProposalId, charterIssueTitle, parseCharterIssueTitle,
         revAddressFromPublicKey, signCharterAuthorization,
         verifyCharterAuthorizations, inspectCharterIssue, canonicalJson
       } from "../src/charter-chain.js";
import { readCharterStatus, readCharterIssue, decodeRhoExpr } from "../src/charter-rhogov.js";
import { revAddressOf } from "../../../scripts/qos-cli/rholang-client.mjs";
import { sha256 } from "@noble/hashes/sha2.js";
const fixture=JSON.parse(readFileSync(new URL("../../../contract/success-charter-1-vector.json",import.meta.url),"utf8"));
const KEY = "01".repeat(32); // public disposable fixture only
const input = fixture.content;
const anchor = input.proposer;
const bytes = [...sha256(new TextEncoder().encode(canonicalJson(input)))];
const hash = bytes.map((n)=>n.toString(16).padStart(2,"0")).join("");
assert.equal(hash, fixture.charterHash);
const sig = signCharterAuthorization(hash,anchor,KEY);
const charter={...input,charterHash:hash,signatures:[sig]};
const pub=sig.split(":")[2];
assert.equal(revAddressFromPublicKey(pub),revAddressOf(KEY));
const members=[{anchor,revAddr:revAddressOf(KEY),role:"admin"}];
assert.deepEqual(verifyCharterAuthorizations(charter,members),{valid:true,approvals:1,adminApprovals:1});
assert.equal(charterProposalId(hash),fixture.proposalId);
const title=charterIssueTitle(charter);
assert(title.startsWith("qos/success-charter/1:"));
assert.deepEqual(parseCharterIssueTitle(title),charter);
const stored={gid:input.group.id,title,mode:"approval",options:["approve","reject"],status:"open",ballots:{},results:{}};
const good=await inspectCharterIssue(stored,charter);
assert.equal(good.status,"pending");
assert.equal(good.proposalId,fixture.proposalId);
assert.equal(good.storedHash,hash);
assert.equal((await inspectCharterIssue({...stored,status:"closed"},charter)).status,"unknown",
             "closed+opener claimed results are not independently verified tally");
for (const wrong of [{...stored,title:title.replace("g-291-fixture","wrong")},
                      {...stored,options:["approve"]}, {...stored,gid:"wrong"}]) {
  await assert.rejects(inspectCharterIssue(wrong,charter));
}
assert.throws(()=>verifyCharterAuthorizations({...charter,signatures:["not-a-signature"]},members));
assert.throws(()=>verifyCharterAuthorizations({...charter,signatures:[sig,sig]},members));
assert.throws(()=>verifyCharterAuthorizations(charter,[{...members[0],revAddr:"wrong"}]));
assert.throws(()=>verifyCharterAuthorizations(charter,[{...members[0],role:"member"}]));
const tampered={...charter,objectives:[{...charter.objectives[0],title:"tampered"}]};
assert.notEqual(charterIssueTitle(tampered),title);
assert.throws(()=>charterIssueTitle({...charter,group:{...charter.group,cap:"cap:room:abcdef"}}));
assert.equal(decodeRhoExpr({ExprMap:{data:[[{ExprString:{data:"gid"}},{ExprString:{data:input.group.id}}]]}}).gid,input.group.id);
assert.equal(decodeRhoExpr({ExprTuple:{data:[{ExprString:{data:"opened"}},{ExprString:{data:fixture.proposalId}}]}})[0],"opened");
// Zero network calls made in this test. No status claim from a nonexistent chain.
console.log("PASS: charter-chain #291 signer, canonical payload, maps, collision/tamper/authorization");


// Regression: TOFU attribution must never be promoted to a signature.
const trustBoundary = await import("../src/charter-chain.js");
assert.equal(trustBoundary.CHARTER_AUTHORIZATION_TRUST.walletSignature, "secp256k1-wallet-verified");
assert.equal(trustBoundary.CHARTER_AUTHORIZATION_TRUST.dyncapAttribution, "hash-only-tofu-unverified");
assert.equal(trustBoundary.CHARTER_AUTHORIZATION_TRUST.pollRatification, "not-independently-verified");

// Mock only the transport: prove absence cannot be assembled from different
// snapshots or inferred from an explicit Nil without the contract index.
const originalFetch = globalThis.fetch;
const fakeNode = "http://127.0.0.1:40403";
const fakeUri = "rho:id:fixture";
const blockA = "a".repeat(64), blockB = "b".repeat(64);
const calls = [];
let mode = "moving";
try {
  globalThis.fetch = async (url, opts) => {
    const path = new URL(url).pathname;
    if (path === "/api/blocks/1") {
      const blockHash = calls.some(c => c.path === "/api/blocks/1") ? blockB : blockA;
      calls.push({path});
      return Response.json(mode === "unpinned" ? [] : [{blockHash, blockNumber: 10}]);
    }
    const body = JSON.parse(opts.body);
    const term = typeof body === "string" ? body : body.term;
    const blockHash = body.blockHash;
    calls.push({path, blockHash, term});
    const index = term.includes('"issues"');
    if (!index) return Response.json({expr: mode === "nil" ? ["Nil"] : []});
    return Response.json({expr: [mode === "nil" ? [fixture.proposalId] : []]});
  };
  const absent = await readCharterIssue(fakeNode, fakeUri, hash);
  assert.equal(absent.raw, null);
  assert.equal(calls.filter(c=>c.path === "/api/blocks/1").length, 1, "one block selected for absence proof");
  assert.deepEqual(calls.filter(c=>c.term).map(c=>c.blockHash), [blockA, blockA]);
  calls.length = 0; mode = "nil";
  await assert.rejects(readCharterIssue(fakeNode, fakeUri, hash), /indexed/);
  calls.length = 0; mode = "unpinned";
  await assert.rejects(readCharterIssue(fakeNode, fakeUri, hash), /snapshot|block/i);
} finally { globalThis.fetch = originalFetch; }
console.log("PASS: same-block absence proof, explicit Nil index check, unpinned refusal");
