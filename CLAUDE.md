# CLAUDE.md — [QuantumOS](README.md)

Project context for Claude Code sessions. Read this before making any changes.

---

## Project overview

**QuantumOS (QOS) is an intelligent gateway to each other and everything — the rho ZFA peer-to-peer layer, proven secure.** Framed for a technical reader: zero-trust p2p where a capability token (not an ACL, session, or TLS cert) is the sole unit of authorization, and its validity is a machine-checked algebraic fact, Lean-verified in QLF, not a policy any party has to trust. Framed for anyone else: reaching another person and reaching the truth, agreement, or value between you are the same one verified act, so one substrate serves as the gateway to both.

That model is **off-chain by default across every layer** — rooms (each its own Markov-blanket-isolated process; see Multi-room below), capability tokens, lemmas, notes, polls, rendezvous, and governance are all verified p2p by the ZFA algebra, with no chain in the loop. This is a security and privacy property, not just a cost saving: nothing about ordinary room activity is written to a public ledger for anyone to correlate, and nothing costs gas. `/rholang` and its chain macros (`$x*`, `$w*`) are the deliberate exception — reached for only when something specifically needs a durable public record, or a currency/exchange that must federate across rchain **shards** on-chain (`rho:*` shard ids, `$xlink`/`$xprepare`/`$xcommit`) — never a dependency of the core security model. When touching chain-adjacent code, don't assume a room-level feature needs rnode; check whether the off-chain primitive (lemma, note, poll, gov) already covers it.

The off-chain layer is also **quantum-secure by construction**: capability tokens (`getRandomValues` entropy), dyncap identity (SHA-256 only), and the identity vault (PBKDF2-SHA256 → AES-256-GCM) use no factoring/discrete-log keypair for Shor's algorithm to attack — only Grover's quadratic-speedup brute force applies. Only `/rholang deploy` (secp256k1 ECDSA, to interoperate with the shipped rnode) carries classical exposure, and it's opt-in/off-chain-by-default like everything else on the chain path. Full detail: [`SECURITY.md`](SECURITY.md#quantum-security). Keep this true when adding crypto: don't introduce an RSA/ECC keypair into the core p2p path (tokens, dyncap, vault) without flagging the quantum-security tradeoff explicitly.

**QuantumOS** is a peer-to-peer browser application that makes ZFA (Zero Free Action) capability tokens the live security model of a collaborative computing room. Two or more browser peers connect via WebRTC, share a room identified by a ZFA capability token, and run QLF slash commands (`/qucalc`, `/lemma`, `/braket`, `/zfa`, …) whose results broadcast to all peers.

The ZFA kernel is implemented in Rust (compiled to WASM) and is the same algebraic core as the [Quantum Logical Framework](https://github.com/rhovision-org/quantum-logical-framework). Possessing a capability token IS authorization — no server, no accounts, no trust.

**Live deployment:** https://rhovision-org.github.io/quantum-os/
**Signaling server:** `wss://quantum-os-signaling.onrender.com` (Render.com, auto-deploys from `packages/signaling/`)

---

## Repository layout

```
quantum-os/
├── crates/
│   └── zfa-core/          Rust library: ZFA kernel (twist algebra, capabilities, processes)
│       └── src/
│           ├── capability.rs   cap:label:hex token generation (rejection-sampling) and validation
│           ├── history.rs      achieves_zfa, is_count_balanced, spectral_gap, count_pos/neg, is_symmetric
│           ├── pauli.rs        Pauli matrix algebra: pauli_fold, is_pauli_closed, twist_matrix
│           ├── process.rs      Form (2×2 Hermitian), Process (RhoQuCalc)
│           ├── twist.rs        Twist enum (8-symbol alphabet)
│           └── wasm.rs         wasm-bindgen exports (feature = "wasm")
├── packages/
│   ├── browser/            Vite + TypeScript browser app (GitHub Pages)
│   │   ├── index.html      Layout + CSS (sidebar, chat, share row)
│   │   ├── public/
│   │   │   └── render.html Room animation (the `/render` command) — self-contained canvas, deploys to /quantum-os/render.html
│   │   └── src/
│   │       ├── app.ts      All UI logic, slash commands, lemma/note/rdv stores, peer callbacks
│   │       ├── peer.ts     QOSPeer class — WebRTC + signaling WebSocket
│   │       ├── zfa.ts      Browser-side ZFA helpers (validateCapability, tokenTwists, …)
│   │       ├── notes.ts    Promissory note primitives (mint, split, merge, parseNoteLabel, denomination)
│   │       ├── rendezvous.ts  N-party rendezvous protocol (Proposal/Row/CommitRow types, conservationCheck, cyclicSwap)
│   │       ├── dyncap.ts   Hash-only dynamic capabilities (sign/verify envelopes; SHA-256 only)
│   │       ├── vault.ts    Password-encrypted identity vault (PBKDF2 → AES-GCM over the dyncap seed; /password, /login)
│   │       ├── probe.ts    Discrepancy probe — chain-weighted supermajority tally on join
│   │       ├── polls.ts    Group polls — pure approval + ranked-choice (IRV) tally over content-hash option ids
│   │       ├── macro-lang.js Interact2 `$` macro language — parse, bind, expand; both lexers; --selftest
│   │       ├── rhoqu.ts    RhoQu macro parser + transpiler (process / new / | / if / on / for → /command strings)
│   │       └── index.ts    WASM module re-exports
│   ├── signaling/          Node.js WebSocket signaling relay (Render.com)
│   │   └── src/
│   │       ├── server.ts   SignalingServer — join/leave/relay, rate limiting, wsIndex auth
│   │       └── room.ts     Room — peer membership, broadcast helpers
│   └── zfa-core-wasm/      wasm-pack output (generated — do not edit)
├── scripts/                Utility scripts
├── docs/                   architecture.md (engineering parent), commands.md (full slash-command reference), connection.md, rholang.md
├── .github/workflows/
│   ├── ci.yml              Rust tests + WASM build + TS typecheck on every push/PR
│   └── pages.yml           Build + deploy to GitHub Pages on every push to main
├── render.yaml             Signaling server deploy config (Render.com)
├── SECURITY.md             Threat model, known issues, dependency audit
└── SyllogismDemo.md        Step-by-step walkthrough of collaborative syllogism proof
```

---

## Key concepts

### ZFA capability tokens

Every peer identity, room ID, and named lemma cap is a `cap:label:hex` token:

```
cap:peer:024602460246024602460246…
     ↑       ↑
  label    hex digits 0–7 only (each is a twist value)
           ZFA: count balance ∧ Pauli closure (see below)
```

- Generated with `crypto.getRandomValues()` (browser) or `getrandom` crate (Rust); since v0.17, `from_entropy` uses rejection sampling to guarantee Pauli closure (~4 iterations expected per token).
- 128-bit entropy; ZFA constraint still leaves astronomically large space.
- `validateCapability(token)` — checks format, count balance, AND Pauli closure.
- `tokenTwists(token)` — extracts `Uint8Array` of twist values from hex.
- Knowing a room token IS the capability to join (bearer token in URL hash).

### Twist alphabet (8 symbols)

| Symbol | Value | Parity | Name |
|--------|-------|--------|------|
| `^` | 0 | even/pos | Up |
| `v` | 1 | odd/neg | Down |
| `>` | 2 | even/pos | Right |
| `<` | 3 | odd/neg | Left |
| `/` | 4 | even/pos | Slash |
| `\` | 5 | odd/neg | Backslash |
| `+` | 6 | even/pos | Plus |
| `-` | 7 | odd/neg | Minus |

**ZFA = half-spin closure** (v0.17+): a process whose execution returns a spin-1/2 spinor to itself up to a global phase. The predicate `achieves_zfa(H) = pauli_closed(H) ∧ count_balanced(H)` is the algebraic decomposition of that closure into its two faces:

1. **Pauli closure** (non-abelian face): the ordered matrix product of twists lands in `{+I, −I, +iI, −iI}` — the Pauli scalar group. Each twist maps to an SU(2) generator (`^v` ↔ ±σ_y, `<>` ↔ ∓σ_x, `/\` ↔ ±σ_z, `+-` ↔ ±I). Order matters because Paulis anti-commute. **This is the SU(2)-scalar-return reading of half-spin closure** — the spinor closes up to phase.
2. **Count balance** (abelian face): `count_pos == count_neg`. Spectral gap = `|count_pos − count_neg|` = 0. This is the bra-ket / Hermitian-pair multiset count: each twist is paired with its Hermitian conjugate.

Pauli closure is not a "stronger condition" layered on top of count balance — it IS the SU(2)-scalar-return of the same half-spin closure that count balance reads as a Hermitian-pair multiset. Neither face implies the other in isolation (`σ_x σ_y σ_z = iI` is Pauli-closed but count-imbalanced; `^<` is count-balanced — one positive, one negative — but folds to −iσ_z, not a scalar); both together are the unique characterisation of a closed half-spin process. **Aggregate vs pairwise balance.** `count_balanced` above is the *aggregate* count `count_pos == count_neg`. QLF's `is_zfa` requires the stronger *pairwise* balance — the signed action vector `(#^−#v, #>−#<, #/−#\, #+−#-)` vanishing, which is what Zero Free Action names. `achieves_zfa` conjoins Pauli closure with the aggregate count, so it **over-accepts**: at length 6 it admits 20,480 histories where QLF admits 5,120. It is deliberately left as-is — it is what every live room link and minted identity validates against, and narrowing it would invalidate deployed tokens. `is_pairwise_balanced` / `achieves_zfa_pairwise` (Rust) and `isPairwiseBalanced` / `achievesZfaPairwise` (`zfa.ts`) provide QLF's predicate; `signed_action` exposes the vector. `crates/zfa-core/tests/census_conformance.rs` re-derives QLF's exhaustive 8-twist census (`tests/data/census_inventory.json`, provenance to QLF `54fcc9b`) by brute force from this crate's own fold — 266,304 histories at lengths 2/4/6 every `cargo test`, 16.7M at length 8 behind `--ignored`. SECURITY.md records the gap.

**Coupling** (`crates/zfa-core/src/coupling.rs`, `/coupling`). `parallel(peer1, …)` is ZFA-balanced by construction, so its balance distinguishes no room from any other. Cutting a closed join into per-peer factors does: `independent` (each factor closes alone — two closures, not one), `product` (no factor closes but each folds to a Pauli scalar — separable), `coupled` (only the join closes — a shared closure, QLF's entanglement), `open` (the join does not close; no event). This is the census's own cut-and-classify, so a verdict reads against an exact baseline — `COUPLED_BASELINE` = 80.3% of shared closures are coupled. Note the classification uses the **pairwise** predicate. With no arguments `/coupling` cuts the room along **what peers proposed with `/qlf-action`** (`RoomContext.actionProposals`, latest per peer, in-memory only) — *not* along peer capability tokens. A token is a random identity bearer minted against the aggregate predicate (~2.4% are pairwise-balanced), so joining tokens returned `open` for ~99.5% of real rooms and said nothing about the room; a history someone deliberately typed is a contribution, so a join of two peers' proposals closing means they built one closure together. All four verdicts are reachable that way (`^`+`v` → coupled, `+`+`-` → product, `^v`+`><` → independent, `^`+`>` → open).

### QuCalc Search — "what closes next" from a room position (`/search`, `/solve` — `qucalc-search.ts` + `app.ts`)

**Computed in the browser — quantum-os runs no service for this** (qos#119, supersedes #117's HTTP-client approach). `packages/browser/src/qucalc-enum.ts` enumerates the admissible **next closures** from a QuCalc history — the twist words you can append so the whole thing is a ZFA closure — shortest first, a faithful port of the QLF reference [`qucalc_search.py`](https://github.com/rhovision-org/quantum-logical-framework/blob/main/qucalc_search.py) ([`QucalcSearch.md`](https://github.com/rhovision-org/quantum-logical-framework/blob/main/QucalcSearch.md)). The enumeration is cheap (a depth-6 continuation search is ~260k raw candidates, count-prefiltered to a few thousand before any Pauli fold) and runs in a **Web Worker** (`qucalc-worker.ts`) so a depth-7 sweep doesn't hitch the UI. No Render deployment, no HTTP client, no endpoint config, no contract-version pin — **and the `/solve` determinism ("the meeting of minds") is *stronger* for it**: every peer computes the same closure from the same algebra, with nothing to be "up" or "honest". "No server, no trust, just algebra."

**The count-balance gate is QLF's, not quantum-os's.** It is the signed action vector vanishing (`#^=#v ∧ #>=#< ∧ #/=#\ ∧ #+=#−`), matching `qucalc_search.py` — **not** the weaker aggregate `count_pos == count_neg` that `achievesZfa` accepts (`achievesZfa` would admit `^^<<`, which the reference rejects — see the `zfa.ts` header note). `pauliScalarOf` in `zfa.ts` (always pure-TS, so worker and main agree) gives the phase.

**The search is the experiment, not a lookup — it is truth divination** ([`QucalcSearch.md` § "What search and solve are"](https://github.com/rhovision-org/quantum-logical-framework/blob/main/QucalcSearch.md)). All admissible histories exist *a priori* as pure possibility (QLF possibilism); the enumeration is the generative/experimental act — it asks the substrate *which of them close from here*. Truth in QLF is what closes: a closure receipt, not a standing proposition, and `mode=events` makes that literal — a closure *is* an event, so each branch is reported only at its first closure (the future is un-rendered possibility; the search renders a slice of it). `mode=possibilities` is every closure within `max_depth`.

**A concurrent search is a meeting of minds.** `/search` with no argument runs one enumeration over *every peer's* `/qlf-action` position (`qc=a,b,c`) with **shared listeners** — peers contribute their positions into the room, the listeners are the room's joint reading, and the search is the room's shared experiment (`QLF_as_Intelligence.md` §8: the room as one distributed synthesis, peers as Markov-blanket sub-agents; `ScientificApproach.md` §2: an apparatus is a closure inventory, an observer only a perspective on it). `capacity:R` listeners give each peer's reach on the *same* census — one possibility structure, heard by horizons of different capacity.

- **Core** (`packages/browser/src/qucalc-enum.ts`, imports only `zfa.ts`): `enumerateClosures(qc, {maxDepth, limit, minTotalLen, absorbing})` is a sync generator over `Closure` (`{cont, history, len, depth, phase, qc?}`); `runSearch(seeds, {maxDepth, limit, mode, listeners})` wraps it over one or more seeds, yields each `Closure` and returns a `SearchReport` (`{seeds, maxDepth, mode, found, truncated, elapsedS, perSeed, listeners}`); `solvePosition(qc, {maxDepth, withShortlist})` runs the `/solve` cascade. Listener spec `phase,depth,capacity:R,head:N` (count always on) — same names as the Python. Ported 1:1 from `qucalc_search.py` (`7046c55`); `enumerateClosures` iterates `itertools.product` in `twist_core.TWISTS` order (`^v<>/\+-`) via an incremental odometer so emission order, the `head` sample and the lexicographic solve tie-break all match.
- **Front door** (`qucalc-search.ts`): `qucalcSearch(qc, {maxDepth, limit, mode, listeners, signal})` is an **async** generator (same yield/return shape as the old HTTP client, so `app.ts` barely moved) that runs the core in a fresh Web Worker per call — streamed back in batches — and falls back to running it inline where `Worker` is unavailable (Node/tests). `qucalcSolve(qc, {withShortlist, signal})` returns the `SolveResult`.
- **`/search` command** (`app.ts`). `/search <pos>` where `pos` is symbolic `^v<>/\+-`, `@lemma`, or `cap:token`; **bare `/search`** cuts the room along peers' `/qlf-action` proposals as a concurrent search (the "meeting of minds"). Flags: `--depth N`, `--limit N`, `--events`/`--possibilities` (default events), `--full` (stream every continuation), `--no-save`, `--save-cap N`. Default listeners `phase,depth,capacity:2,capacity:3` — `capacity:R` is the QLF *listening* (`heard`/`missed` split by whether `max_excursion ≤ R`). The search is async: `/search` is **excluded from the generic `qlf` rebroadcast** and sends its own `{kind:"qlf", cmd:"search", lines}` envelope when the enumeration completes, so the room sees the shared experiment's result. `/search url` / `/search info` now just say there is no endpoint.
- **Discovered events become lemmas.** In `events` mode each new closure is registered as a **room lemma named with an integer** in discovery order (`@1`, `@2`, …) — a re-run of the same search then finds them already known rather than anonymous. `LemmaEntry.event?: boolean` marks them (cosmetic — `renderLemmas` shows `⌁` and sorts them after authored claims; carried on the `lemma`/`sync-lemmas` wire). Bounded by `EVENT_LEMMA_CAP` (default 32, `--save-cap` up to 256) so a deep search can't flood the room's vocabulary; the batch goes out as one signed `sync-lemmas` broadcast, not N `lemma` envelopes. `nextEventNumber()` allocates the next free integer; first-write-wins by name (like every lemma) so identical searches on different peers converge. The room's lemma store **is** the closure cache — a re-run of a search finds its own past discoveries already named, with no service to hold them (QLF#153's "server-side closure store" is moot without a service).
- **`/solve` command** — the complement of `/search`: **`/search` renders every way to close (the experiment); `/solve` finds the solution, or the path to it.** From a position it picks the *one* closure the substrate takes, by a deterministic cascade so every peer computes the same winner (joiner-local, like `/poll`):
  `peakExcursion` asc → `depth` asc → phase (`+1` before `-1`) → history lexicographic. `peakExcursion` (`maxExcursion` in `qucalc-enum.ts`, ported from `qucalc_search.py`'s `max_excursion`) is the least-free-action reading — the walk that strays least from balance. It **widens the horizon** — starts at `min(floor+2, 7)` where `floor = Σ|residual|` is the feasibility floor, escalates to depth 7 (`MAX_DEPTH_CAP`) if that misses — and on a total miss reports the **residual fallback**: the exact action vector `−signedAction(seed)` a completion still owes, `residualToTwists()` giving one concrete count-balancing continuation, and whether the shortest completion is simply beyond the depth cap (`floor > 7`, `reason: "beyond max_depth"`) or genuinely off any short path (`"no short event"`). `pos` = symbolic / `@lemma` / `cap:token` / none (the room's *joined* `/qlf-action` proposals, in proposal order). `--all` shows the ranked shortlist (`solvePosition(qc, {withShortlist:true})`); `--no-save` skips the lemma. The chosen path is saved as an integer-named event lemma and self-broadcast (`cmd:"solve"`, excluded from the generic rebroadcast).
- **`qucalc_search.py` stays the reference.** It is the Python reference implementation + CLI (and still `--serve`-able for research use), and the spec `qucalc-enum.ts` conforms to — but it is **not** a quantum-os dependency. `test/qucalc-search.test.mjs` carries a conformance block of digests captured from it (`7046c55`) so the TS port cannot silently drift; regenerate them from `python3 qucalc_search.py … --json` if the reference changes.

### QLF alphabet / SU(2)

The 8-twist alphabet is the SU(2) generator set up to sign (SU(2) ≅ unit quaternions; Hurwitz singles out H as the unique non-commutative associative composition real algebra — see QLF [HALF-SPIN-ZFA-EMBEDDING.md §6](https://github.com/rhovision-org/quantum-logical-framework/blob/main/HALF-SPIN-ZFA-EMBEDDING.md)).

Both faces are checked uniformly in `crates/zfa-core/src/pauli.rs`, `packages/browser/src/zfa.ts`, and the QLF Python core `twist_core.py`.

### Lemma system

Named logical claims shared across peers, persisted to `localStorage` per room URL.

- **Grammar** (`packages/browser/src/lemma-parse.ts` `parseLemmaDecl` — pure, `test/lemma-parse.test.mjs`; also holds the moved `canonLemma` / `parseRefTokens` / `splitLemmaNameArg`): `/lemma <statement> [| <twists>]`. The statement, in order: `[bracket name]` (legacy); legacy `<word> <twists-like>` (so `/lemma concl @a @b` still composes); **one `@handle` marked in a sentence** — `/lemma All men are @mortal` → name `mortal`, `LemmaEntry.text` = "All men are mortal" (issue #128); a **leading** `@handle` followed by words is a handle not in the sentence (`/lemma @concl Socrates is mortal | …`); otherwise the **whole statement is the name** (bare multi-word names now work). `>1 @word` → error.
- Twists after `|` (or the legacy space form): symbolic / hex / `cap:token` / `@ref1 @ref2` — via `expandLemmaRefs` + `resolveLemmaToBytes`, unchanged. Omitted → `allocateTwists(name)` from the handle.
- `@name` in any command arg — expands to the stored twist sequence
- Auto-mints `cap:name:hex` when the result is ZFA-balanced
- Broadcasts `{kind: "lemma", name, twists, cap, who, text?}` to all peers on register (`text` also rides `sync-lemmas`). `text` is cosmetic — first-write-wins like `who`, **never** part of the immutability check (only `twists` is); `renderLemmas` shows `@handle — "text"`.
- `allocateTwists(name)`: each character yields one pos twist `(code & 3)*2` and one neg twist `((code>>2)&3)*2+1` — always balanced, always deterministic
- **Event lemmas** (`LemmaEntry.event`): `/search` (events mode) registers each discovered closure as a lemma named with the next free integer (`nextEventNumber()`), so a re-run finds it already known. Same machinery as any lemma — synced, tombstone-able, `@N` refs, cap auto-mint — just marked and sorted last in `renderLemmas`. See the QuCalc Search section.

**Transfer commands** (peer-to-peer, not broadcast):
- `/request name` — broadcasts `{kind: "lemma-request", name, fromName}`; holder's window shows a prompt with the ready-to-type `/pass` command
- `/pass name peer-name` — looks up `peerNames` to find peerId, sends `{kind: "lemma-pass", name, twists, cap}` directly via data channel, deletes from sender's `lemmaStore`; recipient auto-registers and sees confirmation
- `findPeerByName(name)`: exact then prefix match on `peerNames` map (case-insensitive)

### Promissory notes (`/note` — `notes.ts` + `app.ts`)

Bearer instruments as ZFA capabilities. Format `cap:note-<currency>:<balanced hex>`; **denomination = `hex.length / 2`**. Conservation falls out of the existing balance invariant — split/merge preserve `count_pos == count_neg`.

Three label kinds parsed by `parseNoteLabel`: `token` (issuer authority), `note` (bearer denomination), `receipt` (permanent redemption record). Lifecycle vocabulary borrowed from DarkWow's TokenMint → Mint → Transfer → Redeem, but implemented with no ZK, no Pedersen, no consensus.

Stores (per-room `localStorage`):
- `currencyTokens: Map<currency, token>` — currencies *I issue* (private bearer authority)
- `knownCurrencies: Map<token, KnownCurrency>` — *public* registry of every declared currency in the room (populated from `note-declare` broadcasts and `sync-currencies` snapshots)
- `noteStore: Map<token, NoteEntry>` — bearer notes I currently hold
- `receiptStore: Map<token, ReceiptEntry>` — redemption receipts (permanent, non-transferable)
- `redemptionsHonored: Map<token, RedemptionRecord>` — issuer-side accounting

Wire kinds: `note-declare` (broadcast), `note-grant` (broadcast — currency + denomination only, the bearer token stays private), `note-pass` / `note-redeem` / `note-receipt` (direct).

The sidebar's **Currencies** block shows `currencyTokens` entries with `✦` and others' declarations with the issuer's name; **Notes** shows `noteStore`. Click handlers prefill the input. Receipts and redemptions are chat-only.

#### Terms & conditions — terms-stamped series

Notes can carry **terms & conditions**, and different notes of the same currency can carry *different* terms, via **series stamps**. A terms-bearing note's token is `cap:note-<base>~<termsHash8>:<hex>` where `termsHash8 = first 8 hex of FNV-1a(canonicalized terms)` (`termsHash8` in `notes.ts`). `parseNoteLabel` returns `{ currency (full, e.g. "USD~a1b2"), baseCurrency ("USD"), series ("a1b2"|null) }`. **`currency` is the full unit**, so each series is its own non-fungible unit: `splitNote` keeps the stamp on both children (terms inherited); `mergeNotes` already requires a matching currency segment, so it refuses to combine different series (or a series with plain). "Different terms for USD" = **different series under USD**.

- Mint: `/note grant USD 5 | <terms text>` → derives the stamp, mints `cap:note-USD~<hash>`, records the series, and broadcasts it. Plain `/note grant USD 5` is unchanged.
- **Authority/integrity:** the issuer broadcasts a **dyncap-signed `note-series {seriesKey, baseCurrency, termsHash, terms, who}`** (and it rides the join handshake via **`sync-series`**). Inbound is honored only if self-consistent (`termsHash8(terms) === stamp` and `seriesKey === base~hash`) **and** from the currency's issuer (sender's verified dyncap anchor matches the `KnownCurrency.dyncap.anchor`, like the lemma-retract author check). `note-pass` also carries the terms as a self-verifying cache (text must hash to the token's stamp); the signed `note-series` overrides an `(unconfirmed)` cache.
- **Acceptance gate:** `/note redeem` of a stamped note is blocked until the holder runs `/note accept <currency~hash>`; acceptance is recorded in `acceptedTerms`. `/note terms <currency~hash>` shows a series' terms; `/note terms <currency>` lists a currency's series.
- Stores: `seriesTerms: Map<seriesKey, SeriesTerms>` and `acceptedTerms: Map<seriesKey, AcceptedTerms>`, persisted `qos-series-terms-<room>` / `qos-accepted-terms-<room>`. Issuance checks use `baseCurrency` (a `USD~hash` note is issued by whoever issues `USD`). Sidebar notes show a 📜 marker with terms in the tooltip.
- Limitation: terms are fixed at mint (the stamp commits to them); re-terming means minting a new series.

### Rendezvous (`/rdv` — `rendezvous.ts` + `app.ts`)

N-party atomic synchronization. Each participant contributes a `gives` token and receives a `gets` token; `conservationCheck(rows)` enforces `multiset(gives) == multiset(gets)` over the joint composition.

Protocol (5 direct-send wire kinds, never broadcast): `rdv-propose`, `rdv-accept`, `rdv-reject`, `rdv-commit`, `rdv-abort`. The proposer collects accepts (each accept carries the participant's committed gives token), and on all-accepts builds commit rows via the cyclic mapping `row[i].gets = next-row.gives` and dispatches `rdv-commit`. Each participant applies locally: `lockedNotes.delete(givesToken); noteStore.set(getsToken, …)`.

Locking: accepted-but-not-yet-committed tokens move from `noteStore` to `lockedNotes` (so `/note pass` etc. don't see them). Released on abort/reject/timeout. On reload, locks are orphaned (proposal state is in-memory only) and auto-released back to `noteStore` in `loadNotes()` — so value is never lost across a crash.

Atomicity is best-effort, same trust model as `/note pass`. 60s default timeout via `scheduleProposalTimeout` / `proposalTimedOut`.

### Dynamic capabilities (`/dyncap` — `dyncap.ts` + `app.ts`)

Hash-only identity layer. Uses `crypto.subtle.digest("SHA-256", …)` — browser built-in, no external library, no keypairs, no signatures.

State per peer (private, in `localStorage` under `qos-dyncap-state`, cross-room):
- `seed: Uint8Array(32)` — generated at first launch, never broadcast
- `anchor: string` — hex of `H(seed)`, 64 chars; the peer's permanent identity
- `seq: number` — monotonically incremented per signed envelope

Signed envelope grows: `dyncap: { anchor, seq, witness }` where `witness = H(seed || seq_le32 || room_id_bytes || payload_hash)`. `payload_hash` covers a canonical serialization (sorted keys, JSON, dyncap stripped) of the envelope.

Receivers maintain `dyncapChains: Map<peerId, ChainEntry>` per room. TOFU-pin the first observed anchor. Subsequent envelopes must extend the chain — monotonic `seq`, unseen `witness`. Two valid envelopes at the same `seq` under the same anchor are a *fork*; the entry is flagged `contested` and the user is warned via `⚠` chat line.

Outbound wired in: `signedBroadcast` and `signedSend` are drop-in wrappers replacing direct `qpeer.broadcast` / `qpeer.send` for envelope kinds we sign. A `signQueue: Promise` chain serializes outbound signings so `seq` ordering is preserved across concurrent broadcasts.

Currently signed: `name`, `lemma`, `note-declare`, `sync-lemmas`, `sync-currencies`. `LemmaEntry` and `KnownCurrency` gained an optional `dyncap?: DyncapField` field so sync-forwarded entries carry the original author's chain step. Inner-entry verification against the original author's anchor (cross-peer lookup) is a future revision.

Trust ceiling: TOFU at first contact + chain-tamper / replay / fork detection. Cannot mathematically verify the seed (hash-only). Race condition if a clone broadcasts before the real holder. Cross-room continuity not provided. See SECURITY.md for full threat enumeration.

### Identity recovery (`/password` / `/login` — `vault.ts` + `app.ts` + `gov.ts`)

The dyncap seed is the whole identity; `vault.ts` makes it portable without leaving the hash-only model. `encryptVault`/`decryptVault` seal `{ seed, name }` with **PBKDF2-SHA256 (210k) → AES-256-GCM**, emitting `qos-vault:v1:<salt>:<iv>:<ct>` — the app's only `crypto.subtle` AES (SHA-256 stays dyncap's). `/password` produces it (password via a masked dialog, never an inline command arg, so no secret hits the chat log / broadcast) and, for each group you're a member of, replicates it via a self-signed **`gov-vault`** envelope carried on `sync-gov` (the memory daemon persists it inside `groups.json`). `/login <handle>` fetches the ciphertext from synced group state and decrypts; a bare `/login` restores from a pasted (or this browser's saved) string. Both commands are excluded from the `qlf` broadcast.

Group scoping is anchor-bound: `Member` gained `anchor`, `isMember`/`isAdmin`/`memberKeyFor` match by anchor as well as peerId, and `reconcileGroups`/`rekeyMember` (in `gov.ts`) move a returning member (recovered seed, fresh peerId) — plus every peerId-keyed reference (delegations, trust, censures, creator) — onto the live peerId, only ever on a **dyncap-verified** anchor. `Group.vaults: Record<handle, VaultRecord>` is first-write-wins by handle, overwrite only by the same anchor (publisher must be a member and `fromAnchor === vault.anchor`). Pure p2p — no server, no username registry; the daemon holds ciphertext it can't read. Confidentiality is exactly the password's strength (offline-crackable by any ciphertext holder). See SECURITY.md.

### Multi-room with per-room Markov blankets (`/room` — `app.ts`)

A single browser session can join N rooms simultaneously, each as a tab across the top of the UI. The full reference framing is below; concrete summary for code work:

State model:
- `RoomContext` interface (defined in `app.ts`) collects all per-room state: `lemmaStore`, `noteStore`, `currencyTokens`, `knownCurrencies`, `receiptStore`, `redemptionsHonored`, `lockedNotes`, `proposals`, `proposalTimers`, `dyncapChains`, `probe`, `ignoredForSync`, `actionProposals`, `chatLog`, `peers`, `peerNames`, `pendingLeaves`, `qpeer`, `signalingUrl`, `hasUnread`, `roomId`.
- `const rooms: Map<roomId, RoomContext>` — all joined rooms.
- `let activeRoom: RoomContext` — the room whose state is aliased into the module-level `let` bindings (`lemmaStore`, `peers`, …). Temporarily swapped by inbound QOSPeer callbacks via `setActiveRoom(ctx)` so background activity lands in the right room.
- `let uiActiveRoom: RoomContext` — the room the user is *looking at*. Changes only on `switchToRoom`. DOM-touching helpers (`addMessage`, `renderPeers`, `renderLemmas`, `renderNotes`, `renderRoomProcess`, `setStatus`) guard with `isUiActive()` (= `activeRoom === uiActiveRoom`) so a background callback doesn't disturb the visible tab.

Cross-room state (not in `RoomContext`):
- `myName`, `dyncapState` (with `seqByRoom: Record<roomId, number>`), `signQueue`, `sessionLog`. Per-device, shared across all rooms.

Tab UI:
- HTML: `#tab-bar` with `#tab-list` and `#tab-add` (the `+` button). CSS classes `.tab`, `.tab.active`, `.tab.unread`.
- `renderTabs()` paints from `rooms.values()`; the unread indicator is an orange `●` prefix on tabs where `ctx.hasUnread && ctx !== uiActiveRoom`. Tab clicks call `switchToRoom`.
- `switchToRoom(roomId)` calls `setActiveRoom(next)`, sets `uiActiveRoom = next`, clears `next.hasUnread`, and calls `applyActiveRoomToUI()` which re-renders everything from the new active room (replays `chatLog`, updates sidebar, syncs URL hash via `history.replaceState`).

Persistence: `qos-joined-rooms` localStorage key holds the array of joined room IDs. On reload, every room is restored via `loadRoomState(ctx)` (which briefly swaps `activeRoom` to `ctx` while `loadLemmas` / `loadNotes` run). The URL-hash room becomes the initial active room.

Callback model for simultaneous connections:
- Each `connect()` call captures `const ctx = activeRoom` at QOSPeer construction time. Every callback wraps its body in `const prev = activeRoom; setActiveRoom(ctx); try { … } finally { setActiveRoom(prev); }`.
- For `async onMessage`, the same wrapper applies plus a manual `setActiveRoom(ctx)` after each `await verifyDyncapIfPresent(…)` — the binding doesn't survive await suspensions, so we re-assert at each resumption point.
- DOM-touching code (the renderer guards above + direct `msgInput.disabled` / `connectBtn.textContent` writes) checks `isUiActive()` so background-callback DOM noise is suppressed.

The bridge-peer model: there's no protocol-level "cross-room" envelope. A peer in two rooms manually re-declares lemmas / re-grants notes in each room via the dispatcher (which acts on `activeRoom`, i.e. the current tab). Future work: an explicit `/share` command that copies a selected item from the active room into a named tab. Today, manual re-declaration is the bridge primitive.

### Discrepancy probe — joiner-local supermajority (`/probe` — `probe.ts` + `app.ts`)

Partial-consensus layer that runs when a peer joins a room. The full reference doc is [Consensus.md](Consensus.md); the implementation summary for code work:

State (per room, joiner only):
- `probe: ProbeWindow` — `{ open, observations: Observation[], contributors: Set<peerId>, timer }`. Opened in `onSignalingOpen`, closes on `PROBE_WINDOW_MS` (5000) timeout or after `SAMPLE_SIZE` (5) distinct senders.
- `ignoredForSync: Set<peerId>` — peers whose sync envelopes are silently dropped (persisted under `qos-ignored-sync-{room}`).

Constants in `probe.ts`: `SAMPLE_SIZE`, `PROBE_WINDOW_MS`, `SUPERMAJORITY_NUM = 2`, `SUPERMAJORITY_DEN = 3`.

Observation shape: `{ storeName: "lemmas"|"currencies", key, value (JSON-normalized), peer, weight }`. Weight is `dyncapChains.get(peer)?.lastSeq ?? 1` (floor 1), captured by `recordSyncObservations` when each `sync-lemmas` / `sync-currencies` arrives during the window.

`findDiscrepancies` groups by `(storeName, key)`; for each group it buckets by value, sums weights, sorts buckets by weight desc (count desc, first-seen as tiebreak). The leading bucket's value becomes the `winner` only if `leader.weight × DEN > totalWeight × NUM` (strict supermajority). Otherwise `winner: null` (contested, unresolved). `losingPeersIn` returns peers in non-winner buckets only for *resolved* discrepancies — contested discrepancies produce no losers.

On close, `closeProbeWindow`:
- For each resolved discrepancy: apply the winner to `lemmaStore` / `knownCurrencies` locally, broadcast `state-discrepancy { ..., winner: <object> }`, add losers to `ignoredForSync`.
- For each contested discrepancy: broadcast `state-discrepancy { ..., winner: null }`, no local change, no losers added.

The `state-discrepancy` inbound handler logs the broadcast on receipt; non-joining peers do *not* auto-update on receipt (joiner-local resolution).

**Critical preflight: lemma immutability.** Once `@name` is in `lemmaStore`, both the `case "lemma"` dispatcher and the inbound `lemma` handler refuse a re-declaration with different `twists` (idempotent re-declare is silently a no-op). Without this, the probe's notion of "discrepancy" would be meaningless — peers could just overwrite each other's lemma state. The fix is in `app.ts` around the existing dispatcher block and the inbound handler.

### Room state sync on data channel open

When a new data channel opens (`onChannelOpen(peerId)` in `connect()`), the peer sends the new arrival:
- `name` (existing) — display name
- `sync-lemmas` — `Array<{name, twists, who, cap?}>` from `lemmaStore`
- `sync-currencies` — `Array<KnownCurrency>` from `knownCurrencies`

Inbound handlers validate every entry with the same label/ZFA-balance checks as the live `lemma` / `note-declare` flows. First-write-wins dedupe by lemma name; currency dedupe by token. Held notes / receipts / redemptions are *never* gossiped — they're private bearer state.

Polls are also synced here: a `sync-polls` envelope (full `Poll[]`) is pushed to the new arrival so it sees polls created before it joined (see Group polls below).

### Group polls (`/poll` — `polls.ts` + `app.ts`)

On-demand group decisions (e.g. "pizza vs burgers vs salad for lunch") with **collect-then-vote** open nominations and two methods: **approval** and **ranked-choice (IRV)**.

`polls.ts` is a **pure tally module** (no DOM / storage / app imports — mirrors `probe.ts`). The tally is **deterministic and joiner-local**: every peer recomputes the same result from the ballots it holds — no central counter, echoing the consensus probe.

- **Options are referenced by a stable content-hash id** (`optionId(text)` — djb2 over normalized text), *never* by array position. Options are collected by broadcast and arrive in different orders on different peers, so an index would mean different things on different peers; an id also auto-dedupes identical suggestions ("Pizza" ≡ "pizza "). Ballots are `Record<peerId, string[]>` of option ids.
- `tallyApproval` — most-approvals-win, ties listed. `tallyRanked` — IRV over ids: win at majority of continuing ballots, exhausted ballots excluded from the denominator, deterministic tie-break = smallest option id (so every peer agrees regardless of ballot arrival order). `tally` dispatches by method; `liveCounts` gives per-option bars; `sortedOptions` is the deterministic display order (add-time then id); `summarizeWinners` is the chat/foot text.

Lifecycle: `/poll new <q>` opens for nominations (no fixed options); `| a, b` seeds some. Anyone adds options (the card's "add an option" box or `/poll add <opt>`); everyone votes/re-votes live (latest ballot per peer wins) until the creator closes. The creator may `/poll lock` to freeze nominations. On close, every peer **logs the result as a permanent transcript message** (`postPollClosedMessage`) so the outcome survives card re-renders and chat scroll-back — not only the interactive card.

Wire kinds (all dyncap-signed, idempotent, out-of-order tolerant): `poll-open` (with `options: PollOption[]`), `poll-option`, `poll-lock`, `poll-ballot` (id list), `poll-close`, and `sync-polls` (join replay). Options/ballots that arrive before their `poll-open` are buffered (`pollOptionBuffer` / `pollBallotBuffer`) and drained on open. Per-room persistence under `qos-polls-<roomId>`; cards rebuild from live `pollStore` on reload/tab-switch via the `pollId` branch in `renderChatLine`. Only the creator can lock/close (`from === poll.creator`).

For the broader family of group-decision processes this interface supports (approval / ranked-choice / consensus / atomic rendezvous / delegation / sortition / …) — built and sketched, each mapped to its primitive — see [Group_Decisions.md](Group_Decisions.md).

### The room's library (`/file` — `library.ts` + `app.ts`)

Layers 1–5 of [Media_Libraries.md](Media_Libraries.md): **a file's name is its content hash**, and the index of those names is ordinary room state. **Serverless, and no chain anywhere** — durability is *replication*: every peer keeps the index and replays it to joiners, and every peer that fetches a file becomes a holder of it, so a file survives by being wanted. A chain (#102) and an always-on peer are both **enhancements** — one that the library *needed* would be a server whatever it was called. What the design owes instead is legibility about risk: `copiesOf`/`atRisk` mark an entry with a single copy in the list and the sidebar, because that is one closed laptop from none and the moment to make another is while the first is still reachable.

- `hashBlob` (SHA-256, the digest `dyncap` already uses) names an entry, so two peers adding one file agree by construction, a copy from anyone is verifiable, and a fetch is resumable from a different holder later.
- `LibraryEntry = {hash, name, mime, size, addedBy, addedLabel, at, cap?}`. `entryFromWire` validates every field because every entry arrives from a peer; `findEntry` takes a hash, a prefix or a name and **returns null rather than guessing** between two matches; `sortEntries` is newest-first with the hash as tie-break, so every peer lists the same order.
- **Three facts, kept apart, because they fail apart**: `libraryStore` (the index — public, gossiped, `qos-library-<room>`), `heldFiles` (whose bytes this browser has — local, `qos-library-held-<room>`, and **reconciled against OPFS on load**, since claiming to hold bytes you no longer have is the one lie a library must not tell), and availability — `fileHolders` (hash → peers here who say they hold it; live, never persisted, emptied of a peer the moment it leaves) with `holderSeen` (`qos-library-seen-<room>`) so *offline* and *gone* differ. `availabilityOf` folds them into `held ●` / `here ◉` / `known ○` / `gone ⚠` (`GONE_AFTER_MS`, a week), which is what stops a library being a list of broken links. A peer announces its holdings with a signed `library-have` (replace, never merge) on change and on the join handshake.
- Bytes live in **OPFS** (`putBytes`/`getBytes`/`dropBytes`/`heldHashes` in `library.ts`, the filesystem `record.ts` streams into). Every operation answers rather than throws, so a browser that refuses storage still indexes and lists.
- Wire: dyncap-signed `library-entry`, `sync-library` on the join handshake (the index, never the bytes), and removal through the existing tombstone machinery (`retract` kind `"library"`, honored only from the peer who added it).
- **Fetch (`library-fetch.ts`, `/file get`)** — `attachments.ts` with the request turned around: one asker, one holder, one hash, paced against that one connection, so the cap is what a person will wait for (`FETCH_MAX` 64 MB) rather than what a room will tolerate (8 MB, a property of broadcasting). **The hash is the whole trust model**: the arrival is verified against the name it was fetched by and a mismatch is deleted, so nothing has to trust the peer that answered. Written to a `.part` file as it arrives (which `heldHashes` refuses to count, so an interrupted fetch never looks like a held file), sent a slice at a time so neither side holds the file in memory, and **only what was asked for, from whom it was asked** — an unrequested `lib-head` opens nothing, or a peer could write 64 MB into your storage by sending a message. Wire kinds `lib-want`/`lib-head`/`lib-part`/`lib-deny` are unsigned by design: a signature would prove who sent bytes that are checked anyway.
- Verbs, not a feature — `/file add · list [--mine|--here] · get · holders · drop · cancel · forget`, each answering in lines so a room composes its own workflow in a `+command` body.
- **In the sidebar** (`renderLibrary`): a row per entry carrying its availability mark, so what can be had looks different *before* it is clicked. A click does the next sensible thing — play what we hold, fetch what a peer here holds, say why not otherwise. Playing uses an **object URL over the file on disk**, never a `data:` url: the bytes are not copied into the page, which is the difference between a 60 MB recording playing and the tab dying. Dropping on the library adds to the library while dropping on the chat still sends an attachment — two targets because they are two intentions, and the library's drop stops propagating so one drop cannot do both.

### Removal & retraction (`/forget` — `app.ts`)

Per-item removal of polls, lemmas, and held notes (sidebar ✕ on each row; a `remove` button on poll cards; the `/forget <poll <id> | lemma <name> | note <token|currency denom> | list>` command).

The key problem is that gossiped state (polls, lemmas) *heals back*: a local delete is re-added by the next peer's `sync-*` push. The fix is **tombstones** — a per-room `retracted: Set<"<kind>:<id>">` (persisted `qos-retracted-<roomId>`, checked by `isRetracted`). Inbound `poll-open` / `poll-option` / `poll-ballot` / `mergePollFromSync` and the live `lemma` handler / `sync-lemmas` loop all skip tombstoned ids, so a removed item stays removed locally.

Removal is **authoritative for the owner, local-hide for everyone else**:
- A dyncap-signed `retract {what, id}` envelope is honored only from the owner — `from === poll.creator` for a poll, or the sender's verified dyncap anchor matching the lemma's stored author anchor (`entry.dyncap.anchor`) for a lemma. So a peer can retract its own item for everyone, but only hides others' items from its own view (still tombstoned locally).
- `forgetPoll` / `forgetLemma` broadcast the retract only when you're the owner; otherwise they just tombstone + drop locally.
- **Notes** are private bearer value: `forgetNote` is local-only with a confirm (no broadcast, no tombstone — the same token can legitimately be received again).

Limitation: there is intentionally **no** `sync-retracted` join replay (it would let a joiner push unverified tombstones and wipe a peer's view). So a peer that was *offline* during a retract keeps its own copy until told otherwise; peers that received the retract still ignore that peer's re-sync of it.

### Governance — liquid democracy (`/gov` — `gov.ts` + `app.ts`)

Exposes RChain [rgov](https://github.com/rhovision-org/rgov)'s governance (groups, members, issues, delegated voting) on quantum-os primitives instead of running its `.rho` — the full rationale + mapping is in `Governance.md`.

Per-room `groupStore: Map<groupId, Group>` (persisted `qos-groups-<roomId>`, synced via `sync-gov`, tombstone-aware with kind `"group"`). `Group = {id,name,creator,members:Record<peerId,{role,label,at}>, delegations:Record<peerId,{delegate,at}>, topicDelegations?, trustRatings?:Record<rater,Record<ratee,0..5>>, censures?:Record<censurer,Record<target,1>>, treasury?, kudos?, uri?, issues:Issue[]}`. Wire kinds (dyncap-signed): `group-open`, `group-member` (admin-gated by `from === creator`/admin), `group-issue`, `group-vote` (links an issue to a `/poll`), and the self-signed (only `from === actor`) **`gov-delegate`**, **`gov-trust`**, **`gov-censure`**. `mergeGroupFromSync` unions members/delegations/issues by latest `at` on join.

**Liquid democracy is the centerpiece.** `gov.ts` `resolveWeights(members, delegations, directVoters, trustWeights?)` implements: *if a member votes, their ballot counts (overrides delegation); if not, their weight flows transitively along delegation edges to whoever ultimately voted*; cycles / dead-ends abstain; `weight(d) = Σ baseWeight(m)` over members `m` flowing to `d`, where `baseWeight = trustWeights[m] ?? 1`. Those weights feed `polls.ts` `tally(poll, weights)` (the approval/IRV engines take an optional `weights` map — no change at weight 1), so a `/gov vote` opens a normal `/poll` bound to an issue but tallies **delegation- and trust-weighted**. Voting *is* the per-issue override. `/gov` subcommands act on a **focused group** (set by `/gov new`/`show` or clicking the Governance sidebar); the group card (`buildGroupCard`) shows members with each member's delegate, trust weight `[wt N]`, and `⚠` discredited flag, plus per-member **delegate** / **trust dropdown** (confer a level ≤ `myLevel−1`) / **censure** toggle controls — so liquid trust + accountability are usable without typing the commands.

**Liquid trust + accountability (Phase 2d).** `gov.ts` `trustLevels(g)` is a 2-phase deterministic fixed point: **phase 1** (increasing LFP) — affirmative trust is an **admin-rooted hierarchy** (admins seed level `TRUST_MAX=5`); a rating `v` from `r` confers `min(v, level(r)−1)` — *strictly below the rater's own level* — so two untrusted members can't bootstrap each other. **Phase 2** (decreasing) — **accountability**: `trustWeightsFor(g)` returns `1 + level` (flat `1` when no ratings → exact one-person-one-vote, backward-compatible). `/gov trust <m> <0–5>` sets a rating (capped to `myLevel−1` at the command, re-capped in aggregation so a forged high rating is auto-capped); `/gov censure <m>` flags undeserved trust and, when a **⅔ quorum of eligible censurers (members of ≥ standing, floored at 2)** is reached, the target is discredited (level→0) and every voucher is **slashed** by the level they staked — so no single member (admin included) acts alone and a disagreeing admin can't block a quorum. `discreditedMembers(g)` lists the discredited; `/gov status` shows `[wt N]` + `⚠ discredited`.

**Per-issue delegation (Phase 2a).** Besides a standing global delegate, a member can set a per-issue delegate (`/gov delegate <m> on <issue>`) stored in `Group.topicDelegations[issueId]`. `gov.ts` `delegationMapFor(g, issueId)` composes topic-over-global into the flat map `resolveWeights` consumes — the resolver is unchanged. `gov-delegate` envelopes carry an optional `issueId`; `mergeGroupFromSync` unions topic delegations by latest `at`.

**The group's on-chain record (`/gov uri`).** A room is ephemeral and a registry entry is not, so a group can record the URI its record was deployed to — `rho:id:…`, validated on the way in (`looksLikeRegistryUri`), set by an admin through the existing `group-meta` envelope, carried on `sync-gov`, and shown on the group card where clicking it prefills `/rholang read`. Recorded rather than derived: the deploy happened in someone's browser with someone's key, and only they can say where it landed. What goes *behind* that URI — a Merkle checkpoint over canonical record hashes, so the room can prove what it agreed and when — is designed in issue #96, not built.

**The group's locker (`/gov locker`).** A locker is a directory somebody installed, and being in a group should be enough to reach the group's: an admin records it through `group-meta` (validated, synced like `uri`), and `/rholang register|bind|resolve|record|grant` fall back to a locker recorded by a group **you are a member of** — the focused group first — naming which group it came from, so it is never a silent substitution of a stranger's directory for your own. Membership is the gate: adopting a locker from a group you merely see would be adopting someone else's.

**Treasury + kudos (Phase 2b).** A group can declare a `/note` treasury currency (`/gov treasury`) and a kudos reputation currency (`/gov kudos`), names recorded on `Group.treasury`/`.kudos` via an admin-gated `group-meta` envelope (synced/merged). The `/gov treasury|kudos` commands are thin orchestration over `/note` (declare → grant → pass → balance) via recursive `handleCommand`; `govCurrency(g, suffix)` derives a valid, group-unique currency name. Balances are bearer-private (you see your own).

**Inbox + daemon persistence (Phase 2c).** `/gov say <msg>` posts a membership-scoped `group-msg` (only fellow members render it — no `/channel` subscription needed). The headless memory **daemon** (`scripts/qos-cli/qos-daemon.mjs`) now persists `groups.json` and re-serves `sync-gov`, applying the same group mutation envelopes (admin/self-gated) and honoring a creator's group `retract` (tombstoned `group:<id>`), so groups survive when every browser leaves. Phase 2e (not yet built): hard role enforcement, more rgov exemplars.

### Connection & networking

**Jitsi-shaped (2026-09-18):** one connection per person that the room depends
on — the signaling WebSocket — carrying a **room-keyed, encrypted control plane**
that the relay cannot read, with the server holding a seat through a socket
blip and resuming it silently. WebRTC (a bounded-degree overlay past ~5 peers,
a default TURN relay for cross-NAT) is kept for **calls and bulk only**. **Full
detail — the transport, signaling trust model, room capacity (`ROOM_HOLDS`),
the ring+skip-link overlay, leased peer IDs, `/ice`, the default TURN relay,
and every signaling-reconnect / false leave-join fix — in
[docs/connection.md](docs/connection.md).**

Load-bearing facts for code work:

- **Control plane over the socket, sealed** (`room-crypto.js`, shared by `peer.ts` and `qospeer.mjs`): `send`/`broadcast` seal the envelope with AES-256-GCM under `HKDF-SHA256(room token)`, sender peerId as AAD, and send a `{type:"data", from, to?, payload}` frame; the server relays it (and queues it for a grace-held peer) unread. The server is told **`SHA-256` of the token as the room id, never the token** — don't send the raw token to it. Chat, lemmas, notes, polls, gov, every `sync-*` ride this. **Bulk** (`file-start`/`file-chunk`, `lib-part`) passes `{bulk:true}` and goes over a direct WebRTC channel / the overlay flood only — the server's 64 KB frame cap is for handshakes and chat. `connect()` is async (derives the key first).
- **Membership is the server's roster, and a socket blip is not a departure.** The server holds a seat `SIGNAL_GRACE_MS` (60 s) after a socket dies; a `join` under the same peerId inside it is a **resume** (`peers … resumed:true`, queued frames replayed, no `joined` broadcast). An explicit `leave` (sent on `pagehide`, own seat only) is immediate. **`onPeerReady(id)`** — fresh join (each peer listed) and each newcomer, never a resume — is where the app's handshake (`name`, `sync-*`) lives; `onChannelOpen` is the direct WebRTC link only. **A data channel closing or a pc failing for a peer the server still lists reports nothing** (cleanup + redial); `onPeerLeft` follows the server's `left`. Don't reintroduce roster changes from WebRTC state. **The socket is trusted only while heard from**: `wake()` marks it suspect until the join's `peers` reply (outbound waits), `WAKE_PROBE_MS` (4 s) without one = dead → replaced; in the foreground an app-level `ping`/`pong` after 25 s quiet, reconnect after 70 s silent — the Android app-switch zombie socket (TCP dropped under a frozen tab, `readyState` still OPEN).
- **The signaling server is an untrusted relay.** Routes SDP/ICE and sealed `data` frames, binds each socket to its peerId (`wsIndex`, validates `msg.from` on every relay and `peerId` on `leave`), token-bucket rate-limited (`SIGNAL_RATE_LIMIT` — 200/s public via `render.yaml`, 20/s code default; a hand-created Render service ignores the file), 256 KB payload cap (`SIGNAL_MAX_PAYLOAD`; was 64 KB when the socket carried handshakes alone — `sync-*` envelopes ride it now, and clients refuse to send a frame over it rather than be cut off). `GET /` reports `build` (`2026-09-18-resume-relay`). Tests: `packages/signaling/test/server.test.mjs` (in CI).
- **Bounded-degree overlay** (`ringSkipNeighbors`, `peer.ts` + `scripts/qos-cli/ring-neighbors.mjs`): past 5 peers each peer connects only to ±1/±2 in the lexicographically-sorted roster (degree 4) plus `pins` (`pinNeighbor` — every AI agent, `ensureConnected`). Degenerates to full mesh at ≤5; one formula, no mode switch. `reconcilePrune` is **deliberately inert** — an open connection is never actively closed. A `{bulk:true}` `broadcast` **floods** the overlay (`_relayId`/`_hops`/`_from` tags, stripped before `onMessage`); a `{bulk:true}` `send` needs `hasChannel` and is false without it. Agents still dial werift for exactly this — they relay bulk between two browsers that cannot reach each other.
- **`isReachable(peerId)`** = in the server's roster OR direct channel OR bulk-relay traffic within `REACHABLE_WINDOW_MS`; drives the `⚠` roster mark (now "the server no longer lists them") and status-line count. `hasChannel` is the narrower "directly linked" question for `/conn`, calls and files. The `presence` flood is gone — presence is the server's word.
- **Peer IDs are leased** (`claimPeerId`, `qos-peer-lease:<id>` in localStorage, **scoped to the dyncap anchor**) so a mobile tab eviction doesn't mint a ghost peer, and a changed identity (`/login`, storage clear) mints fresh rather than inheriting a TOFU-pinned id. A `name` envelope that fails dyncap verification is still rendered, with a ` ⚠` suffix.
- **ICE / TURN**: `peer.ts` `DEFAULT_ICE` is STUN-only; the app auto-fetches a TURN relay from `<signalingOrigin>/turn` (Cloudflare Realtime, minted server-side from `TURN_KEY_*` env vars, never in `render.yaml` / the browser) and merges it before constructing `QOSPeer`. `/ice auto on|off` opts out; `/ice turn` substitutes your own; `/ice test` reports `host`/`srflx`/`relay`. Symmetric NAT / CGNAT **needs** TURN — the retry sweep cannot help. A call whose media still can't cross to a participant is surfaced ~12/35s after start (`calls.ts` `checkMediaReach` / `CallHost.mediaBlocked`, quantum-os#126).
- **An ICE `"failed"` to a peer still in the signaling roster is *unreachable*, not *gone*** — `cleanup()` the pc so the sweep redials, mark `⚠`, do **not** `onPeerLeft`. The authoritative "they left" is the signaling `left` message (or a data-channel `onclose` for a peer we held a channel to).
- **Reconnect rebuilds, not renegotiates**: a fresh offer whose `ice-ufrag` differs from the live connection's ⟹ rebuild a clean pc (resurfaces the data channel); same ufrag ⟹ genuine renegotiation, keep the pc.
- **`onPeerLeft` is debounced 6s** (`pendingLeaves`) and idempotent — a rejoin within the window suppresses both "left" and "joined". Sticky `lastKnownNames` / `peerAgents` caches survive flaps (never cleared on leave).
- **Node agents** (`qospeer.mjs`): 30s signaling keepalive; `DISCONNECT_GRACE_MS` (30s) teardown for a `"disconnected"` pc werift never escalates (otherwise orphaned SCTP pegs a core); perfect-negotiation glare (`makingOffer`, larger peerId keeps its offer); `_rejectMedia` answers a call's audio/video with a rejected m-line (a data-only agent must never decrypt RTP). `room-memory.mjs` `serveStateTo` skips an unchanged re-serve (`_servedSig`).

### Rholang & macros

Two macro layers plus a chain client. **Full detail in
[docs/rholang.md](docs/rholang.md)**; reference doc [RChain_Macros.md](RChain_Macros.md)
(design & history); [MacRhoLang.md](MacRhoLang.md) is the end-user guide (assumes no
rholang, explains each rholang statement inline).

- **Interact2 `$`/`+` macros** (`/macro`, `+name` — `macro-lang.js` + `app.ts`): user-written commands. `/macro define|list|show|find|echo|remove` builds them; `+name args` invokes (`++text` escapes a literal `+`; `+1` is chat, not a call). **Definition grammar** (`parseDefinition`): `name body` or `name(arg, …) body` — the name is bare (a leading `$`/`+` is tolerated, not required), params bare, the body is the rest of the line *or* the lines below; an optional `// doc` sits between the signature and the body. `$param` sites in the body stay `$name`. `bodyKind()` → three kinds: first line `/` or `+` → **command** (`+name`); rholang syntax (a `!` send, `` `powerbox` ``, `for`/`match`/`new … in {`, `<-`, `=>`) → **rholang** fragment (`$name(…)` inside `/rholang eval|deploy|echo`); anything else → **text** (substitution only, `$name` yields its body). A bare `$name` line for a room macro is **shown, not run** (`showRoomMacro`) — `/rholang eval $name(…)` / `deploy` run it explicitly. `/macro edit <name>[(args)]` opens the editor on a definition. The two bodies have different lexical rules (`lexical: "rholang" | "text"`): a command body has no string literals and substitutes `$topic` textually; a rholang body treats `"$topic"` as a literal. Binding is textual, positional by default (all-`name=value` binds by name). **Macros are a per-BROWSER store** (`macroStore` — a module-level `const`, not in `RoomContext`; persisted `qos-macros`, not per room; loaded once at startup, migrating any legacy `qos-macros-<room>` keys) — a macro you write or pick up follows you into every room. It is still dyncap-signed and **contributed to each room** via the join `sync-macros` + a live `macro-define` broadcast, so peers get it and it persists for them too; **first-writer-wins by anchor**. Removal tombstones are also per-browser (`macroTombstones` / `qos-macro-tombstones`, `isMacroTombstoned`), so a `sync-macros` in another room can't heal back one you retracted. `runInput()` routes `+` → `runMacroLine`, else → `handleCommand`; `/script` and `/rhoqu` segments can be `+commands` too.
- **`$` capability macros** (`rholang-macros.js` — one source, both halves via `createMacroEngine(kernel)`): 20+ built-in templates mirroring `qucalc/examples/*.rho` (proofs, `rho:gov:*` decisions, bearer caps, `$transfer`/`$balance`, structural patterns). `expandProgram` scans for real `$name(…)` (and legacy `%name(…)`) call sites (skips strings/comments, balances brackets, splits args on top-level commas) and expands in place **without parsing the rholang**. Errors never abort — a failed site is left as typed. **`$` is the sigil because it is lexically illegal in rholang** — a missed expansion is a hard error at rnode, never silent; `%` is rholang's modulo operator and is kept only as a deprecated alias (an unknown `%name(` is reported, an unknown `$name(` is left for a later pass / a room `/macro`). Strings reach rholang via `JSON.stringify`; amounts are BigInt. `macroMode(name)` → `read-local` (answered in-browser: `$zfa`/`$verify`) · `eval` (unsigned chain read: `$balance`/`$xquote`/`$xinspect`/`$xstateof`/`$wbalance`/`$winfo`) · `deploy` (signed: `$transfer`/`$grant`/`$xopen`/`$xswap`/`$xprepare`/`$wrap`/…) · `null`.
- **`$x*` — the pooled token exchange, federated atomically** (`rholang-exchange.js`, imported by `rholang-macros.js` for the call-site shape). `$xinstall()` deploys a fresh exchange (no args). A pool trades one token pair at an owner-set fixed rate (`rate` = B per A ×1e6): `$xopen` a pool, `$xprovide` reserve (owner), `$xdeposit` a token in, `$xquote`/`$xswap` at the rate, `$xwithdraw` out. `$xlink` federates two pools by name; a cross-shard trade is a **client-driven two-phase commit** — `$xprepare` the local leg (does the swap now, holds a reversible tx record), `$xreceive` the linked remote pool over a Layer-1 remote signed deploy (credits the local leg's output as if deposited, gated to a registered link — the federation trusts its own linked pools, not an unverified cross-shard claim), then `$xcommit` both or `$xabort` whichever leg prepared (both idempotent). `$xstateof` is the durable per-tx record a crashed client's own key recovers from (`exchange-2pc.ts` `decideRecovery` — pure decision table, in CI). `abort` is **holder-or-expired-gated**: the tx's own holder may always abort a prepared tx, and anyone else may once the current block number passes the tx's recorded `expiryBlock` ([quantum-os#198](https://github.com/rhovision-org/quantum-os/issues/198), shipped) — reads `rho:block:data` inside the `abort` contract to check it, which used to silently break signed-deploy readback on the shipped rnode build (verified empirically, 2026-09-11) but no longer reproduces as of rholo `dev` `9e667e203` (re-verified 2026-09-14, not bisected which upstream change fixed it). `token` args are the tokens' own contract URIs; **never touches `revVault`** — the platform token trades only wrapped (below). A `/note` currency reaches the exchange as that URI once a token contract is deployed for it. Verified end to end against localnet, including both the self-abort and permissionless-after-expiry paths across two separate exchange deployments (a real two-shard simulation).
- **Issuer-backed tokens** (`wrapped-token.js`, imported by `rholang-macros.js`) — two uses, one ledger, one minimal ERC20 shape (mint issuer-gated; transfer and burn self-service). `$winstall(backingAddr, baseCurrency)` deploys a fresh mint/burn/transfer/balanceOf contract, issuer-gated to the deployer. **A personal currency**: `$mint(wrapperUri, amount, holder)` credits any address directly, no `revVault` involved — issued on the issuer's own word, the on-chain analog of a `/note` currency (`ExchangeDemo.md` §1). **A wrapped native token**: REV (or any chain's own) trades on the exchange only wrapped — `$wrap` is the **one** macro in this whole design that touches `revVault`, because it's the issuer's own sanctioned deploy: a real transfer to the wrapper's backing address, chained with `mint` in one program. `$wtransfer(wrapperUri, to, amount)` is ordinary peer-to-peer transfer — same shape as REV's own `$transfer` — and works identically whether the balance came from `$mint` or `$wrap`; self-identified on-chain via `rho:rev:address "fromDeployerId"` (never a caller-supplied string, same as `$unwrap`), and refuses `to == self` outright (the debit/credit `.set()` pair would otherwise alias on the same map key). `$unwrap` is the holder's own `burn`. `$wrelease` is the issuer's separate redemption step (their own transfer, chained with marking the claim released) — two macros because they're two parties' actions. `$winfo`/`$wbalance` are reads; `info` reports the backing address so anyone can `$balance` it against supply — public verifiability, not enforcement. Fungibility: `w<BASE>~<issuer8>`, the terms-series shape. Verified end to end against localnet (wrap → mint → burn → release; mint → P2P transfer both directions → guard rejections).
- **`$name(…)` as a room line** (`runDollarLine` in `app.ts`, routed from `runInput` alongside `+`): `$verify(@x)` answers locally; `$balance($me)` runs an unsigned `/rholang eval`; `$transfer(10, "1111…")` and `$anchor(…)` open the deploy path; `$( new x in { $anchor(…) } )` is a full inline program (deploy unless every site is a read). A `$name` the built-in library doesn't know falls through to this room's `/macro`-defined ones.
- **`$me`** — a client-side token resolved to this browser's own REV address (a quoted rholang string) in `resolveClientTokens` (called by `expandRholangMacros` and `runDollarLine`'s peek), before rnode sees it. Works anywhere a program is built (`$`-line, editor, a bigger program): `$balance($me)`, `$transfer(10, $me)`. Not a call site (no parens); only exists where the key is known (`rho:rchain:deployerId` is unbound in an exploratory deploy). Bare `me` still works in a `$balance(me)` chat line.
- **`$macro(…) as <pat> { …block… }`** — capture (`expandProgram` in `rholang-macros.js`). A `capture: true` macro (`$balance` / `$transfer` / `$grant`) binds its result by `<pat>` and runs the block instead of `return!`ing: `$balance($me) as bal { … }` → `… *ret) | for (@bal <- ret) { <block> }`. `<pat>` is a name, `_`, a literal, **or** a balanced `(a, b)` / `[a, …rest]` — whatever `for (@<pat> <- …)` accepts — a single arm is a plain bind, the `for` firing only when the reply matches, so match what the macro replies (its `help` states it): `$balance` → the int; `$grant` → the raw capability; `$transfer` → a normalised **`(result, error)`** tuple (`result` = `("transfer ok", amt, to)` / `Nil`; `error` = string / `Nil`) for both capture *and* its default reporting. **Repeat `<pat> { block }` for more arms** — `as (ok,Nil) { … } (Nil,err) { … }` — two or more become `for (@__reply <- <chan>) { match __reply { <pat> => { … } … } }`; `parseCaptureArms` stops arm collection at the first non-`<pat> {`, so the rest of the program is untouched. `expand(args, capture)` — `capture` is `{ arms:[{pattern, block}] }` or null; `captureSink(capture, chan)` builds the `for` (`$transfer` normalises the raw `Nil`/string reply through `__outcome` first). Non-`capture` macros reject `as`.
- **`/rholang`** (`rholang.ts` + `rholang-pipeline.ts`): verbs `status` / `eval` (exploratory, unsigned, no block) / `deploy` (secp256k1 over blake2b256 of the `DeployDataProto` protobuf) / `explain` (posts program + question to the room's AI agent) / `echo`|`show` (expansion — the answer to *should I sign this*), plus rnode settings (`rnode` · `shard` · `phlo` · `key` · `config`). `eval`/`deploy` open the live-linted `rholang-editor.ts`; every program is wrapped in `new return, stdout, zfa, grant, verify, fuse in { … }` — but `wrapProgram` **merges** those decls into the program's own top-level `new … in { … }` when it has one (a hand-written program, or any `$macro` expansion — `splitTopNew`), deduped by binding name, so a self-contained body is not double-`new`-nested. Over rnode's HTTP API (CORS-open) — no relay, no agent in between. A deploy also writes `return`'s answer to the deployer's registry slot (as `(nonce, value)`); `/rholang read` looks it up and **warns when the slot's nonce is behind your last deploy** (`readResultRecord` / `readResultsFresh` + `lastDeployNonce`) — a program that errored or never `return!`s leaves a leftover value there, and read now says so + checks `deployFate` instead of printing it as the result. `bin/rnode` ships with the repo (`scripts/localnet/run-node.sh`). **Zero-trust split:** the agent only expands, in the open; the browser lints (WASM `lint.rs`), signs (passphrase-wrapped key in IndexedDB), deploys.
- **Known gaps:** `/rholang deploy` (`rholang.ts` `deployTerm` / `signDeployData`) signs **secp256k1** via `@noble/curves` (DER over blake2b256 of the `DeployDataProto`) — verified end-to-end against the shipped `bin/rnode` (real REV transfers land in blocks). The older `rholang-pipeline.ts` educational pipeline still carries an ECDSA-P-256 placeholder and is not the deploy path. Macros expand to standalone programs, so they don't embed mid-expression. `match` is first-branch-wins; a runaway returns `reduction step budget exceeded (10000 steps)` as a bare JSON string. Every `contract` needs ≥2 params ([rholo#19](https://github.com/rhovision-org/rholo/issues/19)). On the shipped rnode build a *failed* `revVault` transfer may not reply on its return channel at all, so `$transfer … as (result, error)` only ever fires the success arm.

### Room agents + collective optimization (`scripts/qos-cli`)

Headless **agent daemons** join a room as full peers (Node; `werift` + `ws`), reusing `QOSPeer` (`qospeer.mjs`) + dyncap identity. The generalized daemon is **`agent.mjs`**; `facilitator.mjs` is a thin back-compat shim (`--role facilitator`). `scripts/qos-cli` is **outside the pnpm workspace**, so it doesn't affect the TS/Rust CI — test with `node --check` + the `*.selftest.mjs`/`loopback.mjs`/`optimize-demo.mjs` scripts, and the `*.e2e.mjs` ones (`list-cmd`, `observer`) that drive the real `agent.mjs` through an in-process relay — all listed in `scripts/qos-cli/README.md` § "Verify offline". What needs two real peers on two networks is `Live_Testing.md` (rows L1–L12; L1–L4 after any change to the connect/call path).

- **Roles** (`agent-roles.mjs`): `facilitator`, `scribe`, `greeter`, `skeptic`. A role = default name + command prefix (`cmd`) + AI `persona` + a `duties` map (intro/greet/namePrompt/silentQuarter/dominator/discrepancy/stimulate/synthesize/**verify**). **`verify`** (skeptic only) is the census-backed check: an inbound `lemma` or `/qlf-action`/`/zfa-check` history that passes the room's aggregate `achieves_zfa` but fails QLF's `achieves_zfa_pairwise` gets flagged once, with its signed action vector and the census scale of the gap (at length 6, 20,480 admitted against QLF's 5,120). `zfa.mjs` carries the ported predicate + `CENSUS_ADMITTED`. Adding one = a single registry entry (`resolveRole`/`dutiesOf`). Run: `node agent.mjs --room <cap> --role <r> [--ai --ai-backend claude-code]`.
- **AI advisor** (`facilitator-advisor.mjs`, `makeAdvisor`): backends `api` (Anthropic Messages API, `ANTHROPIC_API_KEY`) or **`claude-code`** (shells out to the local `claude` CLI = a Claude Pro/Max subscription, **no API credits**). Modes: `ask`, `stimulate`, `synthesize`, `optimize`, **`chair`** (per-phase deliberation synthesis + closure decision; phase-aware tokens, NONE-bypass so phases always render). Persona + `cmd` are per-role. The **`ask`** mode's system knowledge (`askKnowledge`) makes the agent an **expert on QuantumOS itself** — the P2P/capability-token room model + the full slash-command set (kernel, messaging/sharing, decisions/gov, `/render`, identity) + the docs — so `/facil ask "how do I …"` names the exact command (e.g. `/render` for "see the room animation").
- **Trust governance** (`gov.mjs` — faithful port of `gov.ts` `trustLevels`): the agent ingests `gov-*`/`group-*`/`sync-gov`, computes its own standing, and **scales its post budget by trust level** (`min(--budget, level)`); a ⅔ censure-discredit makes it stand down. Agents are rated/governed, **not** raters.
- **Multi-agent coexistence**: agents tag their `name` envelope with `agent:<role>`; **lead election** (lowest peerId among agents sharing a duty) de-dups shared proactive duties (intro is same-role-scoped, so each role self-introduces); posts count **collectively** against a human fair-share.
- **Commands** (user-invoked, relayed by the browser as chat — `handleCommand` relays `facil`/`facilitator`/`scribe`/`skeptic`/`greeter`): `/<cmd>` (present?), `/<cmd> help`, `/<cmd> ask <q>`, **`/<cmd> optimize <problem>`**, **`/<cmd> chair <topic>`** (+ `next`/`back`/`close`/`cancel` to steer it), `/<cmd> trust`, **`/<cmd> health`** (uptime/RSS/CPU, signaling + channel state, present peers, budget used, trust standing, last error — CPU as a lifetime average *and* a delta since the previous check, since the average hides a runaway the way `ps` %CPU hid the orphaned-SCTP burn), **`/<cmd> list [n]`** (the room's screen history the agent has seen — chat lines and `/command → result` lines, oldest→newest; default 25, max 500; a 1:1 answer to the asker, not a room broadcast; the agent's own control replies and `/<cmd> …` commands are excluded, kept in a count-bounded `transcript` buffer, not time-purged like `recentMsgs`), `/<cmd> off|on`, and — only when the agent was started with `--key` (TEST SYSTEMS ONLY) — **`/<cmd> faucet [address]`**: signs and deploys a fixed-amount REV transfer. **The address is optional and normally omitted** — an agent cannot derive a browser's REV address (the key is the browser's), so `app.ts` fills it in when relaying a bare `faucet`, and `$me` is resolved in any relayed agent command. Being asked "what's your REV address?" by something that could not know it was the bug. **Confirmation is by the recipient's BALANCE**, not by the deploy's return value: `$transfer` answers on `return`, which reaches the deployer's registry result slot — and that slot is not written on every node, so the old check could never succeed and reported every landed transfer as unconfirmed ([docs/rholang.md](docs/rholang.md#it-worked-but-reported-nothing--the-result-slot-is-not-written-everywhere)) (`rholang-client.mjs`, reusing the same `$transfer` macro the browser's `/rholang` does), no rate limit; `/<cmd> ask give me some test rev` routes to the identical function via a deterministic regex, never an LLM decision to move funds. Replies bypass the nudge throttle; per-peer self-introductions mention the command + `MyRoom`.
- **Reliability**: `qospeer.mjs` has a 30s ping/pong **keepalive** (and a 30s `"disconnected"` teardown grace — see the pegged-CPU fix in [docs/connection.md](docs/connection.md)) (reconnects a dead/zombie signaling socket — without it a long-running agent goes deaf to new joiners). Persistent identity + greet-state under `--state ./.qos-<role>`. **`run-agents.sh` / `stop-agents.sh`** launch/stop a detached set — `facilitator` + `skeptic`, staggered 15s (`STAGGER=n`); the `/rholang` macro agent is not among them, since the browser expands locally and the agent is only worth a peer when the room wants the expansion posted into chat. **`room-memory.mjs`** holds the durable half of a room (lemmas, currencies, terms-series, gov groups, dyncap chains, transcript; re-served to every joiner) and has two carriers: `qos-daemon.mjs` as a peer that does nothing else (no AI, no subscription), or `agent.mjs --persist <dir>` folding it into a role agent — one fewer peer against the signaling ceiling, at the cost of tying durability to an agent that also talks. Serving is deliberately **not** lead-gated: greeting is lead-only so N agents don't all greet, but state must be served by whoever holds it or a joiner gets nothing. `scribe` is not launched by default because its duties are a strict subset of the facilitator's; `skeptic` is, because it alone carries `verify`. `stop-agents.sh` with no arguments stops everything holding a pidfile rather than a hardcoded role list — a spelled-out list silently omits whatever is not in it, leaving that agent unstoppable by name and outliving every "stop all" around it. The signaling server caps the per-connection message rate (`SIGNAL_RATE_LIMIT`), and a peer joining a room of N sends N−1 offers plus a burst of ICE candidates, so the join cost is superlinear in room size: over the cap, handshakes stop completing while every peer still appears in the room. The **code default is 200/s** (burst 800), because a default that breaks a four-peer room protects nothing — what guards the server is the 256 KB payload cap and the wsIndex relay auth. `render.yaml` also sets it, but **a service Render did not create from that blueprint ignores the file**, so the default is what a hand-created service actually runs, and a deploy proves nothing about the environment. `GET /` reports the enforced `limit`/`burst`, and `scripts/qos-cli/signal-probe.mjs` measures what is really enforced (a manual deploy of the token-bucket code showed 21/s against the 200 the file asked for). The code default, 20/s, blows at about four peers. A browser marks a peer it has no data channel to (`QOSPeer.hasChannel` → `⚠` in the roster, "N unreachable" in the status line), so the failure is visible rather than reading as "chat is broken". **Self-healing identity announce:** the agent signs its `{name, agent:<role>}` envelope **once and caches it** (`announceName`/`signedNameEnv`), so the channel-open announce and the throttled re-announce from the 30s tick loop (`reannounceStale`, ≤ once/90s per present peer) are byte-identical idempotent re-deliveries (same anchor+seq+witness — no seq advance, no fork). This recovers the single channel-open announce when it is lost to a signaling flap (async sign + a closing data channel), which otherwise leaves a fresh browser showing the agent as an unlabelled hex id.
- **Collective optimization** (`Collective_Optimization.md`): the room run as a quantum-annealing-style optimizer — propose → score (`/poll`/`/estimate`, trust-weighted) → anneal → `/probe` → `/lemma`. `/facil optimize` (advisor `optimize` mode) facilitates a round; **`optimize-demo.mjs`** is a runnable room-session demo (named participants + a Facilitator → brute-force TSP optimum). Honest scope: a metaheuristic, **not** an instant/optimal NP solver (`OptimizationDemo.md`).
- **Chaired deliberation** (`/facil chair <topic>`, needs `--ai`; [`scripts/qos-cli/README.md`](scripts/qos-cli/README.md) "Chaired deliberation"): the facilitator becomes the room's **single neutral chair** and walks the group through six phases — **define → alternatives → evaluate → disagreements → agreements → closure** — posting a neutral synthesis at each step and recording a **decision-of-record** receipt (`<state>/rooms/<room>/deliberations/<ts>-<slug>.json` + a `deliberations.json` index; `/lemma` it into a room decision). Steered by `/facil next` (a *participant readiness signal* — anyone sends it, the one chair performs the transition, re-entrancy-guarded via `chair.busy`), `/facil back`/`close`/`cancel`; `/facil status` shows the phase. Phase prompts/syntheses ride the un-throttled `reply()` path, so a session steps briskly while the facilitator stays light-touch otherwise. **One leader by design** — Jim's EIES finding (a computer leader *and* a human leader at once stymies consensus; see `Governance.md` / `Room_Best_Practices.md`): the chair is the sole leader for the session, following best-practice facilitation (neutral framing, equal airtime, surface before converging). The six phases are the substrate's generate-then-close pattern applied to a group (divergent define/alternatives → prune evaluate/disagreements/agreements → ZFA-closed closure receipt). Verified by the live two-peer walk (in-process signaling + the real `agent.mjs` running `claude` + a driver peer through all six phases).

---

## Slash commands (app.ts `handleCommand`)

| Command | Description |
|---------|-------------|
| `/help [command]` | List all commands; `/help <command>` shows per-command detail from the `CMD_HELP` registry (e.g. `/help note`) |
| `/id` | Show your peer ID |
| `/room` | Show room ID |
| `/cap [label]` | Mint a random ZFA capability token |
| `/grant [label]` | Mint and broadcast a capability token |
| `/zfa <token>` | Validate a capability token, show twist stats |
| `/braket <states>` | Evaluate bra-ket (states: 0 1 + - i -i) |
| `/qucalc [twists]` | Evaluate RhoQuCalc twist sequence; accepts `@name` refs |
| `/conj <twists>` | Hermitian adjoint (reverse + parity-flip); flags self-adjoint inputs. The QLF "negation" operator; fixed locus Σ_sa is the operator-side counterpart of the Riemann ξ critical line (see `ReverseMathematics.md` §4.9). |
| `/freq [n\|twists]` | ZFA frequency spectrum (C(2n,n) arrangements) |
| `/lemma <claim> [\| tw]` | Register/list named lemmas. Mark the handle: `/lemma All men are @mortal`. Bare multi-word names, leading `@handle`, and legacy `/lemma [name] tw` all work. Omit twists to auto-allocate from the handle |
| `/request <name>` | Broadcast that you need `@name`; holder sees a `/pass` prompt |
| `/pass <name> <peer>` | Transfer `@name` directly to a peer; removes from sender's store, auto-registers on recipient's |
| `/note <sub>` | Promissory notes — `declare`, `grant`, `pass`, `redeem`, `split`, `merge`, `list`, `balance` |
| `/rdv <sub>` | N-party atomic rendezvous — `swap`, `accept`, `reject`, `abort`, `list` |
| `/poll <sub>` | Group decision — `new <q> [\| seeds] [ranked]`, `add <opt>`, `vote [id] <choices>`, `status`, `lock`, `close`, `remove`, `list`. Collect-then-vote with approval / ranked-choice (IRV); deterministic joiner-local tally |
| `/estimate <sub>` | Robust group numeric estimate — `new <q>`, `<number>` (submit), `status` (median + IQR), `close`; `--mean` opt. Mesh-synced (`estimate-open`/`-value`/`-close`); median is whale/outlier-resistant |
| `/coupling [tw …]` | Was the room's closure shared, or several side by side? Cuts a joint history into factors and classifies it `independent` / `product` / `coupled` / `open` against the census baseline. No args = the room's own peers (see the limitation above) |
| `/qlf-action <tw>` · `/zfa-check <tw>` | Collaborative-study verbs over the `zfa-core-wasm` kernel — propose a history string / verify ZFA closure locally (`is_count_balanced ∧ is_pauli_closed`); used by the colab-study macro |
| `/search [pos]` | The admissible **next closures** from a QuCalc position — *the search is the experiment* (truth divination). Computed in the browser (`qucalc-enum.ts`, in a Web Worker), no service (qos#119). `pos` = symbolic / `@lemma` / `cap:token`; no arg = a concurrent search over the room's `/qlf-action` proposals (a *meeting of minds*). Each discovered event is saved as an integer-named room lemma (`@1`, `@2`, …); `--no-save`/`--save-cap N` control that. Flags `--depth`/`--limit`/`--events`/`--possibilities`/`--full`. Result is broadcast |
| `/solve [pos]` | The complement of `/search`: **finds the solution, or the path to it.** Picks the one closure the substrate takes from `pos` (deterministic cascade: least peak excursion → shortest → phase `+1` → lexicographic), widening the horizon until something closes. Computed locally (`qucalc-enum.ts`), so every peer agrees with no service. On a miss, the **residual** — the exact action vector a completion still owes. `--all` for the ranked shortlist. The chosen path is saved as an integer-named lemma and broadcast |
| `/forget <sub>` | Remove an item — `poll <id>`, `lemma <name>`, `note <token\|currency denom>`, `group <name>`, `list`. Owner retracts for everyone (dyncap-signed `retract`, tombstoned so it can't re-sync back); others hide locally. Notes delete with confirm |
| `/gov <sub>` | **Liquid-democracy + liquid-trust governance** (rgov on primitives) — `new <name>`, `show`, `member add\|remove`, `issue <title>`, `delegate <peer> [on <issue>]`/`undelegate`, **`trust <member> <0–5>`** (confer a level below your own), **`censure\|uncensure <member>`** (⅔-quorum accountability), `vote <issue> \| opts [ranked]`, `treasury declare\|grant\|balance`, `kudos <m> <n>\|balance`, `say <msg>`, `status`, `list`, **`claim`** (re-attach an orphaned group to this identity — gated on the group having at most one member, so there is nobody it could take anything from), and **`chain`** — the group's governance ON CHAIN (`chain install` deploys Inbox/Group/Issue, `chain push` writes **your own** rows — membership, delegation, ratings, censures, the issues you opened and your ballots — `chain pull` reports what they hold, `chain inbox` receives (consuming), `chain send <peer> <msg>` puts a message in a member's locker, `chain inbox|group|issue <uri>` records a contract). Push is per-member by construction, not by policy: `delegate`/`rate`/`censure` are self verbs, so an admin cannot push a member's rows and a member needs no admin to push their own. Transitive delegation + trust-weighted tally; treasury/kudos via `/note`; per-group inbox; daemon-persisted; see `Governance.md` and [RGov_Core.md](RGov_Core.md) |
| `/dyncap <sub>` | Hash-only dynamic capabilities — `status`, `peers` |
| `/probe <sub>` | Joiner-local consensus probe — `status`, `clear` (the probe runs automatically on connect) |
| `/room <sub>` | Multi-room tabs — `list`, `join <cap\|url>`, `leave`, `ref`, **`hide`/`show`**. Hidden is the default: a room cap is a bearer capability, so the address bar (plus the share row and the sidebar line) is in every screen share, screenshot and recording. Hiding keeps it off screen without losing it — `qos-active-room` remembers which room a reload returns to, joined rooms come back as tabs, and copy / `/room ref` still hand out the link. Persisted per browser under `qos-hide-room` |
| `/share <selector> to <room>` | Bridge a lemma / chat / note from the active tab into another joined tab (application-level; no cross-room wire kind) |
| `/rdv counter <id> …` | Round-trip negotiation in an in-flight rendezvous — replaces rows, swaps locks, counterer implicitly accepts |
| `/channel <sub>` | Tagged broadcast messaging — `list`, `listen <name>`, `unlisten <name>`, `send <name> <text>`; per-room subscriptions |
| `/record` (⏺ in the toolbar) | Record what is on your screen, with audio, to a `.webm` download. `getDisplayMedia` + your mic + **every peer's live audio taken from the call** (a window share offers no audio at all, and a tab share only carries the room because its voices come out of the page — so they are mixed in directly instead, and a peer who joins mid-recording is added). Everything else the device is playing reaches a recording only through the picker's own **Share system audio** checkbox on a whole-screen capture (ChromeOS/Windows; Chrome does not offer it on Linux) — a consent decision no constraint can pre-tick, so `systemAudio: "include"` asks that it be offered and the chat line says it is there. 15 fps / 1.2 Mbps ≈ 540 MB/hour. **No `displaySurface` constraint** — Chrome treats it as a filter on what the picker returns rather than a hint about which pane it opens, so naming one takes the choice away from the person making it (asking for a window handed back a window when a whole screen was wanted). What *is* asked for is that the picker offer everything: **`selfBrowserSurface: "include"`** (Chrome excludes the capturing page by default, which hid the room's own tab — the one most worth capturing) and **`monitorTypeSurfaces: "include"`** for whole screens, plus `surfaceSwitching` so the surface can change mid-share. The chat line names what was actually captured — "your entire screen" / "one window" / "one browser tab" — while it can still be redone. Screen capture is desktop-only: Chrome on Android has no `getDisplayMedia`, and `noScreenCapture()` says so in those words rather than reading as a bug. Video is the surface you picked, nothing composited: a peer's video is on it if their tile is on that surface. Needs no call in progress. Broadcasts a `record {on}` line on start and stop: nobody is recorded silently |
| `/render` (alias `/animate`) | Opens `public/render.html` — an animation of the current room: its perspectives (peers, you included) bound to the shared room closure, its closures (lemmas), and groups. Snapshot of live state (peer/lemma names + group/channel counts) passed via URL params; local-only (window.open), not broadcast. The QLF/ER=EPR picture applied to the live room |
| `/script <c1>;…` | Sequential command chain on one line; `//` skips a segment |
| `/persist <sub>` | Agreed cross-peer replication of public state — request, accept, reject pending requests |
| `/rholang <sub>` | **Run rholang on rnode** — `eval` (run it, read values back; unsigned, no block), `deploy` (sign with a browser-held secp256k1 key and submit), `status`, `powerbox`, and the rnode settings `rnode <url>` · `shard <id>` · `phlo <limit> [price]` · `key generate\|<hex>\|show\|forget` · `config`. `eval`/`deploy` open a syntax-highlighted, live-linted editor (`rholang-editor.ts`; Ctrl+Enter runs, Esc cancels, loads or accepts a dropped `.rho`), while a program written inline runs as typed; every program is wrapped in `new return, stdout, zfa, grant, verify, fuse in { … }` — merged into the program's own `new` when it has one, not nested. Over rnode's HTTP API (CORS-open), so no relay and no agent in between |
| `/macro <sub>` | **Interact2 — write a `+command`.** `define name(a) body` or `name body` — bare name/params, inline or multi-line body, optional `// doc` · `edit <n>[(args)]` (write the body in the `/rholang` editor) · `list` · `show <n>` · `find [re]` · `echo <n> [args]` (expand, run nothing) · `remove <n>`. `bodyKind` → **command** (`/`+`+` first line), **rholang** fragment, or **text** (substitution). A bare `$name` line is shown, not run. Macros are a **per-browser** store (`qos-macros`, not per room) — contributed to every room you join (dyncap-signed `macro-define` / `sync-macros`), first-writer-wins by anchor. See [MacRhoLang.md](MacRhoLang.md) / [RChain_Macros.md](RChain_Macros.md) |
| `+name <args>` | Run a command somebody in the room defined. Quotes group an argument, `name=value` binds by name. `++text` sends a literal `+` line; a non-identifier like `+1` is ordinary chat |
| `$name(args)` | Run a **chain macro** — `$verify(@x)` (local), `$balance(me)` / `$xquote(…)` / `$xstateof(…)` (unsigned `/rholang eval`), `$transfer(10, "1111…")` / `$xswap(…)` / `$xprepare(…)`/`$xreceive(…)`/`$xcommit(…)`/`$xabort(…)` / `$mint(…)`/`$wtransfer(…)`/`$wrap(…)`/`$unwrap(…)`/`$wrelease(…)` / `$anchor(…)` (signed deploy), `$( … )` (inline program). Built-ins in `rholang-macros.js` (+ `$x*` exchange in `rholang-exchange.js`, wrapped native tokens in `wrapped-token.js`); unknown names fall through to this room's `/macro` fragments. `$` is illegal in rholang so a missed expansion fails loud |
| `/rhoqu <text>` | RhoQu macro language: parse `process` / `new` / `\|` parallel / `if` / `on channel` / `for`, transpile to `/command` strings, dispatch in order. `/rhoqu list` and `/rhoqu clear` manage registered `on` handlers (per-room). |
| `/conn` | What each peer connection is actually doing — channel, connection and ICE state per peer. **The unreachable warning already says this for the peer it is about** (`readConnection`), since a diagnostic you must know to run is one most people never run; `/conn` is for looking before a warning, or at everyone at once. The roster says reachable or not; this says *why* not: `ice checking` forever is candidates that never pair, `failed` is no path at all, `connected` with no channel is a third fault. Local only |
| `/version` (alias `/build`) | Which build this browser is running (`__APP_BUILD__`, the commit), the signaling server and rnode it points at, and whether WebRTC exists here. The first question of any connection puzzle, answerable without opening the sidebar |
| `/reset` | Give this browser a **fresh peer ID** and drop its dyncap TOFU pins, then reload — identity, name, groups and vault kept. For when peers show you as a bare hex id or ⚠ / contested after a `/login` recovery or a half-cleared storage: the stale peerId is anchor-pinned to your old identity on other peers, and a fresh one lets them re-TOFU you cleanly (it does not reach into *their* storage, but the `Name ⚠` fallback covers that meanwhile). `/reset identity` also mints a new dyncap seed — you rejoin as a different person; room content untouched. Asks first (`confirmDialog`), local only, excluded from the qlf broadcast |
| `/dump` | Summary of all logic shared this session |
| `//message` | Send a message that starts with `/` |

Broadcasting: commands that broadcast their output via `{kind: "qlf", cmd, arg, lines}` are anything not in this exclusion list: `/help`, `/grant`, `/lemma`, `/note`, `/rdv`, `/poll`, `/forget`, `/gov`, `/estimate`, `/dyncap`, `/probe`, `/room`, `/share`, `/channel`, `/record`, `/ice`, `/render`, `/animate`, `/script`, `/persist`, `/rhoqu`, `/macro`, `/rholang`, `/request`, `/pass`, `/dump`, `/search`, `/solve`, `/reset`. Excluded commands send purpose-specific envelopes (e.g. `/gov` → `group-*`/`gov-*`, `/estimate` → `estimate-*`) or are local-only, so a generic qlf rebroadcast would be redundant or noisy. `/search` and `/solve` are excluded only because they are async — each sends its *own* `{kind:"qlf", cmd:…}` envelope once it completes, so the room does see the result. `/qlf-action` and `/zfa-check` are *not* excluded — broadcasting their kernel verdict to the room is the point. `/rhoqu` itself doesn't broadcast — only the commands it transpiles to do, per their own rules; the same holds for a `+command`, which sends no envelope of its own and is seen through whatever its body runs.

---

## Development workflow

### Local dev

```bash
# 1. Build WASM kernel (required first)
pnpm build:wasm

# 2. Install JS deps
pnpm install

# 3. Run browser dev server (hot reload, port 5173)
pnpm dev:browser

# 4. (Optional) Run signaling server locally
pnpm dev:signaling   # port 4444
```

Change the signaling URL in the sidebar to `ws://localhost:4444` to use a local signaling server.

**Reaching a local rnode from the browser.** The dev server is https (Web Crypto needs a secure context), and a browser refuses plain http to any host but **loopback** — where loopback means the machine the *browser* runs on. On a Chromebook that is ChromeOS while rnode is inside the Linux VM, so `http://127.0.0.1:40403` finds nothing and the VM's own address is blocked as mixed content. Vite proxies the node at **`/rnode`** for exactly this: `/rholang rnode https://<host>:5173/rnode` is same-origin https on the cert already accepted. `isBlockedMixedContent` in `app.ts` refuses only what is genuinely blocked (http to a non-loopback host) — loopback is exempt and must not be refused, or a node that works is turned away.

### Type checking

```bash
cd packages/browser && npx tsc --noEmit
```

Always run before committing browser changes.

### Rust tests

```bash
cargo test --workspace
```

### Build for production

```bash
pnpm build:wasm && pnpm build:browser   # output: packages/browser/dist/
```

### Branches

`main` is what is **deployed**: a push to it publishes GitHub Pages and redeploys
the signaling server on Render. So it is not the place to accumulate work.

```
project branch ──┐
project branch ──┼──▶  work  ──PR──▶  main   (deploys)
small change ────┘
```

- **`work`** — the working branch. Small changes go straight here; project
  branches are cut from it and merged back into it. CI runs on every push to it,
  so nothing reaches `main` unrun.
- **project branches** — one per piece of work, cut from `work`, merged to
  `work` (a PR if it wants reading, otherwise directly). Delete them the same
  session.
- **`main`** — reached only by a PR from `work`, which is the moment the batch
  goes live and the place to read it as a whole.

```bash
git checkout work && git pull                 # start from the working branch
git checkout -b some-feature                  # a project branch off work
gh pr create --base work                      # …reviewed into work
gh pr create --base main --head work          # …and work into main, when it should ship
```

An urgent fix still goes straight to `main` — then `git checkout work && git merge main`,
so the two do not drift.

### Deployment

- **GitHub Pages**: auto-deploys on every push to `main` via `.github/workflows/pages.yml`
- **Signaling server**: **redeployed by hand**, from the Render dashboard. `render.yaml` describes
  the service but does not drive it — the running service was created by hand rather than from the
  blueprint, so Render neither watches the repo for it nor reads that file (the same reason
  `SIGNAL_RATE_LIMIT` in `render.yaml` is not what the service actually enforces). A push to `main`
  therefore deploys Pages and nothing else; a signaling change is live only once somebody redeploys it.

### CI

On every push/PR to `main`:
1. `cargo test --workspace` — Rust unit tests
2. `pnpm build:wasm` + `pnpm build:signaling` + `tsc --noEmit` — WASM build and TS typecheck
3. the plain-JS `--selftest`s and `packages/browser/test/*.test.mjs` (see the `wasm` job)
4. `python3 scripts/doc_network_check.py` — the document network (below)

Check CI: `gh run list --limit 5`
On failure: `gh run view <run-id> --log-failed`

### Documentation PRs

The docs are a **network**, and the root `README.md` is its hub, not its index (quantum-os#116).
`README.md` routes by intent ("Choose your path") and keeps only what every reader needs;
the engineering parent is `docs/architecture.md`, the full command reference is
`docs/commands.md`, and every other doc hangs off one of those, the User Guide, or the
Developer Guide. `python3 scripts/doc_network_check.py` runs in CI and fails on an orphaned
root/`docs/` `.md`, a dead relative link, or a `#anchor` that names no heading — so run it
before pushing a doc change. Then the review questions, for any new or moved page:

- **Does it have a clear parent?** One doc links to it *by intent* (a row in the README's
  routing table, or a section of the parent that says why you'd read it) — not just a bare
  mention.
- **Does it link out to its dependencies?** A claim of a proof or a security property is
  followed by a hard relative link to the exact `.md` / `.lean` / source file.
- **Is it running code or a design?** A design that is not implemented goes in the README's
  *Roadmap* table with its issue, and says so in its own first lines — never in a section
  that reads as shipped.
- **Did the README get longer?** It should not. A new feature adds a row to an existing table
  or a line to a sub-document; the reference material lives in `docs/`.

---

## Key files to know

| File | What to touch it for |
|------|----------------------|
| `packages/browser/src/app.ts` | All slash commands, lemma/note/rdv stores, UI logic, peer callbacks |
| `packages/browser/src/notes.ts` | Note primitives (mintNote, splitNote, mergeNotes, parseNoteLabel, denomination) |
| `packages/browser/src/rendezvous.ts` | Rendezvous protocol types, conservationCheck, cyclicSwap |
| `packages/browser/src/dyncap.ts` | Dyncap protocol (signEnvelope, verifyEnvelope, anchor / witness derivation) |
| `packages/browser/src/probe.ts` | Discrepancy probe types + `findDiscrepancies` + supermajority constants + `losingPeersIn` |
| `packages/browser/src/polls.ts` | Pure poll-tally module — `optionId`, `tallyApproval`, `tallyRanked` (IRV), `tally`, `liveCounts`, `sortedOptions`, `summarizeWinners` (no DOM/storage). Tallies take an optional `weights` map for liquid-democracy weighting (no change at weight 1) |
| `packages/browser/src/lemma-parse.ts` | Pure `/lemma` grammar (issue #128) — `parseLemmaDecl` (`<statement> [\| twists]`, `@handle` marking, bare multi-word names), plus `canonLemma` / `parseRefTokens` / `splitLemmaNameArg` moved here. No DOM/storage; `test/lemma-parse.test.mjs` |
| `packages/browser/src/gov.ts` | Pure governance module — `Group`/`Issue`/`Member` types + **`resolveWeights`** (transitive delegation → per-voter weight, with override + cycle abstention, optional `trustWeights`), **`trustLevels`** (admin-rooted hierarchy + ⅔-quorum censure accountability, 2-phase fixed point), `trustWeightsFor`, `discreditedMembers`, `delegationMapFor`, `issueId`, `delegatorsOf`. Drives `/gov`; see `Governance.md` |
| `packages/browser/src/macro-lang.js` | **The `$` macro language (Interact2).** Plain JS, no imports, node-runnable: `parseDefinition`, `parseInvocation`, `bindArgs`, `substitute`, `expandCallSites`, `expandCommand`, `splitBody`, `findMacros`. Carries BOTH lexers — a rholang body skips string literals and comments, a command body does not (see [docs/rholang.md](docs/rholang.md)). `node packages/browser/src/macro-lang.js --selftest` covers it |
| `packages/browser/src/rholang-macros.js` | **The `%` capability macro registry — one source for both halves.** Plain JS, ZFA kernel injected via `createMacroEngine(kernel)`; two sibling imports (`rholang-exchange.js` and `wrapped-token.js`, also plain JS) for the `$x*` / `$wrap` shapes. Registry + arg validators + templates + the rholang call-site scanner (`expandProgram`). Edit macros here and nowhere else; `node scripts/qos-cli/rholang-macros.mjs --selftest` covers it |
| `packages/browser/src/rholang-exchange.js` | **The pooled token exchange contract + `$x*` call-site builders.** Plain JS, no imports, `--selftest` (in CI). `EXCHANGE_RHO` (open/provide/deposit/quote/swap/withdraw/link/setRate/inspect + the atomic 2PC verbs prepare/prepareReceive/commit/abort/stateOf — method dispatch, consumed-and-restored state cells, ≥2 params, no quoted names, never `revVault`, never binds `rho:block:data`) + `installProgram` / `*Program` builders. Federates across shards atomically via a remote signed deploy (rholo#33). Verified end to end against localnet, including the abort path |
| `packages/browser/src/exchange-2pc.ts` | **The client-side cross-shard trade recovery logic.** Pure — `TxLegStatus`, `decideRecovery(local, remote)` (the exhaustive decision table a crashed client's reconnect follows), `makeTxId`, `evaluateTrade`. No network calls; `test/exchange-2pc.test.mjs` covers every reachable status pair (in CI) |
| `packages/browser/src/wrapped-token.js` | **A wrapped native token (REV, or any chain's own) + `$wrap`/`$unwrap`/`$wrelease` call-site builders.** Plain JS, no imports, `--selftest` (in CI). `WRAPPED_TOKEN_RHO` (mint/burn/release/balanceOf/claimOf/info — issuer bound at install, never a runtime arg; `burn` self-identifies the caller via `rho:rev:address`, never a caller-supplied string; the contract itself never mentions `revVault`) + `installWrappedProgram` / `*Program` builders. The one sanctioned `revVault` touch in this whole design lives in `$wrap`/`$wrelease` in `rholang-macros.js`, not here. Verified end to end against localnet (wrap → mint → burn → release) |
| `packages/browser/src/dictionary.js` | **The master dictionary, redesigned** ([MasterDictionary.md](MasterDictionary.md)) — a working prototype of the naming layer the governance contracts need. Plain JS, no imports, `--selftest` (in CI). **A name is rooted in the identity that owns it** (`<revAddr>/<path>`): a caller may write under their own REV-address prefix and no other, checked by derivation rather than by a permission bit, so publishing is self-service and squatting is *not expressible*. Short names (`Inbox`) are a governed tier of **aliases** to rooted paths, so upgrading is re-pointing one. Versions are append-only (immutable by construction), `seal` closes a path, and `grant` is **revocable** via a per-path epoch. Replaces a genesis dictionary that stores nothing — `Directory`, `Echo` and `Log` there are the same stateless factory, so a write to it succeeds into a throwaway |
| `scripts/localnet/dictionary-check.mjs` | **Does the redesigned dictionary hold up on a chain?** 27 checks including the four that must fail: publishing outside your own root, a writekey used after `revoke`, publishing to a sealed path, and setting a short name without the root authority. Needs a key and a node, so not in CI |
| `scripts/localnet/locker-check.mjs` | **Does the locker still work on a chain?** Install, register (twice, for idempotence), bind, resolve, another identity resolving your name, read, grant, and an unknown verb — against a live node with signed deploys. Two defects survived the offline selftest for months (a `(_, caps)` unwrap this node does not send, and an answer written only to a result slot this node does not write), both of which made a healthy locker look absent. Needs a key and a node, so not in CI |
| `packages/browser/src/rgov-core.js` | **The three on-chain governance contracts — Inbox, Group, Issue.** Plain JS, no imports, `--selftest` (in CI). They hold durable state and nothing else: the trust metric, delegation, tallying and censure are already node natives (`rho:gov:*`), so every verb on a `read` facet is named after **the argument of the native it feeds** and no governance policy lives in a contract. Three facets — `read` (never answers a capability or a message body), `self` (mutates only the caller's own row, so it is safe to publish), `admin` (migration; **the Inbox refuses whole-contract dump/load** — dump returned message bodies, and load could never carry an unforgeable, so a vault migrates per-identity via `export`/`import` in one term). Identity is **derived** inside the contract via `rho:rev:address("fromDeployerId", …)` and guarded against `Nil`, because a deployer id that is not one yields Nil rather than an error. A deployer id is **unforgeable but delegable by disclosure** — a key, not a signature — so no contract here ever stores or returns one, asserted in `--selftest` ([SECURITY.md](SECURITY.md#rhorchaindeployerid-is-a-key-not-a-signature)). One state cell, consumed and restored. One arity per facet, so a wrong-arity call answers `("gov-error", "bad verb or arity")` instead of falling silent (law 40). Design + evidence: [RGov_Core.md](RGov_Core.md) |
| `scripts/localnet/rgov-core-check.mjs` | **Do the governance contracts still work on a chain?** Installs all three and walks a scenario ending in `trustLevels` → `resolveWeights` → `tally`, including the negatives (a non-admin setting a role, a public read asked for a message body, a wrong-arity call, a vault asked for a whole-contract dump) and the migration that proves a **capability survives**: a send-cap delivered into a locker, migrated to a second Inbox, then used from the new contract against the old one. Needs a funded key and a node, so not in CI — run it after touching `rgov-core.js` |
| `packages/browser/src/rholang.ts` | **The `/rholang` node client** — config (persisted), REV address derivation, DeployDataProto protobuf encoding + secp256k1 signing, `evalTerm` / `deployTerm` / `readResults`, the powerbox table with signatures, and `wrapProgram`. Also `deployToNode(baseCfg, url, term)` — deploy to a *specific* node with a per-node result-slot nonce and no persisted-config write (for a workflow that spans nodes; kept for the CapTP gateway direction, #173) |
| `scripts/localnet/macro-check.mjs` | **Do the macros still work?** Runs every expansion on a live rnode; a failure gives the macro, the line it died on, and rnode's answer. An expansion test cannot catch this — it only checks a macro produced the rholang it meant to. Not in CI (needs a node) |
| `scripts/localnet/` | Keys, wallet, and `run-node.sh` that start the **shipped** `bin/rnode` — a checkout of quantum-os alone brings a chain up. `README.md` records the files, `RNODE=` for a candidate build, and why the keys are committed |
| `packages/browser/src/rholang-pipeline.ts` | Browser half of the macro path — WASM lint (`lintRholang`), passphrase-wrapped key store (IndexedDB), sign, deploy. Binds the shared `%` engine |
| `packages/browser/src/rhoqu.ts` | RhoQu tokenizer, parser (`process`/`new`/`if`/`on`/`for`/`\|`), AST, and `transpile(source, ctx?)` that emits a `string[]` of `/commands`. `RhoQuContext` interface + `OnHandler` for `on channel(x) { … }` dispatcher registration. |
| `docs/connection.md` | Networking detail split out of this file — signaling trust, room capacity, ring+skip overlay, leased peer IDs, `/ice`, TURN, signaling-reconnect fixes |
| `docs/rholang.md` | Rholang + macros detail split out of this file — Interact2 `$`/`+` macros, `%` capability macros, the `/rholang` chain client |
| `MacRhoLang.md` | End-user guide to the macro layer — writing `+commands` (no rholang), then the `$` chain macros with each rholang statement explained inline. Update when `/macro define` grammar or the `$`/`as` forms change |
| `Consensus.md` | Reference doc for the joiner-local consensus probe — protocol, trust model, BFT comparison |
| `Group_Decisions.md` | Map of group-decision processes the interface supports — built (poll / probe / rdv / channel / lemma) and sketched (quorum, weighted, quadratic, delegation, sortition, consent, conviction), each mapped to a primitive |
| `RhoQuDemo.md` | End-user walkthrough of `/rhoqu` — atomic swap with conditional accept, dining philosophers, multisig with persistence |
| `ExchangeDemo.md` | End-user walkthrough of the pooled token exchange — opens with minting and persisting a personal currency on-chain (`$winstall`/`$mint`, `wrapped-token.js`), then open/provide/deposit/quote/swap/withdraw (`rholang-exchange.js` / `$x*` macros), the atomic `link`/`prepare`/`receive`/`commit`/`abort` cross-shard federation over Layer 1 (2PC), wrapped native tokens (`$wrap`/`$unwrap`/`$wrelease`), the `/note`-currency connection. Update when a verb, a `$x*`/`$w*` macro, or the federation model changes |
| `packages/browser/src/palette.ts` | The toolbar, the command menu, and `CMD_HELP`. Quick actions **ask for their arguments** (`ArgSpec` → one prompt at a time, Enter continues, Esc cancels) and run the assembled line through the box, so it echoes and lands in history like a typed one. Typing past a command's name shows its syntax from `CMD_HELP` instead of a command list — `isPicking()` keeps that hint out of Enter's way, and `justTouched()` keeps a touch on the panel from dismissing it (the panel closes on the input blurring, and touching the panel is how the input blurs — so on a phone, reading it dismissed it; the menu's own items cancel `mousedown` instead, which the hint cannot do without making its text unselectable). A browsable menu (the command list, Other) closes on a click outside it too — real, but not obvious ("clicking elsewhere works but it's not obvious" — reported live) — so it carries its own sticky ✕ (`addCloseBar`, `position:sticky; top:0` inside the menu's own scroll, no separate scroll container needed) pinned above the list regardless of scroll. Eight buttons, the room first and what outlives it next: **Ask** (a `fill` action — drops `/facil ask ` into the box and leaves it there to finish typing, no guided prompt and no auto-run, since a question is free text) · Call · Record · Rholang · Poll · Estimate · Commands · **Other**, sectioned: *Group* (the groups you are in, start one, rate a member's trust) · *Value* (mint a note) · *Getting set up* (name, password, login, invite, reset peer ID, help) · *If you use a chain*, last and named as a branch — point at a node, make a signing key, claim the locker record, record where a group lives on chain. **A room is whole with no chain**: peers, decisions, notes and groups need no node, no key and no phlo, so nothing chain-dependent sits in the sequence someone reads as "what I have to do to start". Everything else is still in `⌘ Commands` and `/help` |
| `packages/browser/vite.config.ts` | Dev server (https, so Web Crypto works off-loopback), the `/signal` and `/rnode` proxies, and the build stamp: `__APP_VERSION__` from package.json plus **`__APP_BUILD__`, the commit** — shown at the foot of the sidebar, because "are you on the new build?" is the first question of every peer-connection puzzle and a static version number cannot answer it |
| `packages/browser/src/record.ts` | Screen recording — `getDisplayMedia` + mic mixed, `MediaRecorder`, and the two constraints that shape it: chunks stream to an **OPFS scratch file** so memory stays flat (a Blob-at-the-end holds ~1 GB/hour in RAM), and OPFS needs no user gesture where `showSaveFilePicker` would want the one `getDisplayMedia` already consumed. The download is handed the `File`, so the bytes never come back through JS |
| `packages/browser/src/calls.ts` | Live calls — media acquisition, tiles (click one to fill the window), screen share as a track swap, and what to do when acquiring fails. `permissionState()` reads the browser's **stored** answer before asking: a prompt appears only when the answer is unknown, so "I allowed it to ask and it never asks" is a stored block or an OS withholding the camera from the browser itself — both silent, and both named rather than waited on |
| `packages/browser/test/peer.test.mjs` | **The retry sweep, which has been wrong twice.** Both of the day's connection failures were reported from a live room rather than caught: a failed handshake never retried, then a retry that redialled attempts still negotiating so slow paths (phones) could never finish. Neither needs a browser — a stubbed clock, socket and `RTCPeerConnection` reproduce both. Covers: joining dials the room, an in-flight attempt is left alone, a stuck one is retried, a failed one is redialled, **both** ids retry (deferring to the lower one assumed the other side has the fix — false with mixed builds), a departed peer is not chased, and — a third live report — a peer whose direct connection *fails* while it is still in the signaling roster is kept and retried (not `onPeerLeft`), so a cross-NAT peer reachable only over the relay does not vanish from the roster |
| `packages/browser/src/peer.ts` | WebRTC connection, signaling reconnect + `wake()`, onPeerJoined/Left/ChannelOpen |
| `packages/browser/public/render.html` | The `/render` room animation — self-contained canvas (no deps), reads the room's live state (perspective/closure names, group/channel counts) from URL params and draws perspectives bound to the shared room closure, closures (lemmas), and groups. Deploys to `/quantum-os/render.html` |
| `Room_Bridges.md` | Sharing information among perspectives *across rooms* — the bridge model (a member of both rooms is the shared closure, ER=EPR), what `bridge.mjs` relays (channels/chat/lemmas/gov), signed-verbatim relay, loop prevention, and honest scope |
| `scripts/qos-cli/agent.mjs` | Generalized room-agent daemon — roles, duties, lead election, trust standing, advisor wiring, commands (ask/optimize/**chair**+next/back/close/cancel/trust/off/on/**faucet**), chaired-deliberation state machine + receipts. `facilitator.mjs` is a shim |
| `scripts/qos-cli/agent-roles.mjs` | Role registry (facilitator/scribe/greeter/skeptic) — `resolveRole`/`dutiesOf`; add a role here |
| `scripts/qos-cli/rholang-client.mjs` | **TEST-SYSTEM-ONLY REV faucet's deploy client.** Hand port of `rholang.ts`'s deploy-signing path (protobuf encoding, secp256k1 signing, REV-address derivation, `wrapProgram`) with `localStorage` config swapped for a plain in-memory `{key, url, …}` the caller supplies — verified byte-identical against `scripts/localnet/keys.mjs`'s REV-address derivation. Backs `agent.mjs --key`/`/facil faucet`; a deliberate, narrow exception to "an agent never holds a key" (contrast `rholang-agent.mjs`, which only ever previews for client-side signing) |
| `scripts/qos-cli/bridge.mjs` | Room **bridge** — one headless perspective in ≥2 rooms relaying each room's outputs as the others' inputs: channels (default) + `--chat`, plus durable state `--lemmas` (published lemmas + `sync-lemmas` import) and `--gov` (`group-*`/`gov-*` mutations + `sync-gov` import). Signed state relayed **verbatim** so the signer's dyncap chain carries through; origin-labeled text, loop-guarded (`_bridge` tag + `--max-hops` + durable per-item dedupe). ER=EPR at the collaboration layer (a member of both rooms IS the shared closure). See [`Room_Bridges.md`](Room_Bridges.md) |
| `scripts/qos-cli/facilitator-advisor.mjs` | AI advisor `makeAdvisor` — backends `api`/`claude-code`, modes ask/stimulate/synthesize/optimize/**chair** (single-neutral-chair persona, per-phase synthesis + closure decision), per-role persona. The **`ask`** knowledge (`askKnowledge`) makes the agent an **expert on QuantumOS itself** — room model + full slash-command set (incl. `/render`) + docs — so `/facil ask` names the exact command. Keep it in sync when adding commands |
| `scripts/qos-cli/gov.mjs` | Port of `gov.ts` `trustLevels`/`discreditedMembers` so an agent computes its own trust standing |
| `scripts/qos-cli/qospeer.mjs` | Node `QOSPeer` transport (werift+ws) + 30s signaling keepalive + 30s `"disconnected"` teardown grace (`DISCONNECT_GRACE_MS`, stops orphaned SCTP associations pegging a core) + perfect-negotiation glare handling (`makingOffer`, larger-peerId-keeps-its-offer — stops two co-located agents rebuilding forever) + `_rejectMedia` (answers a call's audio/video with a rejected m-line — a data-only agent must never receive RTP, or werift burns a core decrypting it; the fix that let a 3rd agent run); imports werift through `werift-patched.mjs`; shared by agents + the memory daemon |
| `scripts/qos-cli/werift-patched.mjs` | Re-exports `werift` with `RTCCertificate.getFingerprints()` memoized (issue #125) — werift re-parsed the cert PEM + re-hashed it on every inbound ICE candidate (~1.5 ms × the SDP rebuild), pegging ~40 %/core per idle agent. Patches the shared class prototype at import time; `werift-patched.selftest.mjs` covers it. See docs/connection.md |
| `scripts/qos-cli/optimize-demo.mjs` | Runnable collective-optimization demo (room session on TSP → optimum); see `Collective_Optimization.md` |
| `packages/browser/src/zfa.ts` | Browser-side ZFA helpers (validateCapability, twistStats, …) |
| `packages/browser/src/qucalc-enum.ts` | The local `/search` + `/solve` enumerator (qos#119) — `enumerateClosures` / `runSearch` / `solvePosition`, a 1:1 port of `quantum-logical-framework/qucalc_search.py`. Gates on QLF's per-axis count balance (not `achievesZfa`'s aggregate). Imports only `zfa.ts`; `test/qucalc-search.test.mjs` covers it + a conformance block vs the Python |
| `packages/browser/src/qucalc-search.ts` | Async front door to `qucalc-enum` — `qucalcSearch` async generator + `qucalcSolve`, running the core in a Web Worker (`qucalc-worker.ts`) with an inline fallback. Same yield/return shape as the old HTTP client |
| `packages/browser/index.html` | Layout, CSS, sidebar structure |
| `packages/signaling/src/server.ts` | Signaling relay, rate limiting, relay auth, `GET /turn` |
| `packages/signaling/src/room.ts` | Room membership, broadcast |
| `packages/signaling/src/turn.ts` | Mints short-lived Cloudflare Realtime TURN credentials from `TURN_KEY_ID`/`TURN_KEY_API_TOKEN` (env vars on the Render service — never `render.yaml`, never the browser); cached 1h. See "Calls must work across networks" |
| `crates/zfa-core/src/` | ZFA kernel in Rust (capability, twist algebra, WASM exports) |
| `SECURITY.md` | Threat model and known issues — update when fixing security bugs |
| `SyllogismDemo.md` | End-user walkthrough — update when UX or commands change |

---

## Philosophical foundations (shared with QLF)

QuantumOS is the **executable instantiation** of the Quantum Logical Framework. The ZFA capability model is not an analogy — it is the same algebraic invariant that QLF machine-verifies in Lean 4:

- `rho_process_always_zfa` — parallel composition stays ZFA-balanced
- `decoherence_impossibility` — no operation can break ZFA balance
- `bra_ket_always_balanced` — bra-ket well-typedness IS ZFA balance

In a classical OS, security, scheduling, error correction, and garbage collection are separate subsystems. In QuantumOS all five are the same operation — ZFA enforcement — because possessing a capability token IS proof of authorization (Curry-Howard). The room process `parallel(peer1, peer2, …)` is machine-verified to stay balanced under composition.

The QLF math substrate has **active inference built into its foundation**: every admissible state is a free-energy-minimizing trajectory of a Markov-blanket agent, with per-event ΔF = −log 2 saturated by half-spin ZFA closure. The kernel here realises that substrate as an executable system — every capability token, room and closure is a concrete instance of the active-inference math. The runtime ZFA check (`is_zfa = is_count_balanced ∧ is_pauli_closed`, in `crates/zfa-core` and `zfa.ts`) is Lean-anchored in QLF at three layers: count balance under concatenation (`emergent_blanket_formation`), Pauli closure in the abstract scalar group (`pauli_closed_of_admissible_zfa`), and the explicit σ-matrix mapping (`hermitian_pair_is_pauli_scalar`, `concat_pairs_is_pauli_scalar`). QLF's wider programme — the constants-from-substrate derivations (α at 0.026%, m_p/m_e at 0.002%, γ at 0.017%, all Lean-verified), the vacuum-alignment TOE-completing layer, the atomic/nuclear mass spectrum, the Riemann prime-annihilation argument, the Kitada local-time GR scoping — lives in the QLF repo, not here.

See [QLF CLAUDE.md](https://github.com/rhovision-org/quantum-logical-framework/blob/main/CLAUDE.md) and [AI.md](https://github.com/rhovision-org/quantum-logical-framework/blob/main/AI.md) for the full theoretical background.

### What NOT to say

- Do not describe the signaling server as trusted — it is an explicit untrusted relay
- Do not describe ZFA tokens as "passwords" or "API keys" — possessing the token IS the capability, with no separate authentication step
- Do not describe lemma auto-allocation as random — it is deterministic from the name, giving identical results on every client
- Do not describe the room as a server — the room is the emergent ZFA process of the peers; the signaling server only routes handshakes
