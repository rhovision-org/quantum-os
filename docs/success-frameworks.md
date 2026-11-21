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

## Group scope

Use existing governance, not a second group model:

1. A charter or objectives are ordinary `/gov` issues.
2. Ratify with `/poll` or `/gov vote`; trust weighting is whatever the group
   already uses.
3. Record the decision with `/lemma` and, if desired, `/persist`.
4. A future compact panel reads those issues/lemmas; it does not own a separate
   group record.

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

Current RhoQu runtime semantics and recipe limitations are:

- Runtime `parallel` runs concurrent local branches, not distributed execution;
  cross-branch mutation ordering is not guaranteed.
- `$LAST_ID` and named bindings use structured results or unique authoritative-store
  ID deltas; display output is never parsed to invent IDs.
- Runtime `when` evaluates at execution time against a fresh room-state snapshot;
  this is not immutable event-log replay.
- Typed RhoProcess IR is the runtime representation; Lean is a separate
  verification/design layer, not a runtime dependency.
- Raw commands end at `|`, so `/poll` options are added with `/poll add`, not
  seeded with `|`.
- `on` syntax is `on <channel>(<binding>) { … }`, not `on channel(<name>)`.

The recipes intentionally use a conservative compatibility subset; runtime behavior
and package limits are documented in [rhoqu-v2-runtime.md](rhoqu-v2-runtime.md).

## AI integration

AI is an assistant, not an authority:

- agents may draft RhoQu, propose a charter/retrospective structure, or summarize
  outcomes;
- generated programs are shown as the expanded command list/diff before
  execution; state-changing commands require explicit confirmation;
- AI cannot sign, move funds, hand off to RhoGov, or bypass `/gov` decisions;
- personal goals/habits are not sent to a model without explicit consent;
- deterministic recipes work with no AI at all.

## What is implemented

- identity-scoped, private `/goal` store and explicit `/goal share`;
- canonical `success-charter/1` builder/validator (no chain call);
- tested RhoQu recipe library using the shipped subset;
- docs and attribution.

## What remains

- chain handoff/status and cross-repo RhoGov work (#291);
- a compact personal/group panel;
- RhoQu v2 process-package UI integration and end-to-end source → IR → command
  golden compatibility evidence for #290;
- AI-assisted authoring with preview/approval integration (see #132).
