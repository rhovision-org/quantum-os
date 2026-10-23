# Room Bridges — sharing information among perspectives, across rooms

Companion to [`Room_Best_Practices.md`](Room_Best_Practices.md) (quality closure *within* a room) and [`scripts/qos-cli/README.md`](scripts/qos-cli/README.md). This document is about the layer above: how information flows *between* rooms as the inputs and outputs of distinct perspectives.

---

## The idea

A [QuantumOS](README.md) room is a **Markov blanket**: the peers inside it share a live closure (a common capability token, a common set of lemmas, currencies, and chat), and peers outside see nothing. Each room is one **perspective** — a self-consistent local world, in the sense of the [Quantum Logical Framework](https://github.com/rhovision-org/quantum-logical-framework)'s many-observers reading (every observer's local information defines its own coherent relative world).

Two perspectives share information the same way two histories do in QLF: one perspective's **output becomes another's input** only through something that stands in both. That something is a **bridge** — a peer that is a member of two (or more) rooms at once. The bridge's simultaneous membership *is* the shared closure between the rooms. In QLF terms this is **ER=EPR at the collaboration layer**:

> `SharedClosure A B := achieves_ZFA (A ++ B)` ([`ER_EPR_QLF`](https://github.com/rhovision-org/quantum-logical-framework/blob/main/ER_EPR_QLF.md)) — entanglement is a shared closure between two histories; a bridge is that shared closure between two rooms.

It is the exact analogue of [`MultiParticle.py`](https://github.com/rhovision-org/quantum-logical-framework/blob/main/MultiParticle.py): two independent histories expand until their causal cones intersect, and the **interaction manifold** — the events they share — is where a joint closure (entanglement) can form. A room bridge is that interaction manifold, made operational.

## Inputs and outputs are channels

Information already travels inside a room on **channels** — the app's `/channel send <name> <text>` broadcasts a `{ kind: "channel-msg", channel, payload }` envelope, and peers `/channel listen <name>` to receive it. A channel is a named input/output port of a perspective. A bridge is simply a peer that:

- **subscribes** to a room's channel outputs, and
- **re-emits** them as inputs to the other rooms it stands in.

Chat can be bridged too (`--chat`), but channels are the disciplined path: they carry named, intentional inputs/outputs rather than all conversation.

## The bridge tool

[`scripts/qos-cli/bridge.mjs`](scripts/qos-cli/bridge.mjs) is a headless perspective that joins several rooms and relays their outputs as each other's inputs. It reuses the same `QOSPeer` WebRTC/signaling core as every other headless peer, and lives outside the pnpm workspace, so it does not touch the TS/Rust CI.

```bash
cd scripts/qos-cli
npm install                     # ws + werift (once)

# Bridge two rooms — every channel message in one becomes an input to the other:
node bridge.mjs \
  --room "cap:room:…A…" \
  --room "cap:room:…B…" \
  --name "team-bridge"

# Restrict to specific channels, and also relay chat:
node bridge.mjs --room <A> --room <B> --channel decisions --channel alerts --chat

# Also bridge durable state — lemmas and governance/groups:
node bridge.mjs --room <A> --room <B> --lemmas --gov

# Bridge three rooms (a hub perspective):
node bridge.mjs --room <A> --room <B> --room <C> --channel status
```

Rooms may be given as bare caps (`cap:room:…`) or as full app URLs (`…/#room=cap%3Aroom%3A…`). At least two distinct rooms are required. Every relayed message is prefixed with its **origin room label** (`[R1:abc123] …`) so each perspective sees where the input came from — provenance is never dropped.

Options: `--room` (repeatable, ≥2), `--channel <name>` (repeatable; default: all channels), `--chat`, `--name <label>`, `--signal <wss url>`, `--max-hops <n>` (default 1).

## Bridging durable state — lemmas and governance

Channels and chat are the *live* input/output layer. Two opt-in flags bridge a room's **durable** state as well:

- **`--lemmas`** relays every published lemma (`kind:"lemma"`) between rooms, and — when the bridge joins a room and a peer or memory daemon serves it the room's existing set (`sync-lemmas`) — imports each of those lemmas into the other rooms. So a lemma proven in one room becomes a lemma in the other.
- **`--gov`** relays group and governance mutations (`group-open`, `group-member`, `group-meta`, `group-msg`, `group-issue`, `group-vote`, `gov-delegate`, `gov-trust`, `gov-censure`, `gov-vault`) and imports existing groups (`sync-gov`). A group whose id (a capability token) is shared across two bridged rooms stays in sync — membership, delegations, issues, and votes cross the bridge.

**Signatures carry through.** Lemma and governance envelopes are signed with the sender's dynamic capability (`dyncap`). The bridge relays them **verbatim** — it never rewrites their content — so the *original signer's* anchor and chain travel with the envelope. Receivers accept forwarded entries on the forwarder's trust (a receiver cannot re-derive the witness without the seed; see `dyncap.ts`), exactly as they already accept a peer's `sync-*` replay. Provenance for state is therefore the signer's anchor, not an origin prefix — the bridge adds no origin tag to signed state (that would break the signature).

**Durable dedupe.** Each state item is relayed at most once per bridge run (lemmas keyed by name + cap; mutations by their dyncap witness), so a later `sync-*` cannot echo a lemma back around the mesh.

**Persistence still wants a daemon.** A bridge only relays what is live; a peer that joins a room *after* an import will not see it unless a [memory daemon](scripts/qos-cli/README.md) is holding that room's state. Run a daemon per room for durable cross-room state, and a bridge to keep them in step.

## Loop prevention

Rooms can be bridged into cycles (A↔B↔C↔A), and the same human may sit in two bridged rooms. To keep a message from echoing forever, every forwarded envelope carries:

- `_bridge` — this bridge's unique id, so a bridge never re-relays its own output; and
- `_hops` — a hop counter, dropped once it reaches `--max-hops` (default 1: a message crosses at most one bridge, which is what you want for a simple two-room link).

A short recent-forward dedupe window additionally absorbs bursts, so a flurry in one room cannot storm the mesh.

## Because rooms have no server, run a bridge like a daemon

QuantumOS rooms are pure peer-to-peer — the signaling server only routes WebRTC handshakes; there is no server-side room and no history. A bridge, like [`qos-daemon.mjs`](scripts/qos-cli/README.md), only relays what is live: a message crosses only if the bridge is connected to both rooms at the moment it is sent. For a standing link between two ongoing rooms, run the bridge as a long-lived process (it auto-reconnects with backoff, inherited from `QOSPeer`). Pair it with a memory daemon in each room if you also want the room's state to survive everyone leaving.

## Best practice

- **Name the ports, not the firehose.** Prefer bridging a few named channels (`--channel decisions`) over `--chat`; a bridge is an intentional information contract between groups, not a merge of two conversations.
- **One bridge per link.** Two bridges spanning the same pair of rooms double every message; use a single bridge and let `--max-hops` bound multi-room topologies.
- **Provenance stays visible.** The `[origin]` prefix means a receiving room always knows an input is imported, not native — keep it.
- **A bridge is a capability, not a backdoor.** It can only relay between rooms whose capability tokens it holds. Possessing both tokens *is* the authorization to connect them — the same object-capability rule as joining a single room ([`SECURITY.md`](SECURITY.md)). Do not run a bridge into a room you were not given the cap to.
- **Closure still happens per room.** A bridge shares inputs and outputs; it does not merge the rooms. Each perspective still reaches its own group closure ([`Room_Best_Practices.md`](Room_Best_Practices.md)) over the inputs it now has.

## Honest scope

`bridge.mjs` relays the live input/output layer (channels, chat) and — opt-in — durable **lemma** and **governance/group** state, verbatim so signatures carry through. It deliberately does **not** bridge **currency/note transfers** (`note-pass`/`note-redeem`/`note-receipt`): those are targeted, conservation-checked value moves, and relaying them across rooms would double-spend or misroute value — currencies belong to one room's ledger. (A room's currency *declarations* could be bridged read-only in a future revision; transfers should not.) Because receivers cannot re-derive a forwarded envelope's witness (`dyncap.ts`), bridged state inherits the *forwarder's* trust — run bridges you and your counterparts trust, and only into rooms whose caps you hold. The QLF ER=EPR framing is a faithful analogy for *how* information becomes shared (a mutual closure through a member of both), not a claim that the two rooms become one entangled quantum state.

## Related

- [`Room_Best_Practices.md`](Room_Best_Practices.md) — reaching quality closure within a single room.
- [`scripts/qos-cli/README.md`](scripts/qos-cli/README.md) — the headless-peer tools (`qos-cli`, `qos-daemon`, `agent`, `bridge`).
- [`MyRoom.md`](MyRoom.md) — running your own room.
- QLF: [`ER_EPR_QLF.md`](https://github.com/rhovision-org/quantum-logical-framework/blob/main/ER_EPR_QLF.md), [`MultiParticle.md`](https://github.com/rhovision-org/quantum-logical-framework/blob/main/MultiParticle.md) — entanglement as a shared closure; the two-history interaction manifold this bridge realizes.
