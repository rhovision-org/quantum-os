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
  readRhoGovGroup, readCharterStatusByHash, submitCharter
} from "../../packages/browser/src/charter-rhogov.js";
import {
  DEFAULT_CONFIG, nodeStatus, revAddressOf, deployTerm
} from "../qos-cli/rholang-client.mjs";

const report = {
  schema: "qos291-real-chain-evidence/1",
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
  writeFileSync("qos291-real-chain.json", JSON.stringify(report,null,2)+"\n", {mode:0o600});
  writeFileSync("qos291-real-chain.SHA256SUMS", sha(readFileSync("qos291-real-chain.json"))+
    "  qos291-real-chain.json\n", {mode:0o600});
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
  report.githubWorkflowTestedMergeSha=sourceCommit;
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

  const deploy=async(program,label)=>{
    const reply=await deployTerm(cfg,program,{waitAttempts:0});
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
  const charterContent=vector.content;
  const charterHash=sha(canonicalJson(charterContent));
  if(charterHash!==vector.charterHash) fail("cross-repo canonical SHA-256 vector mismatch");
  report.charterHash=charterHash;
  report.proposalId=charterProposalId(charterHash);
  const groupId=charterContent.group.id;

  await deploy(rgov.createGroupProgram(groupUri,groupId,charterContent.group.name),"create-group");
  const group=await readRhoGovGroup(nodeUrl,groupUri,groupId);
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
  if(byHash.storedHash!==charterHash||byHash.proposalId!==vector.proposalId)
    fail("read-only hash lookup mismatch");
  stage("read-only-lookup-by-hash","PASS",{status:byHash.status});

  const modified={...charter,group:{...charter.group,name:"tampered"}};
  let detected=false;
  try {
    await submitCharter(nodeUrl,issueUri,modified,async()=>fail("tampered payload attempted a deploy"));
  } catch(e) { detected=/MISMATCH|collision|noncanonical|invalid/.test(String(e)); }
  if(!detected) fail("tampered artifact did not fail closed");
  stage("tampered-artifact-rejected","PASS");

  report.result="PASS_REAL_DISPOSABLE_ISSUE_4_SUBMISSION";
  report.unproven=[
    "not the current rholo dev source unless node version is explicitly pinned",
    "no independently verified multi-stakeholder native tally/quorum",
    "read from latest tip may be unfinalized, never settlement proof",
    "CI fixture is not a live human UI click, browser handoff awaits separate review"
  ];
  publicRecord();
  console.log("QOS291 REAL CHAIN RECORD: PASS (not ratification/finality)");
}
try { await main(); }
catch(e) {
  report.result="FAIL_OR_BLOCKED";
  report.failure=String(e).slice(0,320);
  publicRecord();
  console.error("QOS291 FAIL (redacted):", String(e).slice(0,300));
  process.exitCode=1;
}
