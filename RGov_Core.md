# rgov core — the three contracts

**Built and verified.** [`packages/browser/src/rgov-core.js`](packages/browser/src/rgov-core.js),
91/91 selftest in CI, 84/84 live on the playground, reachable from a room through `/gov chain`.
This is the design and the evidence for it, written after an audit established that most of what
rgov does on-chain either belongs to the node or belongs nowhere.

## Why only three

The core governance capabilities are **inbox send/receive, groups, issues, delegation, trust
metric**. Four of those five are already the node's, probed live on `rnodeapi.rhobot.net`:

| powerbox | bound? | what it is |
|---|---|---|
| `rho:gov:trustLevels` | **yes** | the trust metric — admin-rooted fixed point |
| `rho:gov:resolveWeights` | **yes** | delegation, resolved transitively |
| `rho:gov:tally` | **yes** | weighted approval / ranked-choice counting |
| `rho:gov:censure` | **yes** | ⅔-quorum accountability with voucher slashing |
| `rho:gov:delegate` · `:inbox` · `:group` · `:issue` | no | — |

So delegation is **not a contract**: it is a *record* (who delegates to whom) plus a function the
node already computes over it. The same is true of trust, tallying and censure. What is left to
build is **durable state**, and there are exactly three kinds of it:

1. **Inbox** — the capability vault. Messages carry authority, so this is the security-critical one.
2. **Group** — membership, roles, delegations, ratings, censures.
3. **Issue** — proposals, options, ballots, status.

The resulting shape: **state in contracts, computation native, naming in the genesis directory.**

**The semantics are already specified and in production off-chain.**
[`packages/browser/src/gov.ts`](packages/browser/src/gov.ts) implements them for the room
(`Member`, `Delegation`, `Issue`, `resolveWeights`, `trustLevels`, `trustWeightsFor`,
`TRUST_MAX = 5`). The on-chain core matches **those** shapes — not rgov's 2021 versions, of which
10 of 28 client actions answer at all and six do not parse.

## The one interface rule

> **Every verb on a read facet is named after the argument of the native it feeds.**

`Group.ratingsOf` returns exactly `trustLevels`' first argument. `Group.adminsOf` returns its
second. `Group.delegationsOf(g, issue)` returns `resolveWeights`' second, topic-over-global already
composed. `Issue.ballotsOf` returns `tally`'s first. A client does one read per parameter and one
native call, and **no governance policy lives in a contract** — which is what keeps policy
upgradable without a hard fork, since the natives are the node's and the contracts hold only facts.

## Three facets, not one

Every contract publishes three facets, and the split *is* the security model:

| facet | who holds it | what it may do |
|---|---|---|
| **`read`** | everyone | never mutates; never returns a capability or a message body |
| **`self`** | everyone | mutates **only the caller's own row** |
| **`admin`** | the installer | migration (`dump`/`load`) only, and identity-gated |

**Privilege inside a group is data, not a facet** — a correction the build forced. An earlier
draft put `invite`, `setRole`, `enroll`, `lock` and `close` behind `admin`. That is wrong: it would
make whoever *deployed the contract* an admin of every group inside it. They live on `self` and
check the group's own `admins` set, or the issue's own opener. What is left for `admin` is
migration, which really is the installer's business and nobody else's.

That in turn makes the facet map safe to publish whole: holding the `admin` bundle is not
sufficient, because `admin` re-derives the caller and compares against the installer's address.
The three are still three separable bundles — you can hand out `read` alone — but the security
does not depend on keeping one of them secret.

`self` is safe to publish because of the identity rule below: a caller cannot name a row that is
not theirs. That is what dissolves rgov's admin bottleneck — `delegate`, `rate`, `censure`, `join`,
`cast`, `send` and `receive` are all public verbs, and none of them needs an admin to have acted
first (requirement 5: onboarding works in both directions).

## Identity: derived, never claimed

rgov keys everything to a caller-supplied string, which is why its actions can be run on anyone's
behalf. Here, every mutating verb takes the caller's deployer id as its **first** parameter — as a
*name*, unquoted — and derives the caller's REV address inside the contract:

```rholang
contract doX(_id, @arg, ret) = {
  new aret in {
    revAddr!("fromDeployerId", *_id, *aret) |
    for (@me <- aret) { … }            // `me` is the row key. It was not supplied.
  }
}
```

The address is the public member id the natives' maps are keyed by; the deployer id is the
unforgeable part. This is `wrapped-token.js`'s own spelling, the rule it relies on for `burn` and
`transfer` ("self-identified on-chain via `rho:rev:address "fromDeployerId"`, never a
caller-supplied string").

### Verified live (2026-09-23, `rnodeapi.rhobot.net`)

A `deriver` contract doing exactly the above was installed by **alice** with `insertArbitrary`, then
called from separate signed deploys:

| | result |
|---|---|
| alice calls it | her own address; equal to the address derived in her own program |
| **bob calls alice's deployed contract** | **bob's address** — the contract sees the *caller*, not the installer |
| alice passes bob's public key as bytes where the deployer id belongs | **`Nil`** |
| alice passes a plain string | **`Nil`** |

The middle row is the property the whole `self` facet rests on, and it holds across deploys and
across identities. Forgery is not expressible: the powerbox will not derive an address from
anything that is not a real deployer id.

### …but it answers `Nil` rather than failing

Both forgery attempts returned `Nil` — **no error, no refusal, just `Nil`** (law 38 again: the node
does not tell you that a thing did not work). A contract that skips the check would happily write a
row keyed `Nil`, and that row would be reachable by *anyone* who can produce a `Nil`. So:

> **Every verb guards the derived address before it touches state.**
> `match me { Nil => { state!(s) | ret!(("gov-error", "no identity")) } _ => { … } }`

That guard is not defensive decoration; it is the difference between "a caller cannot name another's
row" and "there is one shared row anybody can write". It belongs in the `--selftest` and in
`rgov-core-check` as a negative scenario, not just in review — both of which it now is.

## State: one cell, consumed and restored

```rholang
state!({}) | … contract doX(…) = { for (@s <- state) { state!(s') | ret!(…) } }
```

One cell per contract, `for (@s <- state) { state!(…) }` — never a peek, never a second send onto
the same channel. This is not a style preference: the audit's worst finding was that
`@[*deployerId, "MasterContractAdmin"]!({…})` is a **linear send**, so every bootstrap run left
another directory on that channel and every consumer peeked an arbitrary one. Two values consumed
off it compared **unequal** — two live directories, nothing erroring anywhere. A single consumed-and-
restored cell cannot accumulate, and every write serialises against every other.

Every creating verb is **idempotent** and says which happened (`"created"` / `"already"`), so a
re-run repairs rather than doubling.

---

## 1. Inbox — the capability vault

rgov's inbox is "a rholang par, unordered": one undifferentiated pile per identity, scanned in full
on every read, holding capabilities. Two consequences — read cost that grows with history and never
falls, and a read cap that, once leaked, leaks *everything you were ever sent*.

**A set of named lockers instead**, using the `lockerTag` seam rgov already has but never populates:

```
boxes: { <ownerAddr>: { <lockerTag>: { "policy": "open"|"invite", "msgs": [ msg, … ] } } }
msg  : { "from": <addr>, "type": <str>, "subtype": <str>, "at": <int>, "body": <proc> }
```

`body` may be a `bundle+` name — that is the point of the thing.

| facet | verb | notes |
|---|---|---|
| `self` | `newLocker(deployerId, tag, policy, ret)` | idempotent; `"created"` / `"already"` |
| `self` | `send(deployerId, toAddr, tag, msg, ret)` | `from` is **derived**, never taken from `msg`; refused if the locker's policy is `invite` and the sender holds no send cap |
| `self` | `receive(deployerId, tag, ret)` | **consumes** — returns the locker's messages and empties it. The authority-bearing read |
| `self` | `take(deployerId, tag, type, subtype, ret)` | consumes only the matching messages |
| `self` | `grantRead(deployerId, tag, ret)` | a read-only facet bound to **one** locker |
| `self` | `grantSend(deployerId, tag, ret)` | an append-only facet bound to **one** locker |
| `read` | `lockersOf(addr, ret)` | tag names and message **counts** only |
| `read` | `countIn(addr, tag, type, ret)` | counts only |
| `admin` | `version` only | **no whole-contract dump**: it returned message bodies |
| `self` | `export()` · `import(lockers)` | migration, per identity, in one term |
| `self` | `history(query, cursor, limit)` | **Inbox/4.** What `receive`/`take` handed over, newest first, paged (≤ 50 per call); `query` is any of `{from, type, title}` |
| `self` | `forget(seqs)` | **Inbox/4.** Delete history entries |
| `self` | `exportHistory()` · `importHistory(h)` | **Inbox/4.** History migrates with the lockers, in the same term (`migrateLockersProgram`) |

### History (Inbox/4, quantum-os#241)

`receive` and `take` still hand messages over and empty the locker, so a capability is still
delivered once. They also append each message to the owner's **history**, so a person's record of
what they were sent follows their key to any device instead of living in one browser.

- **Who can read it: the owner, by signed deploy.** `history` is on the `self` facet, so the
  contract answers only the caller's own history, and each page is one signed deploy (a fee and a
  block). It is not on the `read` facet. That decides what the **contract** answers, not what a node
  operator can see: bodies sit in chain state unencrypted, as they always have until collected.
- **Capabilities are not kept.** An entry keeps the message's string, integer and boolean fields
  and drops anything else, so history is a record of what was said, not a second copy of the
  authority.
- **Cost does not leak between people.** Each owner's history is its own cell, `@(*hist, owner)`,
  consumed and restored, so one person's long history never makes anybody else's send or receive
  cost more. Filters by sender and by type start from per-owner indexes (`byFrom`, `byType`), so
  finding one sender's messages does not scan the rest. A title filter is a case-sensitive substring
  of the message's `subject`, scanned over the candidates.
- **Bounded.** A page answers at most 50 entries; each owner keeps the newest 500, and `forget`
  deletes entries. A cursor is a `seq`: the next page is the entries below it, and a `Nil` cursor
  (absent from the decoded tuple) means there is no next page.

```
history : { "seq": n, "order": [seq, …], "entries": { seq: {"seq", "from", "type", "title", "msg"} },
            "byFrom": { addr: [seq, …] }, "byType": { type: [seq, …] } }
```

**The public `read` facet never returns a message body.** Metadata is public; contents require a
per-locker cap. That is requirement 2 (reporting without write authority) and requirement 4 (blast
radius) answered by the same mechanism — and it is `Directory.rho`'s own `grant` pattern, one key at
a time, applied per locker:

```rholang
contract doGrantRead(_id, @tag, ret) = {
  new a in {
    revAddr!("fromDeployerId", *_id, *a) |
    for (@me <- a) {
      match me {
        Nil => { ret!(("gov-error", "no identity")) }
        _   => {
          new readOne in {
            contract readOne(@_unused, r2) = {
              for (@s <- state) {
                state!(s) |
                r2!(s.getOrElse(me, {}).getOrElse(tag, {}).getOrElse("msgs", []))
              }
            } |
            ret!(bundle+{*readOne})
          }
        }
      }
    }
  }
}
```

(The `@_unused` first parameter is the ≥2-params rule from `locker.js` — a one-binder persistent
receive in a nested `new` was rholo#19. That is **closed and verified fixed**, but the shape
costs nothing and the whole corpus is written this way.)

`peek` is deliberately **not** a public verb. Peek-vs-consume is a security distinction here, not an
ergonomic one: a non-consuming read of a locker full of capabilities is the strictly more dangerous
operation, so it is the one that requires a cap.

## 2. Group — the state the natives read

```
groups: { <groupId>: {
  "name": <str>, "createdAt": <int>,
  "admins":  Set(<addr>, …),
  "members": { <addr>: {"role": "admin"|"member", "label": <str>, "at": <int>} },
  "deleg":   { <addr>: <addr> },                       // standing
  "topic":   { <issueId>: { <addr>: <addr> } },        // per-issue override
  "ratings": { <rater>: { <ratee>: <0..5> } },
  "censures":{ <censurer>: { <target>: 1 } },
  "policy":  "open" | "invite"
} }
```

| facet | verb | notes |
|---|---|---|
| `self` | `create(deployerId, groupId, name, policy, ret)` | caller is sole admin; idempotent |
| `self` | `join(deployerId, groupId, label, ret)` | the **pull** path. `open` → member; `invite` → `"pending"` |
| `self` | `delegate(deployerId, groupId, toAddr, issueId, ret)` | own row only; `issueId` `Nil` = standing |
| `self` | `rate(deployerId, groupId, rateeAddr, level, ret)` | own row only; stored **raw** |
| `self` | `censure(deployerId, groupId, targetAddr, on, ret)` | own row only |
| `admin` | `invite(deployerId, groupId, addr, ret)` | the **push** path — returns a one-shot `acceptOne` cap for the inbox |
| `admin` | `uninvite(deployerId, groupId, addr, ret)` | withdraw an invitation not yet taken up — the mirror of `invite`, as `uncensure` mirrors `censure` ([#246](https://github.com/rhovision-org/quantum-os/issues/246)) |
| `admin` | `setRole(deployerId, groupId, addr, role, ret)` | refuses to demote the **last admin** — a group with none can never invite or promote again ([rhogov#75](https://github.com/rhovision-org/rhogov/issues/75)) |
| `self` | `leave(deployerId, groupId, ret)` | the last admin cannot leave while other members remain; the last member always can |
| `read` | `ratingsOf(groupId, ret)` | → `trustLevels` arg 1 |
| `read` | `adminsOf(groupId, ret)` | → `trustLevels` arg 2 |
| `read` | `delegationsOf(groupId, issueId, ret)` | → `resolveWeights` arg 2, topic over standing |
| `read` | `censuresOf(groupId, ret)` · `vouchersOf(groupId, ret)` | → `censure` args 1 and 3 |
| `read` | `membersOf(groupId, ret)` · `roll(groupId, ret)` | |
| `admin` | `dump` / `load` / `version` | migration; `load` refuses a non-empty cell |

**Ratings are stored raw and capped by the node.** `gov.ts` caps a rating at the rater's own level
minus one, and `trustLevels` re-caps during aggregation — so a forged high rating is already
neutralised where the policy lives. Re-implementing the cap in the contract would put the same rule
in two places that can disagree across an upgrade. The contract's job is to record who said what.

**Both onboarding directions are first-class** (requirement 5). `join` needs no prior admin act;
`invite` needs no prior member act. Neither is a precondition of the other, and there is no
`MasterContractAdmin` anywhere — the group's admin set is ordinary state in the group's own row.

## 3. Issue — proposals and ballots

```
issues: { <issueId>: {
  "groupId": <str>, "title": <str>, "by": <addr>, "at": <int>,
  "status": "open"|"locked"|"closed",
  "mode": "approval"|"ranked",
  "groupRead": <proc>,                       // the Group read facet this issue trusts
  "options": [ <optionId>, … ],
  "ballots": { <addr>: [ <optionId>, … ] },
  "results": { <addr>: <result> }            // the opener's proposed tally, keyed by their address
} }
```

| facet | verb | notes |
|---|---|---|
| `self` | `open(deployerId, groupId, issueId, title, mode, options, groupRead, ret)` | idempotent |
| `self` | `addOption(deployerId, issueId, optionId, ret)` | while `open` |
| `self` | `cast(deployerId, issueId, choices, ret)` | membership checked through `groupRead`; latest ballot per voter wins |
| `self` | `propose(deployerId, issueId, result, ret)` | **opener only** — record the computed tally under the opener's name ([#245](https://github.com/rhovision-org/quantum-os/issues/245)) |
| `admin` | `enroll(deployerId, issueId, addr, ret)` | returns a `castOne` cap bound to (issue, voter) — for the inbox |
| `admin` | `lock` / `close(deployerId, issueId, ret)` | freeze options / freeze ballots |
| `read` | `ballotsOf(issueId, ret)` | → `tally` arg 1 |
| `read` | `votersOf` · `optionsOf` · `statusOf` · `issuesOf(groupId)` · `resultsOf` | |
| `admin` | `dump` / `load` / `version` | migration; `load` refuses a non-empty cell |

**No contract counts votes.** `tally` is the node's, deterministic over published ballots and
published weights, so anyone can recompute it. `propose` records the opener's claim about the
ballots, keyed by their address, and refuses anyone else: an ungated `propose` let any member post a
second "result" of the same shape, with nothing on chain saying which was the record (#245). The
ballots are the authoritative state; a reader who disagrees recomputes the tally from them rather
than writing a rival result. This is the same stance
`polls.ts` takes in the room ("deterministic and joiner-local — no central counter").

**`open` takes the Group read facet it trusts** and records it. That is one cross-contract edge,
deliberately chosen over an unchecked roll argument, and it is auditable: the facet an issue used is
part of the issue.

### The end-to-end path

```
Group.ratingsOf ─┐
Group.adminsOf  ─┴─▶ rho:gov:trustLevels ──▶ levels ─┐
Group.delegationsOf(g, issue) ───────────────────────┴─▶ rho:gov:resolveWeights ──▶ weights ─┐
Issue.ballotsOf ─────────────────────────────────────────────────────────────────────────────┴─▶ rho:gov:tally ──▶ winner
Group.censuresOf + levels + Group.vouchersOf ──▶ rho:gov:censure ──▶ (discredited, newLevels)
```

Five reads, four native calls, and `Issue.propose` to publish the result. `Inbox` carries the
`acceptOne` and `castOne` caps that make enrollment work without anyone holding an admin facet they
did not earn.

---

## Naming, addressing, migration

**The design wants names. The node does not currently allow them.** This section records what was
measured on 2026-09-23, because the gap matters more than the intention.

What works: `PORT_READ_CAP` **is the master directory's `read` facet**, and its two-argument form
resolves a single name — `read("Inbox", ret)` answers a live capability. So a client really can hold
one public constant and ask for a name, which is the whole point of the design.

What does not: **that map is genesis content and nothing can be added to it.** Only `read` is
published; the master's `write` and `grant` are held by whoever built genesis and are reachable from
nowhere. So a deployed contract cannot be registered under a name by its installer.

### `Directory` is a factory, not a directory

The `Directory` entry in the genesis map is `bundle+{*directory}`, and
[`Directory.rho`](https://github.com/rhovision-org/rholo/blob/dev/casper/src/genesis/resources/rgov/Directory.rho)
opens a fresh `new mapCh, read, write, grant in { mapCh!({}) … }` on **every call**. So calling it
mints a brand-new empty directory with its own `{read, write, grant}`.

That is easy to misread as an unrestricted global registry, and it was misread here: granting a key
and writing to it succeeds, reports `"added"`, and changes nothing anybody else can see. Measured
directly — write into instance A, read the same key from instance B: `Nil`. The write went into a
throwaway. **There is no open write path to the shared namespace; there is no write path at all.**

A group *can* mint its own directory, and `directory(ParentReadCap, capabilities)` chains reads to a
parent, which is clearly the intended shape for a namespace. But the new directory's `read` cap is
an unforgeable, and an unforgeable has no source syntax — it cannot be written down in a room,
stored, and resolved again next week. Publishing it means `insertArbitrary`, which mints a uri.

### So, uris — for now, and under protest

`/gov chain` records one uri per contract. That is the rgov failure mode this audit set out to
remove: an address that must be handed around out of band, with no migration path. It is what the
node currently permits.

**The redesign is written up in [MasterDictionary.md](MasterDictionary.md)** — names rooted in the
identity that owns them (`<revAddr>/<path>`), so publishing is self-service and squatting is not
expressible; short names as a governed tier of aliases; versions with pinning and freezing; and
per-name grants that can be *revoked*. It also records a measurement that makes the case: `Directory`,
`Echo` and `Log` in the genesis map are **the same unforgeable** — one stateless factory under three
names — so the current dictionary stores nothing at all, and there is no state to migrate.

**What the node owes this design**, and the one upstream ask that unblocks it: a *restricted* grant
on the master directory — per-name authority, so a name's owner can write it and nobody else can.
With that, registration replaces every uri here, upgrading becomes "deploy v2, `dump`, `load`,
re-point the name", and requirement 3's migration story falls out. `rho:gov:directory` as a
powerbox name would do the same job.

Until then a client that wants a stable address has one other option worth noting: `insertSigned`,
whose uri is **derived from a public key** and so is computable rather than communicated. It is one
slot per key, and it collides with the slot a deploy's answer goes to (see `locker.js`), so it is
not free — but it is the difference between an address you can derive and one you must be told.

## The one rule a caller must follow

A deployer id is **unforgeable but delegable by disclosure** — a key, not a
signature. A contract that stores `*deployerId` where a reader can reach it hands
its identity to whoever reads it, and that holder can then act as that identity
anywhere, including here. Demonstrated end to end on the playground; the rule and
the evidence are in [SECURITY.md](SECURITY.md#rhorchaindeployerid-is-a-key-not-a-signature).

These contracts never disclose one — every use of the caller's id is the address
derivation and nothing else, asserted in `--selftest` so a future verb that
stashed one fails CI.

## What is deliberately absent

- **No `MasterContractAdmin`.** The linear send that silently accumulated a second directory.
- **No bootstrapper-keyed dictionary.** rgov keys everything to the bootstrapper's `deployerId`, so
  no member can onboard without them.
- **No per-class registration through a shared admin channel.** Per-name `grant` instead.
- **No policy in the contracts.** Caps, quorums, weights and tie-breaks are the natives'.
- **No chat, kudos, ballot, mint or crowdfund.** Later, registered by name — which is exactly what
  the directory design makes cheap.

## Built and verified (2026-09-23)

[`packages/browser/src/rgov-core.js`](packages/browser/src/rgov-core.js) — the three contract
sources, their install programs and every call-site builder, plain JS in the `locker.js` /
`wrapped-token.js` shape. `node packages/browser/src/rgov-core.js --selftest` is **91/91** and runs
in CI. The live half, `scripts/localnet/rgov-core-check.mjs`, installed all three on
`rnodeapi.rhobot.net` and walked a scenario: **84 ok, 0 failed** across 3 identities.

What that run actually established, beyond "it parses":

| | |
|---|---|
| `newLocker` twice | `("created", …)` then `("already", …)` — idempotent |
| bob sends to alice's locker | `from` is **bob's derived address**, not what he put in the message |
| public `read` asked for a body (`peek`) | `("gov-error", "bad verb or arity", "peek")` — there is no such verb |
| `receive` | returns the message *and empties the locker*; the count goes 1 → 0 |
| bob calls `setRole` | `("gov-error", "not an admin")` — privilege is the group's data |
| `rate` with one argument instead of three | **`("gov-error", "bad verb or arity", "rate")`** — not silence |
| a granted read cap | answers that locker's bodies, and reaches no other locker |
| a granted send cap, **delivered through the Inbox** and used by the recipient | wrote into alice's invite-only locker |
| `enroll`'s bearer ballot | cast under **the guest's** address, not the enroller's |
| bob calls `admin` | `("gov-error", "not the installer")` |
| `load` over live state | `("gov-error", "not empty")` |
| a first send to an identity that has **never acted** | `("sent", …, "locker created")` — the push half of onboarding does not need the pull half |
| a first send to a **non-default** tag | `("gov-error", "no such locker", …)` — only `inbox` is auto-created |
| the opener refreshes an issue's roll; a non-opener tries | `("roll", iid, 3)` / `("gov-error", "not the opener")` |
| `ratingsOf` → `trustLevels` → `resolveWeights` → `tally` → `censure` | `{alice: 5, bob: 3}` → `{bob: 4}` → `"yes"` |

That last row is the design working end to end, and the weights confirm the contracts match
`gov.ts` rather than rgov: alice is 5 by the admin root, bob is 3 because a rating is capped below
the rater's level, and bob's voting weight is **4 = 1 + level**, which is `trustWeightsFor`.

### One thing the build found in shipped code

`rho:registry:lookup` on this node answers **the bare stored value**: `rec.keys().toList()` gives
`["admin","read","self"]` and matching it against `(_, caps)` reports "not a tuple".
[`locker.js`](packages/browser/src/locker.js) unwraps a `(_, caps)` tuple — the Scala shape — and
falls to its own default branch, so a locker call there would report `["no locker at", uri]` for a
locker that is present and healthy. `rgov-core.js` accepts either shape and funnels both into one
channel. Whether locker.js broke with a registry change or was never exercised this way is not
established here; it is worth a look before anyone relies on `/rholang register|bind|resolve`.

## Build order

1. ~~**Probe** `rho:rev:address("fromDeployerId", …)` on a passed-through deployer id.~~ **Done —
   it holds** (see *Verified live* above), with the `Nil` guard as the one amendment it forced.
2. ~~**`packages/browser/src/rgov-core.js`**~~ **Done** — 91/91 selftest, in CI.
3. ~~**Deploy to the playground**~~ **Done** — `scripts/localnet/rgov-core-check.mjs`, 28/28 live.
   Every verb is now covered, including the capability-delivery path end to end and the negatives.
4. ~~**Wire `/gov`**~~ **Done** — `/gov chain` (`install` · `push` · `pull` · `inbox|group|issue
   <uri>`), carried between peers on the existing `group-meta` envelope, plus a self-signed
   `gov-chain` envelope for a member's own REV address. See
   [Governance.md § The group on chain](Governance.md#the-group-on-chain--gov-chain).

   Two things that fell out of wiring it, both of which the design implies rather than adds:
   - **A push is per-member.** `delegate`/`rate`/`censure` are `self` verbs, so an admin *cannot*
     push a member's rows and a member needs no admin to push their own.
   - **A member must publish a chain address first.** The contracts key rows by REV address; a room
     knows peerIds and anchors. `Member.revAddr` carries it, self-signed, and a push skips — out
     loud — any row whose target has not published one rather than guessing at a vote's destination.
5. **Register the three by name** in the genesis directory, which is what makes step 4 a constant
   rather than three uris to distribute.

## Provenance

The audit that produced this: `scripts/localnet/rgov-check.mjs` (two tiers, live against
`rnodeapi.rhobot.net`) and `scripts/localnet/macro-check.mjs` (14 ok, 0 failed, 6 skipped — all four
`rho:gov:*` natives confirmed with `gov.ts`-shaped arguments). The genesis decision — genesis carries
the directory and its admission policy, nothing else of rgov — is posted upstream as
[rholo#71](https://github.com/rhovision-org/rholo/issues/71). The node behaviours
this design steers around are laws 38 and 40 in
[`porting-a-client.md`](https://github.com/rhovision-org/rholo/blob/dev/docs/src/developer/porting-a-client.md):
a `for` that matches no datum reports no error, and a call at the wrong arity does nothing.

Off-chain semantics: [Governance.md](Governance.md) · [`gov.ts`](packages/browser/src/gov.ts).
