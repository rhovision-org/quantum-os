# Connection & networking

Detail split out of [CLAUDE.md](../CLAUDE.md). Covers the transport (the
relayed, room-keyed control plane), the signaling relay's trust model, room
capacity, the bounded-degree WebRTC overlay, leased peer IDs, `/ice`
diagnostics, the default TURN relay, and the signaling-reconnect / false
leave-join fixes.

---

## The transport — one connection per person, and a seat that survives a blip

Modelled on what works (Jitsi), after a season of "people keep getting
dropped": every participant holds **one** connection that the room depends on
— the signaling WebSocket, TLS on 443, to a host with a public address — and
that is the path chat and state take. WebRTC is kept for what only it can do.

| | control plane | media & bulk |
|---|---|---|
| carries | chat, `name`, lemmas, notes, polls, gov, every `sync-*` — every envelope that is not below | calls (`MediaStreamTrack`s), attachments (`file-start`/`file-chunk`), `/file get` (`lib-part`) |
| path | `{type:"data"}` frame over the signaling socket, relayed by the server | direct WebRTC data channel / media, dialled over the ring+skip overlay below |
| when it fails | the server holds the seat (below) and the client queues (`outbox`) — a blip loses nothing | the sweep redials; the link is opportunistic and nothing the room depends on |
| API | `send(to, msg)` / `broadcast(msg)` | `send(to, msg, {bulk:true})` (needs `hasChannel`) / `broadcast(msg, {bulk:true})` (floods the overlay) |

**The relay cannot read the room.** Each frame's payload is the envelope
sealed with **AES-256-GCM under a key derived by HKDF-SHA256 from the room
capability token** (`packages/browser/src/room-crypto.js` — plain JS, the same
file the browser and the Node agents both run, so one derivation, not two).
The sender's peerId is bound in as GCM additional data, so a relay that
re-labels a frame's `from` produces a frame nobody can open. The server is
told only `SHA-256("qos-room-id:" + token)` as the room's name — it **used to
be handed the raw token on `join`**, i.e. the capability to join any room it
relayed. Now holding the room's name is not holding the room. Symmetric only,
no keypair: nothing here is exposed to Shor (see [SECURITY.md](../SECURITY.md)).
What it does *not* do is stop the relay replaying a frame under its original
`from` — the dyncap-signed kinds carry a monotonic `seq` and catch that; plain
chat does not.

**Membership is the server's roster, held across a blip.** A socket that dies
(a phone switching apps, a wifi handoff, a lid, the server itself restarting
under everyone) does not remove the peer: the server **holds the seat** for
`SIGNAL_GRACE_MS` (60 s), tells nobody, queues control-plane frames for it
(`QUEUE_MAX_MSGS`/`QUEUE_MAX_BYTES`, oldest dropped), and a `join` under the
same peerId inside the window is a **resume** — `peers` comes back with
`resumed: true`, the queue is replayed, no `joined` is broadcast. A rejoin on a
new socket while the old one is still open (a phone that reconnected before we
noticed) supersedes it. Only the grace expiring, or an explicit `leave`, is a
departure — and a `leave` is only honoured for the socket's own seat (before
this any socket could `leave` anyone). The browser sends `leave` on `pagehide`
(not `persisted`), so closing the tab is immediate; `QOSPeer.leave()`.
`peer.ts`/`qospeer.mjs` fire **`onPeerReady(id)`** — where the app's handshake
(`name`, `sync-*`) now lives — for each peer on a fresh join and for each
newcomer, and **not on a resume**, so a blip does not re-serve the room's whole
state to everyone (that used to hang off `onChannelOpen`, so a peer with no
direct WebRTC path never got it at all). **A WebRTC connection dying is not a
departure**: a data channel closing or a pc reaching `failed` for a peer the
server still lists tears the pc down for the sweep and reports nothing;
`onPeerLeft` follows the server's `left`. `isReachable(id)` is "the server
lists them" (or a direct channel); `hasChannel` stays the narrower question a
call or a file needs, and what `/conn` diagnoses. The `⚠` in the roster
therefore means "the server no longer lists this peer", which clears itself.

**A socket is trusted only while it is heard from** (`peer.ts` `lastInboundAt`
/ `suspect`). A phone that switches apps has its TCP dropped by the OS under
the frozen tab, and on return the WebSocket still reads `OPEN` for minutes —
`wake()` used to send a `join` into that void and everything typed followed it.
Now `readyState` is a claim and traffic is the proof: on `wake()` the socket is
*suspect* until the join's own `peers` reply arrives (outbound waits in the
outbox meanwhile), and if nothing arrives within `WAKE_PROBE_MS` (4 s) the
socket is closed and replaced at once — a resume, inside the server's grace.
In the foreground the same idea runs on a timer: an app-level `ping` (the
server answers `pong`; a browser cannot send a protocol ping and never sees
the server's) after `QUIET_MS` (25 s) of silence, and a reconnect after
`SILENT_MS` (70 s). Any inbound frame at all — even an error — counts.
`document` `resume` (Page Lifecycle) wakes rooms alongside `visibilitychange`.

Why this shape: before it, N−1 NAT-crossing WebRTC connections had to hold for
chat to work, every socket blip became a `left`/`joined` and a redial storm
for the whole room, and the server's logs showed one machine's uplink flapping
being amplified into "everyone keeps dropping" (the facilitator and a browser
on the same laptop reaped within 3 ms of each other, back within a second of
each other 15 minutes later — a lid). With one resumable connection per
person, a flap is that person's few seconds of silence, replayed. Tests:
`packages/signaling/test/server.test.mjs` (real sockets: relay, sender check,
hold, resume with replay, grace expiry, explicit leave, zombie superseded) and
the control-plane block of `packages/browser/test/peer.test.mjs`.

## Signaling server trust model

The signaling server is an **untrusted relay**:
- Routes SDP/ICE between peers, and relays the sealed control-plane frames it cannot open (above); never sees WebRTC data channel or media contents either (DTLS-encrypted)
- Knows a room only by the hash of its token — it cannot join what it relays
- `wsIndex: Map<WebSocket, string>` — binds each socket to its peerId at join; validates `msg.from` on every relay (`offer`/`answer`/`ice` **and `data`**) and `peerId` on `leave` to prevent forgery
- Rate-limited per connection as a **token bucket** — `SIGNAL_RATE_LIMIT` sustained (200/s on the public deployment via `render.yaml`, 20/s if unset) with `SIGNAL_RATE_BURST` depth (4× by default). Joining is bursty then quiet — offers plus their ICE candidates arrive in a clump — and a fixed window punished exactly that shape; the sustained rate protects the server, the burst is what lets a legitimate join land. The client staggers its offers (`JOIN_STAGGER_MS`, 250ms) **and holds at most `MAX_IN_FLIGHT` (3) handshakes at once**, since the burst is otherwise self-inflicted: a dial is an offer plus a trickle of ICE candidates, so dialling everyone at once makes a join cost a burst that grows with the room — past what the server carries per connection, handshakes stop completing, which from inside a browser looks exactly like peers who never arrived. A server refusal is now **surfaced into the room** (`onSignalingError`) instead of going only to the console, so "rate limit exceeded" is a thing you read rather than a thing you argue about
- Message size capped at 256 KB (`SIGNAL_MAX_PAYLOAD`; 64 KB before the control plane rode the socket — a `sync-*` envelope for a large room needs the headroom, and the clients refuse to send a frame over the cap rather than be cut off for it)
- Logs show only last 8 chars of IDs

## How many people a room holds

Full mesh: every browser opens a connection to every other, so the cost per person is the room's size and a browser gives out somewhere past ten (fewer on a call, where each link carries media). `ROOM_HOLDS = 10` in `app.ts` is that fact, not a configured cap — nothing is refused at the door. Five is where a group actually thinks together, so the human limit binds first.

What matters is that the room **says so**: a peer nobody can reach at all — no direct channel and no overlay relay traffic either — is `⚠`/dimmed (`QOSPeer.isReachable`; `hasChannel` still answers the narrower "am I directly linked to them," used by `/conn`), the status line counts them, **The two rosters can disagree.** A `peers` list replaces `QOSPeer.roster` wholesale, so a peer the server omitted once — mid-flap, or joining as the list was built — is dropped there while `app.ts` still shows them present; nothing dials them, and the room reports somebody it is making no attempt to reach (`connection none · ice none`). `ensureConnected(peerId)` lets the side that knows repair it, and the unreachable warning calls it rather than reporting and waiting. **Replacing our own connection is not the peer leaving**: `createPeerConnection` detaches the stale connection's handlers before closing it, because closing fires them and they declare the peer gone — so every retry produced a `left`, and the new channel opening produced a `joined`, which reads as peers flapping while nothing has happened. The sweep **never redials an attempt already in flight** (`connecting()`): a connection still negotiating has no open channel either, and redialling sends a fresh offer with a new ICE ufrag, so the far side rebuilds and the negotiation in progress is discarded — a peer whose path is merely slow (mobile: more candidates, longer checks) would be reset before it could ever finish. Answering an offer counts as an attempt for the same reason. `RETRY_MIN_MS` is 20s and an attempt is given `ATTEMPT_PATIENCE_MS` (45s) before it counts as stuck. A handshake still unfinished after `HANDSHAKE_GRACE_MS` (30s — deliberately longer than a retry cycle, since `peer.ts` sweeps every 12s and first retries at 8, so a shorter grace announces a failure while the repair is still running) posts one line per peer, cleared by a `✓ connected after all` when the channel does open — "the room is full" past `ROOM_HOLDS`, "the handshake never completed" below it. Unmarked, this is indistinguishable from chat being broken, which is how it was reported: two browsers each had a channel to the agents and none to each other, so only the agent's replies landed.

Past ten needs a different topology (an SFU for media, a relay or partial-mesh/gossip overlay for data), not a bigger rate limit — this is that overlay, for data.

## Bounded-degree connection overlay — ring + skip-links

Full mesh means every peer opens N−1 connections, and the join cost is worse than that: a joiner's own dial burst (N−1 offers plus their ICE candidates, all at once) is what actually trips the signaling server's rate limit — measured on the public server at "7 peers → 0 of 6 channels open, 5 → 1 of 4, 4 → 3 of 3" (`scripts/qos-cli/README.md`). Several headless agents (facilitator/scribe/skeptic/greeter) alongside a couple of browsers already sits at that wall.

**`ringSkipNeighbors(sortedIds, myId)`** (`peer.ts`, mirrored zero-dependency in `scripts/qos-cli/ring-neighbors.mjs`, both consumed by `qospeer.mjs`) is the fix: sort everyone present lexicographically (the same string comparison already used for glare/politeness) and connect only to the peers one and two positions away in each direction — degree 4. It's a **pure function of the roster**, so every peer computes the same neighbor sets independently with no coordination message, and the relation is symmetric by construction (if B is in A's neighbor set, A is in B's). **This degenerates to exactly today's full mesh for five or fewer peers** — every peer is within distance 2 of every other at that size — so there is no separate "mesh vs overlay" mode or size threshold anywhere; one formula, and it only starts capping *new* dials once a room reaches six (existing connections are never actively closed for falling outside it — see `reconcilePrune` below).

**`QOSPeer.targetPeers()`** (private) is `ringSkipNeighbors(...) ∪ pins`. **`pinNeighbor(peerId)`/`unpinNeighbor(peerId)`** (public) add/remove a peer from `pins` — always-direct regardless of ring position, additive on top of the computed degree-4 set. Used for: any peer whose `name` envelope carries an `agent` field (every AI agent in the room, not scoped to "yours" — there's no wire signal to tell whose agent it is), and `ensureConnected(peerId)` (the `/conn`-driven "connect now," which now pins so the fix doesn't silently regress a short time later once the ring reconciles). Pinning is deliberately unbounded and un-prioritized — no eviction scheme if pins push total degree past the 4-6 budget; the system just runs over budget rather than silently degrading (issue #111 tracks this and the other known limitations). **A departure clears any pin on that peer** — otherwise `ensureConnected`/an agent-tag pin would have `sweep()` chasing someone provably gone forever, which is exactly the regression `peer.test.mjs`'s original "a peer that left is not chased" test exists to catch, and did catch during this work.

**`reconcilePrune` is deliberately inert — an already-open connection is never actively closed for falling outside `targetPeers()`.** It shipped active (a grace timer, `PRUNE_GRACE_MS` 30s, that closed a now-out-of-range link) and was disabled after live testing showed the real cost: a roster change reshuffles ring positions for *everyone* in the room, not just the peer that joined/left, so one bouncing/flaky peer could cascade into closing *other* peers' entirely healthy connections as a side effect — amplifying one device's instability into churn across the room. The grace period bounded how often that could happen, not whether it could. `targetPeers()`/`ringSkipNeighbors` still bound who gets *newly* dialled — that's the actual fix for the join-burst/rate-limit problem this overlay exists for — only the active *closing* of a working connection is gone. Accepted tradeoff: connection count can only grow past 4 over a long session with a lot of churn, never shrink back on its own. `prunePeer`/`clearPruneTimer`/`pruneTimers` stay in place and tested (closes a link without ever firing `onPeerLeft` — the peer usually hasn't left the room, just stopped being a direct neighbor, and app.ts's leave handling assumes true departure) for a deliberate future re-enable behind something better than a fixed per-peer grace timer — e.g. only pruning once the *room*, not just one peer, has been stable for a while.

**Bulk relay over the overlay is flooding, not routing** — this whole mechanism now carries only `{bulk:true}` traffic (attachments, `/file get`), since the control plane rides the signaling socket (see the transport section above). No routing table, a deliberate simplicity tradeoff. `broadcast(data, {bulk:true})` tags the payload with `_relayId` (unique per broadcast), `_hops` (a remaining budget, `max(4, ceil((roster.size+1)/2))` — roughly 2x the true ring+skip diameter, erring generous since dedupe bounds the cost of over-relaying but an undersized budget means a genuine delivery failure), and `_from` (the true originator — without it a relayed message would be attributed to whichever neighbor forwarded it last, the wrong name in chat and the wrong dyncap-anchor cross-check), then sends to every open channel. `send(targetPeerId, data)` stays **raw and untagged** when a direct channel is open — byte-identical to before, so anyone already directly connected (old build or new) sees no format change at all; only when there's no direct link does it flood, additionally tagged `_relayTo`. On receipt, a tagged message dedupes against a bounded `Set` (`seenRelay`, cleared past 5000 — mirroring `bridge.mjs`'s own durable dedupe `firstState`, not its transient `firstTime`, since this must survive the message's full multi-hop lifetime), strips the tag fields before delivery (`delete`, not `undefined` — `bridge.mjs`'s `stripMeta` idiom) so `onMessage` callers see the exact original payload unchanged, delivers only if untargeted or addressed to this peer, and **always** relays onward to every other neighbor if hops remain regardless of whether this hop was the target — that's what lets a directed send reach through peers who aren't the recipient. The `_hops` field name is deliberately reused from `bridge.mjs`'s own cross-room relay tagging, but counts in the opposite direction (down from a budget here, up to a ceiling there) — by the time a message reaches `bridge.mjs`'s handler this file's own `_hops` has already been stripped, so there's no collision, just a naming echo worth knowing about. **Originating a broadcast/send also marks its own `_relayId` seen immediately** (not just on receipt) — otherwise a flood that loops all the way around the ring back to its own originator would be delivered to `onMessage` twice.

**Dyncap signatures are unaffected**: `signedBroadcast`/`signedSend` (app.ts) sign a `dyncap`-stripped canonical form *before* calling `qpeer.broadcast`/`send`; the relay fields are added after signing and stripped again before `onMessage` fires, so `verifyEnvelope` downstream always hashes exactly what was signed.

**New trust consideration, honestly flagged, not a blocker**: an unsigned direct-send kind (`rdv-propose`, `note-pass`) routed through ≥2 hops could now be dropped or tampered with by an intermediate relay peer — not possible when every send was a direct DTLS link. Signed kinds are unaffected (tampering invalidates the signature at the true recipient). Existing timeout/retry (rendezvous's 60s proposal timeout) already covers "the message didn't arrive"; nothing new was built for this.

**`isReachable(peerId)`** is "the server lists them" — the relay reaches everyone in the roster — or a direct channel, or bulk-relay traffic seen from them (`lastHeardVia`, keyed off `_from`) within `REACHABLE_WINDOW_MS` (45s). The periodic `{kind:"presence"}` flood that used to keep this honest is gone: presence is the server's word now. `hasChannel`/`connectionReport` are unchanged and stay meaningful on their own for `/conn`'s direct-link diagnostics — "am I directly linked to X" (a call, a file) is a different question from "can I reach X at all."

**Required follow-up, not yet built**: `calls.ts`'s `addLocalMedia` iterates `this.connections` — only direct links, since a `MediaStreamTrack` can't be relayed. Starting a call in a room past the degeneracy threshold without pinning every participant first would silently transmit audio/video only to the caller's 4 ring-neighbors. Tracked in issue #111 along with the other known limitations (no k-connectivity proof — best-effort resilience only; no eviction/priority scheme for pin overrun; flooding's bandwidth cost for a directed send).

## An identity that survives a phone discarding the tab

`peerId` lived in `sessionStorage` alone: per-tab, which is right (two tabs must differ), but **a mobile browser throws sessionStorage away when it evicts a backgrounded tab**. So a phone whose screen locked rejoined as a *new peer* every time, and the room filled with ghosts of its previous incarnations — each listed, each unreachable, each intro'd to again by the agents, until the signaling heartbeat evicted them. Every symptom of that reads as a connection problem and none of it is one: `⚠` on hex ids nobody could ever reach, `connection none · ice none`, and three greetings to one person.

So an id is **leased** (`claimPeerId` in `peer.ts`): a live tab refreshes `qos-peer-lease:<id>` in localStorage every 5s, and a load with no sessionStorage id reclaims any lease older than 20s rather than minting. Two tabs open at once still differ — both leases are fresh, and only an expired one can be taken.

**The lease is scoped to the dyncap anchor.** It records `{at, anchor}` (a bare timestamp is legacy, read as anchorless), and `claimPeerId` reclaims a stale lease only if its `anchor` matches this browser's current one (`myAnchor()` reads `qos-dyncap-state` directly, no dyncap.ts import; anchorless legacy leases are grandfathered). Without this, an identity that *changed* — a `/login` recovery, a partial storage clear, an incognito key that leaked — would inherit a `peerId` that other peers TOFU-pinned to the **old** anchor, and every signed `name`/`lemma`/… from it is then refused as `anchor-mismatch`. A changed identity now mints a fresh id and TOFUs cleanly. `test/peer.test.mjs` covers both directions (another identity's stale lease is not taken; our own still is).

**`name` survives a dyncap refusal (`app.ts`, inbound `name` handler).** A `lemma`/`note-declare`/`sync-*`/`retract` envelope that fails `verifyDyncapIfPresent` (`"  · refused: …"`) is dropped. A **`name`** envelope is not — the receiver applies the claimed name with a ` ⚠` suffix (into `peerNames` and `lastKnownNames`), posts one warning line, and re-renders, while still skipping `reconcileGroups` and the agent pin (the parts that *trust* the chain). A display name is cosmetic (anyone can `/name` anything; the chain never owned it), and refusing to render it left a peer whose chain went contested — the exact `/login` / reused-peerId case above, until they clear storage — as a permanent hex id, which made the room unusable with them and *hid* the impersonation instead of flagging it. SECURITY.md records the reasoning.

## Whether two peers can connect at all (`/ice`)

Before any of this: **a browser may have no WebRTC**. `RTCPeerConnection` missing is not a network problem and no relay, retry or reload touches it — that browser cannot reach anybody. `webrtcMissing()` is checked in `connect()` and names the three causes, which have different fixes: a privacy extension or shield, WebRTC disabled in settings, or an in-app browser (a link opened inside a chat or mail app). Seen live: a laptop where `/ice test` answered `RTCPeerConnection is not defined` while the same person's phone connected fine.

STUN only tells each side what its public address looks like; the connection is still made **directly**. Two peers behind symmetric NAT — a corporate network, mobile CGNAT — have no address pair that works, so the handshake fails **permanently** and the retry sweep cannot help: it is not a timing problem. Only a TURN relay crosses that.

`peer.ts`'s own `DEFAULT_ICE` constant is STUN alone — the app layer supplies a relay by default (see below). `/ice list · auto · test · stun · turn · reset` is where a relay is chosen or turned off — and it is **excluded from the qlf broadcast**, because a `/ice turn` entry carries a username and password and the envelope would have carried them to the whole room, persisted per device (`qos-ice`) and merged with the sidebar's STUN field by `iceServersFor`. Which side is at fault is answerable from the room rather than guessed: the peer that fails against **everyone remote while peers on the same machine still work** is the one whose network cannot be crossed, and **a relay on that side alone is enough** — the other side reaches the relay's public address. **`/ice test`** gathers candidates (until gathering completes, or 5s), **including the auto-fetched relay** (so a `relay ✓` means *this browser's actual next call* can cross a hard NAT, not just that some STUN server answered), and names what the network allows — `host` (same LAN), `srflx` (STUN answered), `relay` (a TURN server is available) — the difference between "this pair is slow to connect" and "this pair cannot connect". The result is **one fenced block, kept on the device** (`qos-ice-last`) and re-readable with `/ice last`: a diagnostic is only useful once somebody else has read it, and on a phone five separate lines are easy to lose. A failure of the test itself is reported rather than swallowed — silence read as "no candidates", which is a different diagnosis entirely.

## Calls must work across networks — a default TURN relay (quantum-os#126)

**Chat surviving a NAT boundary used to hide that calls don't.** A data-channel message floods peer→agent→peer with no direct link required (the bounded-degree overlay's relay); a `MediaStreamTrack` **cannot** be relayed that way — a call needs either a direct ICE pair or a TURN relay. So a call between two peers who couldn't form a direct pair (symmetric NAT, mobile CGNAT, a NAT'd container like Crostini) produced **no video at all, silently** — reported live: jim ↔ jimscarver, different networks, "chat works but video is lost". STUN-only was a deliberate choice (see above) made on the reasoning that *whose machine your traffic passes through is the user's decision* — true, but a default that makes the tool's core use case (two people who aren't in the same building) not work isn't a neutral default, it's a broken one for most real rooms.

**The fix ships a default relay, kept overridable.** `TURN_KEY_ID` / `TURN_KEY_API_TOKEN` (Cloudflare Realtime's TURN Service) are environment variables on the **signaling** deployment — never in `render.yaml` (committed to the repo), never shipped to the browser. `packages/signaling/src/turn.ts` mints a short-lived credential from them (`POST rtc.live.cloudflare.com/v1/turn/keys/{id}/credentials/generate`, cached 1h server-side against a 24h Cloudflare TTL so a re-mint always has most of its life ahead of it) and `GET /turn` on the signaling HTTP server (CORS-open — the response isn't a secret, it's a Cloudflare-expired credential anyone who already knows the room's signaling URL could reach the same way) hands back `{iceServers: [...]}`. The master API token **never leaves the signaling process**.

- **Browser** (`app.ts` `fetchAutoTurn`): `connect()` awaits a 4s-capped fetch of `<signalingOrigin>/turn` and merges the result into `iceServers` before constructing `QOSPeer`. Best-effort throughout — offline, CORS, a signaling deploy with no `TURN_KEY_*` set, a slow cold start all fall back to `[]` (STUN-only), never throw, never hang `connect()`. `connectBtn.disabled` brackets the await (the only re-entrancy guard on `connect()` — `qpeer` stays null until `setQpeer` at the very end — used to be adequate because the whole function ran in one tick; the await broke that).
- **`/ice auto on|off`** (default on, `qos-ice-auto` in localStorage) is the opt-out — same reasoning as `/ice turn` never being silently defaulted before this: a relay is still a decision, just one this tool now makes *for* you by default rather than leaving cross-network calls broken until you knew to look. `/ice list` reports the auto-relay state; `/ice turn` still lets you substitute your own.
- **Agents** (`qospeer.mjs` `_loadAutoTurn`/`_iceServers`) get the same fetch — the flood relay only works at all if *some* agent actually holds a direct link to both sides of a NAT boundary, so an agent that can't be dialed directly is a relay gap, not just a media gap. Skipped entirely when the caller passed an explicit `iceServers` (tests, `loopback.mjs`, `media-reject.selftest.mjs` all pass `iceServers: []`, which is truthy — no network calls in tests). `turn-relay.selftest.mjs` covers merge / empty / unreachable / explicit-override against a stand-in HTTP server.
- **A cross-network call that still can't cross is surfaced** (`calls.ts` `checkMediaReach` / `CallHost.mediaBlocked`, quantum-os#126 part 2): ~12s and ~35s after a call starts, any non-agent room peer whose direct connection has `failed`/`disconnected` (or, on the later strict pass, is still stuck `checking`/`connecting`) gets one chat line naming them — "can't get the call … try `/ice turn …` or `/ice test`". Chat still floods to them, so nothing else says the call is one-way. Each peer is named once per call; the warned set clears on `end()`.
- **Render can't host TURN itself** — it exposes one HTTP(S) port per service; TURN needs raw UDP (3478 + a relay port range). Cloudflare Realtime was chosen because it needs no server at all. A paid Render tier is still worth it for the **signaling** service specifically — it removes free-tier sleep-on-idle, the actual cause of the `signaling dropped (1006)` reconnect churn (`render.yaml` documents the intended `plan: starter`, but a hand-created service ignores the file — same gotcha as `SIGNAL_RATE_LIMIT` — so the plan change is a dashboard action).

## Signaling reconnect / false peer left-right

When the signaling WebSocket drops and reconnects (Render.com sleep, network blip):

- **`peer.ts`**: On receiving the `"peers"` list after reconnect, skip peers where the WebRTC data channel is still open — avoids tearing down a working connection
- **Reconnect = rebuild, not renegotiate (the reload fix)** — `peer.ts` **and** `qospeer.mjs` `handleOffer`: a **reload keeps the peerId** (sessionStorage) but dials in with a **fresh ICE session**. If the answerer still holds an `"open"` stale connection to that peerId (the close not yet detected — racy), answering the fresh offer *as a renegotiation on the dead pc* never resurfaces the peer's **new data channel** (`ondatachannel` doesn't re-fire on renegotiation), so the reloaded peer connects-but-stays-silent — no `name` announce, no messages, just a hex id, and only for the non-deterministic subset of peers whose stale connection lingered. Fix: compare the offer's **`ice-ufrag`** to the live connection's (`iceUfrag`/`_iceUfrag`) — **same ufrag** = a genuine same-session renegotiation (keep the pc, e.g. call media added); **different ufrag** = the peer reconnected/reloaded ⟹ **rebuild a clean pc** (resurfaces the data channel ⟹ `onChannelOpen` fires ⟹ re-announce). Do not "reuse the existing pc on any second offer" — that reintroduces the silent-reload bug. (Browsers are stricter here than werift, which masks it with an implicit ICE restart — so it reproduces in the real browser, not the werift↔werift loopback.)
- **`peer.ts` presence eviction (stale-room fix)**: an *ungraceful* drop (killed tab, network loss) sends no `leave`, and the connection often never reaches `"failed"`. So `declarePeerGone` fires `onPeerLeft` on **data-channel `onclose`** (the reliable signal for a clean tab-close); `"disconnected"` starts a grace timer (`disconnectTimers`) and evicts only if it doesn't recover to `"connected"`. `declarePeerGone` is idempotent (a had-connection guard), so the channel-close and state-change paths can't double-fire
- **An ICE `"failed"` to a peer still in the room is *unreachable*, not *gone*.** `"failed"`/`"closed"`/`"disconnected"`(after grace) used to call `declarePeerGone` unconditionally. But `"failed"` means *no candidate pair worked* — a cross-network peer with no working TURN never completes a **direct** handshake — and that is a different fact from "they left". Declaring them gone dropped them from the app roster, so a cross-NAT peer **vanished for everyone who couldn't dial them directly**, even while their chat still relayed fine through an agent (reported live: "different network, chat works but peer not listed"). Fix (`onconnectionstatechange`): if `this.roster.has(peerId)` (signaling still lists them) → `cleanup()` the dead pc so the sweep redials, back `retryAt` off one `RETRY_MIN_MS`, and **return without `onPeerLeft`** — the peer stays a known, retried peer and `renderPeers` marks them `⚠` via `isReachable` (which stays true as long as relay traffic flows, so a relay-reachable peer shows normally). Only when they're **not** in the roster does `"failed"` still `declarePeerGone`. The authoritative "they left" is the signaling `left` message; the data-channel `onclose` path still declares gone for a peer we actually held a channel to. `test/peer.test.mjs` covers both directions. The real fix for the underlying cross-NAT case is a **TURN server** (`/ice turn`) — STUN-only `DEFAULT_ICE` cannot cross symmetric NAT / mobile CGNAT and the retry sweep cannot help.
- **`qospeer.mjs` glare handling (the facilitator↔skeptic rebuild-storm fix)** — `peer.ts` (browser) has had perfect-negotiation glare arbitration for a while; `qospeer.mjs` (node) had **none**. Two node agents on one host (facilitator + skeptic) dial each other on the same tick every time the roster changes, and with no arbitration each tore down its own outstanding offer to answer the other's — both answers then landed on a pc that was already replaced (`_newPC` closes the old one), `_handleAnswer`'s `signalingState !== "have-local-offer"` guard dropped them, and neither side ever completed. Result: an **infinite rebuild** — `onChannelOpen` firing hundreds of times, `serveStateTo` on every one (`serving state to <peer>` thousands of lines), both cores pegged at 35–66 ticks/s while the room sat idle. Three parts, all ported from `peer.ts` which already had them: **(1)** a `makingOffer` map + the perfect-negotiation rule — on an inbound offer while our own is outstanding (`makingOffer` set, or `signalingState !== "stable"`), the **larger peerId keeps its offer and ignores the incoming one**; the **smaller yields**, clears `makingOffer`, and answers (rebuild-as-rollback). **(2)** `_connecting(peerId)` — a pc that's `new`/`connecting`/`checking` with an attempt younger than `ATTEMPT_PATIENCE_MS` (45s) is left alone: the `peers` sweep and `pinNeighbor` no longer restart a dial already in flight (a `name` re-announce carrying `agent:<role>` calls `pinNeighbor` on every arrival, and `_newPC` mid-negotiation is what turned that into churn). `attemptAt` is stamped in `_initiate` and `_handleOffer` (answering counts). **(3)** `serveStateTo` in `room-memory.mjs` is cooled to once per peer per 15s — the payload is idempotent, so re-serving it on a flap is pure cost, and an unstable link flaps repeatedly. `loopback.mjs` forces a simultaneous A↔B dial and asserts `onChannelOpen` fires ≤ 3× per side (was hundreds).
- **`qospeer.mjs` disconnected-teardown (the pegged-CPU fix)** — the Node-side counterpart of the `peer.ts` presence eviction above, and the same root cause: **werift never escalates `"disconnected"` to `"failed"`** (its ICE layer implements no consent-freshness timer; `iceConnectionStateChange` maps `disconnected → setConnectionState("disconnected")` and nothing moves it on). `_newPC` cleaned up **only** on `"failed"`, so a peer that vanished silently (closed browser, shut lid, dropped wifi) parked a connection in `"disconnected"` **forever**: `pc.close()` was never called ⟹ `sctpTransport.stop()` never ran ⟹ the SCTP association retransmitted its unacked queue at full speed, re-encrypting every chunk through werift's pure-JS DTLS. **One zombie peer pegs a core indefinitely** — measured at 79% CPU on a facilitator with **0 UDP datagrams/s in or out** (the giveaway: it encrypts into a void, since the transport is gone). Fix: also tear down on `"disconnected"` after `DISCONNECT_GRACE_MS` (30s), re-checking that the **same** `pc` is still stuck so a recoverable blip doesn't kill a live peer; `_cleanup` now deletes from the maps *before* closing (`close()` can fire a state change re-entrantly) and routes the `close()` rejection to `onError` instead of swallowing it — `close()` is **async** and awaiting `sctpTransport.stop()` is the whole point. **Diagnosing a recurrence:** compare CPU against UDP throughput (`/proc/net/snmp` `Udp: OutDatagrams`) — high CPU + ~0 pkt/s means an orphaned association, not real traffic; `ps` `%CPU` is a *lifetime average* and understates it, so use `top -bn1` or a `/proc/<pid>/stat` delta. A CPU profile pins it instantly (`Profiler` over the inspector): the stack is `transmit@sctp.js → sendChunk → dtls → encryptPacket → createCipheriv`. Note the burn is **independent of signaling churn** — it recurred after a restart with only ~67 reconnects in 19h.
- **`qospeer.mjs` rejects call media (`_rejectMedia`) — the second pegged-CPU fix, and the one that actually blocked running >2 agents.** A node agent is data-only, but when a browser peer starts a **call** (`/record` too), `calls.ts` `addLocalMedia` renegotiates with **every** peer — agents included — putting `m=audio`/`m=video` in the offer. `qospeer.mjs` had **no media handling at all**, so werift did its default: auto-create `recvonly` transceivers, register SSRC receivers, and then **decrypt + parse every inbound RTP packet in pure JS** (`srtp.decrypt` → `RtpPacket.deSerialize` → `router.routeRtp` → `rtpHeaderExtensionsParser` per packet — the SRTP path in `transport/dtls.js` runs unconditionally once started, direction is not checked). Measured live: **one call → three co-located agents (facilitator + skeptic + scribe) pegged a machine**, `RtpHeader` / `getBit` / `handleRTP` / `decryptRtp` topping each agent's CPU profile at ~20–25%. This is why `run-agents.sh` only ever launched two and `scribe` "had" to be by hand — the third agent is what tipped a call into unusable. Fix: `_handleOffer` calls `_rejectMedia(pc)` after `setRemoteDescription`, before `createAnswer` — walk `pc.getTransceivers()` and `setDirection("inactive")` on every audio/video one. werift then emits a **rejected m-line** (`m=audio 0` / `a=inactive`), so a compliant peer sends **no RTP** and the decrypt loop never runs. The data channel is untouched (`m=application` stays). Also fixed alongside: the `sameSession` renegotiation branch now guards on `signalingState === "stable"` (a call adding media mid-glare otherwise threw `Cannot handle offer in signaling state have-local-offer` and fell to `onError` — seen in `scribe.log`). `media-reject.selftest.mjs` covers it. **Required follow-up still open (issue #111):** `calls.ts` `addLocalMedia` iterates only direct links, so a call in a room past the ring-overlay degeneracy threshold still needs every participant pinned.
- **`werift-patched.mjs` — the per-ICE-candidate SDP-rebuild burn (issue #125).** werift rebuilds the entire offer SDP on every inbound ICE candidate, and each rebuild calls `RTCCertificate.getFingerprints()`, which **re-parses the cert PEM (ASN.1) and re-hashes it** — ~1.5 ms a call on a laptop. A room of a few peers doing ordinary ICE keepalives / consent-freshness / trickle is a continuous stream of full rebuilds; two co-located agents burned **~40 %/core each with the room otherwise idle and their logs quiet** (measured; profile tail `addIceCandidate → buildOfferSdp → addTransportDescription → get localParameters → getFingerprints → Certificate.fromPEM`). The fingerprint is a pure function of the cert, which werift generates once in `setupCertificate()` and never mutates — so `werift-patched.mjs` **memoizes `getFingerprints()` on the instance**, keyed on `certPem` so a hypothetical cert swap still recomputes. `qospeer.mjs` imports werift *through* this wrapper (and therefore every agent and `qos-cli.mjs`, which delegates to `QOSPeer`), which patches the shared class prototype for the whole process; the returned `RTCDtlsFingerprint[]` is byte-identical, ~5000× cheaper. `werift-patched.selftest.mjs` guards against a werift bump that renames the method or `certPem`.
- **`room-memory.mjs` `serveStateTo` skips an unchanged re-serve (`_servedSig`).** The 15s cooldown bounded the *rate* of full-state serves to a flapping peer but not the total — a peer whose channel bounced every ~20s for two days earned 7,487 `serving state to …` lines (91% of `facilitator.log`) and the payload build/sign/send each time. Now a per-peer signature of everything the serve would send (`stateSignature()` — lemma names+twists, currency tokens, series keys, group id+size) is compared; an identical re-serve is dropped silently regardless of time. A real new joiner has no signature on file; a genuine state change invalidates it for every peer. `forgetPeer(id)` (wired from `onPeerLeft` in `agent.mjs` / `qos-daemon.mjs`) drops both maps on departure.
- **Present is not reachable (`hasChannel`)**: the signaling server lists a peer as soon as it joins, but the WebRTC handshake is separate and can simply never complete — the public server rate-limits the offer/answer/ICE exchange itself, so past a handful of peers in one room some channels never open. Everyone appears in the room and nothing typed reaches them, which reads as "chat is broken" rather than "you are not connected to them" (reported that way: two browsers each had a channel to the agents and none to each other, so only the agent's replies landed). `QOSPeer.hasChannel(peerId)` answers it; `renderPeers` marks those peers `⚠`/`.unreachable` and `connectedLabel` counts them, so the failure is visible where the peer is. `onChannelOpen` repaints unconditionally — a peer already listed from signaling needs the mark cleared.
- **Async command output belongs to a room (`inRoom`)**: `activeRoom` is aliased state that inbound callbacks swap while they work, so a command answering after an `await` can append its lines to whichever room happened to be current — where they are invisible, or rendered and then wiped by the next transcript repaint (which replays the *viewed* room's log). That is what "the message flashed briefly" is. `inRoom(ctx, fn)` captures the room at command time and restores after, the way the peer callbacks already do; `/ice test` and `/rholang explain` use it.
- **`app.ts`**: `onPeerLeft` is debounced 6 seconds via `pendingLeaves: Map<string, timer>` and is idempotent (one pending-leave per peer). If the peer rejoins within the window, suppress both "left" and "joined" messages silently
- **Background-tab recovery + presence polish**: `peer.ts` `wake()` (reconnect now, reset the throttled backoff; floor lowered to 1.5s) is called on `visibilitychange`/`focus`/`pageshow`/`online`, so peers return instantly after a tab switch instead of "eventually"; `app.ts` adds a peer to the roster on **`onChannelOpen`** too (not just signaling-join), so a remote-initiated peer (e.g. an agent that dialed us) shows up; agents are flagged **🤖** in the roster via `peerAgents` (from the `name` envelope's `agent:<role>`); the status line shows a live `connected · N peers` / `reconnecting…`; the "joined" line waits for the peer's **name** (`pendingJoins`, 5s id fallback) so it reads "Jim joined", not a raw id. **Sticky identity caches (survive flaps):** both the display name (`lastKnownNames`) and the agent role (`peerAgents`) are per-`RoomContext` caches that are **never cleared on leave** — only reset when a peer re-announces itself as a non-agent — so a flapping AI daemon keeps its name **and** its 🤖 badge across reconnect churn instead of decaying to a raw hex id (a departed peer's stale entry never renders — the roster only badges ids still in `peers`). Do not re-add a `peerAgents.delete` to the leave-grace timer

## posix-net — POSIX-style sockets over the mesh

**Scope, stated up front: this is not a VPN.** A browser tab cannot create a
TUN/TAP interface or a raw socket — no amount of code here reroutes the
OS's or another app's traffic. What this is: `socket()`/`connect()`/
`send()`/`recv()`/`close()`/`listen()`/`accept()` macros (`posix-net.ts`),
addressed by `(peerId, port)`, that reach **other quantum-os mesh peers
only**. A future native runtime (see `scripts/qos-cli`) could someday back
the same API with real OS sockets and extend `connect()` to arbitrary
external hosts — that bridge does not exist here and the browser
implementation must never imply it does.

**Two dedicated data channels per peer connection, not one.** `peer.ts`
opens `"qos-stream"` (ordered, reliable — TCP-like) and `"qos-dgram"`
(`ordered: false, maxRetransmits: 0` — UDP-like) alongside the existing
chat `"qos"` channel, in the same offer/answer as everything else
(`initiateConnection`'s three `createDataChannel` calls; `handleOffer`'s
`ondatachannel` dispatches by `event.channel.label`). `QOSPeer.
hasSocketChannel(peerId, kind)`/`sendSocketFrame(peerId, kind, data)` are
the only way to reach them — **there is no flood-relay fallback**, unlike
`send()`/`broadcast()` on the chat channel. A socket is point-to-point by
definition, so `posix-net.ts`'s `connect()` calls `pinNeighbor()` first
(the existing "always keep a direct link to this peer" primitive already
used for calls and `/conn`) rather than relying on ring/skip-overlay luck,
and a send with no open channel simply fails rather than flooding
someone else's bytes through peers who have no reason to carry them.

**`posix-net.ts` itself never touches WebRTC.** It talks only to a small
injected `SocketTransport` interface (`pinNeighbor`/`hasSocketChannel`/
`sendSocketFrame`), which is what makes its framing and multiplexing
(`PosixNet` class: a tiny `{port, connId, seq, flag, payload}` frame, a
SYN/SYN-ACK/DATA/FIN/RST handshake, one listener per `(type, port)`)
testable with two fake in-memory transports and no browser at all
(`test/posix-net.test.mjs`).

**`app.ts` wires one `PosixNet` per room, alongside its `QOSPeer`.**
`connect()` builds `net = new PosixNet({selfId, pinNeighbor,
hasSocketChannel, sendSocketFrame})` from the same `newPeer` it just
constructed (a forward-declared `let net` lets the `QOSPeer` config's
`onSocketChannelOpen`/`onSocketMessage` callbacks close over it, since
those only fire later, well after both exist) and stores it on
`RoomContext.posixNet` — same per-room lifetime and `setActiveRoom`
aliasing as `qpeer`, torn down alongside it on disconnect/tab-close.
**`/socket`** is the manual command surface: `listen <port> [stream|dgram]`,
`unlisten`, `connect <peer> <port> [stream|dgram]`, `send <connId> <text>`,
`close <connId>`, `list`. Like `/ice`/`/conn`, it's excluded from the
generic `qlf` rebroadcast (`send()`'s exclusion list) — its output is local
diagnostic/data, not room chat. **No capability gating yet** — anyone can
`/socket listen` or `connect`; gating `bind`/`connect` behind a
`cap:socket:<port>`-style token (consistent with everything else in the
ZFA model — see `note-declare`/`gov-*`'s dyncap-signed-envelope pattern) is
the next step, tracked but not built.

**Same TURN dependency as calls, for the same reason.** A socket has no
flood-relay fallback to mask a failed direct pair, so two peers behind
symmetric NAT/CGNAT need `fetchAutoTurn`/`/ice`'s existing relay exactly as
a call does — nothing new to configure, since `iceServers` is supplied
once per `RTCPeerConnection` regardless of which channels ride it.

**NAT/firewall traversal is not censorship resistance.** STUN/TURN gets
two ordinary networks (corporate NAT, mobile CGNAT) connected; it does
nothing against an adversary actively fingerprinting and blocking
WebRTC/TURN traffic itself. That's a materially different, harder problem
(traffic obfuscation, pluggable-transport-style techniques) and is
explicitly out of scope for this layer — track it separately if it
becomes a real requirement, rather than assuming "mesh + TURN" already
covers it.
