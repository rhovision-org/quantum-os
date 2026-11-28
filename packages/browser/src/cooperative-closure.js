// cooperative-closure.js — provenance, closure certificates and a cooperative
// listener: the Quantum-OS half of quantum-os#354 (QLF side:
// quantum-logical-framework#337).
//
// Design: ../../../docs/cooperative-closure.md. The short version:
//
// The target is synthesis. A question gets resolved that no participant, and no
// proper subset of them, could resolve. Consensus is not the target. Four
// closures are kept apart, because each can hold while the others fail:
//
//   social        participants agree
//   logical       stated obligations are met (a ZFA verdict, a shared /solve)
//   empirical     the claim survives independently specified observation
//   constructive  need → offer → commitment → fulfillment → acknowledgment
//
// Mass hysteria is social closure without empirical closure. So nothing here
// lets agreement, repetition or popularity stand in for an observation.
//
// What this file holds, each part pure and recomputable (CC9):
//
//   provenance graph   (QOS3, CC3)  origins of every contribution; relaying,
//                                   repeating or copying adds no origin
//   certificates       (QOS4–5)     what a verdict rests on, typed by warrant,
//                                   with a lifecycle state derived, not set
//   promotion policy   (QOS6)       circular corroboration and popularity are
//                                   refused, and objections stay on record
//   synthesis checks   (CC2/CC6)    which coalitions resolve a question, by the
//                                   fibre of what they hold, not their count
//   cooperative listener (QOS0–1)   persistent obligations, asynchronous
//                                   contributions, delayed relevance
//
// What it does NOT claim. QLF's CC4 bridge (an encoding of a cooperative history
// into a QLF history, fixed before any verdict) is open. Until it holds, a
// certificate here is QLF-inspired verification, never QLF-derived closure:
// `qlfDerived` is always false and `QLF_CC4_AVAILABLE` says why. A Boolean from
// an external verifier is recorded as an `external-verdict` warrant and cannot
// by itself make a certificate verified (kill condition: "a certificate restates
// an external verdict").
//
// Plain JS, no imports, so the browser and the Node agents load the same file.
//
//   node packages/browser/src/cooperative-closure.js --selftest

// ---------------------------------------------------------------- vocabulary

export const CLOSURE_KINDS = Object.freeze(["social", "logical", "empirical", "constructive"]);

/**
 * What a warrant is. A certificate must say which of these it rests on, because
 * they establish different things (an algebraic receipt is not a Lean proof, a
 * Lean proof is not an observation, and a commitment is not a fulfillment).
 */
export const WARRANT_KINDS = Object.freeze([
  "algebraic-receipt",     // a QLF/ZFA closure computed in the room (/zfa-check, /solve)
  "recomputable-check",    // any decidable checker anyone can rerun (CC9)
  "lean-proof",            // a named, pinned Lean theorem
  "empirical-observation", // an independently specified observation
  "social-commitment",     // a participant agreeing, endorsing or promising
  "constructive-step",     // one step of need → offer → commitment → fulfillment → acknowledgment
  "external-verdict",      // a Boolean some other verifier returned
]);

export const LIFECYCLE = Object.freeze([
  "open", "candidate", "formally-verified", "empirically-supported",
  "constructively-fulfilled", "rejected", "undetermined", "superseded",
]);

export const CONSTRUCTIVE_STEPS = Object.freeze(["need", "offer", "commitment", "fulfillment", "acknowledgment"]);

/** The QLF CC4 bridge is open; nothing here may be labelled QLF-derived. */
export const QLF_CC4_AVAILABLE = false;

// ---------------------------------------------------------------- canonical form

/** Canonical JSON: sorted keys, no undefined. Two peers get the same string. */
export function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
}

/**
 * A short content id (FNV-1a, 64-bit). It identifies content so two peers name
 * the same certificate the same way; it is NOT a security digest. Authorship
 * and tamper resistance come from the dyncap signature on the envelope that
 * carries a certificate, not from this.
 */
export function contentId(value) {
  const s = canonical(value);
  let h = 0xcbf29ce484222325n;
  for (let i = 0; i < s.length; i++) {
    h ^= BigInt(s.charCodeAt(i));
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return h.toString(16).padStart(16, "0");
}

// ---------------------------------------------------------------- provenance (QOS3, CC3)

const NODE_KINDS = new Set(["observation", "assertion", "relay", "derivation"]);

/**
 * An append-only provenance graph. Every contribution names the origin it comes
 * from and the earlier contributions it cites, and only already-present ids can
 * be cited — so the graph is acyclic by construction, and support cannot be
 * manufactured after the fact (a certificate binds the support it was sealed on).
 *
 * Node kinds:
 *   observation  the origin observed something (the only kind that can carry
 *                empirical support)
 *   assertion    the origin claims something without an observation
 *   relay        the origin passes on what it cites; it adds NO origin of its own
 *   derivation   the origin computed something from what it cites; its origins
 *                are the cited ones, plus itself as the deriver
 */
export class ProvenanceGraph {
  constructor() { this.nodes = new Map(); }

  add({ id, origin, kind, content = null, cites = [], at = 0 }) {
    if (!id || typeof id !== "string") return { ok: false, reason: "a contribution needs an id" };
    if (this.nodes.has(id)) return { ok: false, reason: `${id} is already recorded` };
    if (!origin || typeof origin !== "string") return { ok: false, reason: "a contribution needs an origin" };
    if (!NODE_KINDS.has(kind)) return { ok: false, reason: `unknown kind ${kind}` };
    for (const c of cites) if (!this.nodes.has(c)) return { ok: false, reason: `${id} cites ${c}, which is not recorded yet` };
    if ((kind === "relay" || kind === "derivation") && !cites.length) return { ok: false, reason: `a ${kind} must cite what it passes on` };
    this.nodes.set(id, Object.freeze({ id, origin, kind, content, cites: [...cites], at }));
    return { ok: true };
  }

  get(id) { return this.nodes.get(id) ?? null; }

  /** Every node reachable from `ids` through cites, `ids` included. */
  closure(ids) {
    const seen = new Set();
    const stack = [...ids];
    while (stack.length) {
      const id = stack.pop();
      if (seen.has(id) || !this.nodes.has(id)) continue;
      seen.add(id);
      stack.push(...this.nodes.get(id).cites);
    }
    return seen;
  }

  /**
   * The origins behind `ids` (CC3). A relay contributes only what it cites;
   * repeating, copying or replaying a contribution changes nothing.
   */
  originsOf(ids) {
    const out = new Set();
    for (const id of this.closure(ids)) {
      const n = this.nodes.get(id);
      if (n.kind !== "relay") out.add(n.origin);
    }
    return out;
  }

  /** The origins that actually observed something, behind `ids`. */
  observationOriginsOf(ids) {
    const out = new Set();
    for (const id of this.closure(ids)) {
      const n = this.nodes.get(id);
      if (n.kind === "observation") out.add(n.origin);
    }
    return out;
  }

  toJSON() { return [...this.nodes.values()]; }
  static fromJSON(list) {
    const g = new ProvenanceGraph();
    for (const n of list ?? []) {
      const r = g.add(n);
      if (!r.ok) throw new Error(`provenance: ${r.reason}`);
    }
    return g;
  }
}

// ---------------------------------------------------------------- certificates (QOS4–5)

/**
 * Seal a certificate. It binds the claim, the warrants (each typed and with an
 * outcome), and the support it was sealed on: the contribution ids and, from the
 * graph at seal time, their origins and observation origins. Its id is a
 * content id over all of that, so adding support later is a different
 * certificate, never an edit of this one.
 *
 * @param {{ claim: string, scope?: string, warrants: Array<{kind, outcome: "pass"|"fail", ref?: string, by?: string}>,
 *           support?: string[], sealedAt?: number }} spec
 * @param {ProvenanceGraph} graph
 */
export function sealCertificate(spec, graph) {
  const warrants = (spec.warrants ?? []).map((w) => ({
    kind: w.kind, outcome: w.outcome === "fail" ? "fail" : "pass",
    ...(w.ref ? { ref: String(w.ref) } : {}), ...(w.by ? { by: String(w.by) } : {}),
    ...(w.step ? { step: String(w.step) } : {}),
  }));
  for (const w of warrants) if (!WARRANT_KINDS.includes(w.kind)) throw new Error(`unknown warrant kind ${w.kind}`);
  const support = [...new Set(spec.support ?? [])].sort();
  for (const s of support) if (!graph?.get(s)) throw new Error(`support ${s} is not in the provenance graph`);
  const body = {
    v: "closure-cert/1",
    claim: String(spec.claim ?? ""),
    scope: String(spec.scope ?? ""),
    warrants,
    support,
    origins: [...(graph?.originsOf(support) ?? [])].sort(),
    observationOrigins: [...(graph?.observationOriginsOf(support) ?? [])].sort(),
    sealedAt: spec.sealedAt ?? 0,
  };
  return { id: contentId(body), ...body };
}

/** Recompute a certificate's id; false means someone changed it after sealing. */
export function certificateIntact(cert) {
  const { id, ...body } = cert;
  return id === contentId(body);
}

/**
 * The lifecycle state of a certificate, derived from what it rests on and what
 * has happened since. Never set by hand, so every peer computes the same state.
 *
 * @param {object} cert           a sealed certificate
 * @param {{ objections?: Array, supersededBy?: string, undetermined?: boolean,
 *           minObservationOrigins?: number }} ctx
 * @returns {{ state, states: string[], closures: string[], qlfDerived: false, notes: string[] }}
 */
export function deriveState(cert, ctx = {}) {
  const notes = [];
  const pass = (k) => cert.warrants.some((w) => w.kind === k && w.outcome === "pass");
  const fail = (k) => cert.warrants.some((w) => w.kind === k && w.outcome === "fail");
  const minObs = ctx.minObservationOrigins ?? 1;
  const states = new Set();
  const closures = new Set();

  if (pass("social-commitment")) closures.add("social");
  const formal = pass("algebraic-receipt") || pass("recomputable-check") || pass("lean-proof");
  if (formal) { closures.add("logical"); states.add("formally-verified"); }
  if (pass("external-verdict") && !formal) notes.push("an external verdict alone is recorded, not counted as verification");

  const observed = cert.observationOrigins.length;
  if (pass("empirical-observation")) {
    if (observed >= minObs) { closures.add("empirical"); states.add("empirically-supported"); }
    else notes.push(`empirical warrant without ${minObs} observing origin${minObs === 1 ? "" : "s"} in its provenance`);
  }

  const steps = new Set(cert.warrants.filter((w) => w.kind === "constructive-step" && w.outcome === "pass").map((w) => w.step));
  if (CONSTRUCTIVE_STEPS.every((s) => steps.has(s))) { closures.add("constructive"); states.add("constructively-fulfilled"); }

  if (closures.has("social") && !closures.has("empirical") && !formal)
    notes.push("social closure only: agreement is not evidence (CC0)");

  // Objections are never deleted. One that carries a failing observation or check
  // rejects; one without stays on record and marks the certificate contested.
  const objections = ctx.objections ?? [];
  const refuted = objections.some((o) => o.warrant && o.warrant.outcome === "fail" &&
    ["empirical-observation", "recomputable-check", "algebraic-receipt", "lean-proof"].includes(o.warrant.kind));
  const failed = fail("algebraic-receipt") || fail("recomputable-check") || fail("lean-proof") || fail("empirical-observation");
  if (objections.length && !refuted) notes.push(`${objections.length} objection${objections.length === 1 ? "" : "s"} on record`);

  let state;
  if (refuted || failed) state = "rejected";
  else if (ctx.supersededBy) state = "superseded";
  else if (states.has("constructively-fulfilled")) state = "constructively-fulfilled";
  else if (states.has("empirically-supported")) state = "empirically-supported";
  else if (states.has("formally-verified")) state = "formally-verified";
  else if (ctx.undetermined) state = "undetermined";      // CC8: not resolved within budget, not impossible
  else if (cert.warrants.length) state = "candidate";
  else state = "open";
  if (state === "undetermined") notes.push("undetermined within its budget, which does not mean impossible (CC8)");

  return { state, states: [...states], closures: [...closures], contested: objections.length > 0 && !refuted,
    qlfDerived: false, notes };
}

// ---------------------------------------------------------------- promotion policy (QOS6)

/**
 * Whether a certificate may be promoted into the room's durable knowledge (a
 * lemma, a decision of record). Refuses:
 *   - circular corroboration: the claim's own contribution in its support's
 *     ancestry, or support that is only relays of one origin
 *   - popularity: endorsements are social commitments and never count as
 *     origins; N endorsements of one source are one origin
 *   - a rejected or merely social certificate
 * Objections are not a reason to refuse by themselves (a minority may be wrong)
 * but they ride along with the promotion, so the record keeps them.
 */
export function promotionCheck(cert, graph, { claimNode = null, objections = [], requireEmpirical = false, minOrigins = 1 } = {}) {
  const reasons = [];
  if (!certificateIntact(cert)) reasons.push("the certificate was changed after sealing");
  const st = deriveState(cert, { objections });
  if (st.state === "rejected") reasons.push("the certificate is rejected");
  if (st.state === "candidate" || st.state === "open") reasons.push("nothing verifies it yet: agreement alone is not promoted");
  if (requireEmpirical && st.state !== "empirically-supported" && st.state !== "constructively-fulfilled")
    reasons.push("this promotion needs an empirical warrant with an observing origin");
  if (claimNode && graph.closure(cert.support).has(claimNode)) reasons.push("circular corroboration: the claim supports itself");
  const independent = new Set(cert.observationOrigins.length ? cert.observationOrigins : cert.origins);
  if (independent.size < minOrigins) reasons.push(`needs ${minOrigins} independent origin${minOrigins === 1 ? "" : "s"}, has ${independent.size}`);
  return { ok: reasons.length === 0, reasons, state: st.state, objections: objections.map((o) => ({ ...o })) };
}

// ---------------------------------------------------------------- synthesis (CC2/CC6)

/**
 * The answers a coalition cannot rule out: enumerate every assignment of the
 * variables nobody in the coalition holds, and collect f's values. One value
 * means the coalition resolves the question; two or more means it stays blind.
 *
 * @param {{ vars: string[], f: (assignment: Record<string, any>) => any, domain?: any[] }} question
 * @param {Record<string, Record<string, any>>} holdings  member → {var: value}
 * @param {string[]} coalition
 */
export function consistentAnswers(question, holdings, coalition) {
  const domain = question.domain ?? [0, 1];
  const known = {};
  for (const m of coalition) for (const [k, v] of Object.entries(holdings[m] ?? {})) if (question.vars.includes(k)) known[k] = v;
  const free = question.vars.filter((v) => !(v in known));
  const answers = new Set();
  const assign = { ...known };
  const walk = (i) => {
    if (answers.size > 1 && i > 0) return;
    if (i === free.length) { answers.add(canonical(question.f(assign))); return; }
    for (const d of domain) { assign[free[i]] = d; walk(i + 1); }
  };
  walk(0);
  return [...answers].map((a) => JSON.parse(a));
}

export function resolves(question, holdings, coalition) {
  return consistentAnswers(question, holdings, coalition).length === 1;
}

function* subsetsOf(list) {
  const n = list.length;
  for (let mask = 0; mask < (1 << n); mask++) yield list.filter((_, i) => mask & (1 << i));
}

/**
 * The minimal coalitions that resolve the question. Irreducible synthesis is the
 * case where the only one is everybody (parity: all n holders, no proper subset).
 */
export function minimalResolvingCoalitions(question, holdings, members = Object.keys(holdings)) {
  if (members.length > 16) throw new Error("minimalResolvingCoalitions enumerates subsets; keep it to 16 members");
  const resolving = [...subsetsOf(members)].filter((c) => resolves(question, holdings, c));
  return resolving.filter((c) => !resolving.some((d) => d.length < c.length && d.every((m) => c.includes(m))));
}

/** Parity of the named bits — the pre-registered irreducible-synthesis baseline. */
export function parityQuestion(vars) {
  return { vars: [...vars], f: (a) => vars.reduce((x, v) => x ^ (a[v] ? 1 : 0), 0) };
}

/**
 * The substrate witness (#354): n parties each holding `^`, one holding `v`×n.
 * `closes(history)` is the ZFA predicate, injected so this file stays import-free.
 * Returns whether the whole coalition closes and whether any nonempty proper
 * sub-coalition does (concatenated in member order).
 */
export function substrateWitness(n, closes) {
  const parts = [...Array(n).fill("^"), "v".repeat(n)];
  const members = parts.map((_, i) => i);
  let properCloses = false;
  for (const c of subsetsOf(members)) {
    if (!c.length || c.length === members.length) continue;
    if (closes(c.map((i) => parts[i]).join(""))) { properCloses = true; break; }
  }
  return { parts, jointCloses: closes(parts.join("")), properCloses };
}

// ---------------------------------------------------------------- cooperative listener (QOS0–1)

/**
 * A cooperative listener. It holds obligations open across time, takes
 * contributions whenever they arrive, and admits a contribution to an
 * obligation only when it is relevant there — which may be later than when it
 * arrived (delayed relevance).
 *
 * An obligation is a question over named variables. `needs(known)` says which
 * variables matter given what is already known, so a clue can make a variable
 * relevant that was not before. Contributions name an origin and carry values
 * for variables; the listener records each in the provenance graph.
 *
 * Rules, each from #354:
 *   - repetition never counts: the same origin saying the same thing twice is one
 *     contribution, and a relay of it adds no origin (CC3)
 *   - conflicting values for one variable are never settled by count. If exactly
 *     one value is backed by an observation and the others are only asserted,
 *     the observed one stands and the others stay on record as overruled;
 *     otherwise the obligation stays open with the conflict on record, so a
 *     majority cannot bury a minority's evidence (CC0, QOS6)
 *   - a locally consistent partial answer is not acceptance: an obligation is
 *     open until the checker resolves it, and nothing else closes it (CC1, as
 *     corrected on #354)
 *   - an obligation past its deadline is undetermined, never impossible (CC8)
 *   - the verdict is a recomputable check over recorded contributions (CC9)
 *
 * Serializable (`toJSON` / `fromJSON`), so obligations survive a restart.
 */
export class CooperativeListener {
  constructor({ questions = {} } = {}) {
    this.questions = questions;          // questionKind → (spec) => {vars, f, domain?}
    this.graph = new ProvenanceGraph();
    this.obligations = new Map();        // id → {id, kind, spec, openedAt, deadline, needs?}
    this.values = new Map();             // var → Map(value canonical → Set(contribution ids))
    this.held = [];                      // contribution ids no open obligation needs yet
    this.log = [];                       // events, oldest first
    this._seq = 0;
  }

  _question(ob) {
    const make = this.questions[ob.kind] ?? DEFAULT_QUESTIONS[ob.kind];
    if (!make) throw new Error(`no question kind ${ob.kind}`);
    return make(ob.spec);
  }

  _needs(ob, known) {
    const q = this._question(ob);
    if (typeof ob.spec?.needsWhen === "object" && ob.spec.needsWhen) {
      // {var: {ifVar, equals}} — `var` matters only once ifVar is known to equal `equals`
      return q.vars.filter((v) => {
        const cond = ob.spec.needsWhen[v];
        return !cond || (cond.ifVar in known && known[cond.ifVar] === cond.equals);
      });
    }
    return q.vars;
  }

  open({ id, kind = "parity", spec, at = 0, deadline = null }) {
    if (this.obligations.has(id)) return { ok: false, reason: `obligation ${id} is already open` };
    const ob = { id, kind, spec, openedAt: at, deadline };
    this._question(ob);   // validates the kind
    this.obligations.set(id, ob);
    this.log.push({ at, type: "OPEN", obligation: id });
    this._readmit(at);
    return { ok: true };
  }

  /**
   * Record a contribution. `vars` are the values it states; `relayOf` makes it a
   * relay of an earlier contribution (it then states nothing new and adds no origin).
   */
  contribute({ id, origin, vars = {}, kind = "observation", relayOf = null, at = 0, text = null }) {
    id = id ?? `k${++this._seq}`;
    // Exact repetition by the same origin is one contribution.
    for (const n of this.graph.nodes.values()) {
      if (n.origin === origin && n.kind === kind && canonical(n.content?.vars ?? {}) === canonical(vars) && !relayOf) {
        this.log.push({ at, type: "REPEAT", contribution: n.id, origin });
        return { ok: true, id: n.id, repeat: true };
      }
    }
    const cites = relayOf ? [relayOf] : [];
    const r = this.graph.add({ id, origin, kind: relayOf ? "relay" : kind, content: { vars: relayOf ? {} : vars, text }, cites, at });
    if (!r.ok) return r;
    if (!relayOf) for (const [k, v] of Object.entries(vars)) {
      const byVal = this.values.get(k) ?? new Map();
      const key = canonical(v);
      (byVal.get(key) ?? byVal.set(key, new Set()).get(key)).add(id);
      this.values.set(k, byVal);
    }
    this.log.push({ at, type: relayOf ? "RELAY" : "CONTRIBUTE", contribution: id, origin });
    if (!relayOf && !this._relevantAnywhere(vars)) { this.held.push(id); this.log.push({ at, type: "HOLD", contribution: id }); }
    else if (!relayOf) this.log.push({ at, type: "ADMIT", contribution: id });
    this._readmit(at);
    return { ok: true, id };
  }

  /**
   * The settled value of a variable, or undefined. One value is settled. Two or
   * more are settled only when exactly one of them is backed by an observation
   * and the rest are unobserved assertions: evidence outranks popularity, however
   * many assert the other (CC0). Anything else is a conflict and stays open.
   */
  _settle(k) {
    const byVal = this.values.get(k);
    if (!byVal || !byVal.size) return { state: "unknown" };
    if (byVal.size === 1) return { state: "known", value: JSON.parse([...byVal.keys()][0]) };
    const observed = [...byVal.entries()].filter(([, ids]) => [...ids].some((id) => this.graph.get(id)?.kind === "observation"));
    if (observed.length === 1) {
      const overruled = [...byVal.entries()].filter(([v]) => v !== observed[0][0])
        .map(([v, ids]) => ({ value: JSON.parse(v), origins: [...this.graph.originsOf([...ids])].sort() }));
      return { state: "known", value: JSON.parse(observed[0][0]), overruled };
    }
    return { state: "conflict" };
  }

  _known() {
    const known = {};
    for (const k of this.values.keys()) { const s = this._settle(k); if (s.state === "known") known[k] = s.value; }
    return known;
  }

  _relevantAnywhere(vars) {
    const known = this._known();
    for (const ob of this.obligations.values()) {
      const needs = this._needs(ob, known);
      if (Object.keys(vars).some((k) => needs.includes(k))) return true;
    }
    return false;
  }

  _readmit(at) {
    const still = [];
    for (const id of this.held) {
      const vars = this.graph.get(id).content.vars;
      if (this._relevantAnywhere(vars)) this.log.push({ at, type: "ADMIT", contribution: id, delayed: true });
      else still.push(id);
    }
    this.held = still;
  }

  /** Where an obligation stands now. Pure over the recorded contributions. */
  status(id, now = 0) {
    const ob = this.obligations.get(id);
    if (!ob) return null;
    const q = this._question(ob);
    const known = this._known();
    const needs = this._needs(ob, known);
    const overruled = needs.map((v) => ({ var: v, ...this._settle(v) })).filter((x) => x.overruled?.length)
      .map((x) => ({ var: x.var, kept: x.value, overruled: x.overruled }));
    const conflicts = needs.filter((v) => this._settle(v).state === "conflict")
      .map((v) => ({ var: v, values: [...this.values.get(v).entries()].map(([val, ids]) => ({ value: JSON.parse(val), origins: [...this.graph.originsOf([...ids])].sort() })) }));
    const missing = needs.filter((v) => !(v in known) && !conflicts.some((c) => c.var === v));
    // Resolve over the needed variables only; an unneeded variable is fixed to its
    // first domain value so it cannot change the answer.
    let answers = null;
    if (!conflicts.length) {
      const holdings = { room: Object.fromEntries(Object.entries(known).filter(([k]) => needs.includes(k))) };
      const domain = q.domain ?? [0, 1];
      const fixed = Object.fromEntries(q.vars.filter((v) => !needs.includes(v)).map((v) => [v, domain[0]]));
      answers = consistentAnswers({ ...q, vars: needs, f: (a) => q.f({ ...fixed, ...a }) }, holdings, ["room"]);
    }
    const support = [];
    for (const v of needs) {
      const st = this._settle(v);
      for (const [val, ids] of (this.values.get(v) ?? new Map())) if (st.state !== "known" || canonical(st.value) === val) support.push(...ids);
    }
    const resolved = !!answers && answers.length === 1;
    const expired = !resolved && ob.deadline != null && now > ob.deadline;
    return {
      id, kind: ob.kind, needs, missing, conflicts, overruled,
      state: resolved ? "resolved" : expired ? "undetermined" : conflicts.length ? "conflicted" : "open",
      answer: resolved ? answers[0] : null,
      origins: [...this.graph.originsOf(support)].sort(),
      support: [...new Set(support)].sort(),
    };
  }

  /** A certificate for a resolved obligation: a recomputable check, nothing more. */
  certify(id, now = 0) {
    const s = this.status(id, now);
    if (!s || s.state !== "resolved") return null;
    return sealCertificate({
      claim: `${id} = ${canonical(s.answer)}`,
      scope: `obligation ${id} (${s.kind}) over ${s.needs.join(", ")}`,
      warrants: [{ kind: "recomputable-check", outcome: "pass", ref: `cooperative-listener/${s.kind}` }],
      support: s.support, sealedAt: now,
    }, this.graph);
  }

  toJSON() {
    return {
      v: "cooperative-listener/1",
      obligations: [...this.obligations.values()],
      contributions: this.graph.toJSON(),
      held: [...this.held], seq: this._seq,
    };
  }

  static fromJSON(data, opts = {}) {
    const l = new CooperativeListener(opts);
    for (const ob of data.obligations ?? []) l.obligations.set(ob.id, ob);
    for (const n of data.contributions ?? []) {
      const r = l.graph.add(n);
      if (!r.ok) throw new Error(`listener: ${r.reason}`);
      if (n.kind !== "relay") for (const [k, v] of Object.entries(n.content?.vars ?? {})) {
        const byVal = l.values.get(k) ?? new Map();
        const key = canonical(v);
        (byVal.get(key) ?? byVal.set(key, new Set()).get(key)).add(n.id);
        l.values.set(k, byVal);
      }
    }
    l.held = [...(data.held ?? [])];
    l._seq = data.seq ?? 0;
    return l;
  }
}

const DEFAULT_QUESTIONS = {
  parity: (spec) => parityQuestion(spec.vars),
  // all-of: true when every needed variable is 1 — a conjunction of complementary facts
  all: (spec) => ({ vars: [...spec.vars], f: (a) => spec.vars.every((v) => a[v] === 1) ? 1 : 0 }),
};

// ---------------------------------------------------------------- fixtures

/**
 * The shared fixtures: each QLF result #354 lists as proved, stated as a check
 * this module must pass. QLF proves them in Lean (QLF_CooperativeClosure,
 * QLF_AnalogicalListener); this is Quantum-OS running the same cases.
 */
export function runFixtures({ closes } = {}) {
  const results = [];
  const check = (name, ok, detail = "") => results.push({ name, ok: !!ok, detail });

  // CC0 — consensus fallacy: any number of participants accepting one origin's
  // false claim is one origin and no observation; with one observation it differs.
  {
    const g = new ProvenanceGraph();
    g.add({ id: "src", origin: "O", kind: "assertion", content: "x" });
    for (let i = 0; i < 50; i++) g.add({ id: `r${i}`, origin: `P${i}`, kind: "relay", cites: ["src"] });
    const support = ["src", ...Array.from({ length: 50 }, (_, i) => `r${i}`)];
    const cert = sealCertificate({ claim: "x", warrants: support.map((s) => ({ kind: "social-commitment", outcome: "pass", by: s })), support }, g);
    const st = deriveState(cert);
    check("CC0: 50 relays of one assertion are one origin", cert.origins.length === 1 && cert.observationOrigins.length === 0);
    check("CC0: consensus without observation stays a candidate", st.state === "candidate" && !st.closures.includes("empirical"));
    check("CC0: and is not promotable", !promotionCheck(cert, g).ok);
    g.add({ id: "obs", origin: "Q", kind: "observation", content: "x seen" });
    const withObs = sealCertificate({ claim: "x", warrants: [{ kind: "empirical-observation", outcome: "pass", ref: "obs" }], support: ["obs"] }, g);
    check("CC0: one observation in the record makes it empirically supported", deriveState(withObs).state === "empirically-supported");
  }

  // CC3 — provenance conservation: repetition, duplication, replay and copying
  // change neither the origins nor the observational support.
  {
    const g = new ProvenanceGraph();
    g.add({ id: "a", origin: "A", kind: "observation" });
    const before = [...g.originsOf(["a"])];
    g.add({ id: "a-copy", origin: "B", kind: "relay", cites: ["a"] });
    g.add({ id: "a-copy2", origin: "C", kind: "relay", cites: ["a-copy"] });
    check("CC3: relaying adds no origin", canonical([...g.originsOf(["a", "a-copy", "a-copy2"])]) === canonical(before));
    check("CC3: relaying adds no observation", g.observationOriginsOf(["a-copy2"]).size === 1);
    const l = new CooperativeListener();
    l.open({ id: "q", kind: "parity", spec: { vars: ["x"] } });
    l.contribute({ origin: "A", vars: { x: 1 } });
    const r = l.contribute({ origin: "A", vars: { x: 1 } });
    check("CC3: the same origin repeating itself is one contribution", r.repeat === true && l.status("q").origins.length === 1);
  }

  // Record forgetting (QLF#350, QLF_RecordForgetting.lean / QLF_SantaClosure.lean):
  // a record recovers a forgotten distinction iff it is not a function of the
  // record it is joined to. Copies and reports computed from one record add no
  // observational support (redundant_record_adds_nothing, reports_add_nothing);
  // an independently grounded observation adds one (independent_record_decides).
  {
    const g = new ProvenanceGraph();
    g.add({ id: "gift", origin: "Giver", kind: "observation", content: "gift given" });
    const reports = ["gift"];
    for (let i = 0; i < 1000; i++) {
      const id = `report${i}`;
      g.add({ id, origin: `R${i}`, kind: i % 2 ? "relay" : "derivation", cites: [reports[i]] });
      reports.push(id);
    }
    check("record forgetting: 1,000 copies and reports of one record add no observation",
      canonical([...g.observationOriginsOf(reports)]) === canonical(["Giver"]));
    g.add({ id: "receipt", origin: "Child", kind: "observation", content: "gift received" });
    check("record forgetting: an independently grounded observation adds one",
      g.observationOriginsOf([...reports, "receipt"]).size === 2);
  }

  // CC2/CC6 — irreducible synthesis: parity of n bits is resolved by all n
  // holders and by no proper subset; held variables matter, not member count.
  for (const n of [2, 3, 4, 5]) {
    const vars = Array.from({ length: n }, (_, i) => `x${i}`);
    const holdings = Object.fromEntries(vars.map((v, i) => [`m${i}`, { [v]: i % 2 }]));
    const minimal = minimalResolvingCoalitions(parityQuestion(vars), holdings);
    check(`CC2: parity of ${n} bits — only all ${n} holders resolve it`, minimal.length === 1 && minimal[0].length === n);
  }
  {
    const vars = ["x0", "x1", "x2"];
    const q = parityQuestion(vars);
    const holdings = { a: { x0: 1 }, b: { x0: 1 }, c: { x0: 1 }, d: { x0: 1 } };
    check("CC6: an echo chamber of four holding one variable resolves nothing one member can't",
      !resolves(q, holdings, ["a", "b", "c", "d"]) && consistentAnswers(q, holdings, ["a", "b", "c", "d"]).length === consistentAnswers(q, holdings, ["a"]).length);
    const withIdle = { a: { x0: 1 }, b: { x1: 0 }, c: { x2: 1 }, idle: { y: 1 } };
    const minimal = minimalResolvingCoalitions(q, withIdle);
    check("CC6: an irrelevant member adds nothing", minimal.length === 1 && !minimal[0].includes("idle"));
    const unheld = { a: { x0: 1 }, b: { x1: 0 } };
    check("CC6: a variable nobody holds means no coalition resolves it", minimalResolvingCoalitions(q, unheld).length === 0);
    check("CC6: every proper subset stays blind", ["a", "b"].every((m) => consistentAnswers(q, withIdle, [m]).length === 2));
  }

  // Substrate witness — n parties holding `^`, one holding `v`×n, close jointly;
  // no nonempty proper sub-coalition closes.
  if (closes) for (const n of [1, 2, 3, 4]) {
    const w = substrateWitness(n, closes);
    check(`witness n=${n}: the joint history closes`, w.jointCloses);
    check(`witness n=${n}: no proper sub-coalition closes`, !w.properCloses);
  }

  // CC1, as corrected on #354 — a locally consistent partial answer is not
  // acceptance; the obligation stays open until the check resolves it.
  {
    const l = new CooperativeListener();
    l.open({ id: "an", kind: "all", spec: { vars: ["sun-nucleus", "planet-electron"] } });
    l.contribute({ origin: "A", vars: { "sun-nucleus": 1 } });
    const s = l.status("an");
    check("CC1: a consistent partial analogy leaves the obligation open", s.state === "open" && s.missing.includes("planet-electron"));
    check("CC1: and yields no certificate", l.certify("an") === null);
  }

  // CC4 — open: nothing may be labelled QLF-derived.
  check("CC4: no certificate is QLF-derived while the bridge is open", QLF_CC4_AVAILABLE === false &&
    deriveState(sealCertificate({ claim: "z", warrants: [{ kind: "algebraic-receipt", outcome: "pass" }] }, new ProvenanceGraph())).qlfDerived === false);

  return results;
}

// ---------------------------------------------------------------- selftest

/** A small, self-contained ZFA predicate for the selftest (pairwise balance ∧ Pauli closure). */
export function zfaClosesForSelftest(history) {
  const axis = { "^": [0, 1], v: [0, -1], ">": [1, 1], "<": [1, -1], "/": [2, 1], "\\": [2, -1], "+": [3, 1], "-": [3, -1] };
  const action = [0, 0, 0, 0];
  for (const t of history) { const [a, s] = axis[t]; action[a] += s; }
  if (action.some((x) => x !== 0)) return false;
  // Pauli fold as (phase k: i^k, sign) × basis in {I, X, Y, Z}
  const basisOf = { "^": "Y", v: "Y", ">": "X", "<": "X", "/": "Z", "\\": "Z", "+": "I", "-": "I" };
  const sign = { "^": 1, v: -1, ">": 1, "<": -1, "/": 1, "\\": -1, "+": 1, "-": -1 };
  const mul = { II: [0, "I"], IX: [0, "X"], IY: [0, "Y"], IZ: [0, "Z"], XI: [0, "X"], YI: [0, "Y"], ZI: [0, "Z"],
    XX: [0, "I"], YY: [0, "I"], ZZ: [0, "I"], XY: [1, "Z"], YX: [3, "Z"], YZ: [1, "X"], ZY: [3, "X"], ZX: [1, "Y"], XZ: [3, "Y"] };
  let phase = 0, s = 1, b = "I";
  for (const t of history) { const [k, nb] = mul[b + basisOf[t]]; phase = (phase + k) % 4; s *= sign[t]; b = nb; }
  return b === "I";
}

export function selftest() {
  let fail = 0;
  const ok = (cond, msg) => { console.log(`${cond ? "PASS" : "FAIL"}  ${msg}`); if (!cond) fail++; };

  for (const r of runFixtures({ closes: zfaClosesForSelftest })) ok(r.ok, `fixture ${r.name}${r.detail ? ` — ${r.detail}` : ""}`);

  const census = (len) => { const T = "^v<>/\\+-"; let c = 0; for (let i = 0; i < 8 ** len; i++) { let h = "", x = i; for (let k = 0; k < len; k++) { h += T[x % 8]; x = Math.floor(x / 8); } if (zfaClosesForSelftest(h)) c++; } return c; };
  ok(census(2) === 8 && census(4) === 168, "selftest ZFA predicate reproduces QLF's census at lengths 2 and 4 (8, 168)");
  ok(zfaClosesForSelftest("^v") && !zfaClosesForSelftest("^^<<") && !zfaClosesForSelftest("^<"), "selftest ZFA predicate agrees with the known cases");

  // Provenance graph discipline
  const g = new ProvenanceGraph();
  ok(g.add({ id: "a", origin: "A", kind: "observation" }).ok, "graph: an observation is recorded");
  ok(!g.add({ id: "b", origin: "B", kind: "relay", cites: ["zzz"] }).ok, "graph: citing what isn't recorded is refused (no cycles, no back-filling)");
  ok(!g.add({ id: "c", origin: "C", kind: "relay" }).ok, "graph: a relay must cite something");
  ok(!g.add({ id: "a", origin: "A", kind: "observation" }).ok, "graph: an id is recorded once");
  const g2 = ProvenanceGraph.fromJSON(JSON.parse(JSON.stringify(g.toJSON())));
  ok(g2.originsOf(["a"]).has("A"), "graph: round-trips through JSON");

  // Certificates: sealing, tampering, warrant typing
  const cert = sealCertificate({ claim: "p", warrants: [{ kind: "lean-proof", outcome: "pass", ref: "QLF_CooperativeClosure.cc2" }], support: ["a"] }, g);
  ok(certificateIntact(cert), "cert: intact after sealing");
  ok(!certificateIntact({ ...cert, support: ["a", "b"] }), "cert: adding support after sealing is detected");
  ok(deriveState(cert).state === "empirically-supported" || deriveState(cert).state === "formally-verified", "cert: a Lean proof verifies formally");
  ok(deriveState(cert).state === "formally-verified", "cert: a Lean proof is not an empirical warrant");
  let threw = false; try { sealCertificate({ claim: "q", warrants: [{ kind: "vibes", outcome: "pass" }] }, g); } catch { threw = true; }
  ok(threw, "cert: an untyped warrant is refused");
  const ext = sealCertificate({ claim: "q", warrants: [{ kind: "external-verdict", outcome: "pass", ref: "some-verifier" }] }, g);
  ok(deriveState(ext).state === "candidate", "cert: an external verdict alone does not verify (kill condition)");
  const both = sealCertificate({ claim: "q", warrants: [{ kind: "lean-proof", outcome: "pass" }, { kind: "empirical-observation", outcome: "pass" }], support: ["a"] }, g);
  const bs = deriveState(both);
  ok(bs.state === "empirically-supported" && bs.closures.includes("logical") && bs.closures.includes("empirical"), "cert: logical and empirical closure are reported apart");
  ok(deriveState(both, { supersededBy: "x" }).state === "superseded", "cert: superseded");
  ok(deriveState(sealCertificate({ claim: "q", warrants: [{ kind: "social-commitment", outcome: "pass" }] }, g), { undetermined: true }).state === "undetermined", "cert: undetermined within budget (CC8)");
  ok(deriveState(sealCertificate({ claim: "q", warrants: [] }, g)).state === "open", "cert: nothing yet is open");
  const constructive = sealCertificate({ claim: "lunch", warrants: CONSTRUCTIVE_STEPS.map((step) => ({ kind: "constructive-step", outcome: "pass", step })) }, g);
  ok(deriveState(constructive).state === "constructively-fulfilled", "cert: need → … → acknowledgment is constructive closure");
  const promised = sealCertificate({ claim: "lunch", warrants: CONSTRUCTIVE_STEPS.slice(0, 3).map((step) => ({ kind: "constructive-step", outcome: "pass", step })) }, g);
  ok(deriveState(promised).state === "candidate", "cert: a commitment is not a fulfillment");

  // Objections: kept, minority evidence can reject
  const obj = [{ by: "M", text: "I measured otherwise", warrant: { kind: "empirical-observation", outcome: "fail" } }];
  ok(deriveState(both, { objections: obj }).state === "rejected", "objection: one failing observation rejects, whatever the majority says");
  const soft = [{ by: "M", text: "I doubt it" }];
  const ss = deriveState(both, { objections: soft });
  ok(ss.state === "empirically-supported" && ss.contested, "objection: without evidence it is kept on record and marks it contested");
  const pc = promotionCheck(both, g, { objections: soft });
  ok(pc.ok && pc.objections.length === 1, "promotion: an objection rides along with the promotion");

  // Promotion: circular corroboration
  const gc = new ProvenanceGraph();
  gc.add({ id: "claim", origin: "A", kind: "assertion" });
  gc.add({ id: "echo", origin: "B", kind: "derivation", cites: ["claim"] });
  const circ = sealCertificate({ claim: "claim", warrants: [{ kind: "recomputable-check", outcome: "pass" }], support: ["echo"] }, gc);
  ok(!promotionCheck(circ, gc, { claimNode: "claim" }).ok, "promotion: a claim supported by its own echo is refused");
  ok(!promotionCheck(circ, gc, { requireEmpirical: true }).ok, "promotion: empirical promotion needs an observation");

  // Listener: delayed relevance, conflicts, deadlines, persistence
  const l = new CooperativeListener();
  l.contribute({ origin: "C", vars: { x2: 1 }, at: 1 });
  ok(l.held.length === 1, "listener: a contribution nothing needs yet is held");
  l.open({ id: "p", kind: "parity", spec: { vars: ["x0", "x1", "x2"], needsWhen: { x2: { ifVar: "x0", equals: 1 } } }, at: 2 });
  ok(l.held.length === 1, "listener: still held — x2 only matters once x0 is 1");
  l.contribute({ origin: "A", vars: { x0: 1 }, at: 3 });
  ok(l.held.length === 0 && l.log.some((e) => e.type === "ADMIT" && e.delayed), "listener: a later clue admits the held contribution (delayed relevance)");
  ok(l.status("p").state === "open" && l.status("p").missing.join() === "x1", "listener: open until every needed variable is in");
  l.contribute({ origin: "B", vars: { x1: 0 }, at: 4 });
  const sp = l.status("p", 5);
  ok(sp.state === "resolved" && sp.answer === 0 && sp.origins.join() === "A,B,C", "listener: resolved jointly by three origins");
  const c = l.certify("p", 5);
  ok(c && deriveState(c).state === "formally-verified" && c.origins.length === 3, "listener: certifies as a recomputable check");
  const l2 = CooperativeListener.fromJSON(JSON.parse(JSON.stringify(l.toJSON())));
  ok(canonical(l2.status("p", 5)) === canonical(sp), "listener: obligations and contributions survive a restart");

  const lc = new CooperativeListener();
  lc.open({ id: "q", kind: "parity", spec: { vars: ["x", "y"] }, deadline: 10 });
  lc.contribute({ origin: "A", vars: { x: 1 } });
  lc.contribute({ origin: "B", vars: { x: 1 } });
  lc.contribute({ origin: "C", vars: { x: 1 } });
  lc.contribute({ origin: "M", vars: { x: 0 } });
  lc.contribute({ origin: "D", vars: { y: 1 } });
  const sq = lc.status("q", 5);
  ok(sq.state === "conflicted" && sq.conflicts[0].values.length === 2, "listener: three against one is a conflict, not a majority verdict");
  ok(lc.certify("q", 5) === null, "listener: a conflict yields no certificate");
  const lm = new CooperativeListener();
  lm.open({ id: "z", kind: "all", spec: { vars: ["z"] } });
  for (const o of ["A", "B", "C", "D"]) lm.contribute({ origin: o, kind: "assertion", vars: { z: 1 } });
  lm.contribute({ origin: "M", kind: "observation", vars: { z: 0 } });
  const sz = lm.status("z");
  ok(sz.state === "resolved" && sz.answer === 0 && sz.overruled[0].overruled[0].origins.length === 4,
    "listener: one observation outranks four unobserved assertions, which stay on record as overruled");
  ok(sz.origins.join() === "M", "listener: the verdict's support is the observation, not the crowd");
  const lr = new CooperativeListener();
  lr.open({ id: "q", kind: "parity", spec: { vars: ["x", "y"] }, deadline: 10 });
  const first = lr.contribute({ origin: "A", vars: { x: 1 } });
  lr.contribute({ origin: "B", relayOf: first.id });
  lr.contribute({ origin: "C", relayOf: first.id });
  ok(lr.status("q", 5).origins.join() === "A", "listener: relays of one origin are that one origin");
  ok(lr.status("q", 11).state === "undetermined", "listener: past its deadline an obligation is undetermined (CC8)");

  console.log(fail ? `\n${fail} failed` : "\nall passed");
  return fail;
}

if (typeof process !== "undefined" && process.argv?.[1]?.endsWith("cooperative-closure.js") && process.argv.includes("--selftest")) {
  process.exit(selftest() ? 1 : 0);
}
