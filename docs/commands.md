# Slash commands — the full reference

Every in-app command, split out of the root [README](../README.md) so the README can
route readers instead of listing everything (quantum-os#116). The short version is the
[User Guide's cheat-sheet](../User_Guide.md#cheat-sheet); the implementation is
`packages/browser/src/app.ts` `handleCommand`, and [CLAUDE.md](../CLAUDE.md#slash-commands-appts-handlecommand)
maps each command family to its module.

Type these in the chat input after connecting. The `/help` list is shown automatically at
startup. Commands marked **shared** broadcast their output to all peers in the room;
**[direct]** ones address one peer.

---
### `/help`
Lists all available commands.
```
QLF slash commands:
  /help            — show this help
  /id              — your peer ID and ZFA proof
  /password [show] — password-protect your identity → a recovery string
  /login           — restore a former identity (recovery string + password)
  /room            — room capability token
  /cap [label]     — generate a new ZFA capability
  /grant [label]   — generate and share a ZFA capability token
  /zfa [token]     — validate a capability token
  /braket <state>  — evaluate bra-ket (states: 0 1 + - i -i)
  /qucalc [twists] — evaluate RhoQuCalc twist sequence
  /conj <twists>   — Hermitian adjoint (reverse + parity-flip); flags self-adjoint
  /freq [n|twists] — ZFA frequency spectrum; C(2n,n) arrangements at level n
  /qlf-action <tw> — propose a history string for the room to verify
  /zfa-check <tw>  — verify ZFA closure locally (count-balanced ∧ pauli-closed)
  /coupling [tw …] — was the room's closure shared, or several side by side?
  /search [pos]    — the admissible next closures from a QuCalc position (computed locally)
  /solve [pos]     — pick the one closure the substrate takes (least free action); the residual if none
  /dump            — summary of all logic shared this session
  /lemma           — list named lemmas
  /lemma <claim>   — register a claim; mark the handle: /lemma All men are @mortal  →  @mortal
  /lemma <c> | <tw> — with explicit twists (else auto-allocated from the handle)
  /request <n>     — request @n from whoever holds it
  /pass <n> <peer> — transfer @n directly to a named peer
  /note [sub]      — promissory notes (declare|grant [| terms]|pass|redeem|terms|accept|split|merge|balance)
  /poll [sub]      — group vote: new <q> [| seeds] [ranked] · add · vote · status · lock · close · remove · list
  /estimate [sub]  — robust group numeric estimate: new <q> · <number> · status · close (median)
  /gov [sub]       — liquid-democracy + liquid-trust groups: new · member · issue · delegate · trust · censure · vote · treasury · kudos · say · status
  /forget <sub>    — remove an item: poll <id> · lemma <name> · note <token|cur denom> · group <name> · list
  /rdv [sub]       — n-party atomic rendezvous (swap|counter|accept|reject|abort|list)
  /dyncap [sub]    — hash-only dynamic capabilities (status|peers)
  /probe [sub]     — joiner-local consensus probe (status|clear)
  /room [sub]      — multi-room tabs (list|join <cap>|leave|ref)
  /share <sel> to <room>  — bridge a lemma/chat/note into another tab
  /channel [sub]   — tagged messages (listen|unlisten|send <name> <text>|list)
  /script <c1>;…   — sequential command chain (// to skip a segment)
  /persist [sub]   — agreed-replication of public state (@lemma|currency …)
  /rhoqu <text>    — RhoQu macro: process / new / | / if / on / for over /commands
  @name in args    — expand named lemma (e.g. /qucalc @major @minor; @[multi word] for a spaced name)
  //message        — send a message starting with /
```

**Group decisions** — `/poll` brings approval and ranked-choice (IRV) voting with open
nominations to a room: `/poll new What's for lunch?`, then everyone adds options and votes,
and the creator closes it for a deterministic, joiner-local tally. `/estimate` adds a
whale-resistant **median** group estimate (`new <q>` · `<number>` · `status` · `close`).
See [Group_Decisions.md](../Group_Decisions.md) for the full family of decision processes the
interface supports.

**Portable identity** — your identity is a hash-only **dyncap** anchor (`anchor = SHA-256(seed)`)
that peers pin on first contact; by default the 32-byte seed lives only in this browser's storage,
so clearing it or switching browsers makes you a stranger. `/password` fixes that: it encrypts the
seed under a password (PBKDF2 → AES-GCM) and hands you a `qos-vault:v1:…` **recovery string** (the
password is typed in a masked dialog — it never touches the chat log or a broadcast). `/login`
restores that exact seed/anchor from the recovery string + password, so peers recognize you again.
The recovery string is self-custody — no server holds it; anyone with the string *and* your password
can restore your identity, so keep it private.

**Group-scoped recovery (no string to carry, still pure p2p).** If you're in a group, `/password` also
replicates your *encrypted* vault into it under your display-name handle — riding the same peer-to-peer
`sync-gov` fabric as the rest of governance (the persistent memory peer holds it durably; no server, no
username registry, and the ciphertext is useless without your password). Then in a fresh browser you just
rejoin the group's room and run `/login <handle>` + password — the vault is fetched from whichever peers
hold the group state and decrypted locally. Membership is bound to your durable **anchor** (not the
per-tab peerId), so a recovered identity is re-recognized as the same member — trust, delegations, and
role follow you. (Squatting is prevented first-write-wins by handle, overwrite only by the same identity;
and one identity shouldn't run live in two browsers at once — it forks.)

**Group governance** — `/gov` ports RChain's rgov onto quantum-os primitives:
capability-scoped groups, issues, and **liquid democracy** (`/gov delegate` — standing,
transitive, revocable) with a deterministic joiner-local tally. It extends to **liquid
*trust***: `/gov trust <member> <0–5>` confers a trust level *strictly below your own* in
an admin-rooted hierarchy (vote weight = `1 + level`), and `/gov censure` makes vouching a
**stake** — a ⅔ quorum of eligible peers (even over an admin) discredits a member who holds
undeserved trust and *slashes everyone who vouched for them*. With no ratings it is exactly
one-person-one-vote. See [Governance.md](../Governance.md), and [Room_Best_Practices.md](../Room_Best_Practices.md)
for the collective-intelligence practices behind it.

**Notes with terms** — `/note grant USD 5 | redeemable for one coffee` mints a
**terms-stamped** note (`cap:note-USD~<hash>`); the issuer's terms are dyncap-signed and
travel with the note. `/note terms` reads them and `/note accept` is required before redeeming.
Different terms for the same currency are simply different stamped series.

### `/braket <state>` [shared]
Evaluates a bra-ket expression using the `Form` 2×2 Hermitian matrix algebra from `SpacetimeDynamics.lean`. States: `0`, `1`, `+`, `-`, `i`, `-i`. Multiple states (space-separated) compose as `parallel` (matrix addition = superposition). Output broadcasts to all peers.

`Form.toMatrix = [[t+z, x−iy],[x+iy, t−z]]`

Input:
```
/braket +
```
Output:
```
· ket: |+⟩
·   RhoProcess: action(Form_+)
·   eval = Form.toMatrix:
·   ⎡ 0.5  0.5 ⎤
·   ⎣ 0.5  0.5 ⎦
· bra: ⟨+|  (eval = ket†  =  ket  [Hermitian: Form.toMatrix_adjoint ✓])
·   ZFA: action [+,−]  lift [−,+]  both balanced: ✓
·   bra_ket_always_balanced: ✓ (BraKetRhoQuCalc.lean)
```

Input:
```
/braket 0 1
```
Output:
```
· ket: |0⟩ + |1⟩
·   RhoProcess: parallel(action(Form_0), action(Form_1))
·   eval = Form.toMatrix:
·   ⎡ 1  0 ⎤
·   ⎣ 0  1 ⎦
· bra: ⟨0| + ⟨1|  (eval = ket†  =  ket  [Hermitian: Form.toMatrix_adjoint ✓])
·   ZFA: action [+,−]  lift [−,+]  both balanced: ✓
·   bra_ket_always_balanced: ✓ (BraKetRhoQuCalc.lean)
```

The `|0⟩ + |1⟩` superposition yields the identity matrix — a complete basis. See [BraKetRhoQuCalc.md](https://github.com/rhovision-org/quantum-logical-framework/blob/main/BraKetRhoQuCalc.md) for the full bra-ket ↔ RhoQuCalc correspondence.

Lean anchor: [`bra_ket_always_balanced`](https://github.com/rhovision-org/quantum-logical-framework/blob/main/lean/BraKetRhoQuCalc.lean)

### `/qucalc [twists]` [shared]
Evaluates a RhoQuCalc twist sequence. Accepts symbolic twists (`^v<>/\+-`), hex digits `0-7`, a `cap:label:hex` token, or `@name` references to named lemmas. No argument → show your peer's twist sequence. Click a peer or lemma name in the sidebar to prefill the input.

Twist alphabet: `^`=Up=0, `v`=Down=1, `>`=Right=2, `<`=Left=3, `/`=Slash=4, `\`=BSlash=5, `+`=Plus=6, `-`=Minus=7. Even values are positive (action); odd are negative (lift).

Input (compose named premises — see `/lemma` below):
```
/qucalc @mortality @socrates
```
Output:
```
· RhoQuCalc process:
·   composed: @mortality @socrates
·   deduction composition:
·     @mortality  →  ^v  (1+/1-)  ZFA: ✓
·     @socrates   →  +-  (1+/1-)  ZFA: ✓
·   composed: ^v+-  (4 total)
·   action (pos): count=2   lift (neg): count=2
·   spectral gap: 0  ZFA-balanced: ✓
·   frequency level: 2  C(4,2) = 6 arrangements
·   process: parallel(action(Form), lift(Form))  → ZFA stable
·   achieves_ZFA: ✓  stable under full_zeno_prune
·   rho_process_always_zfa: ✓ (Lean-verified)
```

`/qucalc` *shows* the composition; **`/solve @mortality @socrates`** asks the substrate what it concludes — a valid argument is one whose premises already **close** (`/solve` returns the empty continuation), an invalid one comes back with the exact action still owed. **`/search`** enumerates every way to close from a position. Both compute in the browser — no service.

Input (unbalanced — invalid argument):
```
/qucalc ^v^v^
```
Output:
```
· RhoQuCalc process:
·   input: ^v^v^
·   twists: ^v^v^  (5 total)
·   action (pos): count=3   lift (neg): count=2
·   spectral gap: 1  ZFA-balanced: ✗
·   process: UNBALANCED  → pruned by full_zeno_prune
·   achieves_ZFA: ✗  gap=1  (not a physical process)
```

ZFA balance is the selection principle: `@major @minor` composed (gap=0) is a valid deduction; an unbalanced composition is pruned by `full_zeno_prune` before becoming a physical event. See [BraKetRhoQuCalc.md](https://github.com/rhovision-org/quantum-logical-framework/blob/main/BraKetRhoQuCalc.md) and [QuantumOS.md](https://github.com/rhovision-org/quantum-logical-framework/blob/main/QuantumOS.md) for the capability-security model built on this invariant.

Lean anchors: [`RhoProcess`](https://github.com/rhovision-org/quantum-logical-framework/blob/main/lean/RhoQuCalc.lean) · [`rho_process_always_zfa`](https://github.com/rhovision-org/quantum-logical-framework/blob/main/lean/RhoQuCalc.lean) · [`bra_ket_always_balanced`](https://github.com/rhovision-org/quantum-logical-framework/blob/main/lean/BraKetRhoQuCalc.lean)

### `/conj <twists>` [shared]

Computes the **Hermitian adjoint** of a twist history `H`: reverse the sequence and flip each twist's parity (the pairing `0↔1, 2↔3, 4↔5, 6↔7`). This is QLF's structural "negation" operator — implemented as `Twist::conjugate` in the WASM kernel (`crates/zfa-core/src/twist.rs`), `Twist.conj` in Lean (`lean/QLF_TwistAlphabet.lean`), and `adjointHistory` in `packages/browser/src/app.ts`. Defining identity: `E + E† ≡ ZFA` (see [Hermitian_Conjugacy_Proof.md](https://github.com/rhovision-org/quantum-logical-framework/blob/main/Hermitian_Conjugacy_Proof.md)).

Accepts the full twist-parsing pipeline used by `/qucalc`: symbolic (`^v<>/\+-`), hex digits 0-7, `cap:label:hex` tokens, and `@lemma` references.

Output:

```
Hermitian adjoint (H†):
·   input: ^v<>
·   H  = ^v<>   (n=4)
·   H† = ><v^   (reversed + parity-flipped)
·   self-adjoint (H = H†): ✗
·   H || H† balanced: ✓  (E + E† ≡ ZFA)
```

For palindromic-under-flip inputs the output flags self-adjointness:

```
/conj ^v
Hermitian adjoint (H†):
·   input: ^v
·   H  = ^v   (n=2)
·   H† = ^v   (reversed + parity-flipped)
·   self-adjoint (H = H†): ✓
·   H || H† balanced: ✓  (E + E† ≡ ZFA)
·   member of Σ_sa  → fixed locus of QLF adjoint involution
·   (counterpart of Re(s)=1/2 in Riemann ξ;  see ReverseMathematics §4.9)
```

Self-adjoint histories `Σ_sa = {H : H = H†}` form the operator-side counterpart of the Riemann ξ critical line — see [ReverseMathematics §4.9](https://github.com/rhovision-org/quantum-logical-framework/blob/main/ReverseMathematics.md). The vacuum-alignment principle in [VacuumEnergy §6](https://github.com/rhovision-org/quantum-logical-framework/blob/main/VacuumEnergy.md) reads the adjoint operator as the framework's negation; under [Magic_numbers.md](https://github.com/rhovision-org/quantum-logical-framework/blob/main/Magic_numbers.md) the same adjoint structure drives the vacuum-as-intruder selection in nuclear shells.

Lean anchors: [`Twist.conj`](https://github.com/rhovision-org/quantum-logical-framework/blob/main/lean/QLF_TwistAlphabet.lean) · [`vacuum_alignment_selects_zfa`](https://github.com/rhovision-org/quantum-logical-framework/blob/main/lean/QLF_VacuumAlignment.lean) · [`global_alignment_selects_zfa`](https://github.com/rhovision-org/quantum-logical-framework/blob/main/lean/QLF_VacuumAlignment.lean) · [`rho_process_alignment_saturates`](https://github.com/rhovision-org/quantum-logical-framework/blob/main/lean/QLF_RhoProcessBridge.lean)

### `/coupling [<twists> …]`

Classifies a **joint** closure by how its parts relate to it. With arguments it classifies the histories you give it, one part per argument. With no arguments it cuts the room along **what peers put on the table with `/qlf-action`** — one part per contributor, latest proposal each.

The room process is ZFA-balanced *by construction* — `rho_process_always_zfa` is a theorem about the constructor, so it holds of every room and therefore distinguishes nothing. Cutting the join into one factor per contributor is what makes the balance carry information. Exactly one of four things is true:

| verdict | meaning |
|---|---|
| **open** | the join does not close at all — there is no event |
| **independent** | every part closes on its own — several closures that happened side by side, not one |
| **product** | no part closes alone, yet each folds to a Pauli scalar — separable, `σ ⊗ I` and `I ⊗ σ` reproduce it |
| **coupled** | some part neither closes nor folds to a scalar — only the join closes |

**Coupled** is QLF's `SharedClosure`: the parts are not separately describable, and indexing them as independent subsystems cannot reproduce the join — it is a genuine Pauli string. In a room that is the difference between *"we decided this together"* and *"we each happened to be fine."*

```
/coupling ^ v
/coupling: parallel(^, v)
  ^  ^  — open
  v  v  — open
  verdict: coupled
    only the join closes — a shared closure (QLF's entanglement)
    census baseline: 80.3% of shared closures are coupled
```

In a room the parts are contributions, so the workflow is: each peer proposes a
history, then anyone asks how they combined.

```
Ana:  /qlf-action ^
Ben:  /qlf-action v
      2 proposals on the table — /coupling to see if they form one shared closure
      /coupling
      /coupling: parallel(Ana, Ben (you))
        verdict: coupled
```

The parts are deliberately **not** the peers' capability tokens. A token is a
random identity bearer minted against the aggregate predicate — it says nothing
about what its holder contributed, and joining tokens returns `open` ("no event")
for essentially every real room. A history someone chose and typed is a
contribution, so a join of two proposals closing means they built one closure
together.

The gauge pair splits the other way — `/coupling + -` is **product**, because `+` and `-` each fold to a scalar alone. That contrast is the point: the axis pair `^v` is ER=EPR's primordial entanglement witness and the gauge pair is not, so indexing cannot simply replace concatenation.

The sectors are not a heuristic. They are the same cut-and-classify the QLF census performs over every balanced history, so a room's verdict has an exact baseline to read against: of all shared closures cut from a balanced history, **80.3%** are coupled rather than product (0.750, 0.791, 0.804, 0.803 at lengths 2, 4, 6, 8 — nearly flat, so the comparison does not depend on picking a length). `crates/zfa-core/tests/census_conformance.rs` re-derives those sector counts from the kernel and requires them to match the census exactly.

Rust: [`crates/zfa-core/src/coupling.rs`](../crates/zfa-core/src/coupling.rs) · census: [`data/census_inventory.json`](https://github.com/jimscarver/quantum-logical-framework/blob/main/data/census_inventory.json) in QLF · Lean anchors: `QLF_IndexedFactors.phase_factorizes`, `count_balanced_pauli_closed`

### `/search [position]` [shared]

The admissible **next closures** from a QuCalc position — the twist words you can
append so the whole history is a ZFA closure — **computed in your browser**
(`qucalc-enum.ts`, a port of the QLF reference
[`qucalc_search.py`](https://github.com/rhovision-org/quantum-logical-framework/blob/main/QucalcSearch.md),
run in a Web Worker so a deep sweep doesn't hitch the UI). No server, no
endpoint: every peer runs the same algebra.

**The search is the experiment — truth divination.** It is not a lookup: all
admissible histories exist *a priori* as pure possibility, and the enumeration is
the generative act — it asks the substrate *which of them close from here*. Truth
in QLF is what closes, a closure receipt rather than a standing proposition, and
`--events` makes that literal (each branch reported at its first closure — the
future is un-rendered possibility; the search renders a slice of it). This is the
possibility step of the [quantum problem solver](../Collective_Optimization.md) made
literal.

```
/search ^<v>+-              next closures from an explicit position
/search @plan               … from a named lemma (or  /search cap:token)
/search                     concurrent search over every peer's /qlf-action proposal
/search --possibilities     every closure within depth (default is --events: first per branch)
/search --depth 6 --full    stream every continuation, not just the rollup
/search --no-save           don't turn the events into lemmas
```

**Discovered events are kept.** Each new closure an `events` search finds is
registered as a room **lemma named with an integer** in discovery order (`@1`,
`@2`, …), so a re-run finds them already known rather than anonymous — the room
accumulates the truths it has divined. Bounded (default 32 per search, raise with
`--save-cap N`); `@N` works in any command (`/qucalc @7`), and they sync to peers
like any lemma. The room's lemma store **is** the closure cache — a re-run finds
its own past discoveries already named, with no service to hold them.

Default output is a rollup — closures per Pauli phase, per appended-twist depth,
and per **listening horizon** (`capacity:R` — how many closures a horizon of
reach `R` hears).

**Bare `/search` is a meeting of minds.** One enumeration runs over *every* peer's
`/qlf-action` position at once, with shared listeners: peers contribute their
positions into the room, the listeners are the room's joint reading, and the
result is broadcast — the room reading its own possibility space as one
distributed experiment ([QLF_as_Intelligence §8](https://github.com/rhovision-org/quantum-logical-framework/blob/main/QLF_as_Intelligence.md);
peers as Markov-blanket sub-agents). `capacity:R` gives each peer's reach on the
*same* census — one possibility structure, heard by horizons of different capacity.

The enumerator is a pure function of the ZFA kernel — it holds no room state and
nothing leaves your browser. It gates on QLF's per-axis count balance (the signed
action vector vanishing), matching the reference exactly, not the app's weaker
aggregate check. Core: [`packages/browser/src/qucalc-enum.ts`](../packages/browser/src/qucalc-enum.ts);
`test/qucalc-search.test.mjs` holds a conformance block against `qucalc_search.py`.

### `/solve [position]` [shared]

The complement of `/search`. **`/search` renders every way to close (the
experiment); `/solve` finds the solution, or the path to it** — it picks the
*one* closure the substrate takes and hands you the continuation that reaches it.

```
/solve ^</>+          the least-free-action completion of a partial position
/solve @7            … of a stored history, or  /solve cap:token
/solve               complete the room's joined /qlf-action proposals
/solve ^</>+ --all   the ranked shortlist, not just the winner
```

Selection is a **deterministic cascade**, so every peer computes the same path
(joiner-local, like the `/poll` tally):

> least peak excursion → shortest → phase `+1` → lexicographic

Peak excursion is how far the walk strays from ZFA balance — the least-free-action
reading, the path an ordinary listening horizon can follow. `/solve` **widens the
horizon** until something closes. If nothing does within reach, it reports the
**residual**: the exact action vector `(v,h,d,l)` a completion still owes, a
concrete continuation that count-balances it, and whether the closure is simply
deeper than the depth-7 horizon or off any short path — *"on a path to closure,
but a deep one"* rather than a bare failure.

The chosen path is saved as an integer-named lemma (like a `/search` event) and
broadcast. Like `/search`, it runs locally — no service.

### `/grant [label]` [shared]
Mints a fresh ZFA-balanced capability token with the given label, broadcasts it to all peers, and **automatically registers it as `@label` in your local lemma store** so you can immediately `/pass label peer` without any further setup.
```
/grant fork-b
```
Output (you see):
```
granted: cap:fork-b:024602460246024602460246…
  twists: 32  (16 pos, 16 neg)  ZFA-balanced: ✓
  registered as @fork-b — use /pass fork-b <peer> to transfer
```
Output (peers see):
```
· Plato  /grant fork-b
·   cap:fork-b:024602460246024602460246…
·   run /zfa cap:fork-b:… to verify
```

### `/lemma <claim> [| <twists>]` [shared]
Names a logical claim so peers can reference it by `@name` in any command. Lemmas sync to all peers when registered and persist to `localStorage` per room URL — they survive page reloads.

- `/lemma` — list all registered lemmas in the room
- `/lemma <claim>` — write the claim as a sentence and mark one word as the handle with `@`: `/lemma All men are @mortal` registers `@mortal`, keeps the sentence as the shown text, and auto-allocates twists deterministically from the handle (every peer gets the same twists — no server)
- `/lemma <claim> | <twists>` — supply twists explicitly after a pipe (symbolic `^v<>/\+-`, hex `0-7`, `cap:token`, or `@ref1 @ref2` to compose)
- Also works: a bare multi-word name (`/lemma socrates is a man` → `@[socrates is a man]`), a leading handle (`/lemma @concl Socrates is mortal | @mortal @man`), and the older forms `/lemma name twists` and `/lemma [name with spaces] twists`
- `@name` anywhere in `/qucalc` args — expand and compose named lemmas

When the twist sequence is ZFA-balanced, a `cap:name:hex` capability token is auto-minted and shown. The Lemmas panel in the sidebar lists each handle (with its claim text) as a clickable item — click `@name` to prefill `/qucalc @name`.

Write the claim as a sentence, mark the handle (simplest form):
```
/lemma All men are @mortal
```
Output:
```
· lemma registered: @mortal  =  <auto>  (auto-allocated)
·   “All men are mortal”
·   twists: 12  (6+/6-)  ZFA: ✓
·   cap: cap:mortal:…  (share with /zfa to verify)
```

Or supply explicit twists after a pipe:
```
/lemma All men are @mortal | ^v
```
Output:
```
· lemma registered: @mortal  =  ^v
·   “All men are mortal”
·   twists: 2  (1+/1-)  ZFA: ✓
·   cap: cap:mortal:01  (share with /zfa to verify)
```

```
/lemma @socrates Socrates is a man | +-
```
Output:
```
· lemma registered: @socrates  =  +-
·   “Socrates is a man”
·   twists: 2  (1+/1-)  ZFA: ✓
·   cap: cap:socrates:67  (share with /zfa to verify)
```

Chain lemmas to prove the conclusion from the two named premises:
```
/lemma @concl Socrates is mortal | @mortal @socrates
```
Output:
```
· lemma registered: @concl  =  ^v+-
·   “Socrates is mortal”
·   twists: 4  (2+/2-)  ZFA: ✓
·   cap: cap:concl:0167  (share with /zfa to verify)
```

List the full proof vocabulary:
```
/lemma
```
Output:
```
· lemmas (3):
·   @mortality  =  ^v     [cap: cap:mortality:01]   (by Alice)
·   @socrates   =  +-     [cap: cap:socrates:67]    (by Bob)
·   @mortal     =  ^v+-   [cap: cap:mortal:0167]    (by Alice)
```

See [SyllogismDemo.md](../SyllogismDemo.md) for the full collaborative walkthrough.

### `/request <name>` and `/pass <name> <peer>` [direct]

Transfer a named lemma (and its capability token) directly between peers — no token strings to copy.

- `/request name` — broadcasts that you need `@name`; whoever holds it sees a prompt with the exact `/pass` command to respond
- `/pass name peer-name` — transfers `@name` to the named peer via their data channel; removes it from your lemma store; the recipient auto-registers it

```
Aristotle:  /request fork-b
```
Plato sees:
```
· Aristotle requests @fork-b
· you hold @fork-b — type /pass fork-b Aristotle to transfer
```
Plato types:
```
/pass fork-b aristotle
```
Output on Plato's side:
```
· @fork-b transferred to Aristotle — removed from your lemmas
```
Aristotle's window automatically shows:
```
· @fork-b received from Plato  [cap: cap:fork-b:…]
· run /zfa cap:fork-b:… to verify
```

`/pass` always requires explicit consent — the holder must type the command. `/request` is a broadcast signal, not an automatic transfer. The Dijkstra ordering protocol in [DiningPhilosophersDemo.md](../DiningPhilosophersDemo.md) shows these commands in a concurrency context.

### `/note [sub]` [direct]

Promissory notes as ZFA twist sequences. A note is a bearer capability `cap:note-<currency>:<balanced hex>` whose **denomination equals `hex.length / 2`**. Conservation falls out of the existing ZFA balance invariant — split partitions a balanced sequence into two balanced halves, merge concatenates two balanced sequences, and the per-currency denomination total is exactly the sum of positive twists across all held notes of that currency.

Lifecycle modeled on DarkWow's TokenMint → Mint → Transfer → Redeem, implemented over the room's data channel with no ZK, Pedersen, or consensus.

| Subcommand | Effect |
|---|---|
| `/note declare <currency>` | Mints `cap:token-<currency>:…` as your issuer authority and broadcasts the declaration to the room. |
| `/note grant <currency> <N>` | Requires you to hold `cap:token-<currency>`; mints `cap:note-<currency>:hex(2N)` and stores it locally. The denomination-N note never leaves your wallet (no bearer-token broadcast). |
| `/note pass <currency> <N> <peer>` | Finds a held note ≥ N (auto-splits if larger), direct-sends the N-piece to the peer. Atomic: removed from your wallet, registered on the recipient's. |
| `/note redeem <currency> <N> <issuer>` | Direct-sends a note back to the issuer; their handler verifies they hold the matching `cap:token-…`, mints `cap:receipt-<currency>:hex(2N)` back to you, and logs the redemption locally. |
| `/note split <token> <a>` | Partitions a held note into denominations `(a, N−a)`; both halves stay balanced by construction. |
| `/note merge <t1> <t2>` | Concatenates two notes of the same currency. Sum of balanced is balanced. |
| `/note list` / `/note balance [currency]` | Wallet view (also rendered in the sidebar). |

The **Currencies** and **Notes** blocks in the sidebar show held authorities and notes at a glance. Click a currency to prefill `/note grant`; click a note to prefill `/note pass`. Currencies you didn't issue appear with the issuer's label and prefill `/note redeem`.

Example flow (two peers Alice and Bob):

```
Alice:  /note declare USD
        /note grant USD 100
Alice:  /note pass USD 30 Bob
Bob:    /note redeem USD 30 Alice
```

After this sequence: Alice's wallet holds USD 70 (change) and a `redemptionsHonored` log entry; Bob holds `cap:receipt-USD:hex(60)` — a permanent, non-transferable record that Alice honored a USD 30 redemption.

**Conservation**: every operation preserves `count_pos == count_neg` per token. Splitting/merging never changes the total denomination of a wallet. The same Lean invariant that proves `rho_process_always_zfa` covers split (partition of a balanced sequence) and merge (parallel composition of balanced sequences).

**Privacy boundary**: declarations and grant *announcements* broadcast (so the room knows what currencies exist and who issues them). Held notes, receipts, and the issuer's redemption log are private — never sent without an explicit `/note pass` or `/note redeem`.

**Lifecycle vocabulary borrowed from [Patrick Mockridge's DarkWow promissory note contract](https://codeberg.org/PatrickM123/darkwow/src/branch/linear-master/doc/src/contract/promissory_note.md)** — DarkWow implements TokenMint → Mint → Transfer → Redeem as a privacy-preserving DeFi contract on a Halo2/Pallas zk-rollup. quantum-os implements the same algebraic shape over a per-room WebRTC data channel, with **conservation enforced by ZFA twist balance** instead of Pedersen commitments — no zk circuits, no global ledger. See [PromissoryNoteDemo.md](../PromissoryNoteDemo.md) for the full walkthrough.

### `/rdv [sub]` [direct]

N-party atomic rendezvous: a single composite move across N participants, with ZFA conservation enforced over the joint composition. Each participant contributes a `gives` token and receives a `gets` token; the protocol requires `multiset(gives) == multiset(gets)` — value flows in a closed cycle. The MVP exposes the 2-party bilateral swap (`/rdv swap`); the underlying protocol generalizes to N parties (cyclic).

Protocol (6 direct-send wire kinds, never broadcast):

```
rdv-propose  proposer    → each participant   (carries the proposal)
rdv-accept   participant → proposer           (carries the committed gives token)
rdv-reject   participant → proposer
rdv-counter  either      → either             (round-trip negotiation; new terms + new token)
rdv-commit   proposer    → each participant   (carries final assignments)
rdv-abort    proposer    → each participant   (releases locks)
```

| Subcommand | Effect |
|---|---|
| `/rdv swap <giveCur> <giveN> <getCur> <getN> <peer>` | Locks your gives token, sends a proposal to the peer, sets a 60s timeout. |
| `/rdv counter <id> <giveCur> <giveN> <getCur> <getN>` | Propose new terms in an in-flight rdv. Releases the round's locks; replaces the rows; locks your new gives; counterer is implicitly accepted, other party reset to pending. Either party can counter again; rounds repeat until accept/reject/abort/timeout. |
| `/rdv accept <id>` | Locks your gives token. As a participant, sends accept to the proposer. As proposer-after-counter, locally records acceptance — if all parties now accept, commit fires. |
| `/rdv reject <id>` | Declines; the proposer aborts the proposal and releases all participant locks. |
| `/rdv abort <id>` | Proposer cancels; sends `rdv-abort` to participants. |
| `/rdv list` | Shows pending proposals and currently locked notes. |

**Locking**: while a token is locked for a proposal it moves out of `noteStore` (so `/note pass`, `/note redeem`, etc. don't see it) into a separate `lockedNotes` map. Released back on abort / reject / timeout; consumed on commit (replaced by the gets token).

**Atomicity caveat**: best-effort, same trust model as `/note pass`. If a commit message is lost in flight, the recipient who got it diverges from the one who didn't. True multi-party atomicity needs a consensus layer, which is out of scope.

See [AtomicSwapDemo.md](../AtomicSwapDemo.md) for a full Alice/Bob walkthrough — proposal lifecycle, locking, failure modes. The N-of-N multisig discussion lives in its own demo: [MultisigDemo.md](../MultisigDemo.md) shows 2-of-2 cosignature using `/dyncap` + `/rdv` (atomic exchange of dyncap-signed attestation tokens). K-of-N threshold multisig needs either a threshold conservation predicate or signature-strength identity beyond what hash-only dyncap provides.

### `/dyncap [sub]`

Hash-only dynamic capabilities. Each peer keeps a private 32-byte `seed` (per-device, persisted to `localStorage` outside the per-room namespace) and publishes `anchor = H(seed)` at name-handshake. Each signable envelope gains a `dyncap` field carrying `{anchor, seq, witness}`, where `witness = H(seed || seq_le32 || room_id_bytes || payload_hash)`.

Uses only `crypto.subtle.digest("SHA-256", …)` — browser built-in, no external library, no keypairs, no signatures.

| Subcommand | Effect |
|---|---|
| `/dyncap status` (or just `/dyncap`) | Show your anchor, current seq, and number of tracked peer chains. |
| `/dyncap peers` | List tracked peers with their TOFU-pinned anchors and last-seen seq; flags `⚠ CONTESTED` if a fork was observed. |

Outbound signing is wired into the highest-value envelopes: `name` (TOFU bootstrap on each new data channel), `lemma`, `note-declare`, and the `sync-lemmas` / `sync-currencies` envelopes (whose entries forward their original signer's dyncap).

Trust ceiling: this is **TOFU plus chain-tamper / replay / fork detection**, not signature-strength identity. Receivers cannot mathematically verify a witness was correctly derived from `seed` — they treat it as opaque-unique per `(anchor, seq)`. Two valid envelopes at the same `seq` under the same anchor are a fork: the peer's identity is flagged contested and the user is warned. The deliberate trade is that the QLF algebra remains the security model; identity is extended via continuity rather than borrowing a separate asymmetric primitive.

See [MultisigDemo.md](../MultisigDemo.md) for a worked example combining `/dyncap` with `/rdv`.

### `/probe [sub]`

Joiner-local consensus probe — partial Byzantine-leaning resolution layered on top of the existing room-state sync. On `onSignalingOpen`, opens a probe window for `PROBE_WINDOW_MS` (5 s) that collects inbound `sync-lemmas` / `sync-currencies` envelopes from up to `SAMPLE_SIZE` (5) distinct peers. On close, for each contested key, the probe tallies a chain-weighted vote: each peer's vote weight is their dyncap `lastSeq` (floor 1), and the winning value must clear a strict `SUPERMAJORITY_NUM / SUPERMAJORITY_DEN` (2/3) of the total weight. Below threshold, `winner === null` and the key remains contested but is broadcast for the room's benefit; the joiner keeps their own local value. Above threshold, the joiner adopts the winner and adds the peers behind every losing bucket to `ignoredForSync` — their subsequent sync envelopes are silently dropped.

| Subcommand | Effect |
|---|---|
| `/probe status` (or just `/probe`) | Show the probe window state and the per-room ignored-for-sync peer list. |
| `/probe clear` | Clear the ignored-for-sync set (e.g., after manual reconciliation). |

This is **not** classical BFT — there's no global agreement, no finality, no resolution that binds non-joining peers. Each new joiner reaches their own decision independently. The probe raises the attacker cost (sync forgery now needs supermajority weight, not first-arrival) but doesn't prove tolerance against coordinated, aged-identity Sybils. See [Consensus.md](../Consensus.md) for the full protocol specification, threat analysis, and comparison with classical BFT.

Lemmas are now content-addressed by name: `/lemma X ^v` refuses to re-declare `@X` with different twists, both locally and on inbound broadcast. The probe relies on this so that disagreement reflects genuine partition (or forgery) rather than accidental overwrite.

Example flow (Alice has USD 100, Bob has EUR 100):

```
Alice:  /rdv swap USD 30 EUR 20 Bob
        → · proposed rendezvous a3f1c2…  expires in 60s
Bob:    /rdv accept a3f1c2
        → · accepted rendezvous a3f1c2 — locked EUR 20; awaiting commit…
Alice:  → · committed rdv a3f1c2
Bob:    → · rdv a3f1c2 settled
```

After settlement: Alice holds USD 70 + EUR 20, Bob holds EUR 80 + USD 30. Both wallets total identical-denominated value to before; only the assignment changed.

**Sync on join**: when a new peer joins, every existing peer sends them a snapshot of `lemmaStore` and the room's currency registry (`knownCurrencies`) over each new data channel. Late joiners see currencies declared before they arrived; they do *not* see held notes, receipts, or in-flight rendezvous proposals — only room-knowledge stores are gossiped.

### `/id`
Shows your ZFA-balanced peer identity and confirms the `rho_process_always_zfa` invariant holds.
```
peer ID: cap:peer:024602460246024602460246…
  twists: 32  (16 positive, 16 negative)
  ZFA-balanced: ✓  spectral gap: 0
  rho_process_always_zfa: ✓ (Lean-verified)
```
Lean anchor: [`rho_process_always_zfa`](https://github.com/rhovision-org/quantum-logical-framework/blob/main/lean/RhoQuCalc.lean)

### `/room [sub]`

Multi-room tabs. A single browser session can be joined to N rooms simultaneously, each in its own tab across the top of the UI. Each room is a separate Markov blanket — independent peers, lemma store, currency registry, notes, dyncap chain, consensus probe, and signaling connection. The room you're looking at is the *uiActive* room; background tabs continue to receive and process their own envelopes, with state mutations correctly routed via per-callback context capture (no cross-talk between rooms). Activity in a background tab surfaces as an orange `●` indicator on its tab.

| Subcommand | Effect |
|---|---|
| `/room` or `/room list` | Show the active room's cap-token + twist stats, plus a list of joined rooms with their connection (`●`) and active (`←`) markers. |
| `/room join <cap:room:…\|url>` | Open a new tab joined to the named room. Accepts a raw cap-token or a share URL. The new tab is created but does not auto-connect — click Connect to bring up signaling. |
| `/room leave` | Close the active tab. The room's state stays in `localStorage` so re-joining picks up where you left off; the connection is dropped. Can't close the last remaining tab. |
| `/room ref [cap:room:…]` | Print a shareable URL for the active room (or the given cap). |

Joined rooms persist across reloads (`qos-joined-rooms` in `localStorage`); on next launch the same tabs are restored, with the URL-hash room re-activated. The `+` button on the tab bar prompts for a room cap or URL.

**Markov-blanket constraints** (deliberate):
- No cross-room signaling backchannel — each room has its own `QOSPeer` and signaling WebSocket.
- No cross-room state sync — a lemma declared in one room doesn't auto-propagate to others.
- No cross-room consensus — the probe runs per-room.
- Cross-room information flow is mediated by a peer who's in both rooms (a "bridge peer"); they consciously re-broadcast in each room. There's no automatic `/share` command yet — manual re-declaration is the bridge primitive today.

A peer in N rooms has the same dyncap *anchor* across rooms (it's `H(seed)` where seed is per-device), but each room maintains an independent chain trajectory via per-room `seq` in `DynCapState.seqByRoom`. The witness binding `H(seed ‖ seq ‖ room_id ‖ payload_hash)` produces algebraically independent witnesses across rooms.

### `/share <selector> to <room-prefix>`

Bridge selected state from the active tab into another joined tab. The bridge is application-level: `/share` briefly swaps the active room context to the target room and runs the existing dispatcher commands there. The target room sees the action as if the user typed it locally — including the bridge peer's dyncap signature in *that* room's chain. No new wire kinds; no infrastructure relay.

| Selector | Effect in target |
|---|---|
| `@<lemma-name>` | re-declare the lemma. Lemma immutability applies (same twists → silent no-op; different twists → refused) |
| `msg <text>` | post a chat message |
| `note <currency> <N>` | `/note grant <currency> <N>` (target room must hold the currency authority) |

Target resolution: `<room-prefix>` prefix-matches against joined room IDs. Ambiguous matches are listed; no match errors out.

### Cooperating across rooms

Each room is its own Markov blanket — a self-consistent **perspective**. Information crosses between rooms only through something that stands in both. Multi-room cooperation happens at three levels:

- **Many rooms, one session** — `/room` opens each room as its own tab, each an independent blanket (its own peers, lemmas, currencies, dyncap chain). Holding several tabs makes *you* the link between them.
- **Move an item between your own tabs** — `/share <selector> to <room>` re-enacts a lemma / note / message in another of your joined rooms, signed into *that* room's chain.
- **Link separate rooms** — the headless **room bridge** ([`scripts/qos-cli/bridge.mjs`](../scripts/qos-cli/bridge.mjs)) is one perspective that stands in two or more rooms and relays each room's outputs as the others' inputs: channels and chat, plus (opt-in) durable **lemma** and **governance** state relayed verbatim so signatures carry through. That shared membership *is* the shared closure between the rooms — **ER=EPR at the collaboration layer**. See [`Room_Bridges.md`](../Room_Bridges.md).

### `/channel [sub]`

Name-tagged broadcast messaging with per-receiver filtering. The envelope (`kind: "channel-msg", {channel, payload}`) goes to everyone in the room; subscribed peers surface it in chat, unsubscribed peers silently drop it. Subscriptions are per-room and persist across reloads (`qos-channel-subs-{room}` in localStorage).

| Subcommand | Effect |
|---|---|
| `/channel list` (or `/channel`) | Show your subscriptions in the active room |
| `/channel listen <name>` | Subscribe |
| `/channel unlisten <name>` | Unsubscribe |
| `/channel send <name> <text>` | Broadcast a tagged message |

Useful for topic-based coordination on top of broadcast — e.g., one channel per long-running discussion, or as the substrate for higher-level macro languages (rho-calculus channels).

### `/script <cmd1>; <cmd2>; …`

Sequential command chain. Each `;`-separated segment is trimmed and run through the dispatcher exactly as if typed individually. Segments starting with `//` are skipped (comments). Errors in one segment don't stop subsequent ones; each segment's output appears in chat in order.

```
/script /grant fork-a; /lemma alice-thinking; /qucalc @alice-thinking
/script /note declare USD; /note grant USD 100; // /note pass USD 30 Bob
```

The MVP is single-line. Multi-line scripts and variable binding are deferred.

### `/persist [sub]`

Agreed cross-peer replication of public room state. A peer asks another to also store a lemma or currency declaration; the receiver explicitly accepts or rejects. Both peers then hold redundant copies across sessions. The existing consensus probe + chain-weighted supermajority resolution reconciles any drift on the next join.

| Subcommand | Effect |
|---|---|
| `/persist @<lemma> to <peer>` | Ask peer to also store the lemma |
| `/persist currency <name> to <peer>` | Ask peer to also store the currency declaration |
| `/persist accept <id>` | Accept a pending inbound request |
| `/persist reject <id>` | Discard a pending inbound request |
| `/persist [list]` | Show pending inbound requests |

Bearer state (held notes, receipts, redemption logs) is excluded by design — replicating a bearer token means giving away ownership, which is what `/note pass` already does. `/persist` applies only to public room knowledge.

The "persistence" is "as long as one of the replicating peers is online" — there's no server, no eternal storage. Multiple agreeing copies are the agreement-based mechanism.

### `/rhoqu <text>`

RhoQu macro language — a thin syntactic surface that compiles to the shipped slash commands. The body is parsed by `packages/browser/src/rhoqu.ts` into an AST and transpiled to a `string[]` of `/commands`, each dispatched in order through the regular handler.

| Construct | Meaning |
|---|---|
| `process name(args…) { body }` | Define a parameterized macro. Calls inline at call site with substituted `$arg`s. |
| `name(…); name(…);` | Sequential calls (or any sequence of `/commands` separated by `;`). |
| `s1 \| s2 \| s3` | Parallel composition — each statement is grouped as a parallel block; on a single peer the group still executes sequentially, but the `\|` records "no ordering dependency." |
| `if cond { … } else { … }` | Transpile-time branch. Conditions evaluate against current room state: `bal(@name)`, `peers`, `connected`, `seq`, `hasLemma(@name)`, plus `==`, `!=`, `<`, `<=`, `>`, `>=`, `and`, `or`, `not`. |
| `on channel(payload) { body }` | Register a `/channel` dispatcher: when an inbound `channel-msg` on `channel` arrives, bind `payload` to its text and execute `body`. Survives across messages until `/rhoqu clear`. |
| `new name in { body }` | Mint a fresh `cap` named `name`, bind for the lexical body, broadcast as a lemma. |
| `for x in [a, b, c]: stmt;` | Unroll a list at transpile time. |
| `$var` | Substitute a process-parameter or `for`-bound value. |

Sub-commands:

| Subcommand | Effect |
|---|---|
| `/rhoqu <text>` | Parse, transpile, and dispatch the body. |
| `/rhoqu list` | List registered `on` handlers in the active room. |
| `/rhoqu clear` | Drop all registered handlers. |

Example (parallel grant + immediate dispatch):
```
/rhoqu process setup(label, p1, p2) { /grant $label; /pass $label $p1 | /pass $label $p2; } setup(fork-a, Alice, Bob);
```

Example (transpile-time guard):
```
/rhoqu if bal(@attest-alice) >= 1 and bal(@attest-bob) == 0 { /rdv swap attest-alice 1 attest-bob 1 Bob; }
```

Example (on handler):
```
/rhoqu /channel listen orders; on orders(text) { /qucalc $text; }
```

See [RhoQuDemo.md](../RhoQuDemo.md) for worked end-to-end demos (atomic swap with conditional accept, Dining Philosophers, multisig with persistence).

### `/zfa [token]`
Validates any `cap:label:hex` token — checks ZFA balance and reports the spectral gap.
```
/zfa cap:room:024602460246024602460246…
  valid: ✓  spectral gap: 0
  twists: 32 (16 positive, 16 negative)
```
Lean anchor: [`achieves_ZFA`](https://github.com/rhovision-org/quantum-logical-framework/blob/main/lean/QLF_Axioms.lean)

### `/cap [label]`
Generates a fresh ZFA-balanced capability token locally (not shared).
```
generated: cap:peer:024602460246024602460246…
  twists: 32  (16 pos, 16 neg)  ZFA-balanced: ✓
```
Rust source: [`crates/zfa-core/src/capability.rs`](../crates/zfa-core/src/capability.rs)

### `//message`
Sends a literal message that starts with `/` (escapes the command prefix).

---
