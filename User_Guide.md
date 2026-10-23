# User Guide — collaborating in a [QuantumOS](README.md) room

**QuantumOS is an intelligent gateway to each other and everything — the rho ZFA p2p layer, proven secure.** In practice that means: the link you share *is* the room, holding it *is* your membership, and everything the group builds inside — an agreement, a decision, a shared value — is as verifiably yours as the link itself, with no company or server standing between you and either. It also runs **off-chain by default**, so a normal session — voting, recording a lemma, passing a note — costs nothing and shows up on no public ledger; a blockchain only enters if the group deliberately chooses it (see `/rholang`), never as a precondition for privacy or security. And it's built to stay secure even against a future quantum computer — your identity and capabilities aren't the kind of cryptography that breaks when one arrives.

A QuantumOS room is a serverless, peer-to-peer space where a group **discusses,
decides, and records** together — no account, no host, no central server. This guide
is the **map**: what to do at each stage, the one command for it, and where the full
details live. It doesn't repeat those docs — follow the links for depth.

> [Open a room →](https://rhovision-org.github.io/quantum-os/), set a name, share the
> room link. Everyone with the link is a peer; holding the link **is** your membership.

**The arc of a session:** gather → **discuss & brainstorm** → **build trust** →
**decide** → **record**. Stop at any stage; nothing binds a peer who didn't take part.

---

## 1. Be known
`/name <you>` sets your display name so people (and the agents) know who's talking.
`/help` lists every command in the app.

Your identity is a per-browser key, so by default clearing storage or switching
browsers makes you a stranger. `/password` protects it with a password — and, if
you're in a group, replicates an *encrypted* copy into the group (pure peer-to-peer,
no server). In a new browser, rejoin the group and `/login <handle>` — or paste the
recovery string `/password` gave you — to return as the *same* person, trust and
roles intact. The password is the only thing that decrypts it, so choose a strong
one. → **[Security](SECURITY.md)**

## 2. Discuss & brainstorm
Quality closure comes from **complementary roles** — Proposer, Skeptic, Integrator,
Evidence-keeper, Operator, Boundary-keeper — and a few turn-taking rules: don't
dominate, include the silent, don't close a proposal unrefuted.
→ **[Room Best Practices](Room_Best_Practices.md)** — the roles, rules, and closure checklist.

Optional **AI agents** can join as full members to help: a `facilitator` (keeps everyone
included, surfaces dis/agreement), a `scribe` (tracks decisions, offers to record them),
a `greeter`, a `skeptic` (surfaces unexamined assumptions before the group closes). They
only *nudge*, and the room governs them with the same trust as anyone.
→ **[Running agents](scripts/qos-cli/README.md)** · build your own → **[Developer Guide](Developer_Guide.md)**.

## 3. Build trust
Voting weight is **earned, not one-person-one-vote**: rate peers (`/gov trust <member> 0–5`),
delegate your vote to someone you trust (`/gov delegate <member>`), and hold the
over-trusted to account (`/gov censure`, a ⅔ quorum). Trust descends from the room's
admins and is *liquid* — it flows along delegation.
→ **[Governance — liquid democracy](Governance.md)**.

## 4. Decide & vote
Use the lightest process that fits:
- read the room → `/poll` (approval, or `ranked`)
- agree a number (estimate, budget, points) → `/estimate`
- *"are we actually agreed?"* on join → `/probe` (chain-weighted supermajority; losing peers are ignored for sync, not overruled)
- a formal group issue + weighted vote → `/gov issue`, then `/gov vote`
- a hard topic that needs structure → **`/facil chair <topic>`**: an AI facilitator chairs the room through **define → alternatives → evaluate → disagreements → agreements → closure** as the *single neutral leader* (best practice: one leader, never a computer *and* a human leader at once), and records a decision of record at the end. Steer it with `/facil next`/`back`/`close`/`cancel`.

→ **[Group Decisions](Group_Decisions.md)** (the whole family, and when to use each) ·
**[Consensus](Consensus.md)** (the `/probe` protocol and its threat model).

## 4½. The quantum problem solver
Chain those tools into an **annealing loop** and the room becomes a quantum-annealing-style optimizer:
it relaxes toward a low-energy consensus rather than "trying every answer at once." Propose candidate
solutions, score them (trust-weighted) with `/estimate` or `/poll`, lower the "temperature" each round
(explore wide early, refine the leader late), then `/probe` to converge and `/lemma`+`/persist` the
winner. An AI facilitator can run the rounds for you — **`/facil optimize <objective + constraints>`**
proposes candidates and the next step. When the problem is a QuCalc position, **`/search`** renders the
admissible possibility space straight from the substrate — the generate step done by the kernel — and
**`/solve`** picks the one closure it takes (or the exact action a completion still owes). Both compute
in the browser, so every peer agrees with no service.
→ **[Collective Optimization](Collective_Optimization.md)** (the method, and why a room beats a QPU on
real problems), with a runnable room-session **[demo](OptimizationDemo.md)** (`node scripts/qos-cli/optimize-demo.mjs`).

## 5. Record the decision
A decision only outlives the session if it's written down: `/lemma <statement>` mints it — write it as a
sentence and mark one word as the handle with `@` (`/lemma Ship v2 on @friday`), so you cite it as
`@friday` later. `/persist` keeps it so late joiners (and an always-on memory daemon) still see it.
→ **[Group Decisions](Group_Decisions.md)**.

## 6. Work across rooms
Each room is its own space — its own people, lemmas, and decisions. To cooperate across
several: `/room` opens each as a tab, and `/share <item> to <room>` copies a lemma, note, or
message from one of your tabs into another. To link *separate* rooms (different groups), run a
**room bridge** — one connection that stands in both and passes their channels, chat, lemmas, and
governance to each other, so a lemma proven in one room becomes a lemma in the other.
→ **[Room Bridges](Room_Bridges.md)**. Want to *see* a room? Type `/render`.

---

## Cheat-sheet

| To… | Use | Learn more |
|---|---|---|
| set your name | `/name <you>` | `/help` |
| keep / recover your identity | `/password` · `/login <handle>` | [Security](SECURITY.md) |
| run a good discussion | roles + turn-taking | [Room Best Practices](Room_Best_Practices.md) |
| add an AI helper | `agent.mjs --role …` | [Agents](scripts/qos-cli/README.md) |
| rate · delegate · hold to account | `/gov trust` · `/gov delegate` · `/gov censure` | [Governance](Governance.md) |
| quick vote | `/poll` (`ranked`) | [Group Decisions](Group_Decisions.md) |
| agree a number | `/estimate` | [Group Decisions](Group_Decisions.md) |
| check real agreement | `/probe` | [Consensus](Consensus.md) |
| formal weighted vote | `/gov issue` · `/gov vote` | [Governance](Governance.md) |
| record a decision | `/lemma` · `/persist` | [Group Decisions](Group_Decisions.md) |
| cooperate across rooms | `/room` · `/share` · `bridge.mjs` | [Room Bridges](Room_Bridges.md) |
| write your own command | `/macro define name(a) …` then `+name` | [MacRhoLang](MacRhoLang.md) |
| see the room | `/render` | — |

## See it in action
Worked sessions, grounded in the real commands:
**[Multi-stakeholder governance](GovernanceCaseStudy.md)** ·
**[Collaborative learning](CollaborativeLearningCaseStudy.md)** ·
**[Complementary-specialist room](SpecialistRoomCaseStudy.md)**.
