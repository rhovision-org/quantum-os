// calls.ts — live calls over the room's WebRTC connections.
//
// The transport is QOSPeer's: `addLocalMedia` adds tracks to every connection
// and renegotiates, `onRemoteStream` brings the other side back. What lives here
// is everything above that — acquiring media, the tiles, the toolbar state, and
// deciding what to do when acquiring fails, which is most of the code because
// it is most of what actually happens to people.
//
// It reaches app.ts through `CallHost` rather than importing it: which peer is
// current changes as the user switches room tabs, so the peer is asked for
// rather than held.

import type { QOSPeer } from "./peer.js";
import { noScreenCapture } from "./record.js";

/** What calls need from the app, asked for rather than held. */
export interface CallHost {
  /** The active room's peer, or null when not connected. */
  peer(): QOSPeer | null;
  /** Put a line in the transcript. */
  say(text: string): void;
  /** Display name for a peer id. */
  label(peerId: string): string;
  /** Agents are data-only: their media is never rendered. */
  isAgent(peerId: string): boolean;
  /**
   * Everyone currently in the room. A call has no invite list — it broadcasts
   * to whoever's here — so this is who needs a guaranteed direct connection
   * before media goes out (see start()): under the bounded-degree overlay
   * (peer.ts), most peers past a handful aren't a direct ring/skip neighbor,
   * and a MediaStreamTrack can't be relayed the way a data-channel message
   * can. Without pinning, a call in a big room would silently reach only the
   * caller's ring neighbors.
   */
  roomPeers(): string[];
  /**
   * Room peers (non-agent) whose *direct* peer connection has failed or is
   * still stuck — `failed`/`disconnected` always, and `checking`/`connecting`
   * only once `strict` is set (a slow mobile handshake needs the grace).
   *
   * A call needs a direct ICE pair or a working TURN relay; when neither forms,
   * chat still reaches the peer (it floods through the overlay) but a
   * `MediaStreamTrack` cannot, so the call is silently one-way. This is checked
   * a short time after a call starts because that is exactly when it is wrong
   * with nothing on screen to say so (quantum-os#126).
   */
  mediaBlocked(strict: boolean): string[];
}

export interface CallElements {
  bar: HTMLElement | null;
  tiles: HTMLElement | null;
  mute: HTMLButtonElement | null;
  cam: HTMLButtonElement | null;
  share: HTMLButtonElement | null;
  /** Switches between the thumbnail grid and speaker view. Optional. */
  view?: HTMLButtonElement | null;
  /** Puts the whole call — tiles and controls — full screen. Optional. */
  full?: HTMLButtonElement | null;
}

/** `grid`: every tile the same size. `speaker`: whoever is talking, large. */
export type CallView = "grid" | "speaker";

/** How many thumbnails sit beside the main video before they go below it. */
export const SIDE_MAX = 3;

export interface Stage {
  /** The tile shown large. */
  main: string | null;
  /** Beside the main video, at most `SIDE_MAX`. */
  side: string[];
  /** Everyone else, in a row under it. */
  below: string[];
}

/**
 * Who goes where in speaker view. Pure, so it can be tested without a DOM.
 *
 * The main tile is the one you pinned, else whoever is (or last was) talking,
 * else the first other person, else yourself — you are only ever your own main
 * video when you chose it or are alone. Everyone else keeps the order they
 * arrived in, so thumbnails do not shuffle beyond the one swap a change of
 * speaker needs.
 */
export function arrangeStage(
  keys: string[],
  opts: { pinned?: string | null; speaker?: string | null; local?: string } = {},
): Stage {
  const has = (k: string | null | undefined): k is string => !!k && keys.includes(k);
  const main = has(opts.pinned) ? opts.pinned
    : has(opts.speaker) ? opts.speaker
    : keys.find((k) => k !== opts.local) ?? keys[0] ?? null;
  const rest = keys.filter((k) => k !== main);
  return { main, side: rest.slice(0, SIDE_MAX), below: rest.slice(SIDE_MAX) };
}

/**
 * Decides who "the speaker" is from a stream of audio levels.
 *
 * Two things keep the main video from flickering: a newcomer has to be the
 * loudest for `hold` consecutive readings before taking over (a cough is not a
 * turn), and silence changes nothing — the last person to speak stays up, as
 * in any call app.
 */
export function speakerTracker(threshold = 0.03, hold = 2) {
  let current: string | null = null;
  let cand: string | null = null;
  let n = 0;
  return {
    /** Feed one reading per peer (0..1 RMS). Returns the current speaker. */
    update(levels: Map<string, number>): string | null {
      let loudest: string | null = null;
      let top = threshold;
      for (const [id, v] of levels) if (v >= top) { top = v; loudest = id; }
      if (!loudest || loudest === current) { cand = null; n = 0; return current; }
      if (loudest === cand) n++; else { cand = loudest; n = 1; }
      if (n >= hold) { current = cand; cand = null; n = 0; }
      return current;
    },
    drop(id: string): void {
      if (current === id) current = null;
      if (cand === id) { cand = null; n = 0; }
    },
    current: () => current,
  };
}

/** How long a tile stays marked `speaking` after its voice was last heard. */
export const SPEAKING_HOLD_MS = 3000;

/**
 * Who should carry the `speaking` highlight. The raw "loudest right now" drops
 * out at every breath and pause, so the highlight blinked on and off mid-
 * sentence; instead each peer stays marked until `holdMs` after they were last
 * the loudest voice. Pure — the clock is passed in — so it can be tested.
 */
export function speakingHold(holdMs = SPEAKING_HOLD_MS) {
  const lastHeard = new Map<string, number>();
  return {
    /** Feed the loudest peer now (or null) and the time; returns who is speaking. */
    update(loud: string | null, now: number): Set<string> {
      if (loud) lastHeard.set(loud, now);
      const speaking = new Set<string>();
      for (const [id, t] of lastHeard) {
        if (now - t < holdMs) speaking.add(id); else lastHeard.delete(id);
      }
      return speaking;
    },
    drop(id: string): void { lastHeard.delete(id); },
  };
}

export interface Calls {
  /** Start if idle, hang up if in a call. */
  toggle(): void;
  end(): void;
  toggleMute(): void;
  toggleCam(): void;
  /** Share the screen, or stop sharing and go back to the camera. */
  toggleScreen(): void;
  /** A peer's media arrived. */
  remoteStream(peerId: string, stream: MediaStream): void;
  /** Every peer's live audio — what a recording needs to have the room on it. */
  audioTracks(): MediaStreamTrack[];
  /** A peer left, or ended their call: drop their tile. */
  peerGone(peerId: string): void;
  inCall(): boolean;
  /** You pressed Leave while others are still in the call (the rejoin box is up). */
  hasLeft(): boolean;
  /** Choose the layout: the thumbnail grid, or speaker view. */
  setView(view: CallView): void;
  view(): CallView;
  toggleView(): void;
  /** The whole call, controls included, full screen — or back. */
  toggleFull(): void;
}

// Always request the browser's acoustic echo canceller (+ noise suppression /
// auto gain). `audio: true` *usually* enables AEC, but being explicit guards
// against a driver or profile that left it off — one cause of hearing yourself.
const AUDIO: MediaTrackConstraints = {
  echoCancellation: true, noiseSuppression: true, autoGainControl: true,
};

export function createCalls(host: CallHost, els: CallElements): Calls {
  let localStream: MediaStream | null = null;
  /** The camera track, held while the screen is being shared in its place. */
  let cameraTrack: MediaStreamTrack | null = null;
  let screenStream: MediaStream | null = null;
  let inCall = false;
  const tiles = new Map<string, HTMLVideoElement>();   // "__local__" | peerId → video
  /** What each peer is sending, kept so a recording can mix their voice in. */
  const remote = new Map<string, MediaStream>();
  /** Whether our own tile is carrying the screen rather than the camera. */
  const screens = new Set<string>();
  /** The one tile currently shown big, if any. */
  let expanded: string | null = null;
  /** Timers for the post-start media-reach check; cleared on end(). */
  const reachTimers: ReturnType<typeof setTimeout>[] = [];
  /** Peers already named as unreachable for this call — each is said once. */
  const reachWarned = new Set<string>();
  let view: CallView = "grid";
  /** Speaker view: the tile the user chose to keep large, if any. */
  let pinned: string | null = null;
  const speaker = speakerTracker();
  /** Whether the call bar is filling the screen. */
  let full = false;

  // --- who is talking -------------------------------------------------------
  // An analyser per remote stream, read a few times a second. Only remote
  // voices are metered: you are never promoted to your own main video.
  const newMeter = (stream: MediaStream, src: AudioNode, an: AnalyserNode) =>
    ({ stream, src, an, buf: new Uint8Array(an.fftSize) });
  type Meter = ReturnType<typeof newMeter>;
  let actx: AudioContext | null = null;
  const meters = new Map<string, Meter>();
  let meterTimer: ReturnType<typeof setInterval> | null = null;
  /** Peers heard within the last SPEAKING_HOLD_MS — the `speaking` highlight.
   *  Held through pauses, but not sticky like the speaker. */
  const speakingTracker = speakingHold();
  let speakingNow = new Set<string>();

  function audioContext(): AudioContext | null {
    const g = globalThis as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext };
    const AC = g.AudioContext ?? g.webkitAudioContext;
    if (!AC) return null;
    try {
      actx ??= new AC();
      // Created outside a click it starts suspended; resuming is harmless.
      if (actx.state === "suspended") void actx.resume().catch(() => {});
      return actx;
    } catch { return null; }
  }

  function watchLevel(peerId: string, stream: MediaStream): void {
    if (meters.get(peerId)?.stream === stream) return;
    if (stream.getAudioTracks().length === 0) return;
    const ctx = audioContext();
    if (!ctx) return;
    unwatchLevel(peerId);
    try {
      const src = ctx.createMediaStreamSource(stream);
      const an = ctx.createAnalyser();
      an.fftSize = 512;
      src.connect(an);      // never to the destination: the <video> plays it
      meters.set(peerId, newMeter(stream, src, an));
      meterTimer ??= setInterval(readLevels, 200);
    } catch { /* no metering: speaker view falls back to the first peer */ }
  }

  function unwatchLevel(peerId: string): void {
    const m = meters.get(peerId);
    if (!m) return;
    try { m.src.disconnect(); } catch { /* already gone */ }
    meters.delete(peerId);
    speaker.drop(peerId);
    speakingTracker.drop(peerId);
    speakingNow.delete(peerId);
    if (meters.size === 0 && meterTimer !== null) { clearInterval(meterTimer); meterTimer = null; }
  }

  function readLevels(): void {
    const levels = new Map<string, number>();
    let loud: string | null = null;
    let top = 0.03;
    for (const [id, m] of meters) {
      m.an.getByteTimeDomainData(m.buf);
      let sum = 0;
      for (const b of m.buf) { const x = (b - 128) / 128; sum += x * x; }
      const rms = Math.sqrt(sum / m.buf.length);
      levels.set(id, rms);
      if (rms >= top) { top = rms; loud = id; }
    }
    const before = speaker.current();
    const now = speaker.update(levels);
    const speaking = speakingTracker.update(loud, Date.now());
    const changed = speaking.size !== speakingNow.size || [...speaking].some((id) => !speakingNow.has(id));
    speakingNow = speaking;
    if (now !== before || changed) layout();
  }

  // --- layout ---------------------------------------------------------------
  const STAGE = ["stage-main", "stage-side", "stage-below", "pinned"];

  /** Paint the current view onto the tiles. Nothing is reparented — a moved
   *  <video> re-attaches and restarts — so placement is classes and grid rows. */
  function layout(): void {
    const speakerView = view === "speaker";
    if (speakerView) els.tiles?.classList.add("speaker"); else els.tiles?.classList.remove("speaker");
    const stage = speakerView
      ? arrangeStage([...tiles.keys()], { pinned, speaker: speaker.current(), local: "__local__" })
      : null;
    if (stage && stage.side.length === 0) els.tiles?.classList.add("solo"); else els.tiles?.classList.remove("solo");
    for (const key of tiles.keys()) {
      const wrap = tileOf(key);
      if (!wrap) continue;
      wrap.classList.remove(...STAGE);
      wrap.style.gridRow = "";
      if (speakingNow.has(key)) wrap.classList.add("speaking"); else wrap.classList.remove("speaking");
      const btn = wrap.querySelector(".call-zoom") as HTMLElement | null;
      if (!stage) {
        if (btn && expanded !== key) { btn.textContent = "⛶"; btn.title = "Show this big"; }
        continue;
      }
      const side = stage.side.indexOf(key);
      if (key === stage.main) {
        wrap.classList.add("stage-main");
        if (pinned === key) wrap.classList.add("pinned");
        if (btn) {
          btn.textContent = pinned === key ? "📌" : "⛶";
          btn.title = pinned === key ? "Pinned — click to go back to whoever is talking" : "Keep this one large";
        }
      } else {
        wrap.classList.add(side >= 0 ? "stage-side" : "stage-below");
        if (side >= 0) wrap.style.gridRow = String(side + 1);
        if (btn) { btn.textContent = "⛶"; btn.title = "Show this one large"; }
      }
    }
    if (els.view) {
      els.view.textContent = speakerView ? "▦" : "👤";
      els.view.dataset.label = speakerView ? "Grid view" : "Speaker view";
      els.view.title = speakerView ? "Show everyone the same size" : "Show whoever is talking large";
    }
    if (els.full) {
      els.full.textContent = full ? "🗗" : "⛶";
      els.full.dataset.label = full ? "Exit full screen" : "Full screen";
      els.full.title = full ? "Leave full screen (Esc)" : "Full screen, with the call controls";
    }
  }

  function setView(next: CallView): void {
    if (next === "speaker" && expanded) setExpanded(null);
    view = next;
    layout();
  }

  /** A click on a tile: in speaker view it pins (or unpins) that person. */
  function pick(key: string): void {
    if (view === "speaker") { pinned = pinned === key ? null : key; layout(); }
    else toggleExpand(key);
  }

  /**
   * Full screen is the call bar itself — tiles and controls together — so
   * mute, camera, share and leave stay within reach. The class does the work
   * (fixed, filling the window); the Fullscreen API is asked for on top of it
   * and is allowed to refuse, as it does on an iPhone, where the class alone
   * still fills the page.
   */
  function setFull(on: boolean): void {
    const bar = els.bar;
    if (!bar || full === on) return;
    full = on;
    if (on) {
      if (expanded) setExpanded(null);
      bar.classList.add("call-full");
      try { void bar.requestFullscreen?.()?.catch(() => {}); } catch { /* the class is enough */ }
    } else {
      bar.classList.remove("call-full");
      if (document.fullscreenElement === bar) void document.exitFullscreen?.().catch(() => {});
    }
    layout();
  }
  // Esc inside the browser's own full screen never reaches keydown; it shows
  // up here instead, as full screen having ended.
  document.addEventListener("fullscreenchange", () => {
    if (full && !document.fullscreenElement) setFull(false);
  });
  const showBar = () => { if (els.bar) els.bar.hidden = false; };
  const hideBarIfIdle = () => {
    if (els.bar && !inCall && !left && tiles.size === 0) els.bar.hidden = true;
  };

  // --- having left ----------------------------------------------------------
  // Leave means leaving the call, not only switching your own camera and mic
  // off: everyone else's video and voice stop too. While anyone is still in
  // the call, a video-shaped box stays where the call was, with a button back
  // in. Their streams are kept (not shown, not played), so rejoining shows
  // them at once rather than waiting for a renegotiation.
  //
  // The connections still carry what they send: a peer's tracks go to every
  // connection, and taking ourselves off their list would need each of them to
  // renegotiate. What leaving changes is what this browser shows and plays.
  let left = false;
  let rejoinBox: HTMLElement | null = null;
  let rejoinMsg: HTMLElement | null = null;

  /** Humans still sending into the call (agents never count). */
  const othersInCall = (): string[] => [...remote.keys()].filter((id) => !host.isAgent(id));

  function paintRejoin(): void {
    const others = othersInCall();
    if (!left || others.length === 0) {
      rejoinBox?.remove(); rejoinBox = null; rejoinMsg = null;
      els.bar?.classList.remove("call-left");
      left = false;
      hideBarIfIdle();
      return;
    }
    els.bar?.classList.add("call-left");
    if (!rejoinBox) {
      rejoinBox = document.createElement("div");
      rejoinBox.className = "call-rejoin";
      const msg = rejoinMsg = document.createElement("div");
      msg.className = "call-rejoin-msg";
      const btn = document.createElement("button");
      btn.className = "call-rejoin-btn";
      btn.textContent = "📞 Rejoin the call";
      btn.addEventListener("click", () => void start());
      rejoinBox.append(msg, btn);
      els.tiles?.appendChild(rejoinBox);
    }
    const names = others.map((id) => host.label(id));
    const who = names.length <= 3 ? names.join(", ") : `${names.slice(0, 3).join(", ")} and ${names.length - 3} more`;
    if (rejoinMsg) rejoinMsg.textContent = `You left the call. Still in it: ${who}.`;
    showBar();
  }

  /** Show a peer's tile and play their stream. */
  function attachRemote(peerId: string, stream: MediaStream): void {
    let v = tiles.get(peerId);
    if (!v) v = makeTile(peerId, host.label(peerId));
    if (v.srcObject !== stream) v.srcObject = stream;
    watchLevel(peerId, stream);
  }

  const tileOf = (key: string): HTMLElement | null =>
    tiles.get(key)?.closest(".call-tile") as HTMLElement | null;

  function makeTile(key: string, label: string): HTMLVideoElement {
    const wrap = document.createElement("div");
    wrap.className = "call-tile";
    wrap.dataset.key = key;
    wrap.dataset.label = label;
    const v = document.createElement("video");
    v.autoplay = true; v.playsInline = true;
    const cap = document.createElement("span");
    cap.className = "call-name"; cap.textContent = label;
    // The thumbnail row is the right default — it shows everyone at once and
    // stays out of the way. What it needed was a way out of: any tile can be
    // clicked to fill the window. The button is for discovery; the whole tile
    // is the target.
    const zoom = document.createElement("button");
    zoom.className = "call-zoom"; zoom.textContent = "⛶";
    zoom.title = "Show this big";
    zoom.addEventListener("click", (e) => { e.stopPropagation(); pick(key); });
    wrap.addEventListener("click", () => pick(key));
    // Double-click goes to the browser's own full screen, where a shared screen
    // is finally shown at something like its real size.
    wrap.addEventListener("dblclick", (e) => {
      e.preventDefault();
      // In speaker view, and whenever the call is already full screen, the
      // thing to make full screen is the call — not one tile without controls.
      if (view === "speaker" || full) { setFull(!full); return; }
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
      else void wrap.requestFullscreen?.().catch(() => {});
    });
    wrap.append(v, cap, zoom);
    els.tiles?.appendChild(wrap);
    tiles.set(key, v);
    if (screens.has(key)) markScreen(key, true);
    layout();
    return v;
  }

  function removeTile(key: string): void {
    const v = tiles.get(key);
    if (!v) return;
    if (expanded === key) setExpanded(null);
    v.srcObject = null;
    v.closest(".call-tile")?.remove();
    tiles.delete(key);
    screens.delete(key);
    if (pinned === key) pinned = null;
    layout();
  }

  /** Label a tile as a screen, and stop cropping it. */
  function markScreen(key: string, on: boolean): void {
    if (on) screens.add(key); else screens.delete(key);
    const wrap = tileOf(key);
    if (!wrap) return;
    if (on) wrap.dataset.screen = "1"; else delete wrap.dataset.screen;
    const base = wrap.dataset.label ?? "";
    const cap = wrap.querySelector(".call-name");
    if (cap) cap.textContent = on ? `${base} — screen` : base;
  }

  function setExpanded(key: string | null): void {
    if (expanded) {
      const was = tileOf(expanded);
      was?.classList.remove("expanded");
      const btn = was?.querySelector(".call-zoom");
      if (btn) btn.textContent = "⛶";
    }
    expanded = key && tiles.has(key) ? key : null;
    const wrap = expanded ? tileOf(expanded) : null;
    if (wrap) {
      wrap.classList.add("expanded");
      const btn = wrap.querySelector(".call-zoom");
      if (btn) { btn.textContent = "✕"; (btn as HTMLElement).title = "Shrink (Esc)"; }
    }
  }

  const toggleExpand = (key: string) => setExpanded(expanded === key ? null : key);

  // Esc shrinks whatever is big. Full screen swallows its own Esc, so this only
  // ever fires for the in-page version.
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || document.fullscreenElement) return;
    if (expanded) setExpanded(null);
    else if (full) setFull(false);
  });

  /** The senders carrying our video — one per peer, all of which a share replaces. */
  function videoSenders(): RTCRtpSender[] {
    return host.peer()?.videoSenders() ?? [];
  }

  function updateControls(): void {
    const audioOn = localStream?.getAudioTracks()[0]?.enabled ?? false;
    const videoOn = localStream?.getVideoTracks()[0]?.enabled ?? false;
    if (els.mute) {
      els.mute.textContent = audioOn ? "🎤" : "🔇";
      els.mute.title = audioOn ? "Mute mic" : "Unmute mic";
      els.mute.dataset.label = audioOn ? "Mute" : "Unmute";
    }
    if (els.cam) {
      const hasVideo = (localStream?.getVideoTracks().length ?? 0) > 0;
      els.cam.disabled = !hasVideo || !!screenStream;
      els.cam.textContent = !hasVideo ? "🚫" : videoOn ? "🎥" : "🚫";
      els.cam.title = !hasVideo ? "No camera — audio-only call"
        : screenStream ? "Sharing your screen — stop sharing to use the camera"
        : videoOn ? "Turn camera off" : "Turn camera on";
      els.cam.dataset.label = hasVideo && videoOn ? "Stop video" : "Start video";
    }
    if (els.share) {
      els.share.disabled = !inCall;
      els.share.textContent = screenStream ? "🛑" : "🖥";
      els.share.title = !inCall ? "Start a call first"
        : screenStream ? "Stop sharing your screen" : "Share your screen";
      els.share.dataset.label = screenStream ? "Stop sharing" : "Share screen";
    }
  }

  /**
   * A call is up locally but a participant's connection may never carry media —
   * a direct pair that can't form (symmetric NAT, mobile CGNAT) and no relay
   * that crosses. Chat keeps working over the flood overlay, so nothing else
   * says it. Checked twice: once early for an outright `failed`, once later
   * (`strict`) to also catch a handshake still stuck — long enough that a slow
   * but fine mobile path isn't accused.
   */
  function checkMediaReach(strict: boolean): void {
    if (!inCall) return;
    for (const id of host.mediaBlocked(strict)) {
      if (reachWarned.has(id)) continue;
      reachWarned.add(id);
      host.say(`⚠ ${host.label(id)} can't get the call — your networks need a relay to cross and `
        + `none did. Chat still reaches them. Try \`/ice turn …\` (your own relay) or \`/ice test\`.`);
    }
  }

  async function start(): Promise<void> {
    const peer = host.peer();
    if (!peer) { host.say("connect to a room before starting a call"); return; }
    if (inCall) return;
    if (!navigator.mediaDevices?.getUserMedia) {
      host.say(`⚠ calls need a secure context — open the site over https:// or localhost${window.isSecureContext ? "" : " (this page is not a secure context)"}`);
      return;
    }
    // Read the stored answer first: if the camera is already blocked, no prompt
    // will appear however long anyone waits, and saying so beats waiting.
    const stored = await permissionState();
    if (stored) host.say(`⚠ ${stored}`);
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ audio: AUDIO, video: true });
    } catch {
      // Many devices have no camera (desktops), or video is blocked while audio
      // is allowed — retry audio-only before giving up.
      try {
        localStream = await navigator.mediaDevices.getUserMedia({ audio: AUDIO, video: false });
        host.say("🎙 camera unavailable — starting an audio-only call");
      } catch (audioErr) {
        host.say(`⚠ could not start call: ${whyMediaFailed(audioErr)}`);
        const stored = await permissionState();
        if (stored) host.say(`   ${stored}`);
        return;
      }
    }
    inCall = true;
    const rejoining = left;
    left = false;
    paintRejoin();
    audioContext();   // inside the click that started the call, so it may run
    const local = makeTile("__local__", "you");
    local.muted = true;
    local.srcObject = localStream;
    // Back in: everyone still in the call reappears straight away.
    for (const [id, stream] of remote) if (!host.isAgent(id)) attachRemote(id, stream);
    showBar();
    // addLocalMedia adds tracks to whatever's in `peer`'s connection map RIGHT
    // NOW, so it must run BEFORE pinning, not after: pinning a peer with no
    // existing connection creates a brand-new RTCPeerConnection synchronously
    // and starts its initial offer/answer asynchronously, and if addLocalMedia
    // then also renegotiated that same still-negotiating connection, the two
    // offers would race. Called first, addLocalMedia only ever touches
    // connections that are already stable. The peers a fresh pin dials in are
    // still covered — peer.ts's data-channel onopen already pushes media to a
    // newcomer whenever a call is in progress (checking `localStream`, which
    // addLocalMedia just set) — so once each pinned connection's handshake
    // completes, its media follows automatically, with no race.
    peer.addLocalMedia(localStream);
    // Under the bounded-degree overlay most room peers aren't a direct
    // neighbor by default, and a MediaStreamTrack can't be relayed the way a
    // data-channel message can — pin everyone so a connection actually gets
    // made to each of them (harmless no-ops for anyone already connected).
    for (const id of host.roomPeers()) peer.pinNeighbor(id);
    peer.broadcast({ kind: "call-start" });
    host.say(rejoining ? "📞 you rejoined the call" : "📞 you started a call");
    updateControls();
    reachTimers.push(
      setTimeout(() => checkMediaReach(false), 12_000),
      setTimeout(() => checkMediaReach(true), 35_000),
    );
  }

  function end(): void {
    const peer = host.peer();
    if (peer) {
      peer.removeLocalMedia();
      peer.broadcast({ kind: "call-end" });
      // Undo the pins start()/onPeerJoined made for this call — otherwise,
      // with active pruning off (see peer.ts's reconcilePrune), a call's
      // connections would stay pinned open for the rest of the session even
      // after it ends, silently pushing the room toward full mesh forever
      // the first time anyone makes a call. Unpinning doesn't itself close
      // anything right now (pruning is inert), but keeps pin state honest
      // for when pruning is eventually re-enabled, and for any other future
      // reader of `pins`. Skip agents — they're pinned independently, for
      // the life of the room, not for this call; unpinning one here would
      // silently break that separate, permanent guarantee.
      for (const id of host.roomPeers()) if (!host.isAgent(id)) peer.unpinNeighbor(id);
    }
    reachTimers.splice(0).forEach(clearTimeout);
    reachWarned.clear();
    stopScreenTracks();
    cameraTrack = null;
    localStream?.getTracks().forEach((t) => t.stop());
    localStream = null;
    inCall = false;
    removeTile("__local__");
    // Leaving the call leaves everyone in it: their tiles go, and with them
    // their voices (the <video> elements are what play them).
    for (const id of [...tiles.keys()]) { unwatchLevel(id); removeTile(id); }
    pinned = null;
    setFull(false);
    left = othersInCall().length > 0;
    if (left) host.say("📵 you left the call — Rejoin is where the call was");
    updateControls();
    paintRejoin();
  }

  function stopScreenTracks(): void {
    screenStream?.getTracks().forEach((t) => t.stop());
    screenStream = null;
  }

  /**
   * Share the screen in place of the camera.
   *
   * `localStream` is the truth of what we are sending: existing connections
   * carry its tracks, and a peer that connects later is given them
   * (`QOSPeer` re-adds from its own reference to the same object). So sharing
   * swaps the track *in that stream* and not only on the senders — otherwise
   * whoever joined next would get the camera while everyone already here saw
   * the screen.
   *
   * On senders that already carry video, `replaceTrack` does it with no
   * renegotiation and nothing torn down. Where there is no video sender — an
   * audio-only call, or nobody connected yet — the track is new to the
   * connection, so `addLocalMedia` negotiates it.
   *
   * Being alone is not a reason to refuse. The camera runs, the preview shows
   * it, and there is simply nobody receiving yet; sharing has to work then too,
   * or it fails exactly when someone sets up before a call.
   *
   * The cost of this shape is that it is a swap: you cannot send your face and
   * your screen at once. That wants a second track and per-track tile identity,
   * which is a bigger change than the button is worth today.
   */
  async function startScreen(): Promise<void> {
    if (!inCall) { host.say("start a call before sharing your screen"); return; }
    if (screenStream) return;
    if (!navigator.mediaDevices?.getDisplayMedia) {
      host.say(noScreenCapture("share"));
      return;
    }
    try {
      // No `displaySurface`: Chrome treats it as a filter on what the picker
      // returns rather than a hint about where it opens, so naming one takes
      // the choice away from the person making it.
      screenStream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        surfaceSwitching: "include",
        // Chrome hides the capturing page from its own picker by default
        // (`selfBrowserSurface` is "exclude"), which is why the room's own tab
        // was missing from the list — and it is the tab most worth capturing
        // here. Monitors are asked for explicitly for the same reason: what the
        // picker offers should be everything, and the choice should be the
        // person's.
        selfBrowserSurface: "include",
        monitorTypeSurfaces: "include",
      } as DisplayMediaStreamOptions);
    } catch (e) {
      // Cancelling the picker is an ordinary thing to do, not an error to report.
      if ((e as DOMException)?.name !== "NotAllowedError") {
        host.say(`⚠ could not share the screen: ${whyMediaFailed(e)}`);
      }
      return;
    }
    const track = screenStream.getVideoTracks()[0];
    if (!track) { stopScreenTracks(); return; }

    // Swap it into what we are sending, keeping the camera track to put back.
    cameraTrack = localStream?.getVideoTracks()[0] ?? null;
    if (localStream) {
      if (cameraTrack) localStream.removeTrack(cameraTrack);
      localStream.addTrack(track);
    }
    const senders = videoSenders();
    if (senders.length) {
      await Promise.all(senders.map((s) => s.replaceTrack(track).catch(() => {})));
    } else if (localStream) {
      // No video sender to swap — the track is new to every connection.
      host.peer()?.addLocalMedia(localStream);
    }

    // The browser's own "stop sharing" control ends the track without telling us.
    track.addEventListener("ended", () => { void stopScreen(); });
    const local = tiles.get("__local__");
    if (local && localStream) local.srcObject = localStream;
    markScreen("__local__", true);
    const kind = (track.getSettings?.() as { displaySurface?: string } | undefined)?.displaySurface;
    host.say(`🖥 you are sharing ${kind === "monitor" ? "your entire screen"
      : kind === "window" ? "one window" : kind === "browser" ? "one browser tab" : "your screen"}`);
    updateControls();
  }

  async function stopScreen(): Promise<void> {
    if (!screenStream) return;
    const shared = screenStream.getVideoTracks()[0] ?? null;
    stopScreenTracks();
    if (localStream) {
      if (shared) localStream.removeTrack(shared);
      if (cameraTrack) localStream.addTrack(cameraTrack);
    }
    // `replaceTrack(null)` where there is no camera: stop sending video rather
    // than leaving the far side on a frozen last frame of the screen.
    const cam = cameraTrack;
    await Promise.all(videoSenders().map((s) => s.replaceTrack(cam).catch(() => {})));
    cameraTrack = null;
    const local = tiles.get("__local__");
    if (local && localStream) local.srcObject = localStream;
    markScreen("__local__", false);
    if (expanded === "__local__") setExpanded(null);
    if (inCall) host.say("🖥 you stopped sharing your screen");
    updateControls();
  }

  layout();   // the view and full-screen buttons start out labelled

  return {
    toggle() { if (inCall) end(); else void start(); },
    end,
    toggleMute() {
      const t = localStream?.getAudioTracks()[0];
      if (t) t.enabled = !t.enabled;
      updateControls();
    },
    toggleCam() {
      const t = localStream?.getVideoTracks()[0];
      if (t) t.enabled = !t.enabled;
      updateControls();
    },
    toggleScreen() { if (screenStream) void stopScreen(); else void startScreen(); },
    remoteStream(peerId, stream) {
      // Ignore media from AI agents (data-only peers). They don't really stream —
      // werift loops our own audio back, which plays as a strong echo when you
      // are "alone" in a call and spuriously raises the call bar. Humans only.
      if (host.isAgent(peerId)) return;
      remote.set(peerId, stream);
      // Having left, keep the stream for a rejoin but neither show nor play it.
      if (left) { paintRejoin(); return; }
      attachRemote(peerId, stream);
      showBar();
    },
    audioTracks() {
      return [...remote.values()].flatMap((s) => s.getAudioTracks());
    },
    peerGone(peerId) {
      remote.delete(peerId); unwatchLevel(peerId); removeTile(peerId);
      if (left) paintRejoin(); else hideBarIfIdle();
      if (els.bar?.hidden) setFull(false);
    },
    inCall: () => inCall,
    hasLeft: () => left,
    setView,
    view: () => view,
    toggleView() { setView(view === "speaker" ? "grid" : "speaker"); },
    toggleFull() { setFull(!full); },
  };
}

/**
 * What the browser has already decided about the camera and mic.
 *
 * "I allowed Chrome to ask, but it never asks" is the commonest way this fails,
 * and it is not a bug: a prompt appears only when the answer is unknown. A
 * stored block, or an operating system that has not given the browser itself
 * camera access, both mean silence — so the stored answer is worth reading out
 * rather than leaving somebody waiting for a prompt that will not come.
 */
async function permissionState(): Promise<string> {
  const q = (navigator as unknown as {
    permissions?: { query(d: { name: string }): Promise<{ state: string }> };
  }).permissions;
  if (!q?.query) return "";
  const read = async (name: string): Promise<string> => {
    try { return (await q.query({ name })).state; } catch { return "unknown"; }
  };
  const [cam, mic] = await Promise.all([read("camera"), read("microphone")]);
  if (cam === "denied" || mic === "denied") {
    return `this site is blocked from the ${cam === "denied" ? "camera" : "microphone"}`
      + " — the browser will not ask again until you change it: click the 🔒 (or ⓘ) at the left of the"
      + " address bar → Site settings → Allow. If it already says Allow there, the operating system is"
      + " withholding it from the browser itself (System settings → Privacy → Camera / Microphone).";
  }
  if (cam === "granted" || mic === "granted") return "";
  return "";
}

/** Say why getUserMedia/getDisplayMedia refused, in terms of what to do next. */
function whyMediaFailed(err: unknown): string {
  const e = err as DOMException;
  switch (e?.name) {
    case "NotAllowedError":  return "permission denied — click the camera/🔒 icon in the address bar and Allow mic & camera for this site, then retry";
    case "NotFoundError":    return "no microphone or camera was found on this device";
    case "NotReadableError": return "your mic/camera is already in use by another app or tab";
    case "SecurityError":    return "blocked by the browser's permissions policy (needs https:// or localhost)";
    default:                 return e?.message || String(err);
  }
}
