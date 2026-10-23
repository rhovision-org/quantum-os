# Solving a Syllogism Together

A step-by-step walkthrough of two peers — **Alice** and **Bob** — using [quantum-os](README.md) to collaboratively verify the Aristotelian syllogism:

> All Men are Mortal. Socrates is a Man. Therefore, Socrates is Mortal.

Each step shows both browser windows side by side. The room URL is shared; both peers are connected. Lemmas registered by either peer appear in the **Lemmas** sidebar panel and persist across page reloads for the same room.

> **Tip:** Write the claim as a sentence and mark one word as the handle with `@` — `/lemma All men are @mortal` registers `@mortal`, keeps the sentence as its shown text, and auto-allocates a deterministic ZFA-balanced twist sequence from the handle (the same on every client, no coordination). Add explicit twists after a pipe (`/lemma All men are @mortal | ^v`) when you want to show the encoding, as the steps below do.
>
> **Tip:** Once the premises are named, `/solve @mortal @man` asks the substrate what it concludes — a valid syllogism is one whose premises already **close** (no further action needed); an invalid one comes back with the exact action still owed.

---

## Setup: Both peers connect

Alice opens the room and clicks **Connect**. She copies the share link and sends it to Bob. Bob opens the same URL and connects.

```
┌─────────────────────────────────────────────────────────────┐
│  ⬡ QuantumOS   peer-to-peer · ZFA capability model · WebRTC │
├──────────────┬──────────────────────────────────────────────┤
│ Your name    │  Share room: https://…#room=cap:room:024…    │
│ [Alice     ] │                                              │
│              │  · QLF slash commands:                       │
│ Your ID      │  ·   /help   /id   /room   /cap   /grant     │
│ cap:peer:02… │  ·   /zfa    /braket       /qucalc           │
│              │  ·   /lemma  @name in args                   │
│ Room         │  ·   //message                               │
│ cap:room:02… │  · joined room 024602…                       │
│              │                                              │
│ Signaling    │                                              │
│ [wss://…   ] │                                              │
│ ● connected  │                                              │
│              │                                              │
│ Peers (1)    │                                              │
│ Alice (you)  │                                              │
│ Bob      ←   │                                              │
│              │                                              │
│ Lemmas (0)   │                                              │
│ (none yet)   │                                              │
│              │                                              │
│ Room Process │                                              │
│ parallel(    │  [broadcast a message…]          [Send]      │
│  Alice (you) │                                              │
│  Bob         │                                              │
│ )            │                                              │
│ ZFA: ✓ gap:0 │                                              │
└──────────────┴──────────────────────────────────────────────┘
                          ALICE'S WINDOW
```

Both peers see each other in the **Peers** list. The **Room Process** panel shows `parallel(Alice, Bob)` — their combined ZFA process is already balanced (each peer identity is a 32-twist ZFA token with 16 positive and 16 negative twists).

---

## Step 1 — Alice names the Major Premise

Alice types `/lemma All men are @mortal | ^v`. She writes the claim as a sentence and marks the handle with `@`. The `^v` sequence encodes **"All men are mortal"**: `^` (Up, action) asserts the universal category; `v` (Down, lift) closes it — the minimal balanced logical container. The handle `@mortal` gives both peers a shared, reusable reference; the sentence is kept as the lemma's shown text.

```
ALICE TYPES:  /lemma All men are @mortal | ^v
```

**Alice's window:**

```
┌──────────────────────────────────────────────────────────────┐
│  · lemma registered: @mortal  =  ^v                          │
│  ·   “All men are mortal”                                    │
│  ·   twists: 2  (1+/1-)  ZFA: ✓                             │
│  ·   cap: cap:mortal:01  (share with /zfa to verify)         │
└──────────────────────────────────────────────────────────────┘
```

**Bob's window** — receives the lemma automatically:

```
┌──────────────────────────────────────────────────────────────┐
│  Alice  /lemma All men are mortal                             │
│  ·   @mortal registered from Alice  “All men are mortal”      │
│        [cap: cap:mortal:01]                                   │
└──────────────────────────────────────────────────────────────┘
```

Both sidebars now show:

```
│ Lemmas (1)                       │
│ @mortal — “All men are mortal” ← │   ← click to prefill /qucalc @mortal
```

**Result:** "All men are mortal" is ZFA-balanced (gap = 0), stored as `@mortal`, and auto-minted as `cap:mortal:01` — an unforgeable proof object for this claim.

---

## Step 2 — Bob names the Minor Premise

Bob types `/lemma Socrates is a @man | +-`. The `+-` sequence encodes **"Socrates is a man"**: `+` (Plus, action) asserts the identity; `-` (Minus, lift) grounds it. The handle `@man` completes the shared premise vocabulary.

```
BOB TYPES:  /lemma Socrates is a @man | +-
```

**Bob's window:**

```
┌──────────────────────────────────────────────────────────────┐
│  · lemma registered: @man  =  +-                             │
│  ·   “Socrates is a man”                                     │
│  ·   twists: 2  (1+/1-)  ZFA: ✓                             │
│  ·   cap: cap:man:67  (share with /zfa to verify)            │
└──────────────────────────────────────────────────────────────┘
```

**Alice's window** — receives Bob's lemma:

```
┌──────────────────────────────────────────────────────────────┐
│  Bob  /lemma Socrates is a man                                │
│  ·   @man registered from Bob  “Socrates is a man”            │
│        [cap: cap:man:67]                                      │
└──────────────────────────────────────────────────────────────┘
```

Both sidebars now show:

```
│ Lemmas (2)                        │
│ @mortal — “All men are mortal”  ← │
│ @man — “Socrates is a man”      ← │
```

**Result:** "Socrates is a man" registered as `@man`. The shared positive action `+` with Alice's `^` is the **Middle Term** ("Man") — the bridge that will fuse both premises into the conclusion.

---

## Step 3 — Alice deduces from named premises

Alice types `/qucalc @mortal @man`. The system expands each `@ref` to its twist sequence, concatenates them, and shows the deduction composition label-by-label.

```
ALICE TYPES:  /qucalc @mortal @man
```

**Both windows** show:

```
┌──────────────────────────────────────────────────────────────┐
│  · RhoQuCalc process:                                        │
│  ·   composed: @mortal @man                                  │
│  ·   deduction composition:                                  │
│  ·     @mortal  →  ^v  (1+/1-)  ZFA: ✓                      │
│  ·     @man     →  +-  (1+/1-)  ZFA: ✓                      │
│  ·   composed: ^v+-  (4 total)                               │
│  ·   action (pos): count=2   lift (neg): count=2             │
│  ·   spectral gap: 0  ZFA-balanced: ✓                        │
│  ·   frequency level: 2  C(4,2) = 6 arrangements            │
│  ·   process: parallel(action(Form), lift(Form)) → ZFA stable│
│  ·   achieves_ZFA: ✓  stable under full_zeno_prune           │
│  ·   rho_process_always_zfa: ✓ (Lean-verified)               │
└──────────────────────────────────────────────────────────────┘
```

**Result:** `@mortal` (^v) + `@man` (+-) = `^v+-`, gap = 0. The Middle Term cancels internally. **The syllogism is valid** — shown by name, not by raw twist string.

---

## Step 4 — Bob asks the substrate for the conclusion

Bob types `/solve @mortal @man`. Where `/qucalc` *shows* the composition, `/solve` asks the substrate which closure it takes from here — computed locally, so every peer gets the same answer with no service.

```
BOB TYPES:  /solve @mortal @man
```

**Both windows** show:

```
┌──────────────────────────────────────────────────────────────┐
│  · /solve  @mortal @man   (^v+-)                             │
│  ·   already a closure — no further action                   │
│  ·   phase: +1   peak excursion: 1   depth: 0                │
│  ·   the premises close on their own: the syllogism is valid │
└──────────────────────────────────────────────────────────────┘
```

**Result:** the composed premises are *already* a ZFA closure — `/solve` returns the empty continuation. That is exactly what "the syllogism is valid" means: nothing more has to be asserted for it to close. An **invalid** argument would come back with a residual — the precise action vector a completion still owes — and `/search @mortal @man` would enumerate every way (if any) to reach closure from there.

The Room Process panel confirms the joint state:

```
┌─────────────────────┐
│ Room Process        │
│ parallel(           │
│   action(Alice)     │
│     16+/16-         │
│   action(Bob)       │
│     16+/16-         │
│ )                   │
│ ZFA: ✓  gap: 0      │
│ total twists: 64    │
└─────────────────────┘
```

---

## Step 5 — Bob evaluates the Conclusion as a quantum state

Bob evaluates **"Socrates is mortal"** as a bra-ket superposition. The conclusion synthesises the universal (`|0⟩`) and the particular (`|1⟩`).

```
BOB TYPES:  /braket 0 1
```

**Both windows** show:

```
┌──────────────────────────────────────────────────────────────┐
│  · ket: |0⟩ + |1⟩                                           │
│  ·   RhoProcess: parallel(action(Form_0), action(Form_1))    │
│  ·   eval = Form.toMatrix:                                   │
│  ·   ⎡ 1  0 ⎤                                               │
│  ·   ⎣ 0  1 ⎦                                               │
│  · bra: ⟨0| + ⟨1|  (eval = ket†  =  ket                    │
│  ·   [Hermitian: Form.toMatrix_adjoint ✓])                   │
│  ·   ZFA: action [+,−]  lift [−,+]  both balanced: ✓        │
│  ·   bra_ket_always_balanced: ✓ (BraKetRhoQuCalc.lean)       │
└──────────────────────────────────────────────────────────────┘
```

**Result:** `|0⟩⟨0| + |1⟩⟨1| = I` — the identity matrix. The conclusion spans the full logical space defined by the premises.

---

## Step 6 — Alice seals the conclusion as a named lemma

Alice registers the proved conclusion as `@concl` — composing it directly from the two named premises. The system resolves the chain, validates ZFA balance, and mints `cap:concl:0167` as the unforgeable proof object for "Socrates is mortal."

```
ALICE TYPES:  /lemma @concl Socrates is mortal | @mortal @man
```

**Alice's window:**

```
┌──────────────────────────────────────────────────────────────┐
│  · lemma registered: @concl  =  ^v+-                         │
│  ·   “Socrates is mortal”                                    │
│  ·   twists: 4  (2+/2-)  ZFA: ✓                             │
│  ·   cap: cap:concl:0167  (share with /zfa to verify)        │
└──────────────────────────────────────────────────────────────┘
```

**Bob's window** — receives the proved conclusion:

```
┌──────────────────────────────────────────────────────────────┐
│  Alice  /lemma Socrates is mortal                             │
│  ·   @concl registered from Alice  “Socrates is mortal”       │
│        [cap: cap:concl:0167]                                  │
└──────────────────────────────────────────────────────────────┘
```

Bob verifies by clicking `@concl` in the Lemmas sidebar (prefills `/qucalc @concl`), or directly:

```
BOB TYPES:  /zfa cap:concl:0167
```

**Bob's window:**

```
┌──────────────────────────────────────────────────────────────┐
│  · token: cap:concl:0167                                      │
│  ·   valid: ✓  spectral gap: 0                               │
│  ·   twists: 4  (2 positive, 2 negative)                     │
└──────────────────────────────────────────────────────────────┘
```

Both sidebars now show the complete proof vocabulary:

```
│ Lemmas (3)                          │
│ @mortal — “All men are mortal”   ←  │   cap:mortal:01
│ @man    — “Socrates is a man”    ←  │   cap:man:67
│ @concl  — “Socrates is mortal”   ←  │   cap:concl:0167   (proved)
```

**Result:** `cap:concl:0167` is a valid ZFA-balanced token. Possessing it — or referencing `@concl` — is proof that the syllogism reached ZFA closure. An invalid argument produces a non-zero spectral gap and cannot be named as a balanced lemma.

---

## Full session view

Both windows at the end of the session:

```
┌──────────────────────────────────────┬──────────────────────────────────────┐
│  ALICE'S WINDOW                      │  BOB'S WINDOW                        │
├──────────────────┬───────────────────┼──────────────────┬───────────────────┤
│ Peers (1)        │ · joined room 024…│ Peers (1)        │ · joined room 024…│
│ Alice (you)      │                   │ Bob (you)        │                   │
│ Bob          →   │ · @mortal = ^v ✓  │ Alice        →   │ · @mortal from    │
│                  │                   │                  │   Alice ✓         │
│ Lemmas (3)       │ · @man from Bob ✓ │ Lemmas (3)       │ · @man = +- ✓     │
│ @mortal — “All … │                   │ @mortal — “All … │                   │
│ @man   — “Socr…  │ · /solve @mortal  │ @man   — “Socr…  │ · @mortal @man:   │
│ @concl — “Socr…  │   @man → already  │ @concl — “Socr…  │ ·  ^v ✓  +- ✓     │
│                  │   closed, +1      │                  │ ·  ^v+- ZFA: ✓    │
│ Room Process     │                   │ Room Process     │                   │
│ parallel(        │ · braket 0 1:     │ parallel(        │ · /solve → closed │
│  Alice (you)     │ ·  ⎡ 1  0 ⎤       │  Bob (you)       │ · braket 0 1:     │
│   16+/16-        │ ·  ⎣ 0  1 ⎦       │   16+/16-        │ ·  ⎡ 1  0 ⎤       │
│  Bob             │                   │  Alice           │ ·  ⎣ 0  1 ⎦       │
│   16+/16-        │ · @concl from     │   16+/16-        │ · token valid ✓   │
│ )                │   Alice ✓         │ )                │   cap:concl:0167  │
│ ZFA: ✓ gap:0     │                   │ ZFA: ✓ gap:0     │                   │
│ twists: 64       │                   │ twists: 64       │                   │
└──────────────────┴───────────────────┴──────────────────┴───────────────────┘
```

---

## What just happened

The room was the coprocessor. Neither peer needed a shared server, a database, or a trusted third party. The proof emerged from the ZFA structure of their collaboration — named and navigable through lemmas:

| Step | Who | Command | Lemma | Meaning |
|------|-----|---------|-------|---------|
| 1 | Alice | `/lemma All men are @mortal \| ^v` | `@mortal` | "All men are mortal" — gap 0 ✓ |
| 2 | Bob | `/lemma Socrates is a @man \| +-` | `@man` | "Socrates is a man" — gap 0 ✓ |
| 3 | Alice | `/qucalc @mortal @man` | — | Deduction: Middle Term cancels, gap 0 ✓ |
| 4 | Bob | `/solve @mortal @man` | — | The substrate: premises **already close**, phase +1 — valid |
| 5 | Bob | `/braket 0 1` | — | Conclusion: `\|0⟩ + \|1⟩ = I` (completeness) |
| 6 | Alice | `/lemma @concl Socrates is mortal \| @mortal @man` | `@concl` | Proof sealed: `cap:concl:0167` unforgeable |

Steps 1 and 2 supply explicit twists after a pipe to illustrate the ZFA encoding. The same proof works with auto-allocation — just drop the ` | ^v`:

```
/lemma All men are @mortal     ← twists auto-allocated from the @mortal handle
/lemma Socrates is a @man
```

Both peers always derive the same twists for the same handle, so the cap tokens match without any coordination.

The Lemmas panel gives both peers a shared, navigable vocabulary of proved claims — each `@handle` shown with its sentence; click one to expand it with `/qucalc`. Lemmas persist in localStorage per room, so the proof survives a page reload. An invalid syllogism would produce a non-zero spectral gap at step 3, `/solve` at step 4 would report the residual action a completion still owes instead of "already closed", and the auto-minted capability token would fail `/zfa` verification — unbalanced tokens are algebraically impossible to construct.

The ZFA filter — `full_zeno_prune` — is the same operation that selects physical reality from the space of all possible logical histories.

**[Open a room and try it →](https://rhovision-org.github.io/quantum-os/)**

See [AI.md](https://github.com/rhovision-org/quantum-logical-framework/blob/main/AI.md) for the theoretical background on ZFA Blanket Fusion and the Neuro-Symbolic architecture.
