# RhoQu success recipes

Starter RhoQu processes for the success framework
([success-frameworks.md](success-frameworks.md)). These use only the shipped
`/rhoqu` subset: process definitions, `$arg`, raw `/commands`, transpile-time
`if`, and `on <channel>(<binding>)` handlers.

They are also exported from `packages/browser/src/success-recipes.ts` and
transpiled by `packages/browser/test/rhoqu-success-recipes.test.mjs`.

## Current limits — do not pretend otherwise

| Limit | Today | Consequence |
|---|---|---|
| recipe coverage | recipes use simple ordered commands and handlers | runtime IR features are not demonstrated by these recipes |
| runtime `parallel` | concurrent local branches | not remote/distributed execution; cross-branch mutation order is undefined |
| runtime `when` | evaluated at execution against a fresh snapshot | not a replay of an immutable event log |
| bindings | unique IDs from structured results or authoritative-store deltas | display output is never parsed to invent IDs |
| raw pipe operator | ends a raw command | `/poll` options use `/poll add`, not pipe seeds |
| process packages | validated JSON, canonical hash, provenance, size/depth limits | package import/export does not itself grant execution authority |

The #290 runtime implementation is documented in
[rhoqu-v2-runtime.md](rhoqu-v2-runtime.md). These recipes remain a compatibility
subset, not a statement that the newer runtime features are absent.

## Weekly prioritization

```rhoqu
process weekly-prioritize(goal) {
  /goal add $goal;
  /goal review;
}

weekly-prioritize("Finish the success framework docs");
```

Private and local. RhoQu cannot pass `| priority` inside a raw command today;
the recipe uses the default priority.

## Group retrospective

```rhoqu
process retrospective(cycle) {
  /gov issue Retrospective $cycle;
  /channel send feedback What went well in $cycle?;
  /channel send feedback What should improve in $cycle?;
  if peers() >= 2 {
    /poll new Adopt the top improvement;
    /poll add keep;
    /poll add change;
  }
}

retrospective("this cycle");
```

Run inside the group. Fewer than two peers omits the poll at transpile time.

## Objectives check-in

```rhoqu
process okr-checkin(objective) {
  /gov issue Check-in: $objective;
  /lemma okr-checkin-recorded;
}

okr-checkin("Ship phase 1");
```

The issue carries the discussion; the lemma records that the check-in happened.

## Listening round

```rhoqu
process listening-round(topic) {
  /channel listen listening;
  /channel send listening Round on $topic: each person speaks once;
  /facil chair;
}

listening-round("the charter");
```

The facilitator holds the turn; the channel keeps the round tagged.

## Collective search

```rhoqu
process collective-search(topic) {
  /search $topic;
  /channel send intelligence Search: $topic;
}

collective-search("the next closure");
```

`/search` is async; the channel line records what was searched.

## Renewal check

```rhoqu
process renewal-check(period) {
  /poll new What should we renew for $period?;
  /poll add keep;
  /poll add change;
  /goal review;
}

renewal-check("next month");
```

Group poll plus a private personal review; no output binding is required.

## Feedback loop

```rhoqu
process feedback-loop() {
  on feedback(msg) {
    /lemma feedback-received;
  };
  /channel send feedback Ready for feedback;
}

feedback-loop();
```

The handler is registered per room and persists until `/rhoqu clear`. The
channel is `feedback`; the payload binds to `msg`. The old illustrative form
`on channel(feedback)` is **not** the parser syntax.

## Running a recipe

```text
/rhoqu process weekly-prioritize(goal) { /goal add $goal; /goal review; } weekly-prioritize("Ship docs");
```

The dispatcher prints how many commands were transpiled and executes them in
order. A failed command does not stop later commands. `on` handlers are
registered instead of executed.

## What these recipes do not do

- They do not create a personal dashboard.
- They do not claim runtime branching or concurrency.
- They do not hand off to RhoGov; that requires the required
  [success-charter](success-charter.md) path.
- They do not send personal goals anywhere; `/goal share` is explicit.
