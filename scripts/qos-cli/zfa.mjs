// ZFA capability generation + validation — Node port of the pure-TS fallback
// in packages/browser/src/zfa.ts. No dependencies (uses Web Crypto from Node 18+).
//
// ZFA = half-spin closure = count balance ∧ Pauli closure. Twist values are
// single hex digits 0–7. A `cap:label:hex` token is valid iff its twist
// sequence is count-balanced AND its ordered Pauli product lands in {±I, ±iI}.
// This must match crates/zfa-core (Rust) and twist_core.py exactly.

const T = { Up: 0, Down: 1, Right: 2, Left: 3, Slash: 4, BSlash: 5, Plus: 6, Minus: 7 };
const POS = new Set([T.Up, T.Right, T.Slash, T.Plus]); // {0,2,4,6}
const TOL = 1e-9;

// Complex as [re, im]; 2×2 matrix as [a, b, c, d].
const ZC = [0, 0], OC = [1, 0], NOC = [-1, 0], IC = [0, 1], NIC = [0, -1];
const cMul = (a, b) => [a[0] * b[0] - a[1] * b[1], a[0] * b[1] + a[1] * b[0]];
const cAdd = (a, b) => [a[0] + b[0], a[1] + b[1]];
const cEq = (a, b) => Math.abs(a[0] - b[0]) < TOL && Math.abs(a[1] - b[1]) < TOL;

const IDENTITY = [OC, ZC, ZC, OC];
const mMul = (m, n) => [
  cAdd(cMul(m[0], n[0]), cMul(m[1], n[2])),
  cAdd(cMul(m[0], n[1]), cMul(m[1], n[3])),
  cAdd(cMul(m[2], n[0]), cMul(m[3], n[2])),
  cAdd(cMul(m[2], n[1]), cMul(m[3], n[3])),
];

function twistMatrix(t) {
  switch (t) {
    case T.Up:     return [ZC, NIC, IC, ZC];   // +σ_y
    case T.Down:   return [ZC, IC, NIC, ZC];   // -σ_y
    case T.Right:  return [ZC, OC, OC, ZC];    // +σ_x
    case T.Left:   return [ZC, NOC, NOC, ZC];  // -σ_x
    case T.Slash:  return [OC, ZC, ZC, NOC];   // +σ_z
    case T.BSlash: return [NOC, ZC, ZC, OC];   // -σ_z
    case T.Plus:   return IDENTITY;            // +I
    case T.Minus:  return [NOC, ZC, ZC, NOC];  // -I
    default:       return IDENTITY;
  }
}

function pauliFold(tw) {
  let m = IDENTITY;
  for (const t of tw) m = mMul(m, twistMatrix(t));
  return m;
}

export function isPauliClosed(tw) {
  const [a, b, c, d] = pauliFold(tw);
  if (!cEq(b, ZC) || !cEq(c, ZC)) return false;
  if (!cEq(a, d)) return false;
  return [OC, NOC, IC, NIC].some((s) => cEq(a, s));
}

const countPos = (tw) => { let n = 0; for (const b of tw) if (POS.has(b)) n++; return n; };
const isCountBalanced = (tw) => countPos(tw) === tw.length - countPos(tw);

export function achievesZfa(tw) {
  return isCountBalanced(tw) && isPauliClosed(tw);
}

// ---- QLF's predicate: pairwise balance ----
//
// `achievesZfa` above conjoins Pauli closure with the AGGREGATE count
// (count_pos == count_neg). QLF's `is_zfa` requires the stronger PAIRWISE
// balance — the signed action vector vanishing, which is what Zero Free Action
// names. The aggregate predicate over-accepts: at length 6 it admits 20,480
// histories where QLF admits 5,120. It is what live room links and minted
// identities validate against and is deliberately not narrowed; these mirror
// `is_pairwise_balanced` / `achieves_zfa_pairwise` in crates/zfa-core so an
// agent can tell a room which predicate a history actually passed.

/** The signed action vector `(#^-#v, #>-#<, #/-#\, #+-#-)`. */
export function signedAction(tw) {
  const n = (t) => { let c = 0; for (const b of tw) if (b === t) c++; return c; };
  return [
    n(T.Up) - n(T.Down),
    n(T.Right) - n(T.Left),
    n(T.Slash) - n(T.BSlash),
    n(T.Plus) - n(T.Minus),
  ];
}

/** QLF's count balance: every conjugate pair balances on its own. */
export function isPairwiseBalanced(tw) {
  return signedAction(tw).every((c) => c === 0);
}

/** QLF's ZFA exactly. Strictly narrower than `achievesZfa`. */
export function achievesZfaPairwise(tw) {
  return isPairwiseBalanced(tw) && isPauliClosed(tw);
}

/**
 * How many histories each predicate admits, by history length. `pairwise` is
 * the census's own `folds.by_length[n].count` from
 * crates/zfa-core/tests/data/census_inventory.json (QLF 54fcc9b), which
 * tests/census_conformance.rs re-derives by brute force. `aggregate` is not a
 * census field — it is this crate's weaker predicate, counted here by
 * exhaustive enumeration (null where enumeration is too large to have run).
 */
export const CENSUS_ADMITTED = {
  2: { aggregate: 8,     pairwise: 8,      total: 64 },
  4: { aggregate: 384,   pairwise: 168,    total: 4096 },
  6: { aggregate: 20480, pairwise: 5120,   total: 262144 },
  8: { aggregate: null,  pairwise: 190120, total: 16777216 },
};

// Each byte → [pos, neg]: pos ∈ {0,2,4,6}, neg ∈ {1,3,5,7}. Always count-balanced.
function bytesToTwists(bytes) {
  const tw = new Uint8Array(bytes.length * 2);
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    tw[i * 2] = ((b >> 4) & 0x3) * 2;
    tw[i * 2 + 1] = ((b & 0x3) * 2) + 1;
  }
  return tw;
}

const formatCap = (label, tw) => {
  let hex = "";
  for (const t of tw) hex += t.toString(16);
  return `cap:${label}:${hex}`;
};

// Rejection-sample fresh entropy until Pauli closure holds (~4 iterations).
export function generateCapability(label) {
  return generateCapabilityProfile(label, 16);
}

// Research candidate; no existing caller opts in automatically.
export function generateCapabilityV2Candidate(label) {
  return generateCapabilityProfile(label, 34);
}

function generateCapabilityProfile(label, size) {
  const bytes = new Uint8Array(size);
  globalThis.crypto.getRandomValues(bytes);
  let tw = bytesToTwists(bytes);
  if (isPauliClosed(tw)) return formatCap(label, tw);

  const mixed = new Uint8Array(bytes.length);
  const extra = new Uint8Array(bytes.length);
  for (let attempt = 0; attempt < 1_000_000; attempt++) {
    globalThis.crypto.getRandomValues(extra);
    for (let i = 0; i < bytes.length; i++) mixed[i] = bytes[i] ^ extra[i];
    tw = bytesToTwists(mixed);
    if (isPauliClosed(tw)) return formatCap(label, tw);
  }
  throw new Error("Pauli closure rejection sampling exceeded budget");
}

export function validateCapability(token) {
  const parts = token.split(":");
  if (parts.length < 3 || parts[0] !== "cap") return false;
  const hex = parts[2];
  if (hex.length === 0 || !/^[0-7]+$/.test(hex)) return false;
  const tw = Uint8Array.from([...hex].map((c) => parseInt(c, 10)));
  return achievesZfa(tw);
}

// Parse a twist sequence from one of three forms a lemma may carry:
//   symbolic  "^v<>/\\+-"      → mapped per the 8-symbol alphabet
//   hex       "024657…"        → digits 0–7
//   capability "cap:label:hex" → the hex segment
// Returns a Uint8Array of twist values, or null if any char is invalid.
const SYMBOL = { "^": 0, v: 1, ">": 2, "<": 3, "/": 4, "\\": 5, "+": 6, "-": 7 };
export function parseTwists(str) {
  if (typeof str !== "string" || str.length === 0) return null;
  let s = str;
  if (s.startsWith("cap:")) {
    const parts = s.split(":");
    if (parts.length < 3) return null;
    s = parts[2];
  }
  // All hex digits 0–7?
  if (/^[0-7]+$/.test(s)) return Uint8Array.from([...s].map((c) => parseInt(c, 10)));
  // Otherwise treat as symbolic.
  const out = [];
  for (const ch of s) {
    if (!(ch in SYMBOL)) return null;
    out.push(SYMBOL[ch]);
  }
  return Uint8Array.from(out);
}
