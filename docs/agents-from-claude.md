# Running room agents from Claude

How to have Claude (Claude Code on the web, or a Claude project thread) put a
**facilitator** or another agent into a live QuantumOS room, headlessly, with no
browser. The agent is the repo's own `scripts/qos-cli/agent.mjs`, described in full in
[scripts/qos-cli/README.md](../scripts/qos-cli/README.md#agents-facilitator-scribe-greeter-).
This page covers what is different when Claude runs it in a cloud session: the network
setting, the commands, and how long the agent lasts.

**You don't need write access to this repository.** The repo is public. Everything below
works from a read-only clone: nothing is committed, forked or pushed. Your settings (the
room, the AI credentials, the persona) live in the command line, environment variables
or files in your own copy.

**You don't need a GitHub account either.** The clone is anonymous, over HTTPS. The Claude
session doesn't need this repository attached, because it clones the repo itself, so
don't connect GitHub for this. Render's *Public Git Repository* option and Fly's local
deploy also work without one. The accounts you do need are a Claude account, an
account with whichever host you choose, and, for `--ai-backend api`, an Anthropic API
key.

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
git clone --depth 1 https://github.com/rhovision-org/quantum-os
cd quantum-os/scripts/qos-cli
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

**Minutes, not hours, once the thread goes quiet.** Observed 2026-11-18: the cloud
container is restarted soon after Claude's turn ends (`uptime` read 2 minutes on the
next message), and every process in it, the agent included, goes with it. The
`--state` directory did survive, so a restarted agent came back as the same peer. A
cloud session is therefore good for trying an agent out, or for running one during a
session you are actively working in. It is not a host. Ask "restart the agent" to bring
it back. For an agent that stays, use one of the hosts in the next section.

## 5. Keeping an agent up: low-cost hosts

An agent is one small Node process: it makes outbound connections only (signaling over
WebSocket, WebRTC), serves no port, and uses about 150 MB of memory. Any always-on box
that runs Node 18+ will do. Two settings come with it wherever it runs.

**The room cap is a secret.** Whoever holds it can join the room. Put it in the host's
secret or environment-variable store as `ROOM_CAP` and pass `--room "$ROOM_CAP"`. Don't
put it in a file anyone else can read.

**The AI backend needs credentials there too.** Without `--ai` the agent still greets,
prompts for names and answers the basics from `facilitator-faq.mjs`. With it:

- `--ai-backend api` with `ANTHROPIC_API_KEY` set uses API credits, which are pay as you
  go and cheap at an agent's few calls an hour. This is the simplest choice on a host.
- `--ai-backend claude-code` bills a Claude subscription. Install the CLI on the host
  (`npm install -g @anthropic-ai/claude-code`), run `claude setup-token` once on your own
  machine, and store the token it prints as `CLAUDE_CODE_OAUTH_TOKEN`. The agent runs
  `claude` with the host's environment, so that is all it needs.

**What Claude can and can't do here.** From a thread, Claude can write the exact settings
and commands for your host and run the agent anywhere it has a shell. It cannot sign you
up for a host, enter payment details, or see your host's dashboard. So the account, the
secret values and the first deploy are yours, and they take about ten minutes.

| Host | Cost | Fits when |
|------|------|-----------|
| **Render**, Background Worker | about $7/month (Starter) | You already run the signaling server there. No Dockerfile is needed. |
| **Fly.io**, one Machine | about $2–4/month (shared-cpu-1x, 512 MB) | You want the cheapest managed option. |
| **Oracle Cloud** Always Free VM | $0 | You don't mind running a Linux VM yourself. |
| A machine you already own | $0 | It is on all the time: a home server, a Raspberry Pi 4, a spare laptop. |

Free tiers that put idle services to sleep (Render's free web services, for example)
don't work, because a sleeping agent has left the room. GitHub Actions jobs end after 6
hours, and GitHub's terms are not meant for long-running bots, so don't use them either.

### Render (Background Worker)

New → Background Worker → **Public Git Repository**, and paste
`https://github.com/rhovision-org/quantum-os` (branch `main`). Render builds from the
public repo, so it needs no GitHub connection and no access to it. Then set:

- **Root directory:** `scripts/qos-cli`
- **Build command:** `npm install` (append `&& npm install -g @anthropic-ai/claude-code`
  for the `claude-code` backend)
- **Start command:**
  `node agent.mjs --room "$ROOM_CAP" --role facilitator --ai --ai-backend api --state /var/data/qos-agent`
- **Environment:** `ROOM_CAP`, plus `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN`
- **Auto-deploy:** turn it off if you'd rather update when you choose. With it on, your
  agent redeploys whenever `main` changes upstream.
- **Disk** (optional, about $0.25/month for 1 GB): mount it at `/var/data`. This keeps the
  agent's identity across deploys. Without a disk the room sees a new peer after each
  deploy, which works but loses any `/gov trust` it was given.

### Fly.io

Fly deploys from a local folder, so this runs in your own clone. `fly.toml` is written
there and never leaves your machine.

```bash
git clone --depth 1 https://github.com/rhovision-org/quantum-os
cd quantum-os/scripts/qos-cli
fly launch --no-deploy --name qos-facilitator     # detects Node; no public port needed
fly secrets set ROOM_CAP='cap:room:…' ANTHROPIC_API_KEY='…'
fly volumes create qos_state --size 1             # optional: stable identity
# in fly.toml: remove the [http_service] section, mount qos_state at /data, and set
#   [processes]
#   app = "sh -c 'node agent.mjs --room \"$ROOM_CAP\" --role facilitator --ai --ai-backend api --state /data/qos-agent'"
fly deploy
```

### A Linux box (Oracle Free VM, home server, Pi)

```bash
git clone --depth 1 https://github.com/rhovision-org/quantum-os && cd quantum-os/scripts/qos-cli
npm install
sudo tee /etc/systemd/system/qos-agent.service <<'UNIT'
[Unit]
Description=QuantumOS room agent
After=network-online.target
[Service]
WorkingDirectory=/home/YOU/quantum-os/scripts/qos-cli
EnvironmentFile=/home/YOU/.qos-agent.env
ExecStart=/usr/bin/node agent.mjs --room ${ROOM_CAP} --role facilitator --ai --ai-backend api --state /home/YOU/.qos-agent
Restart=always
RestartSec=10
User=YOU
[Install]
WantedBy=multi-user.target
UNIT
# ~/.qos-agent.env (chmod 600):  ROOM_CAP=cap:room:…   ANTHROPIC_API_KEY=…
sudo systemctl enable --now qos-agent
```

`Restart=always` brings it back after a crash or reboot. To update later, run
`git pull && npm install` in the clone and then `sudo systemctl restart qos-agent`.

### Custom personas

How to add a role is in the [Developer Guide](../Developer_Guide.md#path-a--add-a-role-the-common-case).
A role you add in your own clone, without pushing it, runs wherever that clone runs: in
a cloud session (until the container restarts), on Fly, or on a Linux box. Render builds
from the public repo, so it only runs the roles already there.

### Optional: with a GitHub account

Nothing above needs one. A GitHub account adds one thing: a **custom persona that
redeploys itself** on a managed host.

1. Fork `rhovision-org/quantum-os` to your account. A fork is your copy: you can write to
   it without any access to the original.
2. Add your role to `scripts/qos-cli/agent-roles.mjs` in the fork, as the Developer Guide
   describes, and commit it. You can edit on github.com, or ask Claude (below).
3. On Render, create the Background Worker from **your fork** instead of the public URL,
   with the settings above and `--role <your role>`. With auto-deploy on, every commit
   to the fork redeploys the agent.
4. To have Claude make those edits, [connect GitHub](https://claude.ai/connect-github),
   install the Claude GitHub App on the fork, and add the fork to your project under
   Project settings → Repositories. A thread then gets the fork checked out and can push
   to it. "Make the heckler ruder" becomes a commit, and Render redeploys it.

To pick up upstream changes, use **Sync fork** on the fork's GitHub page. If you leave
auto-deploy on, the agent only changes when you sync or commit.

## Stopping it

```bash
kill $(pgrep -f "agent.mjs --room") # or: bash scripts/qos-cli/stop-agents.sh, for run-agents.sh launches
```

In the room, `/facil off` silences it without disconnecting it, and `/facil on` turns
it back on.
