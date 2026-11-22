#!/usr/bin/env node
// #291: REAL on-chain disposable Rholo/Issue/4 handoff on an isolated GH runner.
// Never contacts or controls the four public validators. No private keys in output.
import { readFileSync, writeFileSync } from "node:fs";
import { lightBlock, witness } from "./finality-witness.mjs";
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
  schema: "omega-g4-distributed-evidence/1",
  scope: "DISPOSABLE four-validator Rholo network on one isolated GitHub Actions runner; NOT public Rholo #584 validators",
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
  writeFileSync("omega-g4-distributed.json", JSON.stringify(report,null,2)+"\n", {mode:0o600});
  writeFileSync("omega-g4-distributed.SHA256SUMS", sha(readFileSync("omega-g4-distributed.json"))+
    "  omega-g4-distributed.json\n", {mode:0o600});
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
  if(process.env.GITHUB_ACTIONS!=="true" || process.env.RUNNER_ENVIRONMENT!=="github-hosted" || process.env.DEVNET_NETWORK!=="omega-finality" || !process.env.QOS_291_DATA) {
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
  if(!st.shardId || st.networkId!=="omega-g4-isolated") fail("unexpected node network/shard");
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
    return {...processed,fixtureDeploySignature:reply.sig};
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
  const closed=await deploy(rgov.closeIssueProgram(issueUri,id),"close-issue");
  const anchor=lightBlock(closed.block);
  report.closeDeploySignature=closed.fixtureDeploySignature;
  report.closeAnchor=anchor;

  const urls=[0,1,2,3].map(i=>"http://127.0.0.1:"+(40403+1000*i));
  async function get(path,base=nodeUrl) {
    const r=await fetch(base+path,{signal:AbortSignal.timeout(5000)});
    if(!r.ok) throw new Error("GET "+path+" HTTP "+r.status);
    return r.json();
  }
  async function pinned(term,hash,base=nodeUrl) {
    const r=await fetch(base+"/api/explore-deploy-by-block-hash",{
      method:"POST",headers:{"content-type":"application/json"},
      body:JSON.stringify({term,blockHash:hash,usePreStateHash:false}),
      signal:AbortSignal.timeout(10000)});
    if(!r.ok) throw new Error("pinned read HTTP "+r.status);
    const j=await r.json();
    const identity=lightBlock(j.block);
    if(identity.hash!==hash || identity.postStateHash!==anchor.postStateHash)
      throw new Error("pinned response identity mismatch");
    if(!Array.isArray(j.expr)||j.expr.length!==1) throw new Error("expected exactly one pinned result");
    return decodeRhoExpr(j.expr[0]);
  }
  const issueTerm=rgov.readProgram(issueUri,"issueOf",[JSON.stringify(id)]);
  const groupTerm=rgov.readProgram(groupUri,"groupOf",[JSON.stringify(groupId)]);
  // Freeze the actual block containing the close transaction, never a moving tip.
  const hash=anchor.hash;
  const block={blockNumber:anchor.height};
  let snapshot,groupSnapshot;
  for(let n=0;n<12;n++){
    try { snapshot=await pinned(issueTerm,hash); groupSnapshot=await pinned(groupTerm,hash); break; }
    catch(e) { report.snapshotReadError=String(e); await delay(2000); }
  }
  if(snapshot?.status!=="closed" || !groupSnapshot) fail("exact close post-state unavailable");
  let finalityObservation="not-observed";
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
  // Derive expected digest from independently decoded exact snapshot. For
  // every validator separately require its finalized oracle, header identity,
  // actual state read, native tally, and operational readiness.
  const snapshotDigest=sha(canonicalJson({issue:snapshot,group:groupSnapshot}));
  report.expectedSnapshotDigest=snapshotDigest;
  report.finalityAttempts=[];
  const deadline=Date.now()+240000;
  async function observe(base,i){
    const status=await get("/api/status",base);
    const health=await get("/health",base);
    const operator=await get("/api/v1/status/operator","http://127.0.0.1:"+(40405+1000*i));
    const row={node:i,identity:status.address,network:status.networkId,
      healthy:health.ready===true && health.orphanBodies===0 &&
        health.pipelineFaultsOutstanding===0 && health.proposalHalted===false &&
        operator.unrestorableRecords===0 && operator.resources?.cgroupOomKills===0,
      health:{ready:health.ready,orphanBodies:health.orphanBodies,
        pipelineFaultsOutstanding:health.pipelineFaultsOutstanding,proposalHalted:health.proposalHalted,
        unrestorableRecords:operator.unrestorableRecords,cgroupOomKills:operator.resources?.cgroupOomKills}};
    row.finalized=await get("/api/is-finalized/"+hash,base);
    if(typeof row.finalized!=="boolean") throw new Error("finalized oracle not boolean");
    row.head=lightBlock(await get("/api/last-finalized-block",base));
    row.anchor=lightBlock(await get("/api/block/"+hash,base));
    if(row.finalized!==true) return row;
    const v=await pinned(issueTerm,hash,base),g=await pinned(groupTerm,hash,base);
    row.snapshotDigest=sha(canonicalJson({issue:v,group:g}));
    row.nativeWinner=await pinned(nativeTerm,hash,base);
    return row;
  }
  let passRows;
  while(Date.now()<deadline){
    const observed=await Promise.allSettled(urls.map(observe));
    const rows=observed.map((r,i)=>r.status==="fulfilled"?r.value:{node:i,error:String(r.reason)});
    report.finalityAttempts.push({utc:now(),rows});
    publicRecord();
    if(witness(rows,anchor,snapshotDigest)){passRows=rows;break;}
    await delay(3000);
  }
  if(!passRows) fail("four-validator fixed-anchor finality not established within bounded window");
  // Retention at the same anchor after a quiet observation interval.
  await delay(12000);
  const retained=await Promise.all(urls.map(observe));
  report.retentionRows=retained;
  if(!witness(retained,anchor,snapshotDigest)) fail("finality or exact state not retained");
  report.finalityRows=passRows;
  finalityObservation="four-validators-report-same-finalized-anchor-and-state";
  report.distributedFinalityObserved=true; // bounded cross-node observation; not formal certificate verification
  const status=await readCharterStatusByHash(nodeUrl,issueUri,charterHash,groupId);
  if(status.status!=="unknown") fail("closed issue must not automatically promote");
  report.g4={blockHash:hash,blockNumber:block.blockNumber??null,finalityObservation,
    fixturePolicy:"three equally weighted distinct wallets; full turnout; strict majority",
    electorate:roll,ballots,weights,nativeWinner:winner,independentCounts:{approve:2,reject:1},
    rollLog:snapshot.rollLog??[],fixturePolicyDigest:sha("fixture:three-equal-wallets:full-turnout:strict-majority"),
    ballotDigest:sha(canonicalJson(ballots)),rollDigest:sha(canonicalJson(roll)),weightsDigest:sha(canonicalJson(weights)),
    chainFacingStatus:status.status,productionCouncilPolicyVerified:false,independentConsensusFinalityVerified:false};
  stage("g4-three-signed-ballots-native-tally","PASS",{blockHash:hash,winner});
  stage("g4-finality-observation","PASS_FOUR_VALIDATOR_WITNESS",{blockHash:hash});
  report.result="PASS_DISTRIBUTED_FINALITY_WITNESS_NOT_PRODUCTION_RATIFICATION";
  report.unproven=[
    "not the current rholo dev source unless node version is explicitly pinned",
    "three-wallet fixture only; no production council policy or independently verified weighted electorate",
    "four process oracle agreement and pinned state; no independent cryptographic consensus certificate or separate host failure domains",
    "CI fixture is not a live human UI click, browser handoff awaits separate review"
  ];
  publicRecord();
  console.log("G4 DISTRIBUTED WITNESS: PASS (bounded four-validator observation; not production ratification)");
}
try { await main(); }
catch(e) {
  report.result="FAIL_OR_BLOCKED";
  report.failure=String(e).slice(0,320);
  publicRecord();
  console.error("QOS291 FAIL (redacted):", String(e).slice(0,300));
  process.exitCode=1;
}
