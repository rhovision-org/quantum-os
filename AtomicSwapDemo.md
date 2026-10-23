# Atomic Swap by Rendezvous

A step-by-step walkthrough of two peers — **Alice** and **Bob** — using [quantum-os](README.md) to swap currencies atomically with **`/rdv swap`**. Neither party fronts value, no escrow exists, no third party mediates. The exchange commits as a single composite event or not at all.

> Standard `/note pass` moves a token in one direction. To trade — Alice gives USD, Bob gives EUR, at the same moment — the system needs an event that succeeds or fails as a whole. That's what rendezvous is.

The protocol generalizes to N parties (cyclic n-way swap), with **ZFA conservation enforced over the joint composition**: `multiset(gives) == multiset(gets)`. The wire-level machinery lives in [`packages/browser/src/rendezvous.ts`](packages/browser/src/rendezvous.ts); the dispatcher and message handlers are in [`packages/browser/src/app.ts`](packages/browser/src/app.ts). The shipped MVP exposes the 2-party case via `/rdv swap`; the underlying protocol supports n.

---

## The model

A rendezvous is a single composite move across N participants:

```
inputs  = (cap_1, cap_2, …, cap_N)     each participant contributes a token
outputs = (cap_1', cap_2', …, cap_N')  each participant receives a token
invariant: multiset(inputs) == multiset(outputs)        — joint conservation
            and every individual cap is ZFA-balanced    — algebraic well-formedness
```

The wire is five direct-send envelope kinds — never broadcast:

```
rdv-propose   proposer    → each participant   (carries the proposal)
rdv-accept    participant → proposer           (carries the committed gives token)
rdv-reject    participant → proposer
rdv-commit    proposer    → each participant   (carries final token assignments)
rdv-abort     proposer    → each participant   (releases locks)
```

While a proposal is pending, accepted-but-not-yet-committed tokens move from `noteStore` to a separate `lockedNotes` map. `/note pass` and friends don't see them. They are released on abort / reject / timeout (60 s default); consumed on commit.

---

## Setup: both peers connect, each issues a currency

Alice opens the room, copies the share link, and Bob joins. Both set their display names.

Alice declares USD and grants herself USD 100. Bob declares EUR and grants himself EUR 100. The declarations and grant *announcements* sync to both sides automatically — see [PromissoryNoteDemo.md](PromissoryNoteDemo.md) for the per-command detail.

After setup:

```
ALICE                                BOB
│ Currencies (2)          │          │ Currencies (2)              │
│ ✦ USD               ←   │          │ ✦ EUR                   ←   │
│ EUR  (by Bob)       ←   │          │ USD  (by Alice)         ←   │
│                         │          │                             │
│ Notes (1)               │          │ Notes (1)                   │
│ USD 100             ←   │          │ EUR 100                 ←   │
```

Each peer holds their own issuer authority (`✦`) and a denomination-100 note in their own currency. Each sees the *other* currency as a known room declaration with the other peer as issuer.

Both wallets are *individually* ZFA-balanced and the room process `parallel(Alice, Bob)` is balanced, but the room is in a static state: nothing has moved.

---

## Step 1 — Alice proposes the swap

Alice wants to convert USD 30 into EUR 20 with Bob. She types:

```
ALICE TYPES:  /rdv swap USD 30 EUR 20 Bob
```

What happens, in order:

1. Alice's dispatcher picks her USD 100 note, **auto-splits** it into a USD 30 piece and a USD 70 change piece. The change goes back into her `noteStore`; the USD 30 piece moves into `lockedNotes` (reserved for this proposal).
2. A `Proposal` is constructed by `cyclicSwap`:

   ```
   id: a3f1c2…  (random 16-hex)
   proposer: cap:peer:Alice…
   rows:
     { participant: Alice, gives: {USD, 30}, gets: {EUR, 20} }
     { participant: Bob,   gives: {EUR, 20}, gets: {USD, 30} }
   expiresAt: now + 60s
   ```

3. `conservationCheck(rows)` runs locally: `{(USD,30), (EUR,20)}` on the `gives` side, `{(EUR,20), (USD,30)}` on the `gets` side — equal as multisets. ✓
4. The proposal is stored with `role=proposer, myStatus=accepted` (the proposer implicitly accepts their own row at propose time).
5. `rdv-propose` is direct-sent to Bob's peer ID. A 60 s timeout is scheduled.

**Alice's window:**

```
┌──────────────────────────────────────────────────────────────┐
│  · proposed rendezvous a3f1c2… to Bob                        │
│  ·   you give USD 30, get EUR 20                             │
│  ·   expires in 60s — /rdv abort a3f1c2 to cancel            │
│  ·   (change 70 returned to your wallet)                     │
└──────────────────────────────────────────────────────────────┘
```

Alice's sidebar wallet now shows:

```
│ Notes (1)               │     ← USD 30 is locked (not in noteStore)
│ USD 70              ←   │
```

Type `/rdv list` to see the locked piece:

```
ALICE TYPES:  /rdv list
```

```
┌──────────────────────────────────────────────────────────────┐
│  · proposals (1):                                            │
│  ·   a3f1c2…  (yours)  — you give USD 30, get EUR 20  [accepted]│
│  · locked notes (1):                                         │
│  ·   USD 30  (for rdv a3f1c2…)                               │
└──────────────────────────────────────────────────────────────┘
```

**Bob's window** receives the proposal — `rdv-propose` arrives, his handler validates `conservationCheck` and finds his own row:

```
┌──────────────────────────────────────────────────────────────┐
│  Alice  proposes rendezvous a3f1c2…                          │
│  ·   you give EUR 20, get USD 30                             │
│  ·   /rdv accept a3f1c2   or   /rdv reject a3f1c2            │
└──────────────────────────────────────────────────────────────┘
```

Bob's `proposals` map has a pending entry with `role=participant, myStatus=pending`. Nothing in his wallet has moved yet.

---

## Step 2 — Bob accepts

Bob examines the proposal in his chat log and runs:

```
BOB TYPES:  /rdv accept a3f1c2
```

His dispatcher looks up the proposal by short-id prefix, finds his row, picks his EUR 100 note, auto-splits it into EUR 20 + EUR 80 change, moves the EUR 20 into `lockedNotes`, marks his own status as `accepted`, and direct-sends `rdv-accept` to Alice carrying the specific token he committed.

**Bob's window:**

```
┌──────────────────────────────────────────────────────────────┐
│  · accepted rendezvous a3f1c2…                               │
│  ·   locked EUR 20; awaiting commit…                         │
│  ·   (change 80 returned to your wallet)                     │
└──────────────────────────────────────────────────────────────┘
```

Bob's sidebar:

```
│ Notes (1)               │     ← EUR 20 is locked
│ EUR 80              ←   │
```

---

## Step 3 — Alice's handler commits

Alice's `rdv-accept` handler receives Bob's envelope. It validates that the token Bob committed matches Bob's row's `gives` spec (currency = EUR, denomination = 20, `validateCapability` true). It stores `acceptedBy[Bob] = bobToken`.

It then checks: every participant has now accepted (Alice implicitly at propose time, Bob just now). All-accepts. The handler builds the commit rows by the cyclic mapping `row[i].gets = next-row's gives`:

```
commitRows:
  { participant: Alice, givesToken: <Alice's locked USD 30>, getsToken: <Bob's locked EUR 20> }
  { participant: Bob,   givesToken: <Bob's locked EUR 20>,   getsToken: <Alice's locked USD 30> }
```

Alice dispatches `rdv-commit` direct to Bob, then calls `applyCommit` locally — which:
- Deletes her locked USD 30 from `lockedNotes` (it's transferred to Bob)
- Validates the assigned `getsToken` (EUR 20, ZFA-balanced) and registers it in `noteStore`

**Alice's window:**

```
┌──────────────────────────────────────────────────────────────┐
│  Bob  accepts rdv a3f1c2…                                    │
│  ·   committed rdv a3f1c2…                                   │
└──────────────────────────────────────────────────────────────┘
```

**Bob's window** — receives `rdv-commit`, applies it locally (drops his locked EUR 20, registers the assigned USD 30):

```
┌──────────────────────────────────────────────────────────────┐
│  Alice  commits rdv a3f1c2…                                  │
│  ·   rdv a3f1c2… settled                                     │
└──────────────────────────────────────────────────────────────┘
```

Both sidebars after settlement:

```
ALICE                                BOB
│ Currencies (2)          │          │ Currencies (2)              │
│ ✦ USD               ←   │          │ ✦ EUR                   ←   │
│ EUR  (by Bob)       ←   │          │ USD  (by Alice)         ←   │
│                         │          │                             │
│ Notes (2)               │          │ Notes (2)                   │
│ USD 70              ←   │          │ EUR 80                  ←   │
│ EUR 20  (from Bob)  ←   │          │ USD 30  (from Alice)    ←   │
```

Both wallets are still individually balanced; the joint sum of pos and neg twists per currency is unchanged. Only the *assignment* shifted.

---

## What just happened

| Step | Who | Command | Wire kind | Effect |
|------|-----|---------|-----------|--------|
| 1 | Alice | `/rdv swap USD 30 EUR 20 Bob` | `rdv-propose` (direct → Bob) | Auto-split USD 100 → 30+70; locks 30; sends proposal; sets 60s timeout |
| 2 | Bob | `/rdv accept a3f1c2` | `rdv-accept` (direct → Alice) | Auto-split EUR 100 → 20+80; locks 20; commits intent |
| 3 | Alice's handler | (automatic) | `rdv-commit` (direct → Bob) + local `applyCommit` | Both wallets atomically transition |

**Final state:**

- **Alice** holds USD 70 + EUR 20 (and her `cap:token-USD` issuer authority).
- **Bob** holds EUR 80 + USD 30 (and his `cap:token-EUR` issuer authority).
- **Total USD in circulation**: 100 (70 Alice + 30 Bob), unchanged from before.
- **Total EUR in circulation**: 100 (80 Bob + 20 Alice), unchanged from before.
- No third party touched either token.

The joint conservation check at propose time **and** the per-row validation at commit time together guarantee: no proposer can construct a rendezvous that materializes value from nothing, and no participant can apply a commit that hands them a token mismatched to what they agreed to.

---

## Failure modes

**Bob rejects.** If Bob types `/rdv reject a3f1c2` instead of `accept`, his handler sends `rdv-reject` to Alice. Alice's handler releases her locked USD 30 back to `noteStore` (so her wallet returns to USD 100), broadcasts `rdv-abort` to any other participants (n=2 case: just Bob), clears the proposal. Chat shows `· rdv a3f1c2… aborted`. Alice's USD 100 reappears in her sidebar.

**Bob never responds.** After 60 s, Alice's `proposalTimedOut` fires: lock released, `rdv-abort` sent to Bob (in case he's online now and accepted but is offline for the commit), proposal cleared. Bob, if he's also been holding a lock from accepting, will release it on his own timeout.

**Alice aborts.** Before Bob responds, Alice can run `/rdv abort a3f1c2`. Same cleanup as the timeout path, immediate.

**A peer disconnects mid-protocol.** Whoever holds a lock keeps it until their local timeout fires; on reload, locks are **orphaned** (proposal state is in-memory only) and released back to `noteStore` automatically by `loadNotes`. No value is lost across a crash. The other side's state may diverge transiently — same "best-effort" posture as `/note pass`.

See [SECURITY.md § Rendezvous commit divergence](SECURITY.md#what-the-system-does-not-defend-against) for the honest atomicity story. True multi-party atomicity needs consensus, which is out of scope.

---

## Multisig

A `/rdv` proposal commits only when every listed participant accepts, which is structurally an N-of-N multi-party signature. Combined with `/dyncap` (which gives each peer a TOFU-anchored chain identity), the rendezvous becomes a verifiable cosignature event: identity is bound at the dyncap layer, atomicity at the rendezvous layer.

See [**MultisigDemo.md**](MultisigDemo.md) for a 2-of-2 walkthrough using `/dyncap` + `/rdv` to atomically exchange attestation tokens. K-of-N threshold multisig — any K of N keyholders authorize — needs either a threshold conservation predicate (a small protocol extension) or signature-strength identity beyond what hash-only dyncap provides.

---

## What is *not* shown here

- **3+ party cyclic swap** — the underlying protocol supports it; the `/rdv swap` command exposes only n=2. A 3-way cyclic command (Alice→Bob→Charlie→Alice) is a thin dispatcher addition. The conservation check, locking, and commit construction work unchanged.
- **Rendezvous over rendezvous** — chained atomic events. The current `lockedNotes` map keys by token, not by proposal, so a held note can be in at most one in-flight rendezvous at a time. Composition needs careful design (it's not just nested locks — failure modes cascade).
- **Liveness against adversarial delay** — a malicious participant can stall by accepting then never letting the proposer know. The 60 s timeout mitigates but doesn't prevent griefing. Mitigation belongs at the social layer (reputation) until a consensus or signed-log layer is added.
- **Cross-room rendezvous** — same room-scoped trust model as everything else. Rendezvous fires only when all participants are joined to the same room.

---

## Related

- [Commands § `/rdv`](docs/commands.md#rdv-sub-direct) — full command reference
- [`packages/browser/src/rendezvous.ts`](packages/browser/src/rendezvous.ts) — `Proposal`, `Row`, `CommitRow`, `conservationCheck`, `cyclicSwap`, `newProposalId`
- [`packages/browser/src/app.ts`](packages/browser/src/app.ts) — dispatcher case `rdv`, inbound `rdv-*` handlers, lock/unlock helpers
- [PromissoryNoteDemo.md](PromissoryNoteDemo.md) — bearer notes as ZFA twist sequences; `/note declare`/`grant`/`pass`/`redeem`
- [DiningPhilosophersDemo.md § Step 7](DiningPhilosophersDemo.md#step-7--the-rendezvous-lens-atomic-acquisition-as-a-single-event) — atomic resource acquisition as a single composite event (aspirational n-party variant)
- [MultisigDemo.md](MultisigDemo.md) — 2-of-2 cosignature using `/dyncap` + `/rdv`
- [SECURITY.md § Rendezvous and no consensus](SECURITY.md#the-shared-root-no-consensus) — what best-effort atomicity buys and where consensus is needed

**[Open a room and try it →](https://rhovision-org.github.io/quantum-os/)**
