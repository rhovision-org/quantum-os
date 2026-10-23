# Cross-shard — the linked invoke, and CapTP on top

Companion to [`Room_Bridges.md`](Room_Bridges.md) (information across rooms) and
[`Governance.md`](Governance.md) (a group as an identity). This is about
**coordination between shards** — RChain shards, and other chains later.

Two layers, and most uses only need the first:

| layer | what | where |
|---|---|---|
| **1 — linked invoke** | your *own* account, signed — a remote deploy to another shard to invoke a capability there | [rholo#33](https://github.com/rhovision-org/rholo/issues/33) / [#34](https://github.com/rhovision-org/rholo/pull/34) |
| **2 — CapTP** | handing someone a *revocable, attenuated* proxy that acts on your behalf; promise pipelining; routing to non-linked shards and other chains | [quantum-os#173](https://github.com/rhovision-org/quantum-os/issues/173) |

Status: **Layer 1 in draft** ([rholo#34](https://github.com/rhovision-org/rholo/pull/34):
`casper::shard_invoke`, the decision record, the exchange contract — CI green,
and the branch build verified against the local chain). Layer 2 is design.
On the quantum-os side, the pooled exchange's cross-shard trade is now
**atomic** — a client-driven two-phase commit, verified end to end against
localnet, including the wrapped-native-token path (`$wrap`/`$unwrap`) — see
"Exchange support" and "Wrapped native tokens" below.
An earlier quantum-os cut (a burn/mint value-transfer escrow, `/captp` command)
was built and removed — it moved the platform token and assumed equal value,
both ruled out. What is kept client-side:
[`deployToNode`](packages/browser/src/rholang.ts) (deploy to a specific node,
per-node result-slot nonce) and this document.

---

## Not, at either layer

- **No burn or mint of the platform token (REV). Ever.** Nothing here touches
  `rho:rchain:revVault`. A token that wants cross-shard movement exposes a
  `transfer` method on its own contract; a caller invokes *that*.
- **No assumption that tokens are REV, fungible, or of equal value.**
- **No value teleportation.** A capability stays on its home shard.

---

## Layer 1 — the linked invoke (the primitive)

Identity is **not bridged — it is already the same.** A `deployerId` (and the
REV address derived from it) is shard-independent: your secp256k1 key *is* the
same account on every shard. So invoking a capability on another shard is not
a transport problem — it is signed message-passing where the far shard binds
*your own* `deployerId`.

**It is an ordinary, caller-signed deploy submitted to the target shard —
no relay, no link table, no new consensus** (resolved in
[rholo#33](https://github.com/rhovision-org/rholo/issues/33),
draft PR rholo#34). A deploy already *is* the signed message that carries
the identity; a home-shard relay would have to re-sign a different payload as
the caller, which the home node cannot do (it holds only the public key).

- **`$at(shard, `rho:id:x`)!(method, args…)`** expands, at the client, to a
  normal deploy signed with the caller's key, whose term runs on the target
  shard:
  ```rholang
  new lookup(`rho:registry:lookup`), cap in {
    lookup!(`rho:id:x`, *cap) |
    for (@(_, target) <- cap) { @target!(method, args…, `rho:rchain:deployId`) }
  }
  ```
- **Identity:** the far node binds `rho:rchain:deployerId` from the signature —
  the caller's own key — so a `deployerId`-gated capability there (the locker,
  an escrow facet) sees exactly the caller it would locally. Nothing is
  delegated or wrapped.
- **Reply:** written to `` `rho:rchain:deployId` `` (the deploy's own id). The
  client **listens on that channel** (`listenForDataAtName`) and resolves on
  the value — no `deployStatus` polling; a caller-local `*ret` cannot cross
  shards, so a channel listen is the equivalent of a local `for`.
- **Failure is a value:** a missed lookup, a rejected deploy, or a listen that
  times out yields `("shard-error", reason)` — never a hang.
- **Phlo** is charged to the caller's account on the far shard — the same
  account, same key, same REV vault.
- **The "link table" collapses** to an endpoint (the target's deploy service)
  plus the registry URI (the capability handle you were handed). Reachability,
  not authority; no replicated link state, so no new consensus. Revocation is
  the far contract's own authorization, or not handing out the URI.
- **The security is capability security, which is proven:** you can only invoke
  a URI you were handed; the far contract enforces whatever it enforces against
  your real identity.

**Honest consequence.** A remote deploy is a *separate transaction* on the far
shard, so it cannot compose into one home-shard closure — there is no single
transaction spanning two shards, and never will be without shared consensus.
What Layer 1 *does* let a contract do is compose a **two-phase commit** across
that separate-transaction boundary: prepare each leg (durably, readably,
reversibly), then commit both or abort whichever prepared. That is
**safety-atomic** — no reachable state loses value or shorts a party — even
though it is still two transactions, not one. See the pooled exchange below.

### Exchange support — contracts on Layer 1

Two shapes:

- **Pooled exchange, atomic** (`packages/browser/src/rholang-exchange.js`,
  quantum-os) — a pool trades one token pair at an owner-set rate
  (`$xopen` / `$xprovide` / `$xdeposit` / `$xquote` / `$xswap` / `$xwithdraw`);
  `$xlink` federates two pools, and a cross-shard trade is **client-driven
  two-phase commit**: `$xprepare` the local leg (does the swap now, holds a
  reversible tx record) → `$xreceive` the linked remote pool (over a Layer-1
  remote signed deploy — credits the local leg's output as if deposited, gated
  to a registered link so the federation only extends this trust to a shard it
  has deliberately linked) → `$xcommit` both, or `$xabort` the one leg that
  prepared. Both are idempotent; `$xstateof` is the durable, readable record a
  crashed client's own key reconnects to and recovers from
  (`packages/browser/src/exchange-2pc.ts`'s `decideRecovery` is the pure
  decision table). **Verified end to end against localnet** — happy path,
  the abort path (a rejected `prepareReceive` unwinds the prepared leg
  exactly), and the permissionless-after-expiry abort below. A quantum-os
  `/note` currency reaches a pool as its token contract's URI; the platform
  token participates only wrapped (below).
  - **`abort` is holder-or-expired-gated**
    ([quantum-os#198](https://github.com/rhovision-org/quantum-os/issues/198),
    shipped 2026-09-15): the tx's own holder may always abort a prepared tx;
    anyone else may once the current block number passes the tx's recorded
    `expiryBlock`, so a trade abandoned by a lost/gone key is not locked
    forever. The `abort` contract reads `rho:block:data` to check this. That
    used to be blocked — verified empirically (2026-09-11, `bin/rnode` 0.1.0)
    that reading `rho:block:data` from a *signed deploy* broke that build's
    `return`/registry-readback mechanism, reproduced down to the simplest
    possible program (a bare block-data read + `return!`), with a clean
    "Success!" and no rholang error either — but does not reproduce as of
    rholo `dev` `9e667e203` (re-verified 2026-09-14, twice, against a
    fresh devnet); not bisected which upstream change fixed it.
- **Bilateral escrow** (`qucalc/examples/shard_exchange.rho`, rholo#34):
  an escrow on each shard, pre-funded, fixed rate; a send `deposit`s locally
  and `consume`s the remote one through a remote invoke. Still
  client-orchestrated and non-atomic as originally built — the same
  prepare/commit/abort upgrade above is a natural follow-up there, not done
  in this pass.

**Capability security is the proof.** Neither contract exposes a method that
pays the operator, holds a capability that drains it outside the rate, or
governs the rate at anything but deploy time. There is nothing to corrupt
because there is no ambient authority — `prepare`/`prepareReceive` never pay
out more than their own reserve, the same check `swap` already makes, so a
bad-faith trader can at worst strand one leg (bounded by `expiryBlock`, never
a loss to the pool). The joint-ZFA-closure reading — one closure spanning
both legs (`crates/zfa-core/src/coupling.rs` `coupled`) — is a *check* a
contract can run with `rho:qucalc:verify`, which rnode already exposes, not a
prerequisite; for the pooled exchange the preimage-reveal-style single
triggering event is now the `commit` pair itself, not a post-hoc monitor.
rholo already carries the QLF primitives, so the escrow lives there.

### Wrapped native tokens — the platform token, without touching `revVault`

"Any token to any token" includes a shard's own native token (REV, or any
chain's base token) — but the hard constraint stands: **the exchange never
touches `revVault`.** A native token trades only as a **wrapped**
representation (`packages/browser/src/wrapped-token.js`) — a token contract
an issuer backs 1:1 with their own holdings, mint/burn-gated to that issuer
(mint/burn is fine — REV is the one token this constraint singles out).

- **`$wrap`** is the *only* macro in this design that touches `revVault`, and
  only because it is the issuer's own sanctioned deploy: `revVault!("transfer",
  …)` to the wrapper's recorded backing address, then `mint`, chained in one
  program. **`$unwrap`** is the holder's own `burn` (self-identified on-chain
  via `rho:rev:address "fromDeployerId"`, never a caller-supplied string, so
  nobody can name someone else's balance) — it records a permanent redemption
  claim. **`$wrelease`** is the issuer's separate step, honoring that claim:
  their own `revVault!("transfer", …)` to the holder, chained with marking the
  claim released. Two macros because they are two different parties' actions,
  possibly at different times.
- **Trust:** a wrapped token is worth par only if the issuer honors
  `$wrelease` — the same assumption as any `/note` currency. `$winfo` reports
  the issuer, backing address, base currency and supply, so anyone can
  `$balance(backingAddr)` and compare it against supply — public
  verifiability, not enforcement. If an issuer stiffs a redemption, the
  `claims` entry is permanent on-chain evidence for `/gov censure`;
  making the issuer a `/gov` group rather than a person is the mitigation for
  anything beyond small value. The machinery cannot force a `revVault`
  transfer — that is the honest cost of never touching it.
- **Fungibility:** `w<BASE>~<issuer8>` — non-fungible across issuers, the same
  shape as a terms-stamped note series (`notes.ts` `termsHash8`).
- **The full path**, native REV (shard A) → native FOO (shard B): `$wrap` on
  A (local, edge) → `$xprepare`/`$xreceive`/`$xcommit` across the linked pools
  (the atomic part) → `$unwrap` on B (local, edge). Verified end to end
  against localnet, including wrap → burn → release. See `ExchangeDemo.md`.

---

## Layer 2 — CapTP (the delegation layer)

CapTP ([Mark S. Miller](https://github.com/ocapn/ocapn); Agoric `@endo/captp`,
standardized as OCapN) earns its complexity only when the authority **is not
your own account**:

- **Revocable, attenuated proxies.** You export a capability as a *proxy* —
  someone else holds it, invokes it *on your behalf*, cannot escalate it to
  your full identity, and you can switch it off (#107). `$proxy(uri, methods)`
  → a `cap:` token the holder invokes; the on-shard forwarder checks it against
  your grant, not their identity.
- **Promise pipelining.** Send a message to the *result* of a cross-shard call
  before it resolves. A promise-proxy is returned immediately; further
  invocations queue against it.
- **Three-party handoff.** Introduce a party who has no pre-existing link, with
  a certificate the room's witnesses or a `/gov` decision issue.
- **Gateway routing.** A quantum-os peer that is a member of a coordination room
  and can deploy to a shard's rnode, for shard pairs with no link — and, via an
  oracle contract the agent carries, to non-RChain chains. The gateway signs
  the deploy, so `*deployerId` there is the *gateway*: the gateway path suits
  public / stateless capabilities and ones written to take an explicit,
  contract-verified caller.

Embedded in a deploy, the result comes back on a channel — **rholang's `for` is
the promise:**

```rholang
new price in {
  $at("shard-b", `rho:id:theOracle`)!("getPrice", "ETH", *price) |
  for (@p <- price) { … }
}
```

`$at(shard, uri)` expands, at the client, to a **remote signed deploy** whose
reply lands on `` `rho:rchain:deployId` `` (Layer 1 — the client listens on that
channel), or to **gateway-routing glue** (Layer 2 — a promise-proxy the client
machinery resolves). Same call site either way; the `for` above is the local
idiom the client presents over the channel listen.

Revocation binds only those who check: a peer offline for a `proxy-revoke` keeps
its stale view until it re-syncs; *revoked* is shown as distinct from *gone*.

---

## Phases

1. **Layer 1** — the client-side `$at` → remote signed deploy + reply-channel
   listen (rholo#33 / #34: `casper::shard_invoke`).
2. Exchange support — **done**: the pooled exchange's atomic two-phase-commit
   federation (`prepare`/`prepareReceive`/`commit`/`abort`/`stateOf`) and
   wrapped native tokens (`wrapped-token.js`, `$wrap`/`$unwrap`/`$wrelease`),
   both quantum-os-side and verified against localnet. The bilateral escrow
   (`qucalc/examples/shard_exchange.rho`, rholo#34) is unchanged —
   the same upgrade there is a follow-up, not required.
3. **Layer 2** — `$proxy` + the gateway peer + `captp-export` / `captp-invoke`
   / `captp-result` / `captp-revoke`; synchronous invocation.
4. Promise pipelining.
5. Three-party handoff + revocation (#107).
6. OCapN wire conformance — interop with Agoric / Spritely endpoints.

---

## Related

- [`ExchangeDemo.md`](ExchangeDemo.md) — end-user walkthrough of the pooled token exchange and its atomic `link`/`prepare`/`receive`/`commit`/`abort` cross-shard federation over Layer 1, plus wrapped native tokens.
- [`Room_Bridges.md`](Room_Bridges.md) — a peer in two rooms is the shared closure (the gateway is that, between a room and a shard).
- [`Governance.md`](Governance.md) — group ownership of a gateway; delegation- and trust-weighted decisions; censure.
- [quantum-os#173](https://github.com/rhovision-org/quantum-os/issues/173) (Layer 2) · [rholo#33](https://github.com/rhovision-org/rholo/issues/33) (Layer 1) · [#138](https://github.com/rhovision-org/quantum-os/issues/138) · [#107](https://github.com/rhovision-org/quantum-os/issues/107).
- [OCapN](https://github.com/ocapn/ocapn) · Agoric [`@endo/captp`](https://www.npmjs.com/package/@endo/captp).
