# Running room agents from Claude

How to put a **facilitator**, or another AI agent, into a live QuantumOS room with
Claude's help and **no terminal on your side**. Each step is either a click in a
website or something you ask Claude in a [Claude Code on the web](https://claude.ai/code)
session or a Claude project thread. Claude runs every command in its cloud session.

The agent is the repo's own `scripts/qos-cli/agent.mjs`. It joins the room as a full
peer, and the room can `/gov trust` it up or `/gov censure` it down like anyone else.
The full reference is in
[scripts/qos-cli/README.md](../scripts/qos-cli/README.md#agents-facilitator-scribe-greeter-).

**What you need:** a Claude account. To keep an agent up for good, you also need an
account with a host and an Anthropic API key. **You don't need** write access to this
repository or a GitHub account: the repo is public, and Claude clones it anonymously.
GitHub is only for the [optional fork path](#optional-your-own-persona-with-a-github-account).

Verified 2026-11-18: a facilitator joined a live room from a cloud session and greeted a
new peer within seconds.

## Quick start

**Try it now:** this is included in your Claude plan, and the agent lasts minutes after
you stop chatting.

1. In [Claude Code on the web](https://claude.ai/code), create a cloud environment that
   allows the signaling server, and select it ([step 1](#1-set-the-cloud-environment-once)).
2. Open a room at [rhovision-org.github.io/quantum-os](https://rhovision-org.github.io/quantum-os/),
   copy its link, and ask Claude:
   *"run a facilitator agent in &lt;room link&gt;"* ([step 2](#2-ask-claude)).

**Keep it up:** a few dollars a month, or free.

1. Create an [Anthropic API key](https://console.anthropic.com/settings/keys).
2. Pick a host ([step 4](#4-keep-it-up-on-a-host)):
   - [Render](#render-about-7month): about $7/month, set up by clicking through
     Render's dashboard.
   - [An Oracle Always Free VM](#oracle-cloud-always-free-0): $0. Claude writes a
     setup script and you paste it into Oracle's web console.

## 1. Set the cloud environment (once)

An agent must reach the signaling server, `quantum-os-signaling.onrender.com`. The
**default ("Built-in") cloud environment blocks that host**, so nothing works until it
is allowed.

1. Open [Claude Code on the web](https://claude.ai/code) and use the environment selector
   to create a new environment, named `quantum-os` here. See
   [how environments work](https://code.claude.com/docs/en/claude-code-on-the-web).
2. Under its network access, allow `quantum-os-signaling.onrender.com`
   (`*.onrender.com` also works). Keep the default package registries and GitHub allowed,
   since Claude needs `npm install` and `git clone`.
3. Select it. In a Claude **project**, use Project settings → Cloud environment, so every
   new thread runs there. A thread that is already running stays on its old environment,
   so start a new thread after changing the setting.

Claude checks the setting itself: `curl https://quantum-os-signaling.onrender.com/`
answers `{"status":"ok",…}` when the host is reachable. If it isn't reachable, Claude will
say the environment is the problem.

## 2. Ask Claude

Paste the room link and say what you want:

> run a facilitator agent in https://rhovision-org.github.io/quantum-os/#room=cap:room:…

Other things you can ask for:

- **Another role:** *"run a skeptic"*. The roles are `facilitator`, `skeptic`, `scribe`,
  `greeter` and `observer`. Run one at a time unless you need two, because each costs CPU.
- **A persona of your own:** *"run an agent that heckles"*. Claude adds the role to its
  own copy and runs it. That copy disappears with the container, so ask again after a
  restart. To keep a persona, see [the fork path](#optional-your-own-persona-with-a-github-account).
- **Room memory:** *"…and have it keep the room's memory"*. The agent then stores
  lemmas, currencies, groups and the transcript, and replays them to people who join
  later.

For reference, this is what Claude runs:

```bash
git clone --depth 1 https://github.com/rhovision-org/quantum-os
cd quantum-os/scripts/qos-cli && npm install
nohup node agent.mjs --room "cap:room:…" --role facilitator \
  --ai --ai-backend claude-code --state ~/.qos-facil > ~/facil.log 2>&1 &
```

The `claude-code` backend uses the session's own Claude, so you don't need an API key here.
The calls count against your Claude plan.

## 3. Check it's live

Ask Claude *"is the agent in the room?"*. Claude reads the agent's log and can join a
throwaway peer to confirm the agent greets it. In the room itself, try:

- `/facil` to see whether it's present
- `/facil help`
- `/ask <question>`
- `/facil chair <topic>` to have it run a deliberation
- `/facil health`

## 4. Keep it up on a host

**A cloud session is not a host.** Observed 2026-11-18: the container restarts a few
minutes after Claude's reply ends, and the agent goes with it. Asking *"restart the
agent"* brings it back, as the same peer. For an agent that stays, put it on a host.

An agent is one small Node process. It uses about 150 MB of memory and only makes
outbound connections. Two values go into the host's secret settings, and never into a
file anyone else can read:

- **`ROOM_CAP`**: the `cap:room:…` part of the room link. Anyone who holds it can join
  the room.
- **`ANTHROPIC_API_KEY`**: from the [Anthropic console](https://console.anthropic.com/settings/keys).
  You pay as you go, which is cheap at an agent's few calls an hour. Leave it out, and
  `--ai`, for an agent that only greets and answers basic questions from its built-in FAQ.

Claude can't sign you up, enter payment details, or see your dashboards. Those few
clicks are yours, and Claude can walk you through them.

| Host | Cost | You do | Claude does |
|------|------|--------|-------------|
| [Render](#render-about-7month) | about $7/month ([pricing](https://render.com/pricing)) | click through Render's dashboard | gives you each value to paste |
| [Oracle Cloud](#oracle-cloud-always-free-0) | $0 ([Always Free](https://www.oracle.com/cloud/free/)) | create a VM in the web console | writes the setup script you paste in |

Hosts that put idle services to sleep, such as Render's free web services, don't work,
because a sleeping agent has left the room. GitHub Actions jobs stop after 6 hours.

### Render (about $7/month)

1. [Sign up](https://dashboard.render.com/register). In the
   [dashboard](https://dashboard.render.com/), choose **New → Background Worker**
   ([docs](https://render.com/docs/background-workers)).
2. Choose **Public Git Repository** and paste `https://github.com/rhovision-org/quantum-os`.
   Render needs no GitHub connection for this.
3. Fill in:
   - **Branch:** `main`
   - **Root Directory:** `scripts/qos-cli`
   - **Runtime:** Node
   - **Build Command:** `npm install`
   - **Start Command:**
     `node agent.mjs --room "$ROOM_CAP" --role facilitator --ai --ai-backend api --state /var/data/qos-agent`
   - **Instance type:** Starter
   - **Environment Variables:** `ROOM_CAP` and `ANTHROPIC_API_KEY`
4. Optional: under **Disks**, add 1 GB mounted at `/var/data`. That's about $0.25/month
   ([docs](https://render.com/docs/disks)). It keeps the agent the same peer across
   deploys, so any `/gov trust` the room gave it isn't lost.
5. Click **Create Background Worker**. The logs should show `signaling connected; joined room`.

Turn **Auto-Deploy** off if you'd rather not redeploy whenever `main` changes upstream.
**Suspend** in the service's settings stops the agent.

### Oracle Cloud Always Free ($0)

1. [Sign up for Oracle Cloud Free Tier](https://www.oracle.com/cloud/free/). A card is
   asked for, to verify you, but Always Free resources aren't charged.
2. Ask Claude: *"write me an Oracle cloud-init script that runs a facilitator in
   &lt;room link&gt;"*. Add *"with the heckler persona"* or similar for a custom role,
   and Claude builds it into the script. Claude gives you a script with `ROOM_CAP` filled
   in and a placeholder for your API key.
3. In the console, go to **Compute → Instances → Create instance**:
   - **Image:** Ubuntu
   - **Shape:** an Always Free one (Ampere A1 or VM.Standard.E2.1.Micro)
   - Open **Show advanced options → Management → Paste cloud-init script**. Paste the
     script and replace the API-key placeholder with your key, there in the browser.
     That way the key never goes through the chat.
4. Click **Create**. The VM installs Node, the agent and a service that restarts it after
   a crash or reboot. The agent joins the room a few minutes after the VM starts.

**Stop** on the instance's page stops the agent.

The script Claude writes follows this shape, with the values filled in:

```bash
#!/bin/bash
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs git
git clone --depth 1 https://github.com/rhovision-org/quantum-os /opt/quantum-os
cd /opt/quantum-os/scripts/qos-cli && npm install
# (a custom role, if asked for, is appended to agent-roles.mjs here)
cat > /etc/qos-agent.env <<'ENV'
ROOM_CAP=cap:room:…
ANTHROPIC_API_KEY=PASTE-YOUR-KEY-HERE
ENV
chmod 600 /etc/qos-agent.env
cat > /etc/systemd/system/qos-agent.service <<'UNIT'
[Unit]
Description=QuantumOS room agent
After=network-online.target
[Service]
WorkingDirectory=/opt/quantum-os/scripts/qos-cli
EnvironmentFile=/etc/qos-agent.env
ExecStart=/usr/bin/node agent.mjs --room ${ROOM_CAP} --role facilitator --ai --ai-backend api --state /var/lib/qos-agent
Restart=always
RestartSec=10
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload && systemctl enable --now qos-agent
```

## Optional: your own persona with a GitHub account

Render builds the public repo, so it runs only the roles already there. A fork lets
Render run your own persona, and redeploy it whenever you change it.

1. [Sign up for GitHub](https://github.com/signup) and
   [fork rhovision-org/quantum-os](https://github.com/rhovision-org/quantum-os/fork).
2. Let Claude edit the fork:
   - [connect GitHub](https://claude.ai/connect-github)
   - [install the Claude GitHub App](https://github.com/apps/claude/installations/select_target)
     on the fork
   - add the fork to your project under Project settings → Repositories
3. Ask Claude in that project: *"add a heckler role to my fork"*. Claude commits it,
   following the [Developer Guide](../Developer_Guide.md#path-a--add-a-role-the-common-case).
   You can also edit `scripts/qos-cli/agent-roles.mjs` yourself on github.com, using the
   pencil icon.
4. Create the Render worker from **your fork** instead of the public URL, using
   `--role <your role>` in the start command. Every later change ("make the heckler
   ruder") is a commit, and Render redeploys it.

**Sync fork** on the fork's GitHub page brings in upstream changes.

## Stopping it

- **In a cloud session:** ask Claude to stop the agent.
- **On a host:** Suspend the worker on Render, or Stop the instance on Oracle.
- **In the room:** `/facil off` silences the agent without disconnecting it, and
  `/facil on` turns it back on.
