# Governance — liquid democracy on [quantum-os](README.md)

A governance layer that exposes the functionality of RChain's
[rgov](https://github.com/rhovision-org/rgov) — groups, members, issues,
delegated voting — using quantum-os's own primitives, rather than running rgov's
`.rho` contracts. The centerpiece is **delegated (liquid) democracy**: members
delegate their vote, delegation flows transitively, and a non-voter's weight is
cast by their delegate.

This is the same ZFA substrate as everything else: dyncap-signed envelopes plus a
**deterministic, joiner-local tally** (every peer resolves the same delegation
graph from the signed delegations + ballots it holds — no central counter). See
[`Group_Decisions.md`](Group_Decisions.md) for the broader family of decision
processes and [`Group_Decisions_Demo.md`](https://github.com/rhovision-org/quantum-logical-framework/blob/main/Group_Decisions_Demo.md)
for a worked multi-peer walkthrough.

Membership, delegation, trust, censure, and vote tallying are all **off-chain**
— a group and its liquid-democracy graph exist entirely as signed state its own
peers hold and replicate, so who trusts whom and who delegated to whom is never
public ledger data. Treasury and kudos ride `/note` (also off-chain, bearer
tokens). A chain is optional and always additive: `/gov uri`/`/gov locker`
*record* (never derive) a URI or directory the group separately chose to deploy
to, and **`/gov chain`** mirrors a group onto the three governance contracts —
pointers and records a group can add later, never a prerequisite for governing.

---

## Design philosophy — RGOV as a liquid-trust network

The intent ported here predates rgov: it is the **RGOV liquid-trust network
governance** model from [Whitescarver, *Collective Intelligence Best
Practices*](https://docs.google.com/presentation/d/1qFK10rFcCiBO72aeSFIfII0e1TeIXDKgZqwVlP-wREk/edit)
(orig. RChain Governance Forum, 2018). Its principles are what `/gov` is *for*,
not just what it does — an **anti-fragile sociocratic polyarchy**: maximal
distribution of power with effective global coordination, representing **all**
stakeholders through interlinked autonomous teams.

| RGOV principle | How quantum-os realizes it |
|---|---|
| **Liquid democracy** (affirmative trust delegation) | `/gov delegate` — standing, transitive, revocable; direct vote overrides |
| **Self-governance by peer-to-peer agreements** | dyncap-signed envelopes; each group sets its own roster, delegates, currencies — no central authority |
| **Exchange of capabilities (property)** | unforgeable capability tokens (`/cap`/`/grant`), `/note` currencies (treasury, kudos) |
| **Asset pools** — budgets, crowdfunds, staking | `/gov treasury`; *"budgets awarded to teams divided how they decide"* = sub-group autonomy |
| **Chat channels distributing communications & capabilities** | `/channel`, `/gov say` (membership-scoped) |
| **User-programmed — save and share actions** | the [RhoQuCalc macros](RhoQuCalc_Macros.md): name = quoted process = shareable capability |
| **Purposeful transparency + privacy** | public signed decisions of record; bearer-private balances; pseudonymous peers |

**Liquid *trust*, not only liquid democracy (shipped).** The RGOV vision weights
alternatives by **voter trust ratings** alongside delegation — affirmative trust,
not just vote-flow. `/gov trust <member> <0–5>` lets each member confer a trust
**level** on another, and a member's **base voting weight** becomes `1 + their
trust level` instead of a flat `1`; that weighted vote then flows through the
*same* delegation resolver. The defining rule (per Jim): **you can only confer a
level strictly below your own.** Admins are the trust root (level `5`); trust
descends hop-by-hop, strictly decreasing, so two untrusted members cannot bootstrap
each other — the hierarchy, not just admin gating, is the Sybil boundary. And
because **vouching is a stake** (a **⅔ quorum** of eligible peers can `/gov
censure` a member who holds undeserved trust, discrediting them and *slashing
everyone who vouched for them* — no single member, admin included, acts alone),
the web self-corrects — there is accountability for conferring trust carelessly.
With no
ratings the base is `1` for everyone, reproducing equal-weight liquid democracy
exactly — so trust weighting is opt-in and backward-compatible. The room-side
complement — *who* should be in the room and how it closes well — is
[`Room_Best_Practices.md`](Room_Best_Practices.md), grounded in the same talk's
collective-intelligence findings.

---

## Why not run the `.rho` directly?

> **The on-chain half is now built.** A 2026-09 audit of rgov's rholang found that four of the five
> core governance capabilities — trust, delegation, tallying, censure — are already node powerbox
> natives (`rho:gov:*`), leaving three contracts that hold nothing but durable state: **Inbox,
> Group, Issue**. They are in [`rgov-core.js`](packages/browser/src/rgov-core.js), verified live, and
> reachable from a room through **`/gov chain`** (below). They match the shapes on *this* page, not
> rgov's 2021 ones. Design and evidence: **[RGov_Core.md](RGov_Core.md)**.
>
> Everything else on this page still runs off-chain and needs no node. The chain is where a group
> records what it decided, not where it decides.

rgov uses full RChain Rholang — persistent `contract`s, the RSpace tuplespace with
`for`/COMM matching, pattern destructuring, the registry, `rho:` system processes
(`registry`, `deployId`, `deployerId`, RevVault), and signed, phlogiston-metered
deploys ordered by Casper consensus. quantum-os has none of that machinery (its
"RhoQu" is a macro transpiler, `/channel` is fire-and-forget, there's no
tuplespace or global consensus). Literally executing the contracts would mean
embedding a Rholang interpreter or deploying to a real RNode.

Instead we port the **intent**. rgov's governance behavior maps cleanly onto
primitives quantum-os already has:

| rgov | quantum-os |
|---|---|
| `Group` / `WorkingGroup` / `addMember` / `MemberDirectory` | a group record + membership capabilities; `/gov member` |
| `Issue` / `newIssue` | an issue record per group (`/gov issue`) |
| `Ballot` / `castBallot` / `castVote` / `tallyVotes` | `/poll` (approval + ranked-choice IRV), opened via `/gov vote` |
| **`delegateVote`** | **`/gov delegate`** — standing, revocable, transitive delegation (global or per-issue) |
| `RevIssuer` / `makeMint` / `transfer` / `checkBalance` | **`/gov treasury`** — a per-group `/note` currency (declare/grant/balance) |
| `Kudos` / `awardKudos` | **`/gov kudos`** — a per-group `/note` reputation currency |
| `Inbox` / `Chat` / `sendMail` | **`/gov say`** — a membership-scoped `group-msg` (only fellow members see it) |
| `deployerId` identity | `/dyncap` anchor |
| registry lookup / durable link | `/lemma` + the memory-peer daemon |

---

## Liquid democracy — the governing rule

**Per issue:** if a member casts a ballot, their own vote counts (it **overrides**
delegation). If they do **not** vote, their vote is cast by their **delegate** —
transitively: it flows to whoever their delegate's delegate … ultimately voted.
Each member has one standing delegate; direct voting always overrides for that
issue. A chain that reaches no direct voter, or loops, **abstains**.

**Resolution** (pure, in `gov.ts` `resolveWeights`, recomputed by every peer):
- `directVoters` = members who cast a ballot on the issue's poll.
- Each member's vote walks the delegation chain to the first direct voter reached
  (its weight flows there); cycles / dead-ends with no direct voter abstain.
- `weight(d) = Σ baseWeight(m)` over members `m` whose chain terminates at `d`,
  where `baseWeight(m) = 1 + trustLevel(m)` (`gov.ts` `trustWeightsFor`; flat `1`
  when there are no ratings, so this reduces to `1 + #delegators`).
- The weighted counts feed the existing approval / IRV poll engine (`tally(poll,
  weights)`), so votes are *ranked-choice*, *delegation-weighted*, **and
  trust-weighted**, with the same deterministic tie-breaks.

**Trust levels** (`gov.ts` `trustLevels`) are a **hierarchical web of trust rooted
at the admins** (`level = 5`). A rating `v` from rater `r` confers
`min(v, level(r) − 1)` on the ratee — **strictly below the rater's own level** —
and a member's level is the highest conferred on them, computed as a deterministic
least fixed point (a monotone relaxation every peer reproduces from the signed
`gov-trust` envelopes it holds). Ratings are self-signed (you set only your own
outgoing ratings, like delegation); self-ratings and non-member ratings are ignored.

Because each hop *strictly decreases*, **two untrusted members cannot bootstrap
each other** — a level-0 member can confer nothing, and a colluding clique can
never lift itself above the level an admin actually conferred on it. Trust must
descend from an admin; the hierarchy itself is the Sybil boundary, not merely
admin-gated membership. Enforcement lives in the aggregation (the conferral cap is
re-applied on every recompute), so a forged high rating from a low-level peer is
automatically capped — the `/gov trust` command's cap is only the UX hint.

### Accountability — vouching is a stake

Conferring trust is not free: **you are accountable for assigning undeserved
trust.** `/gov censure <member>` flags a member as holding trust they don't
deserve. The **eligible censurers** of `m` are the members whose current standing
≥ `m`'s (you can call out a peer or subordinate, not someone above you — symmetric
to "confer only below your own level"). `m` is **discredited** when a **quorum of
that eligible body — a ⅔ supermajority, floored at 2 — has censured them**
(reusing the ⅔-supermajority precedent of [`Consensus.md`](Consensus.md)). On
discredit, `m`'s level → 0 **and every member who vouched for `m` is slashed by
the level they staked** on them (`gov.ts` `trustLevels`, phase 2 — a decreasing
fixed point, so slashing a voucher can cascade and still converge). So a steward
who hands out trust carelessly loses their own standing when those endorsements go
bad — the web of trust self-corrects.

The quorum is the point: **no single member can discredit anyone — not even an
admin.** A lone admin's censure is one vote short of the floor of 2; and because a
disagreeing admin is counted in the eligible *body* (the quorum denominator) but
not in the censuring *set*, **a quorum of the others discredits over that admin's
objection** — admin opinion carries no veto and no unilateral power here. Censures
are self-signed (`gov-censure`), so a member below `m`'s standing can record one
but it is not counted toward the quorum.

Example: members A, B, C; B delegates A; C delegates B. If only **A** votes, A
carries weight **3** (self + B + C transitively). If **C** then votes directly, C
reclaims weight 1 and A drops to 2 (self + B). A delegation cycle with no direct
voter abstains.

---

## `/gov` command reference

`/gov` subcommands act on the **focused group** (set by `/gov new`/`show`, by
clicking it in the Governance sidebar, or implicitly when there's only one group).

| Command | Effect |
|---|---|
| `/gov new <name>` | Create a group (you become admin); focus + show its card |
| `/gov claim` | Re-attach an **orphaned** group to this identity. A peerId is per-tab and can change; a member record written before anchors were stamped carries no durable identity, so a creator whose peerId moved could lose admin of their own group with no way back. Gated on the group having **at most one member** — not a permission check but a situation in which the question does not arise: either the sole record is this identity under an old peerId, or the group is empty, and there is nobody a claim could take anything from. A group with two members is somebody else's to grant, and `member add` is how they grant it |
| `/gov show <name>` · `/gov list` | Focus + render a group / list all groups |
| `/gov member add <peer> [admin]` · `member remove <peer>` | Manage roster (admin only); membership is capability-backed |
| `/gov issue <title>` · `/gov issue list` | Record / list issues to decide. Each issue gets its own **issue card** (title, group, weighted result, open-vote/vote) that persists in the transcript and replays on reload, like a poll card |
| `/gov delegate <member> [on <issue>]` · `/gov undelegate [on <issue>]` | Set / clear your **standing delegate**, or a **per-issue** delegate that overrides it for one issue |
| `/gov trust <member> <0–5>` | Set / clear (`0`) your **affirmative trust rating** of a member; confers a level **below your own**, raising their base voting weight (liquid *trust*). Self-signed |
| `/gov censure <member>` · `/gov uncensure <member>` | Flag / unflag a member for **undeserved trust**; a **⅔ quorum** of eligible censurers (min 2, even over an admin) discredits them and **slashes their vouchers** (accountability). Self-signed |
| `/gov vote <issue> \| opt1, opt2 [ranked]` | Open a poll bound to the issue (find-or-create the issue) |
| `/gov treasury declare \| grant <member> <n> \| balance` | Group funds — a per-group `/note` currency (admin declares + funds; balances are bearer-private) |
| `/gov kudos <member> <n> \| balance` | Award reputation — a per-group kudos `/note` currency (admin issues; members re-gift what they hold) |
| `/gov say <message>` | Post to the group's inbox — a `group-msg` only fellow members see |
| `/gov status` | Group overview: members, delegations, issue results |
| `/forget group <name>` | Disband (creator) / hide (others) — tombstoned, dyncap-signed |

The **group card** (sidebar → click) shows members with roles and their delegate,
each member's **trust weight** `[wt N]` and a `⚠` on any discredited member, a
"your vote flows to … unless you vote" note, each issue's **weighted** leader/
winner, and per-member controls — **delegate**, a **trust** dropdown (confer a
level 0…*below your own*), and a **censure** toggle — plus buttons to open a vote,
vote, add a member / issue, set up treasury, or disband.

Wire envelopes (all dyncap-signed, synced on join via `sync-gov`, tombstone-aware):
`group-open`, `group-member` (admin-gated), `group-issue`, `group-vote`,
`gov-delegate`, `gov-trust`, `gov-censure` (all self-signed — only you set
your own delegate / trust ratings / censures), and `gov-vault` (a member's
password-encrypted identity for `/login <handle>` recovery — self-signed,
first-write-wins by handle; see [Security](SECURITY.md)). Votes themselves are
plain `/poll` envelopes. The headless memory daemon persists `group-*` and the
member `anchor` / `vaults` fields, so membership and recovery survive when every
browser leaves.

---

## Worked exemplar — rgov `delegateVote.rho` + `castVote.rho` + `tallyVotes.rho`

rgov: a member sends `delegateVote` to point their vote at another member; voting
on an issue casts directly; `tallyVotes` walks delegations to total the result.
The quantum-os equivalent over a P2P room (cast: A admin, B, C, D):

```
A> /gov new Stewards
·  🏛 created group "Stewards" — you are admin.
A> /gov member add Bob          ·  /gov member add Carol     ·  /gov member add Dave
A> /gov issue Adopt the new logo
B> /gov delegate Alice          ·  (B's vote will flow to Alice unless B votes)
C> /gov delegate Bob            ·  (C → Bob → Alice, transitively)
A> /gov vote Adopt the new logo | keep, replace ranked
·  🗳 vote opened on "Adopt the new logo" (ranked)
A> /poll vote keep              ·  Alice votes directly
D> /poll vote replace           ·  Dave votes directly; B and C have not voted
A> /gov status
·  ▸ Adopt the new logo — leading: keep · 4 weight
·    (Alice carries 3 = self + Bob + Carol delegated; Dave carries 1)
C> /poll vote replace            ·  Carol overrides her delegation for this issue
A> /gov status
·  ▸ Adopt the new logo — tie/▸ leading reflects Alice 2 (self + Bob), Dave+Carol 2
```

`tallyVotes` is the deterministic `resolveWeights` + weighted IRV: no contract
deploy, no consensus round — every peer computes the same result from the signed
delegations and ballots. Overriding is just voting; delegation is revocable with
`/gov undelegate`.

---

## The group on chain — `/gov chain`

Optional, additive, and off by default. A room decides; the chain is where a group *records* what
it decided, for the readers who were not in the room and the browsers that have all since closed.

The contracts are [`rgov-core.js`](packages/browser/src/rgov-core.js) — **Inbox, Group, Issue** —
and they hold state and nothing else. The trust metric, delegation resolution, tallying and censure
are node natives (`rho:gov:*`) that compute over what the contracts hold, which is why every read
verb is named after the argument of the native it feeds. Full design: [RGov_Core.md](RGov_Core.md).

| | |
|---|---|
| `/gov chain` | what the group has recorded, your chain address, how many members have published one |
| `/gov chain install` | *(admin)* deploy Inbox, Group and Issue and record the three uris for everyone |
| `/gov chain inbox\|group\|issue <uri>` | *(admin)* record one somebody already deployed |
| `/gov chain push` | write **your own** rows: join, your delegation, ratings, censures, the issues you opened, and your ballots |
| `/gov chain pull` | report what the contracts hold, including each issue's ballots — a report, never a merge |
| `/gov chain inbox` | open your locker if needed and **receive** — which *consumes*, because a capability read twice by two holders is the bug an inbox of capabilities must not have |
| `/gov chain send <peer> <msg>` | put a message in a member's locker. Unlike `/gov say`, this reaches somebody who was not in the room — and a body may be a capability, so it hands over authority rather than text |

**Why uris and not names.** The design wants one public constant and a name per contract, and
`PORT_READ_CAP` really is the master directory's `read` facet, so `read("Inbox", ret)` resolves. But
that map is genesis content with no published `write` or `grant`, and the `Directory` entry is a
*factory* — every call mints a fresh empty directory, so a write to it changes nothing anyone else
can see. Until the node exposes a restricted per-name grant, an installed contract has no name to
be found under, and a uri is what there is. [RGov_Core.md](RGov_Core.md#naming-addressing-migration)
has the measurements.

**Push is per-member by construction, not by policy.** `delegate`, `rate` and `censure` are `self`
verbs on the contract: the caller's identity is *derived* inside it from their deployer id, so an
admin cannot write a member's row and a member needs no admin to write their own. That is the same
rule the room already follows for `gov-delegate`/`gov-trust`/`gov-censure` — self-signed only —
arriving at the chain by a different road.

**A member has to publish a chain address first.** The contracts key every row by REV address; a
room knows peerIds and dyncap anchors. So `/gov chain push` publishes yours to the group as a
self-signed `gov-chain` envelope, and skips — out loud — any delegation or rating whose *target*
has not published one. Nothing is guessed: a delegation pointed at the wrong address would be a
silent misdirection of a vote.

**Pull reports rather than merges.** The room's state is live and the chain's is a record; silently
overwriting the first with the second would make a stale contract the last word on a group that has
since moved on.

## Scope

**Phase 1 (shipped):** groups, members, issues, **standing delegation + per-issue
override + weighted liquid-democracy tally**, the Governance UI, and this doc.

**Phase 2a (shipped):** **per-topic (issue-scoped) delegation** — `/gov delegate
<member> on <issue>` sets a delegate that overrides your global one for that issue
only (revoke with `/gov undelegate on <issue>`). The per-issue map overrides the
global map (`gov.ts` `delegationMapFor`); the resolver and weighted tally are
unchanged. So you can delegate finance decisions to one steward and design
decisions to another, while still voting directly to override either.

**Phase 2b (shipped):** **treasury + kudos** — each group can declare a `/note`
treasury currency (`/gov treasury`) and a kudos reputation currency
(`/gov kudos`); both are thin orchestration over `/note` (declare/grant/pass/
balance), with the currency names recorded on the group (`group-meta`, synced).
Because notes are bearer instruments, a balance readout shows *your own* holdings,
not a global ledger.

**Phase 2c (shipped):** a **per-group inbox** (`/gov say` → a membership-scoped
`group-msg`; only fellow members render it) and **daemon persistence of groups** —
the headless memory peer now stores `groups.json` and re-serves `sync-gov`, so a
group's members, delegations, issues, and treasury/kudos currencies survive when
every browser leaves; it also honors a creator's group disband (`retract` /
tombstone) and won't resurrect it.

**Phase 2d (shipped):** **trust-rating weights + accountability** — the RGOV
liquid-*trust* extension. `/gov trust <member> <0–5>` (self-signed `gov-trust`)
confers a trust level **below the rater's own** in an admin-rooted hierarchy
(`trustLevels`); base voting weight is `1 + level`, fed into the same
deterministic `resolveWeights` tally. **Accountability:** `/gov censure <member>`
(self-signed `gov-censure`) flags undeserved trust; a **⅔ quorum of eligible
censurers (min 2)** discredits the target and **slashes their vouchers** by the
level they staked (phase 2 of `trustLevels`) — no single member, admin included,
acts alone, and a disagreeing admin can't block a real quorum. Opt-in and
backward-compatible — no ratings ⇒ flat one-person-one-vote. `/gov status` shows
each member's `[wt N]` and any `⚠ discredited` flags.

**Phase 2d UI (shipped):** the group card carries the **trust dropdown** (confer a
level below your own), the **censure** toggle, and per-member `[wt N]` / `⚠
discredited` readouts — so liquid trust and accountability are usable without
typing `/gov trust` / `/gov censure`.

**Phase 2e (planned):** hard role/permission enforcement; more rgov exemplars.

---

## See also

- **[QuantumOS README](README.md)** — the runtime this governance layer is built on: rooms, peers, capability tokens, slash commands, and the ZFA substrate.
- **[Quantum Logical Framework (QLF) README](https://github.com/rhovision-org/quantum-logical-framework/blob/main/README.md)** — the physics/formalism repo: ZFA closure, the machine-verified Lean proofs, and the collective-intelligence theory ([`Room_Best_Practices.md`](Room_Best_Practices.md)) that motivates liquid trust.
