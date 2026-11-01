# Rholang & macros

Detail split out of [CLAUDE.md](../CLAUDE.md). Covers the Interact2 `$`/`+` macro
language, the `%` capability-macro registry, and the `/rholang` chain client.
Reference docs: [RChain_Macros.md](../RChain_Macros.md) (design & history),
[MacRhoLang.md](../MacRhoLang.md) (the user's guide — no rholang assumed).

---

## Macros — Interact2 (`/macro`, `+name` — `macro-lang.js` + `app.ts`)

User-written commands. EIES let a user write a command, share it, and watch a
group adopt it; that was the point of the system rather than a feature of it
(`EIES_Legacy.md`). The direct predecessor is **MacRhoLang / @RHO-bot**, which
already had `$` sites, `define:`/`echo:`/`find:` and command-form invocation.
Full reference in [RChain_Macros.md](../RChain_Macros.md); summary for code work:

**`/` is what the app ships, `+` is what a person wrote.** The verbs that manage
definitions are built in (`/macro define|list|show|find|echo|remove`); what they
produce is invoked `+name args`. `++text` escapes a literal `+` line to chat, and
only an identifier-shaped name is read as an invocation — so `+1` is agreement,
not a call.

**Three kinds, decided by the body** (`bodyKind()`): first non-blank line starts
`/` or `+` → **command** (invokable `+name`); the body has rholang syntax (a `!`
send, a `` `powerbox` `` name, `for`/`match`/`contract`/`new … in {`, `<-`,
`=>`) → **rholang** fragment (a `$name(…)` call site inside `/rholang
eval|deploy|echo`); anything else → **text** (substitution only — `$name` yields
its body). Nothing declares the kind, and `macroFromWire` re-derives it from the
body rather than believing the sender, so peers cannot disagree. A bare `$name`
line for a room macro is **shown, not run** (`showRoomMacro`) — a stray `$x`
never signs a deploy; `/rholang eval $name(…)` / `deploy` run it explicitly. A
`+command` reaches the chain by having `/rholang eval` in its body.
`/macro edit <name>[(args)]` opens the editor on the definition.

**The two halves have different lexical rules, and this is the subtle part.**
`substitute` and `expandCallSites` take `lexical: "rholang" | "text"`:

- *rholang body* — `"$topic"` is a string literal and `$topic` is text (the
  language's own rule); a call-site argument is a **term**, so `$print("hello")`
  must expand to `stdout!("hello")` with the quotes intact.
- *command body* — there are no string literals. `/gov say on "$topic" now` is a
  line somebody typed and `$topic` **substitutes**; an argument is a **word**, so
  `+standup "Q4 budget"` binds `Q4 budget`. Treating command text as rholang
  produced a command with a literal `$topic` in it, which is the worst kind of
  wrong: it runs.

`bindArgs(def, args, plain)` carries the same split (`plain` = command line).
A nested macro is expanded under **its own** body's rules, not its caller's.

**Binding is textual**, which is what makes quantum-os#65's `match [$height] { [height] =>
… }` work rather than something separate from it — the argument lands in the
match subject and rholang's own `match` binds it, so a body stays ordinary
rholang. Positional by default; if *every* argument is `name=value` they bind by
name; mixing is refused.

**`splitBody`**: a line beginning with `/` or `+` at column 0 starts a command,
anything else continues the one before it — so a multi-line rholang program is
the argument to `/rholang eval` with no terminator.

**Errors never abort.** Every site is attempted and a failed one is left exactly
as written. `$` being lexically illegal in rholang is what makes that safe: an
unexpanded site is a hard error at rnode, never something that quietly means
the wrong thing. (`%` is rholang's modulo operator, so it carries no such guarantee.)

**Storage is your browser, not the room and not the chain.** `macroStore` is a
module-level `const` — **not** in `RoomContext` — persisted `qos-macros` (one
key, not per room; a one-time migration folds any legacy `qos-macros-<room>`),
loaded once at startup. A macro you write or pick up follows you into every room
you join. It is still a dyncap-signed `macro-define` broadcast, replayed to a
room's joiners via `sync-macros`, so peers get it and it persists for them too.
Removal tombstones are per-browser as well (`macroTombstones` /
`qos-macro-tombstones`, `isMacroTombstoned` / `tombstoneMacro`), so a
`sync-macros` in a *different* room cannot heal back one you retracted — the
generic `retract` machinery (kind `"macro"`) still carries the wire envelope.
**First writer wins a name and only that author may redefine or retract it,
matched by dyncap `anchor`** — `MacroDef` stores the anchor rather than a chain
step, because a reload mints a new peerId and would otherwise cost you your own
commands. This is the *personal* tier of EIES's personal → group → system
hierarchy; the on-chain dictionary (public / federated tier, behind a
capability) is designed and not built.

Recursion is bounded twice: `MAX_DEPTH` inside expansion, and `MACRO_RUN_DEPTH`
in `runMacroLine` for a body that invokes another body at runtime. `runInput()`
is the router — `+` to `runMacroLine`, anything else to `handleCommand` — and is
what `/script` and `/rhoqu` call so their segments can be `+commands` too.

## Reaching a chain (`/rholang` — `rholang.ts` + `rholang-macros.js` + `rholang-pipeline.ts` + `rholang-agent.mjs`)

Bridges a room to an RChain chain: a room's state is ephemeral, a deploy is not.

**`/rholang` is the current command** (`packages/browser/src/rholang.ts`). Three verbs over rnode's HTTP API: `status`, `eval` (exploratory deploy — runs read-only over finalized state; pure rholang and the system processes both return values), and `deploy` (secp256k1 over blake2b256 of the protobuf encoding of `DeployDataProto` — the encoding must match rnode's byte for byte, proto3 default-omission included). `eval`/`deploy` open a syntax-highlighted, live-linted editor (`rholang-editor.ts`) whose header carries **the node and its live status** — version, shard (flagging a mismatch with yours), block height and phlo floor, checked when the editor opens and again on click, because the answer goes stale while the editor is open and pressing Evaluate is the wrong way to find out — and that offers four actions: **Explain** (what the program will do: where it goes, what it costs, which powerbox names it reaches and what each answers, which macro sites expand, and a warning when nothing is sent to `return`, or when a `return!(…)` sends other than one value (`return!(a, b)` / `return!()` — the wrapper receives `return` with a single binder, so a polyadic send reduces to nothing and the run looks empty; `returnArityIssue`, also checked and warned at run time) so the run would look empty — assembled from what the app knows, never a reading of the program's meaning. What explaining actually wants is somebody who can **read** the program, which is an **AI agent in the room** and not an rnode — so the agent leads: **`/rholang explain [program]`** is the verb, and asking is what it does: the program and the question ("explain this rholang program and any security concerns, briefly") go to the room, where the agent reads them and answers where everyone can see. The editor's **Explain** button gives the same account *without* asking the room, and prefills `/rholang explain …` instead — the difference is who decided to publish the program, which should stay the person rather than the button, and when none is, it says so, because that is the missing piece rather than a missing node. Whether the rnode answers is a footnote after it, since Explain is useful with no rnode at all; a shard mismatch is still flagged, because it rejects a deploy), **Show** (the expanded program in the form it would be sent, sending nothing — the answer to *should I sign this*; `/rholang show` is accepted alongside `echo`, after MacRhoLang's own name for it), Evaluate (Ctrl+Enter) and Sign-and-deploy (Ctrl+Shift+Enter), the typed verb only deciding which is primary, so the choice between running a program and paying to land it in a block is made once you can see the program; it resolves `{source, mode}`, Esc cancels, and it loads a `.rho` from disk, accepts one dropped on it, or saves the program back out; a program written inline runs as typed. Every program is wrapped in `new return, stdout, zfa, grant, verify, fuse in { … }` — but when the body is already a single top-level `new … in { … }` (a program written that way, or any `$macro` expansion — `splitTopNew`), those declarations are **merged into that one `new`** rather than nesting a second layer, deduped by binding name so a body's own `stdout`/`deployerId`/… wins. A deploy additionally writes what `return` answered to the deployer's own registry slot (`rho:registry:insertSigned:secp256k1`, at the uri `registryUriOf` derives from the key) and to stdout, because a deploy otherwise answers only into rnode's log. `/rholang read` looks that slot up; the nonce advances per write and `/rholang nonce` re-syncs it from the slot. The slot also carries the nonce alongside the value (`readResultRecord`), so `/rholang read` — and the brief poll after a deploy (`readResultsFresh`) — can tell a fresh answer from a leftover: if the slot is at an *earlier* nonce than your last deploy wrote, that deploy sent nothing to `return` (it errored, or has no `return!`), and `/rholang read` says so and checks the block (`deployFate`) rather than printing the stale value as if it were the result. `bin/rnode` ships with the repo and `scripts/localnet/run-node.sh` starts it — no build, no rholo checkout. A deploy executes and is charged there, and both `eval` and `deploy` reach the qucalc powerbox — verified against rholo `dev` at `0a2141be1`. `match` selects the branch it should — first written branch wins, `_` is reached only when nothing before it matches — and a runaway term returns `reduction step budget exceeded (10000 steps)` with rnode still serving, the ceiling nowhere near ordinary work (a terminating recursion returns at depth 2560). **One shape to avoid** ([rholo#19](https://github.com/rhovision-org/rholo/issues/19)): a one-binder persistent receive inside a nested `new` does not terminate, so every `contract` takes at least two parameters — `contract c(_, ret) = { … }` where a verb genuinely takes only a return channel. Note the budget error arrives as a bare JSON string where success is a `{expr, block}` object, so a client written for the success shape renders a runaway as an empty result. Several sends to `return` all come back but in no dependable order (`eval` reverses source order; the deploy read path differs) — encode order in the program if it matters, and `/rholang eval` says so whenever it prints more than one value. `renderExpr` turns rnode's wire shape into rholang: `ExprPar` reads as `12 | 14 | 16` (the program's own `|`), and an expression a future build names differently renders its contents rather than printing raw JSON at whoever ran the program (`test/render-expr.test.mjs`, payloads taken from a live node).

**Macro call sites expand before a program is linted or signed.** One sigil, `$name(…)`, for both the built-in capability library that ships with the app **and** what the room defined with `/macro` (see the Interact2 section above) — built-ins resolved first, an unknown `$name` left for the room pass. `%name(…)` is a **deprecated alias** kept for older programs. `/rholang macros` lists the built-ins, `/rholang macro <name> <args…>` runs one on its own when the whole program is that macro, and `/rholang echo` shows the expansion — which is what answers *should I sign this*. Full reference in [RChain_Macros.md](../RChain_Macros.md).

**`$name(…)` as a room line.** Typed as its own line (routed by `runInput` alongside `+`), `$name(…)` runs the macro directly: `$verify(@x)` is answered in-browser; `$balance($me)` runs an unsigned `/rholang eval`; `$transfer(10, "1111…")` / `$anchor(…)` open the deploy path; `$( new x in { $anchor(…) } )` is a full inline program (deploy unless every site is a read). `macroMode(name)` in `rholang-macros.js` decides — `read-local` / `eval` / `deploy` / `null`.

**`$macro(…) as <pattern> { …block… }` — capture.** A macro that opts in (`capture: true` — `$balance`, `$transfer`, `$grant`) binds its result by `<pattern>` and runs a supplied block instead of reporting to `return`: `$balance($me) as bal { stdout!(("balance", bal)) }` expands to `… *ret) | for (@bal <- ret) { stdout!(("balance", bal)) }`. Without `as`, the macro's own reporting runs (a value on `return` for eval / the deploy record). With `as`, the block runs instead — the composition primitive: `$transfer(10, a) as (_, err) { $balance($me) as b { return!(("done", err, b)) } }`.

`<pattern>` is a name, `_`, a literal (`Nil` / a number / a string), **or** a balanced `(a, b)` / `[a, …rest]` — anything a rholang `for (@<pattern> <- …)` accepts. A single arm is a plain bind — the `for`'s own pattern does the matching, so it only fires when the reply matches. **Match the shape the macro replies** (each capture macro's `help` states it):

| macro | reply the block sees |
|---|---|
| `$balance` | the balance, an integer — `as bal { … }` |
| `$grant` | the minted capability (raw reply) — `as cap { … }` |
| `$transfer` | **`(result, error)`** — `result` is `("transfer ok", amount, to)` on success and `Nil` on failure; `error` is the failure string or `Nil`. (The raw revVault reply is just `Nil`/a string; the macro normalises it to this two-slot shape for both capture *and* its default reporting.) |

**`as <pat> { … } <pat> { … } …` — one arm per pattern.** Repeat `<pattern> { block }`; two or more arms become a `match` over the reply, each `<pattern>` a match pattern:

```
$transfer(50, a) as (ok, Nil) { return!(("paid", ok)) }
                   (Nil, err) { return!(("failed", err)) }
```

expands to `… | for (@__reply <- __outcome) { match __reply { (ok, Nil) => { … } (Nil, err) => { … } } }` (over `ret` for `$balance` / `$grant`). Arm collection stops as soon as what follows is not `<pattern> {`, so the rest of the program (`| more`, a closing `)`) is left alone.

A non-`capture` macro rejects `as`; an unbalanced pattern, or `as` with no `<pattern> { … }`, is a reported error. An **unclosed** arm block (`as <pat> { …`) is treated as a *continuation* — a multi-line block still being typed — so the editor's live linter waits rather than flagging it (`expandProgram` returns it in `incomplete`, not `errors`); running it anyway reports "block not closed — add the closing `}`".

**`$me`** is a client-side token — resolved to this browser's own REV address (a quoted rholang string) in `expandRholangMacros`, before the program reaches rnode. Write it bare, anywhere a program is built (a `$`-line, the editor, a larger program): `$balance($me)`, `$transfer(10, $me)`. It is not a macro call site (no parens) and only exists where the deploy key is known — `rho:rchain:deployerId` is unbound in an exploratory deploy, so it cannot be resolved on the node. (Bare `me` still works in a `$balance(me)` chat line for convenience.)

**The body is rholang, not a command line.** A program is one line or many, with call sites written `$name(arg, …)`. The rholang is **not parsed**: `expandProgram` scans only far enough to find call sites that are really call sites (skips string literals and both comment forms, balances `()[]{}`, splits args on top-level commas), expands each in place, and passes every other byte through as written. A sigil is what makes that safe without a grammar — a bare `ballot(…)` is indistinguishable from a real contract call. Errors never abort: every site is attempted, each error carries its line, and a failed site is left exactly as typed. **Why `$`:** it is **lexically illegal in rholang**, so a leftover `$name(…)` is a hard error at rnode — never silent. `%` is rholang's modulo operator and would not be caught, which is why it is only a deprecated alias (an unknown `%name(` is reported; an unknown `$name(` is left for the room pass).

**Single source of truth.** `packages/browser/src/rholang-macros.js` is plain JS with no imports, consumed by **both** halves — `scripts/qos-cli/rholang-macros.mjs` (18-line binding, node) and `packages/browser/src/rholang-pipeline.ts` (browser). The ZFA kernel is *injected* (`createMacroEngine(kernel)`) because each side has its own build (`zfa.mjs` / `zfa.ts`). They were once separate copies; a macro edited in one and not the other meant the rholang a user reviewed in chat was not the rholang their browser signed, and both copies independently carried the same `Number()` precision bug.

**Zero-trust split.** The agent only *expands*, in the open, into room chat. The browser lints (`crates/zfa-core/src/lint.rs` via WASM), signs (key generated locally, wrapped by a passphrase-derived AES key in IndexedDB), and deploys. A compromised agent can post misleading chat text and nothing more.

**20 macros**, mirroring the `qucalc/examples/*.rho` in rholo: proofs (`grant`, `fuse` → `rho:qucalc:*`), group decisions (`trust`, `weights`, `tally`, `censure` → `rho:gov:*`, plus `ballot`/`delegate`), bearer capabilities (`issuer`, `note`, `redeem`, `directory`, `mailbox`, `group`, `transfer`), and structural patterns (`swap`, `philosophers`, `multisig`). Arg types: `string`, `twists`, `list`, `cap`, `int` (BigInt decimal digits), and `term` (a rholang term passed through verbatim — the `rho:gov:*` maps; program-form only, since the bare form splits on whitespace).

**What is not enforced.** There is no forbidden rholang and no forbidden name. The expander does not content-police arguments and the linter checks only delimiter balance. Capability security decides what a deploy can reach; a denylist decided nothing rnode does not already decide while rejecting ordinary input ("New York", `for(`). What *is* enforced: every string reaches rholang through `JSON.stringify` into a literal so it cannot escape its position, and amounts are BigInt so the value approved is the value signed.

**Known gaps.** The browser signs **ECDSA P-256** where RChain needs secp256k1 (Web Crypto has no secp256k1) — a pipeline placeholder, nothing signed today is valid on a real network. Macros expand to *standalone* programs (`new ret in { … }`), so embedding one mid-expression yields rholang the linter rejects. The agent and browser halves are not yet a closed loop.

**Local testing.** A single standalone node runs everything: `rnode run -s --autopropose --no-upnp --host 127.0.0.1 …` (`--host` matters — without it the node guesses an external IP and Kademlia fails to bind). Ports 40401 external gRPC / 40402 internal (eval, propose, repl) / 40403 HTTP. `rnode --grpc-port 40402 eval f.rho` runs rholang with no signing and no block — the fastest loop. `No value set for `rho:qucalc:zfa`` means the node is running a build from before the QuCalc processes landed; a running node keeps its binary image after the file on disk is replaced.

## "It worked but reported nothing" — the result slot is not written everywhere

A deploy's answer normally reaches you through the **deployer key's registry result
slot**: `wrapProgram` wraps the program so a send to `return` is forwarded there with
`rho:registry:insertSigned`, and `readResults` / `/rholang read` fetch it back. One key,
one slot, one job.

**That slot is not written on every node.** Measured on the rebuilt playground: a deploy
that came back `ProcessedWithSuccess` left the key's slot at `nonce: null`, so a program
that ran perfectly reported nothing at all. The deploy is fine; the readback is not.

It is worth knowing because the symptom is never "the readback is broken" — it is whatever
the caller concluded from an empty answer, and it has been three different-looking bugs:

| what it looked like | what it was |
|---|---|
| `locker.js`: every verb answered nothing | the answer went only to `return` |
| `rgov-core.js`: "installed, but no uri came back" | same |
| the room agent's faucet: *"couldn't confirm the transfer"* for transfers that **had landed** | same — and no wait would ever have helped |

**The fix is to answer somewhere else as well.** `rho:rchain:deployId` comes back inside
the deploy's own `/api/v1/deploy-status/<sig>`, which is not subject to this, so a program
that wants to be readable sends to both:

```rholang
for (@answer <- ret) { return!(answer) | deployId!(answer) }
```

`deployAnswer(cfg, sig)` in [`rholang.ts`](../packages/browser/src/rholang.ts) reads that
path, and `/rholang deploy` falls back to it before reporting silence. `locker.js` and
`rgov-core.js` both answer on both channels.

**Where there is nothing to read, confirm by the effect instead.** A REV transfer is the
clearest case: the macro answers on `return` only, so rather than reading a value the room
agent's faucet reads the *recipient's balance* before and after, and checks the deploy's
status for an error. That confirms the thing the user actually cares about, and it cannot
be defeated by a readback path that is missing.
