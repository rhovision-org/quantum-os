# Running room agents from Claude

How to have Claude (Claude Code on the web, or a Claude project thread) put a
**facilitator** or another agent into a live QuantumOS room, headlessly, with no
browser. The agent is the repo's own `scripts/qos-cli/agent.mjs`, described in full in
[scripts/qos-cli/README.md](../scripts/qos-cli/README.md#agents-facilitator-scribe-greeter-).
This page covers what is different when Claude runs it in a cloud session: the network
setting, the commands, and how long the agent lasts.

Verified 2026-11-18: a facilitator joined a live room from a cloud session and greeted a
new peer within seconds.

## 1. Set the cloud environment (once)

An agent needs the signaling server, `quantum-os-signaling.onrender.com`. The
**default ("Built-in") cloud environment's network policy blocks that host**, so the
join fails before anything else happens.

1. Create a cloud environment (named `quantum-os` here) whose network access allows
   `quantum-os-signaling.onrender.com`. Allowing `*.onrender.com` also works. Keep the
   default package registries allowed, since `npm install` is needed.
2. In a Claude **project**, open Project settings → Cloud environment and select it, so
   every new thread runs there. A thread that is already running stays on the
   environment it started in and can't be switched, so start a new thread after
   changing the setting.
3. For a one-off Claude Code session, pick the environment when you start the session.

Check from inside the session:

```bash
curl -sS -m 10 https://quantum-os-signaling.onrender.com/
# {"status":"ok","build":"…","rooms":…}   ← reachable
# a proxy 403 / connection refused        ← still on the wrong environment
```

## 2. Ask Claude

Paste the room link and say what you want, for example:

> can you run a facilitator agent in https://rhovision-org.github.io/quantum-os/#room=cap:room:…

What Claude runs (you can also run these yourself in any terminal):

```bash
cd scripts/qos-cli
npm install                     # ws + werift; this dir is outside the pnpm workspace

nohup node agent.mjs \
  --room "cap:room:…" \
  --role facilitator \
  --ai --ai-backend claude-code \
  --state ~/.qos-facil \
  > ~/facil.log 2>&1 &
```

- `--room` takes the bare `cap:room:…` token or the full room URL.
- `--ai --ai-backend claude-code` makes the agent use the session's own `claude` CLI
  for `/facil ask`, `chair`, `optimize` and syntheses. **No `ANTHROPIC_API_KEY` is
  needed.** The calls count against the Claude subscription that runs the session.
  Without `--ai` the agent still greets, prompts for names, and answers basic questions
  from `facilitator-faq.mjs`.
- `--state` holds the agent's identity (its `cap:peer` and dyncap seed). Reuse the same
  directory when you restart it, so the room sees the same peer again.
- Add `--persist` to have the agent also hold the room's memory (lemmas, currencies,
  groups, transcript) and replay it to new joiners.
- Other roles: `--role skeptic` (flags histories that pass the aggregate ZFA check but
  fail QLF's pairwise one), `scribe`, `greeter`, `observer`. Give each its own `--state`
  directory. Two agents in one container cost noticeable CPU (see the comment at the top
  of `run-agents.sh`), so run one unless you need the second.
- `run-agents.sh` is the detached launcher for a machine you control. By default it also
  turns on the test-REV faucet with the localnet key. Pass `FACIL_KEY=` to turn that off.

## 3. Check it is live

```bash
tail -f ~/facil.log
# [facil] signaling connected; joined room
# [facil] ↪ intro → <someone>
```

From a second terminal, a throwaway peer should be greeted within a few seconds:

```bash
node qos-cli.mjs --room "cap:room:…" --name probe --listen
```

In the room, try `/facil` (is it present?), `/facil help`, `/ask <question>`,
`/facil chair <topic>`, and `/facil health`.

## 4. How long it stays up

**Only as long as the cloud container does.** A cloud session's container is
reclaimed after a period of inactivity, or when the session ends, and nothing is
persistent. When that happens the agent leaves the room with no warning. To bring it
back, ask in the same thread ("the facilitator dropped, restart it"). Claude re-runs
step 2. Its identity comes back only if `--state` survived, so a reclaimed container
means a new peer id.

For an agent that is always on, run `bash scripts/qos-cli/run-agents.sh "<room>"` on a
machine you control (with the `claude` CLI installed and logged in), under tmux or a
service manager.

## Stopping it

```bash
kill $(pgrep -f "agent.mjs --room") # or: bash scripts/qos-cli/stop-agents.sh, for run-agents.sh launches
```

In the room, `/facil off` silences it without disconnecting it, and `/facil on` turns
it back on.
