# Issuing and Redeeming a Promissory Note

A step-by-step walkthrough of two peers — **Alice** and **Bob** — using [quantum-os](README.md) to declare a currency, mint a bearer note, transfer part of it, and close the loop with a redemption receipt.

> All bearer state stays private. The note token itself never appears in a broadcast — only Alice and the holders of derived pieces ever see the bytes. Currency declarations and grant announcements *are* public, so the room knows what currencies exist and who issues them.

The lifecycle vocabulary — **TokenMint → Mint → Transfer → Redeem** — is borrowed from **Patrick Mockridge's [DarkWow promissory note contract](https://codeberg.org/PatrickM123/darkwow/src/branch/linear-master/doc/src/contract/promissory_note.md)**. DarkWow implements it as a privacy-preserving DeFi contract on a Halo2 / Pallas zk-rollup; quantum-os implements the same algebraic shape over a per-room WebRTC data channel, with **conservation enforced by ZFA twist balance** instead of Pedersen commitments — no zk circuits, no global ledger.

---

## The data model

```
cap:token-USD:<balanced hex>       Issuer authority. One per (issuer, currency) in the room.
cap:note-USD:<balanced hex>        Bearer note. Denomination = hex.length / 2.
cap:receipt-USD:<balanced hex>     Permanent redemption record. Non-transferable.
```

Every token is a ZFA-balanced twist sequence — the same `cap:label:hex` shape as a peer ID or a room URL. Conservation falls out of the existing invariant: split partitions a balanced sequence into two balanced halves; merge concatenates two balanced sequences.

Source: [`packages/browser/src/notes.ts`](packages/browser/src/notes.ts) (pure functions) · [`packages/browser/src/app.ts`](packages/browser/src/app.ts) (state, dispatcher, message handlers).

---

## Setup: both peers connect

Alice opens the room and clicks **Connect**. She copies the share link and sends it to Bob. Bob opens the same URL and connects.

```
┌─────────────────────────────────────────────────────────────┐
│  ⬡ QuantumOS   peer-to-peer · ZFA capability model · WebRTC │
├──────────────┬──────────────────────────────────────────────┤
│ Your name    │  Share room: https://…#room=cap:room:024…    │
│ [Alice     ] │                                              │
│              │  · joined room 024602…                       │
│ Your ID      │                                              │
│ cap:peer:02… │                                              │
│              │                                              │
│ Room         │                                              │
│ cap:room:02… │                                              │
│              │                                              │
│ Signaling    │                                              │
│ ● connected  │                                              │
│              │                                              │
│ Peers (1)    │                                              │
│ Alice (you)  │                                              │
│ Bob      ←   │                                              │
│              │                                              │
│ Lemmas (0)   │                                              │
│ (none yet)   │                                              │
│              │                                              │
│ Currencies(0)│                                              │
│ (none yet)   │                                              │
│              │                                              │
│ Notes (0)    │  [broadcast a message…]          [Send]      │
│ (none yet)   │                                              │
└──────────────┴──────────────────────────────────────────────┘
                          ALICE'S WINDOW
```

Both peers see each other in the **Peers** list. The new **Currencies** and **Notes** blocks are empty — no currency has been declared and no notes are held.

---

## Step 1 — Alice declares USD

Alice mints her own currency authority. The token `cap:token-USD:…` is her unforgeable proof that she's the issuer of USD in this room.

```
ALICE TYPES:  /note declare USD
```

**Alice's window:**

```
┌──────────────────────────────────────────────────────────────┐
│  · declared currency: USD                                    │
│  ·   authority: cap:token-USD:0246135702461357…              │
│  ·   you can now /note grant USD <N>                         │
└──────────────────────────────────────────────────────────────┘
```

**Bob's window** — receives the declaration:

```
┌──────────────────────────────────────────────────────────────┐
│  Alice  /note declare USD                                    │
│  ·   Alice issues USD  authority: cap:token-USD:024613570… │
└──────────────────────────────────────────────────────────────┘
```

Both sidebars update — but they show *different* things:

```
ALICE                        BOB
│ Currencies (1)  │          │ Currencies (1)        │
│ ✦ USD       ←   │          │ USD  (by Alice)  ←    │
```

Alice sees `✦ USD` — she holds the authority. Bob sees `USD (by Alice)` — he knows the currency exists but does not hold the bearer authority. Clicking Alice's entry prefills `/note grant USD `; clicking Bob's entry prefills `/note redeem USD `.

Wire kind: `note-declare` is broadcast (the public token is the issuer's public face — anyone in the room can verify a redemption was honored by that authority). See the inbound handler in [`app.ts`](packages/browser/src/app.ts).

---

## Step 2 — Alice mints USD 100

Alice grants herself a bearer note of denomination 100. The hex sequence is **200 characters long** (denomination × 2), each character a twist digit `[0-7]`, half positive and half negative.

```
ALICE TYPES:  /note grant USD 100
```

**Alice's window:**

```
┌──────────────────────────────────────────────────────────────┐
│  · minted: USD 100                                           │
│  ·   cap:note-USD:0246135702461357…  (200 hex chars)         │
└──────────────────────────────────────────────────────────────┘
```

**Bob's window** — receives only an *announcement* (the bearer token is **not** sent):

```
┌──────────────────────────────────────────────────────────────┐
│  Alice  /note grant USD 100                                  │
│  ·   Alice minted USD 100                                    │
└──────────────────────────────────────────────────────────────┘
```

Alice's sidebar now shows the note in her wallet:

```
│ Notes (1)              │
│ USD 100            ←   │   ← click → /note pass USD 100 …
```

Bob's Notes block is still empty — bearer state is private.

**Why the token isn't broadcast.** In the bearer model, possession is authority. If `/note grant` broadcast the full `cap:note-USD:…` token to the room, every peer would now algorithmically hold it. The announcement carries `currency` and `denomination` only — enough to inform the room that issuance happened, not enough to spend.

---

## Step 3 — Alice passes USD 30 to Bob

Alice transfers USD 30. Her wallet has a single USD 100 note, so the dispatcher auto-splits: it produces a balanced denomination-30 piece (60 hex chars) and a balanced denomination-70 piece (140 hex chars). The 30-piece is sent direct to Bob via the WebRTC data channel; the 70-piece (change) stays in Alice's wallet.

```
ALICE TYPES:  /note pass USD 30 Bob
```

**Alice's window:**

```
┌──────────────────────────────────────────────────────────────┐
│  · USD 30 → Bob                                              │
│  ·   cap:note-USD:024613570246…  (60 hex chars)              │
│  ·   (change 70 returned to your wallet)                     │
└──────────────────────────────────────────────────────────────┘
```

**Bob's window** — the note appears in his wallet:

```
┌──────────────────────────────────────────────────────────────┐
│  Alice  passes USD 30                                        │
│  ·   received USD 30 from Alice                              │
│  ·     cap:note-USD:024613570246… (60 hex chars)             │
└──────────────────────────────────────────────────────────────┘
```

Sidebars after the transfer:

```
ALICE                                BOB
│ Notes (1)              │           │ Notes (1)                  │
│ USD 70             ←   │           │ USD 30  (from Alice)   ←   │
```

**Conservation check.** Alice's USD 100 note (200 hex chars, 100 pos + 100 neg twists) was partitioned: 60 chars to Bob (30 pos + 30 neg) and 140 chars remaining (70 pos + 70 neg). 30 + 70 = 100 ✓. Each half is independently ZFA-balanced — the same Lean theorem that proves `rho_process_always_zfa` covers split: a balanced sequence partitions into balanced subsequences.

Wire kind: `note-pass` is a **direct** send to Bob's peer ID — not a broadcast. No other peer in the room sees the token. The implementation is in the `/note pass` case and the inbound `note-pass` handler in [`app.ts`](packages/browser/src/app.ts).

---

## Step 4 — Bob redeems USD 10 with Alice

Bob holds USD 30 but wants to redeem only USD 10 with Alice. The dispatcher auto-splits again: a denomination-10 piece is sent to Alice for redemption; a denomination-20 piece stays in Bob's wallet.

```
BOB TYPES:  /note redeem USD 10 Alice
```

**Bob's window:**

```
┌──────────────────────────────────────────────────────────────┐
│  · redeemed USD 10 → Alice                                   │
│  ·   awaiting receipt…                                       │
│  ·   (change 20 returned to your wallet)                     │
└──────────────────────────────────────────────────────────────┘
```

**Alice's window** — her handler verifies she holds `cap:token-USD`, mints `cap:receipt-USD:hex(20)`, sends it back to Bob, and logs the redemption locally:

```
┌──────────────────────────────────────────────────────────────┐
│  Bob  redeems USD 10                                         │
│  ·   honored: USD 10 for Bob                                 │
│  ·     receipt: cap:receipt-USD:0246135702… (20 hex chars)   │
└──────────────────────────────────────────────────────────────┘
```

**Bob's window** — the receipt arrives and is stored:

```
┌──────────────────────────────────────────────────────────────┐
│  Alice  issues receipt for USD 10                            │
│  ·   USD 10 redemption honored by Alice                      │
│  ·     cap:receipt-USD:0246135702… (20 hex chars)            │
└──────────────────────────────────────────────────────────────┘
```

Sidebars after the redemption:

```
ALICE                                BOB
│ Currencies (1)          │          │ Currencies (1)              │
│ ✦ USD               ←   │          │ USD  (by Alice)         ←   │
│                         │          │                             │
│ Notes (1)               │          │ Notes (1)                   │
│ USD 70              ←   │          │ USD 20  (from Alice)    ←   │
```

The receipt is **not** in the Notes block — it lives in `receiptStore` (chat-only this iteration). It is a permanent, non-transferable record: `/note pass` and friends refuse any token whose label starts with `receipt-`. Type `/note list` in Bob's window to see it:

```
BOB TYPES:  /note list
```

```
┌──────────────────────────────────────────────────────────────┐
│  · currency authorities (1):                                 │
│  ·   USD  cap:token-USD:0246135702461357…  (by Alice)        │
│  · notes you hold (1):                                       │
│  ·   USD 20  (from Alice)                                    │
│  ·     cap:note-USD:0246135702…                              │
│  · receipts (1):                                             │
│  ·   USD 10  honored by Alice                                │
│  ·     cap:receipt-USD:024613570…                            │
└──────────────────────────────────────────────────────────────┘
```

Alice's `/note list` shows the issuer side:

```
ALICE TYPES:  /note list
```

```
┌──────────────────────────────────────────────────────────────┐
│  · currency authorities (1):                                 │
│  ·   USD  cap:token-USD:0246135702461357…                    │
│  · notes you hold (1):                                       │
│  ·   USD 70                                                  │
│  ·     cap:note-USD:0246135702461…                           │
│  · redemptions you honored (1):                              │
│  ·   USD 10  for Bob                                         │
└──────────────────────────────────────────────────────────────┘
```

---

## What just happened

| Step | Who | Command | Wire kind | Effect |
|------|-----|---------|-----------|--------|
| 1 | Alice | `/note declare USD` | `note-declare` (broadcast) | Currency `USD` registered in `knownCurrencies` across the room; `cap:token-USD:…` is Alice's bearer authority |
| 2 | Alice | `/note grant USD 100` | `note-grant` (broadcast, currency + N only) | `cap:note-USD:hex(200)` minted in Alice's `noteStore`; room sees the announcement |
| 3 | Alice | `/note pass USD 30 Bob` | `note-pass` (direct) | Alice's note auto-split into 30 + 70; the 30-piece direct-sent to Bob; conservation `count_pos == count_neg` preserved in each piece |
| 4 | Bob | `/note redeem USD 10 Alice` | `note-redeem` + `note-receipt` (both direct) | Bob's 30 auto-split into 10 + 20; the 10 sent to Alice; Alice mints `cap:receipt-USD:hex(20)` and direct-sends it back; redemption logged in Alice's `redemptionsHonored` |

**Final state:**

- **Alice** holds `cap:token-USD:…` (issuer authority) + a USD 70 note + a log entry "honored USD 10 for Bob".
- **Bob** holds a USD 20 note + a USD 10 receipt from Alice.
- **Total USD in circulation in the room:** 20 (Bob's note) + 70 (Alice's note) = 90, exactly matching the issued 100 minus the redeemed 10. Conservation holds across every transformation.

**What the room observers (other peers, if any) saw:**

```
Alice  /note declare USD                                   ← public
        Alice issues USD  authority: cap:token-USD:024…    ← public
Alice  /note grant USD 100                                 ← public
        Alice minted USD 100                               ← public  (no bearer token)
                                                           ← no other events
```

The pass and redeem were direct-to-peer over DTLS — invisible to third parties. The `/note pass` and `/note redeem` envelopes never traversed the broadcast path. See [SECURITY.md § "Promissory notes, rendezvous, and bearer semantics"](SECURITY.md#promissory-notes-rendezvous-and-bearer-semantics) for the full privacy boundary.

---

## Notes on the design

- **Denomination as length, not as a number.** The denomination of a bearer note is `hex.length / 2`, not a separate field. This is what makes conservation algebraic rather than enforced by external accounting: a 30-denomination note literally *is* 60 twist digits, half positive and half negative. There is no way to construct an "unbalanced" note whose denomination doesn't match its content — the validator (`validateCapability`) rejects it before it can be passed.
- **Issuer authority is just another bearer token.** `cap:token-USD:…` is the same shape as `cap:peer:…` or `cap:room:…`. Holding it = being the USD issuer. There is no separate "issuer keypair." A peer's session compromise lets the attacker mint USD just as it would let them act as that peer.
- **Receipts close the loop.** The receipt isn't bookkeeping bolted on top — it's the same primitive (a ZFA-balanced bearer token) with a label that the dispatcher refuses to transfer. This mirrors DarkWow's *receipt coin* with `value = 0` and `spend_hook = issuer contract`; the quantum-os equivalent is the `receipt-` label prefix.
- **The Lean invariant covers more than `/qucalc`.** The same `rho_process_always_zfa` theorem that proves the room's `parallel(peer1, peer2, …)` stays balanced also proves the split-merge algebra on notes preserves denomination. The promissory-note algebra is a strict subset of `RhoProcess` composition.

---

## What is *not* shown here

- **Multi-issuer USD.** Two peers in the same room can each `/note declare USD` and produce different bearer authorities. The sidebar will show both (`✦ USD` for the holder, `USD (by Bob)` for the other). Receivers disambiguate by issuer — there is no global "USD" namespace.
- **Cross-room continuity.** This entire flow is per-room. A receipt minted by Alice in room A is meaningless in room B; each room has its own `knownCurrencies` registry. Cross-room identity would require a separate identity layer (dynamic capabilities — planned).
- **Unforgeable issuer identity.** A bearer authority token can in principle be stolen via URL leakage, screen recording, or browser-extension exfil — same limit as `/grant`. The planned dynamic-capability layer makes identity a continuously-proven trajectory instead of static bytes; see the discussion in the project history.
- **Multi-party atomic swap.** This demo shows direct transfer and redemption. For atomic n-party exchanges (e.g. cyclic Alice→Bob→Charlie→Alice), use [`/rdv swap`](docs/commands.md#rdv-sub-direct) — the rendezvous primitive enforces `multiset(gives) == multiset(gets)` across all participants in one composite move.

---

## Related

- [Commands § `/note`](docs/commands.md#note-sub-direct) — full command reference
- [`packages/browser/src/notes.ts`](packages/browser/src/notes.ts) — `parseNoteLabel`, `denomination`, `mintNote`, `splitNote`, `mergeNotes`, `mintReceipt`
- [`packages/browser/src/app.ts`](packages/browser/src/app.ts) — dispatcher case `note`, inbound `note-*` handlers, state stores
- [SECURITY.md](SECURITY.md) — bearer-note threat model and conservation guarantees
- [SyllogismDemo.md](SyllogismDemo.md) — collaborative logic over the same primitives
- [DiningPhilosophersDemo.md](DiningPhilosophersDemo.md) — atomic resource acquisition via `/pass`
- **Original design source: [Patrick Mockridge's DarkWow promissory note contract](https://codeberg.org/PatrickM123/darkwow/src/branch/linear-master/doc/src/contract/promissory_note.md)**
- [Quantum Logical Framework `rho_process_always_zfa`](https://github.com/rhovision-org/quantum-logical-framework/blob/main/lean/RhoQuCalc.lean) — the Lean theorem that the conservation algebra inherits

**[Open a room and try it →](https://rhovision-org.github.io/quantum-os/)**
