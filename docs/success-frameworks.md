# Success frameworks

Personal effectiveness and group alignment on top of primitives QuantumOS
already has: dyncap identity, rooms, `/gov`, `/poll`, `/lemma`, `/note`,
`/channel`, `/qos`, RhoQu, and agents.

This is a product layer, not a QOS/1 kernel change. It adds no account system,
no parallel group store, and no central profile.

## Personal scope — `/goal`

Goals are **local to the dyncap identity** and private by default.

```text
/goal add <text> [| urgent-important|important|urgent|neither]
/goal list
/goal done <id>
/goal review
/goal remove <id>
/goal share <id>
```

- Stored under `qos-goals:<dyncap-anchor>` in the browser's local storage.
- A different identity sees a different goal list; `/login` restore drops the
  old store handle and opens the new identity's store.
- `/goal` never broadcasts. There is no sync, no server write, and no signing of
  private habit ticks.
- `/goal share <id>` is the only network path. It sends one goal as a signed
  `goal-share` envelope; the receiving peer verifies the dyncap and displays it.
- A corrupt or refused local store starts empty for the session; it does not
  break the room.

The goal store is implemented in `packages/browser/src/goal-store.ts` and tested
in `packages/browser/test/goal-store.test.mjs`.

## Compact success overview (#289)

The sidebar's **Goals & group overview** button opens an identity-local
priority matrix with explicit Add/Complete actions alongside a read-only
snapshot of the currently selected room's existing /gov groups and issues.

- The personal section uses the existing identity-scoped GoalStore. There
  is no implicit sharing, network request, or additional persistent model.
- Only group name, member/issue counts, and issue title/status/poll-link
  presence are projected. No vault contents, credentials, or raw chain
  references are copied to the panel.
- A configured chain reference is not proof of ratification. The overview
  does not claim that a governance gate has passed.
- User text is rendered through safe DOM text nodes, never interpreted as HTML.
- Switching rooms changes group data; restoring an identity changes the
  private goal projection.
- The focused test (packages/browser/test/success-panel.test.mjs) checks
  privacy boundaries, snapshots, event wiring and text rendering. Full browser
  end-to-end and chain verification remain outside this UI increment.

The implementation lives at packages/browser/src/success-panel.ts and reuses
the current browser app. No QOS/1 ABI, authorization, or on-chain change.

## Private habit check-ins and review history (#289)

The existing identity-scoped GoalStore now contains goals, habits and local
review records under the same key, qos-goals:<dyncap-anchor>. Schema v1 goals
are loaded transparently; subsequent writes use v2 while preserving IDs.

- /goal habit add <text> [| daily|weekly] creates a local cadence.
- /goal habit tick <id> records one UTC-day check-in idempotently.
- /goal habit list and /goal habit remove <id> inspect/delete local habits.
- /goal review note <text> snapshots open/completed goals, today's completed
  check-ins and a private narrative note; /goal review history lists records.
- The Success overview panel offers the same add/check-in/review controls.
- Check-ins and notes never enter the explicit /goal share snapshot. No
  broadcast, signature, central profile, or second persistent store is added.
- Local history is bounded (366 dates per habit; 100 review records per
  identity). Counts are local snapshots, not governance verdicts.

The dedicated regression suite covers v1 migration, per-anchor isolation,
UTC check-in idempotence, bounded history, defensive copies, and no network
side effects: node packages/browser/test/success-habits.test.mjs.

## Group scope

Use existing governance, not a second group model:

1. A charter or objectives are ordinary `/gov` issues.
2. Ratify with `/poll` or `/gov vote`; trust weighting is whatever the group
   already uses.
3. Record the decision with `/lemma` and, if desired, `/persist`.
4. The compact success overview reads existing issues (without duplicating
   group state or asserting a ratification verdict).

Adding charter metadata to `Group` later needs a signed, admin-gated
`group-meta` mutation with merge rules. It is not in this slice.

## Required RhoGov handoff

The handoff is **required**, not optional. A group charter is not complete until
it can be handed off for multi-stakeholder ratification and recorded on chain,
while the off-chain record remains the working source of truth.

The canonical artifact is `success-charter/1`, built and validated in
`packages/browser/src/success-charter.ts`. See
[success-charter.md](success-charter.md) for fields, hashing, the handoff
lifecycle, status, and the rule that a raw `cap:room:…` must never be exported.

The chain submission/status action remains tracked in
[#291](https://github.com/rhovision-org/quantum-os/issues/291); this slice
provides the artifact builder/validator and its tests. There is no silent chain
write in `/goal`, `/charter`, or RhoQu.

## The seven practices

These are generic, open practices—not a proprietary programme.

| Practice | Existing primitives | First step |
|---|---|---|
| Self-ownership / proactivity | local `/goal`; `/gov trust` for group accountability | private goal store |
| Vision / alignment | `/gov issue` for charter/objectives; `/poll`; `/lemma` | charter as an issue |
| Strategic prioritization | `/poll ranked`; `/estimate`; local goal priority | `/goal` priority |
| Collaborative value | `/note` terms; `/rdv` swaps; `/gov issue`; `/lemma` | agreement as issue + record |
| Empathetic communication | `/facil chair`; `/ask`; `/channel` | structured listening round |
| Collective intelligence | `/search`; `/solve`; `/poll`; `/estimate`; `/probe`; `/qos` | reuse; no new storage |
| Continuous renewal | `/poll` retrospective; `/gov kudos`; `/lemma`; recurring `/qos` | retro poll + private review |

Attribution: Eisenhower decision matrix, objectives and key results, SMART
criteria, Kaizen, and active listening are public methodologies. This document
does not reproduce proprietary framework text or slogans.

## RhoQu recipes

The starter library lives in `packages/browser/src/success-recipes.ts` and is
documented in [rhoqu-success-recipes.md](rhoqu-success-recipes.md). Every recipe
is transpiled by `packages/browser/test/rhoqu-success-recipes.test.mjs`.

Current RhoQu limits are real and tested:

- `parallel` is **sequential** expansion today; no concurrency.
- No `$LAST_ID` / output binding; ids must be copied manually.
- `if` is evaluated at **transpile time**, not execution time.
- No formal RhoProcess IR; Lean RhoQuCalc is the verified design layer, not the
  runtime.
- Raw commands end at `|`, so `/poll` options are added with `/poll add`, not
  seeded with `|`.
- `on` syntax is `on <channel>(<binding>) { … }`, not `on channel(<name>)`.

These are tracked in
[#290](https://github.com/rhovision-org/quantum-os/issues/290). Recipes in this
slice use only the shipped subset and do not imply the missing features.

## RhoQu surface IR serialization (first #290 increment)

The existing parser now exposes a versioned JSON-compatible surface plan:
compileRhoQuSurfaceIR(source) yields a rhoqu.surface.ir/1 record, and
lowerRhoQuSurfaceIR(record, context) emits the same legacy command sequence.
The ordinary transpile() call uses this compile-then-lower path.

- The IR carries process definitions, command statements, compile-time
  conditions and on-handler declarations. Parsing has no dispatch or handler
  registration side effects.
- Lowering validates the whole structure, rejects unknown schema or execution
  semantics, duplicate process definitions and malformed nodes, and bounds
  nesting/work to avoid untrusted imported-plan expansion.
- The execution mode is explicitly compat-sequential. In particular,
  parallel blocks retain their historical ordered expansion. This version
  provides no concurrent execution semantics or automatic capability grant.
- On-handler registration occurs only when lowering is explicitly invoked with
  a context. Importing or parsing JSON does not execute commands.

This is a serialization and compatibility foundation, not the effect-typed,
Lean-related, runtime-branching RhoProcess execution IR sought by #290.
It does not implement structured command results, output ID binding,
exec-time conditions, concurrency, or shareable process-package authority.

The regression suite at packages/browser/test/rhoqu-surface-ir.test.mjs covers
JSON round-trip replay, golden command equivalence, handler deferral, and
fail-closed malformed/tampered plans. Legacy RhoQu success recipes still pass.

## AI integration

AI is an assistant, not an authority:

- agents may draft RhoQu, propose a charter/retrospective structure, or summarize
  outcomes;
- generated programs are shown as the expanded command list/diff before
  execution; state-changing commands require explicit confirmation;
- AI cannot sign, move funds, hand off to RhoGov, or bypass `/gov` decisions;
- personal goals/habits are not sent to a model without explicit consent;
- deterministic recipes work with no AI at all.

## RhoQu authoring preview / explicit approval

An agent may draft a source program, but it never obtains the room execution
authority. The owner must inspect the exact lowered commands through:

    /rhoqu preview process P(x) { /lemma $x; } P(example);
    /rhoqu approve <24-hex-token>
    /rhoqu cancel <token>
    /rhoqu pending

Preview is side-effect-free: any on-handler registration is captured, not
installed. The exact expanded commands and handlers are presented in the
local transcript. Approving requires both the opaque one-use token and a
browser confirmation dialog. Approval tokens are bound to room, dyncap
identity, and a snapshot of relevant room state and expire after 10 minutes.
A room/identity change, intervening state drift, expiration or replay causes
a refusal. Source containing a raw room capability is refused; input length
and expanded command counts are bounded. Dispatch still uses the ordinary
per-command capability/authorization checks. Asynchronous results are not
represented as completed until observed separately.

A directly typed /rhoqu <source> remains available for backwards
compatibility. An imported or generated program should be treated as
untrusted and must use preview/approve, not that legacy direct path.
The system does not autonomously run messages returned by /ask.

Test: node packages/browser/test/rhoqu-preview.test.mjs. This tests the
preflight state machine, not browser confirmation UX.

## What is implemented

- identity-scoped, private `/goal` store and explicit `/goal share`;
- canonical `success-charter/1` builder/validator (no chain call);
- tested RhoQu recipe library using the shipped subset;
- a compact private-goal / read-only-group overview;
- docs and attribution.

## RhoQu v2 opt-in execution and package workflow

The runtime builder, signed package system, and bounded human-authorized
browser adapter are specified in [RhoQu v2](rhoqu-v2.md). Supported new
constructs include actual-ID let bindings and $LAST_ID, runtime when/require,
a read-only concurrently joined branch form, typed effect metadata, and
signed shareable source/IR bundles. The old parallel/if forms remain
compatibility-sequential / compile-time.

An imported package is only previewed. It does not execute until the
operator separately approves the exact local candidate and the browser
confirmation. Signed package integrity does not prove a remote dyncap
anchor/private seed relationship; new public keys use explicit TOFU pinning.

The remainder of #290 is the machine-checkable Lean correspondence,
a reliable event-log-based replay criterion, cross-peer scheduling, and
strong structured outcomes for all potentially irreversible async commands.
These cannot be inferred from unit tests or labeled complete.

## What remains

- chain handoff/status and cross-repo RhoGov work (#291);
- RhoQu v2: output binding, exec-time control flow, real parallelism, and
  RhoProcess IR (#290);
- AI-assisted authoring with preview/approval (see #132).
