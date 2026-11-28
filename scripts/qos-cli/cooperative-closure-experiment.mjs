// cooperative-closure-experiment.mjs — the #354 experiment: does distributed
// listening synthesize beyond the best individual, and catch false consensus?
//
// Pre-registration: ../../docs/cooperative-closure-experiment.md. It freezes the
// item bank (data/cooperative-closure-items.json, by SHA-256), the arms, the
// scoring and the decision rule. This harness refuses to score against a bank
// whose digest differs from the frozen one.
//
// Arms (separate from #322's five-arm listener-controller experiment):
//   A  the best individual: each participant alone, best per item (an oracle
//      choice, so a strong control)
//   B  multi-agent discussion: every statement pooled into one transcript, one
//      model answer
//   C  B plus a verifier: B's answer stands only if a provenance-blind checker
//      over the transcript (each line a fact, conflicts settled by count) agrees
//   D  distributed listening with the same checker: statements enter a
//      CooperativeListener in arrival order, with their origins, kinds and
//      relays; the model answers from the listener's state (each variable once,
//      who observed it, what was overruled or conflicts, what is missing), and
//      its answer stands only if the listener's verdict agrees
//   E  D with QLF-derived closure — UNAVAILABLE until QLF's CC4 bridge holds.
//      Reported as unavailable, never relabelled from an ordinary verifier.
//
// Contrasts: C−B, D−C, E−D (E−D unavailable).
//
//   node cooperative-closure-experiment.mjs --selftest           mock model, plumbing only
//   node cooperative-closure-experiment.mjs --mock               score every arm with the mock model
//   node cooperative-closure-experiment.mjs --ai claude-code     a real run (any ai-providers/ plugin)
//   node cooperative-closure-experiment.mjs --build-bank         regenerate the bank (changes its digest)
//
// The mock model is a deterministic reader that believes the majority of what it
// is told. Scores with it test the harness, not the hypothesis: it is built to
// fall for repetition, so its numbers say nothing about a real model.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { CooperativeListener, parityQuestion, consistentAnswers, canonical, QLF_CC4_AVAILABLE } from "../../packages/browser/src/cooperative-closure.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const BANK_PATH = path.join(HERE, "data", "cooperative-closure-items.json");
/** The frozen bank's SHA-256. Changing the bank means changing this, in the open, before any run. */
export const FROZEN_BANK_SHA256 = "e81cfbc7aa48d8490d66b3c0e347054f3bd1b69bd7fea95e0b38390f9ba34176";

export const CLASSES = Object.freeze([
  "complementary", "delayed-relevance", "false-analogy", "common-source",
  "majority-vs-minority", "parity", "constructive", "no-holder",
]);

// ---------------------------------------------------------------- the bank

function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

const NAMES = ["Ada", "Ben", "Cai", "Dee", "Eli", "Fay", "Gus"];

/** Build the item bank deterministically from a fixed seed. */
export function buildBank(seed = 354, perClass = 6) {
  const r = rng(seed);
  const bit = () => (r() < 0.5 ? 0 : 1);
  const items = [];
  const push = (cls, i, body) => items.push({ id: `${cls}-${i + 1}`, class: cls, ...body });
  for (let i = 0; i < perClass; i++) {
    // complementary: an "all" question over k facts, each held by a different person
    { const k = 2 + (i % 3); const vars = Array.from({ length: k }, (_, j) => `f${j}`);
      const world = Object.fromEntries(vars.map((v) => [v, i % 2 === 0 ? 1 : bit()]));
      push("complementary", i, { question: { kind: "all", vars }, world,
        participants: vars.map((v, j) => ({ name: NAMES[j], statements: [{ kind: "observation", vars: { [v]: world[v] }, at: j }] })) }); }
    // delayed relevance: x2 matters only once x0 = 1, and is said before the clue
    { const world = { x0: 1, x1: bit(), x2: bit() };
      push("delayed-relevance", i, { question: { kind: "parity", vars: ["x0", "x1", "x2"], needsWhen: { x2: { ifVar: "x0", equals: 1 } } }, world,
        participants: [
          { name: NAMES[2], statements: [{ kind: "observation", vars: { x2: world.x2 }, at: 0 }] },
          { name: NAMES[1], statements: [{ kind: "observation", vars: { x1: world.x1 }, at: 1 }] },
          { name: NAMES[0], statements: [{ kind: "observation", vars: { x0: 1 }, at: 2 }] },
        ] }); }
    // false analogy: a consistent partial mapping, the last relation observed false
    { const k = 3; const vars = Array.from({ length: k }, (_, j) => `m${j}`);
      const world = Object.fromEntries(vars.map((v, j) => [v, j === k - 1 ? 0 : 1]));
      push("false-analogy", i, { question: { kind: "all", vars }, world,
        participants: [
          ...vars.slice(0, k - 1).map((v, j) => ({ name: NAMES[j], statements: [{ kind: "observation", vars: { [v]: 1 }, at: j }] })),
          { name: NAMES[k - 1], statements: [{ kind: "assertion", vars: { [vars[k - 1]]: 1 }, at: k - 1 }] },
          { name: NAMES[k], statements: [{ kind: "observation", vars: { [vars[k - 1]]: 0 }, at: k + i }] },
        ] }); }
    // common source: one false assertion relayed by several, one independent observation
    { const truth = bit(); const relays = 2 + (i % 3);
      push("common-source", i, { question: { kind: "parity", vars: ["x", "y"] }, world: { x: truth, y: 0 },
        participants: [
          { name: NAMES[0], statements: [{ kind: "assertion", vars: { x: 1 - truth }, at: 0 }] },
          ...Array.from({ length: relays }, (_, j) => ({ name: NAMES[1 + j], statements: [{ kind: "relay", relayOf: NAMES[0], at: 1 + j }] })),
          { name: NAMES[1 + relays], statements: [{ kind: "observation", vars: { x: truth }, at: 1 + relays }] },
          { name: NAMES[2 + relays], statements: [{ kind: "observation", vars: { y: 0 }, at: 2 + relays }] },
        ] }); }
    // majority vs minority: several independent unobserved assertions against one observation
    { const truth = bit(); const majority = 3 + (i % 2);
      push("majority-vs-minority", i, { question: { kind: "all", vars: ["z"] }, world: { z: truth },
        participants: [
          ...Array.from({ length: majority }, (_, j) => ({ name: NAMES[j], statements: [{ kind: "assertion", vars: { z: 1 - truth }, at: j }] })),
          { name: NAMES[majority], statements: [{ kind: "observation", vars: { z: truth }, at: majority }] },
        ] }); }
    // parity: n holders, the irreducible baseline
    { const n = 2 + (i % 4); const vars = Array.from({ length: n }, (_, j) => `x${j}`);
      const world = Object.fromEntries(vars.map((v) => [v, bit()]));
      push("parity", i, { question: { kind: "parity", vars }, world,
        participants: vars.map((v, j) => ({ name: NAMES[j], statements: [{ kind: "observation", vars: { [v]: world[v] }, at: j }] })) }); }
    // constructive: need → offer → commitment → fulfillment → acknowledgment; is it fulfilled?
    { const steps = ["need", "offer", "commitment", "fulfillment", "acknowledgment"];
      const done = i % 2 === 0;
      const world = Object.fromEntries(steps.map((s) => [s, done || (s !== "fulfillment" && s !== "acknowledgment") ? 1 : 0]));
      push("constructive", i, { question: { kind: "all", vars: steps }, world,
        participants: [
          { name: NAMES[0], statements: [{ kind: "observation", vars: { need: 1 }, at: 0 }, { kind: "observation", vars: { acknowledgment: world.acknowledgment }, at: 4 }] },
          { name: NAMES[1], statements: [{ kind: "observation", vars: { offer: 1 }, at: 1 }, { kind: "assertion", vars: { commitment: 1 }, at: 2 }, { kind: "observation", vars: { fulfillment: world.fulfillment }, at: 3 }] },
          { name: NAMES[2], statements: [{ kind: "observation", vars: { commitment: 1 }, at: 2 }] },
        ] }); }
    // no holder: parity with one variable nobody holds
    { const n = 2 + (i % 3); const vars = Array.from({ length: n + 1 }, (_, j) => `x${j}`);
      const world = Object.fromEntries(vars.map((v) => [v, bit()]));
      push("no-holder", i, { question: { kind: "parity", vars }, world, unresolvable: true,
        participants: vars.slice(0, n).map((v, j) => ({ name: NAMES[j], statements: [{ kind: "observation", vars: { [v]: world[v] }, at: j }] })) }); }
  }
  for (const it of items) it.truth = it.unresolvable ? "UNRESOLVABLE" : truthOf(it);
  return { v: "cooperative-closure-bank/1", seed, perClass, items };
}

function questionOf(q) {
  if (q.kind === "parity") return parityQuestion(q.vars);
  return { vars: q.vars, f: (a) => q.vars.every((v) => a[v] === 1) ? 1 : 0 };
}

function neededVars(q, world) {
  return q.vars.filter((v) => { const c = q.needsWhen?.[v]; return !c || world[c.ifVar] === c.equals; });
}

function truthOf(item) {
  const q = questionOf(item.question);
  const needs = neededVars(item.question, item.world);
  const a = Object.fromEntries(q.vars.map((v) => [v, needs.includes(v) ? item.world[v] : 0]));
  return q.f(a);
}

export function bankDigest(bank) {
  return crypto.createHash("sha256").update(canonical(bank)).digest("hex");
}

// ---------------------------------------------------------------- statements as text

/** The flat transcript a discussion sees: one line per statement, arrival order. */
export function transcriptOf(item) {
  const lines = [];
  const said = new Map();   // name → their first stated vars (for relays)
  const all = [];
  for (const p of item.participants) for (const s of p.statements) all.push({ who: p.name, ...s });
  all.sort((a, b) => a.at - b.at || a.who.localeCompare(b.who));
  for (const s of all) {
    if (s.kind === "relay") {
      const src = said.get(s.relayOf) ?? {};
      lines.push({ who: s.who, kind: "relay", vars: src, relayOf: s.relayOf, text: `${s.who}: I heard from ${s.relayOf} that ${fmt(src)}.` });
    } else {
      if (!said.has(s.who)) said.set(s.who, s.vars);
      lines.push({ who: s.who, kind: s.kind, vars: s.vars, text: `${s.who}: ${s.kind === "observation" ? "I checked:" : "I believe"} ${fmt(s.vars)}.` });
    }
  }
  return lines;
}
const fmt = (vars) => Object.entries(vars).map(([k, v]) => `${k} = ${v}`).join(", ") || "(nothing)";

function questionText(item) {
  const q = item.question;
  const what = q.kind === "parity" ? `the parity (XOR) of ${q.vars.join(", ")}` : `whether all of ${q.vars.join(", ")} are 1 (answer 1 or 0)`;
  const cond = q.needsWhen ? ` Only count ${Object.entries(q.needsWhen).map(([v, c]) => `${v} if ${c.ifVar} = ${c.equals}`).join("; ")}; otherwise treat it as 0.` : "";
  return `Question: ${what}.${cond} Reply with exactly one token: 0, 1, or ABSTAIN if what you know does not determine the answer.`;
}

// ---------------------------------------------------------------- checkers

/** C's verifier: provenance-blind. Every line is a fact; a conflict is settled by count. */
export function flatVerdict(item) {
  const counts = new Map();
  for (const l of transcriptOf(item)) for (const [k, v] of Object.entries(l.vars)) {
    const m = counts.get(k) ?? new Map(); m.set(v, (m.get(v) ?? 0) + 1); counts.set(k, m);
  }
  const known = {};
  for (const [k, m] of counts) { const top = [...m.entries()].sort((a, b) => b[1] - a[1]); if (top.length === 1 || top[0][1] > top[1][1]) known[k] = top[0][0]; }
  const q = questionOf(item.question);
  const needs = item.question.needsWhen ? q.vars.filter((v) => { const c = item.question.needsWhen[v]; return !c || known[c.ifVar] === c.equals; }) : q.vars;
  const fixed = Object.fromEntries(q.vars.filter((v) => !needs.includes(v)).map((v) => [v, 0]));
  const ans = consistentAnswers({ ...q, vars: needs, f: (a) => q.f({ ...fixed, ...a }) }, { room: known }, ["room"]);
  return ans.length === 1 ? ans[0] : "ABSTAIN";
}

/** D's verifier: the same checker, fed through a CooperativeListener with provenance. */
export function listenerVerdict(item) { return listenerState(item).verdict; }

/**
 * What distributed listening gives D's model instead of a flat transcript: the
 * listener's state — each needed variable once, with who observed or asserted
 * it, what was overruled and why, what conflicts and what is missing.
 */
export function listenerState(item) {
  const l = new CooperativeListener();
  l.open({ id: item.id, kind: item.question.kind === "parity" ? "parity" : "all", spec: { vars: item.question.vars, ...(item.question.needsWhen ? { needsWhen: item.question.needsWhen } : {}) }, at: -1 });
  const firstOf = new Map();
  for (const s of transcriptOf(item)) {
    if (s.kind === "relay") { const src = firstOf.get(s.relayOf); if (src) l.contribute({ origin: s.who, relayOf: src }); continue; }
    const r = l.contribute({ origin: s.who, kind: s.kind, vars: s.vars });
    if (r.ok && !firstOf.has(s.who)) firstOf.set(s.who, r.id);
  }
  const st = l.status(item.id);
  const known = l._known();
  const lines = [];
  for (const v of st.needs) {
    if (v in known) {
      const ids = [...(l.values.get(v)?.get(canonical(known[v])) ?? [])];
      const obs = [...l.graph.observationOriginsOf(ids)], said = [...l.graph.originsOf(ids)];
      lines.push(`Settled: ${v} = ${known[v]} (${obs.length ? `observed by ${obs.join(", ")}` : `asserted by ${said.join(", ")}, not observed`}).`);
    }
  }
  for (const o of st.overruled) for (const x of o.overruled)
    lines.push(`Overruled: the claim that ${o.var} is ${x.value} — only asserted (origins: ${x.origins.join(", ")}; relays add none), against an observation.`);
  for (const c of st.conflicts) lines.push(`Conflict on ${c.var}: ${c.values.map((x) => `${x.value} from ${x.origins.join(", ")}`).join(" vs ")}; unresolved.`);
  if (st.missing.length) lines.push(`Missing: nobody has stated ${st.missing.join(", ")}.`);
  const unneeded = item.question.vars.filter((v) => !st.needs.includes(v));
  if (unneeded.length) lines.push(`Not needed under the stated condition: ${unneeded.join(", ")} (treated as 0).`);
  return { verdict: st.state === "resolved" ? st.answer : "ABSTAIN", summary: lines.join("\n") };
}

// ---------------------------------------------------------------- models

/** The mock: believes the majority of what it is told, abstains only when it hears nothing. */
export const mockModel = {
  name: "mock-majority-reader",
  async complete({ prompt }) {
    const known = {};
    const counts = new Map();
    for (const m of prompt.matchAll(/\b([a-z]+\d*) = ([01])\b/g)) {
      const c = counts.get(m[1]) ?? [0, 0]; c[Number(m[2])]++; counts.set(m[1], c);
    }
    for (const [k, c] of counts) known[k] = c[1] >= c[0] ? 1 : 0;
    const vars = (prompt.match(/of ([a-z0-9, ]+?)(?: are 1|\.)/) ?? [])[1]?.split(/,\s*/) ?? [];
    if (!vars.length || vars.some((v) => !(v in known))) return { text: "ABSTAIN" };
    const parity = /parity/.test(prompt);
    return { text: String(parity ? vars.reduce((x, v) => x ^ known[v], 0) : (vars.every((v) => known[v] === 1) ? 1 : 0)) };
  },
};

function parseAnswer(text) {
  const t = String(text ?? "").trim().toUpperCase();
  if (/^ABSTAIN\b/.test(t)) return "ABSTAIN";
  const m = t.match(/^([01])\b/) ?? t.match(/\b([01])\b/);
  return m ? Number(m[1]) : "ABSTAIN";
}

const SYSTEM = "You answer one question from what participants in a room have said. Use only what is stated. If it does not determine the answer, reply ABSTAIN.";

async function ask(model, prompt, opts) {
  const out = await model.complete({ system: SYSTEM, prompt, maxTokens: 8, ...opts });
  if (out?.error) throw new Error(out.error);
  return parseAnswer(out?.text);
}

// ---------------------------------------------------------------- arms and scoring

export function score(item, answer) {
  if (item.truth === "UNRESOLVABLE") return answer === "ABSTAIN" ? { correct: 1, falseCommit: 0, abstain: 1 } : { correct: 0, falseCommit: 1, abstain: 0 };
  if (answer === "ABSTAIN") return { correct: 0, falseCommit: 0, abstain: 1 };
  return answer === item.truth ? { correct: 1, falseCommit: 0, abstain: 0 } : { correct: 0, falseCommit: 1, abstain: 0 };
}

export async function runItem(item, model, opts = {}) {
  const lines = transcriptOf(item);
  const qt = questionText(item);
  // A: each participant alone, best per item
  let bestA = null;
  for (const p of item.participants) {
    const own = lines.filter((l) => l.who === p.name).map((l) => l.text).join("\n");
    const a = await ask(model, `${own}\n\n${qt}`, opts);
    const s = score(item, a);
    if (!bestA || s.correct > bestA.s.correct || (s.correct === bestA.s.correct && s.falseCommit < bestA.s.falseCommit)) bestA = { a, s };
  }
  const b = await ask(model, `${lines.map((l) => l.text).join("\n")}\n\n${qt}`, opts);
  const c = flatVerdict(item) === b ? b : "ABSTAIN";
  const ls = listenerState(item);
  const dModel = await ask(model, `${ls.summary}\n\n${qt}`, opts);
  const d = ls.verdict === dModel ? dModel : "ABSTAIN";
  return { id: item.id, class: item.class, truth: item.truth, A: bestA.a, B: b, C: c, D: d, E: "UNAVAILABLE",
    scores: { A: bestA.s, B: score(item, b), C: score(item, c), D: score(item, d) } };
}

/** Paired bootstrap of the mean difference in `field` between two arms, fixed seed. */
export function pairedBootstrap(rows, x, y, field = "correct", reps = 4000, seed = 354) {
  const diffs = rows.map((r) => r.scores[x][field] - r.scores[y][field]);
  const mean = diffs.reduce((s, d) => s + d, 0) / diffs.length;
  const r = rng(seed); const boots = [];
  for (let i = 0; i < reps; i++) { let s = 0; for (let j = 0; j < diffs.length; j++) s += diffs[Math.floor(r() * diffs.length)]; boots.push(s / diffs.length); }
  boots.sort((a, b) => a - b);
  return { mean, lo: boots[Math.floor(reps * 0.025)], hi: boots[Math.floor(reps * 0.975)] };
}

/** The pre-registered decision rule (docs/cooperative-closure-experiment.md §5). */
export function decide(rows) {
  const arms = ["A", "B", "C", "D"];
  const totals = Object.fromEntries(arms.map((a) => [a, {
    correct: rows.reduce((s, r) => s + r.scores[a].correct, 0) / rows.length,
    falseCommit: rows.reduce((s, r) => s + r.scores[a].falseCommit, 0) / rows.length,
  }]));
  const contrasts = { "C−B": pairedBootstrap(rows, "C", "B"), "D−C": pairedBootstrap(rows, "D", "C"), "D−A": pairedBootstrap(rows, "D", "A"), "E−D": "unavailable (QLF CC4 bridge open)" };
  const syn = rows.filter((r) => ["parity", "complementary", "delayed-relevance"].includes(r.class));
  const fc = rows.filter((r) => ["common-source", "majority-vs-minority", "false-analogy"].includes(r.class));
  const dc = contrasts["D−C"];
  const support = dc.mean >= 0.05 && dc.lo > 0 && totals.D.falseCommit <= totals.C.falseCommit;
  return {
    totals, contrasts,
    synthesisBeyondBestIndividual: syn.length ? pairedBootstrap(syn, "D", "A") : null,
    catchesFalseConsensus: fc.length ? { D: fc.reduce((s, r) => s + r.scores.D.falseCommit, 0) / fc.length, B: fc.reduce((s, r) => s + r.scores.B.falseCommit, 0) / fc.length } : null,
    verdict: support ? "supports D over C at the pre-registered threshold" : "does not meet the pre-registered threshold",
    E: QLF_CC4_AVAILABLE ? "available" : "unavailable",
  };
}

export async function runAll(bank, model, opts = {}) {
  const rows = [];
  for (const item of bank.items) rows.push(await runItem(item, model, opts));
  const decision = decide(rows);
  // The mock believes the majority of what it reads, so it is fooled by a flat
  // transcript and not by the listener's summary by construction. Its numbers
  // test the harness; they are never a verdict.
  if (model === mockModel) decision.verdict = "not evaluated: mock model (plumbing only, not evidence)";
  return { rows, decision };
}

// ---------------------------------------------------------------- CLI

function loadBank() {
  const bank = JSON.parse(fs.readFileSync(BANK_PATH, "utf8"));
  const digest = bankDigest(bank);
  return { bank, digest, frozen: digest === FROZEN_BANK_SHA256 };
}

async function selftest() {
  let fail = 0;
  const ok = (c, m) => { console.log(`${c ? "PASS" : "FAIL"}  ${m}`); if (!c) fail++; };
  const bank = buildBank();
  ok(bank.items.length === CLASSES.length * 6 && CLASSES.every((c) => bank.items.some((i) => i.class === c)), "bank: every task class, six items each");
  ok(canonical(buildBank()) === canonical(bank), "bank: rebuilt identically from its seed");
  const onDisk = loadBank();
  ok(canonical(onDisk.bank) === canonical(bank), "bank: the committed file is what the seed builds");
  ok(onDisk.frozen, `bank: digest matches the frozen one (${onDisk.digest.slice(0, 12)}…)`);
  // The checkers on the traps they exist for
  const cs = bank.items.find((i) => i.class === "common-source");
  ok(flatVerdict(cs) !== cs.truth && listenerVerdict(cs) === cs.truth, "common source: counting lines is fooled, provenance is not");
  const mm = bank.items.find((i) => i.class === "majority-vs-minority");
  ok(flatVerdict(mm) !== mm.truth && listenerVerdict(mm) === mm.truth, "majority vs minority: the observation outranks the unobserved majority");
  const nh = bank.items.find((i) => i.class === "no-holder");
  ok(listenerVerdict(nh) === "ABSTAIN" && score(nh, 1).falseCommit === 1, "no holder: abstaining is correct, answering is a false commitment");
  const dr = bank.items.find((i) => i.class === "delayed-relevance");
  ok(listenerVerdict(dr) === dr.truth, "delayed relevance: the early statement counts once the clue arrives");
  const par = bank.items.find((i) => i.class === "parity" && i.question.vars.length === 3);
  ok(par.participants.every((p) => consistentAnswers(questionOf(par.question), { me: p.statements[0].vars }, ["me"]).length === 2), "parity: every individual is blind");
  // Plumbing with the mock
  const { rows, decision } = await runAll(bank, mockModel);
  ok(rows.length === bank.items.length && rows.every((r) => r.E === "UNAVAILABLE"), "run: every item scored, arm E reported unavailable");
  ok(decision.E === "unavailable" && typeof decision.contrasts["E−D"] === "string", "run: E−D is reported as unavailable, not computed");
  ok(Number.isFinite(decision.contrasts["D−C"].mean), "run: paired bootstrap computes");
  ok(/not evaluated/.test(decision.verdict), "run: a mock run never reports a verdict");
  console.log(fail ? `\n${fail} failed` : "\nall passed");
  return fail;
}

async function main(argv) {
  if (argv.includes("--selftest")) process.exit(await selftest() ? 1 : 0);
  if (argv.includes("--build-bank")) {
    const bank = buildBank();
    fs.mkdirSync(path.dirname(BANK_PATH), { recursive: true });
    fs.writeFileSync(BANK_PATH, JSON.stringify(bank, null, 1) + "\n");
    console.log(`wrote ${BANK_PATH}\nsha256 ${bankDigest(bank)}  (update FROZEN_BANK_SHA256 and the pre-registration)`);
    return;
  }
  const { bank, digest, frozen } = loadBank();
  if (!frozen) { console.error(`the item bank's digest ${digest} is not the frozen one; refusing to score`); process.exit(2); }
  let model = mockModel;
  const i = argv.indexOf("--ai");
  if (i >= 0) {
    const { loadProvider } = await import("./ai-providers/index.mjs");
    const prov = await loadProvider(argv[i + 1] ?? "claude-code");
    const why = prov.unavailable?.(process.env);
    if (why) { console.error(`--ai ${prov.name}: ${why}`); process.exit(2); }
    model = { name: prov.name, complete: (o) => prov.complete({ ...o, env: process.env, model: prov.defaultModel, timeoutMs: 60_000 }) };
  } else if (!argv.includes("--mock")) {
    console.error("pass --mock (plumbing only) or --ai <provider> (a real run)"); process.exit(2);
  }
  const out = await runAll(bank, model);
  const report = { model: model.name, bank: digest, at: new Date().toISOString(), ...out };
  if (model === mockModel) report.note = "mock model: tests the harness, not the hypothesis";
  console.log(JSON.stringify(report.decision, null, 2));
  const o = argv.indexOf("--out");
  if (o >= 0) fs.writeFileSync(argv[o + 1], JSON.stringify(report, null, 1));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main(process.argv.slice(2));
