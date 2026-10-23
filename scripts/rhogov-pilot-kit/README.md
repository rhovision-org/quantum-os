# RhoGov Pilot Kit

An evidence-led, local-first workbench for the two-week pilot proposed in [RhoGov — Decisions That Learn (#242)](https://github.com/rhovision-org/quantum-os/issues/242).

**Make a decision together, try it within clear limits, and keep a say in what happens next.**

The workbench preregisters a bounded decision, freezes the initial measurement rules, records every participant attempt and team-hour entry, shows advisory review conditions, records an external human decision, and exports a report or portable JSON backup. It does not vote, submit chain transactions, enforce permissions, or connect a wallet.

## Use the hosted demo

Open the [RhoGov Pilot Kit](https://rhogov-pilot-kit.ariaaix.chatgpt.site). The initial workspace is labelled **DEMO · SYNTHETIC** across the interface and downloadable report. Use **Start blank pilot** to switch to an empty live workspace. Demo data and live data have separate browser storage keys.

The hosted demo is public. Anyone with the link can open it. Hosting serves the static application only; each browser keeps its own pilot records locally. Share a JSON export with the agreed reviewer when transferring a record.

## Use without hosting or installation

Open the self-contained file in dist/index.html in a current desktop or mobile browser. It contains the interface, styles and calculation logic; it needs no network connection after download, build step, dependencies, API keys, or server.

Each browser origin stores its own workspace in localStorage. Hosted and offline copies are separate. Download a JSON backup when moving a pilot between them. Browser-local storage is not encrypted: use pseudonyms, do not enter wallet secrets or identifying participant details, and agree who may access raw observations.

## The measurement contract

- Start the 14-day window only after the team agrees and V1 is frozen. Issue creation or tool use does not start it.
- Measure the earliest invitation opening for each participant. Retain retries, but do not let a later success replace the primary attempt.
- Count a qualifying success only when the first attempt records a ballot, is under the agreed time, is unassisted, and has facilitator-accepted evidence marked **receipt checked** or **observed**.
- A self-report does not become external verification. Disputed or unavailable evidence remains unresolved.
- Missing or unresolved data are not an early failure. Assess a shortfall when the cohort resolves or the scheduled review becomes due.
- Three distinct people at the same named blocking step trigger an advisory review. Repeated attempts by one person count once. “Other” requires manual grouping.
- Team hours include recruitment, preparation and review. Reaching the cap triggers an advisory pause for a human decision.
- An amendment appends a linked version; original targets remain fixed for that pilot. A different cohort or target starts a separate pilot.
- A human review requires a decision reference. Continuing also records the bounded next action, additional hours and a future review date.

The monitor is descriptive and advisory. Actual group approval, consent, voter eligibility, chain receipt checks and any finality rule belong to the team.

## Why this is more than a survey

An onboarding metric alone could label a decision a success while participants had no real reason to care, no influence over what happens next, and no record of dissent. This kit binds one meaningful action to advance-agreed limits, a visible concern, evidence from the first attempt, and an explicit human review. The measure tests whether the decision process is usable; it does not claim that ten people prove collective-intelligence gains.

The idea applies Jim Whitescarver’s co-authored **EIES 2: A Distributed Architecture for Supporting Group Work** (1992) as a practical design cue: connect research with operational use, evolve incrementally, and give the activity a portable protocol. This implementation starts with a versioned local record and a manual pilot. The historical source basis is the [published abstract and NJIT repository record](https://digitalcommons.njit.edu/ccccreports/28/); it does not claim to quote or analyze the full report.

## Repository location

This standalone tool lives under `scripts/rhogov-pilot-kit/` in Quantum-OS. Run the commands below from that directory. The scoped GitHub Actions workflow runs the core tests and checks that the committed offline HTML matches its source.

## Build, test and export examples

Requires Node.js 18 or later; there are no third-party packages.

Run:

    npm test
    npm run examples
    npm run build

The examples command generates a blank Markdown template, blank JSON template and explicitly synthetic sample report under examples/.

## Project structure

- src/pilot-core.js — validation, monitoring rules, timer handling, versioning, and Markdown exports.
- src/app.js, src/styles.css and src/index.template.html — responsive, accessible single-page app.
- dist/index.html — self-contained hosted and offline application.
- tests/ — tests for success classification, unknown data, human review, clock boundaries, and JSON imports.
- examples/ — blank template and explicitly synthetic sample report.

## Privacy and evidence limits

The app sends no participant record to a server. Hosting provides the static application page only. The facilitator’s browser stores attempt logs. Browser extensions, operating-system access and shared-device users can still access that storage. Use participant pseudonyms, get consent before recording, explain public ballot visibility and follow the group’s agreed retention policy.

“Receipt checked” and “observed” describe what a facilitator recorded. They are not independent attestations. For chain-dependent outcomes, specify the network, contract address and finality rule; current RhoGov documentation notes newest-block reads. No RhoGov or Quantum-OS adapter is implemented here. JSON is the portable starting point for a later, explicitly consented adapter.

## References

- [Proposal #242: RhoGov — Decisions That Learn](https://github.com/rhovision-org/quantum-os/issues/242)
- [RhoGov user guide](https://github.com/rhovision-org/rhogov/blob/main/docs/user-guide.md)
- Whitescarver, Czech, Reddy, Rana and Turoff, [EIES 2 (1992)](https://digitalcommons.njit.edu/ccccreports/28/)
