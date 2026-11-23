# Consensus in [quantum-os](README.md)

A reference document for the joiner-local discrepancy probe — the partial consensus mechanism that runs when a peer joins a room. It is **not** classical Byzantine fault tolerance. It is a deliberate, hash-only, room-scoped raise of the attacker cost layered on top of dyncap identity and the existing sync gossip.

Where [SECURITY.md](SECURITY.md) enumerates the threat model and the [demos](README.md) show usage, this document answers the design question:

> *What does the consensus probe guarantee, what doesn't it, and what would have to change to upgrade it?*

The shipped code lives in [`packages/browser/src/probe.ts`](packages/browser/src/probe.ts) (~140 lines of pure tally logic) and [`packages/browser/src/app.ts`](packages/browser/src/app.ts) (window state, integration with sync handlers, broadcast).

---

## What this is

When a peer connects to a room, they open a **probe window**: a fixed-duration buffer that collects inbound `sync-lemmas` and `sync-currencies` envelopes from up to `SAMPLE_SIZE` distinct peers. When the window closes, the joiner runs `findDiscrepancies` on the accumulated observations. For each key (lemma name, currency token) where multiple distinct values were reported, the joiner:

1. Tallies the weight behind each value, where each peer's vote weight is their dyncap chain depth (`dyncapChains[peer].lastSeq`, floor 1).
2. Picks the leading value as the **winner** *only if* its weight strictly exceeds the supermajority threshold `SUPERMAJORITY_NUM / SUPERMAJORITY_DEN` of the total weight. If no value clears the threshold, `winner === null` and the key is contested-but-unresolved.
3. Adopts the winner locally (for resolved discrepancies).
4. Broadcasts a `state-discrepancy` envelope so the room sees the disagreement.
5. Adds the peers behind non-winning values to `ignoredForSync` (only when a winner was declared) — their future sync envelopes are silently dropped.

This is **joiner-local consensus**: the joiner is the only peer that *acts* on the resolution. The broadcast is informational for non-joining peers; they do not auto-update their own state on receipt. Each new joiner runs their own probe and reaches their own decision.

The design trades classical BFT guarantees for staying inside the QLF algebra-as-security philosophy: the probe uses only the same SHA-256 primitive that dyncap uses, no asymmetric signatures, no global log, no view-change protocol. What it gains is a clear escalation in attacker cost without leaving the bearer/TOFU model.

---

## Position in the QLF stack

The probe is one layer in a stack:

| Layer | Module | What it provides |
|---|---|---|
| Hash kernel | browser `crypto.subtle.digest("SHA-256")` | One-way commitment to seed-derived witnesses |
| Identity-as-trajectory | `dyncap.ts` | TOFU-anchored chains; `lastSeq` measures participation depth |
| Room knowledge gossip | `sync-lemmas` / `sync-currencies` in `app.ts` | First-write-wins propagation of lemma names and currency declarations |
| **Consensus probe** | **`probe.ts`** | **Multi-source disagreement detection + chain-weighted supermajority resolution** |
| Application semantics | `notes.ts`, `rendezvous.ts`, dispatcher commands | Bearer notes, atomic swap, multisig — all riding on the layers below |

What's deliberately absent from this stack: a global ordered log, real signatures, view-change protocols, finality. Each of those is what classical BFT provides; each would change the trust model from algebra-as-security to algebra-plus-cryptography-as-security.

The probe is the highest layer the project pushes "consensus" before that boundary. Beyond it lies a different system.

---

## The protocol

### Probe window lifecycle

- **Open**: at the start of `onSignalingOpen` (the existing `connect()` callback in `app.ts`). The window's `contributors: Set<peerId>` is empty, `observations: Observation[]` is empty, a `setTimeout(closeProbeWindow, PROBE_WINDOW_MS)` is set.
- **Collect**: when an inbound `sync-lemmas` or `sync-currencies` envelope arrives during the window, `recordSyncObservations` is called. It pushes one `Observation` per entry into `probe.observations`. The sender's peer ID is added to `probe.contributors`. The sender's weight (`dyncapChains[sender]?.lastSeq ?? 1`, floored at 1) is captured at observation time.
- **Close**: triggered when `probe.contributors.size >= SAMPLE_SIZE` (early close) or when the timer fires (full window). `probe.open` is set to false; no further envelopes contribute.

### Snapshot collection

An `Observation` is `{ storeName, key, value, peer, weight }`:

| Field | Meaning |
|---|---|
| `storeName` | `"lemmas"` or `"currencies"` |
| `key` | Lemma name (for lemmas) or currency-authority token (for currencies). Same as the map key in `lemmaStore` / `knownCurrencies`. |
| `value` | A normalized JSON encoding of the substantive content — `{twists, cap}` for lemmas, `{currency, issuer}` for currencies. Uses sorted-key serialization (`probe.ts::normalizeValue`) so two peers reporting the same content produce byte-identical `value` strings. |
| `peer` | The peer ID of the snapshot's sender. Each peer contributes at most one observation per `(storeName, key)`. |
| `weight` | `dyncapChains.get(peer)?.lastSeq ?? 1` clamped to a floor of 1. Higher = peer has had more signed broadcasts accepted by this receiver. |

Observations from a peer outside the `SAMPLE_SIZE` cap are dropped (the cap is on distinct senders, not on observations).

### Tally function

`findDiscrepancies(observations)` is pure: same input → same output, no state.

1. **Group** observations by `(storeName, key)`. Within each group, bucket by `value`. Each bucket accumulates the set of contributing peers and the sum of their weights.
2. **Skip** groups with only one bucket — there's no discrepancy.
3. **Sort** buckets by `weight` (descending); on weight ties, by `count` (descending); on count ties, by first-seen order (earlier wins).
4. **Threshold**: compute `totalWeight = sum(bucket.weight)`. The leading bucket's value becomes the `winner` if and only if `leader.weight × SUPERMAJORITY_DEN > totalWeight × SUPERMAJORITY_NUM`. Otherwise `winner = null`.
5. **Return** a `Discrepancy` per group: `{ storeName, key, observations (sorted buckets), winner, totalWeight }`.

The strict inequality matters: with `NUM=2, DEN=3`, a leader weighing exactly 2/3 of the total does **not** win. A weight-2 vs weight-1 split totals 3; the leader needs `> 2`, has `2`, fails. Only `> 2/3` resolves.

### Decision rules in `closeProbeWindow`

For each returned `Discrepancy`:

| `winner` | Local effect | Broadcast | `ignoredForSync` |
|---|---|---|---|
| Non-null (resolved) | Apply winner to `lemmaStore` / `knownCurrencies` if it differs from existing local value | `state-discrepancy` with `winner: <object>` | Add every peer in non-winner buckets |
| `null` (contested) | No change to local state | `state-discrepancy` with `winner: null` | No additions |

If at least one resolved discrepancy applied locally, the lemma/note stores are re-rendered to reflect the change.

### Losing-peers rule

`losingPeersIn(discrepancies)` returns the set of peer IDs that contributed to *any* non-winner bucket *for any resolved discrepancy*. Contested discrepancies (no winner) contribute no losers — the room has genuine disagreement and the protocol declines to punish anyone. Once a peer is in `ignoredForSync`, the next `sync-lemmas` / `sync-currencies` envelope they send is silently dropped (with a chat-line notice on the receiver), and `saveNotes` persists the set under `qos-ignored-sync-{roomId}`. The user can inspect with `/probe status` and reset with `/probe clear`.

### Wire envelope: `state-discrepancy`

```ts
{
  kind: "state-discrepancy",
  storeName: "lemmas" | "currencies",
  key:       string,                          // the contested key
  observations: Array<{
    value:  string,                           // JSON-encoded value
    peers:  string[],                         // peer IDs that reported this value
    count:  number,                           // == peers.length
    weight: number,                           // sum of contributor weights
  }>,                                          // sorted by weight desc
  winner: Record<string, unknown> | null,    // null = contested-unresolved
  totalWeight: number,
  dyncap: DyncapField,                         // proves the broadcasting joiner's chain step
}
```

The envelope is dyncap-signed by the joiner (the peer running the probe). Receivers verify the joiner's dyncap on receipt; the *inner* observations carry peer IDs but not the original peers' dyncap signatures — those are still trusted on the joiner's word.

---

## The bug it depends on

For the probe to mean anything, lemma names must be **content-addressed**: once `@X` is declared, the name binds to that value for the room's lifetime. Otherwise any peer could "re-declare" `@X` with new content and the probe would be measuring noise instead of real disagreement.

The shipped fix lives in two callsites in `app.ts`:

- The dispatcher `case "lemma":` checks `lemmaStore.get(name)` before writing. If `existing` is set and `existing.twists !== resolvedTwistsStr`, the dispatcher refuses with `@name already declared with different twists … refusing re-declaration; choose a new name`. Idempotent re-declarations (same twists) are silently a no-op.
- The inbound `lemma` handler does the same check. Mismatched re-declarations are refused and surface a `⚠ refused` chat line; idempotent re-broadcasts return silently.

`sync-lemmas` already had `if (lemmaStore.has(name)) continue;` (first-write-wins). The same rule now holds across all three entry paths into the lemma store: local declaration, live broadcast, and snapshot sync. After the fix, a lemma discrepancy can only arise from genuine partition (two peers each declared `@X` with different twists during disjoint sessions) or sync forgery. The probe catches both.

The same rule does not currently apply to `note-declare` — that one is *already* token-keyed (the bearer authority is per `cap:token-<currency>:…`), so different issuers can declare currencies with the same name without conflict. The probe still tallies them, though, in case two peers genuinely disagree about whether a specific token represents Alice's or Bob's issuance.

---

## Trust model

The probe assumes:

1. **Honest peers report their own genuine state.** A peer that lies about its own `lemmaStore` is indistinguishable, at the snapshot level, from a peer whose state legitimately differs.
2. **Dyncap chain depth (`lastSeq`) is approximately proportional to honest participation.** An attacker has to *age* an identity (issue many signed broadcasts that other peers accept) to weight it. Fresh Sybil peers are weight-1.
3. **The joiner's TOFU pin of each contributor's dyncap anchor is trustworthy at the moment of pinning.** This is the same TOFU assumption dyncap relies on globally.
4. **The probe window observes a representative slice of the room's contributors.** With `SAMPLE_SIZE = 5`, this holds for small rooms (≤5 peers everyone gets probed) and is probabilistic for larger rooms.

The first assumption is the strongest. If a malicious peer reports a fake snapshot whose content matches no other peer's real state, the probe will see disagreement and either resolve via supermajority (if the malicious peer is outweighed) or surface as contested. The protocol does not detect lies that look like genuine disagreement — only that disagreement exists.

---

## What it raises the bar against

| Attack | Pre-probe | With probe |
|---|---|---|
| Single Sybil sync-forgery | Joiner accepts whichever snapshot arrived first (sync first-write-wins) | Sybil's value must command supermajority weight (>2/3) across all probed peers, not just be first |
| Sync flooding with fresh identities | Each fresh identity counts equally | Each fresh identity has weight 1; honest aged peers with high `lastSeq` dominate |
| Equivocating peer | Discrepancy not detected if equivocations reach different receivers | Probe broadcasts `state-discrepancy` even when no winner clears threshold; equivocation surfaces |
| First-write-wins race | Whoever broadcasts first to the joiner wins that key forever | Race is bounded by `PROBE_WINDOW_MS`; after window close, majority-by-weight wins |

The threshold is what binds these: a 1-vs-1 split no longer resolves into a winner, so a single forging peer can no longer dictate the joiner's view even if they arrive first. The forger now needs at least one honest collaborator (real or Sybil), and the collaborators' combined weight must exceed twice the honest disagreement weight.

---

## What it does *not* defend against

### Honest list

- **Coordinated Sybil with aged identities.** An attacker who pre-grows several dyncap identities (sending many signed broadcasts in advance) can later coordinate them to vote together. With three aged identities (`lastSeq ~ 5` each), they outweigh one honest peer (`lastSeq ~ 5`) by 15-to-5; supermajority threshold 13.33; they clear it. The probe assumes attackers don't pay this cost; the assumption gets weaker as the attacker's preparation budget grows.
- **First-mover dyncap-anchor race.** If a clone with a stolen seed broadcasts a `name` envelope to the joiner before the real peer does, the joiner TOFU-pins the clone's anchor. This is a pre-probe issue at the dyncap layer (see SECURITY.md § dyncap clone race) and the probe does not see it.
- **Cross-room resolution.** Chains are per-room. A peer's `lastSeq` in room A has no effect on weighting in room B. There is no cross-room consensus.
- **Joiner-local only.** When a non-joining peer receives a `state-discrepancy` broadcast, they log it but do not auto-update their own local state to match the winner. Their existing values stay. Each new joiner reaches their own decision; the room's views can persistently diverge.
- **Tally manipulation via inflated chain depth.** A peer's `weight` comes from the *receiver's* `dyncapChains[peer].lastSeq`. If the receiver has only seen a few of the peer's broadcasts (say 1), but the peer has actually emitted hundreds, the receiver weights the peer at 1. Conversely, if the peer has broadcast spammy filler to inflate their `lastSeq`, they weight higher. Chain-tamper detection at the dyncap layer catches forged jumps in `seq`, but does not detect *legitimate-but-spammy* growth.
- **Forwarded entries from non-handshaked peers.** The probe weights by sender's chain depth. But a single forwarder Bob can send sync-lemmas containing entries attributed to a "Carol" the joiner has never directly handshaked with. The joiner has no chain state for Carol; Carol's claim weights at the floor of 1. The joiner has no way to distinguish "real Carol's entry" from "Bob-fabricated entry under Carol's name."

### Threshold corner cases

- **Single contributor.** If only one peer's snapshot arrives during the window, every key in their snapshot is uncontested by definition — only one value bucket per key. No discrepancy is returned. The joiner adopts whatever was sent.
- **Weight-1 ties.** Two fresh peers reporting different values both weight 1; total 2; threshold `>1.33`. Neither side wins; key is contested.
- **Weight-5 vs weight-1 split.** Total 6, threshold `>4`. Weight-5 side has 5, clears. Asymmetric weight breaks ties even with just two contributors.

---

## Comparison with classical BFT

| Property | Classical BFT (PBFT, HotStuff, Tendermint, …) | This probe |
|---|---|---|
| Identity model | Signed messages from authenticated principals | TOFU-pinned dyncap anchors, no asymmetric keys |
| Quorum | `n ≥ 3f + 1` on a stable peer set | Up to `SAMPLE_SIZE` voluntary contributors |
| Resolution | Decision binds all participants; finality | Joiner-local; other peers see broadcast but don't update |
| Equivocation defense | View-change protocol detects two valid leader messages | Discrepancy broadcast surfaces but does not bind |
| Liveness | Bounded by network synchrony assumptions | Bounded by `PROBE_WINDOW_MS`; closes regardless |
| Latency | Multiple rounds (typically 3+) | One window |
| Tolerable Byzantine fraction | `f < n/3` (signed) | Indeterminate — depends on attacker's preparation and weight distribution |

To upgrade this layer to classical BFT, three things would change:

1. **Real signatures**: dyncap's hash-only witness becomes a real Ed25519 (or similar) signature over the broadcast hash. Identity claims become unrepudiated. This is the wave-3 direction the user explicitly chose not to take.
2. **Stable view + view-change protocol**: peers run a leader-election + commit protocol over their currently-known peer set. Detect leader equivocation, advance the view, retry. This adds significant message complexity.
3. **Global ordered log**: a peer's history is not just `lemmaStore` but a sequence of accepted broadcasts in agreed order. Finality is the point at which a prefix of the log is permanent. This is what DarkWow and other blockchain-backed systems provide.

Each addition violates "the algebra is the security" in some direction — adding asymmetric crypto, a non-algebraic ordering primitive, or both. The choice to stop at this layer is a deliberate scope decision, not a hidden limit.

---

## Open improvements

The current probe is one design point in a larger space. Improvements that stay within the hash-only / no-consensus philosophy:

- **Inner-entry dyncap re-verification.** When a sync envelope forwards entries authored by peers other than the forwarder, the receiver currently does not re-verify each inner entry's dyncap against the original author's TOFU-pinned anchor. Building a cross-peer anchor lookup table (`peerId → anchor` propagated through the room) would catch forwarder-substituted entries before they reach the probe. Tracked as open issue #6 in SECURITY.md.
- **Cross-peer corroboration on `state-discrepancy` receipt.** Currently non-joining peers log the discrepancy but do nothing else. A small extension: each receiver compares the broadcast's observations against their own local state and, if they find a value not in any bucket, broadcasts a meta-discrepancy. Turns the discrepancy from a one-shot announcement into a participatory check.
- **Sybil-cost gate via SHA-256 PoW on dyncap seed.** Make dyncap anchor generation expensive: require `H(seed)` to start with k leading zero bits. Raises the cost of fresh Sybil creation without leaving the hash-only model. Tunable to the desired difficulty.
- **K-of-N threshold sync.** Currently sync is first-write-wins per key. A threshold variant would require K matching observations before accepting a key into local state. The probe is a one-shot version of this idea; a continuous version would apply to every inbound sync envelope, not just window-bounded joining.

---

## Parameters

| Constant | Default | Effect of change |
|---|---|---|
| `SAMPLE_SIZE` | 5 | Larger samples → better probabilistic coverage of larger rooms; more probe-window bandwidth; later early-close |
| `PROBE_WINDOW_MS` | 5000 | Longer window → tolerates slow networks; delays the joiner's settled state |
| `SUPERMAJORITY_NUM` | 2 | Larger → stricter threshold (1 = simple majority, 3 = three-quarters); harder to resolve, fewer false winners |
| `SUPERMAJORITY_DEN` | 3 | Denominator pairs with NUM; together set the threshold fraction |

All four are exported from `probe.ts` and tunable per deployment. The defaults match the BFT tradition of "tolerate f if n ≥ 3f+1," which corresponds to a 2/3 supermajority on a clean voting set.

---

## Related

- **README §`/probe`** — command surface and one-paragraph summary
- [`packages/browser/src/probe.ts`](packages/browser/src/probe.ts) — types, constants, `findDiscrepancies`, `losingPeersIn`, `normalizeValue`
- [`packages/browser/src/app.ts`](packages/browser/src/app.ts) — `recordSyncObservations`, `closeProbeWindow`, `state-discrepancy` inbound handler, dispatcher `case "probe"`
- [SECURITY.md § Discrepancy probe](SECURITY.md) — threat-model framing of what the probe closes and what it doesn't
- [SECURITY.md § The shared root: no consensus](SECURITY.md) — the broader observation that several SECURITY limits share a missing-consensus root, of which the probe is a partial mitigation
- [MultisigDemo.md](MultisigDemo.md) — the dyncap identity layer the probe rides on
- Lamport, *The Byzantine Generals Problem* (1982) — the classical impossibility result this design works around rather than solving
- Castro & Liskov, *Practical Byzantine Fault Tolerance* (1999) — the standard reference for what "classical BFT" means in the comparison above
