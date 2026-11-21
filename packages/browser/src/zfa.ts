/// ZFA kernel wrapper — loads the WASM module and exposes typed APIs.
/// Falls back to a pure-TS implementation if WASM is unavailable.
///
/// ZFA = **half-spin closure**: a process whose execution returns a spin-1/2
/// spinor to itself up to a global phase. The predicate is the conjunction
/// of the two algebraic faces of that closure:
///
///   1. **Pauli closure** — the ordered SU(2) product of twist Paulis lands
///      in {±I, ±iI}. The *non-abelian* face: the spinor returns up to phase.
///   2. **Count balance** — count_pos == count_neg. The *abelian* face: each
///      twist is paired with its Hermitian conjugate (bra-ket structure).
///
/// Pauli closure is not a stronger second condition; it IS the SU(2)-scalar-
/// return reading of half-spin closure. Count balance is the same closure
/// read as a Hermitian-pair multiset count.
///
/// **Which count balance.** QLF's keystone `count_balanced_pauli_closed`
/// (lean/QLF_TwistAlphabet.lean) proves count balance entails Pauli closure
/// for every history, cross-axis interleavings included — but its hypothesis
/// is *pairwise* balance, `#^=#v ∧ #>=#< ∧ #/=#\ ∧ #+=#-`, the vanishing of
/// the signed action vector. `isCountBalanced` below is the weaker aggregate
/// `count_pos == count_neg`, and the keystone does **not** hold for it:
/// 61,440 histories of length 6 are aggregate-balanced and not Pauli-closed
/// (`crates/zfa-core/tests/census_conformance.rs` counts them). `^<` is the
/// two-twist case — one positive, one negative, folding to −iσ_z.
///
/// So the conjunction below is not redundant, it is load-bearing, and it is
/// still weaker than QLF's ZFA: `^^<<` folds to +I with two positives and
/// two negatives, so `achievesZfa` accepts it, while its signed action
/// vector is (2,−2,0,0), so `is_zfa` in twist_core.py rejects it. Use
/// [`achievesZfaPairwise`] where QLF's predicate is meant. `achievesZfa` is
/// kept as-is because it is what deployed capability tokens validate against.
///
/// The converse genuinely fails in both readings: `^^` folds to σ_y² = I,
/// which is Pauli closed, while its counts are (2,0,0,0).
///
/// The 8-twist alphabet is the SU(2) generator set up to sign (≅ unit
/// quaternions; see HALF-SPIN-ZFA-EMBEDDING.md §6).
///
/// Mirrors the QLF Python core (`twist_core.py`) and the Rust crate
/// (`crates/zfa-core/src/pauli.rs`).

interface ZfaWasm {
  wasm_achieves_zfa(bytes: Uint8Array): boolean;
  wasm_achieves_zfa_pairwise(bytes: Uint8Array): boolean;
  wasm_is_pairwise_balanced(bytes: Uint8Array): boolean;
  wasm_is_pauli_closed(bytes: Uint8Array): boolean;
  wasm_coupling(parts: string): string;
  wasm_spectral_gap(bytes: Uint8Array): number;
  wasm_div_b(bytes: Uint8Array): number;
  wasm_charge(bytes: Uint8Array): number;
  wasm_capability_from_entropy(bytes: Uint8Array, label: string): string;
  wasm_capability_valid(hex: string): boolean;
}

let _wasm: ZfaWasm | null = null;

export async function loadZfa(bytes?:Uint8Array,required=false): Promise<void> {
  try {
    // wasm-pack output lands in @quantum-os/zfa-core
    const mod = await import("@quantum-os/zfa-core");
    await (mod as any).default?.(bytes?{module_or_path:bytes}:undefined);   // explicit bytes in Node, URL in browser
    _wasm = mod as unknown as ZfaWasm;
  } catch {
    if(required)throw Error("required ZFA WASM initialization failed");
    console.warn("[zfa] WASM unavailable, using pure-TS fallback");
  }
}

// ---- Twist encoding (must match crates/zfa-core/src/twist.rs) ----
const enum T {
  Up = 0, Down = 1, Right = 2, Left = 3,
  Slash = 4, BSlash = 5, Plus = 6, Minus = 7,
}
const POS = new Set([T.Up, T.Right, T.Slash, T.Plus]);

function countPos(bytes: Uint8Array): number {
  let n = 0;
  for (const b of bytes) if (POS.has(b as T)) n++;
  return n;
}

function isCountBalanced(twists: Uint8Array): boolean {
  const pos = countPos(twists);
  return pos === twists.length - pos;
}

/// The signed action vector `(#^-#v, #>-#<, #/-#\, #+-#-)`. ZFA is *Zero Free
/// Action* — this vector vanishing. Mirrors `calculate_action` in twist_core.py
/// and `signed_action` in history.rs, component order included.
export function signedAction(twists: Uint8Array): [number, number, number, number] {
  const n = (t: T) => { let c = 0; for (const b of twists) if (b === t) c++; return c; };
  return [
    n(T.Up) - n(T.Down),
    n(T.Right) - n(T.Left),
    n(T.Slash) - n(T.BSlash),
    n(T.Plus) - n(T.Minus),
  ];
}

/// QLF's count balance: every conjugate pair balances on its own. This is the
/// keystone's hypothesis; the aggregate `isCountBalanced` is not.
export function isPairwiseBalanced(twists: Uint8Array): boolean {
  if (_wasm) return _wasm.wasm_is_pairwise_balanced(twists);
  return signedAction(twists).every(c => c === 0);
}

// ---- Pauli matrix algebra (pure TS, mirrors pauli.rs / twist_core.py) ----

// A complex number as [re, im].
type C = [number, number];
const PAULI_TOL = 1e-9;

const ZC: C = [0, 0];
const OC: C = [1, 0];
const NOC: C = [-1, 0];
const IC: C = [0, 1];
const NIC: C = [0, -1];

function cMul(a: C, b: C): C {
  return [a[0] * b[0] - a[1] * b[1], a[0] * b[1] + a[1] * b[0]];
}
function cAdd(a: C, b: C): C { return [a[0] + b[0], a[1] + b[1]]; }
function cApproxEq(a: C, b: C): boolean {
  return Math.abs(a[0] - b[0]) < PAULI_TOL && Math.abs(a[1] - b[1]) < PAULI_TOL;
}

// A 2x2 complex matrix [[a, b], [c, d]].
type M2 = [C, C, C, C];
const IDENTITY_M: M2 = [OC, ZC, ZC, OC];

function mMul(m: M2, n: M2): M2 {
  return [
    cAdd(cMul(m[0], n[0]), cMul(m[1], n[2])),
    cAdd(cMul(m[0], n[1]), cMul(m[1], n[3])),
    cAdd(cMul(m[2], n[0]), cMul(m[3], n[2])),
    cAdd(cMul(m[2], n[1]), cMul(m[3], n[3])),
  ];
}

// Twist → Pauli matrix per Maxwell.md axis assignments.
function twistMatrix(t: T): M2 {
  switch (t) {
    case T.Up:     return [ZC, NIC, IC, ZC];        // +σ_y
    case T.Down:   return [ZC, IC, NIC, ZC];        // -σ_y
    case T.Right:  return [ZC, OC, OC, ZC];         // +σ_x
    case T.Left:   return [ZC, NOC, NOC, ZC];       // -σ_x
    case T.Slash:  return [OC, ZC, ZC, NOC];        // +σ_z
    case T.BSlash: return [NOC, ZC, ZC, OC];        // -σ_z
    case T.Plus:   return IDENTITY_M;               // +I
    case T.Minus:  return [NOC, ZC, ZC, NOC];       // -I
  }
}

function pauliFold(twists: Uint8Array): M2 {
  let m = IDENTITY_M;
  for (const t of twists) m = mMul(m, twistMatrix(t as T));
  return m;
}

const TWIST_SYMBOL: Record<string, number> = {
  "^": 0, v: 1, ">": 2, "<": 3, "/": 4, "\\": 5, "+": 6, "-": 7,
};

/// Parse a twist sequence from hex digits (`0167`), symbols (`^v`), or a
/// `cap:label:hex` token. Mirrors `parseTwists` in scripts/qos-cli/zfa.mjs.
export function parseTwists(str: string): Uint8Array | null {
  if (typeof str !== "string" || str.length === 0) return null;
  let s = str;
  if (s.startsWith("cap:")) {
    const parts = s.split(":");
    if (parts.length < 3) return null;
    s = parts[2];
  }
  if (/^[0-7]+$/.test(s)) return Uint8Array.from([...s].map((c) => parseInt(c, 10)));
  const out: number[] = [];
  for (const ch of s) {
    if (!(ch in TWIST_SYMBOL)) return null;
    out.push(TWIST_SYMBOL[ch]);
  }
  return Uint8Array.from(out);
}

export function isPauliClosed(twists: Uint8Array): boolean {
  if (_wasm) return _wasm.wasm_is_pauli_closed(twists);
  const [a, b, c, d] = pauliFold(twists);
  if (!cApproxEq(b, ZC) || !cApproxEq(c, ZC)) return false;
  if (!cApproxEq(a, d)) return false;
  return [OC, NOC, IC, NIC].some(s => cApproxEq(a, s));
}

/// The Pauli group scalar a history folds to — `"+1"|"-1"|"+i"|"-i"` when it is
/// closed, `null` otherwise. Mirrors `_classify_phase` in qucalc_search.py and
/// `QLF_PhaseRule`. Always pure-TS (the enumerator in `qucalc-enum.ts` calls it
/// on a hot path where the WASM boundary would cost more than the fold).
export type PauliScalar = "+1" | "-1" | "+i" | "-i";
export function pauliScalarOf(twists: Uint8Array): PauliScalar | null {
  const [a, b, c, d] = pauliFold(twists);
  if (!cApproxEq(b, ZC) || !cApproxEq(c, ZC) || !cApproxEq(a, d)) return null;
  if (cApproxEq(a, OC)) return "+1";
  if (cApproxEq(a, NOC)) return "-1";
  if (cApproxEq(a, IC)) return "+i";
  if (cApproxEq(a, NIC)) return "-i";
  return null;
}

// ---- Public API ----

export function achievesZfa(twists: Uint8Array): boolean {
  if (_wasm) return _wasm.wasm_achieves_zfa(twists);
  return isCountBalanced(twists) && isPauliClosed(twists);
}

/// QLF's ZFA exactly: pairwise count balance and Pauli closure. Strictly
/// narrower than [`achievesZfa`] — see the note at the top of this file.
export function achievesZfaPairwise(twists: Uint8Array): boolean {
  if (_wasm) return _wasm.wasm_achieves_zfa_pairwise(twists);
  return isPairwiseBalanced(twists) && isPauliClosed(twists);
}

// ---- Coupling: how a room's parts relate to the closure they form ----

export type Coupling = "open" | "independent" | "product" | "coupled";

export interface CouplingReading {
  verdict: Coupling;
  /// True for `product` and `coupled` — the join is one event, not several.
  shared: boolean;
  /// Indices of the parts that neither close nor fold to a scalar alone.
  open: number[];
  /// The census fraction of shared closures that are coupled, for comparison.
  baseline: number;
}

/// The census baseline (`factors` at length 8): of all shared closures cut
/// from a balanced history, this fraction is coupled rather than product.
/// Nearly flat in length — 0.750, 0.791, 0.804, 0.803 at lengths 2, 4, 6, 8.
export const COUPLED_BASELINE = 0.802893;

/// True iff the Pauli fold is a scalar, decided by axis parity instead of by
/// multiplying matrices: the fold is `phase • axisMatrix(axisProd)`, so it is
/// scalar exactly when the X, Y and Z multiplicities share a parity.
export function foldsToScalar(twists: Uint8Array): boolean {
  let x = 0, y = 0, z = 0;
  for (const b of twists) {
    if (b === T.Right || b === T.Left) x++;
    else if (b === T.Up || b === T.Down) y++;
    else if (b === T.Slash || b === T.BSlash) z++;
  }
  return (x % 2) === (y % 2) && (y % 2) === (z % 2);
}

/// Classify a room's joint closure by how its per-peer factors relate to it.
/// `parts` are the peers' histories, in the order the room composed them.
export function classifyCoupling(parts: Uint8Array[]): CouplingReading {
  if (_wasm) {
    const encoded = parts.map(p => [...p].join("")).join("|");
    return JSON.parse(_wasm.wasm_coupling(encoded)) as CouplingReading;
  }
  const joint = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { joint.set(p, at); at += p.length; }

  const open = parts
    .map((p, i) => (!isPairwiseBalanced(p) && !foldsToScalar(p) ? i : -1))
    .filter(i => i >= 0);

  let verdict: Coupling;
  if (!achievesZfaPairwise(joint)) verdict = "open";
  else if (parts.every(isPairwiseBalanced)) verdict = "independent";
  else if (parts.every(foldsToScalar)) verdict = "product";
  else verdict = "coupled";

  return {
    verdict,
    shared: verdict === "product" || verdict === "coupled",
    open,
    baseline: COUPLED_BASELINE,
  };
}

export function spectralGap(twists: Uint8Array): number {
  if (_wasm) return _wasm.wasm_spectral_gap(twists);
  const pos = countPos(twists);
  return Math.abs(pos - (twists.length - pos));
}

/// Generate a ZFA-balanced capability token using browser entropy.
/// Uses rejection sampling so the result is also Pauli-closed (~25% of random
/// count-balanced sequences pass; expected ~4 iterations).
export function generateCapability(label: string): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  if (_wasm) return _wasm.wasm_capability_from_entropy(bytes, label);

  // First attempt: use the caller's entropy directly.
  let twists = bytesToTwists(bytes);
  if (isPauliClosed(twists)) {
    return formatCap(label, twists);
  }
  // Rejection sampling with fresh entropy mixed in per iteration. (A counter-
  // derived salt can leave fixed byte positions and fail to converge for
  // 16-byte inputs; independent samples guarantee the ~25% pass rate.)
  const mixed = new Uint8Array(bytes.length);
  const extra = new Uint8Array(bytes.length);
  for (let attempt = 0; attempt < 1_000_000; attempt++) {
    crypto.getRandomValues(extra);
    for (let i = 0; i < bytes.length; i++) mixed[i] = bytes[i] ^ extra[i];
    twists = bytesToTwists(mixed);
    if (isPauliClosed(twists)) {
      return formatCap(label, twists);
    }
  }
  throw new Error("Pauli closure rejection sampling exceeded budget");
}

function bytesToTwists(bytes: Uint8Array): Uint8Array {
  // Deterministic byte → twist pair: each byte yields [pos, neg] where
  // pos ∈ {0,2,4,6} (positive twists) and neg ∈ {1,3,5,7} (negative twists).
  const twists = new Uint8Array(bytes.length * 2);
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    twists[i * 2]     = ((b >> 4) & 0x3) * 2;   // → 0,2,4,6
    twists[i * 2 + 1] = ((b & 0x3) * 2) + 1;    // → 1,3,5,7
  }
  return twists;
}

function formatCap(label: string, twists: Uint8Array): string {
  let hex = "";
  for (const t of twists) hex += t.toString(16);
  return `cap:${label}:${hex}`;
}

export function validateCapability(token: string): boolean {
  if (_wasm) return _wasm.wasm_capability_valid(token);
  const parts = token.split(":");
  if (parts.length < 3 || parts[0] !== "cap") return false;
  // Each char encodes one twist value (0–7). Reject any char outside that range
  // rather than silently filtering, which would let malformed tokens pass.
  const hexStr = parts[2];
  if (hexStr.length === 0 || !/^[0-7]+$/.test(hexStr)) return false;
  const twistBytes = Uint8Array.from([...hexStr].map(c => parseInt(c, 10)));
  return achievesZfa(twistBytes);
}
