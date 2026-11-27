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
  /qos [sub]       — named QOS processes: start · status · suspend · resume · terminate
  /ps              — QOS process table (pid · name · state · events · owner)
  /kill <name|id>  — terminate a QOS process you own (owner-only alias)
  /ask <question>  — ask the room's AI agent (facilitator first; reports if none is present)
  /agent [add|grant|fork|revoke] — who's here, add an AI agent (your own key or plan), or fork yours into another room
  /goal [sub]      — private personal goals: add · list · done · review · share
  /probe [sub]     — joiner-local consensus probe (status|clear)
  /room [sub]      — multi-room tabs (new [name]|name [name]|list|join <cap>|leave|ref)
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
**terms-stamped** note (`cap:note-USD~<hash>`); the issuer's terms are dyncap-attributed and
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

See [AtomicSwapDemo.md](../AtomicSwapDemo.md) for a full Alice/Bob walkthrough — proposal lifecycle, locking, failure modes. The N-of-N multisig discussion lives in its own demo: [MultisigDemo.md](../MultisigDemo.md) shows 2-of-2 cosignature using `/dyncap` + `/rdv` (atomic exchange of dyncap-attributed attestation tokens). K-of-N threshold multisig needs either a threshold conservation predicate or signature-strength identity beyond what hash-only dyncap provides.

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

### `/ask <question>`

Finds a **live** AI agent in the room and relays `/<role> ask <question>` as chat. Preference is the **facilitator** (`/facil ask …`) when one is present; otherwise the lowest-peer-id other present agent. The agent badge cache is filtered by the live peer roster, so a departed agent is not chosen. If no agent is present, it says so and sends nothing — it never pretends to have an answer locally. The chosen agent is addressed by its role prefix; the line is still room chat, so every peer sees it. The browser only picks the agent; it does not vouch for it, and the agent answers for itself.

Direct addressing is not limited to the built-in roles. If a live peer announced a custom role such as `heckler`, `/heckler help` (or any `/heckler …` line) is relayed exactly like `/skeptic …`. If `heckler` is the agent's display name but its role is `skeptic`, the browser relays `/skeptic …` to that agent instead. The lookup uses the live `peers` roster, not the sticky badge cache, so a departed agent does not become a phantom command.

### `/agent`: AI agents in the room

Getting an AI agent into the room. An agent is a headless peer (`scripts/qos-cli/agent.mjs`) that must run on *some* computer, so the browser cannot start one — but it can reduce that to one paste.

- `/agent` lists the live agents (filtered by the roster, like `/ask`) and the command each answers to.
- `/agent add [role] [name]` copies **one shell line** with this room already in it: it keeps its own checkout under `~/.qos-agents/quantum-os` (cloned once, `git pull`ed after), then runs [`scripts/qos-cli/add-agent.sh`](../scripts/qos-cli/add-agent.sh), which installs dependencies on first run, picks the AI backend it can use (the `claude` CLI → your Claude plan; else `ANTHROPIC_API_KEY`; else the built-in FAQ only), keeps the room's memory (`--persist`), starts the agent detached and waits until it has joined. A room on a non-default signaling server gets `SIGNAL=` added.
- `/agent claude [role] [name]` copies the same request worded for a Claude Code session, for someone with no terminal ([docs/agents-from-claude.md](agents-from-claude.md)).
- `--ai claude|anthropic|deepseek|none` names the model provider — each a plugin in [`scripts/qos-cli/ai-providers/`](../scripts/qos-cli/ai-providers/README.md), where your own can be added — and `--model` a model. They reach `add-agent.sh` as `AI=`/`AI_MODEL=`. A provider's key (`DEEPSEEK_API_KEY`, `ANTHROPIC_API_KEY`) is read from the agent machine's environment; the copied line never carries one, and the room never sees one. With no `--ai`, the script picks: `claude` CLI, else `ANTHROPIC_API_KEY`, else `DEEPSEEK_API_KEY`; with none it **stops** and says how to set one up — an agent runs on your own key or plan (`--ai none` starts one without AI on purpose).
- **Skills** are an activity's **rules and context** as a Markdown file. Every agent has the [standard set](../scripts/qos-cli/skills/README.md) (brainstorm, debate, retrospective, story-round, twenty-questions, word-chain) with no flag: in the room `/<role> use <skill>` starts one. `--skill <name>[,<name>]` makes one the starting activity, or adds an absolute path to your own `.md` on the agent's computer. It reaches `add-agent.sh` as `SKILL=` and the agent as `--skill`; the rules ride in every prompt the agent's AI sees, so a skill needs an AI (`--ai none` refuses one). In the room, `/<role> rules` shows them and `/<role> play <move>` takes a turn.
- Roles: `facilitator` (default), `skeptic`, `scribe`, `greeter`, `observer`. A first word that is not a role is the start of the name (`/agent add Socrates`). Names are restricted to letters, digits, space, `.`, `_`, `-` so they quote into the shell line safely.

**Forking an agent into another room.** The browser that ran `/agent add` is that agent's **owner** (an owner capability rides in the copied line's environment). The owner can let someone in a *different* room have a copy:

- `/agent grant [agent] [uses N] [days D]` asks the agent for a **fork grant** (`cap:fork:…`; default 1 use, 7 days; at most 20 and 30), and copies `/agent fork cap:fork:…` to the clipboard to hand on.
- In their own room, the holder runs `/agent fork cap:fork:… [name]`. A copy of the agent joins that room with the same role, skills and AI provider, and **none of the owner's room**: no memory, no chat. It runs on the owner's computer and AI account.
- `/agent grants [agent]` lists grants; `/agent revoke <id> [stop] [agent]` stops new copies, and with `stop` ends the running ones.

The request travels through the room the grant names (the agent listens there), so the requester never needs the owner's room. Detail and limits: [SECURITY.md](../SECURITY.md#room-agents-owner-and-fork-grants-agent-grant--agent-fork), [`fork-host.mjs`](../scripts/qos-cli/fork-host.mjs).

Both outputs carry the room capability. Local only, never broadcast; with the room hidden (`/room hide`) the cap is masked on screen and only the clipboard holds it in full. Pure builder: `agent-invite.ts`, `test/agent-invite.test.mjs`.

### `/goal [sub]`

Private personal goals for the success framework. The store is keyed by the
current dyncap anchor (`qos-goals:<anchor>`); a different identity sees a
different list. `/goal` never broadcasts: `list`, `add`, `done`, `review`, and
`remove` are local-only. `/goal share <id>` is the only network path; it sends
one goal as a signed `goal-share` envelope, which receiving peers verify against
the sender's dyncap before displaying.

| Subcommand | Effect |
|---|---|
| `/goal add <text> [| priority]` | Add a private goal. Priority is `urgent-important` (alias `both`), `important` (default), `urgent`, or `neither`. |
| `/goal list` (or just `/goal`) | Show this identity's goals with ids, status, and priority. |
| `/goal done <id>` | Mark a goal done; the completion time stays local. |
| `/goal review` | Show open/done counts and the open list. |
| `/goal remove <id>` | Delete a goal. |
| `/goal share <id>` | Explicitly share one goal into the room; no other goal is sent. |

A corrupt or unavailable local store starts empty for the session rather than
breaking the room. See [success-frameworks.md](success-frameworks.md) and
`test/goal-store.test.mjs`.

### `/qos [sub]`

Named QOS processes over the finite `qos.event/1` contract. A process is a capability-guarded continuation; start, suspend, resume and terminate are dyncap-attributed events, and every peer recomputes the same deterministic `stateDigest` from the same envelopes. No chain RPC is involved.

| Subcommand | Effect |
|---|---|
| `/qos start <name> [| <question>]` | Start a process you own. The returned process id and initial digest are shown. |
| `/qos status [name|id]` | List known processes, or show one with status, phase, event count, quorum, poll result and full state digest. |
| `/qos suspend <name|id> [| reason]` | Owner pauses a running process. |
| `/qos resume <name|id> [| reason]` | Owner resumes a suspended process. |
| `/qos terminate <name|id> [| reason]` | Owner ends a running or suspended process. |

The command is a thin adapter (`qos-command.ts`); `QosProcessRoom` signs and broadcasts the same object every peer verifies. A peer that only saw the start event can read the state but cannot drive someone else's lifecycle. See [qos-process.md](qos-process.md).

### `/ps`

The OS-style process table over the same tracked QOS processes: pid (short), name, status, event count, and owner. It is the same view as `/qos ps`. A locally started process shows `you`; a peer sees the dyncap-attributed owner label it received. The kernel ABI underneath is described in [os-roadmap.md](os-roadmap.md) and [os-abi.md](os-abi.md).

### `/kill <name|id>`

Owner-only alias for `/qos terminate`. It emits the same dyncap-attributed lifecycle event; a non-owner is refused, and a process that is already terminated cannot be killed again. It is not a remote DOS primitive: there is no ambient process namespace, only processes this peer has observed and for which it holds the owner grant.

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
| `/room new [name]` | Mint a fresh room capability under a name and open it as a new tab. With no name, a dialog asks for one (the same dialog as **+ ROOM → New room…**). The capability is generated locally; share the tab's link to invite someone. The new tab does not auto-connect. |
| `/room name [name]` | Rename the active room; no name opens the dialog. Names are unique among the rooms this browser has joined (a taken name is refused with a suggested alternative), shown in full on the tab, and carried by the invite link (`#/my-room?name=…&room=cap:room:…`). With the cap hidden the address bar shows just `#/my-room`; switching tabs rewrites it without a reload. A name is a label, not a capability: `#/my-room` only opens a room this browser has already joined. |
| `/room` or `/room list` | Show the active room's cap-token + twist stats, plus a list of joined rooms with their connection (`●`) and active (`←`) markers. |
| `/room join <cap:room:…\|url>` | Open a new tab joined to the named room. Accepts a raw cap-token or a share URL. The new tab is created but does not auto-connect — click Connect to bring up signaling. |
| `/room leave` | Close the active tab. The room's state stays in `localStorage` so re-joining picks up where you left off; the connection is dropped. Can't close the last remaining tab. |
| `/room ref [cap:room:…]` | Print a shareable URL for the active room (or the given cap). |

Joined rooms persist across reloads (`qos-joined-rooms` in `localStorage`); on next launch the same tabs are restored, with the URL-hash room re-activated. The `+` button on the tab bar opens a menu with **New room** (mint a fresh capability) and **Join room…** (paste a cap or URL).

**Markov-blanket constraints** (deliberate):
- No cross-room signaling backchannel — each room has its own `QOSPeer` and signaling WebSocket.
- No cross-room state sync — a lemma declared in one room doesn't auto-propagate to others.
- No cross-room consensus — the probe runs per-room.
- Cross-room information flow is mediated by `/share <selector> to <room>` or by a peer who is in both rooms; nothing propagates automatically.

A peer in N rooms has the same dyncap *anchor* across rooms (it's `H(seed)` where seed is per-device), but each room maintains an independent chain trajectory via per-room `seq` in `DynCapState.seqByRoom`. The witness binding `H(seed ‖ seq ‖ room_id ‖ payload_hash)` produces algebraically independent witnesses across rooms.

### `/share <selector> to <room-prefix>`

Bridge selected state from the active tab into another joined tab. The bridge is application-level: `/share` briefly swaps the active room context to the target room and runs the existing dispatcher commands there. The target room sees the action as if the user typed it locally — including the bridge peer's dyncap attribution in *that* room's chain. No new wire kinds; no infrastructure relay.

| Selector | Effect in target |
|---|---|
| `@<lemma-name>` | re-declare the lemma. Lemma immutability applies (same twists → silent no-op; different twists → refused) |
| `msg <text>` | post a chat message |
| `note <currency> <N>` | `/note grant <currency> <N>` (target room must hold the currency authority) |

Target resolution: `<room-prefix>` prefix-matches against joined room IDs. Ambiguous matches are listed; no match errors out.

### Cooperating across rooms

Each room is its own Markov blanket — a self-consistent **perspective**. Information crosses between rooms only through something that stands in both. Multi-room cooperation happens at three levels:

- **Many rooms, one session** — `/room` opens each room as its own tab, each an independent blanket (its own peers, lemmas, currencies, dyncap chain). Holding several tabs makes *you* the link between them.
- **Move an item between your own tabs** — `/share <selector> to <room>` re-enacts a lemma / note / message in another of your joined rooms, attributed into *that* room's chain.
- **Link separate rooms** — the headless **room bridge** ([`scripts/qos-cli/bridge.mjs`](../scripts/qos-cli/bridge.mjs)) is one perspective that stands in two or more rooms and relays each room's outputs as the others' inputs: channels and chat, plus (opt-in) durable **lemma** and **governance** state relayed verbatim so attribution carries through. That shared membership *is* the shared closure between the rooms — **ER=EPR at the collaboration layer**. See [`Room_Bridges.md`](../Room_Bridges.md).

### `/channel [sub]`

Name-tagged broadcast messaging with per-receiver filtering. The envelope (`kind: "channel-msg", {channel, payload}`) goes to everyone in the room; subscribed peers surface it in chat, unsubscribed peers silently drop it. Subscriptions are per-room and persist across reloads (`qos-channel-subs-{room}` in localStorage).

| Subcommand | Effect |
|---|---|
| `/channel list` (or `/channel`) | Show your subscriptions in the active room |
| `/channel listen <name>` | Subscribe |
| `/channel unlisten <name>` | Unsubscribe |
| `/channel send <name> <text>` | Broadcast a tagged message |

Useful for topic-based coordination on top of broadcast — e.g., one channel per long-running discussion, or as the substrate for higher-level macro languages (rho-calculus channels).

#### `/channel chain …` — a channel that outlives the room ([#78](https://github.com/rhovision-org/quantum-os/issues/78))

The room's channels end with the room. These are on chain, in the Channel contract ([RGov_Core.md §4](../RGov_Core.md#4-channel--publish-and-subscribe-on-chain)), so they need a deploy key (`/rholang key generate`) and a node. A channel has one publisher and is named `<publisher address>/<name>`; a bare name means one of your own.

| Subcommand | Effect |
|---|---|
| `/channel chain` | The contract you use, the channels you follow and how far you have read |
| `/channel chain install` · `use <uri>` | Publish a Channel contract, or point at one somebody shared |
| `/channel chain open <name> [invite]` | Open a channel under your address. **open**: anyone reads it, free. **invite**: only you and the addresses you allow can read it through the contract. That gates reading; posts are still plaintext on chain. Any other policy is refused |
| `/channel chain post <name> <text>` | Publish to your channel (signed) |
| `/channel chain close <name>` | No more posts. What was posted stays readable, and readers are told it was closed rather than gone quiet |
| `/channel chain allow\|disallow <name> <address>` | Who may read an invite channel. Disallowing stops their future reads |
| `/channel chain allow\|disallow <name> <address> --write` | Who may post to your channel as well as you. A writer can also read it. Each post shows who wrote it |
| `/channel chain post <address/name> <text>` | Post to somebody else's channel, if its publisher made you a writer |
| `/channel chain subscribe <address/name> [--all]` | Follow a channel: from now, or `--all` from the oldest kept post |
| `/channel chain unsubscribe <address/name>` | Stop following. Only you can end your own subscription |
| `/channel chain read <address/name> [--all]` | What is new since your last read (50 at a time). Free for an open channel; a signed read, which costs phlo, for an invite one. Where you have read up to is kept per node, shard and contract |
| `/channel chain info <address/name>` · `list [address]` | A channel's policy, post count and subscriber count · someone's channels |

A channel keeps its newest 500 posts. Relaying between a room channel and a chain channel is not built.

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


### `/fs` — capability-rooted filesystem (#280)

Start a process with `/qos start workspace`, then `/fs init workspace`.
Use the returned namespace handle on subsequent commands (paths are rooted
inside that namespace, not host paths):

| Command (after `/fs`) | Meaning |
| --- | --- |
| `ls <process> <handle> /` | List a directory and child content IDs |
| `stat <process> <handle> /path` | Inspect metadata, including root and version |
| `mkdir <process> <handle> /dir` | Create a directory |
| `put <process> <handle> /dir/file \| text` | Write immutable UTF-8 file bytes to local cache |
| `put-durable <process> <handle> /dir/file \| text` | Explicitly publish bytes to configured Rholo, verify pinned readback, then commit namespace |
| `cat <process> <handle> /dir/file` | Open a READ-only file handle, verify bytes, close handle |
| `rm <process> <handle> /path` | Unlink a file or empty directory |
| `rename <process> <handle> /old /new` | Copy-on-write rename |
| `mount <process> <handle> /mount <source-handle>` | Attach read-only snapshot of a READ+GRANT source |
| `unmount <process> <handle> /mount` | Detach snapshot |
| `grant <process> <handle> <recipient-pid> <rights-mask>` | Attenuated namespace grant (READ=1, WRITE=2, GRANT=16, REVOKE=32) |

Writes require a live WRITE namespace handle and an observed root hash/version.
File bytes are not journal payloads; the versioned, immutable directory
manifest hashes are computed from sorted child names, kinds and content IDs.
A conflicting speculative receipt is explicitly rejected by canonical replay.
A mount is an explicit read-only snapshot copy, not a live/distributed mount.
Unmount or close references before local collection. Browser checkpoints
persist admission evidence in origin-local storage, scoped by room and identity;
OPFS stores verified bytes, with volatile fallback where unavailable.
Persistence failures are surfaced, not represented as successful durable saves.
The current text command grammar uses whitespace-separated paths; generic binary
I/O and live mounts are not asserted. No automatic Rholo writes.

### `/sh` — bounded deterministic shell (#281)

Create an owned QOS process and namespace using `/qos start workspace` and
`/fs init workspace`, then select the namespace via
`/sh use workspace <namespace-handle>`. The selection is local UI state; cwd,
environment, child processes, stage receipts, and exit status are replayed
from the single canonical journal. After reload re-select the shell.

- `/sh set NAME=value; cd /docs; echo "$NAME" | upper > result.txt`
- `/sh cat < result.txt | lower`; `/sh echo next >> result.txt`
- Builtins: echo, cat (stdin), upper, lower, wc (UTF-8 bytes), pwd, env,
  true, false. Standalone cd, set/export, unset, exit configure the shell.
- `/spawn <pipeline>` queues a child and returns its explicit job capability.
  `/bg <job-handle>` marks it runnable; `/exec <job-handle>` advances one
  cooperative stage or finishes it. `/fg <job-handle>` runs remaining stages.
  `/jobs` lists owned handles, `/wait <job-handle>` reaps an exited child,
  `/kill <job-handle>` sends SIGTERM through the job SIGNAL capability.
  The pre-existing /kill process-name lifecycle alias remains distinct.

Single/double quotes, escapes, variable expansion, pipe, semicolon, and
input/output/append redirection are supported. No globbing, substitution,
dynamic evaluation, host execution, implicit Rholang, binary data, or
arbitrary executables. All pipeline stages execute in source order; the first
non-zero status wins (pipefail). Configuration commands cannot be piped.
Background jobs are cooperatively stepped, not autonomous threads.
Parent exit terminates its active children. Children have only a restricted
EXEC image root, while their parent retains explicitly attenuated control.

Input is read using a live file capability and verified against its content
hash; the bytes (bounded UTF-8 text) become journal observations.
Output redirection is an atomic COW namespace update against the root/version
captured at spawn, with verified local-cache metadata, never an ambient host
path. Append verifies the original bytes. If the root changes, the job exits
non-zero without replacing the new root. Redirection is local-cache only;
durable publication remains an explicit /fs put-durable operation.

Limits: 4 KiB source/expanded pipeline/input/output, eight pipeline stages
and eight semicolon segments, sixteen environment variables of at most
256 UTF-8 bytes, 128 historical jobs per parent. **Shell source, environment,
input observations and stage outputs are visible in room journal data.
Do not put secrets or private file contents through this shell.**

### QOS identity and capability control (#282 — individual/proxy slice)

- `/whoami` reports the current dyncap anchor as UID. `/qos id <process>`
  returns its canonical identity and trust ceiling. There is no superuser.
- `/qos cap <process>` lists its handles. `/chmod <process> <handle> <mask>`
  requires REVOKE and can only decrease rights, including all descendants.
  `/chown <process> <handle> <recipient-pid>` moves a grantable non-root
  filesystem or memory handle, not the object or the recipient's identity.
  Existing descendants retain their own grants and ancestry.
- `/qos proxy create <process> <handle> <holder-uid> <mask>` returns a stable
  proxy token bound to the named UID. The holder gains no raw target handle.
- `/qos proxy set <process> <token> <handle> <mask> on|off` changes the target,
  narrows rights or disables the token. Off ignores the handle argument;
  only the original caretaker process may change the table.
- `/qos proxy use <process> <token> stat|ls|read|mkdir|unlink <path>`,
  `... put <path> <own-memory-handle>`, or `... signal <signal>` checks
  the currently observed proxy, caretaker, target handle and namespace/process
  versions at the resource boundary. Read verifies bytes and rechecks after
  asynchronous I/O. SIGKILL is never forwarded.

Rights: READ=1, WRITE=2, EXEC=4, SIGNAL=8, GRANT=16, REVOKE=32. ADMIN is
not an alternative to REVOKE. Raw kernel revocation invalidates handle
descendants; proxy disable stops future mediated use of the unchanged token.
Neither can retrieve bytes already delivered. Tokens and metadata appear in
the room journal, not as confidential bearer secrets. Authorization is under
the existing hash-only dyncap TOFU model, not asymmetric authentication.
The proxy is enforced by clients that replay the current journal; an offline
or noncompliant peer can have an obsolete view. This is not a global
revocation proof or public Rholo access-control enforcement.

Group ownership and group-controlled proxy transfer remain blocked on #103:
`/qos groups <process>` returns only verified groups (none until the contract
exists); group operations are explicitly ENOTSUP. A local roster, role,
or a self-declared threshold is not group authority. #107's library/inbox/
sync-consent and group-owner integration is outside this mediated OS slice.


Permission commands preserve the causal receipts observed by the issuing
client, including accepted tips on other process/source chains. Commands
with an observed frontier depend on those exact receipt hashes in canonical
order. Missing receipts fail closed. Older raw requests remain supported
with their operation-specific version constraints; concurrent histories
can still conflict. This is causal replay, not wall-clock finality.

### `/dev` — capability devices (#283, independent slice)

The logical descriptor + grant and the open handle are separate from a
locally attached host resource. Registering a logical device grants no
ambient hardware permission; no group UID, group role or ADMIN bit is
required or recognized. Future verified group grants can issue the same
attenuated device capability without changing request/observation schemas.

- `/dev define <process> opfs-block 3` creates a scratch-device grant.
- `/dev grant <process> <grant> <recipient-pid> <mask>` attenuates a grant.
- `/dev open <process> <grant> <mask>` creates a logical open session;
  `/dev bind <process> <session>` explicitly attaches the local adapter.
- `/dev list <process>`, `/dev read <process> <session> <limit>`,
  `/dev write <process> <session> | 00ff`, `/dev ioctl <process> <session> status`,
  `/dev ioctl <process> <session> zfa | 0001`, `/dev close <process> <session>`.
- `/dev abandon <process> <pending-ticket>` records EINTR/unknown after
  loss of the executing host. It never retries an external operation.

Rights: READ=1, WRITE=2, EXEC=4 (ZFA ioctl). A grant cannot be widened;
open sessions do not grant additional handles. User commands require an
owned process and a live explicit grant. A successful request receipt
allocates one pending ticket. Its observation is a separate canonical
receipt with strict request-bound byte count, bounded hex, optional opaque
timestamp, or errno plus effect uncertainty. The pure replay engine never
imports the host module or contacts a device. Observations are attributed
claims under the existing dyncap trust model, not hardware attestations.
The scheduler never consults device timestamps.

A local broker dispatches only a newly committed request from the explicit
command path; generic raw syscalls and replay cannot dispatch. Revocation,
close, suspend, and process exit release live leases when the local
client reconciles. Authority is checked before and after I/O; external
effects already performed cannot be undone. Timeout/lost execution means
unknown, not exactly-once delivery. Binding is not persisted.

Built-in browser bindings: OPFS scratch block (room-scoped fixed file name,
not arbitrary host paths; max 4 KiB), ZFA pairwise wrapper (WASM if loaded,
TS fallback), and explicitly bound read-only Rholo status RPC. Donated
dedicated RTC data channels, media tracks (metadata only, no capture), and
existing mesh sockets have adapter constructors; automatic adoption of
active application resources is deliberately not implemented. Native
external POSIX sockets, full media capture and arbitrary RPC methods
remain separate. No device operations are dispatched by journal replay,
including a pending request after reload. Source/output bytes are room
journal data; never pass secrets.

This is not full #283 acceptance until actual browser/adapter and resource
release witnesses are green. It does not resolve #103 or expand #107.


Explicit host-resource adoption: an embedding host may call
`QosCommand.attachDevice(process, session, kind, factory)` after obtaining a
dedicated pre-authorized resource. The factory is not invoked for an
invalid, foreign, closed, already-bound, or wrong-kind session.
`/socket device <connection-id> <process> <open-mesh-session>` surrenders an
existing user-created mesh connection to the device lease and removes it
from the legacy socket command map. No active chat channel or physical
capture is acquired implicitly. Disconnect, room close and identity
replacement release live leases; journal state remains intact.
Browser CI uses real dedicated RTC channels, PosixNet over a separate RTC
channel, and a synthetic canvas MediaStreamTrack (metadata and stop only).
Rholo device CI uses an owned disposable bundled node and GET /api/status
only; replay is verified in a separate process forbidden to perform RPC.

### Signed packages and init (#284)

A supervisor is an owned running QOS process. `/pkg install <process> | JSON`
accepts exactly `{package:{manifest,signature},publisher,bindings}`.
The manifest schema is `qos.package/1`: name, version, publisher (32-byte
Ed25519 public key hex), capabilities (name/kind/rights), entrypoint
(kind/source), ordered dependencies, restart (never/on-failure), health
(bounded builtin pipeline). Signature is 64-byte hex over UTF-8
canonicalJson(manifest), verified against the explicitly pinned publisher.
The user must obtain that pin independently; no publisher PKI is implied.
Bindings are explicit `{name,handle,version?}` for live grantable fs,
memory, or device-grant objects. The command fills omitted handle versions.
No ambient room root, ADMIN, or implicit device acquisition.

`/svc boot <process> | {"schema":"qos-init/1","services":["name"]}`
resolves signed dependencies in declared order. Missing/failed dependencies
and cycles block their dependents. `/svc list|status|start|stop|restart|health`
and `/pkg list|remove` operate in the supervisor namespace. Stable service
identity is separate from the generation-specific process identity.
Restart stops dependents, creates a fresh restricted runtime and attenuated
handles; failed health checks retry only on explicit health commands with
a bounded retry budget. Removing a package stops its service and dependents.
Losing supervisor or resource authority blocks/stops runtime processes.

The builtin entrypoint and health pipeline execute bounded pure shell
stages; no redirection, host I/O, arbitrary eval or npm. Signed agent,
macro and contract entrypoints are installable inert data; starting them
fails closed until an authorized execution runtime is implemented.
This is the deterministic init/core slice, not autonomous daemon service
execution or an agent execution host. Package source is room journal data.

### Observability and isolated recovery (#285)

`/top`, `/dmesg`, `/trace [process]` and `/stat [process]` inspect
canonical replay without authoring events. The trace shows the canonical
position, event hash, caller, handle, operation, result or errno and rejection
diagnostic. Display is bounded (32 recent trace rows, 128 process rows).
The digest is a logical state digest, not a claim of physical byte availability.

`/snapshot <name>` saves a bounded (2 MiB) clean, complete causal cut with
admitted event evidence, room identity, state digest and canonical envelope
hash. Forked, unresolved or pending syscall cuts fail closed.
`/restore <name>` verifies admission and both hashes, then creates a separate
local continuation. `/branch <name> | <command>` explicitly routes a supported
pure command into that continuation. Neither restore nor branch commands
replace or truncate the original room journal. A branch uses the current
monotonic identity counter, not a restored seed or counter. Branch effects
are isolated from room broadcast, byte adapters and host drivers. Snapshots
persist locally; branch continuation is in memory and is not mergeable into
the original room. This is not distributed rollback or a live failover.
Snapshot integrity is not independent authentication of its author.

Deterministic quotas: per process, 128 live handles, 256 KiB of distinct
objects directly referenced by live memory or namespace handles, and 512
committed chargeable syscall operations. Shared namespace changes are
checked for all affected holders. Read-only inspection and cleanup
operations are exempt from the operation budget. Limit refusals return
ENOSPC/EAGAIN without committing speculative state; refusal receipts remain
auditable. The operation budget is not a raw network-event admission limit,
and logical bytes are not physical cache or transitive memory-graph bytes.
No production wire-rate, governance-event or global process quotas are
claimed. No wall-clock dependency.

### Boot manifest and native runtime (#286)

A public `qos.boot/1` manifest contains the versioned kernel contract and
ABI, hashed supervisor identifier, explicit init service list, sorted
signed package identities/publisher pins, logical device descriptors
(explicit host binding only), state root and private snapshot content ID.
It contains no room capability, identity seed, event payloads, package
source, endpoints or host credentials. Content address is SHA-256 of
canonical JSON. Discovering a manifest requires no room authority.
Package/service names and public keys are intentionally public metadata;
publish only a manifest (not its snapshot) after review.

`/snapshot bootcut` then `/qos boot-manifest bootcut <supervisor> <service> ...`
generates the manifest and address from an independently verified clean
causal cut. Store its JSON as `<address>.json` in a public content-addressed
directory. The separately protected snapshot contains private authority
and journal evidence. The manifest alone is not a key or runnable state.
Boot rejects a missing/mismatched package, dependency cycle, mismatched
device set, unsupported kernel contract or snapshot digest.

After `pnpm build:wasm` and `pnpm install --frozen-lockfile`, run
`node scripts/qos-cli/qos-boot.mjs discover --store <dir> --address <hash>`.
For headless boot, use `boot --store <dir> --address <hash> --snapshot
<private.json> --room-file <private-file>`. Private inputs must have mode
0600. Native boot requires actual ZFA WASM initialization; the TS kernel is
the same module as the browser. It reports JSON dmesg and ps, no chain RPC.
Use `--init --identity <private-current-identity> --out <new-private-dir>`
for an explicitly isolated init continuation that creates real builtin
service processes, fresh snapshot and manifest. This is not a takeover
of the live room. Never reuse that fork's identity file on the live
room, broadcast its events, or merge its journal. The original cut and
identity files are not changed. Do not export live identity to an untrusted
host. Optional `--observe-ms <N> --signal <ws-endpoint>` joins via existing
Node QOSPeer with the privately supplied room capability, observes new
events from the verified cut and prints the resulting digest/ps. It does
not publish events or restore a fork into live history. Install the
existing scripts/qos-cli dependencies for this optional network path.

Local filesystem discovery is implemented, not a public hosting service.
Chain anchoring, automatic current-address resolution, live failover,
native device acquisition and agent/macro/contract execution remain
separate. Boot relies on private verified admission evidence under dyncap
TOFU continuity and explicitly pinned signed package manifests.
