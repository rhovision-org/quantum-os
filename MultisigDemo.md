# Two-Party Multisig with Dynamic Capabilities

A step-by-step walkthrough of **Alice** and **Bob** jointly co-signing an attestation — using **`/dyncap`** for hash-anchored identity and **`/rdv`** for atomic two-party agreement. Possessing a single bearer-token is not enough; both parties' chains must converge on the commit.

> Traditional multisig binds K signatures to one artifact. [quantum-os](README.md) assembles the same property from two existing pieces — a TOFU-anchored chain that identifies each participant, and a rendezvous that fires only if every party accepts. The "multisig" is the *conjunction*: the rendezvous commits if and only if both dyncap-anchored peers agreed to it.

This demo uses **2-of-2** because that's what the current `/rdv swap` command exposes. The rendezvous protocol in [`packages/browser/src/rendezvous.ts`](packages/browser/src/rendezvous.ts) generalizes to n-party; a future `/rdv ceremony N` command would lift this story to N-of-N. K-of-N *threshold* multisig needs either a threshold conservation predicate or real signatures — see [What's not shown](#what-is-not-shown).

---

## The pieces

**Dyncap** ([`packages/browser/src/dyncap.ts`](packages/browser/src/dyncap.ts)) gives each peer a permanent, hash-only identity:

```
seed:    32 random bytes, generated at first launch, never broadcast
anchor:  H(seed)  — 64 hex chars; the peer's public identity
witness: H(seed || seq || room_id || H(envelope))  — attached to each signed envelope
```

Receivers TOFU-pin the first observed `(peerId, anchor)` pair and reject subsequent envelopes whose anchor doesn't match. Two valid envelopes at the same `seq` under the same anchor are a *fork*: clone evidence.

**Rendezvous** ([`packages/browser/src/rendezvous.ts`](packages/browser/src/rendezvous.ts)) gives n-party atomic agreement: a proposal commits only after every participant has explicitly accepted, with multiset conservation enforced over the joint composition. See [AtomicSwapDemo.md](AtomicSwapDemo.md) for the per-step protocol detail.

**The combination**: dyncap identifies *who* participated; rendezvous gives *atomicity*. Together they form a multisig that no party alone can forge after the fact and that fails closed if any party doesn't sign.

---

## Setup: each peer has a dyncap anchor

Open the room in two browser profiles. Both peers connect.

On first launch each browser generated a 32-byte seed and persisted it to `localStorage` under `qos-dyncap-state` (per-device, cross-room). The seed never leaves the device. The anchor is computed deterministically from it.

```
ALICE TYPES:  /dyncap status
```

**Alice's window:**

```
┌──────────────────────────────────────────────────────────────┐
│  · dyncap anchor: cap:peer/dyn:7f3a1c9e…                     │
│  ·   seq so far:   0                                         │
│  ·   chain peers:  0                                         │
└──────────────────────────────────────────────────────────────┘
```

Bob does the same and sees his own anchor — distinct from Alice's by 128 bits of entropy.

When Alice connects to Bob, her `onChannelOpen` fires a `name` envelope direct-sent to Bob. The envelope carries her dyncap field. Bob's `verifyDyncapIfPresent` runs, sees no prior chain state for Alice, and TOFU-pins Alice's anchor.

```
BOB SEES:
┌──────────────────────────────────────────────────────────────┐
│  · Alice joined                                              │
│  · Alice · dyncap anchor pinned (TOFU)                       │
└──────────────────────────────────────────────────────────────┘
```

Symmetrically, Bob's `name` envelope arrives at Alice with his dyncap; Alice TOFU-pins Bob's anchor. After the handshake both peers can confirm:

```
BOB TYPES:  /dyncap peers
```

```
┌──────────────────────────────────────────────────────────────┐
│  · tracked peers (1):                                        │
│  ·   Alice  anchor: 7f3a1c9e63b0d8e0…  lastSeq: 1            │
└──────────────────────────────────────────────────────────────┘
```

Alice's `lastSeq: 1` means Bob has accepted one signed envelope from her (the name handshake).

---

## Step 1 — Each peer declares an attestation slot

The co-signature is structured as a swap of **attestation tokens**. Each peer mints a denomination-1 token labeled with their own identity; the swap will exchange them, leaving each peer holding the *other's* attestation as proof of mutual cosignature.

```
ALICE TYPES:  /note declare attest-alice
ALICE TYPES:  /note grant attest-alice 1
```

```
BOB TYPES:    /note declare attest-bob
BOB TYPES:    /note grant attest-bob 1
```

Each `note-declare` broadcast carries the issuer's dyncap (`{anchor, seq, witness}`). Receivers verify the dyncap extends the sender's known chain, and store the carried dyncap with the `knownCurrencies` entry. The `note-grant` broadcast also extends each peer's chain.

After this step both peers' wallets and currency registries look like:

```
ALICE                                  BOB
│ Currencies (2)            │          │ Currencies (2)              │
│ ✦ attest-alice        ←   │          │ ✦ attest-bob            ←   │
│ attest-bob  (by Bob)  ←   │          │ attest-alice  (by Alice) ←  │
│                           │          │                             │
│ Notes (1)                 │          │ Notes (1)                   │
│ attest-alice 1        ←   │          │ attest-bob 1            ←   │
```

Each `attest-bob` entry in Alice's `knownCurrencies` carries Bob's dyncap chain step proving he was the actual issuer. A late-joining Carol who later receives this entry via `sync-currencies` will see Bob's anchor inline; if Carol has already TOFU-pinned Bob via direct handshake, she can verify the sync entry matches Bob's chain.

Each peer's dyncap `/dyncap status` now shows `seq: 3` (name + declare + grant = 3 signed envelopes).

---

## Step 2 — Alice proposes the cosignature rendezvous

The cosignature is implemented as a `/rdv swap`: Alice gives her attestation, gets Bob's; Bob gives his, gets Alice's. The conservation check passes — multiset `{(attest-alice, 1), (attest-bob, 1)}` matches on both sides.

```
ALICE TYPES:  /rdv swap attest-alice 1 attest-bob 1 Bob
```

Alice's dispatcher locks her `attest-alice 1` token, builds the proposal, direct-sends `rdv-propose` to Bob, sets a 60s timeout.

**Alice's window:**

```
┌──────────────────────────────────────────────────────────────┐
│  · proposed rendezvous c4e7a2… to Bob                        │
│  ·   you give attest-alice 1, get attest-bob 1               │
│  ·   expires in 60s — /rdv abort c4e7a2 to cancel            │
└──────────────────────────────────────────────────────────────┘
```

**Bob's window:**

```
┌──────────────────────────────────────────────────────────────┐
│  Alice  proposes rendezvous c4e7a2…                          │
│  ·   you give attest-bob 1, get attest-alice 1               │
│  ·   /rdv accept c4e7a2   or   /rdv reject c4e7a2            │
└──────────────────────────────────────────────────────────────┘
```

The `rdv-propose` envelope itself travels over the DTLS-encrypted WebRTC data channel direct from Alice's peer ID to Bob's — the wire-level sender is authenticated by the transport. Combined with the dyncap anchor that Bob already TOFU-pinned for Alice in Step 0, Bob has two independent grounds for trusting that this proposal really comes from Alice:

1. **Wire-level**: DTLS handshake authenticates Alice's peer ID end-to-end.
2. **Application-level**: Alice's prior signed envelopes (`name`, `note-declare`, `note-grant`) established her dyncap chain; Bob's chain state has `lastSeq: 3` for her, and the room observed her identity participate in the declarations.

---

## Step 3 — Bob accepts; the commit fires atomically

Bob examines the proposal — the currency labels tell him whose attestation he's getting and giving. He accepts:

```
BOB TYPES:  /rdv accept c4e7a2
```

Bob's handler locks his `attest-bob 1` and direct-sends `rdv-accept` to Alice. Alice's `rdv-accept` handler verifies the response, sees all participants (Alice's implicit accept + Bob's explicit accept) have responded, and dispatches `rdv-commit` to Bob plus runs `applyCommit` locally.

**Alice's window:**

```
┌──────────────────────────────────────────────────────────────┐
│  Bob  accepts rdv c4e7a2…                                    │
│  ·   committed rdv c4e7a2…                                   │
└──────────────────────────────────────────────────────────────┘
```

**Bob's window:**

```
┌──────────────────────────────────────────────────────────────┐
│  Alice  commits rdv c4e7a2…                                  │
│  ·   rdv c4e7a2… settled                                     │
└──────────────────────────────────────────────────────────────┘
```

Both wallets transition atomically:

```
ALICE                                  BOB
│ Notes (1)                 │          │ Notes (1)                   │
│ attest-bob 1  (from Bob)  │          │ attest-alice 1  (from Alice) │
```

Each peer now holds the *other's* attestation token. The cosignature is real because:

- **Both anchors were TOFU-pinned** before any of this happened. The room's record of who is "Alice" and who is "Bob" was established at name-handshake.
- **Both declarations and grants were dyncap-signed** by their respective issuers. Bob's `attest-bob` traces back to Bob's anchor; Alice's `attest-alice` traces to Alice's.
- **The rendezvous committed only after both explicit accepts**. Either party could have rejected; either party could have timed out. The atomic commit means both signed.

The fact that Alice now holds `attest-bob 1` is unforgeable proof that Bob participated in this specific rendezvous — Bob's bearer authority over `attest-bob` was established by his dyncap-signed `note-declare`, and only Bob's wallet could supply the denomination-1 piece. Same argument symmetrically.

---

## Step 4 — Verifying the cosignature record

Any party who later wants to prove "Alice and Bob jointly attested" can check three things:

1. **Both anchors exist.** Verify each peer's `cap:peer/dyn:<anchor>` was a TOFU-pinned identity in the room session.
2. **Each `attest-<who>` currency was declared by the corresponding dyncap.** Each `KnownCurrency` entry carries the original `note-declare`'s dyncap; the anchor inside must match the holder's pinned anchor.
3. **The cosignature tokens were exchanged in a single atomic rendezvous.** The bearer holding `attest-<other>` proves the other declared it, and that the transfer was the result of an atomic commit (not a stolen-bearer attack — *they would have had to surrender their own attestation in exchange*).

Running `/note list` on each side shows the final state:

```
ALICE                                  BOB
│ Currencies (2)               │       │ Currencies (2)                │
│ ✦ attest-alice           ←   │       │ ✦ attest-bob              ←   │
│ attest-bob  (by Bob)     ←   │       │ attest-alice  (by Alice)  ←   │
│                              │       │                               │
│ Notes (1)                    │       │ Notes (1)                     │
│ attest-bob 1  (from Bob) ←   │       │ attest-alice 1  (from Alice)← │
```

Each peer's `/dyncap status` reflects the total seq count of their signed envelopes (~5–7 depending on how many sync envelopes also went out).

---

## What just happened

| Step | Who | Command | Layer | Effect |
|------|-----|---------|-------|--------|
| 0 | Both | (automatic) | dyncap | Per-device seed → anchor; persisted to `localStorage` |
| 0 | Both | join the room | dyncap | `name` handshake carries each peer's anchor; receivers TOFU-pin |
| 1 | Alice | `/note declare attest-alice` | note + dyncap | Issuer authority for `attest-alice` minted; broadcast signed |
| 1 | Bob | `/note declare attest-bob` | note + dyncap | Symmetric for Bob |
| 1 | Both | `/note grant attest-<self> 1` | note + dyncap | Each mints their denomination-1 cosignature token, locally held |
| 2 | Alice | `/rdv swap attest-alice 1 attest-bob 1 Bob` | rdv | Alice locks her token; proposal goes direct to Bob; 60s timer |
| 3 | Bob | `/rdv accept …` | rdv | Bob locks his token; accept goes back to Alice |
| 3 | Alice's handler | (automatic) | rdv | Builds commit, sends to Bob, applies locally — atomic |

**Final state**: each peer holds the other's signed cosignature token. Anyone who can verify both dyncap anchors and both bearer tokens has cryptographic proof that the joint signing occurred.

---

## Why this is a real multisig

The standard multisig primitive in cryptography binds K signatures to a single payload. quantum-os does it differently — the *primitive* is atomic agreement, and the *signatures* come from the dyncap chains that authenticate participation. The properties match:

| Multisig property | How this demo provides it |
|---|---|
| Both parties must agree | `/rdv` does not commit unless both `rdv-accept` envelopes arrive |
| Each party's signature is verifiable | Each party's `note-declare` and earlier envelopes are dyncap-signed; receivers TOFU-pinned and verified each chain step |
| The signed artifact is tamper-evident | The atomic swap produces specific bearer tokens; any later modification (e.g., copying a token) doesn't reproduce the chain-of-custody back to the original dyncap-signed declaration |
| One party cannot forge the cosignature alone | A rogue Alice can't produce `attest-bob 1` without Bob's wallet supplying it; Bob's wallet only releases it through `/rdv accept` |

The trust ceiling is the dyncap ceiling: TOFU at first contact, race conditions if a clone broadcasts before the real holder, no cross-room continuity.

---

## What is *not* shown

- **K-of-N threshold multisig** (any K of N keyholders authorize). The current rendezvous requires *all* listed participants to accept. A threshold variant needs either:
  - A *threshold conservation predicate* in `conservationCheck` that accepts a proposal if any K rows verify, treating absent rows as nominal. This is a small protocol extension.
  - **Real per-keyholder signatures** so the proposal can carry K standalone signatures over its hash without requiring K live participants. This is signature-strength identity, which the hash-only dyncap does not provide.
- **3+ party rendezvous**. The protocol in [`rendezvous.ts`](packages/browser/src/rendezvous.ts) supports n-party cyclic; the `/rdv swap` command exposes only n=2. A `/rdv cycle` or `/rdv ceremony` command would lift this demo to 3-of-3 and beyond.
- **Cross-room continuity.** Each room has its own dyncap chain state. An anchor pinned in room A doesn't transfer to room B. Cross-room identity needs a separate layer.
- **Defense against an in-room dyncap race.** If a peer's seed is stolen and the clone *broadcasts before* the real holder in a fresh room, the clone wins the TOFU. Real signatures (Ed25519, etc.) would close this, at the cost of importing a cryptographic primitive outside the QLF algebra. The hash-only design is a deliberate trade.
- **Active verification of sync-forwarded dyncaps**. When Carol joins later and Bob sends her his `knownCurrencies` via sync, Bob's envelope includes each entry's original dyncap. Carol stores the dyncap but does not currently re-verify it against the original author's anchor (the lookup table for "anchor → peer" is not built). This is a follow-up.

---

## Related

- [Commands § `/dyncap`](docs/commands.md#dyncap-sub) — command reference
- [`packages/browser/src/dyncap.ts`](packages/browser/src/dyncap.ts) — protocol module: `signEnvelope`, `verifyEnvelope`, `newDynCapState`, anchor / witness derivation
- [`packages/browser/src/app.ts`](packages/browser/src/app.ts) — `signedBroadcast` / `signedSend` wrappers, `verifyDyncapIfPresent` helper, `/dyncap` dispatcher case
- [AtomicSwapDemo.md](AtomicSwapDemo.md) — atomic swap protocol walkthrough this builds on
- [PromissoryNoteDemo.md](PromissoryNoteDemo.md) — note declaration / grant / pass / redeem primitives
- [SECURITY.md § Dynamic capabilities](SECURITY.md#dynamic-capabilities-dyncap--hash-only-identity-layer) — what dyncap closes and where it doesn't go

**[Open a room and try it →](https://rhovision-org.github.io/quantum-os/)**
