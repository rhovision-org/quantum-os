# The master dictionary, redesigned

**A proposal, with a working prototype.**
[`packages/browser/src/dictionary.js`](packages/browser/src/dictionary.js) implements everything
below and `scripts/localnet/dictionary-check.mjs` runs it against a live chain — **27 of 27**, first
try (see *Verified* at the end). The naming layer the governance contracts need and the current one
cannot give them. Context: [RGov_Core.md](RGov_Core.md) is what runs on top of it;
[Governance.md](Governance.md) is the off-chain half.

## What is there now, measured

Probed live on `rnodeapi.rhobot.net`, 2026-09-23:

| | |
|---|---|
| `PORT_READ_CAP` | **is** the master dictionary's `read` facet. `read(ret)` gives the whole map; `read("Inbox", ret)` resolves one name. Name lookup genuinely works. |
| its `write` / `grant` | **not published anywhere.** No client can add a name. |
| the map | 9 names, fixed at genesis |
| `Directory`, `Echo`, `Log` | **the same unforgeable** — one stateless factory under three names |
| `Inbox`, `Issue`, `Kudos`, `Roll`, `GetMe`, `SendThem` | distinct capabilities |

The factory is the sharp part. `Directory.rho`'s `contract directory(ParentReadCap, capabilities)`
opens `new mapCh, read, write, grant in { mapCh!({}) … }` **on every call**, so calling it mints a
brand-new empty dictionary. Granting a key and writing to it succeeds and reports `"added"` — into a
throwaway that nobody else can see. Measured: write into instance A, read the same key from instance
B → `Nil`. That is a naming system in which a successful write means nothing, and it fails silently,
which is the worst combination available.

**So there is no stored state anywhere in the current dictionary.** Nothing to migrate is the
cheapest moment this will ever be to replace it.

## Requirements

Drawn from the audit and this thread, each one the answer to something that actually went wrong:

1. **Resolve by name from one public constant.** A uri must be communicated; a name is computed. The
   whole rgov provenance mess was per-chain uris handed around out of band.
2. **Anyone may publish; nobody may take what is another's.** Self-service *and* restricted. A
   registry that needs an admin to act first has a bootstrap problem; one that lets anyone write
   anything has no integrity.
3. **Per-name authority, delegable and revocable.** `Directory.rho`'s `grant` had the first two.
4. **Upgrade a name without touching clients.** This is requirement 3 of the plan: state migration
   needs a stable address whose *target* can move.
5. **Read is public, free, and grants nothing by being read.**
6. **Extensible forever without a new genesis.** Genesis content is frozen for every chain built
   from the port.
7. **No chicken-and-egg.** Nobody must have acted before you can register.
8. **Failure is never silent** (law 38), and **a wrong arity answers** (law 40).
9. **Nothing accumulates on a linear channel.** One cell, consumed and restored.
10. **A client that needs certainty can get it** — pin a version, or require immutability.

## The design

### 1. Names are rooted in the identity that owns them

```
1111alice…/inbox
1111alice…/gov/colab/group
1111bob…/inbox
```

A caller may write under **their own REV address prefix and no other**. Not by a permission check —
by derivation:

```rholang
revAddr!("fromDeployerId", *_id, *a) | for (@me <- a) { … only `me + "/"` is writable … }
```

This is verified working: a deployed contract calling `rho:rev:address` on a passed-through deployer
id gets *the caller's* address, not the installer's, across deploys and identities; a forged deployer
id yields `Nil` (so every verb guards `Nil`, or one shared row becomes writable by anyone).

That single move settles requirements **2, 6 and 7** with no policy, no admin, no fee and no
squatting. Your namespace exists because your key exists. There is nothing to grant, so there is
nothing to be waiting for, and no name of yours is reachable by anyone else — the same rule that
makes rgov-core's `self` facet safe to publish.

### 2. Short names are a curated tier, and they are aliases

Bare `Inbox` is scarce and therefore governed; `1111alice…/inbox` is abundant and therefore free.
A root name holds **an alias to a rooted name**, never a value:

```
"Inbox"  ->  "1111alice…/inbox@4"
```

Upgrading the app that `Inbox` means is re-pointing the alias. No client changes, no uri to
redistribute — requirement **4**.

Who may set a root name is the one genuinely political question here, and the design should not
answer it by accident. Genesis places a `rootAuthority` capability; what holds it is a policy
decision, and the natural candidate is a governance contract, since `rho:gov:tally`,
`:trustLevels`, `:resolveWeights` and `:censure` are already node natives. **The dictionary should
not implement that policy itself** — it should hold one capability and let whatever governs it
govern it.

### 3. Versions, and sealing

`publish` appends rather than overwrites:

```
resolve(path)         -> the latest version
resolveAt(path, 3)    -> exactly that one, forever
seal(path)            -> no further versions, ever
```

Because the version list is append-only, **every published version is already immutable** — there is
nothing to freeze. What a client cannot otherwise rely on is that a *bare* resolve stays put, so
`seal` is the verb that matters: it closes a path to further versions. (An earlier draft of this
note said `freeze(path@3)`; building it made clear that froze something that could not move anyway.)

Old versions stay resolvable, which is what gives a migration a window where both the old and the new
contract answer — `dump` from v1 and `load` into v2 need exactly that. Requirement **10** then has
two answers rather than one: pin a version, or require a seal. A client that pins is immune to a
re-point; one that resolves bare gets upgrades. Both are legitimate, and the choice is the client's.

### 4. Three facets

| facet | who | verbs |
|---|---|---|
| `resolve` | everyone, public | `resolve(name)`, `resolveAt(name, v)`, `versionsOf`, `ownerOf`, `sealed`, `epochOf`, `targetOf`, `aliases`, `list(prefix)`, `paths` |
| `publish` | everyone, self-scoped | `publish(path, value)`, `seal(path)`, `grant(path)`, `revoke(path)` |
| `root` | the root authority | `alias(short, target)`, `unalias(short)` |

`publish` is publishable *because* it is self-scoped — the same reason `self` is publishable in
rgov-core. `grant(path)` returns a writekey bound to exactly one path (keeping `Directory.rho`'s one
good idea), and `revoke(path)` bumps that path's epoch so previously-issued writekeys stop working —
which `Directory.rho` had no way to do. A capability you cannot withdraw is one you can only ever
give away once.

**What a name should hold** is a `{read, self}` pair, not an admin facet. Publishing an admin facet
into a public dictionary publishes the administration.

### 5. Shape rules, each one a bug that happened

- **One instance, never a constructor.** Genesis publishes the dictionary's *facets*. The current
  design publishes the factory, which is why a write can succeed into nothing.
- **One state cell, consumed and restored.** Not a peek, not a second send — rgov's
  `@[*deployerId, "MasterContractAdmin"]!(…)` was a linear send that accumulated a second dictionary
  and left consumers binding an arbitrary one, with nothing erroring anywhere.
- **`(verb, args)` dispatch, one arity per facet**, so a call with the wrong number of arguments
  falls to `_` and *answers* `("dir-error", "bad verb or arity", verb)` instead of matching nothing.
- **Every refusal answers.** No verb may complete by doing nothing.
- **Guard `Nil` identity before touching state**, because the address powerbox answers `Nil` rather
  than failing.

### Sketch

```rholang
new state, epochs, resolveFacet, publishFacet, rootFacet, doResolve, doPublish, doRoot,
    revAddr(`rho:rev:address`), rootAuthCh
in {
  state!({}) | epochs!({}) |

  contract publishFacet(_id, @verb, @args, ret) = {
    new a in {
      revAddr!("fromDeployerId", *_id, *a) |
      for (@me <- a) {
        match me {
          Nil => { ret!(("dir-error", "no identity")) }
          _   => { doPublish!(me, verb, args, *ret) }
        }
      }
    }
  } |

  contract doPublish(@me, @verb, @args, ret) = {
    for (@s <- state) {
      match [verb, args] {
        // The prefix check is the whole access-control system. `me` was derived,
        // never supplied, so a path outside it cannot be named by this caller.
        ["publish", [path, value]] => {
          match path.slice(0, me.length() + 1) == me ++ "/" {
            false => { state!(s) | ret!(("dir-error", "not your namespace", path)) }
            true  => { /* append a version, answer (path, version) */ }
          }
        }
        ["grant",  [path]] => { /* writekey bound to one path, carrying its epoch */ }
        ["revoke", [path]] => { /* bump the epoch; old writekeys stop working */ }
        ["seal",   [path]] => { /* no further versions, ever */ }
        _ => { state!(s) | ret!(("dir-error", "bad verb or arity", verb)) }
      }
    }
  } |

  contract resolveFacet(@verb, @args, ret) = { doResolve!(verb, args, *ret) }
  // … root facet gated on the capability in rootAuthCh …
}
```

## What genesis has to carry

Only the dictionary's own facets and the root authority — which is the decision already taken
(*"just directory and admission policy in genesis"*). Everything else is deployed afterwards and
published into it, because anything frozen at genesis is frozen for every chain built from the port,
forever.

This is a genesis change, so it belongs on the hard-fork tracker
([rholo#51](https://github.com/rhovision-org/rholo/issues/51)) alongside
[#71](https://github.com/rhovision-org/rholo/issues/71).

**Filed upstream 2026-09-23**: the design, the measurements and the prototype's results are on
[#71](https://github.com/rhovision-org/rholo/issues/71#issuecomment-5803106296) — which is
the issue this answers ("the genesis application directory is unwritable after genesis") — and
registered as a category-A genesis change on
[#51](https://github.com/rhovision-org/rholo/issues/51#issuecomment-5803110912).

## What it changes here

`rgov-core.js`'s three contracts stop being addressed by uri. `/gov chain install` publishes
`<myaddr>/gov/<groupId>/{inbox,group,issue}` and a group records **names**. `Group.chain` holds
names rather than uris, and `deployAnswer`'s uri-scraping goes away. Nothing about the contracts
themselves changes — they already hold state and nothing else, which is what makes the naming layer
replaceable underneath them.

## Verified

`node scripts/localnet/dictionary-check.mjs` against `rnodeapi.rhobot.net` — **27 ok, 0 failed**,
with two identities. The claims that had to hold:

| | |
|---|---|
| alice publishes under her own root | `("published", path, 0)`, then `1` — append-only |
| `resolveAt(path, 0)` after v2 exists | still the first value — versions are immutable |
| **bob publishes under alice's root** | **`("dir-error", "not your namespace", …)`** |
| a granted writekey | publishes to its one path |
| **the same writekey after `revoke`** | **`("dir-error", "revoked", …)`** |
| **publishing to a sealed path** | **`("dir-error", "sealed", …)`** — and it still resolves |
| **bob sets a short name** | **`("dir-error", "not the root authority")`** |
| the root authority re-points `Inbox` | the same short name resolves somewhere else; the rooted paths are untouched |
| a wrong arity, an unknown verb | both *answer* `("dir-error", "bad verb or arity", …)` |
| resolving an unknown name | `Nil` — absence is not an error |

The four bolded rows are the design: squatting is not expressible, a grant can be withdrawn, a seal
holds, and the governed tier is governed. `node packages/browser/src/dictionary.js --selftest` is
30/30 and runs in CI.

## Open questions

- **Who holds `rootAuthority` at block 0**, and how it rotates. Deliberately not answered here.
- **Whether a short name may ever be re-pointed to a different owner's path.** It is the difference
  between an alias and a transfer of a brand.
- **Whether `list(prefix)` should be bounded.** A public enumerable registry is a nice discovery
  story and an unbounded read.
- **Cost.** Publishing is a write to shared state; a free unbounded namespace is a free unbounded
  write. Rooting by identity limits *who* can write where, not *how much*.
