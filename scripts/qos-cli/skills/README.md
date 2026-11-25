# Agent skills

A **skill** gives a room agent the rules and context for an activity: a game, a
meeting format, a practice. It is a plain Markdown file, so anyone who can write
the rules down can teach an agent something new, with no code.

## The standard skills

Every agent has these with no flag; a fork of an agent has them too.

| Skill | What it is |
|---|---|
| [brainstorm](brainstorm.md) | ideas first with no judging, then grouping, then a `/poll` |
| [debate](debate.md) | a moderated two-sided debate on a motion, ending in a room vote |
| [retrospective](retrospective.md) | went well, didn't, what to try next with an owner |
| [story-round](story-round.md) | the room writes a story, a sentence or two per turn |
| [twenty-questions](twenty-questions.md) | the agent thinks of something; the room asks yes/no questions |
| [word-chain](word-chain.md) | each word starts with the last letter of the one before |

Only the names and one-line descriptions of these ride in the agent's prompt
until the room picks one, so the set costs almost nothing until it is used.

## Using them

In the room:

- `/<cmd> skills`: what the agent knows, and which activity is on.
- `/<cmd> use <skill>`: start an activity (a fresh game); `/<cmd> use none` stops it.
- `/<cmd> rules [skill]`: the rules, posted for everyone.
- `/<cmd> play <move or message>`: a move, a guess, a question for the game master.

To start an agent with an activity already on, or to give it your own:

```bash
node agent.mjs --room <cap> --ai --skill twenty-questions     # a standard one, already on
node agent.mjs --room <cap> --ai --skill /home/me/my-game.md  # your own, by path
```

From the room: `/agent add facilitator --skill twenty-questions` (add `--ai deepseek`
etc. to pick the model provider). On the agent's computer, `SKILL=` in
`add-agent.sh` does the same; several skills are comma-separated.

**Private notes.** The model has no memory beyond what it is shown, so a game
with a secret (the answer in twenty questions, a hidden hand) needs somewhere to
keep it. A line in the model's reply that starts `NOTE:` is kept by the agent,
shown back to the model on the next turn, and never posted. The notes live on
the agent's computer only, in memory, and are cleared when the activity changes.

A skill needs AI (`--ai` with a provider), since following free-form rules is the
model's job. The agent reads the game state from the room's transcript, so the
whole room sees every move.

## Writing one

```markdown
---
name: my-game
description: One line saying what the activity is.
players: 2–6
---

The rules, as you would explain them to a new player: setup, what a turn is,
what is allowed, how it ends, how a winner is decided. Then anything the agent
needs to know about its own part (game master, player, scorekeeper) and how
to talk (short chat lines, whose turn next).
```

- `name` is lowercase letters, digits and `-`; it defaults to the file name.
- The body rides in every prompt the agent sends, so keep it to a page or two
  (12,000 characters at most).
- Write rules you have the right to share. Describe a game in your own words
  rather than pasting a published rulebook.

[twenty-questions.md](twenty-questions.md) is a complete example, including a
private note. A file added to this directory becomes a standard skill for every
agent; `packages/browser/src/agent-invite.ts` `STANDARD_SKILLS` lists them for
the browser, and its test fails until the two agree.
`node skills.selftest.mjs` (one directory up) checks every built-in parses.
