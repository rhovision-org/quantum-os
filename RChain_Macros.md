# Macros — Interact2

> **This document has two halves.** The first is the `$` macro language and the
> `+commands` built on it — what a room writes for itself. The second is the
> `%` capability library that ships with the app and expands inside a
> `/rholang` program. Tracked in
> [#65](https://github.com/rhovision-org/quantum-os/issues/65).
>
> **This is the design & history.** For a hands‑on guide that assumes no rholang,
> see **[MacRhoLang.md](MacRhoLang.md)**.

## Where this comes from

EIES had a command language, INTERACT, and users wrote hundreds of commands in
it, shared them, and watched groups adopt the ones that proved useful. That was
not a feature of the system so much as the point of it —
[EIES_Legacy.md](EIES_Legacy.md) is the full account, and the argument that the
capability model here is a forty-year-old result rather than a new idea.

Two things from it decide the shape of what follows:

- **`+mypriv`** let a command act with its owner's authority — suid, in Unix
  terms — and that is what made a shared command worth sharing at all. Without
  it a command can only do what its *caller* could already do. A capability is
  the same enabling property with the ambient authority removed.
- **Personal → group → system** was ownership and directory permissions, with a
  human deciding at each boundary. Not a governance system. That is why the
  design below starts with capabilities and defers `/gov`.

The 2008 deck *Back to the Network Nation Future* names the destination
outright, under "Formal Language": **Web 3.0 — Rholang, Interact2?** This is
Interact2.

## The language

### `$` — the sigil

A macro is **called** with `$` — `$macroname(name="joe", age=5)` at a rholang
call site, `$arg` for a parameter inside a body. (The `/macro define` line
itself is bare: `define macroname(name, age) …` — see below.)

`$` is **lexically illegal in rholang**, which is what makes a scanner safe
without a grammar. rnode's own lexer rejects it:

```
new return, $x in { return!("x") }   →   Illegal character $ at 28
```

So a `$` site can never be valid rholang, an unexpanded one cannot silently
become something else, and rnode is the backstop if expansion is missed.

A sigil without that property puts call sites in the same character space as
something rholang already means. `%` is its modulo operator: `7 % 3` is `1`.

### `/` is what the app ships, `+` is what a person wrote

A definition is made with a built-in verb, so `/macro define` keeps the slash.
What it produces is invoked with `+`. The grammar is `name body`, or
`name(arg, …) body` — the name and parameters are bare, and the body is the rest
of the line or the lines below it (an optional `// note` between the two is the
macro's doc):

```
/macro define standup(topic)  // opens a standup poll
/poll new $topic | yes, no, later
/gov say standup on "$topic" is open
/channel send team standup: $topic
```

A one-liner needs no newline:

```
/macro define greet(who) Hi $who, welcome to the room!
```

```
+standup "Q4 budget"
```

That is the whole rule, and it is worth stating plainly because it is what the
sigil is *for*: a leading `/` is something the app ships and the repo reviewed;
a leading `+` is something somebody in this room wrote. Quotes group an argument
(`"Q4 budget"` is one topic, not two), and `topic="Q4 budget"` names one instead
of passing it by position.

`++text` sends a literal line beginning with `+`, the way `//` does for `/`.
A `+1` in chat is agreement, not a call — only an identifier-shaped name is read
as an invocation.

### Three kinds, decided by the body

A body of slash/`+` commands makes a **`+command`**. A body with rholang syntax
(a send, a backtick powerbox name, `for`/`match`/`new … in {`) makes a
**fragment**, called as a `$name(…)` site inside another program, the way
MacRhoLang's `$print($expression)` was. A body that is neither — plain text — is
a **text macro**: `$name` yields its body, for use in another macro, a `/rholang`
program, or on its own. `bodyKind` decides; nothing is declared.

```
/macro define print(expression)  // stdout one term
new stdout(`rho:io:stdout`) in { stdout!($expression) }
```

```
/rholang eval
new return in { $print("hello") | return!(42) }
```

Nothing declares which half a definition is in — the first line of the body
says. The two are the EIES half and the @RHO-bot half of the same language, and
a `+command` reaches the chain by having `/rholang eval` in its body, so they
compose without a third mechanism.

### The two halves have different lexical rules

This is the one place the language is not uniform, and the asymmetry is real
rather than an implementation detail.

|  | rholang body | command body |
|---|---|---|
| `"$topic"` | a string literal — `$topic` is text | quotes somebody typed — `$topic` substitutes |
| `// $topic` | a comment — text | a line, and `//` only starts a comment at column 0 |
| `$m("hello")` | argument is a **term**: expands to `stdout!("hello")` | argument is a **word**: `"Q4 budget"` binds as `Q4 budget` |

Both rows follow from the same question — whose lexer is this? — and getting it
wrong is silent in the worst way. A command body whose `"$topic"` is skipped as
a string literal produces a command with a literal `$topic` in it, and that
command runs.

### Binding

Textual substitution, which is what makes `match` binding work rather than
something separate from it:

```
/macro define hanoi(height)  // towers of hanoi - use EXPLORE
/rholang eval
match [$height] {
  [height] => {
    new result(`rho:io:stdout`), move, ack in {
      move!(height, "left", "right", "center", *ack)
    }
  }
}
```

`+hanoi 3` substitutes `3` into the match subject and rholang's own `match`
binds `height`. The body stays ordinary rholang; the substitution happens in a
construct the language already has. **Positional by default**, as rhobot does it
for standard components; if *every* argument is written `name=value` they bind
by name instead. Mixing the two is refused, because then the reading of a call
depends on where you stopped.

**A comment following the name is documentation the macro carries.** The
`// towers of hanoi - use EXPLORE` is not decoration: it is what `/macro find`
searches, what the sidebar shows, and what an LLM composing a program has to
work from beyond the code.

### A line beginning with `/` or `+` starts a command

Inside a command body, anything else continues the line before it. That is what
lets a multi-line rholang program be the argument to `/rholang eval` without a
terminator — as in `$hanoi` above, which is one command, not five.

### `echo` and `explain`

Two ways to see what you are about to run, answering different questions:

| verb | shows | is |
|---|---|---|
| `echo` | what the expansion actually produced | evidence — mechanical, checkable |
| `explain` | what that program means, in prose | a reading of the evidence |

`/macro echo <name> [args]` expands and runs nothing. `/rholang echo` shows the
program including the wrapper, macro sites expanded. Neither replaces the other,
and the asymmetry decides how they get used: for an unfamiliar macro, an
explanation is a summary you are also trusting — most useful for understanding,
weakest exactly where the question is *should I sign this*. `echo` answers that
one. `explain` is not built.

### Errors never abort

Every site is attempted, so one report covers them all, and a site that fails is
left exactly as written rather than silently dropped:

```
✗ line 3: unknown macro $nosuch — try /macro list
```

Because `$` is illegal rholang, a site left in is a hard error at rnode
rather than something that quietly means the wrong thing.

## Where definitions live

A definition lives **in your browser** (`qos-macros`, one key — not per room), so
a macro you write or pick up follows you into every room you join. It is also
signed with the author's dyncap and **contributed to each room** — broadcast on
change, replayed to whoever joins next via `sync-macros`, tombstoned per browser
when retracted. It needs no node, no key and no chain, so a room can write and
share commands the moment two peers are in it.

That maps EIES's hierarchy onto what this system already has:

| tier | what it is | built |
|---|---|---|
| local | macro files in a directory on your machine | no |
| personal | a definition in your browser, kept across every room | yes |
| fork | a library in your fork of quantum-os, shared by pull request | the `%` library is this |
| group | a personal definition contributed into a room (peers pick it up) | yes |
| chain | a name in a locker, reached by capability | no |

### A fork is a library, and a pull request is how it is shared

The `%` capability library is already this tier and has been all along: it is a
file in the repository, and it got there by review. So a fork of quantum-os
carries its own library — the macros that fork's people found worth keeping —
and offering them upstream is a pull request.

That matters because it is the one tier whose consent mechanism is already
built, already understood, and already social. A pull request is a human
deciding at a boundary, which is exactly what `+addgroupcommand` and
`+addsyscommand` were: EIES's system commands were gated by people with write
access to the system directory, and "the most useful were made global system
commands" describes a review queue, not an election.

Nothing about it needs inventing. What it needs is for a fork's library to be a
**directory of macro files** rather than a JS registry, so that adding one is
adding a file and reviewing one is reading a diff.

**Personal macros sit beside it, not inside it.** A macro you wrote for yourself
belongs in your own directory and is nobody's to review. Pushing one to a room
shares it with the people there; pushing one to your locker puts it on chain
under your identity. Neither passes through the fork's library, and a macro that
proves itself in a room is a candidate for a pull request rather than something
that arrives by one.

So the four ways a definition travels are distinct and none of them is a
fallback for another: a **file** you keep, a **pull request** to a fork, a
**broadcast** to a room, a **deploy** to a locker.


**First writer wins a name, and only that author may redefine it** — matched by
dyncap **anchor**, not peerId, so a reload does not cost you your own commands.
That is EIES's rule too: the owner of the file could edit it and nobody else
could. `/forget macro <name>` retracts yours for everyone and hides anyone
else's from your view, exactly as a lemma does.

### `+mypriv`, and what a capability does with it

EIES's most powerful command let a command act with its owner's authority —
suid, in Unix terms — and that is what made a shared command worth sharing at
all. Without it a command can only do what its *caller* could already do.

A `+command` composes the caller's own capabilities, which is enough while a
room is the boundary. It becomes load-bearing at the locker, where a macro
carries the specific capabilities its author chose to put in it — the same
enabling property with the ambient authority removed, and no superuser to
administer it. `grant` on a locker key is that: a write-only facet for one
name, handed to someone who then holds exactly that and nothing else.

## Naming a capability

A `$name` bound to a capability is a macro with no parameters, and the body is
the capability:

```
/macro define ballot   // the colab ballot contract
`rho:id:3qfh1fy7jwfcai7ceyorux4a18hzcn83n9xb6dramjf5gs7cw8fynf`
```

It then stands in for that capability at any call site:

```
/rholang eval
new lookup(`rho:registry:lookup`), ret in { lookup!($ballot, *ret) }
```

That much lives in the room — signed, shared, replayed to whoever joins. What it
does not do is follow you off the room, and a capability you hold is worth more
than a room's memory of it.

## The locker

The chain tier is a **private hierarchical dictionary keyed to `deployerId`**.
It holds your names: `ballot` → a uri, `notes` → a directory, `team` → a parent
you were granted.

**A uri, not a quoted name.** A registry uri is a reference that resolves to
whatever was inserted under it, and what comes back is a `bundle+` facet — so
holding a uri grants exactly what that facet does and nothing else, and there is
no writing to a uri without the capability to insert there. See
[SECURITY.md](SECURITY.md) for why nothing here is kept at `@"…"`.

The primitives rnode supplies, and what each is for:

| primitive | what it gives |
|---|---|
| `rho:rchain:deployerId` | the signer's identity, unforgeable, and only inside a deploy |
| `rho:registry:insertSigned:secp256k1((nonce, data), deployerId, ret)` | a slot at a uri derived from `blake2b256(pubkey)`, writable only by that key, with a nonce that must advance |
| `rho:registry:lookup(uri, ret)` | resolve a uri to what is stored there |
| `rho:registry:insertArbitrary(data, ret)` | a slot at an unpredictable uri |

`insertSigned` is the one that matters: the uri comes from the public key, so
**the browser can compute where its own slot is before deploying**, and nobody
else can write there. That is what makes a dictionary findable without a
well-known name.

The locker is one contract at a published uri, and publishing that uri grants
nothing: every operation takes a `deployerId`, which is unforgeable and issued
only to the deploy that signed for it. So the world may hold the locker's uri
and still reach only its own entry.

```
register!(*deployerId, revAddress, *ret)      — create my identity record
set!(*deployerId, "ballot", uri, *ret)        — bind a name
get!(*deployerId, "ballot", *ret)             — resolve one
grant!(*deployerId, "ballot", *ret)           — mint a write-only cap for one key
```

No operation reads across identities. Finding someone is not something the
locker does — [uris are shared in rooms](#uris-are-shared-in-rooms).

**Hierarchy is the parent link, and it is a capability.** An entry may name a
parent — a directory's read facet somebody granted you. `get` falls through:
yours, then the parent's, then its parent's. That is the scope order the macro
library wants — personal shadows group shadows public — and it arrives without a
permission system, because a name resolves through exactly the capabilities you
were given. Promotion is being granted a write facet; **consent is the act of
granting it**.

## Registering an identity

A user needs a **REV address** before any of this reaches them. It is derived
from the same secp256k1 key that signs their deploys, so the address, the
deploy signature and the locker slot are three faces of one identity rather
than three things to keep in step.

`register` creates that user's **identity record** and hands them a
**restricted** write capability on it.

Restricted is the whole point. If the subject held full write on their own
record they could write their own credentials, and a credential you can issue to
yourself is worth nothing. So the record is partitioned by who may write what:

| part | who writes it |
|---|---|
| what the subject says about themself — display name, an inbox uri, preferences | the subject, through the facet `register` returns |
| what someone else attests about the subject | that voucher, through a facet scoped to their own attestation |

Nobody can write another party's attestation, and the subject cannot write any
of them. Reading a record tells you who vouched, at what level, and you weigh
that by what you think of the voucher — the credential is a relationship, not a
property of the person.

The record lives at the uri derived from the subject's public key:

```
rho:id: + zbase32(blake2b256(pubkey))
```

so **the browser can compute where its own record is before deploying**, and
`insertSigned` means only that key can create it. That is what makes an identity
findable without anything having to be looked up.

`register` is also what makes the rest work at all: `insertSigned` requires a
nonce that advances, and a lookup of a uri that was never inserted does not
answer. Registration is the insert that puts a floor under both.

## Uris are shared in rooms

There is no on-chain directory of users, and there does not need to be. **A uri
is shared in a room** — the room is the introduction.

That is not a workaround; the room is better at it than a chain would be. It
already has the three properties an introduction needs:

| need | the room already has |
|---|---|
| admission | holding the room capability *is* being in the room |
| identity | every envelope is dyncap-signed and anchor-pinned; a fork is flagged |
| standing | `/gov trust` levels, admin-rooted, with ⅔-quorum censure that slashes vouchers |

So sharing a capability is `/macro define ballot` with the uri as its body,
broadcast to the room like any other definition. Whoever is in the room has it;
whoever is not, does not.

**Not persisting it is a real option.** A uri shared in a room can live only as
long as the room does. The locker is for the ones you want to survive the room —
not a place everything has to go.

## Spam, and ignoring

An inbox reachable by anyone is floodable by anyone, so what a correspondent
receives is never the inbox's own write facet — it is a **caretaker** wrapping
it, minted for that one correspondent and holding a flag.

That single choice answers both halves:

- **Ignoring** flips the flag. That correspondent's messages stop; every other
  correspondent is undisturbed and nothing is re-issued. It also answers bearer
  semantics where they bite hardest: a capability once handed over is held by
  whoever it reached, but a caretaker is what was handed over, so revocation is
  a property of what you minted rather than a power over what someone else holds.
- **Spam does not pay**, because a facet identifies its holder. There is no
  shared channel to poison, so a compromised facet is worth one correspondent's
  attention, once. Getting a facet in the first place costs a room capability or
  a credential, and a voucher who hands one to a spammer loses standing for it.

Every attempt is also a signed, phlo-charged deploy, which is a rate limit that
comes from the identity being unforgeable.

**Honest limits.** A credential proves a relationship, not a person; a careless
voucher is the weak edge, and the censure quorum is what makes that
self-correcting rather than what prevents it. An inbox holds what it was sent
until read, so ignoring stops the next message, not the one already delivered.

## The pieces

Ordinary capability-facet contracts — `new` for the names, `bundle+` on what is
handed out so a recipient can use a facet without comparing or forging it:

- **Locker** — the private hierarchical dictionary, keyed by `deployerId`.
- **Identity record** — at the key-derived uri, restricted write for the
  subject, a scoped facet per voucher.
- **Inbox** — a caretaker write facet per correspondent, a read facet you keep.
  A capability travels inside a message, so granting is sending; type and
  subtype are what make it usable rather than a pile.
- **Channels** — publish and subscribe over a stream, subscribers holding read
  facets and the publisher a write one. A room's `/channel` is the in-memory
  form; this is the form that survives the room.

## Open work

Four topics, and which one a piece of work belongs to is a question about who it
reaches: **user** is your own capabilities and identity, **group** is how a
capability reaches someone else, **governance** is who decides inside a group,
and **blockchain** is what happens when the stakeholders are not one group.

### User

| | |
|---|---|
| [#73](https://github.com/rhovision-org/quantum-os/issues/73) | A deploy's answer goes to the deployer's registry slot, which only that key can write to. **done** |
| [#74](https://github.com/rhovision-org/quantum-os/issues/74) | Install the locker and wire `/rholang register`. Needs a signed deploy; gates everything below |
| [#75](https://github.com/rhovision-org/quantum-os/issues/75) | Bind a `$name` to a capability in the locker, so it outlives the room |

Also open, and not yet an issue: **offline**. Resolving a name through the
locker needs an rnode read. What happens with no rnode reachable, and is a
resolved name cached? A cache that goes stale silently is worse than a miss.

### Group

| | |
|---|---|
| [#76](https://github.com/rhovision-org/quantum-os/issues/76) | Identity credentials: issue, hold, verify. A credential is a relationship, not a property |
| [#77](https://github.com/rhovision-org/quantum-os/issues/77) | Inbox: a caretaker facet per correspondent, and ignore |
| [#78](https://github.com/rhovision-org/quantum-os/issues/78) | Channels that outlive the room: publish and subscribe |

**Bearer semantics** sits under this heading and stays open by choice. A granted
facet is held by whoever it reached and there is no un-granting one; a caretaker
is the answer where it bites hardest, and a group wanting more writes the
indirection into its own contract.

### Governance

| | |
|---|---|
| [#79](https://github.com/rhovision-org/quantum-os/issues/79) | A federated tier: when a group agreed, rather than when somebody published |

**Versioning** is the question that decides its shape: does a group consent to a
*name* or to a *definition*? A name means later edits ride in on a decision
taken about something else. In a room a redefinition is visible to everyone as
it happens; through a locker it is not.

### Blockchain

Above a federated tier of groups is the chain itself, and its stakeholders are
not one group. Validators produce blocks, REV holders pay for what runs, the
co-op's members hold the organisation, and whoever wrote the contracts everyone
depends on carries those. A name at this tier is not "somebody published it",
and it is not "one group agreed" either.

RChain's own answer is the model [`Governance.md`](Governance.md) ports: **RGOV
liquid-trust network governance** — an anti-fragile sociocratic polyarchy,
maximal distribution of power with effective global coordination, representing
**all** stakeholders through interlinked autonomous teams. Not one assembly
deciding for everyone; teams that hold their own capabilities and interlink by
holding each other's.

The macro library maps onto that without needing a new idea, because the pieces
are already the right shape:

| RGOV | what it is here |
|---|---|
| an autonomous team | a library behind a capability its team holds |
| teams interlinked | the locker's parent link — a read facet one team granted another |
| trust-weighted decision | `rho:gov:trustLevels` / `resolveWeights` / `tally`, the same predicates `/gov` runs in a room |
| asset pools | a treasury funding a library that costs something to maintain — `/note` on chain |
| purposeful transparency | the definition is readable; who vouched for it is readable; what a team does with it is theirs |

**A coarse plan, in the order the pieces stop being hypothetical:**

1. **Libraries as capabilities** (quantum-os#74, quantum-os#75). A team's library is a locker
   namespace; holding the cap is membership in that library.
2. **Interlink by granting.** A team grants another its read facet, and a name
   resolves through the parent chain. Adoption is a grant, and the graph of
   grants *is* the polyarchy — no registry of teams needed.
3. **Weigh across teams.** When two teams bind the same name differently,
   resolution order settles it locally; where a shared answer is wanted, the
   `rho:gov:*` predicates weigh it by trust rather than by who wrote first.
4. **Fund what is shared.** A library everyone depends on is maintained by
   someone; a treasury and kudos currency are the pool that pays for it.
5. **Stop there.** The platform supplies the capability and the predicates. Which
   rule a team adopts, what adoption requires, and what it costs are that team's,
   and no other team should be able to see or constrain the choice.

Sketch, not built. What is built beneath it is the trust and delegation
machinery (`/gov`) and the capability model the tiers rest on; what is missing is
the chain-side library and everything in the tiers above.

### Used anywhere

[#81](https://github.com/rhovision-org/quantum-os/issues/81). INTERACT was
called an interface language and was a general-purpose one. The
distinction was never real: a language that can answer a prompt conditionally,
hold state, and call anything the system exposes is a programming language that
happens to sit where a person types.

The same is true here, and rnode is what makes it true — it is universal, so
what a macro reaches is not bounded by the app the macro was typed into. What
bounds it today is only that `+name` is read by one message box.

**The interface is keyboard capture with history.** Input is captured as it is
typed, and a macro encountered along the way is **held** — bound, available,
carried forward — until it is replaced or something errors. That is a different
model from a command line that parses a completed line and forgets it: history
is where the macros live, and typing is what populates it.

**The open question is what the user sees while typing a call.** `echo` answers
*what will this do* after the fact, which is the right answer for signing and
the wrong one for typing. At the moment of writing `+standup "Q4` the person
needs to see what is bound, what the call will expand to, and where it will go —
and none of that exists yet. Getting it wrong makes an expansion something that
happens to you rather than something you wrote.

Documenting this is what lets macros be used anywhere rather than in a chat box:
the capture-and-hold model and the display are the parts that have to be
specified before a second place can implement them.

### Not yet placed

- **Active text.** `.get` / `.see` / `@(expr)` and text-as-program equivalence
  were on EIES from the start. A macro that is text, stored as text, expanded
  into text is that same identity — but nothing here yet *reads* a message as a
  program. See [EIES_Legacy.md](EIES_Legacy.md).
- **Orchestration.** `$` expansion is the seed, not the destination, which is
  interactive orchestration of concurrent rholang processes. Matching on prompt
  text is what INTERACT did because it had no channel to bind to; here there is
  one — and [Used anywhere](#used-anywhere) is the interface half of the same
  question.

### Upstream

| | |
|---|---|
| [rholo#19](https://github.com/rhovision-org/rholo/issues/19) | A one-binder persistent receive in a nested `new` does not terminate. Every contract here takes two parameters because of it |
| [rholo#18](https://github.com/rhovision-org/rholo/issues/18) | A cancelled exploratory deploy retains ~10 MB per request |

## Checking the macros against rnode

A macro is a caller: it names a process, sends arguments in a shape, and expects
an answer in a shape. rnode can change any of those without breaking a single
expansion test, because an expansion test only checks that a macro produced the
rholang it meant to produce.

So run them against a node:

```bash
bash scripts/localnet/run-node.sh --fresh
node scripts/localnet/macro-check.mjs          # --node <url>, --verbose
```

A failure gives the macro, the line it died on, and what rnode answered:

```
FAIL    trust
  %trust({"alice": {"bob": 3}}, ["alice"])
  trustLevels!({"alice": {"bob": 3}}, ["alice"], *ret) |
  [ReduceError("expected a list of (rater, ratee, level) tuples")]
```

Skipped is not failed: a macro that identifies its caller needs a signed deploy,
and one taking capability arguments needs them registered first.

Not in CI — it needs a live rnode.

## Where the pieces are

| file | what it holds |
|---|---|
| [`packages/browser/src/macro-lang.js`](packages/browser/src/macro-lang.js) | the whole language: parser, both lexers, binder, expander, `--selftest` |
| [`packages/browser/src/app.ts`](packages/browser/src/app.ts) | `/macro`, `+name` routing, storage, the signed wire envelopes |

`macro-lang.js` is plain JS with no imports for the reason `rholang-macros.js`
is: the agent will want to expand a macro to show a room what a `+command` does,
and the browser expands the one it actually runs. Those must not be able to
differ. Run its tests with:

```bash
node packages/browser/src/macro-lang.js --selftest
```

---

# `%` — the capability library

> The approved macro library that ships with the app, expanded inside a
> `/rholang` program. Where `$` macros are what a room writes for itself, these
> are the reviewed capability templates: typed arguments, one source shared
> between the browser and the room agent. Both sigils expand in the same pass,
> built-ins first, so a room macro may be written in terms of one.
>
> The four-step security model below is why expanding and signing are separate,
> and it covers both halves.

## How the current implementation works

Four steps, and the split between them is the whole security model.

1. **Expand.** A `%name(…)` call site is replaced by that macro's rholang. Every
   other byte of your program is passed through exactly as written.
2. **Lint.** The WASM linter (`crates/zfa-core/src/lint.rs`) checks the result is
   well-formed, so you are never asked to sign something that cannot parse.
3. **Sign.** Your browser signs, with a key generated locally and stored in
   IndexedDB wrapped by a passphrase-derived AES key.
4. **Deploy.** The signed packet goes straight from your browser to rnode.

The agent only ever performs step 1, and it does that in the open — it posts the
expansion into the room chat, where anyone can read it before anyone signs it. It
holds no key and cannot deploy. **If the agent is compromised, it can post
misleading text into a chat room and nothing more**; it cannot forge a deploy or
reach your key, because it never had either.

Both halves expand through one shared registry
([`packages/browser/src/rholang-macros.js`](packages/browser/src/rholang-macros.js)),
so the rholang you review in chat is the rholang your browser signs. Two copies
could differ, and a macro edited in one and not the other would mean the program
you read is not the program you sign.

## Writing macros in rholang

A `/rholang` program is rholang — one line or many. Macro call sites are
written `%name(arg, …)` and expand in place before it is linted or signed:

```
/rholang eval
new ret, log in {
  %ballot("Q4 budget", ["ship auth", "pay down debt"]) |
  for (@winner <- ret) {
    %mailbox("Q4 results")
  }
}
```

**The rholang is not parsed.** The expander scans only far enough to find call
sites that are really call sites: it skips string literals and both comment
forms, balances `()`, `[]` and `{}`, and splits arguments on top-level commas. A
`%name(` inside a string or a comment is text, not a call site.

The `%` sigil is what makes this work without a rholang grammar — a bare
`ballot(…)` would be indistinguishable from a real contract call.

**Errors never abort.** Every call site is attempted, so one report covers them
all, and a site that fails is left exactly as you typed it rather than silently
dropped:

```
✗ line 3: unknown macro %nosuch — try /rholang macros
✗ line 4: amount: expected a non-negative integer (decimal digits only)
```

**Arguments are rholang terms**, which is where quoting comes from: `%directory("New York office")`
works because the term supplies the boundaries. A `term`-typed argument (the
`rho:gov:*` macros take maps) passes through exactly as written.

**One macro can be the whole program.** The bare form still works, and needs no
sigil:

```
/rholang macro transfer 100 bob
/rholang macros                — list the library
```

## The library as it stands

Twenty macros. Each is a typed template: arguments are structurally validated,
then interpolated — a string always lands inside a rholang string literal, an
amount is always a BigInt of decimal digits.

### Proofs — `rho:qucalc:*`

| macro | expands to | mirrors |
|---|---|---|
| `zfa <twists>` | *(read — the agent answers locally)* | `syllogism.rho` "premise" |
| `verify <cap>` | *(read)* | `syllogism.rho` "verify" |
| `%grant(twists)` | `rho:qucalc:grant` — mint a ZFA closure as a capability | `syllogism.rho` "seal" |
| `%fuse(subject, predicate)` | `rho:qucalc:fuse` — dialectical synthesis | `syllogism.rho` "deduce" |

`grant` returns a registry URI, or `Nil` if the history is not ZFA-closed — it
refuses to mint a proof of something unproven. Because the URI is the hash of the
history, the same history always mints the same capability, and it persists
across deploys.

### Group decisions — `rho:gov:*`

| macro | expands to |
|---|---|
| `%trust(ratings, admins)` | `rho:gov:trustLevels` — admin-rooted web of trust. Ratings are a **list of `(rater, ratee, level)` tuples**, not a nested map |
| `%weights(voters, delegations, levels)` | `rho:gov:resolveWeights` — transitive delegation |
| `%tally(ballots, weights, mode)` | `rho:gov:tally` — weighted IRV or approval |
| `%censure(censures, levels, vouchers)` | `rho:gov:censure` — ⅔-quorum accountability. Censures are `(censor, target)` tuples and vouchers `(rater, ratee, level)` tuples; returns `(discredited, newLevels)` |
| `%ballot(issue, options)` | a ranked tally, for the common case |
| `%delegate(to)` | a self-signed delegation |

These four take rholang maps, so they are program-form only. Composed, they are
[`liquid_democracy.rho`](https://github.com/rhovision-org/rholo/blob/dev/qucalc/examples/liquid_democracy.rho):

```
/rholang eval
new levelsCh, weightsCh in {
  %trust([("alice", "bob", 3)], ["alice"]) |
  %weights(["alice", "bob"], {"carol": "bob"}, {}) |
  %tally({"alice": ["keep"], "bob": ["replace"]}, {"alice": 3, "bob": 1}, "ranked")
}
```

This is the same liquid democracy `/gov` runs in-room, deployed on-chain: a
member who votes counts for themselves, a member who does not has their weight
flow along the delegation edge to whoever ultimately voted, and cycles abstain.
Voting *is* the per-issue override.

### Bearer capabilities

| macro | expands to |
|---|---|
| `%issuer(currency)` | issuer authority for a currency |
| `%note(authority, amount)` | a bearer note of a denomination |
| `%redeem(authority, amount)` | a permanent, non-transferable receipt |
| `%directory(name)` · `%mailbox(name)` · `%group(name)` | capability-facet stores |
| `%transfer(amount, to)` | `rho:rchain:revVault` |

`issuer` / `note` / `redeem` are the on-chain form of the room's own `/note`
lifecycle, mirroring [`promissory_note.rho`](https://github.com/rhovision-org/rholo/blob/dev/qucalc/examples/promissory_note.rho).
The difference is what backs conservation: in-room it is ZFA twist balance, on-chain
it is the RChain purse machinery.

### Structural patterns

| macro | expands to | mirrors |
|---|---|---|
| `%swap(depositA, depositB, toA, toB)` | a `for`-join over four channels | `atomic_swap.rho` |
| `%philosophers([names])` | N diners around a fork ring | `dining_philosophers.rho` |
| `%multisig(nonce, proposal, quorum)` | a nonce-keyed confirmation set | `multisig.rho` |

`%swap` is the same all-or-nothing exchange as `/rdv swap`, and the join *is* the
atomicity — both deposits are consumed together or neither is. No escrow, no
third party:

```
/rholang eval
%swap("alice-deposit", "bob-deposit", "to-alice", "to-bob")
```

```rholang
for (@a <- @"alice-deposit"; @b <- @"bob-deposit") {
  @"to-alice"!(b) |
  @"to-bob"!(a)
}
```

`%philosophers` takes any number of names and seats them in a ring, each holding
both adjacent forks in one join — deadlock is impossible by construction rather
than by protocol.

## Running rnode

You do not need a network, a checkout, or a build. **rnode ships with
quantum-os**, and one instance runs everything:

```bash
bash scripts/localnet/run-node.sh --fresh     # first time
bash scripts/localnet/run-node.sh             # after that
```

Then point the browser at it:

```
/rholang rnode http://127.0.0.1:40403
/rholang status
```

`--fresh` builds the genesis block from the funded throwaway keys in
`scripts/localnet/`; leave it off afterwards or block production stops. Ports:
**40403** is the HTTP API the browser uses; 40401 and 40402 are gRPC, which a
browser cannot reach.

**If a program runs but rnode says `` No value set for `rho:qucalc:zfa` ``,**
it is serving an image from before the QuCalc processes were installed. Restart
it — a running rnode keeps its binary image even after the file on disk changes.

[`scripts/localnet/README.md`](scripts/localnet/README.md) covers the rest:
what each file is, how to point `run-node.sh` at a candidate rnode build with
`RNODE=`, and why the keys are in the repository.

## What is and is not enforced

**Not enforced: which rholang you may write.** The expander does not inspect what
you name a directory, and the linter checks only that the expansion is
well-formed. There is no forbidden rholang. What a deploy can reach is decided by
the unforgeable names it holds — RChain's security is capability-based, and a
denylist of identifiers decides nothing rnode does not already decide, while
refusing legitimate programs.

**Enforced: that an argument cannot escape its position.** Every string reaches
rholang through `JSON.stringify` into a string literal, so quotes and backslashes
are escaped. `%directory("new x in { evil!(1) }")` expands to
`{"directory": "new x in { evil!(1) }"}` — text, not code.

**Enforced: that an amount is the amount you typed.** Amounts are decimal digits
carried as a BigInt. `Number()` would round anything past 2⁵³, which for a REV
transfer means the value you approved is not the value you signed.

### Known limitations

- **The browser signs with ECDSA P-256**, where RChain deploys require
  secp256k1. Web Crypto offers no secp256k1, so this is a working placeholder for
  the pipeline shape. **Nothing signed today is valid on a real network** — swap
  `generateKeyPair` / `signPayload` in `rholang-pipeline.ts` for a secp256k1
  implementation before deploying anywhere that matters.
- **Macros expand to standalone programs.** `%ballot(…)` becomes
  `new ret in { … }`, so embedding one mid-expression produces rholang the linter
  will reject. Composing macros into a single program means giving the templates
  a composable form.
- **The agent and browser halves are not a closed loop.** The agent posts an
  expansion into chat and the browser expands locally as a fallback; a room
  message does not yet flow into the browser's sign-and-deploy pipeline
  automatically.

## See also

- [**EIES_Legacy.md**](EIES_Legacy.md) — where this comes from: Interact, `+mypriv`,
  and why user programming is the point rather than a feature
- [**#65**](https://github.com/rhovision-org/quantum-os/issues/65) — the
  discussion behind every decision here, including the ones still open
- [**MacRhoLang / @RHO-bot**](https://docs.google.com/document/d/1mTUQwWV9zW5INaJekf-hrZoukWh8Gt8ggFwIxREp1vk/edit) —
  the direct predecessor: `$` sites, `define:`/`echo:`/`find:`, and command-form
  invocation, on a Discord bot against an rnode
- [`scripts/qos-cli/README.md`](scripts/qos-cli/README.md) — running the macro agent
- [`packages/browser/src/macro-lang.js`](packages/browser/src/macro-lang.js) — the `$` language
- [`packages/browser/src/rholang-macros.js`](packages/browser/src/rholang-macros.js) — the `%` registry, one source for both halves
- [`packages/browser/src/macro-lang.js`](packages/browser/src/macro-lang.js) — the `$` language
- [QuCalc extensions](https://github.com/rhovision-org/rholo/blob/dev/docs/src/qucalc/extensions.md) — the system processes these macros call
- [`Governance.md`](Governance.md) — the in-room liquid democracy the `rho:gov:*` macros mirror
- [`SECURITY.md`](SECURITY.md) — threat model
