# Developer Guide — building [QuantumOS](README.md) agents

An **agent** is an ordinary room peer (a small Node process) that joins over WebRTC,
watches the message stream, and participates — a facilitator, scribe, greeter, or anything
you write. This guide shows the two ways to build one. The transport, wire protocol, and
governance internals live in **[scripts/qos-cli/README.md](scripts/qos-cli/README.md)** and
the source under `scripts/qos-cli/` — this guide routes there rather than repeating it.

Prereqs: `cd scripts/qos-cli && npm install` (pulls `ws` + `werift`). Agents are plain ESM
`.mjs` — no build step, outside the pnpm workspace.

---

## Path A — add a role (the common case)
Most agents are just a **role** of the generalized [`agent.mjs`](scripts/qos-cli/agent.mjs).
Add one entry to [`agent-roles.mjs`](scripts/qos-cli/agent-roles.mjs):

```js
myrole: {
  name: "myrole",                  // default display name
  cmd:  "myrole",                  // command prefix → /myrole, /myrole ask, /myrole trust
  blurb: "what I do, in one line.",
  persona: "You are …",            // AI system-prompt persona (used with --ai)
  duties: { intro:true, greet:false, namePrompt:false, silentQuarter:false,
            dominator:false, discrepancy:true, stimulate:false, synthesize:false },
},
```

Run it: `node agent.mjs --room <cap> --role myrole [--ai --ai-backend claude-code]`. You
inherit for free: a stable identity, the measured-disruption budget, `/myrole` + `ask` +
`trust` + mute commands, the AI advisor ([provider plugins](scripts/qos-cli/ai-providers/README.md)), the [standard activity skills](scripts/qos-cli/skills/README.md), multi-agent lead-election, and trust
governance. **Duties** are the proactive behaviours your role performs (the table atop
`agent-roles.mjs` defines each); everything else is shared. → run/flags: [Agents](scripts/qos-cli/README.md).

## Path B — a custom agent from scratch
When the role system doesn't fit, build directly on the transport.
[`agent.mjs`](scripts/qos-cli/agent.mjs) and [`qos-daemon.mjs`](scripts/qos-cli/qos-daemon.mjs)
are the reference implementations. The skeleton:

```js
import { QOSPeer } from "./qospeer.mjs";
import { generateCapability } from "./zfa.mjs";
import { newDynCapState, signEnvelope, serializeState } from "./dyncap.mjs";

const peerId = generateCapability("peer");      // stable cap:peer — persist it for continuity
const dyncap = await newDynCapState();           // signing identity — persist serializeState(dyncap)
const peer = new QOSPeer({
  signalingUrl: "wss://quantum-os-signaling.onrender.com",
  roomId, peerId,
  onChannelOpen: (id) => peer.send(id, { kind: "name", name: "mybot" }),
  onMessage:     (from, d) => { if (d.kind === "chat") handle(from, d.text); },
  onPeerLeft:    (id) => {},
});
peer.connect();
peer.broadcast({ kind: "chat", text: "hello room" });
```

`QOSPeer` (config + `connect` / `disconnect` / `broadcast` / `send`) and the full envelope
protocol are documented in [scripts/qos-cli/README.md](scripts/qos-cli/README.md). Persist
`peerId` + dyncap state under a `--state` dir so peers TOFU-pin you across restarts (see
`qos-daemon.mjs`).

## The envelope vocabulary
Plain `chat` is enough for a bot. To be a first-class member, also speak these (dyncap-attributed
where noted):

| kind | meaning |
|---|---|
| `chat {text}` | a message |
| `name {name, agent?}` | announce your display name; set `agent:<role>` so other agents recognize you |
| `gov-trust {rater,ratee,rating}` · `gov-censure {censurer,target,on}` · `gov-delegate` | liquid-trust (self-attributed) |
| `group-open` · `group-member` · `sync-gov {groups}` | group roster / re-served state |
| `lemma` · `state-discrepancy` | a recorded fact / a consensus split |
| `sync-chat {lines}` | hand a joiner the conversation you heard (`{from, label, text, at}` per line) |
| `agent-ctl` → `agent-ctl-reply` · `fork-request` → `fork-reply` | an owner's fork grants and a request for a copy ([fork-host.mjs](scripts/qos-cli/fork-host.mjs)) |

Full kinds + payload shapes: [README](scripts/qos-cli/README.md) · [Group Decisions](Group_Decisions.md).

## Reuse the patterns — don't reinvent them
- **Measured disruption.** Quiet by default; gate proactive posts behind a budget, a
  min-gap, per-behaviour cooldowns, and a fair-share vs the humans. Copy the gate from `agent.mjs`.
- **Trust governance.** Be governable: ingest `gov-*`, compute your own standing with
  [`gov.mjs`](scripts/qos-cli/gov.mjs) (a faithful port of `trustLevels`), scale your voice by
  it, and stand down on a ⅔ censure-discredit — an agent posts up to its trust level, one rung
  below a same-rated human. → [Governance](Governance.md).
- **Multi-agent etiquette.** Tag `name` with `agent:<role>`; elect one lead per shared duty
  (lowest peerId) so N agents don't all act; count agent posts collectively against the human share.
- **AI (optional).** [`facilitator-advisor.mjs`](scripts/qos-cli/facilitator-advisor.mjs)'s
  `makeAdvisor({ persona, cmd, backend, skills })` reaches the model through a **provider
  plugin** — `anthropic`, `claude-code` (a Claude plan, no credits), `deepseek`, or your own
  `.mjs` ([contract](scripts/qos-cli/ai-providers/README.md)). Keys come from the agent
  machine's environment only. Advisory only, gated by your own budget.
- **Teach it an activity without code.** A [skill](scripts/qos-cli/skills/README.md) is a
  Markdown file of rules; drop it in `skills/` and every agent has it. In the browser, **`/ask <question>`** routes to the live
  facilitator when one is present, otherwise the lowest-peer-id other live agent, and
  reports if none is present; it relays the normal `/<role> ask` chat form, so an agent
  needs no new protocol.

## Test without a room
```
node selftest.mjs           # ZFA capability layer
node dyncap.selftest.mjs    # signing / verify, canonicalization, fork detection
node loopback.mjs           # two werift peers + a data channel, no network
# throwaway live room cap:
node -e "import('./zfa.mjs').then(z=>console.log(z.generateCapability('room')))"
```
→ more: [scripts/qos-cli/README.md](scripts/qos-cli/README.md).
With a partner on another network: [Live_Testing.md](Live_Testing.md) — the tests that need two people.

## Security model
Holding the room cap **is** authorization; the signaling server is an untrusted relay; data
channels are DTLS-encrypted; identity is TOFU-pinned via dyncap. Never gossip private held
notes/receipts. → [SECURITY.md](SECURITY.md).
