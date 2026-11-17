// #291 — concrete RhoGov Issue/4/Rholo read and submit path.
// Deliberately no private-key or room-capability handling in this module.
// Caller must enforce authorization and require explicit human confirmation.
import * as rgov from "./rgov-core.js";
import { charterProposalId, charterIssueTitle, parseCharterIssueTitle,
         inspectCharterIssue, canonicalJson } from "./charter-chain.js";
import { sha256 } from "@noble/hashes/sha2.js";

export function decodeRhoExpr(node) {
  if (node === null || node === undefined || typeof node !== "object") return node;
  if (Array.isArray(node)) return node.map(decodeRhoExpr);
  const keys = Object.keys(node);
  if (keys.length !== 1 || !keys[0].startsWith("Expr")) return node;
  const tag = keys[0];
  const wrapped = node[tag];
  const body = wrapped && typeof wrapped === "object" && !Array.isArray(wrapped)
          && Object.keys(wrapped).length === 1 && "data" in wrapped ? wrapped.data : wrapped;
  if (tag === "ExprMap") {
    const pairs = Array.isArray(body) ? body : Object.entries(body || {});
    return Object.fromEntries(pairs.map(([k, v]) => [String(decodeRhoExpr(k)), decodeRhoExpr(v)]));
  }
  if (["ExprPar","ExprTuple","ExprList","ExprSet"].includes(tag)) return (body || []).map(decodeRhoExpr);
  if (["ExprInt","ExprString","ExprBool","ExprUri"].includes(tag)) return body;
  if (tag === "ExprBytes") return "0x" + String(body);
  return body;
}
function verifyBase(url) {
  const parsed = new URL(url);
  if (!["http:", "https:"].includes(parsed.protocol) || !parsed.hostname
      || parsed.username || parsed.password || parsed.search || parsed.hash
      || !["", "/"].includes(parsed.pathname)) throw new Error("unsafe Rholo API base URL");
  if (parsed.port === "40405") throw new Error("admin HTTP port must never be used");
  return parsed.href.replace(/\/$/, "");
}
async function getJson(url) {
  const res = await fetch(url, { method: "GET", signal: AbortSignal.timeout(7000) });
  if (!res.ok) throw new Error("Rholo GET " + res.status);
  return res.json();
}
async function explore(nodeUrl, term) {
  const base = verifyBase(nodeUrl);
  async function post(path, body) {
    const res = await fetch(base + path, {method:"POST",
      headers: {"content-type":"application/json"},
      body: JSON.stringify(body), signal: AbortSignal.timeout(10000)});
    const text = await res.text();
    if (!res.ok) throw new Error("Rholo explore HTTP " + res.status);
    let result;
    try { result = JSON.parse(text); } catch { throw new Error("invalid Rholo response"); }
    if (typeof result === "string") throw new Error(result.slice(0, 200));
    if (!result || !Array.isArray(result.expr)) throw new Error("missing Rholo expr");
    return { values: result.expr.map(decodeRhoExpr), block: result.block ?? null };
  }
  // RhoGov uses the latest block for an immediately readable proposal;
  // this is *not* necessarily finalized. Snapshot the actual block hash.
  let latest = null;
  try {
    const blocks = await getJson(base + "/api/blocks/1");
    latest = Array.isArray(blocks) && blocks[0]?.blockHash ? blocks[0].blockHash : null;
  } catch {}
  if (latest) {
    try {
      const r = await post("/api/explore-deploy-by-block-hash", {term, blockHash:latest, usePreStateHash:false});
      return { ...r, readAt:"latest-block-unfinalized-possible", observedHash:latest };
    } catch (err) {
      if (!/404|unknown route|not found/i.test(String(err))) throw err;
    }
  }
  const r = await post("/api/explore-deploy", term);
  return { ...r, readAt:"finalized-fringe-or-node-default", observedHash:r.block?.blockHash ?? null };
}
export async function readRhoGovGroup(nodeUrl, groupUri, groupId) {
  if (!/^rho:id:[a-z0-9]+$/.test(groupUri)) throw new Error("invalid Group contract URI");
  const r = await explore(nodeUrl, rgov.readProgram(groupUri, "groupOf", [JSON.stringify(groupId)]));
  if (r.values.length !== 1) throw new Error("Group/4 did not return exactly one value");
  const g = r.values[0];
  if (!g || typeof g !== "object" || Array.isArray(g) || !g.members || !g.admins) {
    throw new Error("no on-chain RhoGov group or invalid group record");
  }
  return { group: g, readAt: r.readAt, observedBlockHash:r.observedHash };
}
export async function readCharterIssue(nodeUrl, issueUri, charterHash) {
  const id = charterProposalId(charterHash);
  if (!/^rho:id:[a-z0-9]+$/.test(issueUri)) throw new Error("invalid Issue contract URI");
  const term = rgov.readProgram(issueUri, "issueOf", [JSON.stringify(id)]);
  const result = await explore(nodeUrl, term);
  if (result.values.length === 0) {
    // A missing Issue is represented by Nil, whose explore result has no
    // expressions on Rholo. Distinguish that from a missing/broken contract:
    // only a verified Issue/4 "issues" list authorizes absence.
    const probe = await explore(nodeUrl, rgov.readProgram(issueUri, "issues", []));
    if (probe.values.length !== 1 || !Array.isArray(probe.values[0])) {
      throw new Error("Issue/4 contract presence not proven; refusing absence claim");
    }
    if (probe.values[0].includes(id)) {
      throw new Error("Issue id indexed but issueOf returned Nil; inconsistent read");
    }
    return {raw:null, readAt:result.readAt, block:result.block,
            observedBlockHash:result.observedHash};
  }
  if (result.values.length !== 1) throw new Error("Issue/4 returned multiple values");
  const entry = result.values[0];
  if (Array.isArray(entry) && entry[0] === "gov-error") throw new Error("RhoGov read: " + String(entry[1]));
  const raw = entry === null || entry === "Nil" ? null : entry;
  return { raw, readAt: result.readAt, block: result.block,
           observedBlockHash:result.observedHash };
}
export async function readCharterStatus(nodeUrl, issueUri, charter) {
  const record = await readCharterIssue(nodeUrl,issueUri,charter.charterHash);
  const status = await inspectCharterIssue(record.raw,charter);
  // Rehash the exact independently retrieved on-chain artifact.
  if (record.raw) {
    const stored = parseCharterIssueTitle(record.raw.title);
    const { charterHash: claimed, signatures, ...content } = stored;
    const digest = [...sha256(new TextEncoder().encode(canonicalJson(content)))]
      .map((b) => b.toString(16).padStart(2,"0")).join("");
    if (digest !== stored.charterHash || claimed !== charter.charterHash) {
      throw new Error("CHAIN_CONTENT_HASH_MISMATCH");
    }
  }
  return { ...status, issueUri, chainRef:issueUri+"/"+charterProposalId(charter.charterHash),
           observedBlockHash:record.observedBlockHash, readAt:record.readAt,
           blockNumber:record.block?.blockNumber ?? null };
}
/**
 * Idempotent prepare+submit. Reads first. Unknown outcomes are NOT retried
 * automatically: a deploy might already have been accepted at the node.
 */
export async function submitCharter(nodeUrl, issueUri, charter, submitTerm) {
  const before = await readCharterStatus(nodeUrl, issueUri, charter);
  if (before.storedHash === charter.charterHash) return { ...before, submitted:false, idempotent:true };
  if (before.status !== "unknown" || before.reason !== "not found") {
    throw new Error("cannot confirm proposal absence; refusing automatic write");
  }
  const pid = charterProposalId(charter.charterHash);
  const term = rgov.openIssueProgram(issueUri, pid, charter.group.id,
    charterIssueTitle(charter), "approval", ["approve","reject"], []);
  const send = await submitTerm(term);
  if (!send || !send.ok || !send.sig) throw new Error("RhoGov deploy not accepted: " + String(send?.message ?? "unknown"));
  // Acceptance is not execution. A separate read may lag until the deploy
  // becomes visible in a block; never perform a second submission automatically.
  for (let i=0; i<12; i++) {
    await new Promise((resolve)=>setTimeout(resolve,1600));
    try {
      const after = await readCharterStatus(nodeUrl,issueUri,charter);
      if (after.storedHash === charter.charterHash)
        return { ...after, submitted:true, idempotent:false, signedDeployReference:send.sig };
    } catch (error) {
      if (/MISMATCH|noncanonical|invalid Issue/.test(String(error))) throw error;
    }
  }
  return { status:"unknown", proposalId:pid, submitted:true, idempotent:false,
           signedDeployReference:send.sig, reason:"accepted but read-back not yet observed" };
}

/** Read by hash after a reload; the complete immutable artifact lives on chain. */
export async function readCharterStatusByHash(nodeUrl, issueUri, hash, groupId) {
  const record = await readCharterIssue(nodeUrl, issueUri, hash);
  if (!record.raw) return { status:"unknown", proposalId:charterProposalId(hash),reason:"not found" };
  const expected = parseCharterIssueTitle(record.raw.title);
  if (expected.group?.id !== groupId || expected.charterHash !== hash) {
    throw new Error("CHAIN_CONTENT_HASH_MISMATCH");
  }
  return readCharterStatus(nodeUrl, issueUri, expected);
}
