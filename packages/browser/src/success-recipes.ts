// success-recipes.ts — starter RhoQu recipes for the success framework.
//
// These use only the shipped RhoQu subset:
//   process / call / $arg / raw /command / transpile-time if / on channel.
// They deliberately do not use `parallel`, `$LAST_ID`, exec-time branching, or
// a formal RhoProcess IR; those are tracked in #290.
//
// Raw commands terminate at `;` or `|`, so recipes avoid `|` (for example,
// `/poll` options are added with `/poll add`, not seeded with `|`).

export interface SuccessRecipe {
  id: string;
  title: string;
  /** Generic practices this recipe helps with; no proprietary framework names. */
  practices: string[];
  source: string;
  notes: string;
}

export const SUCCESS_RECIPES: readonly SuccessRecipe[] = [
  {
    id: "weekly-prioritize",
    title: "Weekly prioritization",
    practices: ["self-ownership", "prioritization", "renewal"],
    source: `process weekly-prioritize(goal) {
  /goal add $goal;
  /goal review;
}

weekly-prioritize("Finish the success framework docs");`,
    notes: "Personal and local: /goal never broadcasts. RhoQu cannot pass a `| priority` inside a raw command today; this recipe uses the default priority.",
  },
  {
    id: "retrospective",
    title: "Group retrospective",
    practices: ["collective-intelligence", "renewal"],
    source: `process retrospective(cycle) {
  /gov issue Retrospective $cycle;
  /channel send feedback What went well in $cycle?;
  /channel send feedback What should improve in $cycle?;
  if peers() >= 2 {
    /poll new Adopt the top improvement;
    /poll add keep;
    /poll add change;
  }
}

retrospective("this cycle");`,
    notes: "Run inside the group. With fewer than two peers the poll is omitted at transpile time.",
  },
  {
    id: "okr-checkin",
    title: "Objectives check-in",
    practices: ["vision", "alignment"],
    source: `process okr-checkin(objective) {
  /gov issue Check-in: $objective;
  /lemma okr-checkin-recorded;
}

okr-checkin("Ship phase 1");`,
    notes: "The issue carries the discussion; the lemma records that the check-in happened.",
  },
  {
    id: "listening-round",
    title: "Listening round",
    practices: ["empathetic-communication", "collective-intelligence"],
    source: `process listening-round(topic) {
  /channel listen listening;
  /channel send listening Round on $topic: each person speaks once;
  /facil chair;
}

listening-round("the charter");`,
    notes: "The facilitator holds the turn; the channel keeps the round tagged.",
  },
  {
    id: "collective-search",
    title: "Collective search",
    practices: ["collective-intelligence"],
    source: `process collective-search(topic) {
  /search $topic;
  /channel send intelligence Search: $topic;
}

collective-search("the next closure");`,
    notes: "/search is async; the channel line records what was searched.",
  },
  {
    id: "renewal-check",
    title: "Renewal check",
    practices: ["renewal"],
    source: `process renewal-check(period) {
  /poll new What should we renew for $period?;
  /poll add keep;
  /poll add change;
  /goal review;
}

renewal-check("next month");`,
    notes: "Group poll plus a private personal review; no output binding is required.",
  },
  {
    id: "feedback-loop",
    title: "Feedback loop handler",
    practices: ["empathetic-communication"],
    source: `process feedback-loop() {
  on feedback(msg) {
    /lemma feedback-received;
  };
  /channel send feedback Ready for feedback;
}

feedback-loop();`,
    notes: "The `on feedback(msg)` handler is registered per room and persists until /rhoqu clear; RhoQu binds the payload to msg.",
  },
];

export function recipeById(id: string): SuccessRecipe | null {
  return SUCCESS_RECIPES.find((r) => r.id === id) ?? null;
}
