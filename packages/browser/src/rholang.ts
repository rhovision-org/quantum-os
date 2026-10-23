// rholang.ts — talk to rnode, an RChain node, from the browser.
//
// Three verbs, and the difference between them is what rnode does with your
// program:
//
//   status — ask rnode what it is (version, shard, height, phlo floor).
//   eval   — run rholang and read the result back. Nothing is signed, nothing
//            is stored, no block is produced. This is `explore-deploy`.
//   deploy — sign a program and submit it. It costs phlo, it lands in a block,
//            and what it writes outlives every peer in the room.
//
// All three go over rnode's HTTP API (`--api-host`, port 40403 by default),
// which sets permissive CORS, so the browser reaches it directly — no relay, no
// agent in the middle. The gRPC API (40402) is not reachable from a browser and
// is not used here.
//
// LIMIT OF `eval`: exploratory deploy runs against already-finalized state in a
// read-only sandbox. Pure rholang and the qucalc powerbox both return values
// there. What it cannot give you is a deploy's own identity — `rho:rchain:deployId`
// and `rho:rchain:deployerId` are unbound, an exploratory deploy having no deploy
// to name — and a registry lookup of an unregistered uri simply never answers.
// rnode must also allow exploratory deploy at all: it answers only when run as
// a read-only observer or with `--dev-mode`.

import { secp256k1 } from "@noble/curves/secp256k1.js";
import { blake2b } from "@noble/hashes/blake2.js";
import { keccak_256 } from "@noble/hashes/sha3.js";

// ---------------------------------------------------------------------------
// Configuration — where rnode is and how a deploy is charged
// ---------------------------------------------------------------------------

export interface NodeConfig {
  /** Base URL of rnode's HTTP API. */
  url: string;
  /** Shard the deploy is valid in. A deploy for the wrong shard is rejected. */
  shard: string;
  phloLimit: number;
  phloPrice: number;
  /** secp256k1 deploy key, base16. Held here, never sent — only signatures are. */
  key?: string;
  /** The locker's uri. Whoever installed it derived this from their own key. */
  locker?: string;
  /** Next nonce for this key's registry slot. insertSigned refuses a stale one. */
  resultNonce?: number;
}

const CONFIG_KEY = "qos-rnode-config";

export const DEFAULT_CONFIG: NodeConfig = {
  // The **rholang playground** — a public, single-node dev chain that proposes
  // on every deploy, so /rholang works out of the box from the https
  // deployment (no mixed-content block, no local rnode to run). Deliberately
  // NOT `testnet.rhobot.net`: that is a separate, multi-validator chain that
  // only produces a block when a deploy arrives, and it is not the place to
  // learn on. `/rholang rnode <url>` points at either, or at your own — e.g.
  // http://127.0.0.1:40403 for a localnet.
  url: "https://rnodeapi.rhobot.net",
  shard: "root",
  phloLimit: 500_000,
  phloPrice: 1,
};

export function loadConfig(): NodeConfig {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    if (!raw) return { ...DEFAULT_CONFIG };
    return { ...DEFAULT_CONFIG, ...(JSON.parse(raw) as Partial<NodeConfig>) };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function saveConfig(cfg: NodeConfig): void {
  localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg));
}

/** The config as display lines. The key is shown by its public half only. */
export function describeConfig(cfg: NodeConfig): string[] {
  const out = [
    `rnode  ${cfg.url}`,
    `shard  ${cfg.shard}`,
    `phlo   limit ${cfg.phloLimit}, price ${cfg.phloPrice}`,
  ];
  if (cfg.key) {
    try {
      // The REV address only. It is the identifier a balance is held against,
      // the one to share to be paid, and the one to check a deploy's pre-charge
      // against — so it is the whole answer. A truncated public key alongside it
      // was two identifiers for one key, neither checkable against the other by
      // eye. The secret never leaves this browser.
      out.push(`addr   ${revAddressOf(cfg.key)}`);
      // Where this key's identity record lives. Computable from the key alone,
      // writable only by it — so it is worth showing next to the address a
      // balance is held against: both come from the same key.
      out.push(`record ${registryUriOf(cfg.key)}`);
    } catch {
      out.push("key    ✗ not a valid secp256k1 key");
    }
  } else {
    out.push("key    (none — /rholang key generate, or /rholang key <hex>)");
  }
  out.push(cfg.locker ? `locker ${cfg.locker}` : "locker (none — /rholang locker <uri>, or install one)");
  return out;
}

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

const hex = (b: Uint8Array): string =>
  Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

const unhex = (s: string): Uint8Array => {
  const t = s.trim().replace(/^0x/, "");
  if (!/^[0-9a-fA-F]*$/.test(t) || t.length % 2) throw new Error("not base16");
  return new Uint8Array((t.match(/../g) ?? []).map((p) => parseInt(p, 16)));
};

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = "";
  while (n > 0n) { out = BASE58[Number(n % 58n)] + out; n /= 58n; }
  for (const b of bytes) { if (b !== 0) break; out = BASE58[0] + out; }
  return out;
}

export function generateKey(): string {
  return hex(secp256k1.utils.randomSecretKey());
}

/** The uncompressed (65-byte, `04…`) public key a deploy is attributed to. */
export function publicKeyOf(secretHex: string): string {
  return hex(secp256k1.getPublicKey(unhex(secretHex), false));
}

/**
 * The REV address a deploy is charged to, derived the way rnode derives it
 * (rholang/src/util/rev_address.rs) so what is shown is what is charged:
 *
 *   eth     = last 20 bytes of keccak256(public key without its 0x04 prefix)
 *   payload = 00000000 ++ keccak256(eth)
 *   address = base58(payload ++ first 4 bytes of blake2b256(payload))
 */
// ---------------------------------------------------------------------------
// Where your own record lives
//
// rnode derives a signed-registry uri from the deployer's public key:
//
//     rho:id: + zbase32(blake2b256(pubkey))
//
// (`registry::build_uri` over `blake2b256(pub_key)` in rnode's
// `registry_insert_signed`.) Two things follow, and both matter.
//
// The uri is computable from the key alone, so a browser knows where its own
// record is BEFORE it deploys anything, with nothing to look up to find out. And `insertSigned` will only write there for
// the key the uri came from, so the slot is unforgeable without being secret.
//
// z-base-32: MSB-first 5-bit groups over the full 256 bits, no padding, the
// human-oriented alphabet rather than RFC 4648's. Checked against rnode's own
// vector — an all-zero hash encodes to 'y' repeated 52 times.
// ---------------------------------------------------------------------------

const ZBASE32 = "ybndrfg8ejkmcpqxot1uwisza345h769";

export function zbase32(data: Uint8Array, bitLength: number): string {
  let out = "";
  for (let p = 0; p < bitLength; p += 5) {
    let v = 0;
    for (let k = 0; k < 5; k++) {
      const i = p + k;
      v <<= 1;
      if (i < bitLength) v |= (data[i >> 3] >> (7 - (i % 8))) & 1;
    }
    out += ZBASE32[v];
  }
  return out;
}

/** The signed-registry uri this secret key writes to, and only this key can. */
export function registryUriOf(secretHex: string): string {
  const pub = secp256k1.getPublicKey(unhex(secretHex), false);
  return "rho:id:" + zbase32(blake2b(pub, { dkLen: 32 }), 256);
}

export function revAddressOf(secretHex: string): string {
  const pub = secp256k1.getPublicKey(unhex(secretHex), false);
  const eth = hex(keccak_256(pub.slice(1))).slice(-40);
  const payload = new Uint8Array([0, 0, 0, 0, ...keccak_256(unhex(eth))]);
  const checksum = blake2b(payload, { dkLen: 32 }).slice(0, 4);
  return base58(new Uint8Array([...payload, ...checksum]));
}

// ---------------------------------------------------------------------------
// Protobuf encoding of DeployData
//
// The signature is over blake2b256 of the protobuf encoding of DeployDataProto
// (models/proto/casper.proto), so the bytes must match rnode's exactly. proto3
// omits fields at their default value — a zero timestamp is an absent field, not
// a zero-valued one — and fields are written in ascending field number.
// ---------------------------------------------------------------------------

function varint(n: number): number[] {
  const out: number[] = [];
  let v = BigInt(n);
  do {
    let byte = Number(v & 0x7fn);
    v >>= 7n;
    if (v > 0n) byte |= 0x80;
    out.push(byte);
  } while (v > 0n);
  return out;
}

function fieldVarint(field: number, value: number): number[] {
  if (value === 0) return []; // proto3 default — omitted
  return [...varint((field << 3) | 0), ...varint(value)];
}

function fieldString(field: number, value: string): number[] {
  if (!value) return []; // proto3 default — omitted
  const bytes = new TextEncoder().encode(value);
  return [...varint((field << 3) | 2), ...varint(bytes.length), ...bytes];
}

export interface DeployData {
  term: string;
  timestamp: number;
  phloPrice: number;
  phloLimit: number;
  validAfterBlockNumber: number;
  shardId: string;
}

/** DeployDataProto: term=2, timestamp=3, phloPrice=7, phloLimit=8, validAfterBlockNumber=10, shardId=11. */
export function encodeDeployData(d: DeployData): Uint8Array {
  return new Uint8Array([
    ...fieldString(2, d.term),
    ...fieldVarint(3, d.timestamp),
    ...fieldVarint(7, d.phloPrice),
    ...fieldVarint(8, d.phloLimit),
    ...fieldVarint(10, d.validAfterBlockNumber),
    ...fieldString(11, d.shardId),
  ]);
}

/** Sign deploy data the way rnode verifies it: DER secp256k1 over blake2b256. */
export function signDeployData(d: DeployData, secretHex: string): { deployer: string; signature: string } {
  const digest = blake2b(encodeDeployData(d), { dkLen: 32 });
  const sig = secp256k1.sign(digest, unhex(secretHex), { prehash: false, format: "der" });
  return { deployer: publicKeyOf(secretHex), signature: hex(sig) };
}

// ---------------------------------------------------------------------------
// The powerbox, and the wrapper every program gets
//
// Two problems, one answer. A deploy's output goes to rnode's log, which
// nobody running a browser can read; and rnode's own capabilities are URNs
// that have to be `new`-bound before anything can be sent to them, which is a
// line of ceremony in front of every program.
//
// So every program is wrapped: `return` is in scope to report on, and so is
// every system process, under a short name. What you type is the body.
// ---------------------------------------------------------------------------

/**
 * The names a program gets for free, and what each one takes.
 *
 * `deployOnly` marks `deployerId`: an eval has no deployer, and merely binding
 * it there fails to normalize ("No value set for rho:rchain:deployerId").
 *
 * The shapes here were read off rnode's own argument parsers, not its docs —
 * `docs/src/qucalc/extensions.md` documents `trustLevels` ratings and `censure`
 * censures/vouchers as nested maps, and rnode rejects those: it wants tuple
 * lists (`parse_rating_list`, `parse_censure_list`, and `parse_voucher_list`,
 * which is `parse_rating_list` again). Verified against a running node.
 */
interface PowerboxEntry {
  name: string;
  urn: string;
  /** How it is called, with the return channel where rnode expects it. */
  sig: string;
  /** What arrives on that channel. */
  returns?: string;
  /** Argument shapes that are not obvious from the signature. */
  note?: string;
  deployOnly?: boolean;
}

const POWERBOX: PowerboxEntry[] = [
  { name: "stdout", urn: "rho:io:stdout", sig: "stdout!(value)",
    returns: "nothing — it prints to rnode's log" },

  { name: "zfa", urn: "rho:qucalc:zfa", sig: "zfa!(history, *return)",
    returns: "(isZfa, phase) — phase is +I=1, −I=-1, +iI=2, −iI=-2",
    note: "history is a list of twist values 0..7, or the equivalent string" },
  { name: "grant", urn: "rho:qucalc:grant", sig: "grant!(history, *return)",
    returns: "the minted capability uri, or Nil if the history is not ZFA-closed" },
  { name: "verify", urn: "rho:qucalc:verify", sig: "verify!(uri, *return)",
    returns: "Bool" },
  { name: "fuse", urn: "rho:qucalc:fuse", sig: "fuse!(subject, predicate, *return)",
    returns: "(geometry, cap), or Nil if the synthesis does not close" },
];

/** The names a program can use without declaring them. */
export type { PowerboxEntry };

export function powerboxNames(mode: "eval" | "deploy"): string[] {
  return POWERBOX.filter((e) => mode === "deploy" || !e.deployOnly).map((e) => e.name);
}

/** The powerbox names a program actually mentions, with what each one is. */
export function powerboxUsed(source: string, mode: "eval" | "deploy"): PowerboxEntry[] {
  return POWERBOX.filter((e) => {
    if (e.deployOnly && mode !== "deploy") return false;
    return new RegExp(`\\b${e.name}\\b`).test(source);
  });
}

/** The full spec, as display lines: how to call each name and what comes back. */
export function powerboxSpec(mode: "eval" | "deploy"): string[] {
  const out: string[] = [];
  for (const e of POWERBOX) {
    const skipped = e.deployOnly && mode !== "deploy";
    out.push(`${e.sig}${skipped ? "   (deploy only)" : ""}`);
    out.push(`    ${e.urn}`);
    if (e.returns) out.push(`    → ${e.returns}`);
    if (e.note) out.push(`    ${e.note}`);
  }
  return out;
}

/**
 * Read what the last deploy answered.
 *
 * It is at this key's registry slot — the uri `registryUriOf` derives — and
 * `lookup` answers with the whole record kept there, `(uri, (nonce, value))`.
 */
export async function readResult(cfg: NodeConfig): Promise<string[]> {
  if (!cfg.key) return [];
  const uri = registryUriOf(cfg.key);
  const r = await evalTerm(cfg, `new lookup(\`rho:registry:lookup\`), stored in {
  lookup!(\`${uri}\`, *stored) |
  for (@record <- stored) {
    match record { (_, (_, value)) => { return!(value) }  _ => { Nil } }
  }
}`).catch(() => null);
  return r?.values ?? [];
}

/**
 * The record with its nonce, so a reader can tell a fresh answer from a stale
 * one. The slot holds `(uri, (nonce, value))`; this returns `{ nonce, value }`
 * (value as rnode renders it). `nonce` is null when there is no record yet.
 */
export async function readResultRecord(cfg: NodeConfig): Promise<{ nonce: number | null; value: string | null }> {
  if (!cfg.key) return { nonce: null, value: null };
  const uri = registryUriOf(cfg.key);
  const r = await evalTerm(cfg, `new lookup(\`rho:registry:lookup\`), stored in {
  lookup!(\`${uri}\`, *stored) |
  for (@record <- stored) {
    match record { (_, (n, value)) => { return!((n, value)) }  _ => { Nil } }
  }
}`).catch(() => null);
  const raw = r?.values?.[0];
  if (raw == null) return { nonce: null, value: null };
  // rnode renders the pair as `(<int>, <value>)`; the value can itself hold
  // commas and parens, so take the first int and the rest up to the last `)`.
  const mm = /^\(\s*(\d+)\s*,\s*([\s\S]*)\)\s*$/.exec(String(raw).trim());
  if (!mm) return { nonce: null, value: String(raw) };
  return { nonce: Number(mm[1]), value: mm[2].trim() };
}

/**
 * If `body` is, in its entirety, a single top-level `new <decls> in { <inner> }`
 * — a hand-written program, or a `$macro` expansion, which always is — return
 * its parts so `wrapProgram` can MERGE rather than NEST. Otherwise null.
 *
 * Respects rholang string / backtick / comment syntax so `new` or `in` inside a
 * literal doesn't fool it; requires the closing `}` to be the last thing in the
 * body (trailing `| x!(1)` after the block ⟹ not a clean single wrap ⟹ null).
 */
export function splitTopNew(body: string): { decls: string; inner: string } | null {
  const s = body.trim();
  // leading comments before `new`
  let i = 0;
  const skipWsComments = () => {
    for (;;) {
      while (i < s.length && /\s/.test(s[i])) i++;
      if (s.startsWith("//", i)) { const e = s.indexOf("\n", i); i = e < 0 ? s.length : e; continue; }
      if (s.startsWith("/*", i)) { const e = s.indexOf("*/", i + 2); if (e < 0) return; i = e + 2; continue; }
      return;
    }
  };
  skipWsComments();
  if (!/^new\s/.test(s.slice(i))) return null;
  i += 3;
  const declStart = i;
  // scan decls to the top-level `in` that precedes the opening `{`
  let depth = 0, inStr: false | '"' | "`" = false, declEnd = -1;
  for (; i < s.length; i++) {
    const c = s[i];
    if (inStr) { if (c === inStr) inStr = false; else if (c === "\\") i++; continue; }
    if (c === '"' || c === "`") { inStr = c; continue; }
    if (c === "/" && s[i + 1] === "/") { const e = s.indexOf("\n", i); i = e < 0 ? s.length - 1 : e; continue; }
    if (c === "/" && s[i + 1] === "*") { const e = s.indexOf("*/", i + 2); if (e < 0) return null; i = e + 1; continue; }
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (depth === 0 && s.startsWith("in", i) && !/[A-Za-z0-9_']/.test(s[i - 1] ?? "") && !/[A-Za-z0-9_']/.test(s[i + 2] ?? "")) {
      declEnd = i; i += 2; break;
    }
  }
  if (declEnd < 0) return null;
  skipWsComments();
  if (s[i] !== "{") return null;
  const open = i;
  // matching `}` for `open`
  depth = 1; inStr = false; i = open + 1;
  for (; i < s.length; i++) {
    const c = s[i];
    if (inStr) { if (c === inStr) inStr = false; else if (c === "\\") i++; continue; }
    if (c === '"' || c === "`") { inStr = c; continue; }
    if (c === "/" && s[i + 1] === "/") { const e = s.indexOf("\n", i); i = e < 0 ? s.length - 1 : e; continue; }
    if (c === "/" && s[i + 1] === "*") { const e = s.indexOf("*/", i + 2); if (e < 0) return null; i = e + 1; continue; }
    if (c === "{" || c === "(" || c === "[") depth++;
    else if (c === "}" || c === ")" || c === "]") { depth--; if (depth === 0) break; }
  }
  if (depth !== 0) return null;
  const close = i;
  i = close + 1;
  skipWsComments();
  if (i < s.length) return null;                       // trailing code — not a clean single wrap
  const decls = s.slice(declStart, declEnd).trim();
  if (!/[A-Za-z_]/.test(decls)) return null;
  return { decls, inner: s.slice(open + 1, close) };
}

/** The bound names in a `new` decls list. A decl is `name` or `name(`urn`)` —
 *  no internal commas — so a plain split is safe. */
function declNames(decls: string): string[] {
  return decls
    .split(",")
    .map((d) => /^\s*([A-Za-z_][A-Za-z0-9_']*)/.exec(d)?.[1])
    .filter((n): n is string => !!n);
}

/**
 * Wrap a program body.
 *
 * eval reads its values straight off `return`, so `return` is left alone.
 *
 * A deploy cannot: its `return` is unforgeable and the deploy is long gone by
 * the time anyone asks. So the deploy wrapper writes what `return` answered to
 * this key's registry slot — the uri `registryUriOf` derives, which only this
 * key can write to — and to stdout for the log. One receive doing both, because
 * two would compete for the same values, so the first value is the one stored.
 *
 * The nonce has to advance on every write to that slot, which is why it is
 * passed in rather than invented here: the caller keeps the counter.
 *
 * When the body is already a single `new … in { … }` (a program, or a `$macro`
 * expansion — see splitTopNew), the wrapper's declarations are MERGED into that
 * one `new` instead of nesting a second layer — deduped by binding name, so the
 * body's own `stdout` / `deployerId` / etc. wins and we do not double-bind.
 */
export function wrapProgram(body: string, mode: "eval" | "deploy", nonce?: number): string {
  const ours = ["return", ...POWERBOX.filter((e) => mode === "deploy" || !e.deployOnly).map((e) => `${e.name}(\`${e.urn}\`)`)];
  if (nonce !== undefined) {
    ours.push("__insertSigned(`rho:registry:insertSigned:secp256k1`)",
              "__deployerId(`rho:rchain:deployerId`)", "__ack");
  }
  const forwarder = nonce === undefined ? "" :
    `\n  |\n  for (@__value <- return) {` +
    `\n    __insertSigned!((${Number(nonce)}, __value), *__deployerId, *__ack) |` +
    `\n    stdout!(__value)` +
    `\n  }`;

  const split = splitTopNew(body);
  if (split) {
    const taken = new Set(declNames(split.decls));
    const merged = [...ours.filter((d) => !taken.has(declNames(d)[0])), split.decls].filter(Boolean).join(", ");
    const inner = split.inner.replace(/^\n/, "").replace(/\n$/, "");
    return `new ${merged} in {\n${inner}${forwarder}\n}`;
  }

  const indented = body.split("\n").map((l) => (l.trim() ? "  " + l : l)).join("\n");
  return `new ${ours.join(", ")} in {\n${indented}${forwarder}\n}`;
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

const base = (cfg: NodeConfig): string => cfg.url.replace(/\/+$/, "");

async function getJson(cfg: NodeConfig, path: string): Promise<unknown> {
  const res = await fetch(base(cfg) + path, { headers: { accept: "application/json" } });
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(text.slice(0, 200) || `HTTP ${res.status}`);
  }
}

async function postJson(cfg: NodeConfig, path: string, body: unknown): Promise<unknown> {
  const res = await fetch(base(cfg) + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(text.slice(0, 200) || `HTTP ${res.status}`);
  }
}

export interface NodeStatus {
  version?: { api?: string; node?: string };
  address?: string;
  networkId?: string;
  shardId?: string;
  peers?: number;
  nodes?: number;
  minPhloPrice?: number;
  latestBlockNumber?: number;
}

export async function nodeStatus(cfg: NodeConfig): Promise<NodeStatus> {
  return (await getJson(cfg, "/api/status")) as NodeStatus;
}

// ---------------------------------------------------------------------------
// eval — exploratory deploy
// ---------------------------------------------------------------------------

export interface EvalResult {
  values: string[];
  blockNumber?: number;
  blockHash?: string;
}

/** Render one Par expression from rnode's JSON into readable text. */
export function renderExpr(e: unknown): string {
  if (e === null || e === undefined) return "Nil";
  if (typeof e !== "object") return String(e);
  const o = e as Record<string, unknown>;
  if ("ExprInt" in o) return String(o.ExprInt);
  // Several values on one name arrive as a par, which is rholang's own `|` —
  // so it is written the way it would be written in the program.
  if ("ExprPar" in o) {
    const parts = (o.ExprPar as unknown[]).map(renderExpr);
    return parts.length ? parts.join(" | ") : "Nil";
  }
  if ("ExprString" in o) return JSON.stringify(o.ExprString);
  if ("ExprBool" in o) return String(o.ExprBool);
  if ("ExprBytes" in o) return `0x${String(o.ExprBytes)}`;
  if ("ExprUri" in o) return String(o.ExprUri);
  if ("ExprUnforg" in o) return "Unforgeable(…)";
  if ("ExprList" in o) return `[${(o.ExprList as unknown[]).map(renderExpr).join(", ")}]`;
  if ("ExprTuple" in o) return `(${(o.ExprTuple as unknown[]).map(renderExpr).join(", ")})`;
  if ("ExprSet" in o) return `Set(${(o.ExprSet as unknown[]).map(renderExpr).join(", ")})`;
  // A map arrives as a list of [key, value] pairs, not as an object.
  if ("ExprMap" in o) {
    const entries = (o.ExprMap as [string, unknown][]) ?? [];
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}: ${renderExpr(v)}`).join(", ")}}`;
  }
  // An expression this build names differently: render what is inside rather
  // than printing rnode's wire shape at somebody. A single Expr-prefixed key is
  // the pattern every one of the above follows, so the odd one out is very
  // unlikely to be better served by raw JSON.
  const keys = Object.keys(o);
  if (keys.length === 1 && keys[0].startsWith("Expr")) {
    const inner = o[keys[0]];
    if (Array.isArray(inner)) return inner.map(renderExpr).join(", ");
    if (inner !== null && typeof inner === "object") return renderExpr(inner);
    return String(inner);
  }
  return JSON.stringify(o);
}

/**
 * Run a term without deploying it.
 *
 * The plain endpoint runs against the last *finalized* block, which a young
 * chain does not have yet ("Finalized fringe is not available"). Rather than
 * make that the user's problem, fall back to the newest block by hash — the
 * same evaluation, just anchored explicitly.
 */
export async function evalTerm(cfg: NodeConfig, term: string): Promise<EvalResult> {
  const unwrap = (r: unknown): EvalResult => {
    if (typeof r === "string") throw new Error(r); // rnode reports errors as a bare JSON string
    const o = (r ?? {}) as { expr?: unknown[]; block?: { blockNumber?: number; blockHash?: string } };
    return {
      values: (o.expr ?? []).map(renderExpr),
      blockNumber: o.block?.blockNumber,
      blockHash: o.block?.blockHash,
    };
  };

  const program = wrapProgram(term, "eval");
  try {
    return unwrap(await postJson(cfg, "/api/explore-deploy", program));
  } catch (e) {
    const msg = (e as Error).message ?? "";
    if (!/finalized fringe/i.test(msg)) throw e;
    const blocks = (await getJson(cfg, "/api/blocks/1")) as { blockHash?: string }[];
    const blockHash = blocks?.[0]?.blockHash;
    if (!blockHash) throw e;
    return unwrap(
      await postJson(cfg, "/api/explore-deploy-by-block-hash", {
        term: program,
        blockHash,
        usePreStateHash: false,
      })
    );
  }
}

// ---------------------------------------------------------------------------
// deploy — signed, charged, permanent
// ---------------------------------------------------------------------------

export interface DeployOutcome {
  ok: boolean;
  message: string;
  /** The nonce this deploy's answer was stored under, for the reader. */
  /** The nonce this deploy's answer was stored under, for the reader. */
  resultNonce?: number;
  /** The deploy's signature — how to find it in a block once one carries it. */
  sig?: string;
}

/** What a block says happened to a deploy, once one carries it. */
export interface DeployFate {
  blockNumber: number;
  errored: boolean;
  cost?: number;
  systemDeployError?: string;
}

/**
 * Read what a deploy sent to `return`.
 *
 * A deploy answers in the tuplespace, not in the reply to the submission: the
 * block has to be produced first. So this polls the newest block for data at the
 * deploy's result name, and gives up rather than waiting forever — the value is
 * still there to read later.
 */
/**
 * Read whatever is at a name right now, without waiting.
 *
 * A deploy's result outlives the deploy: it sits on the name until something
 * consumes it. So a read is a question you can ask at any time, not a window
 * you have to catch — which is what makes `/rholang read` a real answer to "my
 * deploy hasn't reported yet".
 */
export async function readName(cfg: NodeConfig, name: string): Promise<string[]> {
  const blocks = (await getJson(cfg, "/api/blocks/1")) as { blockHash?: string }[];
  const blockHash = blocks?.[0]?.blockHash;
  if (!blockHash) return [];
  const r = await postJson(cfg, "/api/data-at-name-by-block-hash", {
    name: { ExprString: name },
    blockHash,
    usePreStateHash: false,
  });
  if (typeof r === "string") return [];
  const expr = ((r ?? {}) as { expr?: unknown[] }).expr ?? [];
  return expr.map(renderExpr);
}

/**
 * Find what a block made of a deploy, by its signature.
 *
 * A deploy that fails sends nothing to `return`, so its result name stays empty
 * forever and looks identical to one still waiting on consensus. The block knows
 * the difference — it carries `errored` per deploy — and this is the only way to
 * tell the two apart from outside rnode.
 *
 * `systemDeployError` carries the reducer's first error since rholo#15 —
 * before that it was always empty, and "it errored, and cost this much" was the
 * whole of what a deployer could learn. Treat it as optional: an rnode older than
 * that fix reports nothing there.
 */
export async function deployFate(cfg: NodeConfig, sig: string, depth = 12): Promise<DeployFate | null> {
  const blocks = (await getJson(cfg, `/api/blocks/${depth}`)) as { blockHash?: string }[];
  for (const b of blocks ?? []) {
    if (!b.blockHash) continue;
    const full = (await getJson(cfg, `/api/block/${b.blockHash}`)) as {
      blockInfo?: { blockNumber?: number };
      deploys?: { sig?: string; errored?: boolean; cost?: number; systemDeployError?: string }[];
    };
    const hit = (full?.deploys ?? []).find((d) => d.sig === sig);
    if (hit) {
      return {
        blockNumber: full?.blockInfo?.blockNumber ?? -1,
        errored: hit.errored === true,
        cost: hit.cost,
        systemDeployError: hit.systemDeployError || undefined,
      };
    }
  }
  return null;
}

/**
 * What a deploy answered on `rho:rchain:deployId`, read from its own status.
 *
 * The other way to read a deploy's answer is the key's registry result slot,
 * which `readResults` uses and which the deploy wrapper writes through
 * `insertSigned`. That path is not reliable everywhere: on the rebuilt
 * playground a `ProcessedWithSuccess` deploy left the slot at `nonce: null`, so
 * a program whose answer went only to `return` read back as nothing at all.
 *
 * This path has none of that in the way — the value comes back inside the
 * deploy's own status, keyed by its signature, so it cannot be confused with
 * another deploy's answer or lost to a slot that was never written. A program
 * that wants to be read this way sends to `rho:rchain:deployId`; `rgov-core.js`
 * sends to both.
 */
export async function deployAnswer(cfg: NodeConfig, sig: string, attempts = 20): Promise<string[] | null> {
  for (let i = 0; i < attempts; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    let j: unknown;
    try { j = await getJson(cfg, `/api/v1/deploy-status/${sig}`); } catch { continue; }
    const o = j as { ProcessedWithSuccess?: { deployResult?: unknown[] }; ProcessedWithError?: unknown };
    if (o?.ProcessedWithError) return [renderExpr(o.ProcessedWithError)];
    if (o?.ProcessedWithSuccess) return (o.ProcessedWithSuccess.deployResult ?? []).map(renderExpr);
  }
  return null;
}

export async function readResults(cfg: NodeConfig, attempts = 12): Promise<string[]> {
  for (let i = 0; i < attempts; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    const v = await readResult(cfg).catch(() => []);
    if (v.length) return v;
  }
  return [];
}

/**
 * Poll the record until it reports at `minNonce` or later — a value this deploy
 * wrote, not one left on the slot by an earlier deploy that this one's program
 * never overwrote (because it errored, or sent nothing to `return`). Returns the
 * rendered value, or null if nothing fresh arrived within the window.
 */
export async function readResultsFresh(cfg: NodeConfig, minNonce: number, attempts = 12): Promise<string | null> {
  for (let i = 0; i < attempts; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    const rec = await readResultRecord(cfg).catch(() => ({ nonce: null, value: null }));
    if (rec.value != null && (rec.nonce == null || rec.nonce >= minNonce)) return rec.value;
  }
  return null;
}

/**
 * Read the nonce the slot is actually at and store the next one.
 *
 * The local counter is a convenience; the slot is the truth. They part company
 * when the same key deploys from a second browser, or when a deploy is refused
 * after the counter moved. An insert with a stale nonce is refused, so a run of
 * silent non-reporting is what being behind looks like — this ends it.
 */
export async function syncResultNonce(cfg: NodeConfig): Promise<number | null> {
  if (!cfg.key) return null;
  const uri = registryUriOf(cfg.key);
  const r = await evalTerm(cfg, `new lookup(\`rho:registry:lookup\`), stored in {
  lookup!(\`${uri}\`, *stored) |
  for (@record <- stored) {
    match record { (_, (n, _)) => { return!(n) }  _ => { Nil } }
  }
}`).catch(() => null);
  const n = Number(r?.values?.[0]);
  if (!Number.isFinite(n)) return null;
  saveConfig({ ...cfg, resultNonce: n + 1 });
  return n;
}

export async function deployTerm(cfg: NodeConfig, term: string): Promise<DeployOutcome> {
  if (!cfg.key) {
    return { ok: false, message: "no deploy key — /rholang key generate, or /rholang key <hex>" };
  }
  const [status, priorRecord] = await Promise.all([
    nodeStatus(cfg).catch(() => ({} as NodeStatus)),
    readResultRecord(cfg).catch(() => ({ nonce: null as number | null, value: null as string | null })),
  ]);
  // The answer goes to this key's registry slot, which only this key can write
  // to. The nonce has to advance on every write there, so it is kept beside the
  // key rather than guessed — but the slot is the truth, not the counter: this
  // same devnet deployer key is meant to be shared (scripts/localnet/README.md),
  // so another browser or a script deploying between two of your deploys moves
  // the slot's nonce out from under a purely-local count, without touching it.
  // A deploy at a nonce the slot has already passed is silently refused — no
  // rholang error, "Success!" all the same — and readResultsFresh below would
  // then report whatever is *already* sitting there (someone else's value) as
  // if this deploy had just written it. Taking the max with the slot's own
  // nonce+1 (what `/rholang nonce` does by hand) closes that window instead of
  // requiring it as a manual recovery step.
  const nonce = Math.max(cfg.resultNonce ?? 1, (priorRecord.nonce ?? 0) + 1);
  // Persist the node's own shard alongside the nonce bump, so a corrected
  // mismatch (below) sticks — the /rholang status warning stops nagging
  // after the first successful deploy instead of every one.
  saveConfig({ ...cfg, resultNonce: nonce + 1, shard: status.shardId || cfg.shard });
  const data: DeployData = {
    term: wrapProgram(term, "deploy", nonce),
    timestamp: Date.now(),
    phloPrice: cfg.phloPrice,
    phloLimit: cfg.phloLimit,
    // A deploy is valid only after a block rnode already has; the current
    // height is always safe, and 0 (genesis) is the floor.
    validAfterBlockNumber: Math.max(0, (status.latestBlockNumber ?? 0) - 1),
    // The node's own answer wins over the persisted config: a shard's name is
    // whatever the node currently reports it as (e.g. rnode grew a leading
    // "/" on shardId between builds), and a stale cfg.shard otherwise gets a
    // deploy refused outright ("shardId 'root' is not a member of this
    // node's shards: [/root]") — the same fallback deployToNode already uses.
    shardId: status.shardId || cfg.shard,
  };
  const { deployer, signature } = signDeployData(data, cfg.key);
  const reply = await postJson(cfg, "/api/deploy", {
    data,
    deployer,
    signature,
    sigAlgorithm: "secp256k1",
  });
  // Success and failure both come back as a JSON string; rnode says "Success!"
  // on the happy path and names the reason otherwise.
  const text = typeof reply === "string" ? reply : JSON.stringify(reply);
  const ok = /success/i.test(text);
  return { ok, message: text, resultNonce: ok ? nonce : undefined, sig: ok ? signature : undefined };
}

// A workflow can span shards (CapabilityTransport.md): the bridge key signs on
// both nodes, but the same key has an *independent* result-slot nonce on each
// (separate tuplespaces). `deployTerm` above tracks one nonce in the persisted
// config; this tracks a nonce per node URL, in memory, seeded from each node's
// own slot on first use — and never writes the persisted config, so pointing it
// at shard B does not repoint `/rholang`.
const nodeResultNonce = new Map<string, number>();

/**
 * Deploy `term` to `url` with `baseCfg`'s key and phlo, without touching the
 * persisted single-node config. Returns the deploy outcome plus — polled from
 * that node's result slot — the value the program sent to `return`, or
 * undefined if nothing landed in the window (a failed transfer may send
 * nothing, leaving the slot empty).
 */
export async function deployToNode(
  baseCfg: NodeConfig, url: string, term: string, waitAttempts = 20,
): Promise<DeployOutcome & { value?: string }> {
  if (!baseCfg.key) return { ok: false, message: "no deploy key — /rholang key generate, or /rholang key <hex>" };
  const cfg: NodeConfig = { ...baseCfg, url };

  let nonce = nodeResultNonce.get(url);
  if (nonce === undefined) {
    const rec = await readResultRecord(cfg).catch(() => ({ nonce: null as number | null }));
    nonce = (rec.nonce ?? 0) + 1;
  }
  nodeResultNonce.set(url, nonce + 1);

  const status = await nodeStatus(cfg).catch(() => ({} as NodeStatus));
  const data: DeployData = {
    term: wrapProgram(term, "deploy", nonce),
    timestamp: Date.now(),
    phloPrice: cfg.phloPrice,
    phloLimit: cfg.phloLimit,
    validAfterBlockNumber: Math.max(0, (status.latestBlockNumber ?? 0) - 1),
    shardId: status.shardId || cfg.shard,
  };
  const { deployer, signature } = signDeployData(data, baseCfg.key);
  const reply = await postJson(cfg, "/api/deploy", { data, deployer, signature, sigAlgorithm: "secp256k1" });
  const text = typeof reply === "string" ? reply : JSON.stringify(reply);
  const ok = /success/i.test(text);
  if (!ok) return { ok, message: text };
  const value = await readResultsFresh(cfg, nonce, waitAttempts);
  return { ok, message: text, resultNonce: nonce, sig: signature, value: value ?? undefined };
}

/** Read what a deploy answered at a specific node (its result slot). */
export async function readResultAt(baseCfg: NodeConfig, url: string): Promise<{ nonce: number | null; value: string | null }> {
  return readResultRecord({ ...baseCfg, url }).catch(() => ({ nonce: null, value: null }));
}
