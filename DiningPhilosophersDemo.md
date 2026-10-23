# Dining Philosophers: Five Peers at the Table

A step-by-step walkthrough of five peers — **Aristotle**, **Plato**, **Descartes**, **Kant**, and **Nietzsche** — using [quantum-os](README.md) to solve the classic Dining Philosophers concurrency problem. Each philosopher is a live browser peer. Forks are ZFA capability tokens. The room guarantees no deadlock by construction.

> Five philosophers are seated around a table. Each needs two adjacent forks to eat. There are exactly five forks — one between each pair. Can all five eat without deadlock?

---

## The table

```
            Aristotle
           /          \
       fork-A        fork-B
         /                \
    Nietzsche              Plato
         \                /
       fork-E          fork-C
           \            /
            Kant—fork-D—Descartes
```

Each philosopher needs **both adjacent forks** to eat. Each fork is a `cap:fork-X:hex` capability token — possessing the token IS the authorization to use the fork. Tokens cannot be forged, duplicated, or claimed by two philosophers simultaneously.

| Philosopher | Left fork | Right fork |
|-------------|-----------|------------|
| Aristotle | fork-A | fork-B |
| Plato | fork-B | fork-C |
| Descartes | fork-C | fork-D |
| Kant | fork-D | fork-E |
| Nietzsche | fork-E | fork-A |

---

## Setup: Five peers connect

All five open the same room URL and click **Connect**.

```
┌─────────────────────────────────────────────────────────────┐
│  ⬡ QuantumOS   peer-to-peer · ZFA capability model · WebRTC │
├──────────────┬──────────────────────────────────────────────┤
│ Your name    │  Share room: https://…#room=cap:room:024…    │
│ [Aristotle ] │                                              │
│              │  · joined room 024602…                       │
│ Your ID      │                                              │
│ cap:peer:02… │                                              │
│              │                                              │
│ Peers (4)    │                                              │
│ Aristotle    │                                              │
│   (you)      │                                              │
│ Plato     →  │                                              │
│ Descartes →  │                                              │
│ Kant      →  │                                              │
│ Nietzsche →  │                                              │
│              │                                              │
│ Lemmas (0)   │                                              │
│ (none yet)   │                                              │
│              │                                              │
│ Room Process │                                              │
│ parallel(    │  [broadcast a message…]          [Send]      │
│  Aristotle   │                                              │
│  Plato       │                                              │
│  Descartes   │                                              │
│  Kant        │                                              │
│  Nietzsche   │                                              │
│ )            │                                              │
│ ZFA: ✓ gap:0 │                                              │
└──────────────┴──────────────────────────────────────────────┘
                       ARISTOTLE'S WINDOW
```

The **Room Process** shows `parallel(Aristotle, Plato, Descartes, Kant, Nietzsche)` — ZFA-balanced from the moment all five join. Each peer identity is a 32-twist ZFA token (16+/16−). Their combined process has 160 twists, always balanced.

---

## Step 1 — Each philosopher mints their left fork

Each philosopher runs `/grant fork-X` for the fork on their left. No coordinator needed — minting is local, and the token broadcasts to all peers automatically.

```
ARISTOTLE TYPES:  /grant fork-a
PLATO TYPES:      /grant fork-b
DESCARTES TYPES:  /grant fork-c
KANT TYPES:       /grant fork-d
NIETZSCHE TYPES:  /grant fork-e
```

**Aristotle's window** (his own mint):

```
┌──────────────────────────────────────────────────────────────┐
│  · granted: cap:fork-a:01234567012345670123456701234567       │
│  ·   twists: 32  (16 pos, 16 neg)  ZFA-balanced: ✓          │
└──────────────────────────────────────────────────────────────┘
```

**All windows** (seeing neighbors' grants broadcast):

```
┌──────────────────────────────────────────────────────────────┐
│  Plato  /grant fork-b                                         │
│  ·   cap:fork-b:45674567456745674567456745674567             │
│  ·   run /zfa cap:fork-b:45674567… to verify                 │
│                                                               │
│  Descartes  /grant fork-c                                     │
│  ·   cap:fork-c:23016723016723016723016723016723             │
│  ·   run /zfa cap:fork-c:23016723… to verify                 │
│                                                               │
│  Kant  /grant fork-d                                          │
│  ·   cap:fork-d:67012367012367012367012367012367             │
│  ·   run /zfa cap:fork-d:67012367… to verify                 │
│                                                               │
│  Nietzsche  /grant fork-e                                     │
│  ·   cap:fork-e:30127530127530127530127530127530             │
│  ·   run /zfa cap:fork-e:30127530… to verify                 │
└──────────────────────────────────────────────────────────────┘
```

Each philosopher now **owns** their left fork — `/grant` automatically registers it as `@fork-X` in the local lemma store. The right fork belongs to their left neighbor. To eat, a philosopher uses `/request` to signal need and `/pass` to transfer — no token strings to copy.

**Result:** Five capability tokens minted and registered, one per philosopher, one per fork. Possession is unforgeable — no two philosophers can simultaneously hold the same token.

---

## Step 2 — Philosophers register their identity and state

Each philosopher registers their name as a lemma and sets their initial thinking state.

```
ARISTOTLE TYPES:  /lemma aristotle
ARISTOTLE TYPES:  /lemma aristotle-thinking
PLATO TYPES:      /lemma plato
PLATO TYPES:      /lemma plato-thinking
… (Descartes, Kant, Nietzsche do the same)
```

**All windows — Lemmas sidebar** (after all have registered):

```
│ Lemmas (10)             │
│ @aristotle          ←   │
│ @aristotle-thinking ←   │
│ @plato              ←   │
│ @plato-thinking     ←   │
│ @descartes          ←   │
│ @descartes-thinking ←   │
│ @kant               ←   │
│ @kant-thinking      ←   │
│ @nietzsche          ←   │
│ @nietzsche-thinking ←   │
```

All lemmas are ZFA-balanced (auto-allocated from the name) and sync to every peer instantly.

---

## Step 3 — Aristotle eats (no conflict)

Aristotle is hungry. He needs fork-A (left, already has it) and fork-B (right, held by Plato). Plato is thinking and agrees to pass it.

```
ARISTOTLE TYPES:  /lemma aristotle-hungry
```

```
┌──────────────────────────────────────────────────────────────┐
│  · lemma registered: @aristotle-hungry  (auto-allocated)     │
│  ·   ZFA: ✓                                                  │
└──────────────────────────────────────────────────────────────┘
```

Aristotle requests fork-B:

```
ARISTOTLE TYPES:  /request fork-b
```

```
┌──────────────────────────────────────────────────────────────┐
│  · requested @fork-b — waiting for holder to /pass it        │
└──────────────────────────────────────────────────────────────┘
```

**Plato's window** — sees the request and a ready-to-use prompt:

```
┌──────────────────────────────────────────────────────────────┐
│  Aristotle  requests @fork-b                                  │
│  · you hold @fork-b — type /pass fork-b Aristotle to transfer│
└──────────────────────────────────────────────────────────────┘
```

Plato passes with one command:

```
PLATO TYPES:  /pass fork-b aristotle
```

```
┌──────────────────────────────────────────────────────────────┐
│  · @fork-b transferred to Aristotle — removed from your lemmas│
│    cap: cap:fork-b:45674567…                                  │
└──────────────────────────────────────────────────────────────┘
```

**Aristotle's window** — fork-B arrives automatically:

```
┌──────────────────────────────────────────────────────────────┐
│  Plato  passes @fork-b                                        │
│  · @fork-b received from Plato  [cap: cap:fork-b:45674567…]  │
│  · run /zfa cap:fork-b:45674567… to verify                   │
└──────────────────────────────────────────────────────────────┘
```

Fork-B is now in Aristotle's lemma store, removed from Plato's. Aristotle composes to verify he can eat:

```
ARISTOTLE TYPES:  /qucalc @fork-a @fork-b
```

```
┌──────────────────────────────────────────────────────────────┐
│  · RhoQuCalc process:                                        │
│  ·   deduction composition:                                  │
│  ·     @fork-a  →  01234567…  (32 twists)  ZFA: ✓          │
│  ·     @fork-b  →  45674567…  (32 twists)  ZFA: ✓          │
│  ·   composed: 64 twists  (32+/32-)  gap: 0  ZFA: ✓        │
└──────────────────────────────────────────────────────────────┘
```

Aristotle eats. When finished he returns fork-B with one command:

```
ARISTOTLE TYPES:  /pass fork-b plato
```

Plato's window shows `@fork-b received from Aristotle` and the lemma reappears in his sidebar.

**Result:** Aristotle ate. Every transfer was a single command — no token strings to copy. Fork-B left Plato's possession and returned to it, tracked by the lemma store at each step.

---

## Step 4 — Concurrent eating: Aristotle and Descartes

Aristotle is hungry again. Simultaneously, Descartes is hungry. Their forks don't overlap — Aristotle needs A and B; Descartes needs C and D. No conflict.

Both request their right forks and verify concurrently:

```
ARISTOTLE TYPES:   /request fork-b    →  Plato: /pass fork-b aristotle
DESCARTES TYPES:   /request fork-d    →  Kant:  /pass fork-d descartes
```

Forks arrive automatically. Both compose:

```
ARISTOTLE TYPES:   /qucalc @fork-a @fork-b
DESCARTES TYPES:   /qucalc @fork-c @fork-d
```

**Side by side:**

```
┌──────────────────────────────────┬──────────────────────────────────┐
│  ARISTOTLE'S WINDOW              │  DESCARTES'S WINDOW              │
├──────────────────────────────────┼──────────────────────────────────┤
│  · @fork-a  ZFA: ✓               │  · @fork-c  ZFA: ✓               │
│  · @fork-b  ZFA: ✓               │  · @fork-d  ZFA: ✓               │
│  · composed: 64 twists           │  · composed: 64 twists           │
│  ·   gap: 0  ZFA: ✓              │  ·   gap: 0  ZFA: ✓              │
│                                  │                                  │
│ Room Process                     │ Room Process                     │
│ parallel(                        │ parallel(                        │
│  Aristotle  16+/16-              │  Aristotle  16+/16-              │
│  Plato      16+/16-              │  Plato      16+/16-              │
│  Descartes  16+/16-              │  Descartes  16+/16-              │
│  Kant       16+/16-              │  Kant       16+/16-              │
│  Nietzsche  16+/16-              │  Nietzsche  16+/16-              │
│ )                                │ )                                │
│ ZFA: ✓  gap: 0  twists: 160      │ ZFA: ✓  gap: 0  twists: 160      │
└──────────────────────────────────┴──────────────────────────────────┘
```

The room process remains balanced throughout. Two philosophers eating simultaneously is fine — they hold disjoint sets of tokens.

---

## Step 5 — The ordering rule: Nietzsche's case

Nietzsche needs **fork-E** (left, already has it) and **fork-A** (right, held by Aristotle). This is the dangerous case.

**Without an ordering rule:** all five philosophers simultaneously grab their left fork — Aristotle holds A, Plato holds B, Descartes holds C, Kant holds D, Nietzsche holds E — then each waits for the right fork. Circular wait: deadlock.

**The Dijkstra rule:** always request the **lower-lettered** fork first.

| Philosopher | Needs | Lower first | Action |
|-------------|-------|-------------|--------|
| Aristotle | A, B | A | grab A (has it) → request B |
| Plato | B, C | B | grab B (has it) → request C |
| Descartes | C, D | C | grab C (has it) → request D |
| Kant | D, E | D | grab D (has it) → request E |
| **Nietzsche** | **E, A** | **A** | **request A first → then use E** |

Nietzsche is the only philosopher who "reaches across" — he requests the right fork (A) before using the left fork (E) he already holds. This breaks the circular dependency: at most four philosophers can be simultaneously waiting for a right fork, and the chain is not circular.

```
NIETZSCHE TYPES:  /request fork-a
```

Aristotle sees the request prompt. He finishes eating, then:

```
ARISTOTLE TYPES:  /pass fork-a nietzsche
```

Fork-A arrives in Nietzsche's lemma store automatically. Nietzsche composes:

```
NIETZSCHE TYPES:  /qucalc @fork-a @fork-e
```

```
┌──────────────────────────────────────────────────────────────┐
│  · @fork-a  →  01234567…  (32 twists)  ZFA: ✓              │
│  · @fork-e  →  30127530…  (32 twists)  ZFA: ✓              │
│  · composed: 64 twists  (32+/32-)  gap: 0  ZFA: ✓          │
└──────────────────────────────────────────────────────────────┘
```

**Result:** Nietzsche eats. One reversal in fork-acquisition order eliminates the circular wait for the whole table.

---

## Step 6 — Why deadlock is impossible by construction

The classical deadlock state: all five philosophers hold their left fork and wait for their right fork indefinitely.

In the capability model:

- **Holding** a fork = possessing its `cap:fork-X:hex` token — a real, auditable positive claim
- **Waiting** = a `/request` broadcast with no token in hand — no unbalanced twist state exists in the system

The Room Process `parallel(Aristotle, Plato, Descartes, Kant, Nietzsche)` is always ZFA-balanced. By `decoherence_impossibility` (machine-verified in Lean 4: `rho_process_always_zfa`), parallel composition of ZFA-balanced processes stays balanced — a spectral gap cannot be created by composition.

A corrupt double-claim (two philosophers both registering `@fork-b`) would surface immediately on `/qucalc`:

```
· composed: gap: N  ZFA: ✗  — imbalance detected
```

An unbalanced token cannot be constructed — `validateCapability` rejects it at the source. There is no way to claim a fork you don't hold.

```
ARISTOTLE TYPES:  /id
```

```
┌──────────────────────────────────────────────────────────────┐
│  · peer: cap:peer:01234567012345670123456701234567           │
│  ·   twists: 32  (16+/16-)  ZFA-balanced: ✓                 │
│  · room: cap:room:024602460246024602460246024602             │
│  ·   room process: parallel(5 peers)  ZFA: ✓  gap: 0        │
│  ·   rho_process_always_zfa: ✓ (Lean-verified)              │
└──────────────────────────────────────────────────────────────┘
```

---

## Step 7 — The rendezvous lens: atomic acquisition as a single event

The Dijkstra ordering rule is the *classical* fix for circular wait. It works, and the demo above uses it. But it works by carefully sequencing two unilateral actions — request, then receive — and adding a global ordering rule on top to ensure the sequence cannot form a cycle. The reasoning is operational, not algebraic.

The [rendezvous primitive](docs/commands.md#rdv-sub-direct) gives the same problem an algebraic frame:

> Eating is not "acquire fork-L, then acquire fork-R, then put them down." Eating is **a single composite event** over three participants — the philosopher and the two fork-holders — that either commits as a whole or not at all.

If acquisition of both forks is one atomic event, deadlock is impossible *by definition*: there is no partial state in which the philosopher holds one fork and waits for the other. The classical pre-condition for deadlock — incremental allocation — never appears.

What this would look like at the command level, with an n-party atomic-acquisition rendezvous:

```
NIETZSCHE TYPES:  /rdv eat fork-e Nietzsche fork-a Aristotle
                  · proposes 3-party rendezvous (eat-Nietzsche-08f3a1)
                  · expires in 60s
```

Aristotle (who holds fork-a) sees:

```
Nietzsche  proposes rendezvous 08f3a1
  · 3-party atomic acquisition: Nietzsche holds fork-e, you lend fork-a
  · /rdv accept 08f3a1   or   /rdv reject 08f3a1
```

Nietzsche similarly accepts his own row. On all-accepts the proposer dispatches `rdv-commit` to every participant; each participant atomically transitions:
- Nietzsche: gains fork-a, retains fork-e, gains an "eating" marker — and the inverse return happens automatically on the second composite event when he finishes.
- Aristotle: marks fork-a as on-loan to Nietzsche; cannot lend it again until the second event releases it.

**Five concurrent eat-events from all five philosophers cannot deadlock**, because each is a single atomic transition. The proposer's conservation check would reject a configuration that tried to lock the same fork into two simultaneous eat-events, the same way the existing `conservationCheck` rejects a `/rdv swap` that double-spends an input.

### What the current `/rdv` MVP does and doesn't cover

The shipped MVP (commit `ea17b38`) exposes **2-party value-balanced swap** via `/rdv swap`. The underlying protocol in [`rendezvous.ts`](packages/browser/src/rendezvous.ts) — propose / accept / commit / abort, with multiset conservation over `(currency, denomination)` pairs — generalizes to n-party rendezvous on the wire; only the user-facing commands and the conservation check's semantics need to grow:

- Currently: `multiset(gives) == multiset(gets)` over `(currency, denomination)` pairs — fits *value swap*.
- For dining philosophers: a *resource acquisition* event with bracketing release. Same propose/accept/commit machinery, different conservation predicate (acquisitions match a future release event).

So the rendezvous-edition narrative above is **aspirational at the command layer** but **already half-built at the protocol layer**. The ordering-rule version below (the demo's main body) remains the working implementation.

The conceptual win is what matters: deadlock-freedom by *algebraic atomicity* rather than by *protocol discipline*. The classical computer-science result is that the dining philosophers problem requires a protocol; the rendezvous reading is that the problem dissolves once eating is the right *kind* of event.

---

## Full session view

```
┌──────────────────────────────────┬──────────────────────────────────┐
│  ARISTOTLE'S WINDOW              │  PLATO'S WINDOW                  │
├──────────────┬───────────────────┼──────────────┬───────────────────┤
│ Peers (4)    │ · granted:        │ Peers (4)    │ · granted:        │
│ Aristotle    │   cap:fork-a:01…  │ Plato (you)  │   cap:fork-b:45…  │
│   (you)      │   ZFA: ✓          │ Aristotle →  │   ZFA: ✓          │
│ Plato     →  │                   │ Descartes →  │                   │
│ Descartes →  │ · /request fork-b │ Kant      →  │ · Aristotle       │
│ Kant      →  │   → Plato passes  │ Nietzsche →  │   requests @fork-b│
│ Nietzsche →  │                   │              │ · /pass fork-b    │
│              │ · @fork-a @fork-b │ Lemmas (12+) │   aristotle ✓     │
│ Lemmas (12+) │   gap:0 ✓         │ @plato ←     │                   │
│ @aristotle ← │   Aristotle eats  │ @plato-      │ · Nietzsche       │
│ @aristotle-  │                   │   thinking ← │   requests @fork-a│
│   thinking ← │ · /pass fork-a    │              │ · @fork-a @fork-e │
│ @fork-a ←    │   nietzsche ✓     │ …            │   gap:0 ✓         │
│ @fork-b ←    │                   │              │   Nietzsche eats  │
│ …            │                   │ Room Process │                   │
│              │                   │ parallel(    │                   │
│ Room Process │                   │  Aristotle   │                   │
│ parallel(    │                   │   16+/16-    │                   │
│  Aristotle   │                   │  Plato       │                   │
│   16+/16-    │                   │   16+/16-    │                   │
│  Plato       │                   │  …           │                   │
│   16+/16-    │                   │ )            │                   │
│  …           │                   │ ZFA:✓ gap:0  │                   │
│ )            │                   │ twists: 160  │                   │
│ ZFA:✓ gap:0  │                   │              │                   │
│ twists: 160  │                   │              │                   │
└──────────────┴───────────────────┴──────────────┴───────────────────┘
```

---

## What just happened

The room was the table. No server tracked fork ownership. No lock manager arbitrated requests. The ZFA capability model made deadlock impossible by construction:

| Step | Who | Command | Meaning |
|------|-----|---------|---------|
| 1 | Each | `/grant fork-X` | Fork minted as unforgeable capability token |
| 2 | All | `/lemma <name>-thinking` | State registered, synced to all peers |
| 3 | Aristotle | `/qucalc @fork-a @fork-b` | Holds both forks — gap:0 ✓ — eats |
| 4 | Aristotle + Descartes | concurrent `/qucalc` | Non-adjacent eating — gap:0 ✓ both |
| 5 | Nietzsche | `/request fork-a` → Aristotle: `/pass fork-a nietzsche` | Ordering rule breaks circular wait |
| 6 | Room | `parallel(5 peers)` | ZFA:✓ gap:0 throughout — deadlock unreachable |

Three properties together make the table safe:

- **Unforgeability** — you cannot claim a fork without its `cap:fork-X:hex` string; the token is cryptographically unique
- **Detectability** — a double-claim shows up as a non-zero spectral gap in `/qucalc` immediately
- **Ordering** — the Dijkstra rule (lower letter first) eliminates circular waiting; Nietzsche's reversal is the single point that breaks the cycle

The classical dining philosophers problem requires a protocol to prevent deadlock. In QuantumOS, two of the three properties — unforgeability and detectability — come for free from the ZFA capability model. The ordering rule adds the third.

The [rendezvous lens (Step 7)](#step-7--the-rendezvous-lens-atomic-acquisition-as-a-single-event) replaces the third property with an even stronger one: if eating is a single composite event rather than a sequence of two unilateral acquisitions, deadlock is unreachable by definition. Ordering is no longer needed — atomicity does its work.

---

## Related

- [SyllogismDemo.md](SyllogismDemo.md) — the same `/lemma` and `/qucalc` system used for logical deduction
- [PromissoryNoteDemo.md](PromissoryNoteDemo.md) — bearer notes as ZFA twist sequences; `/note declare` → `/note grant` → `/note pass` → `/note redeem` with receipt
- [Commands § `/rdv`](docs/commands.md#rdv-sub-direct) — n-party atomic rendezvous; current MVP exposes 2-party value swap
- [`packages/browser/src/rendezvous.ts`](packages/browser/src/rendezvous.ts) — protocol module: `Proposal`, `Row`, `CommitRow`, `conservationCheck`, `cyclicSwap`
- [SECURITY.md § no consensus](SECURITY.md#the-shared-root-no-consensus) — why best-effort atomicity is the right primary mitigation only in some places, and where a consensus mechanism would be needed instead

**[Open a room and try it →](https://rhovision-org.github.io/quantum-os/)**
