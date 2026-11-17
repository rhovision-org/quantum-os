# Live Testing — the tests that need two or more people

Everything under `packages/browser/test/` and `scripts/qos-cli/*.selftest.mjs` /
`*.e2e.mjs` runs on one machine with no network (see
[scripts/qos-cli/README.md § Verify offline](scripts/qos-cli/README.md#verify-offline-no-network-no-deps)).
None of it can see what a room actually is: **two real browsers on two real
networks**, behind NATs the tests do not have, through a signaling server with
a rate limit the tests do not enforce, with a TURN relay the tests stub out.
Every connection bug in [docs/connection.md](docs/connection.md) was *reported
live* — a reloaded peer that stays silent, a cross-NAT peer that vanishes from
the roster, a call with no video, an agent pegging a core — and none of them
reproduced in the werift↔werift loopback. This is the plan for finding the next
one on purpose instead of in a meeting.

**Rule:** every test here names at least two participants, the script or
command that drives it, and what "pass" is. Run a test only from the box in the
matrix; when it fails, file an issue with the row id and the observer record
(§ Recording).

---

## Setup — the fixture

| Piece | What | Where |
|---|---|---|
| **Room** | The public test room (**MyRoom**, `cap:room:0521…4721`) — the default of every script below, so no cap needs pasting. For a test that must not be disturbed, mint a fresh cap and share it out of band. | [MyRoom.md](MyRoom.md); fresh cap: `node -e "import('./zfa.mjs').then(z=>console.log(z.generateCapability('room')))"` in `scripts/qos-cli` |
| **P1, P2** | Two humans, two browsers, **two different networks** (home + mobile hotspot is enough; same LAN proves nothing about NAT). One of them on a phone. | — |
| **P3** (some tests) | A third human, or a headless witness: `node qos-cli.mjs --listen` prints everything it receives. | [scripts/qos-cli/README.md § Use](scripts/qos-cli/README.md#use) |
| **Agents** | `bash scripts/qos-cli/run-agents.sh "" facilitator observer` — facilitator for the room's memory, observer to record the session. Add `skeptic` only when a test needs `verify`. Stop with `stop-agents.sh`. | [scripts/qos-cli/run-agents.sh](scripts/qos-cli/run-agents.sh) |
| **Signaling** | The public server, unless the test says otherwise. Its enforced rate limit is the room ceiling: measure it first, don't assume it. | `node scripts/qos-cli/signal-probe.mjs` |

Before the first test each participant runs `/ice test` and pastes the fenced
block into chat — the plan below reads `host` / `srflx` / `relay` off it to know
which pairs *can* connect directly, which is the difference between a bug and a
network.

---

## Recording — every session leaves a record

Start the observer before the first test and stop it after the last:

```
/observer start live-test 2026-09-17 predict: L1 direct or relay; L4 video both ways
… run the tests …
/observer stop
/observer summarize --ai      # optional, an AI summary next to the record
```

That writes `<state>/rooms/<room>/games/<ts>-live-test-….events.jsonl` (every
envelope, raw) and `.json` (polls, estimates, lemmas, chat, participants with
their dyncap anchors), so a failure is reconstructible without anyone having
kept notes. Fill the results table (end of this page) and attach it to the
issue for the run. The facilitator's transcript
(`.qos-facilitator/rooms/<room>/transcript.jsonl`) is the second copy.

---

## The matrix

Ids are stable — refer to them in issues. **Participants** says the minimum;
**Drives** is the script or command; **Pass** is what the room must show.
Known-live-bug rows link the fix so a regression is recognised, not rediscovered.

### L1 — Connect: two networks, one room

| | |
|---|---|
| Participants | P1, P2 on different networks; P3 witness optional |
| Drives | the app's **Connect** button; `/ice test`; `/conn`; `node qos-cli.mjs --listen` as P3 |
| Steps | Both open the room link, click Connect, `/name`. Each runs `/ice test`, pastes the block. Each runs `/conn` and reads the other's state. Each types one chat line. |
| Pass | Both see both names in the roster with **no `⚠`**; both chat lines arrive both ways; `/conn` says `connected` (direct) or the message still arrives via an agent (relay). P3 prints both lines. |
| If not | A peer marked `⚠` whose `/ice test` shows no `relay` cannot cross its NAT — that is the network, and `/ice turn …` on *that* side is the fix ([connection.md § Whether two peers can connect](docs/connection.md#whether-two-peers-can-connect-at-all-ice)). A peer marked `⚠` whose test *does* show `relay` is a bug. |

### L2 — Reload keeps identity and re-announces

| | |
|---|---|
| Participants | P1, P2 |
| Drives | browser reload; `/password`, `/login` |
| Steps | P1 sets `/password`. P1 reloads the tab. P2 watches the roster. P1 types a line. Then P1 closes the tab entirely, opens the link in a new tab, `/login <handle>`. |
| Pass | After the reload P2 sees P1 **by name** (not a bare hex id) within a few seconds, and P1's line arrives. After the new tab, the same. |
| Known bug | The silent-reload bug — a reloaded peer connected but never re-announced (stale pc reused on a fresh ICE session). Fixed by the `ice-ufrag` comparison; **only reproduces in a real browser**, never in loopback ([connection.md § Reconnect = rebuild](docs/connection.md#signaling-reconnect--false-peer-left-right)). |

### L3 — Chat relays where no direct path exists

| | |
|---|---|
| Participants | P1, P2 with **no** direct pair (one on mobile CGNAT with `/ice auto off`), plus the facilitator agent |
| Drives | `/ice auto off` on one side; `node qos-cli.mjs -m "…"` as a fourth voice |
| Steps | Confirm the pair shows `⚠` to each other but both see the agent clean. Each types a line. From a shell, `node qos-cli.mjs --room cap:room:0521… -m "relay probe"` and read the exit code. |
| Pass | Every line reaches everyone (flooded peer→agent→peer); neither peer **vanishes** from the other's roster while marked `⚠`; `qos-cli.mjs` exits `0`. |
| Known bug | The cross-NAT peer that disappeared for everyone who couldn't dial it (ICE `failed` read as "left"). Fixed: `failed` while still in the signaling roster = *unreachable*, retried, not gone ([connection.md](docs/connection.md#signaling-reconnect--false-peer-left-right)). |

### L4 — Calls across networks

| | |
|---|---|
| Participants | P1, P2 on different networks; the facilitator agent **in the room** (so media rejection is exercised) |
| Drives | the call bar (**Call**, mute, camera, share screen); `/record`; `top` on the agent host |
| Steps | P1 starts a call; P2 clicks Call to join. Both speak, both enable camera. P1 shares a screen. P2 `/record`s 20 s of the screen (it captures the screen plus the room's audio, streamed to disk — not the call tiles). Meanwhile watch the agent's CPU. Then repeat with `/ice auto off` on P2. |
| Pass | Audio + video both ways within ~15 s; the shared screen shows on P2; the downloaded recording plays back with P1's audio in it; the **agent's CPU does not rise** during the call (it answered with every media m-line rejected). With the relay off on the CGNAT side, the room prints one line naming the peer that "can't get the call" — the failure is *reported*, not silent. |
| Known bugs | Silent no-video across NAT (quantum-os#126 → default TURN); one call pegging three co-located agents (`_rejectMedia`); sharing a screen alone (PR #86) ([connection.md § Calls must work across networks](docs/connection.md#calls-must-work-across-networks--a-default-turn-relay-quantum-os126)). |

### L5 — Agents answer, remember, and re-serve

| | |
|---|---|
| Participants | P1, P2; facilitator (+ scribe or skeptic as needed) |
| Drives | `run-agents.sh`, `stop-agents.sh`; `/ask …` · `/facil help` · `/facil ask …` · `/scribe list 5` · `/skeptic verify @lemma`; `node pushlemma.mjs` |
| Steps | P1 `/ask` a question and confirm the `→ asked the facilitator` line; P1 `/facil ask` again to address it directly. P2 `/scribe list 5`. P1 `/lemma Live test @works \| ^v`. **Stop the agents, restart them**, P2 leaves and rejoins. From a shell `node pushlemma.mjs --room … --select works`. |
| Pass | `/ask` names the facilitator it chose; each agent replies **as itself** (signed name, not through another). After the restart the rejoining P2 receives the lemma from the agent's `sync-lemmas` (memory survived). `pushlemma` lands the lemma on peers that were already connected. |
| Reference | [scripts/qos-cli/README.md § Agents](scripts/qos-cli/README.md#agents-facilitator-scribe-greeter-) and § memory daemon |

### L6 — Deciding together

| | |
|---|---|
| Participants | **three** voters (P1, P2, P3 — a headless P3 cannot vote; use a third human or a second browser profile on a different network) |
| Drives | `/poll new … \| a, b, c` · `/poll vote` · `/poll lock` · `/poll close`; `/poll new … ranked`; `/estimate new …` · `/estimate <n>`; `/lemma` · `/persist @x to <peer>` · `/persist accept`; `/probe` |
| Steps | Approval poll: all three vote, P2 **re-votes**, P1 locks, closes. Ranked poll with a genuine IRV runoff (no first-round majority). Estimate round with one deliberately absurd value. P1 records the outcome as a lemma and asks P2 to persist it; P2 accepts. Then P3 **reloads** and everyone reads `/probe`. |
| Pass | All three tallies agree on every browser (the poll is joiner-local, so they must be computed identically); re-vote replaces, never adds; the IRV runoff eliminates and transfers; the estimate reports the **median**, unmoved by the outlier; the lemma is on P2 after accept; `/probe` shows no discrepancy after the reload. |
| Reference | [Group_Decisions.md](Group_Decisions.md), [Consensus.md](Consensus.md) |

### L7 — Governance: trust, delegation, a weighted vote

| | |
|---|---|
| Participants | three members |
| Drives | `/gov new` · `/gov member add` · `/gov trust <m> <n>` · `/gov delegate <m>` · `/gov issue` · `/gov vote` |
| Steps | P1 creates the group and adds P2, P3. P1 confers trust on P2 (below P1's own), P2 on P3. P3 delegates to P2. P1 opens an issue; **only P1 and P2 vote**, opposite ways. |
| Pass | The tally is trust-weighted and P2's vote carries P3's delegated weight, so the outcome is the one the weights dictate, identically on all three browsers; a member cannot confer a level ≥ their own (the command refuses). |
| Reference | [Governance.md](Governance.md) |

### L8 — The substrate agrees with itself: `/search`, `/solve`

| | |
|---|---|
| Participants | P1, P2 (P3 if available) |
| Drives | `/qlf-action` · `/search` · `/solve` |
| Steps | Each peer posts a different `/qlf-action`. Each runs bare `/search` and bare `/solve` (the joint position). |
| Pass | Every browser prints the **same** `/solve` answer (or the same residual) — it is a deterministic cascade, so any difference is a bug in the port or in the joint position each peer assembled. `/search` counts agree. |
| Reference | README § `/search` · `/solve`; the Python reference is `quantum-logical-framework/qucalc_search.py` |

### L9 — Two rooms, one bridge

| | |
|---|---|
| Participants | P1 in room A, P2 in room B, the bridge process |
| Drives | `node bridge.mjs --rooms A B [--chat] [--lemmas]`; `/channel listen x` · `/channel send x …`; `/share @lemma to <room>` |
| Steps | Start the bridge over MyRoom and a fresh cap. P1 `/channel send x hello-from-A`; P2 listening on `x` in B. Reverse. With `--lemmas`, P1 `/lemma`s and P2 checks it arrived **signed by P1**. P1 who has both tabs `/share`s a note across. |
| Pass | Channel messages cross both ways exactly once (no echo loop); a bridged lemma verifies against P1's signature in room B; `/share` re-enacts in the target tab. |
| Reference | [Room_Bridges.md](Room_Bridges.md) |

### L10 — A recorded game (the #137 instrument)

| | |
|---|---|
| Participants | **three or more** humans; the observer agent |
| Drives | `/observer start <label> payoffs a,b,c,d stag="…" hare="…" predict: …` · a `/poll` · `/lemma` · `/observer stop` · `/observer summarize`; then `python3 game_log_analysis.py <record>.json` in `quantum-logical-framework` |
| Steps | Pre-register a Stag Hunt (e.g. `payoffs 4,0,3,2`). Round 1: a poll between the ambitious and safe options, cold. Someone `/lemma`s a public commitment. Round 2: the same poll. Round 3: the poll re-scored by the shared objective (name "welfare" in the question). Stop. |
| Pass | The observer's start reply names payoff-dominant, risk-dominant and `p*`; the stop reply counts the polls/lemma; the `.json` scores P1/P2/P3 as held / killed / not testable — **any verdict passes the test**; the predictions are what's under test. |
| Reference | [Collective_Optimization.md](Collective_Optimization.md), `quantum-logical-framework/Game_Theory_QLF.md` § 7 |

### L11 — Room size: past five peers

| | |
|---|---|
| Participants | **six or more** (humans + `qos-cli.mjs --listen` witnesses count — the overlay is about connections, not people) |
| Drives | `node signal-probe.mjs` first; `/conn` on every peer; `node ring-neighbors.mjs` to predict who should be linked to whom |
| Steps | Bring six peers in one at a time. After each join, one chat line from the newest peer. At six, one call. |
| Pass | Every line reaches every peer (through the ring + skip-links, not a full mesh); `/conn` shows degree ≤ 4 on each peer past five; the join rate stays under the probed signaling limit so no handshake is starved. The call at six shows who is **not** pinned — that is the open item quantum-os#111, expected, record it. |
| Reference | [connection.md § How many people a room holds](docs/connection.md#how-many-people-a-room-holds), § bounded-degree overlay |

### L12 — A chain deploy from the room (optional — needs localnet)

| | |
|---|---|
| Participants | P1, P2; the `/rholang` agent (`node rholang-agent.mjs --room …`); a running localnet (`scripts/localnet/run-node.sh`) |
| Drives | `/rholang …` macros; the atomic-swap walkthrough |
| Steps | Follow [ExchangeDemo.md](ExchangeDemo.md) / [AtomicSwapDemo.md](AtomicSwapDemo.md) with P1 and P2 as the two parties, including the **abort** path. |
| Pass | Both legs commit, or both abort — never one of each; the browser signs, the agent never holds a key. |
| Reference | [docs/rholang.md](docs/rholang.md), [scripts/qos-cli/README.md § RChain capability macros](scripts/qos-cli/README.md#rchain-capability-macros--the-rholang-agent-rholang-agentmjs) |

---

## Which rows to run when

- **Every release / every change to `peer.ts`, `qospeer.mjs`, `calls.ts`, `app.ts` connect path:** L1, L2, L3, L4. These are the ones that have been wrong live and cannot be caught offline. Twenty minutes with two people.
- **Any agent change:** L5 (+ L10 if the observer or advisor moved).
- **Any decision/governance change:** L6, L7.
- **Any change to `qucalc-enum.ts` / `zfa.ts`:** L8 (the offline conformance block catches drift from the Python; L8 catches peers assembling different joint positions).
- **Bridges, signaling deploys, rate-limit changes:** L9, L11.
- **Quarterly, regardless:** the whole matrix — it takes an afternoon and finds what nobody changed.

---

## Results table (copy into the run's issue)

```
Live test run — <date> — room <cap or "MyRoom"> — observer record <file>
Participants: P1 <name/network>, P2 <name/network>, P3 <…>
Signaling limit (signal-probe): <n/s, burst>

| Row | Result | Notes / issue |
|-----|--------|---------------|
| L1  | pass / FAIL / skipped | ice: P1 host,srflx,relay · P2 srflx,relay |
| L2  |        |               |
| L3  |        |               |
| L4  |        | agent CPU idle __% → in call __% |
| L5  |        |               |
| L6  |        |               |
| L7  |        |               |
| L8  |        |               |
| L9  |        |               |
| L10 |        | verdicts: P1 … P2 … P3 … |
| L11 |        | n = __ peers |
| L12 |        |               |
```

---

## Related

- [scripts/qos-cli/README.md § Verify offline](scripts/qos-cli/README.md#verify-offline-no-network-no-deps) — the tests that need nobody
- [docs/connection.md](docs/connection.md) — every live-found connection bug and its fix; the regression list behind L1–L4
- [User_Guide.md](User_Guide.md) — the commands as a participant meets them
- [Developer_Guide.md](Developer_Guide.md) — writing the agents L5 exercises
