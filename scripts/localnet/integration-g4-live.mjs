#!/usr/bin/env node
// #291: REAL on-chain disposable Rholo/Issue/4 handoff on an isolated GH runner.
// Never contacts or controls the four public validators. No private keys in output.
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import * as rgov from "../../packages/browser/src/rgov-core.js";
import {
  signCharterAuthorization, verifyCharterAuthorizations, charterIssueTitle,
  charterProposalId, canonicalJson
} from "../../packages/browser/src/charter-chain.js";
import {
  readRhoGovGroup, readCharterStatusByHash, submitCharter, decodeRhoExpr
} from "../../packages/browser/src/charter-rhogov.js";
import {
  DEFAULT_CONFIG, nodeStatus, revAddressOf, deployTerm
} from "../qos-cli/rholang-client.mjs";

const report = {
  schema: "omega-g4-real-chain-evidence/1",
  scope: "DISPOSABLE local Rholo node on an isolated GitHub Actions runner; NOT public Rholo #584 validators",
  stages: [], finalityVerified: false, multiStakeholderRatificationVerified: false,
  disposableNode: true, noPublicValidatorModification: true
};
const stage = (name, verdict, detail={}) => {
  report.stages.push({name, verdict, ...detail});
  console.log("QOS291", name, verdict);
};
const fail = (message) => {
  stage("ABORT", "FAIL", {reason:message});
  throw new Error(message);
};
const sha = (s) => createHash("sha256").update(s).digest("hex");
const now = () => new Date().toISOString();
function publicRecord() {
  report.recordedUtc = now();
  writeFileSync("omega-g4-real-chain.json", JSON.stringify(report,null,2)+"\n", {mode:0o600});
  writeFileSync("omega-g4-real-chain.SHA256SUMS", sha(readFileSync("omega-g4-real-chain.json"))+
    "  omega-g4-real-chain.json\n", {mode:0o600});
}
const delay = (ms)=>new Promise((r)=>setTimeout(r,ms));
const readKey = (n)=>readFileSync(new URL("./pk.txt",import.meta.url),"utf8")
  .split("\n").find((line)=>line.startsWith(n+"="))?.split("=")[1]?.trim();
async function pollDeploy(sig,label) {
  for(let i=0;i<38;i++) {
    await delay(2200);
    try {
      const res=await fetch("http://127.0.0.1:40403/api/v1/deploy-status/"+
        encodeURIComponent(sig),{signal:AbortSignal.timeout(4000)});
      if(!res.ok) continue;
      const body=await res.json();
      if(body.ProcessedWithError) fail(label+" processed WITH ERROR");
      if(body.ProcessedWithSuccess) return body.ProcessedWithSuccess;
    } catch(e) {
      if(e.message?.includes("processed WITH ERROR")) throw e;
    }
  }
  fail(label+" accepted but no observed processed outcome");
}
function extractUri(result){
  const rendered=JSON.stringify(result);
  const m=rendered.match(/rho:id:[a-z0-9]+/);
  if(!m) fail("installed contract URI missing in actual deployResult");
  return m[0];
}
async function main() {
  if(process.env.GITHUB_ACTIONS!=="true" || !process.env.QOS_291_DATA) {
    fail("refusing execution outside dedicated disposable GH Actions runner");
  }
  const state=resolve(process.env.QOS_291_DATA);
  if(!state.startsWith("/home/runner/") && !state.startsWith("/tmp/")) {
    fail("disposable data directory must be in GitHub runner temporary storage");
  }
  const sourceCommit=process.env.GITHUB_SHA||"unavailable";
  report.githubWorkflowTestedSha=sourceCommit;
  report.quantumOsSource=process.env.QOS_291_HEAD_SHA||sourceCommit;
  report.githubRunId=process.env.GITHUB_RUN_ID||null;
  report.githubRunAttempt=process.env.GITHUB_RUN_ATTEMPT||null;
  report.nodeExecutableVersion=process.env.QOS_291_RNODE_VERSION||"unavailable";
  report.nodeExecutableSha256=process.env.QOS_291_RNODE_HASH||"unavailable";
  report.startedUtc=now();

  const key=readKey("deployer"); // committed PUBLIC disposable localnet fixture
  if(!/^[a-f0-9]{64}$/i.test(key||"")) fail("throwaway localnet deployer key unavailable");
  const nodeUrl="http://127.0.0.1:40403";
  const st=await nodeStatus({url:nodeUrl});
  if(!st.shardId || !st.networkId) fail("node network/shard unavailable");
  report.networkId=st.networkId;
  report.shardId=st.shardId;
  stage("actual-disposable-rholo-http", "PASS",{nodeSource:st.version?.node||null});
  const cfg={...DEFAULT_CONFIG,url:nodeUrl,key,shard:st.shardId,phloLimit:8_000_000};

  const deploy=async(program,label,signer=key)=>{
    const reply=await deployTerm({...cfg,key:signer},program,{waitAttempts:0});
    if(!reply?.ok||!reply?.sig) fail(label+" rejected before inclusion");
    const processed=await pollDeploy(reply.sig,label);
    stage(label,"PROCESSED_WITH_SUCCESS",{resultExprPresent:!!processed.deployResult,
      deployResultLength:Array.isArray(processed.deployResult)?processed.deployResult.length:null});
    return processed;
  };

  const groupInstalled=await deploy(rgov.installGroupProgram(),"install-group-4");
  const groupUri=extractUri(groupInstalled.deployResult);
  const issueInstalled=await deploy(rgov.installIssueProgram(),"install-issue-4");
  const issueUri=extractUri(issueInstalled.deployResult);
  report.groupContract=groupUri;
  report.issueContract=issueUri;

  const vector=JSON.parse(readFileSync(new URL("../../contract/success-charter-1-vector.json",
    import.meta.url),"utf8"));
  if(sha(canonicalJson(vector.content))!==vector.charterHash) fail("cross-repo canonical SHA-256 vector mismatch");
  // Public, disposable fixtures only. Three distinct wallets are necessary;
  // the anchors are test labels, not evidence of dyncap ownership.
  const keys=[key,readKey("alice"),readKey("bob")];
  if(keys.some(k=>!/^[a-f0-9]{64}$/i.test(k||""))) fail("missing disposable wallet fixture");
  const addresses=keys.map(k=>revAddressOf(k));
  if(new Set(addresses).size!==3) fail("wallet fixtures not distinct");
  const anchors=addresses.map(a=>sha("omega-g4-test-anchor:"+a));
  const charterContent={...vector.content, members:anchors.map((anchor,i)=>({anchor,role:i===0?"admin":"member"})),proposer:anchors[0]};
  const charterHash=sha(canonicalJson(charterContent));
  report.charterHash=charterHash;
  report.proposalId=charterProposalId(charterHash);
  const groupId=charterContent.group.id;

  await deploy(rgov.createGroupProgram(groupUri,groupId,charterContent.group.name),"create-group");
  await deploy(rgov.joinGroupProgram(groupUri,groupId,"Fixture Alice"),"join-alice",keys[1]);
  await deploy(rgov.joinGroupProgram(groupUri,groupId,"Fixture Bob"),"join-bob",keys[2]);
  const group=await readRhoGovGroup(nodeUrl,groupUri,groupId);
  if(addresses.some(a=>!group.group.members[a])) fail("three wallet membership not observed");
  const walletAddress=revAddressOf(key);
  if(!group.group.members?.[walletAddress] || !group.group.admins?.[walletAddress]) {
    fail("on-chain Group/4 admin identity not independently readable");
  }
  stage("independent-onchain-admin-lookup","PASS",{readAt:group.readAt,
    observedBlockHash:group.observedBlockHash});
  const approval=signCharterAuthorization(charterHash,charterContent.proposer,key);
  const charter={...charterContent,charterHash,signatures:[approval]};
  verifyCharterAuthorizations(charter,[{anchor:charterContent.proposer,
    revAddr:walletAddress,role:"admin"}]);
  stage("wallet-signature-and-identity","PASS",{authorizationType:"secp256k1 wallet + self-asserted TOFU dyncap anchor"});
  const title=charterIssueTitle(charter);
  report.immutableTitleSha256=sha(title);
  // A read of a missing issue must explicitly report absent, not a fake success.
  const absent=await readCharterStatusByHash(nodeUrl,issueUri,charterHash,groupId);
  if(absent.status!=="unknown" || absent.reason!=="not found") fail("pre-submission absence check failed");
  stage("read-before-write","PASS",{proposalId:report.proposalId});

  const result=await submitCharter(nodeUrl,issueUri,charter,async(term)=>{
    const outcome=await deployTerm(cfg,term,{waitAttempts:0});
    if(!outcome?.ok||!outcome?.sig) return outcome;
    await pollDeploy(outcome.sig,"handoff-signed-open");
    stage("handoff-signed-open","PROCESSED_WITH_SUCCESS");
    return outcome;
  });
  if(result.storedHash!==charterHash || result.status!=="pending" || !result.submitted) {
    fail("signed handoff submitted but exact immutable on-chain read-back missing");
  }
  report.observedBlockHash=result.observedBlockHash;
  report.observedBlockNumber=result.blockNumber??null;
  report.readAt=result.readAt;
  report.proposalState=result.status;
  stage("immutable-onchain-read-back","PASS",{status:result.status,readAt:result.readAt});
  const again=await submitCharter(nodeUrl,issueUri,charter,async()=>fail("idempotent retry submitted another deploy"));
  if(again.submitted!==false || !again.idempotent) fail("repeat was not idempotent");
  stage("idempotency-no-second-deploy","PASS");
  const byHash=await readCharterStatusByHash(nodeUrl,issueUri,charterHash,groupId);
  if(byHash.storedHash!==charterHash||byHash.proposalId!==report.proposalId)
    fail("read-only hash lookup mismatch");
  stage("read-only-lookup-by-hash","PASS",{status:byHash.status});

  const modified={...charter,group:{...charter.group,name:"tampered"}};
  let detected=false;
  try {
    await submitCharter(nodeUrl,issueUri,modified,async()=>fail("tampered payload attempted a deploy"));
  } catch(e) { detected=/MISMATCH|collision|noncanonical|invalid/.test(String(e)); }
  if(!detected) fail("tampered artifact did not fail closed");
  stage("tampered-artifact-rejected","PASS");

  // The production handoff opens an empty roll. Set it explicitly *before*
  // any vote; record this as fixture policy, not a production council policy.
  const id=report.proposalId;
  await deploy(rgov.setRollProgram(issueUri,id,addresses),"set-roll-before-vote");
  for(let i=0;i<keys.length;i++)
    await deploy(rgov.castProgram(issueUri,id,[i===2?"reject":"approve"]),"cast-wallet-"+i,keys[i]);
  await deploy(rgov.closeIssueProgram(issueUri,id),"close-issue");

  async function get(path) {
    const r=await fetch(nodeUrl+path,{signal:AbortSignal.timeout(5000)});
    if(!r.ok) throw new Error("GET "+path+" HTTP "+r.status);
    return r.json();
  }
  async function pinned(term,hash) {
    const r=await fetch(nodeUrl+"/api/explore-deploy-by-block-hash",{
      method:"POST",headers:{"content-type":"application/json"},
      body:JSON.stringify({term,blockHash:hash,usePreStateHash:false}),
      signal:AbortSignal.timeout(10000)});
    if(!r.ok) throw new Error("pinned read HTTP "+r.status);
    const j=await r.json();
    if(j.block?.blockHash && j.block.blockHash!==hash) throw new Error("snapshot hash mismatch");
    if(!Array.isArray(j.expr)||j.expr.length!==1) throw new Error("expected exactly one pinned result");
    return decodeRhoExpr(j.expr[0]);
  }
  const issueTerm=rgov.readProgram(issueUri,"issueOf",[JSON.stringify(id)]);
  const groupTerm=rgov.readProgram(groupUri,"groupOf",[JSON.stringify(groupId)]);
  let snapshot, block, finalityObservation="not-observed";
  // A finalized snapshot must contain the CLOSED issue, not merely its open
  // predecessor. A node's endpoint is observation, never independent proof.
  for(let n=0;n<4;n++) {
    try {
      const candidate=await get("/api/last-finalized-block");
      const hash=candidate.blockHash;
      if(!/^[a-f0-9]{64}$/i.test(hash||"")) throw new Error("missing finalized hash");
      const observed=await pinned(issueTerm,hash);
      if(observed?.status==="closed" && await get("/api/is-finalized/"+hash)===true) {
        snapshot=observed;block=candidate;finalityObservation="single-node-reports-finalized";break;
      }
    } catch {}
    if(n<3) await deploy("new ret(`rho:rchain:deployId`) in { ret!(Nil) }","advance-fixture-chain-"+n);
  }
  if(!snapshot) {
    block=(await get("/api/blocks/1"))[0];
    snapshot=await pinned(issueTerm,block.blockHash);
  }
  const hash=block.blockHash;
  if(!/^[a-f0-9]{64}$/i.test(hash||"") || snapshot.status!=="closed") fail("closed issue not observed");
  const groupSnapshot=await pinned(groupTerm,hash);
  const roll=Object.keys(snapshot.voters||{}).sort();
  const actualMembers=Object.keys(groupSnapshot.members||{}).sort();
  const expected=addresses.slice().sort();
  if(canonicalJson(roll)!==canonicalJson(expected)||canonicalJson(actualMembers)!==canonicalJson(expected))
    fail("fixture electorate mismatch");
  const ballots=snapshot.ballots||{};
  if(Object.keys(ballots).length!==3 || addresses.some((a,i)=>canonicalJson(ballots[a])!==canonicalJson([i===2?"reject":"approve"])))
    fail("exact signed ballot record mismatch");
  if(Object.keys(snapshot.guests||{}).length || (snapshot.rollLog||[]).some(x=>x.ballotsBefore>0))
    fail("guest or post-ballot roll change");
  if(snapshot.title!==title) fail("immutable title mismatch after voting");
  const weights=Object.fromEntries(addresses.map(a=>[a,1]));
  const nativeTerm='new return, tally(`rho:gov:tally`), r in { tally!('+JSON.stringify(ballots)+', '+JSON.stringify(weights)+', "approval", *r) | for (@w <- r) { return!(w) } }';
  const winner=await pinned(nativeTerm,hash);
  if(winner!=="approve") fail("native tally disagrees with independent fixture expectation");
  const status=await readCharterStatusByHash(nodeUrl,issueUri,charterHash,groupId);
  if(status.status!=="unknown") fail("closed issue must not automatically promote");
  report.g4={blockHash:hash,blockNumber:block.blockNumber??null,finalityObservation,
    fixturePolicy:"three equally weighted distinct wallets; full turnout; strict majority",
    electorate:roll,ballots,weights,nativeWinner:winner,independentCounts:{approve:2,reject:1},
    rollLog:snapshot.rollLog??[],fixturePolicyDigest:sha("fixture:three-equal-wallets:full-turnout:strict-majority"),
    ballotDigest:sha(canonicalJson(ballots)),rollDigest:sha(canonicalJson(roll)),weightsDigest:sha(canonicalJson(weights)),
    chainFacingStatus:status.status,productionCouncilPolicyVerified:false,independentConsensusFinalityVerified:false};
  stage("g4-three-signed-ballots-native-tally","PASS",{blockHash:hash,winner});
  stage("g4-finality-observation",finalityObservation==="not-observed"?"OPEN":"OBSERVED_SINGLE_NODE",{blockHash:hash});
  report.result="PASS_DISPOSABLE_G4_FIXTURE_NOT_PRODUCTION_RATIFICATION";
  report.unproven=[
    "not the current rholo dev source unless node version is explicitly pinned",
    "three-wallet fixture only; no production council policy or independently verified weighted electorate",
    "read from latest tip may be unfinalized, never settlement proof",
    "CI fixture is not a live human UI click, browser handoff awaits separate review"
  ];
  publicRecord();
  console.log("G4 FIXTURE RECORD: PASS (not production ratification or independent finality)");
}
try { await main(); }
catch(e) {
  report.result="FAIL_OR_BLOCKED";
  report.failure=String(e).slice(0,320);
  publicRecord();
  console.error("QOS291 FAIL (redacted):", String(e).slice(0,300));
  process.exitCode=1;
}
