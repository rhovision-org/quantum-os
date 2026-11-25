# Agent skills

A **skill** gives a room agent the rules and context for an activity: a game, a
meeting format, a practice. It is a plain Markdown file, so anyone who can write
the rules down can teach an agent something new, with no code.

```bash
node agent.mjs --room <cap> --ai --skill twenty-questions     # a built-in, by name
node agent.mjs --room <cap> --ai --skill /home/me/my-game.md  # your own, by path
```

From the room: `/agent add facilitator --skill twenty-questions` (add `--ai deepseek`
etc. to pick the model provider). On the agent's computer, `SKILL=` in
`add-agent.sh` does the same; several skills are comma-separated.

In the room, players talk to the agent with:

- `/<cmd> play <move or message>`: a move, a guess, a question for the game master.
- `/<cmd> skills`: what the agent knows how to do.
- `/<cmd> rules [skill]`: the rules, posted for everyone.

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

[twenty-questions.md](twenty-questions.md) is a complete example.
`node skills.selftest.mjs` (one directory up) checks every built-in parses.
