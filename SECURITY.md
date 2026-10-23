# Security

## Threat model

[quantum-os](README.md) is a peer-to-peer browser application. The security boundary is the **ZFA capability token** — a cryptographically unguessable, algebraically unforgeable identifier. Possessing a token IS the capability to act (Curry-Howard for capabilities). The signaling server is an untrusted relay and is explicitly outside the trust boundary.

**Scope note — off-chain by default.** Every mechanism in this document (capability tokens, dyncap chains, lemma immutability, the discrepancy probe, rendezvous conservation, vault encryption, group/trust governance) is enforced entirely peer-to-peer, with no blockchain, consensus, or third party in the loop. That is deliberate: it is both the privacy property (ordinary room activity — who's here, what was decided, what changed hands — is never written to a public ledger for anyone outside the room to observe) and the resource property (no gas, no block production, no on-chain state to grow). `/rholang` and the on-chain macros (`$x*` pooled exchange, `$w*` wrapped tokens) are an explicit, opt-in extension for the cases that need a durable public record or a currency that outlives a room — they carry rnode's own trust model (see `docs/rholang.md`'s "Known gaps") and do not weaken, or get relied on by, the off-chain guarantees above.

### What the system defends against

| Threat | Mechanism |
|--------|-----------|
| Identity forgery | Peer IDs are 128-bit random ZFA-balanced tokens; guessing one is computationally infeasible |
| Unauthorized room access | Room IDs are ZFA capability tokens; no token = no join |
| SDP/ICE relay forgery | Signaling server binds each `peerId` to its WebSocket; relayed `from` fields are validated server-side |
| Eavesdropping on peer data | Control-plane envelopes are AES-256-GCM sealed under a key derived from the room token before the signaling relay carries them; WebRTC DTLS + SRTP encrypt media and bulk end-to-end. The relay sees ciphertext and a hashed room name |
| Capability decoherence | `decoherence_impossibility` (machine-verified in Lean 4): `parallel(peer1, peer2, …)` stays ZFA-balanced by construction |
| Envelope authorship after TOFU | `/dyncap` ties each signable envelope to its sender's `H(seed)` anchor; once TOFU-pinned, mismatches and forks are detected and surfaced. Covers `name`, `lemma`, `note-declare`, `note-series`, `retract`, and the outer `sync-*` envelopes. |
| Owner-gated removal | A `retract` is honored only from the item's owner — `from === poll.creator` for a poll, or the sender's verified anchor matching the lemma's stored author anchor. Anyone else only hides the item locally. Tombstones (`qos-retracted-<room>`) keep a removed gossiped item from healing back via a later `sync-*`. The memory-peer daemon honors author lemma retractions too, so an always-on peer won't resurrect a removed lemma. |
| Note terms integrity | A terms-stamped note's token commits to a hash of its terms (`cap:note-<base>~<termsHash8>`), so a relayer can't swap the text without changing the note's identity. The issuer's `note-series` declaration (text + hash) is dyncap-signed and honored only from the currency's issuer; a passed terms cache is accepted only if it hashes to the token's stamp. |
| Identity vault confidentiality at rest | `/password` encrypts the dyncap seed under **AES-256-GCM** with a key derived by **PBKDF2-SHA256 (210 000 iterations, 16-byte random salt, 12-byte random IV)**. The vault (`qos-vault:v1:<salt>:<iv>:<ct>`) is the only representation ever persisted or replicated — the plaintext seed never leaves the browser. A wrong password or any tampering fails the GCM authentication tag, so `/login` rejects it cleanly rather than restoring corrupt state. The password is entered in a masked dialog and never enters the chat log, session log, input history, or any broadcast. |
| Recovery-handle squatting | A group's replicated vaults are keyed by a public handle with **first-write-wins by handle, overwrite only by the same anchor** (the lemma rule). A publisher must be a group member and its dyncap-verified anchor must equal the vault's stored anchor (`fromAnchor === vault.anchor`), so a peer can only publish/replace *its own* identity's vault, never claim someone else's handle or overwrite their vault. |
| Membership bound to the durable identity | Group membership carries the member's dyncap `anchor`, not just the ephemeral per-tab peerId. Recognition (`isMember`/`isAdmin`) matches by anchor, and a member returning on a new browser is re-keyed onto the live peerId only on a **dyncap-verified** anchor (`reconcileGroups`/`rekeyMember`) — so trust, role, and delegations follow the identity, and re-keying cannot be driven without control of the seed. |

### What the system does NOT defend against

| Threat | Notes |
|--------|-------|
| Compromised browser / OS | If the client environment is compromised, RNG and capability storage are untrusted |
| Sybil attacks | Anyone with the room URL can join; the signaling server imposes no per-identity limit |
| Signaling server operator | The operator can observe room membership (peerIds, who joined when, message timing and sizes), disrupt or delay relay, and replay an unsigned `chat` frame under its original sender; they cannot read peer data, forge a sender, or join the room (they hold its hash, not its token) |
| STUN server IP disclosure | ICE candidate gathering uses `stun.l.google.com`; Google observes peer IPs. Use a self-hosted STUN/TURN server to avoid this. |
| Default TURN relay IP/metadata disclosure | When a call falls back to the default relay (`/ice auto`, on by default — see above), Cloudflare observes that call's traffic metadata (IPs, timing, volume) but not content (DTLS/SRTP end-to-end). `/ice auto off` or `/ice turn` substitutes a relay you trust more, or none. |
| Physical link intercept | Signaling channel uses WSS (TLS) in production; a CA compromise could allow MITM of signaling (but not WebRTC data channels) |
| Bearer-note exfiltration | Held `cap:note-<currency>:…` tokens are pure bearer; URL leakage, clipboard exfil, screen recording, or browser-extension scraping is full compromise |
| Issuer impersonation across sessions | Anyone can `/note declare <currency>`. The room trusts that "Alice's USD" was declared by the peer named Alice; a compromised peer session can mint forgeable authorities |
| Holder double-spend across rooms | A malicious holder can copy a note's bytes before `/note pass`/`/note redeem` and try to spend it in a different room. Same-room re-spend is rejected (token is gone from `noteStore`); cross-room re-spend is undetectable. Dyncap did not close this — its chain trajectories are per-room by design (see "Multi-room blanket isolation" below). Closing it would require a shared nullifier set, which means consensus — out of scope. |
| Rendezvous commit divergence | Multi-party commit is best-effort. If `rdv-commit` is lost in flight to some participants, they time out and keep their gives; participants who received it apply the swap, producing transient global conservation violation. True atomicity needs consensus. |
| Proposer-issued asymmetric commits | The proposer signs nothing — each participant validates only its own row. A malicious proposer could in principle deliver mutually inconsistent commits to different participants; downstream inconsistencies surface later but are not prevented at commit time. |
| Sync-envelope authorship forgery (further mitigated) | `sync-lemmas` and `sync-currencies` forward per-entry `who` / `issuer` claims and the original signer's `dyncap`. The receiver validates label, ZFA balance, and the *outer* sync envelope's dyncap against the forwarder's TOFU-pinned anchor. **The joiner-local consensus probe (`/probe`) now also tallies inbound sync envelopes from up to 5 peers on join, applies a chain-weighted supermajority resolution, and adds losing peers to `ignoredForSync`** — a forger now needs to command supermajority weight, not merely be first to reply. *Inner-entry* dyncap verification against the original author's anchor (cross-peer anchor lookup) is still not wired; without it, a malicious forwarder can substitute entries authored by peers the receiver has not directly handshaked with, though the probe will surface any disagreement those substitutions cause. Live `lemma` and `note-declare` paths are fully covered by dyncap once the sender's anchor is TOFU-pinned. |
| Sync flooding | A malicious peer can stuff a `sync-lemmas` / `sync-currencies` envelope with arbitrarily many balanced entries (each is just a fresh random ZFA-balanced token bearing any claimed label). All pass validation; all land in the receiver's stores. No per-peer or per-envelope cap is enforced. Dyncap does not address this — it scopes authorship, not volume. |
| Dyncap clone race | An attacker who exfiltrates a peer's seed and broadcasts a `name` envelope *before* the legitimate peer in a fresh room wins the TOFU pin. The legitimate peer's subsequent envelopes will then be rejected as anchor-mismatched in that room. Hash-only identity cannot close this; signature-strength identity could. |
| Vault password brute-force | The identity vault is confidential only up to its password. Anyone who obtains the ciphertext can attack it **offline**, and with group-scoped recovery the ciphertext is *deliberately* replicated to every group peer (including the always-on memory daemon), so it is not a secret. PBKDF2 at 210 000 iterations raises the per-guess cost but does not save a weak or reused password. Choose a strong password; the vault's security is exactly its strength. |
| Public recovery handle | The `/login <handle>` lookup key is a public label (your display name); anyone in the group can fetch a member's *ciphertext* by handle. Confidentiality rests entirely on the password (row above), not on the handle being secret. |
| Token balance is weaker than QLF's ZFA | `achieves_zfa` conjoins Pauli closure with **aggregate** count balance (`count_pos == count_neg`), where QLF's `is_zfa` requires **pairwise** balance — the signed action vector `(#^-#v, #>-#<, #/-#\\, #+-#-)` vanishing. The aggregate reading is strictly weaker, so the token space is larger than the ZFA-balanced space: at length 6 the kernel accepts 20,480 histories where QLF accepts 5,120. `^^<<` is the smallest illustration — it folds to `+I` with two positives against two negatives, and its signed action vector is `(2,-2,0,0)`. This does not weaken *entropy* (tokens are still 128-bit random), and no attack follows from it; what it means is that "ZFA-balanced token" names a superset of ZFA. See the section below. |
| Vault widens the seed's blast radius | Before `/password`, exfiltrating the seed required reading `localStorage` on the victim's device. A published vault means the seed is now recoverable by anyone with the ciphertext **and** the password — a successful offline crack yields a full clone, subject to the same TOFU clone-race above. This is the accepted cost of portable recovery; it is why the password gate and the "don't run one identity in two browsers" (fork) guidance matter. |

---

## Quoted names

`@"some-string"` is a name anyone can construct, so anyone can write to it —
changing what whatever reads it does next. Nothing here keeps state, routes a
result, or holds a capability at one.

What is used instead: names created with `new`, which cannot be constructed from
outside the program that made them; capability facets handed out as `bundle+`;
and, where an address has to be known in advance, a registry uri derived from a
key (`rho:registry:insertSigned:secp256k1`), which only that key can write to.

A deploy's answer goes to the deployer's own registry slot for this reason, and
that slot holds nothing else — one key, one slot, one job.

Quoted names are not worthless. On a node nobody else reaches, and with care
about what is kept where, they are the simplest thing that works. The property
that makes them unusable here is the one that costs nothing there: reachability
by anyone is only a problem where there is anyone.

## `rho:rchain:deployerId` is a key, not a signature

The on-chain governance contracts ([RGov_Core.md](RGov_Core.md)) and the
dictionary ([MasterDictionary.md](MasterDictionary.md)) settle "who is calling"
by derivation: a verb takes the caller's deployer id as a name parameter and
derives their REV address inside the contract.

```rholang
contract selfFacet(_id, @verb, @args, ret) = {
  revAddr!("fromDeployerId", *_id, *a) | for (@me <- a) { … }
}
```

**A deployer id cannot be forged.** Measured on `rnodeapi.rhobot.net`: passing a
public key as bytes, or a plain string, where a deployer id belongs derives
**`Nil`** — not somebody's address. There is no source syntax for one, so a
caller cannot construct another's. That is what makes the whole `self`-facet
model work, and it holds.

**But it can be given away, and then it is gone.** A deployer id is a bearer
value: whoever holds one can act as that identity, anywhere, for as long as it
exists. Demonstrated end to end — alice deployed a contract that stored
`*deployerId` and handed it to any caller; bob fetched it, derived **alice's**
address from it, and used it to publish under **alice's** root in a dictionary
that had correctly refused him a moment earlier.

Nothing was forged. The identity was disclosed, and disclosure is transfer.

**So the rule is the one that applies to a private key.** Never put
`*deployerId` anywhere a reader can reach it: not in a state cell, not in a
returned value, not in a message body, not forwarded to a facet you do not
control. Derive the address — a string, and safe to store — and keep the id
itself in the one place it arrived.

Every contract here follows that, and it is enforced rather than reviewed:
`rgov-core.js` and `dictionary.js` both assert in their `--selftest` that every
use of `*_id` in the contract source *is* the address derivation and nothing
else. A future verb that stashed one would fail CI.

The same caution applies to anything reached with a deployer id in hand: passing
`*deployerId` to a facet resolved from the registry hands that facet your
identity for the duration of the call, so it matters whose facet it is.

## An inbox has no whole-contract dump

The three governance contracts each carry an `admin` facet for migration, gated
to whoever installed them. For `Group` and `Issue` that is harmless: their state
is what the public `read` facet already answers.

For `Inbox` it was not. Measured on the playground: `admin dump` returned message
**bodies** in clear, so the installer of an inbox could read every locker in it,
capabilities included. A read facet that promises not to answer a body is worth
nothing if another verb answers all of them at once.

Nothing was lost by removing it, because `dump`/`load` could never have migrated
an inbox anyway. `load` takes a term the **client** writes, and there is no
source syntax for an unforgeable name — so that path would have moved the data
and silently dropped every capability, which for a vault is the only content
that mattered.

Migration is per-identity and stays on chain: `export` your own lockers and
`import` them into the new contract **in one term**, so the unforgeables pass
from contract to contract without ever being serialised out to a client.
Verified end to end — a capability delivered into a locker, migrated to a second
Inbox, then taken out of the *new* contract and used successfully against the
*old* one.

Nobody can move your capabilities for you. For a vault that is the correct
property, not a limitation.

## Security architecture

### ZFA capability tokens

Every peer identity, room ID, and granted capability is a `cap:label:hex` token:

```
cap:room:024602460246024602460246…
     ↑       ↑
  label    32 hex digits (16 bytes = 128-bit entropy)
           ZFA = half-spin closure
                 = Pauli scalar return (matrix fold ∈ {±I, ±iI})
                 ∧ Hermitian-pair count balance (count_pos == count_neg)
```

**Which count balance — and why it is not QLF's.** The second conjunct above is
*aggregate*: as many positive twists as negative ones, without regard to which
conjugate pair they came from. QLF's count balance is *pairwise* — `#^=#v ∧
#>=#< ∧ #/=#\ ∧ #+=#-`, the vanishing of the signed action vector, which is
what *Zero Free Action* names. Pairwise implies aggregate; the converse fails.

Two consequences, both measured exhaustively by
[`crates/zfa-core/tests/census_conformance.rs`](crates/zfa-core/tests/census_conformance.rs):

- **The keystone does not apply to the aggregate predicate.** QLF's
  `count_balanced_pauli_closed` proves count balance implies Pauli closure for
  every history; its hypothesis is the pairwise predicate. Under the aggregate
  one there are 61,440 counterexamples at length 6 alone (`^<` is the
  two-twist case, folding to `-iσ_z`). So the conjunction here is load-bearing,
  not the redundant cross-check it was previously documented as.
- **`achieves_zfa` over-accepts.** At length 6 it admits 20,480 histories where
  QLF's `is_zfa` admits 5,120 — three quarters of what the kernel calls a
  closure has a non-zero signed action vector.

The predicate is left as-is rather than tightened, because it is what live room
links and already-minted identities validate against; narrowing it would
invalidate deployed tokens. `is_pairwise_balanced` / `achieves_zfa_pairwise`
(Rust) and `isPairwiseBalanced` / `achievesZfaPairwise` (TypeScript) provide
QLF's predicate for anything that needs it, and the coupling metric below uses
them. The conformance suite pins the gap at exactly this size so it cannot
widen unnoticed.

### Census conformance

The kernel is checked against the QLF census — an exhaustive enumeration of the
8-twist alphabet computed in a separate repo, in a different language, and
cross-checked there against machine-verified Lean theorems. The suite
re-derives every census total here by brute force from this crate's own fold:
266,304 histories at lengths 2, 4 and 6 on every `cargo test`, and 16.7M at
length 8 behind `--ignored`. A sign flip in `twist_matrix`, a wrong branch in
`is_pauli_closed`, or a drifted `Twist` encoding moves at least one total and
fails the build. It is the check that found the balance-predicate gap above.

Tokens are generated using `crypto.getRandomValues()` (browser) or the `getrandom` crate (Rust/WASM), which calls `crypto.getRandomValues()` internally. Entropy: 128 bits. Since v0.17, `Capability::from_entropy` uses rejection sampling (expected ~4 iterations) to guarantee both faces of the half-spin closure hold for every issued token. The output space is reduced versus the count-only check, but remains astronomically large for 32-twist tokens.

The ZFA invariant is machine-verified in [Lean 4](https://github.com/rhovision-org/quantum-logical-framework):

- `achieves_ZFA` — half-spin closure (Pauli scalar return ∧ Hermitian-pair count balance)
- `rho_process_always_zfa` — parallel composition stays ZFA
- `decoherence_impossibility` — no operation can break ZFA
- `no_magnetic_monopoles` (ZFAEventDynamics.lean) — `∇·B = 0` follows from ZFA closure

Rust source: [`crates/zfa-core/src/capability.rs`](crates/zfa-core/src/capability.rs)

### Quantum security

The core p2p security model — capability tokens, dyncap identity, the
identity vault — uses **no public-key cryptography whose hardness depends on
factoring or discrete log**, the class of problem Shor's algorithm breaks. It
is built entirely from CSPRNG entropy, hashing, and symmetric encryption,
each of which a quantum computer only attacks with Grover's algorithm — a
quadratic speedup, not a break:

| Mechanism | Primitive | Quantum exposure |
|-----------|-----------|-------------------|
| Capability tokens (peer ID, room ID, lemma/note caps) | `crypto.getRandomValues()` entropy, 128 bits, ZFA-constrained | Grover only: brute-force search over the token space, not a structural attack |
| Dyncap identity (`anchor`, `witness`) | SHA-256 only, hash chain, no keypair | Grover only: preimage search, not a structural attack |
| Identity vault (`/password`) | PBKDF2-SHA256 (210k iters) → AES-256-GCM | Grover only: AES-256 keeps a large post-quantum margin |

None of these rely on discrete log or factoring, so there is no known quantum
algorithm that breaks them structurally the way Shor's algorithm breaks RSA
or ECDSA — only the same brute-force search a classical attacker faces,
sped up quadratically. **This is what "off-chain by default" buys beyond
privacy and cost**: it also keeps the identity and capability layer off of
classical public-key crypto, by construction, not as a deliberate
post-quantum design exercise.

Two exceptions, both outside the core p2p model and both inherent to
interfacing with systems this project does not control, not choices made
here:

- **`/rholang deploy`** signs with **secp256k1 ECDSA** (`rholang.ts`, via
  `@noble/curves`) to interoperate with the shipped rnode's existing
  signature scheme — the same exposure to Shor's algorithm every
  classical-signature blockchain has today. This path is opt-in and
  off-chain-by-default (see the scope note above); a broken deploy key
  compromises that key's on-chain funds/registry slot, not any peer's room
  identity or capability tokens.
- **WebRTC/DTLS transport** — the browser's own DTLS handshake typically
  negotiates ECDHE, outside this project's control. A "harvest now, decrypt
  later" adversary who records a session's ciphertext today and gains a
  quantum computer later could in principle recover that session's
  transport key. This affects only the recorded traffic of that one call,
  not the algebraic capability/identity layer above it, which is not
  transported as a secret to begin with — a capability token's *security*
  is that possessing it is authorization, not that it stays hidden in
  transit forever.

### Signaling server trust model

The signaling server (`packages/signaling/`) is a **thin WebSocket relay**. It:

- Routes SDP offers, answers, and ICE candidates between peers
- Relays the room's **control plane** — chat, lemmas, notes, polls, gov, every `sync-*` — as `data` frames whose payload is **sealed under a key derived from the room token** (below), so it carries what it cannot read
- Tracks room membership (peer join/leave), holding a seat for `SIGNAL_GRACE_MS` (60 s) when a socket dies so a rejoin under the same peerId resumes silently ([docs/connection.md](docs/connection.md), "The transport")
- Never sees WebRTC data channel or media contents (DTLS/SRTP-encrypted peer-to-peer) — calls, attachments and `/file get` stay on WebRTC

**The relay cannot read or join the room** (`packages/browser/src/room-crypto.js`, shared by the browser and the Node agents). Each control-plane envelope is AES-256-GCM encrypted under `HKDF-SHA256(room token)`, with the sender's peerId as GCM additional data — so a frame the relay re-labels with another `from` opens for no one. The server is told only `SHA-256("qos-room-id:" + token)` as the room's name. **Before this build the raw room token was sent on `join`**: the relay operator held the capability to join every room it relayed. Now they hold a name that is not a capability. Symmetric primitives only — no keypair, so no new Shor exposure (see *Quantum security*). What this does **not** prevent: the relay **replaying** a sealed frame under its original `from`. The dyncap-signed kinds (`name`, `lemma`, `note-declare`, `sync-*`, polls, gov, …) carry a monotonic `seq` and a replay is refused as a chain violation; a plain `chat` line could be replayed. A per-room, per-sender frame counter inside the sealed payload would close this and is not built.

**Relay forgery protection:** the server maintains a `ws → peerId` index populated at join time. Every relay message (`offer`, `answer`, `ice`, and `data`) is rejected with an error if the `from` field does not match the peer ID registered for the sending connection, and a `leave` is honoured only for the sending socket's own seat (before this any socket could `leave` any peer, making the room see them gone). A peer cannot forge messages as if they came from another peer.

```typescript
// packages/signaling/src/server.ts
if (this.wsIndex.get(ws) !== msg.from) {
  this.send(ws, { type: "error", message: "relay from mismatch" });
  return;
}
```

**Inbound frame validation:** `SignalMsg` is a *claim* about parsed JSON, not a guarantee — the wire is untrusted. Every frame is checked for its required fields before dispatch (`isWellFormed` in `server.ts`), and a malformed one is answered with an error instead of acted on. The socket's `close` handler additionally contains its own throws, so no cleanup failure can end the process.

```typescript
// packages/signaling/src/server.ts
if (!isWellFormed(msg)) {
  this.send(ws, { type: "error", message: `malformed ${msg.type}: missing required field` });
  return;
}
```

**Room ID as capability:** the signaling server does not enforce authentication. Knowing the room token IS the capability to join — consistent with the ZFA model. The room URL hash (`#room=cap:room:…`) is the bearer token, and it is also the key material: a peer without it can reach the relay's room by its hashed name and read nothing there.

### WebRTC transport security

All peer-to-peer data channel traffic is protected by the WebRTC security stack:

- **DTLS 1.2** for key exchange and authentication
- **SRTP** for data channel encryption
- ICE candidates are gathered via STUN (`stun.l.google.com:19302` by default)

The signaling server's SDP relay cannot be used to MITM the WebRTC connection — each peer's DTLS certificate fingerprint is included in the SDP and verified during the DTLS handshake.

**Default TURN relay (quantum-os#126).** A call between two peers who cannot form a direct ICE pair (symmetric NAT, mobile CGNAT, a NAT'd container) needs a TURN relay — a data-channel message can flood through the room's peer-relay overlay with no direct link, a `MediaStreamTrack` cannot. The browser fetches a short-lived credential from the signaling server's `GET /turn` (`app.ts` `fetchAutoTurn`, on by default, `/ice auto off` opts out), which mints it from Cloudflare Realtime's TURN Service using `TURN_KEY_ID`/`TURN_KEY_API_TOKEN` — environment variables on the signaling deployment, never committed, never sent to the browser (`packages/signaling/src/turn.ts`). What the relay operator (Cloudflare) can see: connection metadata (IP addresses, timing, volume) for any call that actually routes through it — most calls do not, since a relay is only used when a direct path fails. What it cannot see: content — DTLS/SRTP encryption is end-to-end between the two peers, unaffected by a relay in the path. The credential itself is short-lived (minted for 24h, the signaling server re-mints hourly) and scoped to relaying, nothing else. `/ice turn` lets a user substitute a relay they trust more (or run themselves) instead.

### `/search` and `/solve` — computed in the browser

Since qos#119, `/search` and `/solve` **compute locally** — `packages/browser/src/qucalc-enum.ts`, a port of the QLF reference `qucalc_search.py`, run in a Web Worker. There is no service, no endpoint, no HTTP request. This removes the whole external-data-source trust surface the earlier design carried (a configurable endpoint that could return wrong closures or stall).

- **Nothing leaves the browser.** The `qc` seed is a twist history the room already holds; the enumeration is a pure function of the ZFA kernel.
- **The gate matches the QLF reference.** The enumerator accepts a closure only when the signed action vector vanishes *per axis* (`#^=#v ∧ …`) **and** the Pauli fold is a scalar — strictly narrower than the app's aggregate `achievesZfa`. `test/qucalc-search.test.mjs` holds a conformance block of digests captured from `qucalc_search.py` so the port cannot silently drift.
- **Result is broadcast.** `/search` sends its result to the room as a `qlf` envelope (the shared-experiment framing). Same trust surface as any other `qlf` broadcast — a peer can post a misleading result the way it can post a misleading `/qucalc`; the closures are verifiable against the kernel by any recipient, and every peer computing the same deterministic answer is what makes a discrepancy visible.
- **DoS shape.** `MAX_DEPTH_CAP` (7) and the per-call `limit` bound the work; the worker is terminated on abort or when the generator is dropped.

### Promissory notes, rendezvous, and bearer semantics

The `/note` and `/rdv` features extend the bearer-capability model from peer identity to value-bearing instruments. All defenses scale the same way: possession of bytes is authority; no protocol enforces who *should* possess them.

**Validation at every boundary.** Every inbound envelope that carries a token (`note-declare`, `note-pass`, `note-redeem`, `note-receipt`, `rdv-propose`, `rdv-accept`, `rdv-commit`, `sync-lemmas`, `sync-currencies`) re-parses the label (`parseNoteLabel`), checks the declared currency / denomination matches the embedded twist sequence, and runs `validateCapability` for ZFA balance before mutating local state. Malformed or unbalanced entries are silently dropped.

**Conservation as a typing rule.** `conservationCheck(rows)` rejects rendezvous proposals whose `gives` and `gets` multisets do not match per `(currency, denomination)`. Split and merge on notes preserve `count_pos == count_neg` by construction — a denomination-N note that splits into (a, N−a) produces two ZFA-balanced halves whose lengths sum to the original. The same Lean invariant (`rho_process_always_zfa`) covers these operations.

**Locking, not consensus.** During an in-flight rendezvous, an accepted `gives` token moves from `noteStore` to `lockedNotes`; `/note pass` / `/note redeem` cannot see it. On abort/reject/timeout the lock is released back to `noteStore`. On crash the lock is persisted, but the proposal context is in-memory only — on reload, orphaned locks return to the wallet (so value is never lost across a crash), which means the proposer side may see a stale acceptance that no longer corresponds to a held token. This is the same "best-effort" trust posture as `/note pass`.

**Sync is gossip with structural — not authorship — re-validation.** When a new peer joins, every existing peer sends snapshots of `lemmaStore` and `knownCurrencies` over each new data channel. Each entry is re-validated against the same label and ZFA-balance checks the live `lemma` / `note-declare` handlers use, so malformed or unbalanced entries are silently dropped. **What re-validation does not catch is forged authorship.** A `sync-currencies` entry carries `{ currency, token, issuer }`; a `sync-lemmas` entry carries `{ name, twists, who }`. A malicious peer can construct a fresh ZFA-balanced token of any label and claim any `issuer` / `who`. The receiver will store it as fact because there is no signature scheme that binds the token bytes to a specific identity. The live note-declare and lemma broadcast paths are safe from this — they derive authorship from the wire-level sender's peer ID, which the signaling server validates via `wsIndex` — but the sync envelope's per-entry author claim is structurally untrusted. The planned mitigation is dynamic capabilities (Wave 3): identity becomes a continuously-proven trajectory, and a sync entry's `issuer` field gains a verifiable signature instead of a bare claim.

Held notes, receipts, the issuer's `redemptionsHonored` log, and in-flight rendezvous proposals are *never* gossiped — they're private bearer state.

### Dynamic capabilities (`/dyncap`) — hash-only identity layer

A peer's identity is a 32-byte secret `seed` (per-device, persisted to `localStorage` outside the per-room namespace) plus a derived public anchor `H(seed)`. Signable envelopes (`name`, `lemma`, `note-declare`, `sync-lemmas`, `sync-currencies`) carry a `dyncap: { anchor, seq, witness }` field, where `witness = H(seed || seq_le32 || room_id_bytes || payload_hash)`. The `room_id_bytes` binding keeps the chain from being replayed across rooms.

Receivers maintain per-peer chain state keyed by peer ID. The first envelope's anchor is TOFU-pinned. Subsequent envelopes must use the same anchor, must carry a strictly higher `seq` than already seen (per `(anchor, seq)`), and must produce a `witness` distinct from any previously accepted at the same seq. Two valid envelopes at the same `seq` under the same anchor — a *fork* — flag the peer's chain `contested` and surface a `⚠` chat warning.

**`name` is exempt from refusal.** A dyncap failure (anchor mismatch, fork, replay, invalid) on a `lemma` / `note-declare` / `sync-*` / `retract` envelope drops it. On a `name` envelope the receiver instead **applies the claimed display name with a `⚠` suffix** and a chat warning ("treat its identity as unverified"), while still skipping the chain-trusting side effects (`reconcileGroups`, the agent pin). Rationale: a display name is cosmetic — anyone can `/name` anything and the chain never owned it — and refusing to *render* it left a peer with a contested chain (a `/login` recovery, a reused peerId) as a permanent hex id, which made the room unusable with them **and** hid the impersonation rather than surfacing it. `Name ⚠` in the roster is a louder signal than an anonymous hex id, not a weaker one.

**What dyncap closes.** Live `lemma` and `note-declare` envelopes are now bound to their sender's TOFU-anchored chain; a malicious peer cannot forge an envelope claiming to come from a different peer's anchor (mismatch is detected on receipt). The sync envelope itself is also signed by the forwarder.

**What dyncap does not close.** The MVP does not actively re-verify forwarded sync entries against the *original* author's anchor — a malicious forwarder can substitute entries authored by peers the receiver hasn't directly handshaked with (see threat row above). The fork-detection guarantee holds only against equivocation that both halves of the fork eventually reach the same receiver; clones broadcasting to disjoint subsets of the room remain invisible to each other until those subsets compare notes. And the initial TOFU is racy: a clone with a stolen seed who broadcasts first in a fresh room wins the anchor.

**Why hash-only.** The QLF philosophy is that the algebra is the security; importing an asymmetric primitive (Ed25519 etc.) would put a fundamentally different trust mechanism alongside ZFA balance. Hash-only dyncap stays within the same algebraic universe at the cost of TOFU semantics and the clone-race vulnerability. Use [MultisigDemo.md](MultisigDemo.md) as a guide to what dyncap + rendezvous together can attest to in practice.

### Identity recovery (`/password` / `/login`) — password-encrypted vault

The dyncap seed is the whole identity: `anchor = H(seed)`, and every witness derives from it. By default the seed lives only in one browser's `localStorage`, so clearing storage or switching devices loses the identity. `/password` and `/login` make it recoverable without weakening the hash-only model — recovery moves *ciphertext*, and the only added secret is a user password.

**The vault.** `/password` serializes `{ seed, name }`, encrypts it with **AES-256-GCM** under a **PBKDF2-SHA256(password, 16-byte salt, 210 000 iterations)** key, and emits `qos-vault:v1:<salt>:<iv>:<ct>` (fresh salt+IV per call). This is the sole first `crypto.subtle` AES use in the app; SHA-256 elsewhere is dyncap's. The plaintext seed is never broadcast or persisted anywhere but the originating browser; the password is collected in a masked modal, never via a chat command, so it never reaches the transcript or the wire. `/login` reverses it; the GCM tag makes a wrong password or tampered blob a clean rejection, not a corrupt restore.

**Two transports, both keeping the seed on-device until recovery.**
- *Self-custody string.* `/password` shows the vault; the user stores it; `/login` restores from a paste. No network, no third party.
- *Group-scoped replication (pure p2p).* If the user is a group member, `/password` also publishes the vault into the group under a public handle via a self-signed `gov-vault` envelope, replicated on the **same `sync-gov` fabric** as the rest of governance and persisted by the memory-peer daemon. `/login <handle>` fetches the ciphertext from whichever peers hold the group state and decrypts locally. There is **no server and no username→identity registry** — the daemon is just another peer that stores ciphertext it cannot read.

**Authorship and anti-squatting.** A `gov-vault` is honored only if (a) the sender is a member of the target group and (b) its dyncap-verified anchor equals the vault's declared `anchor` — so a member can publish only *its own* identity. Handles are **first-write-wins, overwritable only by the same anchor**, mirroring lemma authorship; a later, higher-`at` write from the same anchor updates the vault (rotating the password), anyone else is ignored. The daemon enforces the identical rule.

**Membership follows the identity, not the tab.** A `Member` record carries the durable `anchor`; recognition (`isMember`/`isAdmin`) matches by anchor as well as peerId. When a dyncap-verified envelope arrives from a known anchor under a *new* peerId (the post-`/login` case), `reconcileGroups`/`rekeyMember` move the membership — and every peerId-keyed reference (delegations, trust ratings, censures, creator) — onto the live peerId. Because this is gated on a **dyncap-verified anchor**, only the holder of the seed can trigger it; a bystander cannot capture a membership by asserting someone else's anchor.

**What this does not add.** It does not upgrade the trust model: recovery confidentiality is exactly the password's strength, and any holder of the replicated ciphertext (group peers, the daemon) can attack it offline — see the "Vault password brute-force" and "Vault widens the seed's blast radius" threat rows. It is not key rotation in the asymmetric sense (there is no keypair) and offers no forward secrecy: re-running `/password` re-encrypts the *same* seed under a new password, so a previously-captured vault stays crackable under its old password. The anchor-rekey inherits dyncap's clone-race limit — an attacker who has *already* stolen the seed could likewise re-key a membership; the seed's secrecy remains the root of trust.

### Discrepancy probe (`/probe`) — joiner-local supermajority resolution

The full reference is [Consensus.md](Consensus.md); the security-architecture summary:

When a peer joins a room, `onSignalingOpen` opens a probe window that collects inbound `sync-lemmas` / `sync-currencies` envelopes from up to `SAMPLE_SIZE` (5) distinct peers within `PROBE_WINDOW_MS` (5 s). On close, `findDiscrepancies` tallies each contested key by **weight**, not by count: each contributor's vote weight is their dyncap chain depth (`dyncapChains[peer].lastSeq`, floor 1). The winning value must clear a strict **2/3 supermajority** of total weight. If it does, the joiner adopts the winner locally, broadcasts a `state-discrepancy` envelope so the room sees the disagreement, and adds the peers behind every losing bucket to `ignoredForSync` — their subsequent sync envelopes are silently dropped. If no value clears the threshold, the discrepancy is broadcast with `winner: null` and the joiner keeps its existing local state.

This raises the bar on three attacks: single-Sybil sync forgery (must now command supermajority weight, not just arrive first), sync flooding with fresh identities (each weighted at the floor of 1, so the forger needs many aged identities), and equivocating peers (the discrepancy is broadcast even when no winner clears the threshold, so the room sees the disagreement).

**It is not classical Byzantine fault tolerance.** Resolution is *joiner-local*: non-joining peers log the broadcast but do not auto-update. Each new joiner reaches their own decision; the room's views can persistently diverge. Coordinated aged-identity Sybils can still buy their way to supermajority weight; the dyncap clone-race remains; cross-room resolution is absent. The probe also relies on **lemma immutability** — once `@name` is declared, both the dispatcher and the inbound `lemma` handler refuse re-declaration with different twists. Without that fix the probe would be tallying accidental overwrites rather than real disagreement.

For full BFT (Castro-Liskov, HotStuff, Tendermint, …) the system would need real signed messages, a stable peer view with `n ≥ 3f + 1`, and a global ordered log with finality. Each is outside the QLF philosophy of algebra-as-security. The probe is the highest layer this project pushes "consensus" before that boundary; deeper is a different system.

### Multi-room blanket isolation (`/room`)

A single browser session can join N rooms simultaneously. Each room is a **separate Markov blanket** — independent peer set, lemma store, currency registry, dyncap chain trajectory, consensus probe, and signaling connection. Per the QLF philosophy: external (other rooms) is conditionally independent of internal (this room's interior) given the room's sensory/active envelope surface.

What this gives:
- **No cross-room signaling backchannel.** Each room has its own `QOSPeer` and signaling WebSocket. Messages routed by the relay never cross rooms.
- **No cross-room state sync.** A lemma declared in room A doesn't auto-propagate to room B. Sync envelopes stay scoped to the room they were authored in.
- **No cross-room consensus.** The probe runs per-room; a discrepancy in room A is invisible to room B.
- **Independent chain trajectories.** A peer's dyncap anchor (`H(seed)`) is the same across rooms (same per-device seed) but the `seq` counter is per-room. Witnesses (`H(seed ‖ seq ‖ room_id ‖ payload_hash)`) are algebraically independent — a peer's chain in room A reveals nothing about their chain in room B.
- **Background-room state mutations are correctly isolated.** Callbacks from a non-viewed tab's QOSPeer execute against the room that owns them (via `setActiveRoom(ctx)` at callback entry, with try/finally restoration and per-`await` re-assertion in `onMessage`). DOM-touching code further guards with `isUiActive()` so the visible tab isn't disturbed.

What remains the user's responsibility (cross-room is by design **explicit**):
- **Bridge peers are application-level.** A peer in rooms A and B can manually re-declare a lemma or re-grant a note in each room; that re-declaration produces a fresh chain step in the target room with that peer's dyncap signature *in that room*. There's no protocol-level cross-room envelope.
- **Cross-room replay is undetectable.** A note minted in room A whose bytes are copied into room B will validate (it's a ZFA-balanced cap) but its issuer's authority in room A means nothing in room B. The room B audience must independently TOFU the issuer's dyncap anchor in room B.
- **Resource: simultaneous WebRTC connections.** Each joined+connected room holds an active signaling socket + data channels. Practical cap is dozens of rooms per browser session; beyond that, memory and battery start to matter.

This is not a *threat* mitigated — it's a *design choice* that the threat model articulates: cross-room continuity is deliberately absent. The Markov-blanket framing makes the absence explicit and turns the previously-vague "out of scope" cross-room rows in this document into a coherent invariant: *the algebra cannot reach across blankets without an explicit bridge peer.*

### The shared root: no consensus

Several of the limits above are facets of the same architectural choice. quantum-os is a peer-to-peer per-room system **with no consensus mechanism**, so it cannot provide global consistency over the room's history. Specifically:

- **Cross-room double-spend** of a bearer note is undetectable because there is no shared nullifier set.
- **Multi-party rendezvous atomicity** is best-effort because there is no agreement protocol that binds all participants to the same commit / abort decision.
- **Sync-envelope authorship forgery** is undetectable because there is no ordered, agreed-upon log of who declared what when.
- **Proposer-issued asymmetric commits** are undetectable at commit time because there is no broadcast-with-equivocation-detection layer.

Each of these has a known solution in the consensus literature — nullifier SMTs in zk-rollups (DarkWow's approach), Byzantine fault tolerant commit (PBFT, HotStuff), append-only signed logs with equivocation detection (CONIKS, Certificate Transparency). quantum-os deliberately omits all of them in exchange for a different set of properties: zero infrastructure, instantaneous per-room operation, and the algebraic guarantee that every individual capability is ZFA-balanced by construction.

**A consensus layer is the right primary mitigation** for the entire class of forge-and-equivocate attacks against the gossip, transfer, and rendezvous flows. The shipped joiner-local consensus probe (chain-weighted supermajority on a 5-peer sample) is a partial step in that direction — it raises the attacker cost on the sync path but does not bind non-joining peers and does not provide finality. Dyncap closed authorship forgery on the live broadcast path; closing cross-room double-spend and asymmetric commits still requires real signatures with a stable view (classical BFT) or a global ordered log (a blockchain consensus layer).

In the meantime, the bearer-and-room-scoped trust model should be read literally: if you wouldn't hand someone the bytes of a `cap:note-USD:…` token in person, don't `/note pass` it to them, and don't trust a fresh sync envelope from a peer you don't recognize.

---

## Known issues and mitigations

### Current gaps (prioritised)

| # | Issue | Severity | Status |
|---|-------|----------|--------|
| 1 | No per-message size limit on signaling WebSocket | Medium | Fixed — `maxPayload` on `WebSocketServer` (64 KB, raised to 256 KB when the control plane moved onto the socket) |
| 2 | No rate limiting on signaling connections or messages | Medium | Fixed — 20 msg/sec per connection (fixed window) |
| 3 | Peer IDs logged in full on the signaling server | Low | Fixed — logs show last 8 chars only (`…abcd1234`) |
| 4 | Hardcoded Google STUN server leaks peer IPs to Google | Low | Fixed — STUN URL editable in sidebar; empty value disables STUN |
| 5 | Lenient hex parsing in fallback `validateCapability()` | Low | Fixed — rejects tokens with any char outside `[0-7]` |
| 6 | Sync inner-entry dyncap not re-verified against original author's anchor | Medium | Open — `sync-lemmas` / `sync-currencies` carry forwarded entries with the original signer's dyncap, but the receiver only verifies the outer envelope. A malicious forwarder can substitute entries authored by peers the receiver has not directly handshaked with. Fix requires a cross-peer anchor lookup table. |
| 7 | Dyncap seed clone wins TOFU race | High (if seed leaks) | Mitigated only by seed secrecy. Fundamental for hash-only identity; full mitigation requires signature-strength identity (out of scope for the QLF philosophy). |
| 8 | Identity vault crackable offline, gated only by password | Medium | Inherent to portable recovery. `/password` replicates AES-256-GCM ciphertext keyed by PBKDF2-SHA256 (210 000 iters); any holder of the ciphertext (group peers, memory daemon) can brute-force offline. Mitigated by iteration count + user password strength; no server-side rate limit is possible in a p2p design. Publishing to a group is opt-in (only on `/password` while a member). |

### Already fixed

| Issue | Fix |
|-------|-----|
| Relay `from` field forgery | `wsIndex` binding in `packages/signaling/src/server.ts` — validates `msg.from` against the sending WebSocket connection |
| No message size limit | `maxPayload` (256 KB, `SIGNAL_MAX_PAYLOAD`) on `WebSocketServer` — oversized frames rejected at the protocol layer |
| No rate limiting | Fixed-window rate limiter in `onConnect` — 20 msg/sec per connection; excess messages receive an error and are dropped |
| Full peer/room IDs in logs | Signaling server logs truncated to last 8 chars (`…abcd1234`) |
| Hardcoded Google STUN | STUN URL now user-configurable in the sidebar; defaults to `stun:stun.l.google.com:19302` |
| Lenient hex parsing in `validateCapability()` | Rejects tokens with any char outside `[0-7]` before processing |
| Unauthenticated remote crash of the signaling server | A `join` missing `roomId`/`peerId` registered a peer under the key `undefined` — the throw inside `onJoin` was swallowed by the `invalid JSON` catch *after* the index was poisoned — and the socket's later `close` ran `onLeave` with an undefined peerId outside any try/catch, ending the process and every room with it. Any client could do this by connecting, sending one malformed frame, and hanging up. Fixed by `isWellFormed` validation before dispatch, plus a contained `close` handler |

---

## Dependency security

| Dependency | Version | Role | Notes |
|------------|---------|------|-------|
| `ws` | ^8.17.0 | WebSocket server | Actively maintained; no known CVEs |
| `wasm-bindgen` | 0.2 | Rust ↔ JS bridge | Standard; generated by wasm-pack |
| `getrandom` | 0.2 | Cryptographic RNG | Uses OS entropy (`/dev/urandom` / `crypto.getRandomValues()`) |
| `vite` | ^5.0.0 | Browser bundler | Dev/build only; not in production bundle |

Dependencies are pinned via `pnpm-lock.yaml` and `Cargo.lock`. Run `cargo audit` and `pnpm audit` to check for known vulnerabilities.

```bash
cargo install cargo-audit
cargo audit
pnpm audit
```

---

## Reporting a vulnerability

Please report security vulnerabilities by opening a [GitHub issue](https://github.com/rhovision-org/quantum-os/issues) marked **[security]**, or by emailing the maintainer directly. Do not include exploit code in public issues.

Responsible disclosure: allow 30 days for a fix before public disclosure.
