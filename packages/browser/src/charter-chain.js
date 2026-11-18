// Cross-repository success-charter/1 → RhoGov Issue/4 binding (#291).
// Pure, source-reviewable functions. The on-chain RhoGov issue is the durable
// record, *not* proof that its declared signatures or tally are legitimate.
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { blake2b } from "@noble/hashes/blake2.js";

export const TITLE_PREFIX = "qos/success-charter/1:";
export const PROPOSAL_PREFIX = "success-charter-";
export const MAX_TITLE_BYTES = 12000;
const SIGN_DOMAIN = "qos:success-charter/1:handoff\n";
const HEX64 = /^[a-f0-9]{64}$/;
const HEXPUB = /^(02|03)[a-f0-9]{64}$/;
const HEXSIG = /^[a-f0-9]{128}$/;
const encoder = new TextEncoder();
const toHex = (value) => [...value].map((b) => b.toString(16).padStart(2, "0")).join("");
const fromHex = (text) => new Uint8Array((text.match(/../g) || []).map((h) => parseInt(h, 16)));

export function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  const keys = Object.keys(value).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalJson(value[k])).join(",") + "}";
}
export function charterProposalId(hash) {
  if (!HEX64.test(hash)) throw new Error("invalid charter hash");
  return PROPOSAL_PREFIX + hash;
}
export function handoffDigest(hash, anchor) {
  if (!HEX64.test(hash) || !HEX64.test(anchor)) throw new Error("invalid hash / anchor");
  return sha256(encoder.encode(SIGN_DOMAIN + hash + "\n" + anchor));
}
function base58(bytes) {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = "";
  while (n > 0n) { out = alphabet[Number(n % 58n)] + out; n /= 58n; }
  for (const b of bytes) { if (b !== 0) break; out = "1" + out; }
  return out;
}
export function revAddressFromPublicKey(pubkey) {
  const pub = fromHex(pubkey);
  if (!HEXPUB.test(pubkey) || pub.length !== 33) throw new Error("invalid compressed secp256k1 public key");
  const uncompressed = secp256k1.Point.fromHex(pubkey).toBytes(false);
  const eth = keccak_256(uncompressed.slice(1)).slice(-20);
  const payload = new Uint8Array([0, 0, 0, 0, ...keccak_256(eth)]);
  const check = blake2b(payload, { dkLen: 32 }).slice(0, 4);
  return base58(new Uint8Array([...payload, ...check]));
}
// A dyncap anchor is hash/TOFU attribution, not a seed signature.
export const CHARTER_AUTHORIZATION_TRUST = Object.freeze({
  walletSignature: "secp256k1-wallet-verified",
  dyncapAttribution: "hash-only-tofu-unverified",
  pollRatification: "not-independently-verified",
});
/** Deterministic domain-separated wallet signature bound to one dyncap anchor. */
export function signCharterAuthorization(hash, anchor, privateKeyHex) {
  if (!HEX64.test(privateKeyHex)) throw new Error("invalid secp256k1 secret");
  const pub = toHex(secp256k1.getPublicKey(fromHex(privateKeyHex), true));
  const sig = secp256k1.sign(handoffDigest(hash, anchor), fromHex(privateKeyHex),
                           { prehash: false, format: "compact" });
  return ["sc1", anchor, pub, toHex(sig)].join(":");
}
/**
 * Signatures authenticate a *wallet key* against a member's published REV
 * address and their dyncap *anchor claim*. Anchor↔key binding is the group's
 * existing self-asserted/TOFU record, not a proof that the dyncap seed signed.
 */
export function verifyCharterAuthorizations(charter, members) {
  if (!charter || !HEX64.test(charter.charterHash || "")) throw new Error("invalid charter hash");
  if (!Array.isArray(charter.signatures) || !charter.signatures.length) throw new Error("charter has no approvals");
  const byAnchor = new Map(members.filter((m) => m.anchor && m.revAddr).map((m) => [m.anchor, m]));
  let adminCount = 0;
  const unique = new Set();
  for (const encoded of charter.signatures) {
    const [tag, anchor, pub, sig, extra] = String(encoded).split(":");
    if (tag !== "sc1" || extra !== undefined || !HEX64.test(anchor || "")
        || !HEXPUB.test(pub || "") || !HEXSIG.test(sig || "")) throw new Error("malformed charter signature");
    if (unique.has(anchor)) throw new Error("duplicate approval anchor");
    unique.add(anchor);
    const member = byAnchor.get(anchor);
    if (!member) throw new Error("signer anchor is not a published group member");
    if (revAddressFromPublicKey(pub) !== member.revAddr) throw new Error("signature wallet does not match member REV address");
    if (!secp256k1.verify(fromHex(sig), handoffDigest(charter.charterHash, anchor), fromHex(pub),
                          { prehash: false, format: "compact" })) throw new Error("invalid charter signature");
    if (member.role === "admin") adminCount++;
  }
  if (!adminCount) throw new Error("charter requires an admin wallet authorization");
  return { valid: true, approvals: unique.size, adminApprovals: adminCount };
}
export function charterIssueTitle(charter) {
  if (!charter || charter.schema !== "success-charter/1" || charter.version !== 1
      || !HEX64.test(charter.charterHash || "")) throw new Error("invalid success-charter/1 artifact");
  // Serialize the exact shared artifact. Do not store only its hash; RhoGov
  // must be able to return exactly the content peers voted to export.
  const text = canonicalJson(charter);
  if (/cap:room:/i.test(text) || /room[_-]?cap/i.test(text) || /"personal(goals?|notes?|habits?)"/i.test(text)) {
    throw new Error("raw room capability or personal-state field is forbidden");
  }
  const title = TITLE_PREFIX + encodeURIComponent(text);
  if (encoder.encode(title).length > MAX_TITLE_BYTES) throw new Error("charter too large for issue-title transport");
  return title;
}
export function parseCharterIssueTitle(title) {
  if (typeof title !== "string" || !title.startsWith(TITLE_PREFIX) || title.length > MAX_TITLE_BYTES) {
    throw new Error("not a success-charter/1 issue");
  }
  let parsed;
  try { parsed = JSON.parse(decodeURIComponent(title.slice(TITLE_PREFIX.length))); }
  catch { throw new Error("malformed charter title encoding"); }
  if (charterIssueTitle(parsed) !== title) throw new Error("noncanonical charter title");
  return parsed;
}
/** Hash and identity check against immutable Issue/4 title; fail closed. */
export async function inspectCharterIssue(raw, expected) {
  const proposalId = charterProposalId(expected.charterHash);
  if (raw === null || raw === undefined) return { status: "unknown", proposalId, reason: "not found" };
  if (typeof raw !== "object" || Array.isArray(raw)) throw new Error("chain returned invalid Issue record");
  if (raw.gid !== expected.group.id || raw.mode !== "approval"
      || canonicalJson(raw.options) !== canonicalJson(["approve", "reject"])) {
    throw new Error("chain proposal metadata does not match charter");
  }
  const got = parseCharterIssueTitle(raw.title);
  if (got.charterHash !== expected.charterHash || got.group?.id !== expected.group.id
      || canonicalJson(got) !== canonicalJson(expected)) throw new Error("CHAIN_HASH_OR_ARTIFACT_MISMATCH");
  // The Issue/4 contract records claimed outcomes but never runs the tally:
  // closed+proposed(result) alone is NOT verified multi-stakeholder approval.
  const phase = raw.status;
  return { status: phase === "open" || phase === "locked" ? "pending" : "unknown",
           proposalId, storedHash: got.charterHash, chainPhase: phase || "unknown",
           reason: phase === "closed" ? "closed issue requires independent tally/ratification proof" : null };
}
