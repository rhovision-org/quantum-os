// faucet-http.mjs — the test-REV faucet as an HTTP endpoint, for a wallet.
//
// The room's `/<role> faucet <address>` is a chat command over the mesh —
// fine for a person in the room, useless to a wallet that only speaks HTTP.
// This is the same faucet with an HTTP face: `POST /faucet {"address"}` (or
// `GET /faucet?address=`) → the agent's `send(address)`, which deploys the
// same `$transfer` from the same throwaway key.
//
// WIRE-COMPATIBLE WITH RNODE'S OWN FAUCET. rholo's dev-mode node has a
// native `POST /api/faucet {"address"}` → `{deployId, amount, to}` (amount in
// dust), and r-wallet already calls exactly that. This endpoint answers in
// that shape (plus its own fields) and is served at `/api/faucet` as well as
// `/faucet`, so a reverse proxy can route `/api/faucet` here and a wallet
// needs no change — it just sees a faucet that also rate-limits. What the room command
// deliberately lacks — a rate limit — this one must have: the room command is
// reachable only by whoever holds the room cap, an HTTP port by anyone on the
// internet, and an unlimited faucet on a public port is a drained faucet.
//
//   per address  one grant per `addrCooldownMs` (default 24 h)
//   per client   `ipPerHour` grants per hour (default 5), keyed on the first
//                X-Forwarded-For hop when present (the port is meant to sit
//                behind a TLS proxy), else the socket address
//
// Limits are in memory — a restart forgets them, which on a test system is
// the right failure. No key, no chain knowledge here: `send` is injected, so
// faucet-http.selftest.mjs exercises every path with a stub.
//
//   node faucet-http.selftest.mjs

import http from "node:http";

const REV_ADDR_RE = /^[1-9A-HJ-NP-Za-km-z]{20,60}$/;   // base58 shape sanity check only
const HOUR_MS = 3_600_000;

export function createFaucetServer({
  send,                           // async (address) => { ok, message?, deployId? }
  amount,                         // in dust (what moves), for the reply and /health
  amountRev = null,               // the same in REV, for people
  fundingAddress = "",            // the faucet's own address, for /health
  rnode = "",                     // which chain the REV is on, for /health
  addrCooldownMs = 24 * HOUR_MS,
  ipPerHour = 5,
  now = Date.now,
  log = () => {},
}) {
  const lastByAddr = new Map();   // address -> when it was last granted
  const ipHits = new Map();       // ip -> timestamps of grants in the last hour

  const clientOf = (req) => {
    const fwd = req.headers["x-forwarded-for"];
    if (typeof fwd === "string" && fwd.trim()) return fwd.split(",")[0].trim();
    return req.socket?.remoteAddress ?? "unknown";
  };

  const json = (res, status, body) => {
    res.writeHead(status, {
      "content-type": "application/json",
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "content-type",
    });
    res.end(JSON.stringify(body));
  };

  const readBody = (req) => new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => { data += c; if (data.length > 4096) { req.destroy(); resolve(""); } });
    req.on("end", () => resolve(data));
    req.on("error", () => resolve(""));
  });

  /** The decision, separated from the transport so it is testable: null to
   *  grant, or the error reply to send. Records the grant as a side effect. */
  function admit(address, client) {
    const t = now();
    const last = lastByAddr.get(address);
    if (last !== undefined && t - last < addrCooldownMs) {
      return { status: 429, body: { ok: false, error: "address already funded recently", retryAfterMs: addrCooldownMs - (t - last) } };
    }
    const hits = (ipHits.get(client) ?? []).filter((h) => t - h < HOUR_MS);
    if (hits.length >= ipPerHour) {
      return { status: 429, body: { ok: false, error: "too many requests from this client", retryAfterMs: HOUR_MS - (t - hits[0]) } };
    }
    hits.push(t);
    ipHits.set(client, hits);
    lastByAddr.set(address, t);
    return null;
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://faucet");
    if (req.method === "OPTIONS") { json(res, 204, {}); return; }
    if (url.pathname === "/" || url.pathname === "/health") {
      json(res, 200, { ok: true, faucet: true, amount: Number(amount), amountRev: amountRev === null ? undefined : String(amountRev), fundingAddress, rnode, addrCooldownMs, ipPerHour });
      return;
    }
    if (url.pathname !== "/faucet" && url.pathname !== "/api/faucet") { json(res, 404, { ok: false, error: "not found" }); return; }
    if (req.method !== "POST" && req.method !== "GET") { json(res, 405, { ok: false, error: "method not allowed" }); return; }

    let address = url.searchParams.get("address") ?? "";
    if (req.method === "POST") {
      const raw = await readBody(req);
      try { address = String(JSON.parse(raw || "{}").address ?? address); } catch { /* not json — fall through to the query */ }
    }
    address = address.trim();
    if (!REV_ADDR_RE.test(address)) { json(res, 400, { ok: false, error: "not a REV address" }); return; }

    const client = clientOf(req);
    const refused = admit(address, client);
    if (refused) { log(`faucet-http: refused ${address} from ${client} — ${refused.body.error}`); json(res, refused.status, refused.body); return; }

    log(`faucet-http: sending ${amount} to ${address} for ${client}`);
    let out;
    try { out = await send(address); }
    catch (e) { out = { ok: false, message: e?.message ?? String(e) }; }
    if (!out?.ok) {
      // The grant is spent even on failure — a failing chain must not turn
      // into a retry loop that hammers it; the address cooldown is the pause.
      json(res, 502, { ok: false, error: "deploy failed", detail: String(out?.message ?? "").slice(0, 300) });
      return;
    }
    // rnode's shape first (deployId, amount in dust, to), then ours.
    // `confirmed` says the recipient's balance was SEEN to rise, not merely
    // that the deploy was accepted — a wallet polling this should be able to
    // tell "it arrived" from "it is on its way" without guessing.
    json(res, 200, {
      deployId: out.deployId ?? "", amount: Number(amount), to: address, ok: true, address,
      confirmed: out.confirmed === true,
      ...(typeof out.balance === "number" ? { balance: out.balance } : {}),
      detail: out.message ?? (out.confirmed ? "balance confirmed" : "accepted; settling"),
    });
  });

  return { server, admit };
}
