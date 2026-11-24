// calls.test.mjs — what a screen share actually sends.
//
// Written after a report from a room with nobody else in it: the camera was
// running, the preview showed it, and sharing refused with "no video is being
// sent". The check had asked the peer connections what they carried, and alone
// there are none — so it confused "nobody is receiving" with "nothing to send".
//
// What matters is not that the code runs but WHAT ENDS UP IN THE STREAM, since
// that stream is what a peer connecting later is given. So the media is stubbed
// and the assertions are about tracks: which one is in the stream we would send,
// and which one each sender carries.
//
//   node packages/browser/test/calls.test.mjs
//
// calls.ts is TypeScript, so it is bundled in-process rather than imported.

import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const bundle = await build({
  absWorkingDir: here,
  entryPoints: [join(here, "..", "src", "calls.ts")],
  bundle: true, format: "esm", platform: "node", write: false,
});
const mod = await import(
  "data:text/javascript;base64," + Buffer.from(bundle.outputFiles[0].text).toString("base64")
);

// --- stub media -------------------------------------------------------------

class Track {
  constructor(kind, label) { this.kind = kind; this.label = label; this.enabled = true; this._h = {}; }
  stop() { this.stopped = true; }
  addEventListener(n, f) { this._h[n] = f; }
  fire(n) { this._h[n]?.(); }
}
class Stream {
  constructor(tracks = []) { this.tracks = tracks; }
  getTracks() { return this.tracks; }
  getVideoTracks() { return this.tracks.filter((t) => t.kind === "video"); }
  getAudioTracks() { return this.tracks.filter((t) => t.kind === "audio"); }
  addTrack(t) { this.tracks.push(t); }
  removeTrack(t) { this.tracks = this.tracks.filter((x) => x !== t); }
}
// Enough of an element to hold a tree: the tiles are looked up through it
// (`video.closest(".call-tile")`, `wrap.querySelector(".call-name")`), so a
// stub that answers those with throwaways would assert nothing.
const docHandlers = {};
const el = () => {
  const classes = new Set();
  const node = {
    hidden: true, dataset: {}, style: {}, textContent: "", title: "",
    disabled: false, muted: false, srcObject: null, autoplay: false, playsInline: false,
    children: [], parent: null, handlers: {},
    get className() { return [...classes].join(" "); },
    set className(v) { classes.clear(); for (const c of String(v).split(/\s+/).filter(Boolean)) classes.add(c); },
    classList: {
      add: (...c) => c.forEach((x) => classes.add(x)),
      remove: (...c) => c.forEach((x) => classes.delete(x)),
      contains: (c) => classes.has(c),
    },
    appendChild(kid) { kid.parent = node; node.children.push(kid); return kid; },
    append(...kids) { kids.forEach((k) => node.appendChild(k)); },
    remove() { node.parent = null; },
    addEventListener(n, f) { node.handlers[n] = f; },
    fire(n, ev = {}) { node.handlers[n]?.({ stopPropagation() {}, preventDefault() {}, ...ev }); },
    querySelector(sel) {
      const want = sel.replace(".", "");
      const hit = node.children.find((k) => k.classList.contains(want));
      return hit ?? node.children.map((k) => k.querySelector(sel)).find(Boolean) ?? null;
    },
    closest(sel) {
      const want = sel.replace(".", "");
      for (let n = node; n; n = n.parent) if (n.classList.contains(want)) return n;
      return null;
    },
  };
  return node;
};

// defineProperty, not assignment: node 22 defines `navigator` itself as a
// getter-only property, so `globalThis.navigator = …` throws there while
// working fine on node 20. CI runs 22.
const provide = (name, value) =>
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });

provide("document", { createElement: () => el(), addEventListener(n, f) { docHandlers[n] = f; } });
provide("window", { isSecureContext: true });
// The browser's stored answer about camera/mic. "denied" is why a prompt never
// appears, which is the thing people report as "it doesn't ask".
let permission = "prompt";
const store = new Map();
provide("localStorage", {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
});

const camera = new Track("video", "camera");
const mic    = new Track("audio", "mic");
const screen = new Track("video", "screen");
screen.getSettings = () => ({ displaySurface: "monitor" });
provide("navigator", {
  permissions: { query: async () => ({ state: permission }) },
  mediaDevices: {
  getUserMedia:    async () => new Stream([mic, camera]),
  getDisplayMedia: async () => new Stream([screen]),
} });

// Long-delay timers (the post-start media-reach check) are captured so the test
// can fire them without waiting; short ones (settle) stay real.
const realSetTimeout = globalThis.setTimeout;
const longTimers = [];
provide("setTimeout", (fn, ms) => {
  if (ms <= 1000) return realSetTimeout(fn, ms);
  longTimers.push(fn);
  return -longTimers.length;
});
provide("clearTimeout", (id) => {
  if (typeof id === "number" && id < 0) longTimers[-id - 1] = null;
});
const fireLong = () => {
  while (longTimers.length) { const f = longTimers.shift(); if (f) { f(); return; } }
};

// --- the room: one person, nobody connected ---------------------------------

const sentToJoiners = [];      // what addLocalMedia was handed, by track label
let senders = [];              // what the connections carry, when there are any
const pinned = [];   // who start() asked for a guaranteed direct connection to
const peer = {
  peerId: "abc123",
  addLocalMedia(s) { sentToJoiners.push(s.getVideoTracks().map((t) => t.label)); },
  removeLocalMedia() {}, broadcast() {},
  videoSenders() { return senders; },
  pinNeighbor(id) { pinned.push(id); },
};
const said = [];
const tilesEl = el();
// This file's "room" never models a real roster (senders/remoteStream stand
// in for other peers directly), so roomPeers stays empty here — the pin
// loop it drives is exercised at the unit level in peer.test.mjs instead.
const calls = mod.createCalls(
  { peer: () => peer, say: (t) => said.push(t), label: () => "peer", isAgent: () => false, roomPeers: () => [], mediaBlocked: () => [] },
  { bar: el(), tiles: tilesEl, mute: el(), cam: el(), share: el() },
);
const tileFor = (key) => tilesEl.children.find((c) => c.dataset.key === key);

let failed = 0;
const settle = () => new Promise((r) => setTimeout(r, 20));
const check = (label, cond, detail) => {
  if (cond) console.log(`  ok   ${label}`);
  else { failed++; console.log(`  FAIL ${label}  (${detail})`); }
};
const lastSent = () => sentToJoiners[sentToJoiners.length - 1] ?? [];

calls.toggle();
await settle();
check("a call starts", calls.inCall(), "not in a call");

// --- alone in the room ------------------------------------------------------
calls.toggleScreen();
await settle();
check("sharing alone is not refused",
      !said.some((s) => s.includes("nothing to share in its place")), said.join(" | "));
check("it says it is sharing", said.some((s) => s.includes("you are sharing")), said.join(" | "));
check("a joiner would be given the screen", lastSent().includes("screen"), JSON.stringify(sentToJoiners));
check("a joiner would not be given the camera", !lastSent().includes("camera"), JSON.stringify(sentToJoiners));

// --- with somebody connected ------------------------------------------------
let replaced = [];
senders = [{ track: camera, replaceTrack: async (t) => { replaced.push(t?.label ?? null); } }];

calls.toggleScreen();          // stop
await settle();
check("stopping puts the camera back", replaced.includes("camera"), JSON.stringify(replaced));

calls.toggleScreen();          // share again, now with a sender to swap
await settle();
check("with a peer, the sender is swapped rather than renegotiated",
      replaced.includes("screen"), JSON.stringify(replaced));

replaced = [];
screen.fire("ended");          // the browser's own "stop sharing" control
await settle();
check("the browser's stop-sharing restores the camera",
      replaced.includes("camera"), JSON.stringify(replaced));

// --- what a recording can reach ---------------------------------------------
// A recording needs the room's voices from the call itself: capturing a window
// offers no audio, so the picker cannot supply them.
calls.remoteStream("ann", new Stream([new Track("audio", "ann-voice"), new Track("video", "ann-cam")]));
check("a peer's voice is reachable for recording",
      calls.audioTracks().map((t) => t.label).includes("ann-voice"),
      JSON.stringify(calls.audioTracks().map((t) => t.label)));
calls.peerGone("ann");
check("and is gone when they leave", calls.audioTracks().length === 0,
      JSON.stringify(calls.audioTracks().map((t) => t.label)));

// --- a screen is not a thumbnail --------------------------------------------
// 160×120 is unreadable for a shared screen, so any tile can be clicked to
// fill the window, and our own tile says which one it is (the caption, and
// `contain` instead of `cover` via the data attribute).
const localTile = () => tileFor("__local__");

calls.toggleScreen();          // share once more
await settle();
check("the local tile knows it is a screen", localTile()?.dataset.screen === "1",
      JSON.stringify(localTile()?.dataset));
check("and says so", localTile()?.querySelector(".call-name")?.textContent === "you — screen",
      localTile()?.querySelector(".call-name")?.textContent);

calls.toggleScreen();          // stop
await settle();
check("and is a face again when sharing stops", localTile()?.dataset.screen === undefined,
      JSON.stringify(localTile()?.dataset));

// --- clicking a tile is what makes it big ------------------------------------
// Nothing comes up big on its own: a tile is big because somebody clicked it.
calls.remoteStream("bob", new Stream([new Track("video", "bob-video")]));
check("a tile arrives small", !tileFor("bob")?.classList.contains("expanded"),
      tileFor("bob")?.className);

tileFor("bob")?.fire("click");
check("clicking it makes it big", tileFor("bob")?.classList.contains("expanded"),
      tileFor("bob")?.className);

docHandlers.keydown?.({ key: "Escape" });
check("Esc shrinks it", !tileFor("bob")?.classList.contains("expanded"), tileFor("bob")?.className);

tileFor("bob")?.fire("click");
calls.remoteStream("dot", new Stream([new Track("video", "dot-video")]));
tileFor("dot")?.fire("click");
check("only one tile is ever big",
      tilesEl.children.filter((c) => c.classList.contains("expanded")).length === 1,
      tilesEl.children.map((c) => c.className).join(" | "));


check("it says which surface was actually shared",
      said.some((s) => s.includes("sharing your entire screen")), said.join(" | "));

// --- "I allowed it to ask, but it never asks" --------------------------------
// A prompt appears only when the answer is unknown. A stored block means
// silence, which is reported as the app being broken — so the app reads the
// stored answer and says it.
said.length = 0;
permission = "denied";
calls.end();
calls.toggle();
await settle();
check("a stored block is explained rather than waited on",
      said.some((t) => t.includes("will not ask again")), said.join(" | "));
check("and it says where to change it",
      said.some((t) => t.includes("Site settings")), said.join(" | "));
check("including when the browser itself lacks the permission",
      said.some((t) => t.includes("operating system")), said.join(" | "));
permission = "prompt";

// --- a call reaches everyone in the room, not just direct neighbors ---------
// Under the bounded-degree overlay (peer.ts) most room peers past a handful
// aren't a direct connection by default, and a MediaStreamTrack can't be
// relayed the way a data-channel message can. Starting a call without
// pinning every room peer first would silently reach only whoever happened
// to already be a ring/skip neighbor. See issue #111 / CLAUDE.md.
{
  const pinnedFresh = [];
  const addOrder = [];
  const freshPeer = {
    peerId: "fresh1",
    addLocalMedia() { addOrder.push("addLocalMedia"); },
    removeLocalMedia() {}, broadcast() {}, videoSenders() { return []; },
    pinNeighbor(id) { addOrder.push("pin"); pinnedFresh.push(id); },
  };
  const freshCalls = mod.createCalls(
    {
      peer: () => freshPeer, say: () => {}, label: () => "peer", isAgent: () => false,
      roomPeers: () => ["r1", "r2", "r3"], mediaBlocked: () => [],
    },
    { bar: el(), tiles: el(), mute: el(), cam: el(), share: el() },
  );
  freshCalls.toggle();
  await settle();
  check("starting a call pins every room peer",
        pinnedFresh.length === 3 && ["r1", "r2", "r3"].every((id) => pinnedFresh.includes(id)),
        JSON.stringify(pinnedFresh));
  check("addLocalMedia runs before any pin — it must only ever touch connections "
        + "that already existed, never one a pin just started negotiating",
        addOrder[0] === "addLocalMedia", JSON.stringify(addOrder));
}

// --- ending a call releases the pins it made — except agents ----------------
// With active pruning off, a pin is otherwise permanent: a call that never
// unpinned anyone would silently push the room toward full mesh for the rest
// of the session the first time anyone made a call. But an agent is pinned
// for a separate, permanent reason (see app.ts's name handler) — end() must
// not clear that just because a call it was never really "for" wraps up.
{
  const unpinnedAtEnd = [];
  const endPeer = {
    peerId: "end1",
    addLocalMedia() {}, removeLocalMedia() {}, broadcast() {}, videoSenders() { return []; },
    pinNeighbor() {},
    unpinNeighbor(id) { unpinnedAtEnd.push(id); },
  };
  const endCalls = mod.createCalls(
    {
      peer: () => endPeer, say: () => {}, label: () => "peer",
      isAgent: (id) => id === "the-agent",
      roomPeers: () => ["r1", "r2", "the-agent"], mediaBlocked: () => [],
    },
    { bar: el(), tiles: el(), mute: el(), cam: el(), share: el() },
  );
  endCalls.toggle();   // start
  await settle();
  endCalls.toggle();   // end
  check("ending a call unpins the ordinary room peers it pinned to start",
        unpinnedAtEnd.includes("r1") && unpinnedAtEnd.includes("r2"), JSON.stringify(unpinnedAtEnd));
  check("...but never unpins an agent — that pin is permanent, not call-scoped",
        !unpinnedAtEnd.includes("the-agent"), JSON.stringify(unpinnedAtEnd));
}

// --- a call the media can't cross to a peer says so, once ------------------
// Chat floods through the overlay so it keeps working; a MediaStreamTrack
// can't, so a call between two networks with no relay that crosses is silently
// one-way. Checked a short time after start, because that is when it is wrong
// with nothing on screen to say so (quantum-os#126).
{
  const saidR = [];
  let blocked = ["r1"];
  const rPeer = {
    peerId: "r0", addLocalMedia() {}, removeLocalMedia() {}, broadcast() {},
    videoSenders() { return []; }, pinNeighbor() {}, unpinNeighbor() {},
  };
  const rCalls = mod.createCalls(
    {
      peer: () => rPeer, say: (t) => saidR.push(t), label: (id) => id,
      isAgent: () => false, roomPeers: () => ["r1"], mediaBlocked: () => blocked,
    },
    { bar: el(), tiles: el(), mute: el(), cam: el(), share: el() },
  );
  const crossings = () => saidR.filter((t) => t.includes("can't get the call")).length;

  longTimers.length = 0;        // drop any stale timers from earlier instances
  rCalls.toggle();              // start
  await settle();
  fireLong();                   // the early check
  check("a call participant the media can't reach is named, with a fix to try",
        saidR.some((t) => t.includes("r1") && t.includes("/ice turn")), saidR.join(" | "));
  const once = crossings();
  fireLong();                   // the later check — still blocked, already warned
  check("and is named only once per call", crossings() === once, saidR.join(" | "));

  rCalls.toggle();              // end
  blocked = [];                 // everyone connects this time
  rCalls.toggle();              // start again
  await settle();
  fireLong(); fireLong();
  check("a call where everyone connects says nothing",
        crossings() === once, saidR.join(" | "));

  rCalls.toggle();              // end
  blocked = ["r1"];
  rCalls.toggle();              // a third call — the once-per-call set cleared on end
  await settle();
  fireLong();
  check("a fresh call re-checks", crossings() === once + 1, saidR.join(" | "));
}

// --- speaker view -----------------------------------------------------------
// Who is shown large, who sits beside them, and who drops underneath. The
// arrangement is a pure function so it is asserted directly; then once through
// the tiles, since a right answer that never reaches a class is no answer.
{
  const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const st = (keys, opts) => mod.arrangeStage(keys, { local: "me", ...opts });

  check("alone, you are your own main video",
        eq(st(["me"]), { main: "me", side: [], below: [] }), JSON.stringify(st(["me"])));
  check("with one other person, they are large and you are beside them",
        eq(st(["me", "a"]), { main: "a", side: ["me"], below: [] }), JSON.stringify(st(["me", "a"])));
  check("whoever is talking is the main video",
        st(["me", "a", "b"], { speaker: "b" }).main === "b", JSON.stringify(st(["me", "a", "b"], { speaker: "b" })));
  check("a pin beats the speaker",
        st(["me", "a", "b"], { speaker: "b", pinned: "a" }).main === "a", "");
  check("you can pin yourself", st(["me", "a"], { pinned: "me" }).main === "me", "");
  check("a pin or speaker who has left is ignored",
        st(["me", "a"], { speaker: "gone", pinned: "gone" }).main === "a", "");
  const five = st(["me", "a", "b", "c", "d"], { speaker: "a" });
  check("at most three sit beside the main video", eq(five.side, ["me", "b", "c"]), JSON.stringify(five));
  check("anyone past three goes below it", eq(five.below, ["d"]), JSON.stringify(five));
  check("nobody is shown twice or dropped",
        eq([five.main, ...five.side, ...five.below].sort(), ["a", "b", "c", "d", "me"]), JSON.stringify(five));

  // The speaker: sticky through silence, and not stolen by one loud moment.
  const t = mod.speakerTracker(0.03, 2);
  const lv = (o) => new Map(Object.entries(o));
  check("silence names nobody", t.update(lv({ a: 0.001, b: 0 })) === null, "");
  t.update(lv({ a: 0.2, b: 0 }));
  check("a voice has to hold before it takes over", t.update(lv({ a: 0.2, b: 0 })) === "a", String(t.current()));
  check("the last speaker stays up through silence", t.update(lv({ a: 0, b: 0 })) === "a", String(t.current()));
  check("one loud moment from someone else changes nothing", t.update(lv({ a: 0, b: 0.3 })) === "a", String(t.current()));
  t.update(lv({ a: 0, b: 0 }));
  t.update(lv({ a: 0, b: 0.3 }));
  check("a sustained voice does", t.update(lv({ a: 0, b: 0.3 })) === "b", String(t.current()));
  t.drop("b");
  check("a speaker who leaves is forgotten", t.current() === null, String(t.current()));

  // Through the tiles.
  const bar = el(), tilesS = el(), viewBtn = el(), fullBtn = el();
  const sPeer = {
    peerId: "s0", addLocalMedia() {}, removeLocalMedia() {}, broadcast() {},
    videoSenders() { return []; }, pinNeighbor() {}, unpinNeighbor() {},
  };
  const sCalls = mod.createCalls(
    { peer: () => sPeer, say() {}, label: (id) => id, isAgent: () => false, roomPeers: () => [], mediaBlocked: () => [] },
    { bar, tiles: tilesS, mute: el(), cam: el(), share: el(), view: viewBtn, full: fullBtn },
  );
  const tile = (key) => tilesS.children.find((c) => c.dataset.key === key && c.parent);
  const has = (key, cls) => tile(key)?.classList.contains(cls) ?? false;
  const cam = (n) => new Stream([new Track("audio", n + "-voice"), new Track("video", n + "-cam")]);

  check("the grid is the default view", sCalls.view() === "grid", sCalls.view());
  sCalls.toggle();
  await settle();
  for (const n of ["a", "b", "c", "d"]) sCalls.remoteStream(n, cam(n));
  check("in the grid, no tile is staged", !has("a", "stage-main") && !tilesS.classList.contains("speaker"), "");

  sCalls.setView("speaker");
  check("speaker view marks the tile container", tilesS.classList.contains("speaker"), tilesS.className);
  check("the first other person is the main video", has("a", "stage-main"), tile("a")?.className);
  check("you are a thumbnail beside it", has("__local__", "stage-side"), tile("__local__")?.className);
  check("three beside, in rows 1–3",
        ["__local__", "b", "c"].map((k) => tile(k).style.gridRow).join() === "1,2,3",
        ["__local__", "b", "c"].map((k) => tile(k).style.gridRow).join());
  check("the fifth goes below", has("d", "stage-below") && tile("d").style.gridRow === "", tile("d")?.className);

  tile("d").fire("click");
  check("clicking a thumbnail makes it the main video", has("d", "stage-main") && has("d", "pinned"), tile("d")?.className);
  check("and the old main becomes a thumbnail", has("a", "stage-side"), tile("a")?.className);
  tile("d").fire("click");
  check("clicking it again lets go of the pin", has("a", "stage-main") && !has("d", "pinned"), tile("a")?.className);

  tile("b").fire("click");
  sCalls.peerGone("b");
  check("a pinned person leaving hands the main video on", has("a", "stage-main"), tile("a")?.className);
  check("and the row below closes up", has("d", "stage-side"), tile("d")?.className);

  sCalls.toggleView();
  check("back in the grid, nothing is left staged",
        !tilesS.classList.contains("speaker") && !has("a", "stage-main") && tile("c").style.gridRow === "", tile("a")?.className);
  check("the view button says what it will switch to", viewBtn.dataset.label === "Speaker view", viewBtn.dataset.label);

  // Full screen is the bar, so the controls come with it.
  sCalls.toggleFull();
  check("full screen fills the window with the call bar, controls included",
        bar.classList.contains("call-full"), bar.className);
  check("the button offers the way back", fullBtn.dataset.label === "Exit full screen", fullBtn.dataset.label);
  docHandlers.keydown?.({ key: "Escape" });
  check("Esc leaves it", !bar.classList.contains("call-full"), bar.className);
  sCalls.toggleFull();
  for (const n of ["a", "c", "d"]) sCalls.peerGone(n);
  sCalls.toggle();              // hang up: nobody left, the bar hides
  check("a call that ends does not leave the window covered",
        bar.hidden && !bar.classList.contains("call-full"), `hidden=${bar.hidden} ${bar.className}`);
}

// --- leaving the call --------------------------------------------------------
// Leave used to stop only your own camera and mic: everyone else stayed on
// screen and in your ears. Now it leaves them too, and a box stays where the
// call was with a way back in, for as long as anyone is still in it.
{
  const bar = el(), tilesL = el();
  const said = [];
  const lPeer = {
    peerId: "l0", addLocalMedia() {}, removeLocalMedia() {}, broadcast() {},
    videoSenders() { return []; }, pinNeighbor() {}, unpinNeighbor() {},
  };
  const lCalls = mod.createCalls(
    { peer: () => lPeer, say: (m) => said.push(m), label: (id) => id.toUpperCase(),
      isAgent: (id) => id === "bot", roomPeers: () => [], mediaBlocked: () => [] },
    { bar, tiles: tilesL, mute: el(), cam: el(), share: el() },
  );
  const live = () => tilesL.children.filter((c) => c.parent);
  const keys = () => live().map((c) => c.dataset.key ?? c.className).join();
  const rejoin = () => live().find((c) => c.className === "call-rejoin");
  const cam = (n) => new Stream([new Track("audio", n + "-voice"), new Track("video", n + "-cam")]);
  const aStream = cam("a"), bStream = cam("b");

  lCalls.toggle();
  await settle();
  lCalls.remoteStream("a", aStream);
  lCalls.remoteStream("b", bStream);
  lCalls.remoteStream("bot", cam("bot"));
  check("in the call: you and the two others", keys() === "__local__,a,b", keys());

  lCalls.toggle();          // Leave
  check("Leave leaves everyone, not just your own camera",
        !live().some((c) => c.dataset.key), keys());
  check("nothing is left playing", tilesL.children.every((c) => !c.dataset.key || c.parent === null), "");
  check("a box with a way back in takes the call's place", !!rejoin() && !bar.hidden, keys());
  check("it says who is still there (people, not agents)",
        rejoin()?.children[0]?.textContent === "You left the call. Still in it: A, B.", rejoin()?.children[0]?.textContent);
  check("the button says Rejoin", rejoin()?.children[1]?.textContent.includes("Rejoin the call"), rejoin()?.children[1]?.textContent);
  check("the call controls are put away", bar.classList.contains("call-left"), bar.className);
  check("hasLeft() reports it", lCalls.hasLeft() === true, String(lCalls.hasLeft()));

  lCalls.remoteStream("c", cam("c"));
  check("someone arriving while you are out is not shown", !live().some((c) => c.dataset.key === "c"), keys());
  check("but is listed", rejoin()?.children[0]?.textContent.includes("C"), rejoin()?.children[0]?.textContent);

  rejoin().children[1].fire("click");
  await settle();
  check("Rejoin puts you back in the call", lCalls.inCall() && !lCalls.hasLeft(), `inCall=${lCalls.inCall()}`);
  check("and shows everyone at once", ["__local__", "a", "b", "c"].every((k) => live().some((c) => c.dataset.key === k)), keys());
  check("the box goes", !rejoin() && !bar.classList.contains("call-left"), keys());
  check("each tile plays the stream it had", live().find((c) => c.dataset.key === "a").children[0].srcObject === aStream, "");
  check("and it says so", said.at(-1) === "📞 you rejoined the call", said.at(-1));

  lCalls.toggle();          // Leave again
  for (const id of ["a", "b", "c"]) lCalls.peerGone(id);
  check("when the last person goes, so does the box", !rejoin() && bar.hidden && !lCalls.hasLeft(), `${keys()} hidden=${bar.hidden}`);

  // Leaving when you were the only one there: no box, as before.
  lCalls.toggle();
  await settle();
  lCalls.toggle();
  check("leaving an empty call just closes it", !rejoin() && bar.hidden, keys());
}

console.log(failed === 0 ? "\ncalls: all passed" : `\ncalls: ${failed} FAILED`);
process.exit(failed ? 1 : 0);
