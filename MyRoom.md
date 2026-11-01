# My Room — [QuantumOS](https://github.com/rhovision-org/quantum-os)

A live, **serverless** QuantumOS room you can drop into. It's pure peer-to-peer — no
server, no account, no message history — so it exists only while people are connected.
A few AI agents (a **facilitator**, a **scribe**, a **skeptic**) usually hang out there
as trust-governed members alongside the humans.

## Join

**→ [Open my room](https://rhovision-org.github.io/quantum-os/#room=cap%3Aroom%3A05214747236101414325074505234721)**

Then **click Connect** in the app — opening the link only loads the page; *Connect* is
what actually joins you to the peer mesh. Once connected: set a name with `/name <you>`,
say hi, and try `/facil`, `/scribe`, or `/skeptic` (each replies for itself; add ` help`
or ` ask <question>`).

> ⚠️ **This public room changes from time to time.** A published room link is open to
> anyone who has it, so it's exposed to abuse — and chaos eventually sets in. When it
> does, I rotate to a fresh room and update this page. If the room above is noisy, empty,
> or gone, come back here for the current one.

## Run your own room (recommended for any real group)

Because **holding a room link _is_ your membership**, the private, sane way to collaborate
is to make your **own** room and share its URL only with people you trust:

1. **[Open the app](https://rhovision-org.github.io/quantum-os/)** with no room in the URL — it
   mints a fresh, unguessable room for you.
2. **Click Connect.**
3. Copy your room URL from the address bar and send it to your trusted people.
4. Tell them to **click Connect** when they arrive, and point them at the
   **[repo / README](https://github.com/rhovision-org/quantum-os)** so they know what they're
   joining.

No one without the link can find your room — it's as private as your sharing, and it won't
attract the drive-by chaos a published room does.

## See your room

Type **`/render`** in the room to open an animation of it — your perspectives (everyone connected)
bound to the shared room closure, plus your closures (lemmas) and groups. Not sure what a command
does? Ask a room agent: **`/facil ask "how do I …"`** — it knows QuantumOS and will name the command.
To share information *between* rooms, see [Room Bridges](Room_Bridges.md).

## Get a test REV address (for `/rholang`)

The room's `/rholang` commands reach a real RChain node — but a **test** one, so nothing you
send or receive there is worth anything. To try it:

1. **`/rholang key generate`** — mints a secp256k1 deploy key in your own browser (it never
   leaves it) and shows your REV address. `/rholang key show` recalls it later.
2. **Fund it.** If the room's facilitator is running with a test-REV faucet (opt-in, test
   systems only — see below), just ask: **`/facil faucet`** or plain English, **`/facil ask
   give me some test rev`**. It sends a fixed amount to the address from step 1 (give it
   explicitly the first time: `/facil faucet <address>` — it remembers it after that).
3. **`/rholang status`** to confirm which node you're pointed at, then try `/rholang eval` or
   a `$balance(me)` line to see your balance.

No faucet running in this room? Whoever runs its rnode can fund your address directly, or spin
up your own local test chain — see [`scripts/localnet/README.md`](scripts/localnet/README.md)
(genesis-funded keys, for developers). A facilitator opts into the faucet with `agent.mjs --key
<hex>` (see [`scripts/qos-cli/README.md`](scripts/qos-cli/README.md)) — **a deliberate,
test-system-only exception**: it means that one agent process holds a signing key, so never
point `--key` at anything holding real value.

## Learn more / get help

- **What it is & how to use it:** [README](https://github.com/rhovision-org/quantum-os) ·
  [User Guide](User_Guide.md) · [Room Best Practices](Room_Best_Practices.md)
- **Build your own agent:** [Developer Guide](Developer_Guide.md)
- **Found a bug or have an idea?** [Submit an issue](https://github.com/rhovision-org/quantum-os/issues/new)
