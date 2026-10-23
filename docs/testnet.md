# Testnet

The testnet's documentation lives upstream in `rholo` now, where the operators and the node
contributors are:

- **[The public testnet — `testnet.rhobot.net`](https://github.com/rhovision-org/rholo/blob/dev/docs/src/node/testnet.md)**
  — the live net: hosts, genesis, funded wallets, using it from r-wallet, the verified validator-onboarding
  path, and the incident log (K1–K7).
- [Running a public testnet of your own](https://github.com/rhovision-org/rholo/blob/dev/docs/src/node/running-a-public-testnet.md)
  — the generalised procedure, if you want to stand up another one.

Nothing in this repo needs maintaining for the testnet beyond pointing an agent at it — the agents take a
node URL:

```sh
node scripts/qos-cli/agent.mjs --rnode https://testnet.rhobot.net …
```

Two different chains are easy to confuse, and only one of them is the testnet:

| | |
|---|---|
| **RChain testnet** | `testnet.rhobot.net` — the idle, two-validator net with funded dev wallets |
| **Rholang playground** | `playground.rhobot.net` (formerly `rnodeapi.rhobot.net`) — the dev-mode playground, and what the playground at `rhobot.net` talks to |

That distinction is now visible in r-wallet's network list; the upstream page explains it.
