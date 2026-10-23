import { loadZfa, generateCapability, validateCapability,
         spectralGap, achievesZfa, isPauliClosed,
         classifyCoupling, isPairwiseBalanced, signedAction,
         foldsToScalar, COUPLED_BASELINE } from "./zfa.js";
import { QOSPeer, DEFAULT_ICE } from "./peer.js";
import { PosixNet, type QosSocket, type SocketType } from "./posix-net.js";
import { parseNoteLabel, denomination as noteDenomination,
         mintCurrencyToken, mintNote, mintNoteSeries, mintReceipt,
         termsHash8, seriesKey as makeSeriesKey,
         splitNote, mergeNotes } from "./notes.js";
import { newProposalId, conservationCheck,
         uniqueParticipants, shortRdvId, cyclicSwap,
         type Proposal, type Row, type CommitRow } from "./rendezvous.js";
import { newDynCapState, signEnvelope, verifyEnvelope,
         serializeState, deserializeState, serializeChain, deserializeChain,
         type DynCapState, type ChainEntry, type DyncapField, type VerifyResult } from "./dyncap.js";
import { encryptVault, decryptVault, looksLikeVault } from "./vault.js";
import { findDiscrepancies, losingPeersIn, normalizeValue,
         SAMPLE_SIZE, PROBE_WINDOW_MS,
         type Observation } from "./probe.js";
import { transpile as rhoquTranspile, RhoQuError, type RhoQuContext, type OnHandler as RhoQuOnHandler } from "./rhoqu.js";
import { tally, liveCounts, summarizeWinners, optionId, sortedOptions,
         type Poll, type PollMethod, type PollOption } from "./polls.js";
import { canonLemma, parseRefTokens, parseLemmaDecl, splitLemmaNameArg } from "./lemma-parse.js";
import { issueId, isMember, isAdmin, memberLabel, findIssue, resolveWeights, delegatorsOf,
         delegationMapFor, trustWeightsFor, trustLevels, discreditedMembers, TRUST_MAX, govCurrency,
         rekeyMember, memberKeyFor, type Group, type Issue, type Role, type VaultRecord,
         type ChainRefs } from "./gov.js";
import { installProgram, registerProgram, bindProgram, resolveProgram,
         readProgram, grantProgram } from "./locker.js";
// The three on-chain governance contracts. `readProgram` is already taken by
// the locker's, so rgov-core's call-site builders come in under a namespace.
import * as rgov from "./rgov-core.js";
import { parseDefinition, parseInvocation, expandCommand, expandCallSites,
         formatDefinition, findMacros, bodyKind, MacroError,
         MACRO_NAME_RE, MAX_BODY } from "./macro-lang.js";
import { createCalls, type Calls } from "./calls.js";
import { createRecorder, type Recorder } from "./record.js";
import { hashBlob, entryFromWire, sortEntries, findEntry, describeEntry, shortHash,
         putBytes, getBytes, dropBytes, heldHashes, availabilityOf, AVAILABILITY_MARK, atRisk,
         fmtSize as fmtFileSize,
         type LibraryEntry, type Availability } from "./library.js";
import { createLibraryFetch, FETCH_MAX, type LibraryFetch } from "./library-fetch.js";
import { createPalette, CMD_HELP, type Palette } from "./palette.js";
import { createAttachments, renderMedia, type Attachments,
         type MediaAttachment, type MediaKind } from "./attachments.js";
import { openRholangEditor } from "./rholang-editor.js";
import { expandBareMacro, expandMacroProgram, lintRholang, macroMode,
         listMacros as listRholangMacros } from "./rholang-pipeline.js";
import { loadConfig as loadNodeConfig, saveConfig as saveNodeConfig, describeConfig as describeNodeConfig,
         generateKey as generateDeployKey, revAddressOf, nodeStatus, evalTerm, deployTerm,
         readResultsFresh, readName, deployFate, wrapProgram, powerboxNames, powerboxSpec,
         registryUriOf, powerboxUsed, DEFAULT_CONFIG as DEFAULT_NODE_CONFIG,
         readResult, readResultRecord, syncResultNonce, deployAnswer,
         type NodeConfig } from "./rholang.js";
import { qucalcSearch, qucalcSolve,
         type SearchDone as QucalcSearchDone } from "./qucalc-search.js";

// ---------------------------------------------------------------------------
// Room ID from URL hash: #room=cap:..., or generate a new one and set hash.
//
// A room cap is a bearer capability: reading it IS joining. The address bar is
// therefore the leakiest surface in the app — it is in every screen share,
// every screenshot and every recording, and none of those look like handing the
// room away at the time. So the cap is taken back out of the address bar once
// the app has read it, and leaves this browser through the copy button instead.
//
// The room is not lost by hiding it: joined rooms are persisted under
// `qos-joined-rooms` and come back as tabs, and `/room ref` prints the URL.
// ---------------------------------------------------------------------------

const HIDE_ROOM_KEY = "qos-hide-room";
const ACTIVE_ROOM_KEY = "qos-active-room";
/** Keep the room cap out of the address bar. On unless explicitly turned off. */
let hideRoom = localStorage.getItem(HIDE_ROOM_KEY) !== "no";

function getRoomId(): string {
  const params = new URLSearchParams(window.location.hash.slice(1));
  const existing = params.get("room");
  if (existing) return existing;
  // No room in the URL is the ordinary case once the cap is hidden, so the
  // room you were last in has to be remembered somewhere else — otherwise a
  // reload would mint a fresh room and leave the real one as a stray tab.
  const last = localStorage.getItem(ACTIVE_ROOM_KEY);
  if (last && loadJoinedRooms().includes(last)) return last;
  const id = generateCapability("room");
  params.set("room", id);
  if (!hideRoom) window.location.hash = params.toString();
  return id;
}

/**
 * The address bar follows the active room — or carries nothing, in which case
 * this is also the only record of which room that was.
 */
function syncRoomHash(): void {
  localStorage.setItem(ACTIVE_ROOM_KEY, activeRoom.roomId);
  if (hideRoom) {
    if (window.location.hash) {
      history.replaceState(null, "", window.location.pathname + window.location.search);
    }
    return;
  }
  const params = new URLSearchParams(window.location.hash.slice(1));
  params.set("room", activeRoom.roomId);
  history.replaceState(null, "", `#${params.toString()}`);
}

function setHideRoom(on: boolean): void {
  hideRoom = on;
  localStorage.setItem(HIDE_ROOM_KEY, on ? "yes" : "no");
  syncRoomHash();
  updateShareLink();
}

// ---------------------------------------------------------------------------
// DOM refs
// ---------------------------------------------------------------------------

const sidebarEl       = document.getElementById("sidebar")!;
const overlayEl       = document.getElementById("sidebar-overlay")!;
const toggleBtn       = document.getElementById("sidebar-toggle") as HTMLButtonElement;
const myNameEl        = document.getElementById("my-name") as HTMLInputElement;
const myIdEl          = document.getElementById("my-id")!;
const roomIdEl        = document.getElementById("room-id")!;
const appVersionEl    = document.getElementById("app-version");
const DEFAULT_SIGNAL  = "wss://quantum-os-signaling.onrender.com";
const signalUrlEl     = document.getElementById("signal-url") as HTMLInputElement;
const stunUrlEl       = document.getElementById("stun-url") as HTMLInputElement;
const connectBtn      = document.getElementById("connect-btn") as HTMLButtonElement;
const statusDot       = document.getElementById("status-dot")!;
const statusText      = document.getElementById("status-text")!;
const peerList        = document.getElementById("peer-list")!;
const peerCount       = document.getElementById("peer-count")!;
const roomProcessEl   = document.getElementById("room-process")!;
const messagesEl      = document.getElementById("messages")!;
const msgInput        = document.getElementById("msg-input") as HTMLInputElement;
const sendBtn         = document.getElementById("send-btn") as HTMLButtonElement;
const shareLink       = document.getElementById("share-link") as HTMLAnchorElement;
const copyBtn         = document.getElementById("copy-btn") as HTMLButtonElement;
const hideBtn         = document.getElementById("hide-btn") as HTMLButtonElement;
const libraryListEl   = document.getElementById("library-list")!;
const libraryCountEl  = document.getElementById("library-count")!;
const libraryDropEl   = document.getElementById("library-drop");
const lemmaListEl     = document.getElementById("lemma-list")!;
const lemmaCountEl    = document.getElementById("lemma-count")!;
const currencyListEl  = document.getElementById("currency-list")!;
const currencyCountEl = document.getElementById("currency-count")!;
const noteListEl      = document.getElementById("note-list")!;
const noteCountEl     = document.getElementById("note-count")!;
const pollListEl      = document.getElementById("poll-list")!;
const pollCountEl     = document.getElementById("poll-count")!;
const tabListEl       = document.getElementById("tab-list")!;
const tabAddBtn       = document.getElementById("tab-add") as HTMLButtonElement;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

// Cross-room (per-device) state — same across every joined room.
let myName: string = localStorage.getItem("qos-name") ?? "";
type LogEntry = { who: string; cmd: string; arg: string; summary: string };
const sessionLog: LogEntry[] = [];
let dyncapState: DynCapState | null = null;            // seed + anchor + per-room seqs
let signQueue: Promise<void> = Promise.resolve();      // serializes outbound signing

// Per-room types.
interface LemmaEntry { twists: string; who: string; cap?: string; dyncap?: DyncapField;
  /** The claim as a sentence, when the name is only a handle within it
   *  (`/lemma All men are @mortal` → name "mortal", text "All men are mortal").
   *  Absent when the name is the whole claim. Cosmetic — first-write-wins like
   *  `who`, never part of the immutability check (only `twists` is). */
  text?: string;
  /** True when this lemma is a closure discovered by `/search`, not a named claim
   *  someone wrote. Integer-named, so a re-run of the same search finds it already
   *  known rather than anonymous. Cosmetic only — otherwise a lemma like any other. */
  event?: boolean }
interface NoteEntry { token: string; currency: string; denomination: number; receivedFrom?: string }
interface ReceiptEntry { token: string; currency: string; denomination: number; issuer: string }
interface RedemptionRecord { token: string; currency: string; denomination: number; redeemer: string; at: number }
interface KnownCurrency { currency: string; token: string; issuer: string; dyncap?: DyncapField }
interface LockedNote extends NoteEntry { proposalId: string; lockedAt: number }
// Issuer-declared terms for a note "series" (cap:note-<base>~<termsHash8>). Keyed
// by the full series id ("USD~a1b2") = a stamped note's `currency`. `dyncap`
// records the declaring issuer's anchor so a non-issuer can't rewrite the terms.
interface SeriesTerms { seriesKey: string; baseCurrency: string; termsHash: string; terms: string; issuer: string; dyncap?: DyncapField }
interface AcceptedTerms { termsHash: string; at: number }
type ProposalRole = "proposer" | "participant";
type ProposalStatus = "pending" | "accepted" | "rejected";
interface ProposalState {
  proposal: Proposal;
  role: ProposalRole;
  myStatus: ProposalStatus;
  acceptedBy: Map<string, string>;
}
interface ProbeWindow {
  open: boolean;
  observations: Observation[];
  contributors: Set<string>;
  timer: number | null;
}

// Per-room chat history so tab switching can replay the messages area.
type ChatKind = "peer" | "self" | "system";
interface ChatLine { from: string; text: string; kind: ChatKind; label?: string; media?: MediaAttachment; pollId?: string; groupId?: string; issueId?: string }

// A persist request is an offer from another peer asking us to also store
// their lemma / currency declaration so the room's public state has more
// than one copy and survives any one peer leaving. Acceptance is explicit.
type PersistKind = "lemma" | "currency";
interface PersistRequest {
  id: string;
  kind: PersistKind;
  fromPeer: string;          // peerId of the asker
  fromName: string;          // display label for chat
  // Inline payload for the kind:
  lemmaName?: string;
  lemmaEntry?: LemmaEntry;
  currencyToken?: string;
  currencyEntry?: KnownCurrency;
}

const RDV_TIMEOUT_MS = 60_000;

// Each room is its own Markov blanket — independent state, independent
// dyncap chain trajectory (seqs tracked in dyncapState.seqByRoom), independent
// signaling/data-channel connection. RoomContext holds everything per-room.
/** A history a peer put on the table with /qlf-action. */
interface ActionProposal { twists: Uint8Array; at: number; }

interface RoomContext {
  roomId: string;
  qpeer: QOSPeer | null;
  // posix-net (docs/connection.md "posix-net"): the socket macro layer for
  // this room's mesh. Live-session state only, like actionProposals/
  // rhoquHandlers below — sockets don't survive a reload, same as any other
  // open connection.
  posixNet: PosixNet | null;
  socketListeners: Map<string, { port: number; type: SocketType; unlisten: () => void }>;
  socketConns: Map<string, QosSocket>;
  // Peers + transport
  peers: Set<string>;
  peerNames: Map<string, string>;
  // Last-known display name per peer id — a sticky cache that, unlike peerNames,
  // is NEVER cleared on leave. So a flapping peer (e.g. an agent whose signaling
  // connection keeps dropping) keeps its label across reconnects even before its
  // re-sent `name` envelope arrives, instead of falling back to a raw hex id.
  lastKnownNames: Map<string, string>;
  // AI-agent role per peer id (e.g. "facilitator"), from the peer's `name`
  // envelope `agent` tag. Like lastKnownNames this is a STICKY cache — never
  // cleared on leave — so a flapping AI daemon keeps its 🤖 badge across
  // reconnect flaps, instead of decaying to an unlabelled peer while its
  // re-announced (and possibly briefly dyncap-refused) name envelope is in flight.
  peerAgents: Map<string, string>;
  pendingLeaves: Map<string, ReturnType<typeof setTimeout>>;
  pendingJoins: Map<string, ReturnType<typeof setTimeout>>;
  // Peers already reported as unreachable, so a full room says so once.
  unreachableWarned: Set<string>;
  /** peerId → when it first appeared, so "long enough to worry" is answerable. */
  peerSeenAt: Map<string, number>;
  // What the room has: the index (public, gossiped) and what this peer is
  // actually holding the bytes for (local — nobody else's business to be told
  // until they ask).
  libraryStore: Map<string, LibraryEntry>;
  heldFiles: Set<string>;
  /** hash → peers here who say they hold it. Live state: never persisted, and
   *  emptied of a peer the moment it leaves. */
  fileHolders: Map<string, Set<string>>;
  /** hash → when a holder was last seen, so "offline" and "gone" differ. */
  holderSeen: Map<string, number>;
  // Lemma + note stores (the public room knowledge)
  lemmaStore: Map<string, LemmaEntry>;
  currencyTokens: Map<string, string>;
  noteStore: Map<string, NoteEntry>;
  receiptStore: Map<string, ReceiptEntry>;
  redemptionsHonored: Map<string, RedemptionRecord>;
  knownCurrencies: Map<string, KnownCurrency>;
  // Note terms-series: issuer-declared terms (seriesKey -> SeriesTerms) and the
  // series this user has accepted (seriesKey -> AcceptedTerms).
  seriesTerms: Map<string, SeriesTerms>;
  acceptedTerms: Map<string, AcceptedTerms>;
  // Histories peers have proposed with /qlf-action, latest per peer. These are
  // what /coupling cuts: a peer's capability token is a random identity bearer
  // and says nothing about what that peer contributed, but a history someone
  // deliberately typed does. Live-session state, not persisted.
  actionProposals: Map<string, ActionProposal>;
  // Rendezvous
  lockedNotes: Map<string, LockedNote>;
  proposals: Map<string, ProposalState>;
  proposalTimers: Map<string, number>;
  // Dyncap chain state (receiver-side TOFU)
  dyncapChains: Map<string, ChainEntry>;
  // Discrepancy probe + losing-peers ignore set
  probe: ProbeWindow;
  ignoredForSync: Set<string>;
  // Channels this peer is subscribed to in this room — inbound channel-msg
  // envelopes on a subscribed name surface in chat; others are silently dropped.
  channelSubscriptions: Set<string>;
  // Inbound persist requests awaiting accept/reject. Each is a pending offer
  // from another peer asking us to also hold their state for cross-session
  // redundancy.
  pendingPersistRequests: Map<string, PersistRequest>;
  // RhoQu `on channel(x) { … }` handlers — fired when channel-msg envelopes
  // arrive on a matching channel name. Persisted in-memory only.
  rhoquHandlers: RhoQuOnHandler[];
  // Polls: pollId -> Poll (persisted); live card DOM nodes (in-memory only).
  pollStore: Map<string, Poll>;
  pollCards: Map<string, HTMLElement>;
  // Governance: groupId -> Group (liquid-democracy groups; persisted).
  groupStore: Map<string, Group>;
  // (Macros are NOT per-room — they are a per-browser store, `macroStore` below,
  //  contributed to every room the user joins. See `saveMacros`.)
  // Retraction tombstones: "<kind>:<id>" of removed gossiped items (poll/lemma)
  // so a peer's later sync-* can't heal them back. Persisted per room.
  retracted: Set<string>;
  // Chat history for this room (replayed on tab switch)
  chatLog: ChatLine[];
  // Persisted user-set name for this room's signaling connection (UI only)
  signalingUrl: string;
  // True if there's been activity since the user last viewed this tab.
  hasUnread: boolean;
  // True after the first successful signaling open for this room. Subsequent
  // reopens (reconnects) are silent so a flapping socket doesn't spam the log.
  hasJoinedOnce: boolean;
}

function createRoom(roomId: string): RoomContext {
  return {
    roomId,
    qpeer: null,
    posixNet: null,
    socketListeners: new Map(),
    socketConns: new Map(),
    peers: new Set(),
    peerNames: new Map(),
    lastKnownNames: new Map(),
    peerAgents: new Map(),
    pendingLeaves: new Map(),
    pendingJoins: new Map(),
    unreachableWarned: new Set(),
    peerSeenAt: new Map(),
    libraryStore: new Map(),
    heldFiles: new Set(),
    fileHolders: new Map(),
    holderSeen: new Map(),
    lemmaStore: new Map(),
    currencyTokens: new Map(),
    noteStore: new Map(),
    receiptStore: new Map(),
    redemptionsHonored: new Map(),
    knownCurrencies: new Map(),
    seriesTerms: new Map(),
    acceptedTerms: new Map(),
    actionProposals: new Map(),
    lockedNotes: new Map(),
    proposals: new Map(),
    proposalTimers: new Map(),
    dyncapChains: new Map(),
    probe: { open: false, observations: [], contributors: new Set(), timer: null },
    ignoredForSync: new Set(),
    channelSubscriptions: new Set(),
    pendingPersistRequests: new Map(),
    rhoquHandlers: [],
    pollStore: new Map(),
    pollCards: new Map(),
    groupStore: new Map(),
    retracted: new Set(),
    chatLog: loadChat(roomId),
    signalingUrl: DEFAULT_SIGNAL,
    hasUnread: false,
    hasJoinedOnce: false,
  };
}

const rooms = new Map<string, RoomContext>();   // roomId → context (all joined rooms)
// `activeRoom` is the room whose state is currently aliased into the module-
// level let bindings (lemmaStore, peers, …). It is set by setActiveRoom and
// temporarily swapped by inbound callbacks to point at the room that owns
// that callback's QOSPeer — so state mutations land in the right room even
// when the user is looking at a different tab.
let activeRoom!: RoomContext;
// `uiActiveRoom` is the tab the user is currently *looking at*. It only
// changes on switchToRoom. DOM-touching code checks `activeRoom ===
// uiActiveRoom` before painting; otherwise the active room is being mutated
// by a background callback and the user's screen should not flicker.
let uiActiveRoom!: RoomContext;

function isUiActive(): boolean { return activeRoom === uiActiveRoom; }

function markUnread(ctx: RoomContext): void {
  if (ctx === uiActiveRoom) return;
  if (ctx.hasUnread) return;
  ctx.hasUnread = true;
  renderTabs();
}

// Module-level aliases for the active room's state. Existing code paths read
// from these names; they are reassigned on `setActiveRoom` to point at the new
// active room. JavaScript looks up `let` bindings at call time, so all
// references see the active room's data automatically.
let qpeer: QOSPeer | null = null;
let posixNet: PosixNet | null = null;
let socketListeners: Map<string, { port: number; type: SocketType; unlisten: () => void }> = new Map();
let socketConns: Map<string, QosSocket> = new Map();
let peers: Set<string> = new Set();
let peerNames: Map<string, string> = new Map();
let lastKnownNames: Map<string, string> = new Map();
// peerId -> agent role (e.g. "facilitator", "scribe") for peers that announced
// themselves as AI agents in their `name` envelope; used to flag them in the
// roster. Aliased per-room via setActiveRoom (like peerNames), and STICKY across
// leaves (see the RoomState field) so the 🤖 badge survives reconnect flaps.
let peerAgents: Map<string, string> = new Map();
let pendingLeaves: Map<string, ReturnType<typeof setTimeout>> = new Map();
let pendingJoins: Map<string, ReturnType<typeof setTimeout>> = new Map();
let unreachableWarned: Set<string> = new Set();
let peerSeenAt: Map<string, number> = new Map();
let libraryStore: Map<string, LibraryEntry> = new Map();
let heldFiles: Set<string> = new Set();
let fileHolders: Map<string, Set<string>> = new Map();
let holderSeen: Map<string, number> = new Map();
let lemmaStore: Map<string, LemmaEntry> = new Map();
let currencyTokens: Map<string, string> = new Map();
let noteStore: Map<string, NoteEntry> = new Map();
let receiptStore: Map<string, ReceiptEntry> = new Map();
let redemptionsHonored: Map<string, RedemptionRecord> = new Map();
let knownCurrencies: Map<string, KnownCurrency> = new Map();
let seriesTerms: Map<string, SeriesTerms> = new Map();
let acceptedTerms: Map<string, AcceptedTerms> = new Map();
let lockedNotes: Map<string, LockedNote> = new Map();
let actionProposals: Map<string, ActionProposal> = new Map();
let proposals: Map<string, ProposalState> = new Map();
let proposalTimers: Map<string, number> = new Map();
let dyncapChains: Map<string, ChainEntry> = new Map();
let probe: ProbeWindow = { open: false, observations: [], contributors: new Set(), timer: null };
let ignoredForSync: Set<string> = new Set();
let channelSubscriptions: Set<string> = new Set();
let pendingPersistRequests: Map<string, PersistRequest> = new Map();
let rhoquHandlers: RhoQuOnHandler[] = [];
let pollStore: Map<string, Poll> = new Map();
let pollCards: Map<string, HTMLElement> = new Map();
let groupStore: Map<string, Group> = new Map();
// Macros are a per-BROWSER store, not per-room: a `+command` or `$name` you
// define (or pick up from a peer) follows you into every room. Loaded once at
// startup, contributed to each room via the join `sync-macros`.
const macroStore: Map<string, MacroDef> = new Map();
// Macro removal tombstones, also per-browser, so a `sync-macros` in another
// room can't heal back one you retracted.
const macroTombstones: Set<string> = new Set();
function isMacroTombstoned(name: string): boolean { return macroTombstones.has(String(name).toLowerCase()); }
function tombstoneMacro(name: string): void {
  macroTombstones.add(String(name).toLowerCase());
  try { localStorage.setItem("qos-macro-tombstones", JSON.stringify([...macroTombstones])); } catch { /* full/blocked */ }
}
function loadMacroTombstones(): void {
  try {
    const raw = localStorage.getItem("qos-macro-tombstones");
    if (raw) for (const n of JSON.parse(raw) as string[]) macroTombstones.add(String(n).toLowerCase());
  } catch { /* corrupt */ }
}
// groupId that /gov subcommands act on. Persisted per tab so it survives a
// reload (set via setFocusedGroup).
let focusedGroup: string | null = (() => { try { return sessionStorage.getItem("qos-focused-group"); } catch { return null; } })();
function setFocusedGroup(id: string): void {
  focusedGroup = id;
  try { sessionStorage.setItem("qos-focused-group", id); } catch { /* ignore */ }
}
let retracted: Set<string> = new Set();

function setActiveRoom(ctx: RoomContext): void {
  activeRoom = ctx;
  if (!rooms.has(ctx.roomId)) rooms.set(ctx.roomId, ctx);
  qpeer              = ctx.qpeer;
  posixNet           = ctx.posixNet;
  socketListeners    = ctx.socketListeners;
  socketConns        = ctx.socketConns;
  peers              = ctx.peers;
  peerNames          = ctx.peerNames;
  lastKnownNames     = ctx.lastKnownNames;
  peerAgents         = ctx.peerAgents;
  pendingLeaves      = ctx.pendingLeaves;
  pendingJoins       = ctx.pendingJoins;
  unreachableWarned  = ctx.unreachableWarned;
  peerSeenAt         = ctx.peerSeenAt;
  libraryStore       = ctx.libraryStore;
  heldFiles          = ctx.heldFiles;
  fileHolders        = ctx.fileHolders;
  holderSeen         = ctx.holderSeen;
  lemmaStore         = ctx.lemmaStore;
  currencyTokens     = ctx.currencyTokens;
  noteStore          = ctx.noteStore;
  receiptStore       = ctx.receiptStore;
  redemptionsHonored = ctx.redemptionsHonored;
  knownCurrencies    = ctx.knownCurrencies;
  seriesTerms        = ctx.seriesTerms;
  acceptedTerms      = ctx.acceptedTerms;
  lockedNotes        = ctx.lockedNotes;
  actionProposals    = ctx.actionProposals;
  proposals          = ctx.proposals;
  proposalTimers     = ctx.proposalTimers;
  dyncapChains       = ctx.dyncapChains;
  probe              = ctx.probe;
  ignoredForSync     = ctx.ignoredForSync;
  channelSubscriptions = ctx.channelSubscriptions;
  pendingPersistRequests = ctx.pendingPersistRequests;
  rhoquHandlers = ctx.rhoquHandlers;
  pollStore          = ctx.pollStore;
  pollCards          = ctx.pollCards;
  groupStore         = ctx.groupStore;
  // macroStore is per-browser, not aliased per room
  retracted          = ctx.retracted;
}

// Mutate both the active-room's qpeer and the module-level alias in lockstep.
// Used by connect() / disconnect to keep activeRoom.qpeer consistent.
function setQpeer(p: QOSPeer | null): void {
  qpeer = p;
  activeRoom.qpeer = p;
}

function setPosixNet(p: PosixNet | null): void {
  posixNet = p;
  activeRoom.posixNet = p;
}

function lemmaToCapToken(name: string, tw: Uint8Array): string {
  // The cap label sits between colons, so slugify spaces out of the name.
  const label = name.trim().replace(/\s+/g, "-");
  return `cap:${label}:${Array.from(tw).map(b => b.toString(16)).join("")}`;
}

// The next free integer lemma name — how a discovered closure ("event") is
// named, in discovery order. First-write-wins by name (like every lemma), so
// two peers running the same search converge (the service yields events in a
// deterministic order); two peers running different searches may briefly race a
// number, which the caller resolves by taking the next free one.
function nextEventNumber(): number {
  let max = 0;
  for (const k of lemmaStore.keys()) {
    if (/^\d+$/.test(k)) { const n = parseInt(k, 10); if (n > max) max = n; }
  }
  return max + 1;
}

function allocateTwists(name: string): Uint8Array {
  // Deterministic ZFA-balanced sequence: each char yields one pos + one neg twist.
  const result: number[] = [];
  for (const c of name) {
    const code = c.charCodeAt(0);
    result.push((code & 3) * 2);            // pos: 0, 2, 4, or 6
    result.push(((code >> 2) & 3) * 2 + 1); // neg: 1, 3, 5, or 7
  }
  return new Uint8Array(result);
}

function saveLemmas(): void {
  const data = Object.fromEntries([...lemmaStore.entries()].map(([k, v]) => [k, v]));
  localStorage.setItem(`qos-lemmas-${activeRoom.roomId}`, JSON.stringify(data));
}

function loadLemmas(): void {
  const raw = localStorage.getItem(`qos-lemmas-${activeRoom.roomId}`);
  if (!raw) return;
  try {
    const data = JSON.parse(raw) as Record<string, LemmaEntry>;
    for (const [name, entry] of Object.entries(data)) lemmaStore.set(name, entry);
    renderLemmas();
  } catch { /* ignore corrupt data */ }
}

function saveLibrary(): void {
  localStorage.setItem(`qos-library-${activeRoom.roomId}`,
    JSON.stringify(Object.fromEntries(libraryStore.entries())));
  // What we hold is per-room and per-browser: the entry is public, the bytes
  // are not, and a peer that cleared its storage should say so rather than
  // claim to still have them.
  localStorage.setItem(`qos-library-held-${activeRoom.roomId}`, JSON.stringify([...heldFiles]));
  // When a holder was last seen is what separates "offline" from "gone", and
  // it only means anything across sessions.
  localStorage.setItem(`qos-library-seen-${activeRoom.roomId}`,
    JSON.stringify(Object.fromEntries(holderSeen)));
}

function loadLibrary(): void {
  const raw = localStorage.getItem(`qos-library-${activeRoom.roomId}`);
  if (raw) {
    try {
      for (const [hash, e] of Object.entries(JSON.parse(raw) as Record<string, LibraryEntry>)) {
        const entry = entryFromWire(e);
        if (entry && !isRetracted("library", hash)) libraryStore.set(hash, entry);
      }
    } catch { /* ignore corrupt data */ }
  }
  const held = localStorage.getItem(`qos-library-held-${activeRoom.roomId}`);
  if (held) {
    try { for (const h of JSON.parse(held) as string[]) heldFiles.add(h); }
    catch { /* ignore corrupt data */ }
  }
  const seen = localStorage.getItem(`qos-library-seen-${activeRoom.roomId}`);
  if (seen) {
    try {
      for (const [h, t] of Object.entries(JSON.parse(seen) as Record<string, number>)) {
        if (typeof t === "number") holderSeen.set(h, t);
      }
    } catch { /* ignore corrupt data */ }
  }
  // What this browser holds is a claim about a disk, so ask the disk. Storage
  // can be cleared without the room being told, and claiming to hold bytes we
  // do not have is the one lie a library must not tell.
  void (async () => {
    const onDisk = new Set(await heldHashes());
    let changed = false;
    for (const h of [...heldFiles]) if (!onDisk.has(h)) { heldFiles.delete(h); changed = true; }
    if (changed) saveLibrary();
  })();
}

/**
 * How many copies of an entry are reachable, this one included.
 *
 * The number durability actually depends on: with no server, a file exists for
 * as long as somebody still has it.
 */
function copiesOf(hash: string): number {
  const others = [...(fileHolders.get(hash) ?? [])].filter((p) => peers.has(p)).length;
  return others + (heldFiles.has(hash) ? 1 : 0);
}

/** What can be had, for one entry, right now. */
function availabilityFor(hash: string): Availability {
  return availabilityOf(hash, heldFiles.has(hash),
    fileHolders.get(hash)?.size ?? 0, holderSeen.get(hash));
}

/** Tell the room what we are holding — or tell one peer, when they arrive. */
function announceHeld(to?: string): void {
  if (heldFiles.size === 0 && !to) return;
  const env = { kind: "library-have", hashes: [...heldFiles] };
  if (to) signedSend(to, env); else signedBroadcast(env);
}

/** A peer said what it holds. Availability is live state — replace, never merge. */
function noteHolder(peerId: string, hashes: unknown): void {
  const list = Array.isArray(hashes) ? hashes.filter((h): h is string => typeof h === "string") : [];
  for (const set of fileHolders.values()) set.delete(peerId);
  const now = Date.now();
  for (const hash of list.slice(0, 2000)) {
    const h = hash.toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(h)) continue;
    let set = fileHolders.get(h);
    if (!set) { set = new Set(); fileHolders.set(h, set); }
    set.add(peerId);
    holderSeen.set(h, now);
  }
  saveLibrary();
  renderLibrary();
}

/** A peer left: it is holding nothing here any more. */
function forgetHolder(peerId: string): void {
  for (const set of fileHolders.values()) set.delete(peerId);
  renderLibrary();
}

/**
 * Record an entry, from wherever it came.
 *
 * First writer wins by hash, which needs no arbitration: the hash IS the
 * content, so two peers adding the same file agree by construction, and a
 * second entry for one hash can only differ in what it is called.
 */
function addLibraryEntry(raw: unknown): LibraryEntry | null {
  const entry = entryFromWire(raw);
  if (!entry || isRetracted("library", entry.hash)) return null;
  if (libraryStore.has(entry.hash)) return null;
  libraryStore.set(entry.hash, entry);
  saveLibrary();
  renderLibrary();
  return entry;
}

function savePolls(): void {
  localStorage.setItem(`qos-polls-${activeRoom.roomId}`,
    JSON.stringify(Object.fromEntries(pollStore.entries())));
}


function saveGroups(): void {
  localStorage.setItem(`qos-groups-${activeRoom.roomId}`,
    JSON.stringify(Object.fromEntries(groupStore.entries())));
}

function loadGroups(): void {
  const raw = localStorage.getItem(`qos-groups-${activeRoom.roomId}`);
  if (!raw) return;
  try {
    const data = JSON.parse(raw) as Record<string, Group>;
    for (const [id, g] of Object.entries(data)) groupStore.set(id, g);
    // Ensure every group has a transcript card marker so it replays on reload —
    // groups created before card-replay shipped won't have one yet. Appended to
    // chatLog (not rendered here); applyActiveRoomToUI replays them.
    let added = false;
    for (const g of groupStore.values()) {
      if (!activeRoom.chatLog.some((l) => l.groupId === g.id && !l.issueId)) {
        activeRoom.chatLog.push({ from: g.creator, text: g.name, kind: "peer", groupId: g.id });
        added = true;
      }
      for (const iss of g.issues) {
        if (!activeRoom.chatLog.some((l) => l.groupId === g.id && l.issueId === iss.id)) {
          activeRoom.chatLog.push({ from: g.creator, text: iss.title, kind: "peer", groupId: g.id, issueId: iss.id });
          added = true;
        }
      }
    }
    if (added) { trimChatLog(activeRoom); saveChat(activeRoom); }
    renderGroups();
  } catch { /* ignore corrupt data */ }
}

// ---------------------------------------------------------------------------
// Macros — Interact2 `+commands` (macro-lang.js does the parsing and expanding)
//
// A definition is room state: signed with the author's dyncap, broadcast,
// replayed to whoever joins next, and tombstoned when retracted — the same
// shape as a lemma. That is the "group" tier of EIES's personal → group →
// system hierarchy, and it needs no node, no key and no chain to work.
// ---------------------------------------------------------------------------

interface MacroDef {
  name: string;                        // canonical, lowercased
  params: string[];                    // parameter names, without the `$`
  body: string;                        // `$param` sites unsubstituted
  doc: string;                         // the comment that followed the name
  kind: "command" | "rholang" | "text";
  author: string;                      // peerId of the definer
  authorLabel: string;
  at: number;
  // The author's dyncap ANCHOR, not their chain step. A reload mints a new
  // peerId but keeps the anchor, so this is what says "mine" after a restart —
  // and what a redefine or a retract from another peer has to match.
  anchor?: string;
}

const MACROS_KEY = "qos-macros";                 // per browser, not per room

function saveMacros(): void {
  try {
    localStorage.setItem(MACROS_KEY, JSON.stringify(Object.fromEntries(macroStore.entries())));
  } catch { /* storage full / blocked */ }
}

function loadMacros(): void {
  loadMacroTombstones();
  try {
    const raw = localStorage.getItem(MACROS_KEY);
    if (raw) {
      const data = JSON.parse(raw) as Record<string, MacroDef>;
      for (const [name, def] of Object.entries(data)) macroStore.set(name, def);
    }
    // One-time migration: earlier builds keyed macros per room. Fold every
    // `qos-macros-<roomId>` into the single store (newest `at` wins) and drop
    // the old keys.
    const legacy: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith("qos-macros-")) legacy.push(k);
    }
    for (const k of legacy) {
      try {
        const data = JSON.parse(localStorage.getItem(k) || "{}") as Record<string, MacroDef>;
        for (const [name, def] of Object.entries(data)) {
          const cur = macroStore.get(name);
          if (!cur || (def.at ?? 0) > (cur.at ?? 0)) macroStore.set(name, def);
        }
      } catch { /* skip */ }
      localStorage.removeItem(k);
    }
    if (legacy.length) saveMacros();
  } catch { /* corrupt */ }
  for (const n of [...macroStore.keys()]) if (isMacroTombstoned(n)) macroStore.delete(n);
  renderMacros();
}

/** The lookup `macro-lang` expands against — this browser's macros, by name. */
const macroLookup = (name: string): MacroDef | undefined => macroStore.get(String(name).toLowerCase());

function loadPolls(): void {
  const raw = localStorage.getItem(`qos-polls-${activeRoom.roomId}`);
  if (!raw) return;
  try {
    const data = JSON.parse(raw) as Record<string, Poll>;
    for (const [id, p] of Object.entries(data)) pollStore.set(id, p);
    renderPolls();
  } catch { /* ignore corrupt data */ }
}

// Retraction tombstones — "<kind>:<id>" of removed gossiped items.
function tombKey(kind: string, id: string): string { return `${kind}:${id}`; }
function isRetracted(kind: string, id: string): boolean { return retracted.has(tombKey(kind, id)); }
function markRetracted(kind: string, id: string): void { retracted.add(tombKey(kind, id)); saveRetracted(); }
function saveRetracted(): void {
  localStorage.setItem(`qos-retracted-${activeRoom.roomId}`, JSON.stringify([...retracted]));
}
function loadRetracted(): void {
  const raw = localStorage.getItem(`qos-retracted-${activeRoom.roomId}`);
  if (!raw) return;
  try {
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) for (const k of arr) retracted.add(String(k));
  } catch { /* ignore corrupt data */ }
}

function saveNotes(): void {
  const room = activeRoom.roomId;
  localStorage.setItem(`qos-currencies-${room}`,       JSON.stringify(Object.fromEntries(currencyTokens)));
  localStorage.setItem(`qos-notes-${room}`,            JSON.stringify(Object.fromEntries(noteStore)));
  localStorage.setItem(`qos-receipts-${room}`,         JSON.stringify(Object.fromEntries(receiptStore)));
  localStorage.setItem(`qos-redemptions-${room}`,      JSON.stringify(Object.fromEntries(redemptionsHonored)));
  localStorage.setItem(`qos-known-currencies-${room}`, JSON.stringify(Object.fromEntries(knownCurrencies)));
  localStorage.setItem(`qos-series-terms-${room}`,     JSON.stringify(Object.fromEntries(seriesTerms)));
  localStorage.setItem(`qos-accepted-terms-${room}`,   JSON.stringify(Object.fromEntries(acceptedTerms)));
  localStorage.setItem(`qos-locked-notes-${room}`,     JSON.stringify(Object.fromEntries(lockedNotes)));
  localStorage.setItem(`qos-ignored-sync-${room}`,     JSON.stringify(Array.from(ignoredForSync)));
  localStorage.setItem(`qos-channel-subs-${room}`,     JSON.stringify(Array.from(channelSubscriptions)));
}

function saveDyncap(): void {
  if (dyncapState) localStorage.setItem("qos-dyncap-state", serializeState(dyncapState));
  localStorage.setItem(`qos-dyncap-chains-${activeRoom.roomId}`, serializeChain(dyncapChains));
}

async function loadDyncap(): Promise<void> {
  const raw = localStorage.getItem("qos-dyncap-state");
  if (raw) {
    // Pass the active room id so legacy single-seq state migrates cleanly.
    const loaded = await deserializeState(raw, activeRoom.roomId);
    if (loaded) dyncapState = loaded;
  }
  if (!dyncapState) {
    dyncapState = await newDynCapState();
    localStorage.setItem("qos-dyncap-state", serializeState(dyncapState));
  }
}

// Sign-and-broadcast: enqueues the signing so seq order is preserved across
// concurrent outbound envelopes. Falls back to an unsigned send if dyncap
// hasn't been initialized yet (early-init edge cases).
function signedBroadcast(envelope: Record<string, unknown>): void {
  signQueue = signQueue.then(async () => {
    if (!qpeer) return;
    if (!dyncapState) { qpeer.broadcast(envelope); return; }
    const dyncap = await signEnvelope(dyncapState, activeRoom.roomId, envelope);
    saveDyncap();
    qpeer.broadcast({ ...envelope, dyncap });
  }).catch(() => { /* swallow signing errors so the queue keeps moving */ });
}

function signedSend(peerId: string, envelope: Record<string, unknown>): boolean {
  // For direct sends we return synchronously (false if no peer/channel);
  // signing is queued and fires on the same channel.
  if (!qpeer) return false;
  signQueue = signQueue.then(async () => {
    if (!qpeer || !dyncapState) return;
    const dyncap = await signEnvelope(dyncapState, activeRoom.roomId, envelope);
    saveDyncap();
    qpeer.send(peerId, { ...envelope, dyncap });
  }).catch(() => { /* swallow */ });
  return true;
}

/// Verify an inbound envelope's dyncap if present. Returns a status string for
/// chat display (empty when no dyncap was carried). On fork detection, the
/// affected peer is flagged contested and the user is notified.
async function verifyDyncapIfPresent(from: string, d: Record<string, unknown>): Promise<string> {
  const raw = d.dyncap;
  if (!raw || typeof raw !== "object") return "";
  const dyncap = raw as DyncapField;
  const prior = dyncapChains.get(from);
  const result: VerifyResult = await verifyEnvelope(prior, activeRoom.roomId, d, dyncap);
  switch (result.kind) {
    case "ok":
    case "tofu":
      dyncapChains.set(from, result.entry);
      saveDyncap();
      return result.kind === "tofu" ? "  · dyncap anchor pinned (TOFU)" : "";
    case "anchor-mismatch":
      addMessage("", `  ⚠ dyncap anchor mismatch from ${peerLabel(from)}  expected: ${prior?.anchor.slice(0,16)}…  got: ${dyncap.anchor.slice(0,16)}…`, "system");
      return "  · refused: anchor mismatch";
    case "fork": {
      const entry = prior ? { ...prior, contested: true } : prior;
      if (entry) { dyncapChains.set(from, entry); saveDyncap(); }
      addMessage("", `  ⚠ dyncap FORK detected for ${peerLabel(from)} at seq ${result.seq} — identity contested`, "system");
      return "  · refused: fork";
    }
    case "replay":
      return "  · refused: replay";
    case "invalid":
      return `  · refused: invalid dyncap (${result.reason})`;
  }
}

// ---------------------------------------------------------------------------
// Probe window — joiner-local majority resolution of state discrepancies
// ---------------------------------------------------------------------------

function openProbeWindow(): void {
  if (probe.open) return;
  probe = { open: true, observations: [], contributors: new Set(), timer: null };
  probe.timer = setTimeout(closeProbeWindow, PROBE_WINDOW_MS) as unknown as number;
}

function recordSyncObservations(from: string, lemmas: Array<{ name?: string; twists?: string; cap?: string; who?: string }>,
                                currencies: Array<{ currency?: string; token?: string; issuer?: string }>): void {
  if (!probe.open) return;
  if (probe.contributors.size >= SAMPLE_SIZE && !probe.contributors.has(from)) return;
  probe.contributors.add(from);
  // Weight by sender's dyncap chain depth; fresh peers get the minimum.
  const weight = Math.max(1, dyncapChains.get(from)?.lastSeq ?? 1);
  for (const e of lemmas) {
    if (!e.name || !e.twists) continue;
    probe.observations.push({
      storeName: "lemmas",
      key: e.name,
      value: normalizeValue({ twists: e.twists, cap: e.cap ?? null }, []),
      peer: from,
      weight,
    });
  }
  for (const e of currencies) {
    if (!e.currency || !e.token) continue;
    probe.observations.push({
      storeName: "currencies",
      key: e.token,
      value: normalizeValue({ currency: e.currency, issuer: e.issuer ?? null }, []),
      peer: from,
      weight,
    });
  }
  if (probe.contributors.size >= SAMPLE_SIZE) closeProbeWindow();
}

function closeProbeWindow(): void {
  if (!probe.open) return;
  probe.open = false;
  if (probe.timer !== null) { clearTimeout(probe.timer); probe.timer = null; }

  const discrepancies = findDiscrepancies(probe.observations);
  if (discrepancies.length === 0) return;

  let applied = 0;
  for (const d of discrepancies) {
    const leader = d.observations[0];
    const tally = `weight ${leader.weight} vs ${d.observations.slice(1).map(o => o.weight).join(", ")} · ${leader.count} vs ${d.observations.slice(1).map(o => o.count).join(", ")} peers`;
    if (d.winner === null) {
      // No supermajority. Surface the disagreement; do not modify local state.
      signedBroadcast({
        kind: "state-discrepancy",
        storeName: d.storeName,
        key: d.key,
        observations: d.observations,
        winner: null,
        totalWeight: d.totalWeight,
      });
      addMessage("", `⚠ state discrepancy on ${d.storeName}/${d.key} — contested (no supermajority by weight); keeping local value`, "system");
      addMessage("", `  · ${tally}`, "system");
      continue;
    }
    const winner = JSON.parse(d.winner) as Record<string, unknown>;
    if (d.storeName === "lemmas") {
      const existing = lemmaStore.get(d.key);
      const expectedValue = existing ? normalizeValue({ twists: existing.twists, cap: existing.cap ?? null }, []) : null;
      if (expectedValue !== d.winner) {
        lemmaStore.set(d.key, {
          twists: String(winner.twists ?? ""),
          who: existing?.who ?? "(majority)",
          cap: winner.cap === null ? undefined : winner.cap as string | undefined,
          dyncap: existing?.dyncap,
        });
        applied++;
      }
    } else {
      const existing = knownCurrencies.get(d.key);
      const expectedValue = existing ? normalizeValue({ currency: existing.currency, issuer: existing.issuer ?? null }, []) : null;
      if (expectedValue !== d.winner) {
        knownCurrencies.set(d.key, {
          currency: String(winner.currency ?? ""),
          token: d.key,
          issuer: String(winner.issuer ?? "(majority)"),
          dyncap: existing?.dyncap,
        });
        applied++;
      }
    }
    signedBroadcast({
      kind: "state-discrepancy",
      storeName: d.storeName,
      key: d.key,
      observations: d.observations,
      winner: winner,
      totalWeight: d.totalWeight,
    });
    addMessage("", `⚠ state discrepancy on ${d.storeName}/${d.key} — applied majority view (${tally})`, "system");
  }

  // Losing nodes are ignored: their future sync envelopes are dropped.
  const losers = losingPeersIn(discrepancies);
  if (losers.size > 0) {
    for (const peer of losers) {
      ignoredForSync.add(peer);
      addMessage("", `  · ignoring future sync from ${peerLabel(peer)} (losing observer)`, "system");
    }
  }

  if (applied > 0) {
    saveLemmas();
    saveNotes();
    renderLemmas();
    renderNotes();
  } else {
    saveNotes();   // persist ignoredForSync even if no winners changed local state
  }
}

function loadNotes(): void {
  const room = activeRoom.roomId;
  const tryLoad = <T>(key: string, set: (k: string, v: T) => void) => {
    const raw = localStorage.getItem(key);
    if (!raw) return;
    try {
      const data = JSON.parse(raw) as Record<string, T>;
      for (const [k, v] of Object.entries(data)) set(k, v);
    } catch { /* ignore */ }
  };
  tryLoad<string>          (`qos-currencies-${room}`,       (k, v) => currencyTokens.set(k, v));
  tryLoad<NoteEntry>       (`qos-notes-${room}`,            (k, v) => noteStore.set(k, v));
  tryLoad<ReceiptEntry>    (`qos-receipts-${room}`,         (k, v) => receiptStore.set(k, v));
  tryLoad<RedemptionRecord>(`qos-redemptions-${room}`,      (k, v) => redemptionsHonored.set(k, v));
  tryLoad<KnownCurrency>   (`qos-known-currencies-${room}`, (k, v) => knownCurrencies.set(k, v));
  tryLoad<SeriesTerms>     (`qos-series-terms-${room}`,     (k, v) => seriesTerms.set(k, v));
  tryLoad<AcceptedTerms>   (`qos-accepted-terms-${room}`,   (k, v) => acceptedTerms.set(k, v));
  // Dyncap chain state (per-room)
  const dynChainRaw = localStorage.getItem(`qos-dyncap-chains-${room}`);
  if (dynChainRaw) {
    for (const [k, v] of deserializeChain(dynChainRaw)) dyncapChains.set(k, v);
  }
  // Ignored-for-sync peers (per-room): peers whose snapshots lost a vote.
  const ignoredRaw = localStorage.getItem(`qos-ignored-sync-${room}`);
  if (ignoredRaw) {
    try {
      const list = JSON.parse(ignoredRaw) as string[];
      if (Array.isArray(list)) for (const p of list) ignoredForSync.add(p);
    } catch { /* ignore */ }
  }
  // Channel subscriptions (per-room).
  const chanRaw = localStorage.getItem(`qos-channel-subs-${room}`);
  if (chanRaw) {
    try {
      const list = JSON.parse(chanRaw) as string[];
      if (Array.isArray(list)) for (const n of list) channelSubscriptions.add(n);
    } catch { /* ignore */ }
  }
  // Locked notes from a previous session are orphans: their proposal state
  // lived in memory only and is gone after reload. Release each back to the
  // wallet so the user doesn't lose value across a refresh.
  const lockedRaw = localStorage.getItem(`qos-locked-notes-${room}`);
  if (lockedRaw) {
    try {
      const data = JSON.parse(lockedRaw) as Record<string, LockedNote>;
      for (const lock of Object.values(data)) {
        noteStore.set(lock.token, {
          token: lock.token,
          currency: lock.currency,
          denomination: lock.denomination,
          receivedFrom: lock.receivedFrom,
        });
      }
      localStorage.removeItem(`qos-locked-notes-${room}`);
    } catch { /* */ }
  }
  // Migration: seed knownCurrencies from currencies I issue if the registry is empty.
  if (knownCurrencies.size === 0 && currencyTokens.size > 0) {
    const me = myName || "you";
    for (const [currency, token] of currencyTokens) {
      knownCurrencies.set(token, { currency, token, issuer: me });
    }
    saveNotes();
  }
  renderNotes();
}

// ---------------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------------

function setStatus(state: "disconnected" | "connecting" | "connected", label: string): void {
  if (!isUiActive()) return;
  statusDot.className = `status-dot ${state === "disconnected" ? "" : state}`;
  statusText.textContent = label;
  statusText.style.color = state === "connected" ? "#4caf50"
                         : state === "connecting" ? "#ff9800"
                         : "#555";
}

// "connected · N peers" — the live count lets you watch peers drop and reconnect
// (e.g. after a tab switch) instead of a static "connected".
/**
 * The ICE servers this browser uses, per device rather than per room.
 *
 * Kept here rather than in `peer.ts` because it is a preference: whose relay a
 * connection may pass through is a decision, and the peer transport should not
 * be the thing that holds it.
 */
const ICE_KEY = "qos-ice";
/**
 * The last `/ice test` result, kept so it can be read again.
 *
 * A diagnostic is only useful once somebody else has read it, and on a phone
 * the lines are easy to lose — a scroll, a tab, a keyboard opening. Stored per
 * device rather than in the transcript so it survives whatever closed it.
 */
const ICE_TEST_KEY = "qos-ice-last";

function loadIceServers(): RTCIceServer[] {
  try {
    const raw = localStorage.getItem(ICE_KEY);
    if (!raw) return DEFAULT_ICE;
    const list = JSON.parse(raw) as RTCIceServer[];
    return Array.isArray(list) && list.length ? list : DEFAULT_ICE;
  } catch { return DEFAULT_ICE; }
}

function saveIceServers(list: RTCIceServer[] | null): void {
  if (list) localStorage.setItem(ICE_KEY, JSON.stringify(list));
  else localStorage.removeItem(ICE_KEY);
}

/** What a connection may use: what `/ice` holds, with the sidebar's STUN first. */
function iceServersFor(stun: string): RTCIceServer[] {
  const saved = loadIceServers();
  if (!stun) return saved;
  return [{ urls: stun }, ...saved.filter((s) => JSON.stringify(s.urls) !== JSON.stringify(stun))];
}

/**
 * Whether `connect()` fetches a relay from the signaling server by default.
 *
 * Chat surviving over the flood overlay used to hide that calls need this: a
 * data-channel message can flood peer-to-agent-to-peer with no direct link,
 * but a MediaStreamTrack cannot — a call between two peers who can't form a
 * direct connection (symmetric NAT, mobile CGNAT, a NAT'd container) produced
 * no video at all, silently (quantum-os#126). Default on, because that is the
 * common case this tool is actually for, not the exception. `/ice auto off`
 * opts out — the credential is short-lived and Cloudflare-minted per fetch
 * (see fetchAutoTurn), but whose machine your media passes through even
 * briefly is still a decision, same reasoning as `/ice turn` never being
 * silently defaulted before this.
 */
const ICE_AUTO_KEY = "qos-ice-auto";
function autoTurnEnabled(): boolean {
  return localStorage.getItem(ICE_AUTO_KEY) !== "off";
}

/**
 * Fetch a short-lived TURN relay from the signaling server's own `GET /turn`
 * — never from Cloudflare directly, and the master API token never reaches
 * this browser, only a credential Cloudflare itself mints and expires (see
 * `packages/signaling/src/turn.ts`). Same-origin as the room's own signaling
 * connection, so no separate config; derived by swapping the ws(s):// scheme
 * for http(s)://.
 *
 * Best-effort and bounded: any failure (offline, CORS, a signaling deploy with
 * no TURN_KEY_* set, a slow cold start) returns `[]` rather than throwing or
 * hanging `connect()` — a room with no relay configured must still connect
 * peers who don't need one, which is most peers most of the time.
 */
/** The signaling server re-mints the TURN credential hourly against a 24h
 *  Cloudflare TTL, so a value cached for ~45 min is always still valid. Caching
 *  it means a reconnect (a flaky link can produce many) does not re-hit `/turn`
 *  every time — the endpoint is cheap but on a metered signaling host every
 *  request counts. */
const TURN_CACHE_KEY = "qos-turn-cache";
const TURN_CACHE_MS = 45 * 60 * 1000;

async function fetchAutoTurn(signalingUrl: string): Promise<RTCIceServer[]> {
  if (!autoTurnEnabled()) return [];
  let base: string;
  try { base = new URL(signalingUrl.replace(/^ws/, "http")).origin; } catch { return []; }
  try {
    const raw = localStorage.getItem(TURN_CACHE_KEY);
    if (raw) {
      const c = JSON.parse(raw) as { origin: string; at: number; iceServers: RTCIceServer[] };
      if (c.origin === base && Date.now() - c.at < TURN_CACHE_MS && Array.isArray(c.iceServers)) {
        return c.iceServers;
      }
    }
  } catch { /* fall through to a fetch */ }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 4000);
  try {
    const res = await fetch(`${base}/turn`, { signal: ctrl.signal });
    if (!res.ok) return [];
    const data = (await res.json()) as { iceServers?: RTCIceServer[] };
    const iceServers = Array.isArray(data.iceServers) ? data.iceServers : [];
    try { localStorage.setItem(TURN_CACHE_KEY, JSON.stringify({ origin: base, at: Date.now(), iceServers })); } catch { /* ignore */ }
    return iceServers;
  } catch { return []; }
  finally { clearTimeout(timer); }
}

/**
 * Put later output back where the command was typed.
 *
 * `activeRoom` is aliased state: an inbound callback swaps it while it works,
 * and an async command finishing during that window appends its lines to
 * whichever room happened to be current — where they are either invisible or
 * wiped by the next transcript repaint, which reads the *viewed* room's log.
 * Anything that answers after an await has to say which room it is answering
 * in, the way the peer callbacks already do.
 */
function inRoom<T>(ctx: RoomContext, fn: () => T): T {
  const prev = activeRoom;
  setActiveRoom(ctx);
  try { return fn(); } finally { setActiveRoom(prev); }
}

function connectedLabel(): string {
  const n = peers.size;
  const out = unreachablePeers().length;
  return `connected · ${n} peer${n === 1 ? "" : "s"}`
       + (out ? ` · ${out} unreachable` : "");
}

/**
 * How many people a room actually holds.
 *
 * Not a configured cap — a fact about a full mesh: every browser opens a
 * connection to every other, so the cost per person is the room's size and a
 * browser gives out somewhere past ten. Five is where a group thinks together
 * at all (the collective-intelligence number), so ten is already generous and
 * the interesting limit is the human one.
 *
 * Nothing is refused at the door. The room simply cannot connect everyone past
 * this, and what matters is that it SAYS so rather than looking like chat is
 * broken.
 */
const ROOM_HOLDS = 10;
/**
 * How long a handshake gets before we call it failed rather than slow.
 *
 * Longer than a retry cycle, deliberately: `peer.ts` sweeps every 12s and makes
 * its first attempt after 8, so a shorter grace announces a failure while the
 * repair is still in progress — and most of those repair themselves.
 */
const HANDSHAKE_GRACE_MS = 30_000;

/**
 * A peer has been in the room without a channel long enough that it is not
 * coming. Say so once, in the terms that are actually true: past ten the room
 * is full, below it something else went wrong.
 */
/**
 * What the connection's own state means, in a sentence.
 *
 * Three faults look identical from the roster and want different things done
 * about them, and nobody should have to know a diagnostic command to be told
 * which one they have.
 */
function readConnection(row: { channel: string; connection: string; ice: string }): string {
  if (row.ice === "failed" || row.connection === "failed") {
    return "no path between these two networks — that pair needs a relay (/ice turn …)";
  }
  if (row.ice === "checking") {
    // Which side is at fault is answerable from the room: whoever fails against
    // everyone remote, while peers on this machine still work, is the one whose
    // network cannot be crossed — and a relay on that side alone is enough,
    // because the other side can reach the relay's public address.
    return "candidates are arriving but not pairing — a strict NAT on one side. "
      + "If everyone remote fails for you while peers on this machine work, it is yours: "
      + "add a relay with /ice turn <url> <user> <pass>, then Disconnect and Connect. "
      + "One side having a relay is enough.";
  }
  if (row.connection === "connected" && row.channel !== "open") {
    return "connected, but the data channel never surfaced — a reload on either side clears this one";
  }
  if (row.connection === "none") return "no attempt in flight; the next retry will start one";
  return "still negotiating";
}

function reportUnreachable(id: string): void {
  // isReachable, not hasChannel: chat rides the relayed control plane, so a
  // peer the server lists gets what we type whether or not a direct WebRTC
  // link exists (that link matters for calls and files — see /conn). This
  // only fires for a peer we show that the server does not list at all.
  if (!qpeer || qpeer.isReachable(id) || !peers.has(id)) return;
  if (unreachableWarned.has(id)) return;
  // Long enough to be a problem rather than a handshake in progress. Timed from
  // when the peer appeared, whichever way it appeared: it used to be armed only
  // on a clean first join, so a peer that arrived through the flap-recovery
  // path — which is every peer during a bad spell — was never diagnosed.
  const since = peerSeenAt.get(id);
  if (since === undefined || Date.now() - since < HANDSHAKE_GRACE_MS) return;
  unreachableWarned.add(id);
  // The diagnosis, with the complaint. Asking someone to run a command to find
  // out why is asking them to already know there is a command.
  const row = qpeer.connectionReport().find((r) => r.peerId === id);
  const size = peers.size + 1;
  addMessage("", size > ROOM_HOLDS
    ? `⚠ the room is full — ${size} here, and a browser mesh holds about ${ROOM_HOLDS}. `
      + `${peerLabel(id)} is in the room but not connected to you: neither of you sees what the other types. `
      + `Split the group (five is where a room actually thinks together) or run your own signaling server.`
    : `⚠ ${peerLabel(id)} is listed here but the signaling server no longer lists them, `
      + `so nothing typed reaches them. They will clear from the room, or come back, shortly.`,
    "system");
  if (row) {
    addMessage("", `   connection ${row.connection} · ice ${row.ice} — ${readConnection(row)}`, "system");
    // "No attempt in flight" for somebody the room can see means the two
    // rosters disagree. Repair it from the side that knows, rather than
    // reporting it and waiting.
    if (row.connection === "none") {
      qpeer.ensureConnected(id);
      addMessage("", "   starting one now", "system");
    }
  }
  renderPeers();
}

/**
 * Peers we show that the relay cannot reach — not in the server's roster and
 * no direct link either. Rare now that chat rides the relay (a WebRTC
 * handshake that never completes no longer makes anyone unreachable); what
 * is left is a roster disagreement, which clears itself on the next roster.
 */
function unreachablePeers(): string[] {
  if (!qpeer) return [];
  return [...peers].filter((id) => !qpeer!.isReachable(id));
}

function renderChatLine(line: ChatLine): void {
  const div = document.createElement("div");
  div.className = `msg${line.kind === "system" ? " system-line" : ""}`;
  if (line.pollId) {
    div.className = "msg poll-msg";
    renderPollCardInto(div, line.pollId);
    messagesEl.appendChild(div);
    return;
  }
  if (line.groupId && line.issueId) {
    div.className = "msg gov-msg";
    renderIssueCardInto(div, line.groupId, line.issueId);
    messagesEl.appendChild(div);
    return;
  }
  if (line.groupId) {
    div.className = "msg gov-msg";
    renderGroupCardInto(div, line.groupId);
    messagesEl.appendChild(div);
    return;
  }
  const fromEl = document.createElement("span");
  fromEl.className = `from ${line.kind}`;
  // A system line's "·" is a gutter mark, not content: it comes from CSS
  // (.from.system::before) so that selecting a run of system lines and copying
  // them yields the text alone. It used to be textContent, which put a "·" in
  // front of every line of anything copied out of the transcript.
  fromEl.textContent = line.kind === "system" ? ""
                     : line.kind === "self"   ? (myName || "you")
                     : (line.label ?? shortId(line.from));
  const textEl = document.createElement("span");
  textEl.className = "text";
  if (line.media) {
    renderMedia(textEl, line.media);
  } else {
    textEl.innerHTML = renderMarkdown(line.text);
  }
  div.appendChild(fromEl);
  div.appendChild(textEl);
  messagesEl.appendChild(div);
}

function addMessage(from: string, text: string, kind: "peer" | "self" | "system" = "peer", label?: string): void {
  const line: ChatLine = { from, text, kind, label };
  activeRoom.chatLog.push(line);
  trimChatLog(activeRoom);
  saveChat(activeRoom);
  if (isUiActive()) {
    renderChatLine(line);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  } else {
    // Activity in a non-viewed tab — surface it via the tab unread indicator.
    markUnread(activeRoom);
  }
}

// Cap the per-room chat log so long sessions don't grow unbounded.
const CHAT_LOG_MAX = 500;
function trimChatLog(room: RoomContext): void {
  if (room.chatLog.length > CHAT_LOG_MAX) {
    room.chatLog.splice(0, room.chatLog.length - CHAT_LOG_MAX);
  }
}

function shortId(id: string): string {
  const parts = id.split(":");
  const hex = parts[2] ?? id;
  return hex.slice(0, 8) + "…";
}

function peerLabel(id: string): string {
  const n = peerNames.get(id);
  if (n && n.trim()) return n;
  // Fall back to the sticky last-known name (survives flaps) before the raw id,
  // so a reconnecting agent stays labelled instead of flashing a hex id.
  const last = lastKnownNames.get(id);
  if (last && last.trim()) return last;
  return shortId(id);
}

// Emit the "<name> joined" line once we know the peer's NAME (browsers send it
// right after the channel opens), or after a short timeout fall back to the id so a
// slow/nameless peer still shows. No-op if the peer already left or was announced.
function announceJoin(id: string): void {
  const jt = pendingJoins.get(id);
  if (jt === undefined) return;
  clearTimeout(jt);
  pendingJoins.delete(id);
  if (peers.has(id)) addMessage("", `${peerLabel(id)} joined`, "system");
}

function findPeerByName(name: string): string | null {
  const lower = name.toLowerCase();
  for (const [id, peerName] of peerNames) {
    if (peerName.toLowerCase() === lower) return id;
  }
  for (const [id, peerName] of peerNames) {
    if (peerName.toLowerCase().startsWith(lower)) return id;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Tabs — multi-room substrate
// ---------------------------------------------------------------------------

function renderTabs(): void {
  tabListEl.innerHTML = "";
  for (const ctx of rooms.values()) {
    const tab = document.createElement("div");
    const isActive = ctx.roomId === uiActiveRoom.roomId;
    tab.className = "tab"
      + (isActive ? " active" : "")
      + (ctx.hasUnread && !isActive ? " unread" : "");
    tab.title = ctx.roomId + (ctx.hasUnread && !isActive ? " (unread)" : "");
    const label = document.createElement("span");
    label.className = "tab-label";
    label.textContent = (ctx.hasUnread && !isActive ? "● " : "") + shortId(ctx.roomId);
    tab.appendChild(label);
    // Only show the close button when there's more than one tab open.
    if (rooms.size > 1) {
      const close = document.createElement("button");
      close.className = "tab-close";
      close.textContent = "×";
      close.title = "Close this room";
      close.addEventListener("click", (e) => { e.stopPropagation(); closeRoomTab(ctx.roomId); });
      tab.appendChild(close);
    }
    tab.addEventListener("click", () => { if (ctx.roomId !== uiActiveRoom.roomId) switchToRoom(ctx.roomId); });
    tabListEl.appendChild(tab);
  }
}

// Switch the active room. Re-renders the whole UI to reflect the new room's
// state. Does NOT disconnect existing connections — each tab keeps its
// per-room qpeer; only the *active* tab's qpeer drives the visible UI.
// (MVP constraint: even though qpeer is per-room in RoomContext, in practice
// only one is connected at a time today.)
function switchToRoom(roomId: string): void {
  const next = rooms.get(roomId);
  if (!next || next.roomId === uiActiveRoom.roomId) return;
  setActiveRoom(next);
  uiActiveRoom = next;
  next.hasUnread = false;        // viewing the room clears the unread flag
  applyActiveRoomToUI();
}

function applyActiveRoomToUI(): void {
  // Sidebar identity / room display
  // Signaling URL field reflects this room's last-used URL.
  signalUrlEl.value = activeRoom.signalingUrl;
  // Connect button reflects this room's qpeer state.
  if (qpeer) {
    connectBtn.textContent = "Disconnect";
    setStatus("connected", `connected · ${activeRoom.signalingUrl}`);
    msgInput.disabled = false;
    sendBtn.disabled  = false;
  } else {
    connectBtn.textContent = "Connect";
    setStatus("disconnected", "disconnected");
    msgInput.disabled = true;
    sendBtn.disabled  = true;
  }
  // Chat history replay
  messagesEl.innerHTML = "";
  for (const line of activeRoom.chatLog) renderChatLine(line);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  // Sidebar lists
  renderPeers();
  renderLemmas();
  renderLibrary();
  renderNotes();
  renderPolls();
  renderMacros();
  // Share link + tab highlight
  updateShareLink();
  renderTabs();
  // Update the URL to the new active room, or keep it out of the address bar
  syncRoomHash();
}

function openRoomTab(roomId: string): void {
  // Idempotent: if already joined, just switch.
  if (rooms.has(roomId)) { switchToRoom(roomId); return; }
  const ctx = createRoom(roomId);
  rooms.set(roomId, ctx);
  // Load per-room persisted state from localStorage into the new context.
  loadRoomState(ctx);
  saveJoinedRooms();
  switchToRoom(roomId);
}

function closeRoomTab(roomId: string): void {
  if (!rooms.has(roomId)) return;
  if (rooms.size <= 1) return;   // never close the last tab
  const ctx = rooms.get(roomId)!;
  // Tear down the connection if any.
  if (ctx.qpeer) { ctx.qpeer.disconnect(); ctx.qpeer = null; }
  if (ctx.posixNet) { ctx.posixNet.close(); ctx.posixNet = null; }
  rooms.delete(roomId);
  saveJoinedRooms();
  // If we closed the visible one, pick another to activate.
  if (uiActiveRoom.roomId === roomId) {
    const next = rooms.values().next().value as RoomContext;
    setActiveRoom(next);
    uiActiveRoom = next;
    applyActiveRoomToUI();
  } else {
    renderTabs();
  }
}

function saveJoinedRooms(): void {
  const ids = Array.from(rooms.keys());
  localStorage.setItem("qos-joined-rooms", JSON.stringify(ids));
}

function loadJoinedRooms(): string[] {
  const raw = localStorage.getItem("qos-joined-rooms");
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === "string") : [];
  } catch { return []; }
}

// Populate a RoomContext's stores from per-room localStorage. Re-uses the
// existing load functions, which read via the module-level aliases — so we
// briefly point them at `ctx` for the duration of the load.
function loadRoomState(ctx: RoomContext): void {
  const previousActive = activeRoom;
  setActiveRoom(ctx);
  loadLemmas();
  loadLibrary();
  renderLibrary();
  loadNotes();
  loadPolls();
  loadGroups();
  loadRetracted();
  if (previousActive) setActiveRoom(previousActive);
}

/// Try to pull a cap:room:… token out of a user-pasted string. Accepts a
/// raw token or a share URL whose hash carries room=cap:room:…
function extractRoomCap(input: string): string | null {
  const s = input.trim();
  if (s.startsWith("cap:room:")) return s;
  const m = s.match(/room=(cap:room:[0-7]+)/);
  return m ? m[1] : null;
}

function promptJoinRoom(): void {
  const input = prompt("Join room — paste a cap:room:… token or a share URL");
  if (!input) return;
  const roomId = extractRoomCap(input);
  if (!roomId) { alert("Couldn't find a cap:room:… token in that input"); return; }
  // Same reasoning as /room join: a legacy (pre-Pauli-closure) cap is still a
  // real room — the public room is one — so warn rather than refuse.
  if (!validateCapability(roomId)) addMessage("", `⚠ room cap is not ZFA-closed (a legacy token?) — joining anyway: ${roomId}`, "system");
  openRoomTab(roomId);
}

function renderRoomProcess(): void {
  if (!isUiActive()) return;
  const allPeers = qpeer ? [qpeer.peerId, ...[...peers]] : [...peers];
  if (allPeers.length === 0) { roomProcessEl.textContent = "—"; return; }

  let totalPos = 0, totalNeg = 0;
  const peerLines: string[] = [];
  for (const id of allPeers) {
    const tw = tokenTwists(id);
    const label = id === qpeer?.peerId
      ? (myName || shortId(id)) + " (you)"
      : peerLabel(id);
    if (tw) {
      const { pos, neg } = twistStats(tw);
      totalPos += pos; totalNeg += neg;
      peerLines.push(`  action(${label})  ${pos}+/${neg}-`);
    }
  }
  const gap = Math.abs(totalPos - totalNeg);
  const balanced = totalPos === totalNeg;
  const lines = [
    "parallel(",
    ...peerLines,
    ")",
    `ZFA: ${balanced ? "✓" : "✗"}  gap: ${gap}  total twists: ${totalPos + totalNeg}`,
  ];
  if (qpeer) {
    const ptw = tokenTwists(qpeer.peerId);
    const pLevel = ptw ? zfaFreqLevel(ptw) : null;
    if (pLevel !== null) {
      lines.push(`freq level: ${pLevel}  C(${2*pLevel},${pLevel}) = ${zfaMultiplicity(pLevel).toLocaleString()}`);
    }
  }
  roomProcessEl.textContent = lines.join("\n");
}

// Insert a reference (a lemma @name or a peer/cap id) into the composer. If the box
// is empty, start a /qucalc with it (quick-eval); otherwise insert it at the cursor
// so it *composes* with whatever command is being typed (e.g. `/forget lemma <ref>`,
// `/qucalc @a @b`) instead of clobbering the input. Clobbering was the cause of
// "clicking a lemma/peer turns my /forget into /qucalc".
function insertRef(ref: string): void {
  const cur = msgInput.value;
  if (cur.trim() === "") {
    msgInput.value = `/qucalc ${ref}`;
  } else {
    const start = msgInput.selectionStart ?? cur.length;
    const end = msgInput.selectionEnd ?? cur.length;
    const before = cur.slice(0, start);
    const after = cur.slice(end);
    const lead = before === "" || before.endsWith(" ") ? "" : " ";
    const tail = after === "" || after.startsWith(" ") ? "" : " ";
    msgInput.value = before + lead + ref + tail + after;
    const pos = (before + lead + ref).length;
    msgInput.setSelectionRange(pos, pos);
  }
  msgInput.focus();
}

function renderPeers(): void {
  if (!isUiActive()) return;
  peerCount.textContent = String(peers.size);
  // Keep the connection status' peer count live, so peers visibly drop and return
  // (only while signaling is up — don't clobber a real "reconnecting…").
  if (qpeer?.isSignalingUp()) setStatus("connected", connectedLabel());
  peerList.innerHTML = "";
  if (qpeer) {
    const li = document.createElement("li");
    li.className = "you";
    li.textContent = `${myName || shortId(qpeer.peerId)} (you)`;
    peerList.appendChild(li);
  }
  for (const id of peers) {
    const li = document.createElement("li");
    li.textContent = peerLabel(id);
    // isReachable, not hasChannel: chat reaches everyone the server lists,
    // through the relay, with or without a direct WebRTC link (which only
    // calls and file transfers need — /conn shows those). This lights up
    // only for a peer the server itself no longer lists.
    if (qpeer && !qpeer.isReachable(id)) {
      li.classList.add("unreachable");
      const warn = document.createElement("span");
      warn.textContent = " ⚠";
      warn.title = "Not reachable — the signaling server no longer lists this peer, so nothing "
        + "typed reaches them. They will clear from the room, or come back, shortly.";
      li.appendChild(warn);
    }
    const role = peerAgents.get(id);
    if (role) {
      const badge = document.createElement("span");
      badge.textContent = " 🤖 AI";
      badge.title = `AI agent (${role})`;
      badge.style.cssText = "opacity:0.7;font-size:0.8em;margin-left:0.25em;";
      li.appendChild(badge);
    }
    li.title = role ? `${id} — AI agent (${role})` : id;
    li.style.cursor = "pointer";
    li.addEventListener("click", () => insertRef(id));
    peerList.appendChild(li);
  }
  renderRoomProcess();
}

// Append a small ✕ remove control to a sidebar list item. The button stops
// click-propagation so it never triggers the row's prefill handler.
function appendRemoveBtn(li: HTMLElement, title: string, onRemove: () => void): void {
  const x = document.createElement("button");
  x.className = "row-remove";
  x.textContent = "✕";
  x.title = title;
  x.addEventListener("click", (e) => { e.stopPropagation(); onRemove(); });
  li.appendChild(x);
}

/**
 * The library, where a person can see it.
 *
 * A row is a click on the thing you want to happen: play it if we hold it,
 * fetch it if somebody here does, and say why not if nobody does. The mark
 * carries the availability, so a row that cannot be had looks different from
 * one that can before it is clicked rather than after.
 */
function renderLibrary(): void {
  if (!isUiActive()) return;
  libraryCountEl.textContent = String(libraryStore.size);
  libraryListEl.innerHTML = "";
  for (const e of sortEntries(libraryStore.values())) {
    const avail = availabilityFor(e.hash);
    const holders = fileHolders.get(e.hash)?.size ?? 0;
    const li = document.createElement("li");
    li.className = `lib-row lib-${avail}`;

    const mark = document.createElement("span");
    mark.className = "lib-mark";
    mark.textContent = AVAILABILITY_MARK[avail];
    const name = document.createElement("span");
    name.className = "lib-name";
    name.textContent = e.name;
    const size = document.createElement("span");
    size.className = "lib-size";
    size.textContent = fmtFileSize(e.size);

    const copies = copiesOf(e.hash);
    if (atRisk(copies)) li.classList.add("lib-thin");
    li.title = avail === "held" ? `${e.name} — you hold it. Click to play or save.`
      : avail === "here" ? `${e.name} — ${holders} holder${holders === 1 ? "" : "s"} here. Click to fetch.`
      : avail === "known" ? `${e.name} — no holder is here right now.`
      : `${e.name} — no holder has been seen in a week; the entry may be all that is left.`;
    if (atRisk(copies)) {
      li.title += "\nOnly one copy exists. Another peer running /file get is what makes it survive.";
    }
    li.append(mark, name, size);
    li.addEventListener("click", () => openLibraryEntry(e));
    appendRemoveBtn(li, "remove this entry", () => forgetLibraryEntry(e));
    libraryListEl.appendChild(li);
  }
}

/** Clicking an entry does the next thing that makes sense for it. */
function openLibraryEntry(e: LibraryEntry): void {
  if (heldFiles.has(e.hash)) { void playLibraryEntry(e); return; }
  const holders = [...(fileHolders.get(e.hash) ?? [])].filter((p) => peers.has(p));
  if (holders.length) { libraryFetch.want(e.hash, holders[0], e.name); return; }
  addMessage("", `nobody here is holding ${e.name} — /file holders ${shortHash(e.hash)}`, "system");
}

/**
 * Play what we hold, in the transcript.
 *
 * An object URL over the file on disk, not a data: url — the bytes are not
 * copied into the page to be played, which is the difference between a 60 MB
 * recording playing and a tab dying.
 */
async function playLibraryEntry(e: LibraryEntry): Promise<void> {
  const file = await getBytes(e.hash);
  if (!file) {
    heldFiles.delete(e.hash);
    saveLibrary(); announceHeld(); renderLibrary();
    addMessage("", `⚠ the bytes for ${e.name} are gone from this browser's storage`, "system");
    return;
  }
  addMedia("", {
    mediaKind: mediaKindFor(e.mime), name: e.name, mime: e.mime, size: e.size,
    url: URL.createObjectURL(file),
  }, "self");
}

const mediaKindFor = (mime: string): MediaKind =>
  mime.startsWith("image/") ? "image" : mime.startsWith("audio/") ? "audio"
  : mime.startsWith("video/") ? "video" : "file";

function renderLemmas(): void {
  if (!isUiActive()) return;
  lemmaCountEl.textContent = String(lemmaStore.size);
  lemmaListEl.innerHTML = "";
  // Named claims first, then discovered closures (/search events) — both are
  // lemmas, but a room's vocabulary reads better with the authored ones on top.
  const ordered = [...lemmaStore.entries()].sort((a, b) => Number(!!a[1].event) - Number(!!b[1].event));
  for (const [name, entry] of ordered) {
    const li = document.createElement("li");
    li.className = "row-item";
    const label = document.createElement("span");
    const shortText = entry.text && entry.text.length > 40 ? entry.text.slice(0, 39) + "…" : entry.text;
    label.textContent = (entry.event ? "⌁ " : "") + lemmaRefStr(name) + (shortText ? ` — “${shortText}”` : "");
    label.className = "row-label";
    label.addEventListener("click", () => insertRef(lemmaRefStr(name)));
    li.title = `${lemmaRefStr(name)}${entry.text ? `  “${entry.text}”` : ""}${entry.event ? "  (closure discovered by /search)" : ""}\n${entry.twists}${entry.cap ? `  cap: ${entry.cap}` : ""}  (by ${entry.who})`;
    li.appendChild(label);
    appendRemoveBtn(li, "forget this lemma", () => forgetLemma(name));
    lemmaListEl.appendChild(li);
  }
}

function renderNotes(): void {
  if (!isUiActive()) return;
  currencyCountEl.textContent = String(knownCurrencies.size);
  currencyListEl.innerHTML = "";
  // List my own issued currencies first (with ✦), then others (with issuer label).
  const mine: KnownCurrency[]  = [];
  const others: KnownCurrency[] = [];
  for (const entry of knownCurrencies.values()) {
    if (currencyTokens.get(entry.currency) === entry.token) mine.push(entry);
    else others.push(entry);
  }
  for (const entry of mine) {
    const li = document.createElement("li");
    li.textContent = `✦ ${entry.currency}`;
    li.title = `${entry.token}  (you issue ${entry.currency})`;
    li.style.cursor = "pointer";
    li.addEventListener("click", () => { msgInput.value = `/note grant ${entry.currency} `; msgInput.focus(); });
    currencyListEl.appendChild(li);
  }
  for (const entry of others) {
    const li = document.createElement("li");
    li.textContent = `${entry.currency}  (by ${entry.issuer})`;
    li.title = `${entry.token}  (issued by ${entry.issuer})`;
    li.style.cursor = "pointer";
    li.addEventListener("click", () => {
      msgInput.value = `/note redeem ${entry.currency} `;
      msgInput.focus();
    });
    currencyListEl.appendChild(li);
  }
  noteCountEl.textContent = String(noteStore.size);
  noteListEl.innerHTML = "";
  for (const n of noteStore.values()) {
    const li = document.createElement("li");
    li.className = "row-item";
    const fromTag = n.receivedFrom ? `  (from ${n.receivedFrom})` : "";
    const st = seriesTerms.get(n.currency);     // stamped notes carry terms
    const stamp = n.currency.includes("~") ? "  📜" : "";
    const label = document.createElement("span");
    label.textContent = `${n.currency} ${n.denomination}${stamp}${fromTag}`;
    label.className = "row-label";
    label.addEventListener("click", () => {
      msgInput.value = `/note pass ${n.currency} ${n.denomination} `;
      msgInput.focus();
    });
    li.title = st
      ? `📜 terms (${st.termsHash})${acceptedTerms.has(n.currency) ? " · accepted" : ""}: ${st.terms}\n${n.token}`
      : n.token;
    li.appendChild(label);
    appendRemoveBtn(li, "delete this note (destroys its value)", () => forgetNote(n.token));
    noteListEl.appendChild(li);
  }
}

// ---------------------------------------------------------------------------
// ZFA helpers for slash commands
// ---------------------------------------------------------------------------

function tokenTwists(token: string): Uint8Array | null {
  const parts = token.split(":");
  if (parts.length < 3 || parts[0] !== "cap") return null;
  const arr = Uint8Array.from(
    [...parts[2]].map(c => parseInt(c, 16)).filter(n => n >= 0 && n < 8)
  );
  return arr.length > 0 ? arr : null;
}

function twistStats(twists: Uint8Array): { pos: number; neg: number; gap: number; balanced: boolean } {
  const POS = new Set([0, 2, 4, 6]);
  let pos = 0;
  for (const t of twists) if (POS.has(t)) pos++;
  const neg = twists.length - pos;
  const gap = spectralGap(twists);
  return { pos, neg, gap, balanced: achievesZfa(twists) };
}

function binomial(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  if (k === 0 || k === n) return 1;
  k = Math.min(k, n - k);
  let r = 1;
  for (let i = 0; i < k; i++) r = r * (n - i) / (i + 1);
  return Math.round(r);
}

function zfaMultiplicity(n: number): number { return binomial(2 * n, n); }

function zfaFreqLevel(twists: Uint8Array): number | null {
  return twists.length % 2 === 0 ? twists.length / 2 : null;
}

// How far a history strays from ZFA balance — the max over prefixes of the total
// free action |v|+|h|+|d|+|l|. A capacity-R listener hears a closure iff this is
// ≤ R (QLF_ClosureDepthLaw); /solve reads it as the least-free-action cost of a
// path. Mirrors `max_excursion` in qucalc_search.py.
function peakExcursion(history: string): number {
  let v = 0, h = 0, d = 0, l = 0, m = 0;
  for (const t of history) {
    if (t === "^") v++; else if (t === "v") v--;
    else if (t === ">") h++; else if (t === "<") h--;
    else if (t === "/") d++; else if (t === "\\") d--;
    else if (t === "+") l++; else if (t === "-") l--;
    const e = Math.abs(v) + Math.abs(h) + Math.abs(d) + Math.abs(l);
    if (e > m) m = e;
  }
  return m;
}

// One concrete continuation supplying exactly the residual action vector
// (v, h, d, l) — count-balances the history, though its twists may not fold to a
// Pauli scalar in any order. Used by /solve's residual fallback.
function residualToTwists(r: readonly number[]): string {
  const axes: Array<[string, string]> = [["^", "v"], [">", "<"], ["/", "\\"], ["+", "-"]];
  let s = "";
  for (let i = 0; i < 4; i++) s += (r[i] >= 0 ? axes[i][0] : axes[i][1]).repeat(Math.abs(r[i]));
  return s;
}

// ---------------------------------------------------------------------------
// Form matrix math for /braket — toMatrix = [[t+z, x−iy],[x+iy, t−z]]
// ---------------------------------------------------------------------------

interface FormF { t: number; x: number; y: number; z: number }
const STATE_FORMS: Record<string, FormF> = {
  "0":  { t: 0.5, x: 0,    y: 0,    z:  0.5 },
  "1":  { t: 0.5, x: 0,    y: 0,    z: -0.5 },
  "+":  { t: 0.5, x: 0.5,  y: 0,    z:  0   },
  "-":  { t: 0.5, x: -0.5, y: 0,    z:  0   },
  "i":  { t: 0.5, x: 0,    y: 0.5,  z:  0   },
  "-i": { t: 0.5, x: 0,    y: -0.5, z:  0   },
};
const STATE_KET: Record<string, string> = {
  "0": "|0⟩", "1": "|1⟩", "+": "|+⟩", "-": "|-⟩", "i": "|i⟩", "-i": "|-i⟩",
};
const STATE_BRA: Record<string, string> = {
  "0": "⟨0|", "1": "⟨1|", "+": "⟨+|", "-": "⟨-|", "i": "⟨i|", "-i": "⟨-i|",
};

type C2 = [number, number];
type M2x2 = [[C2, C2], [C2, C2]];

function formToMatrix(f: FormF): M2x2 {
  return [
    [[f.t + f.z, 0],    [f.x, -f.y]],
    [[f.x,       f.y],  [f.t - f.z, 0]],
  ];
}

function addM(a: M2x2, b: M2x2): M2x2 {
  return [
    [[a[0][0][0]+b[0][0][0], a[0][0][1]+b[0][0][1]], [a[0][1][0]+b[0][1][0], a[0][1][1]+b[0][1][1]]],
    [[a[1][0][0]+b[1][0][0], a[1][0][1]+b[1][0][1]], [a[1][1][0]+b[1][1][0], a[1][1][1]+b[1][1][1]]],
  ];
}

function fmtC2(c: C2): string {
  const eps = 1e-10;
  const r  = Math.abs(c[0]) < eps ? 0 : c[0];
  const im = Math.abs(c[1]) < eps ? 0 : c[1];
  const fr = (v: number) =>
    Math.abs(v - Math.round(v)) < eps
      ? String(Math.round(v))
      : v.toFixed(3).replace(/\.?0+$/, "");
  if (im === 0) return fr(r);
  if (r  === 0) return Math.abs(im) === 1 ? (im > 0 ? "i" : "-i") : `${fr(im)}i`;
  const iStr = Math.abs(im) === 1
    ? (im > 0 ? "+i" : "-i")
    : `${im > 0 ? "+" : ""}${fr(im)}i`;
  return `${fr(r)}${iStr}`;
}

function fmtMatrix(m: M2x2): [string, string] {
  const a = fmtC2(m[0][0]), b = fmtC2(m[0][1]);
  const c = fmtC2(m[1][0]), d = fmtC2(m[1][1]);
  const w = Math.max(a.length, c.length);
  const pad = (s: string) => s.padStart(w);
  return [`  ⎡ ${pad(a)}  ${b} ⎤`, `  ⎣ ${pad(c)}  ${d} ⎦`];
}

// ---------------------------------------------------------------------------
// Twist helpers for /qucalc — alphabet {^=0, v=1, >=2, <=3, /=4, \=5, +=6, -=7}
// ---------------------------------------------------------------------------

const TWIST_SYM: Record<string, number> = {
  "^": 0, "v": 1, ">": 2, "<": 3, "/": 4, "\\": 5, "+": 6, "-": 7,
};
const TWIST_NAME = ["^", "v", ">", "<", "/", "\\", "+", "-"];

function twistToSymbol(t: number): string { return TWIST_NAME[t] ?? "?"; }
function twistsToSymbolic(tw: Uint8Array): string { return [...tw].map(twistToSymbol).join(""); }

function parseSymbolicTwists(s: string): Uint8Array | null {
  const result: number[] = [];
  for (const c of s.replace(/\s/g, "")) {
    if (c >= "0" && c <= "7") result.push(Number(c));
    else if (c in TWIST_SYM) result.push(TWIST_SYM[c]);
    else return null;
  }
  return result.length > 0 ? new Uint8Array(result) : null;
}

function adjointHistory(tw: Uint8Array): Uint8Array {
  const out = new Uint8Array(tw.length);
  for (let i = 0; i < tw.length; i++) out[i] = tw[tw.length - 1 - i] ^ 1;
  return out;
}

function isSelfAdjoint(tw: Uint8Array): boolean {
  const adj = adjointHistory(tw);
  for (let i = 0; i < tw.length; i++) if (tw[i] !== adj[i]) return false;
  return true;
}

function resolveLemmaToBytes(twistsStr: string): Uint8Array | null {
  if (twistsStr.startsWith("cap:")) return tokenTwists(twistsStr);
  return parseSymbolicTwists(twistsStr);
}

// canonLemma / parseRefTokens live in lemma-parse.ts (pure, unit-tested).
// Reference token for display / input prefill: @name or @[name with spaces].
function lemmaRefStr(name: string): string {
  return /\s/.test(name) ? `@[${name}]` : `@${name}`;
}
// Bare name as a command argument (e.g. after /pass): name or [name with spaces].
function lemmaArgStr(name: string): string {
  return /\s/.test(name) ? `[${name}]` : name;
}

// First @ref in `arg` not in the store, formatted for display (or null).
function firstUnknownRef(arg: string): string | null {
  for (const t of parseRefTokens(arg))
    if (t.kind === "ref" && !lemmaStore.has(t.name)) return lemmaRefStr(t.name);
  return null;
}
// Parse a lone lemma name from an argument: accepts `name`, `[name with spaces]`,
// `@name`, or `@[name with spaces]`. Returns the canonical key.
function parseLemmaNameArg(s: string): string {
  let t = s.trim();
  if (t.startsWith("@")) t = t.slice(1).trim();
  const br = t.match(/^\[([^\]]*)\]$/);
  if (br) t = br[1];
  return canonLemma(t);
}
function expandLemmaRefs(arg: string): {
  expanded: string;
  components: Array<{ label: string | null; twists: string }>;
} | null {
  const components: Array<{ label: string | null; twists: string }> = [];
  const parts: string[] = [];
  for (const t of parseRefTokens(arg)) {
    if (t.kind === "ref") {
      const entry = lemmaStore.get(t.name);
      if (!entry) return null;
      const tw = tokenTwists(entry.twists);
      const resolved = entry.twists.startsWith("cap:") && tw
        ? twistsToSymbolic(tw)
        : entry.twists;
      parts.push(resolved);
      components.push({ label: t.name, twists: resolved });
    } else {
      parts.push(t.text);
      components.push({ label: null, twists: t.text });
    }
  }
  return { expanded: parts.join(""), components };
}

// ---------------------------------------------------------------------------
// Rendezvous helpers — locking, timeouts, commit application
// ---------------------------------------------------------------------------

function pickFreeNote(currency: string, N: number): NoteEntry | null {
  let exact: NoteEntry | null = null;
  let larger: NoteEntry | null = null;
  for (const n of noteStore.values()) {
    if (n.currency !== currency) continue;
    if (n.denomination === N) { exact = n; break; }
    if (n.denomination > N && (!larger || n.denomination < larger.denomination)) larger = n;
  }
  return exact ?? larger;
}

function detachFromFree(chosen: NoteEntry, N: number): { outgoing: string; change: NoteEntry | null } | null {
  if (chosen.denomination === N) {
    noteStore.delete(chosen.token);
    return { outgoing: chosen.token, change: null };
  }
  const split = splitNote(chosen.token, N);
  if (!split) return null;
  const [paid, changeTok] = split;
  const change: NoteEntry = { token: changeTok, currency: chosen.currency, denomination: chosen.denomination - N };
  noteStore.delete(chosen.token);
  noteStore.set(changeTok, change);
  return { outgoing: paid, change };
}

function lockToken(token: string, entry: NoteEntry, proposalId: string): void {
  lockedNotes.set(token, {
    token,
    currency: entry.currency,
    denomination: entry.denomination,
    receivedFrom: entry.receivedFrom,
    proposalId,
    lockedAt: Date.now(),
  });
}

function releaseLockedFor(proposalId: string): void {
  for (const [token, lock] of lockedNotes) {
    if (lock.proposalId !== proposalId) continue;
    noteStore.set(token, {
      token: lock.token,
      currency: lock.currency,
      denomination: lock.denomination,
      receivedFrom: lock.receivedFrom,
    });
    lockedNotes.delete(token);
  }
}

function scheduleProposalTimeout(id: string, ms: number): void {
  const existing = proposalTimers.get(id);
  if (existing !== undefined) clearTimeout(existing);
  const t = setTimeout(() => proposalTimedOut(id), ms) as unknown as number;
  proposalTimers.set(id, t);
}

function clearProposalTimeout(id: string): void {
  const t = proposalTimers.get(id);
  if (t !== undefined) clearTimeout(t);
  proposalTimers.delete(id);
}

function proposalTimedOut(id: string): void {
  const state = proposals.get(id);
  if (!state) return;
  releaseLockedFor(id);
  proposals.delete(id);
  proposalTimers.delete(id);
  saveNotes();
  renderNotes();
  if (state.role === "proposer" && qpeer) {
    const self = qpeer.peerId;
    const targets = uniqueParticipants(state.proposal).filter(p => p !== self);
    for (const t of targets) qpeer.send(t, { kind: "rdv-abort", id, reason: "timeout" });
  }
  addMessage("", `· rendezvous ${shortRdvId(id)} expired`, "system");
}

/// Apply a commit on this peer: for each row that names me, remove the locked
/// gives token and register the assigned gets token. Returns false if any
/// expectation is violated (in which case caller should not finalize state).
function applyCommit(state: ProposalState, commitRows: CommitRow[]): boolean {
  const myId = qpeer?.peerId ?? "";
  const myRows = state.proposal.rows.filter(r => r.participant === myId);
  const matched: CommitRow[] = [];
  const remaining = commitRows.filter(c => c.participant === myId);
  for (const myRow of myRows) {
    const idx = remaining.findIndex(c =>
      parseNoteLabel(c.getsToken)?.currency === myRow.gets.currency &&
      noteDenomination(c.getsToken) === myRow.gets.denomination &&
      parseNoteLabel(c.getsToken)?.kind === "note" &&
      validateCapability(c.getsToken));
    if (idx < 0) return false;
    matched.push(remaining[idx]);
    remaining.splice(idx, 1);
  }
  for (const cr of matched) {
    lockedNotes.delete(cr.givesToken);
    const parsed = parseNoteLabel(cr.getsToken);
    if (!parsed) continue;
    noteStore.set(cr.getsToken, {
      token: cr.getsToken,
      currency: parsed.currency,
      denomination: noteDenomination(cr.getsToken),
      receivedFrom: state.proposal.proposerName,
    });
  }
  return true;
}

// ---------------------------------------------------------------------------
// Slash command handler — returns collected output lines for broadcast
// ---------------------------------------------------------------------------

// A minimal modal for collecting secrets (passwords, recovery strings) WITHOUT
// routing them through the chat input — so nothing sensitive lands in the chat
// log, session log, input history, or a room broadcast. Self-contained inline
// styles (no CSS-class dependency); resolves to the field values in order, or
// null if cancelled. Password fields are masked (type=password).
interface SecureField { label: string; type: "password" | "text" | "textarea"; placeholder?: string; value?: string }
/**
 * Ask yes or no without stopping the page.
 *
 * `window.confirm` is synchronous: it blocks every timer, every callback and
 * every render until it is answered, so a dialog that opens behind another
 * window — or on a phone, where it is easy to miss — is indistinguishable from
 * the app having died. It was doing that in front of a deploy, which is the
 * worst place for it: the moment someone is deciding whether to spend phlo.
 */
function confirmDialog(title: string, body: string, okLabel = "OK"): Promise<boolean> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:10000;display:flex;align-items:center;justify-content:center;padding:16px";
    const card = document.createElement("div");
    card.style.cssText = "background:#1b1d23;color:#e8e8ea;border:1px solid #3a3d46;border-radius:10px;max-width:440px;width:100%;padding:18px 18px 14px;box-shadow:0 8px 40px rgba(0,0,0,.5);font:14px/1.5 system-ui,sans-serif";
    const h = document.createElement("div");
    h.textContent = title;
    h.style.cssText = "font-weight:600;font-size:15px;margin-bottom:8px";
    const p = document.createElement("div");
    p.textContent = body;
    p.style.cssText = "font-size:13px;opacity:.85;white-space:pre-wrap;margin-bottom:14px";
    const row = document.createElement("div");
    row.style.cssText = "display:flex;gap:8px;justify-content:flex-end";
    const cancel = document.createElement("button");
    cancel.textContent = "Cancel";
    cancel.style.cssText = "background:#2a2d35;color:#e8e8ea;border:1px solid #3a3d46;border-radius:6px;padding:7px 14px;cursor:pointer";
    const ok = document.createElement("button");
    ok.textContent = okLabel;
    ok.style.cssText = "background:#3b6ef5;color:#fff;border:none;border-radius:6px;padding:7px 14px;cursor:pointer;font-weight:600";
    row.append(cancel, ok);
    card.append(h, p, row);
    overlay.appendChild(card);
    document.body.appendChild(overlay);

    let done = false;
    const close = (answer: boolean): void => {
      if (done) return;
      done = true;
      document.removeEventListener("keydown", onKey, true);
      overlay.remove();
      resolve(answer);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") { e.preventDefault(); close(false); }
      else if (e.key === "Enter") { e.preventDefault(); close(true); }
    };
    document.addEventListener("keydown", onKey, true);
    cancel.addEventListener("click", () => close(false));
    ok.addEventListener("click", () => close(true));
    overlay.addEventListener("click", (e) => { if (e.target === overlay) close(false); });
    setTimeout(() => ok.focus(), 0);
  });
}

function secureDialog(title: string, fields: SecureField[], submitLabel = "OK"): Promise<string[] | null> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:10000;display:flex;align-items:center;justify-content:center;padding:16px";
    const card = document.createElement("div");
    card.style.cssText = "background:#1b1d23;color:#e8e8ea;border:1px solid #3a3d46;border-radius:10px;max-width:440px;width:100%;padding:18px 18px 14px;box-shadow:0 8px 40px rgba(0,0,0,.5);font:14px/1.5 system-ui,sans-serif";
    const h = document.createElement("div");
    h.textContent = title;
    h.style.cssText = "font-weight:600;font-size:15px;margin-bottom:12px";
    card.appendChild(h);

    const inputs: (HTMLInputElement | HTMLTextAreaElement)[] = [];
    for (const f of fields) {
      const lab = document.createElement("label");
      lab.textContent = f.label;
      lab.style.cssText = "display:block;font-size:12px;opacity:.8;margin:8px 0 4px";
      card.appendChild(lab);
      const el = document.createElement(f.type === "textarea" ? "textarea" : "input") as HTMLInputElement | HTMLTextAreaElement;
      if (f.type !== "textarea") (el as HTMLInputElement).type = f.type;
      if (f.placeholder) el.placeholder = f.placeholder;
      if (f.value) el.value = f.value;
      el.style.cssText = "width:100%;box-sizing:border-box;background:#0f1013;color:#e8e8ea;border:1px solid #3a3d46;border-radius:6px;padding:8px 10px;font:13px/1.4 ui-monospace,monospace" + (f.type === "textarea" ? ";min-height:70px;resize:vertical" : "");
      card.appendChild(el);
      inputs.push(el);
    }

    const btnRow = document.createElement("div");
    btnRow.style.cssText = "display:flex;gap:8px;justify-content:flex-end;margin-top:14px";
    const cancelBtn = document.createElement("button");
    cancelBtn.textContent = "Cancel";
    cancelBtn.style.cssText = "background:#2a2d35;color:#e8e8ea;border:1px solid #3a3d46;border-radius:6px;padding:7px 14px;cursor:pointer";
    const okBtn = document.createElement("button");
    okBtn.textContent = submitLabel;
    okBtn.style.cssText = "background:#3b6ef5;color:#fff;border:none;border-radius:6px;padding:7px 14px;cursor:pointer;font-weight:600";
    btnRow.appendChild(cancelBtn);
    btnRow.appendChild(okBtn);
    card.appendChild(btnRow);
    overlay.appendChild(card);
    document.body.appendChild(overlay);
    setTimeout(() => inputs[0]?.focus(), 0);

    let done = false;
    const close = (result: string[] | null) => {
      if (done) return;
      done = true;
      document.removeEventListener("keydown", onKey, true);
      overlay.remove();
      resolve(result);
    };
    const submit = () => close(inputs.map((el) => el.value));
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); close(null); }
      else if (e.key === "Enter" && !(e.target instanceof HTMLTextAreaElement)) { e.preventDefault(); submit(); }
    };
    document.addEventListener("keydown", onKey, true);
    cancelBtn.addEventListener("click", () => close(null));
    okBtn.addEventListener("click", submit);
    overlay.addEventListener("click", (e) => { if (e.target === overlay) close(null); });
  });
}

// ---------------------------------------------------------------------------
// /rholang — the program editor
//
// A rholang program is not a command line: it has newlines, braces and quotes,
// and a chat input takes one line at a time with Enter meaning "send". So
// `/rholang eval` and `/rholang deploy` open an editor — highlighted, linted as
// you type, with somewhere to put the indentation. A program passed inline
// (`/rholang eval return!(42)`) skips it and runs as typed.
// ---------------------------------------------------------------------------

const RHOLANG_HELP = [
  "/rholang — run rholang on rnode, an RChain node.",
  "  /rholang eval          — run a program and read the result back. Nothing is signed,",
  "                           nothing is stored, no block is produced.",
  "  /rholang deploy        — sign a program and submit it. Costs phlo, lands in a block.",
  "  /rholang echo [deploy] — show the program that would be sent, and send nothing.",
  "                           Every program is wrapped before it leaves the browser; this is that.",
  "  /rholang explain [program] — what it will do, where, what it costs; and asks an AI in the room to read it.",
  "  /rholang read [name]   — read what is on a name now; no name means the last deploy's.",
  "                           A deploy waits on consensus, which can take minutes. The value sits",
  "                           on its name until read, so nothing is lost by collecting it later.",
  "  /rholang status        — what rnode is: version, shard, height, phlo floor.",
  "  /rholang powerbox      — the names every program gets, and what each one takes.",
  "  /rholang macros        — the approved capability macro library ($name sites).",
  "  /rholang macro <n> …   — expand one macro on its own, when it is the whole program.",
  "  $name(args)            — run a chain macro straight from the room line: $balance($me),",
  "                           $transfer(10, \"1111…\"), $verify(@x), $( …inline program… ).",
  "",
  "  The locker — your names and your identity record, kept on chain:",
  "  /rholang locker        — where it is · locker <uri> · locker install",
  "  /rholang register      — create your identity record (a REV address anchors it)",
  "  /rholang bind <n> <uri>  — give a capability a name of your own",
  "  /rholang resolve <n>   — what you call that · record — your whole record",
  "  /rholang grant <n>     — a write-only capability for that one name",
  "  Each is its own deploy: your identity exists only inside one.",
  "",
  "  A program's macro call sites expand before it is linted or signed: $name(…)",
  "  from the library above, or from what this room defined with /macro (%name is a",
  "  deprecated alias — $ is illegal in rholang, so a missed expansion fails loud).",
  "  /rholang echo shows the result, which is what answers should-I-sign-this.",
  "",
  "  eval and deploy open an editor: syntax-highlighted, linted as you type,",
  "  Ctrl+Enter to run, Esc to cancel. Insert a .rho from disk at the cursor,",
  "  or drop one in, and save what you have written back out. Inserting rather",
  "  than replacing lets one program be assembled from several files.",
  "  It keeps what you last wrote,",
  "  so you can change one thing and run it again; Clear empties it.",
  "  A program written inline — /rholang eval return!(42) — runs as typed.",
  "  In the message box, Shift+Enter (or a line ending in \\) keeps writing on",
  "  the next line, and a pasted program keeps its lines. Enter sends the lot;",
  "  Esc drops the held lines.",
  "",
  "  Configuration:",
  "  /rholang config               — show all of it",
  "  /rholang rnode <url>          — rnode HTTP API (default: the rholang playground, https://rnodeapi.rhobot.net · the testnet is https://testnet.rhobot.net · a localnet is http://127.0.0.1:40403)",
  "  /rholang shard <id>           — shard the deploy is valid in (default root)",
  "  /rholang phlo <limit> [price] — what a deploy may spend",
  "  /rholang key generate|<hex>|show|forget — the secp256k1 deploy key (this browser only)",
  "",
  "  eval runs in a read-only sandbox over finalized state. Pure rholang and the",
  "  qucalc powerbox both return values there. What it cannot reach is a deploy's",
  "  own identity — rho:rchain:deployId and deployerId are unbound, since an",
  "  exploratory deploy is not a deploy. Those need deploy.",
];

/**
 * Open the editor, then run what it gives back.
 *
 * A program is not one line of chat: it needs room, indentation, and a way to
 * see its own shape. The editor owns the text; this owns lint-and-run.
 */
function editRholang(mode: "eval" | "deploy", seed: string, echoOnly = false, explainOnly = false): void {
  const cfg = loadNodeConfig();
  void (async () => {
    const written = await openRholangEditor({
      mode,
      seed,
      // Deploy's names are the superset, and the editor can end in either mode
      // now, so highlight against them: `deployId`/`deployerId` are marked in
      // scope in a program that is then evaluated, where rnode reports them
      // unbound — which is what /rholang eval's own help says it will.
      scope: ["return", ...powerboxNames("deploy")],
      nodeUrl: cfg.url,
      // Asked live rather than passed in: the editor stays open across a node
      // starting or stopping, and a status from when it opened would be a
      // statement about the past.
      status: async () => {
        try {
          const st = await nodeStatus(loadNodeConfig());
          const mismatch = st.shardId && cfg.shard && st.shardId !== cfg.shard;
          return `rnode ${st.version?.node ?? "?"} · shard ${st.shardId ?? "?"}`
            + `${mismatch ? ` ⚠ you are set to ${cfg.shard}` : ""}`
            + ` · block ${st.latestBlockNumber ?? "?"} · phlo ≥ ${st.minPhloPrice ?? "?"}`;
        } catch {
          return "not answering";
        }
      },
      // Lint what would actually be sent, not the raw buffer: `$macro(…)` and a
      // `… as (a, b) { … }` capture clause are not rholang, so linting the text
      // as typed reports a spurious error on every macro line. Expand (silently)
      // and wrap first; surface an expansion error as the lint error.
      lint: async (raw: string) => {
        // The editor also accepts a macro definition — `define name(x) <body>`
        // (or `/macro define …`) — so a fragment written here can be saved as a
        // `$name(…)` without leaving for the chat box. Lint it as a definition.
        const def = matchDefineBuffer(raw);
        if (def !== null) {
          try { parseDefinition(def); return { ok: true, errors: [] }; }
          catch (e) { return { ok: false, errors: [(e as Error)?.message ?? String(e)] }; }
        }
        // A `$macro(…) as <pat> { …` whose block is still being typed is a
        // continuation, not a broken program — reject so the editor clears the
        // status line (its `.catch` does) rather than flashing an error.
        const peek = expandMacroProgram(resolveClientTokens(raw, () => {}));
        if (peek.incomplete?.length) throw new Error(peek.incomplete[0].message);
        const notes: string[] = [];
        let program: string;
        try {
          const expanded = expandRholangMacros(raw, (t) => { if (t.startsWith("✗")) notes.push(t.replace(/^✗\s*/, "")); });
          if (notes.length) return { ok: false, errors: notes };
          const cfg2 = loadNodeConfig();
          program = mode === "deploy"
            ? wrapProgram(expanded, "deploy", cfg2.resultNonce ?? 1)
            : wrapProgram(expanded, "eval");
        } catch (e) {
          return { ok: false, errors: [(e as Error)?.message ?? String(e)] };
        }
        return lintRholang(program);
      },
      // Per device, not per room: a program is written against an rnode, and the
      // same one is usually run from whichever room you happen to be in.
      draftKey: "qos-rholang-draft",
    });
    if (written === null) { addMessage("", "cancelled — nothing run", "system"); return; }
    // The editor says which button ended it, so the verb that opened it is only
    // a default: a program written to be evaluated can be deployed on the spot.
    const { source, mode: chosen, action } = written;
    // A macro definition typed into the editor registers rather than runs — the
    // body is exactly the rholang you would otherwise deploy, now reusable as a
    // `$name(…)` site.
    const definition = matchDefineBuffer(source);
    if (definition !== null) {
      defineMacro(definition, (t) => addMessage("", t, "system"));
      return;
    }
    // The button explains without asking the room; `/rholang explain` asks. The
    // difference is who decided to publish the program, and it should stay the
    // person rather than the button.
    if (action === "explain" || explainOnly) { explainRholang(chosen, source); return; }
    if (action === "show" || echoOnly) { echoRholang(chosen, source); return; }
    runRholangProgram(chosen, source);
  })();
}

/**
 * Pick files, hash them, keep the bytes, and tell the room what exists.
 *
 * Deliberately not a broadcast of the file: a library entry is a name for
 * something, and the bytes move later, to whoever asks. Adding an entry the
 * room already has is not an error — the hash is the content, so both peers
 * are talking about the same thing, and the second one has simply become
 * another holder of it.
 */
function addFilesToLibrary(dropped?: FileList | File[]): void {
  if (dropped) { void ingestFiles([...dropped]); return; }
  const input = document.createElement("input");
  input.type = "file";
  input.multiple = true;
  input.addEventListener("change", () => { void ingestFiles([...(input.files ?? [])]); });
  input.click();
}

function ingestFiles(files: File[]): Promise<void> {
  return (async () => {
      if (!files.length) return;
      for (const file of files) {
        const hash = await hashBlob(file);
        const kept = await putBytes(hash, file);
        if (!kept) {
          addMessage("", `⚠ could not keep ${file.name} — this browser's storage refused it, so the entry would name bytes nobody has`, "system");
          continue;
        }
        heldFiles.add(hash);
        announceHeld();
        const known = libraryStore.get(hash);
        if (known) {
          saveLibrary();
          renderLibrary();
          addMessage("", `● you are now holding ${known.name} (${shortHash(hash)}) — already in the library`, "system");
          continue;
        }
        const entry: LibraryEntry = {
          hash, name: file.name, mime: file.type || "application/octet-stream",
          size: file.size, addedBy: myPeerId(), addedLabel: myName || shortId(myPeerId()),
          at: Date.now(),
        };
        libraryStore.set(hash, entry);
        saveLibrary();
        signedBroadcast({ kind: "library-entry", entry });
        addMessage("", `● added ${entry.name}  ${fmtFileSize(entry.size)}  ${shortHash(hash)}`, "system");
      }
      renderLibrary();
  })();
}

/**
 * Retract an entry — for everyone if it is yours, from this view otherwise.
 *
 * The same rule the rest of the room's state follows (`/forget`): an owner
 * retracts, anyone else hides. Tombstoned either way, so a peer's next sync
 * does not heal it back.
 */
function forgetLibraryEntry(entry: LibraryEntry): void {
  const mine = entry.addedBy === myPeerId();
  libraryStore.delete(entry.hash);
  retracted.add(`library:${entry.hash}`);
  saveRetracted();
  if (heldFiles.has(entry.hash)) { heldFiles.delete(entry.hash); void dropBytes(entry.hash); }
  saveLibrary();
  renderLibrary();
  if (mine) {
    signedBroadcast({ kind: "retract", what: "library", id: entry.hash });
    addMessage("", `retracted ${entry.name} — removed for everyone`, "system");
  } else {
    addMessage("", `hid ${entry.name} — it is ${entry.addedLabel}'s to retract for the room`, "system");
  }
}

/**
 * The wrapper forwards `return` with a single binder (`for (@__value <- return)`),
 * so a `return!(…)` at the program's top level must send exactly one value.
 * Returns the offending arity (0, or ≥2) of the first bad `return!` — or null if
 * every `return!(…)` sends one value (nested parens / strings respected). A
 * `return!` inside another `for` binding could still legitimately be polyadic,
 * but at the top level it is almost always the mistake it looks like.
 */
function returnArityIssue(source: string): number | null {
  for (const m of source.matchAll(/(?<![A-Za-z0-9_])return\s*!\s*\(/g)) {
    const open = m.index! + m[0].length - 1;
    let depth = 0, commas = 0, i = open, inStr: string | null = null, nonEmpty = false;
    for (; i < source.length; i++) {
      const c = source[i];
      if (inStr) { if (c === "\\") i++; else if (c === inStr) inStr = null; continue; }
      if (c === '"' || c === "`") { inStr = c; nonEmpty = true; continue; }
      if (c === "(" || c === "[" || c === "{") { depth++; continue; }
      if (c === ")" || c === "]" || c === "}") { depth--; if (depth === 0) break; continue; }
      if (c === "," && depth === 1) commas++;
      if (depth === 1 && !/\s/.test(c)) nonEmpty = true;
    }
    if (i >= source.length) continue;            // unbalanced — leave it to the linter
    const arity = nonEmpty ? commas + 1 : 0;
    if (arity !== 1) return arity;
  }
  return null;
}

/**
 * Say what a program will do, before it does it.
 *
 * Not a summary of the rholang — nothing here reads the program's meaning, and
 * a tool that guessed at it would be worse than nothing. It is the account the
 * app can give truthfully: where this goes, what it costs, which of rnode's
 * powers it reaches and what each answers, whether anything comes back, and
 * what a deploy does that an evaluation does not. Show answers "what exactly
 * is sent"; this answers "what will happen if I do".
 */
function explainRholang(mode: "eval" | "deploy", source: string, ask = false): void {
  const cfg = loadNodeConfig();
  const ctx = activeRoom;
  void explainRholangAsync(mode, source, cfg, ask, ctx);
}

/** The question put to an AI that can read the program, in one place. */
const EXPLAIN_ASK = "explain this rholang program and any security concerns, briefly:";

async function explainRholangAsync(mode: "eval" | "deploy", source: string, cfg: NodeConfig, ask: boolean, ctx: RoomContext): Promise<void> {
  // Answers arrive after awaits, so each one says which room it belongs to.
  const line = (t: string): void => { inRoom(ctx, () => addMessage("", t, "system")); };
  const out: string[] = [];
  const say = (l: string) => out.push(l);

  say(mode === "deploy"
    ? `deploy → ${cfg.url}  ·  shard ${cfg.shard}`
    : `evaluate → ${cfg.url}  ·  read-only, over finalized state`);

  if (mode === "deploy") {
    say(`  costs up to ${cfg.phloLimit} phlo at ${cfg.phloPrice} — charged whether or not it succeeds, and it lands in a block`);
    if (cfg.key) {
      say(`  signed with this browser's key, as ${revAddressOf(cfg.key)}`);
      say(`  what the program sends to \`return\` is written to your registry slot at ${registryUriOf(cfg.key)}`);
      say(`     (/rholang read fetches it back; the nonce advances on every write)`);
    } else {
      say("  ⚠ no signing key on this browser — Other ▸ If you use a chain ▸ Make a signing key");
    }
  } else {
    say("  nothing is signed, nothing is stored, no block is made and nothing is charged");
    say("  `deployId` and `deployerId` are unbound here — an exploratory deploy has no identity of its own");
  }

  const used = powerboxUsed(source, mode);
  if (used.length) {
    say(`reaches ${used.length} of rnode's powers:`);
    for (const e of used) {
      say(`  ${e.sig}`);
      if (e.returns) say(`     → ${e.returns}`);
    }
  } else {
    say("reaches none of rnode's powers — it is pure rholang");
  }

  // Call sites expand before anything is linted or signed, so what runs is not
  // quite what is written. Naming them is the cue to press Show.
  const sites = [...source.matchAll(/(?<![A-Za-z0-9_])([%$])([A-Za-z][\w-]*)\s*\(/g)];
  if (sites.length) {
    const names = [...new Set(sites.map((m) => m[1] + m[2]))];
    say(`expands ${sites.length} macro call site${sites.length === 1 ? "" : "s"} before anything is signed: ${names.join(", ")}`);
    say("     Show displays the result — that is what actually runs");
  }

  // A program that never answers `return` is the commonest way to get an empty
  // result and think the node is broken.
  if (!/(\breturn\s*!|\*return\b)/.test(source)) {
    say("⚠ nothing is sent to `return`, so nothing comes back — the run will look empty");
  } else {
    // The wrapper receives it with one binder — `for (@__value <- return)` — so
    // `return!(a, b)` (polyadic) or `return!()` never matches and the run still
    // looks empty. Send one value: `return!((a, b))`.
    const bad = returnArityIssue(source);
    if (bad !== null) {
      say(bad === 0
        ? "⚠ `return!()` sends nothing — the wrapper reads `return` with one binder, so this won't report. Send one value: `return!(x)`"
        : `⚠ \`return!(…)\` sends ${bad} values — the wrapper reads \`return\` with one binder, so this won't report. Wrap them in one tuple: \`return!((…))\``);
    }
  }

  addMessage("", `📖 what this ${mode === "deploy" ? "deploy" : "evaluation"} will do`);
  for (const l of out) line("  " + l);

  // What explaining a program actually wants is somebody who can read it, and
  // that is an AI in the room — not an rnode, which only says whether the thing
  // would run. So the agent comes first and the node is a footnote.
  //
  // Offered rather than sent: asking posts the program to the room, and that is
  // the user's call, not a side effect of pressing a button.
  const advisor = [...peers].find((p) => peerAgents.has(p));
  const oneLine = source.replace(/\s+/g, " ").trim().slice(0, 400);
  if (advisor && ask) {
    // Typing the command IS the consent: the program goes to the room, where
    // the agent reads it and answers where everyone can see the answer.
    const cmd = peerAgents.get(advisor) === "facilitator" ? "facil" : peerAgents.get(advisor);
    qpeer?.broadcast({ kind: "chat", text: `/${cmd} ask ${EXPLAIN_ASK} ${oneLine}` });
    line(`  🤖 asked ${peerLabel(advisor)} to read it — the program went to the room with the question`);
  } else if (advisor) {
    line(`  🤖 ${peerLabel(advisor)} can read the program itself — press Enter to ask `
      + "(it posts the program to the room)");
    msgInput.value = `/rholang explain ${oneLine}`;
    msgInput.focus();
  } else {
    line("  🤖 no AI is in the room to read the program itself — an agent with --ai answers "
      + "“what does this do, and what should worry me”, which nothing here can");
  }

  // And whether the node it names is even there — a footnote, because it is
  // about running rather than understanding, and Explain is useful with no
  // rnode at all.
  try {
    const st = await nodeStatus(cfg);
    line(`  · ${cfg.url} answers — rnode ${st.version?.node ?? "?"}, shard ${st.shardId ?? "?"}, block ${st.latestBlockNumber ?? "?"}`);
    if (st.shardId && cfg.shard && st.shardId !== cfg.shard) {
      line(`  ⚠ it is shard ${st.shardId} and you are set to ${cfg.shard} — a deploy for the wrong shard is rejected (/rholang shard ${st.shardId})`);
    }
  } catch {
    line(`  · ${cfg.url} does not answer, so nothing would run yet`
      + (cfg.url === DEFAULT_NODE_CONFIG.url
        ? " — bash scripts/localnet/run-node.sh starts the one in this repo"
        : `, and neither would ${DEFAULT_NODE_CONFIG.url}`));
  }

  line("  nothing has been run — Show for what would be sent, or run it from the editor");
}

/**
 * Print the program as it would be sent, without sending it.
 *
 * The deploy form is shown with a placeholder result name: a real deploy mints a
 * fresh one per submission, so the name here shows the shape of the forwarder
 * rather than the name any particular deploy will use.
 */
/**
 * Expand a rholang program's macro call sites — both libraries, in one pass
 * each, before anything is linted, echoed or signed.
 *
 *   `%name(…)`  the approved capability library that ships with the app
 *               (rholang-macros.js): typed templates, arguments structurally
 *               validated, one source shared with the room agent.
 *   `$name(…)`  what this room wrote for itself (macro-lang.js).
 *
 * Built-ins expand first, so a room macro may be written in terms of one.
 *
 * Errors never abort: a site that fails is left exactly as written. A leftover
 * `$` is a hard error at rnode, `$` being illegal rholang; a leftover `%` is
 * rholang's modulo operator and will not be, which is why the report matters
 * more for that half.
 */
/**
 * `$me` — a client-side token, resolved to this browser's own REV address (a
 * quoted rholang string) before the program reaches rnode. Write it bare:
 * `$balance($me)`, `$transfer(10, $me)`. Not a macro call site (no parens); it
 * only exists here, where the deploy key is known. Run before any macro pass
 * (in `expandRholangMacros` and in `runDollarLine`'s eval/deploy peek).
 */
function resolveClientTokens(source: string, say: (t: string) => void): string {
  if (!/\$me\b/.test(source)) return source;
  const key = loadNodeConfig().key;
  if (!key) { say("✗ $me needs a deploy key — /rholang key generate, or /rholang key <hex>"); return source; }
  try {
    const addr = revAddressOf(key);
    say(`  · $me → ${addr}`);
    return source.replace(/\$me\b/g, JSON.stringify(addr));
  } catch {
    say("✗ $me: the stored key is not a valid secp256k1 key");
    return source;
  }
}

function expandRholangMacros(source: string, say: (t: string) => void): string {
  let out = resolveClientTokens(source, say);
  if (out.includes("%") || out.includes("$")) {
    const p = expandMacroProgram(out);      // built-in library — `$name(` and legacy `%name(`
    for (const err of p.errors) say(`✗ line ${err.line}: ${err.message}`);
    for (const inc of p.incomplete ?? []) say(`✗ line ${inc.line}: ${inc.message} (add the closing \`}\`)`);
    if (p.expansions.length) {
      const names = [...new Set(p.expansions.map((e) => e.name))].map((n) => "$" + n).join(", ");
      say(`  · expanded ${p.expansions.length} built-in site${p.expansions.length === 1 ? "" : "s"}: ${names}`);
    }
    out = p.source;
  }
  if (out.includes("$")) {
    const x = expandCallSites(out, macroLookup);
    for (const err of x.errors) say(`✗ line ${err.line}: ${err.message}`);
    if (x.expansions.length) {
      const names = [...new Set(x.expansions.map((e) => e.name))].map((n) => "$" + n).join(", ");
      say(`  · expanded ${x.expansions.length} room site${x.expansions.length === 1 ? "" : "s"}: ${names}`);
    }
    out = x.source;
  }
  return out;
}

function echoRholang(mode: "eval" | "deploy", body: string): void {
  const say = (t: string) => addMessage("", t, "system");
  if (!body.trim()) { say("nothing to echo"); return; }
  body = expandRholangMacros(body, say);
  const program = mode === "deploy"
    ? wrapProgram(body, "deploy", loadNodeConfig().resultNonce ?? 1)
    : wrapProgram(body, "eval");
  say(`this is what \`/rholang ${mode}\` would send — nothing has run:`);
  say("```\n" + program + "\n```");
}

/** Lint, then evaluate or sign-and-deploy. */
function runRholangProgram(mode: "eval" | "deploy", source: string): void {
  const say = (t: string) => addMessage("", t, "system");
  if (!source.trim()) { say("nothing typed — cancelled"); return; }
  // Expand before echoing: what is shown has to be what is signed.
  source = expandRholangMacros(source, say);
  // Echo the program as one fenced block, not a row per line. A row per line
  // put the system gutter's "·" in front of every line of the copy, and ran
  // each line through the markdown renderer, whose `*…*` emphasis rule eats
  // rholang's `*` dereference on any line holding two of them. What is echoed
  // has to be what you can paste back and run.
  say("```\n" + source + "\n```");

  // The wrapper receives `return` with one binder, so `return!(a, b)` /
  // `return!()` reduces to nothing and the run looks empty. Warn, don't block —
  // it is legal rholang, just not what this pipeline can report.
  const arity = returnArityIssue(source);
  if (arity !== null) {
    say(arity === 0
      ? "⚠ `return!()` sends nothing — send one value (`return!(x)`) or the result will be empty"
      : `⚠ \`return!(…)\` sends ${arity} values — wrap them in one tuple (\`return!((…))\`) or the result will be empty`);
  }

  const cfg = loadNodeConfig();
  // An https page cannot fetch plain http — except to loopback, which browsers
  // treat as trustworthy, so http://127.0.0.1 and http://localhost are allowed
  // and must not be refused here. What is genuinely blocked is http to any
  // other host, which is worth saying before the signing rather than letting it
  // arrive as a bare network error afterwards.
  if (location.protocol === "https:" && isBlockedMixedContent(cfg.url)) {
    say(`✗ this page is https and ${cfg.url} is plain http to another host — the browser blocks that before the request is made`);
    say("  a node on this machine is reachable at http://127.0.0.1:40403 (loopback is exempt),");
    say("  otherwise point at one served over https:  /rholang rnode https://…");
    return;
  }
  void (async () => {
    // Never ask anyone to sign what cannot parse. The linter checks the shape of
    // the program, not what it is permitted to reach — that is rnode's call.
    const lint = await lintRholang(source);
    if (!lint.ok) {
      say("✗ malformed rholang — not running:");
      for (const e of lint.errors) say("  • " + e);
      return;
    }

    if (mode === "eval") {
      say("evaluating on " + cfg.url + "…");
      try {
        const r = await evalTerm(cfg, source);
        if (r.values.length) for (const v of r.values) say("  → " + v);
        else say("  → (no value — a term reports by sending on a name called `return`)");
        // Order is rnode's, not the program's, and a reader will assume
        // otherwise the moment there is more than one line to read.
        if (r.values.length > 1) {
          say("  (several sends to `return` — they come back in no dependable order)");
        }
        if (r.blockNumber !== undefined) say("  read against block " + r.blockNumber);
      } catch (e) {
        const msg = String((e as Error)?.message ?? e);
        say("✗ " + msg);
        // rnode's own wording. A validator refuses explore-deploy outright —
        // only a read-only observer or --dev-mode node answers it (see the
        // header of rholang.ts) — so on such a node `eval` can never work and
        // the only way to run anything is a signed deploy from a funded key.
        if (/read-only/i.test(msg)) {
          say("  this rnode is a validator, not a read-only observer, so it refuses every `eval`.");
          say("  use `/rholang deploy` instead — it needs a REV-funded key (`/rholang key <hex>`) and costs phlo,");
          say("  or point `eval` at an observer / --dev-mode node with `/rholang rnode <url>`.");
        }
      }
      return;
    }

    if (!cfg.key) { say("✗ no deploy key — /rholang key generate, or /rholang key <hex>"); return; }
    const okToDeploy = await confirmDialog("Sign and deploy?",
      `to ${cfg.url}\nphlo limit ${cfg.phloLimit} × price ${cfg.phloPrice}, shard ${cfg.shard}`,
      "Sign and deploy");
    if (!okToDeploy) { say("cancelled — nothing deployed"); return; }
    say("signing and deploying to " + cfg.url + "…");
    try {
      const r = await deployTerm(cfg, source);
      say((r.ok ? "✓ " : "✗ ") + r.message);
      if (r.ok && r.resultNonce !== undefined) {
        // The deploy is accepted here; everything after is waiting for consensus,
        // which is not ours to hurry. Block creation can lag minutes — an hour is
        // not unheard of — so a short poll that gives up and says "nothing yet"
        // reports a normal wait as if it were a failure.
        //
        // So: name the result, take one brief look in case the block is quick,
        // and otherwise say plainly that waiting is expected and how to collect
        // it whenever. The value sits on the name until something reads it —
        // measured: readable immediately, at +90s and at +210s — so there is no
        // window to miss and nothing is lost by not watching.
        lastDeploySig = r.sig ?? "";
        lastDeployNonce = r.resultNonce ?? null;
        say("  it will answer at your record once a block carries it — /rholang read");
        const fresh = await readResultsFresh(cfg, r.resultNonce, 6);
        if (fresh != null) { say("  → " + fresh); }
        else {
          // An empty name means one of two things that look identical from here:
          // still waiting on consensus, or landed in a block and errored (a failed
          // deploy sends nothing to `return`, so its name stays empty forever).
          // The block knows which; ask it rather than leave you watching a name
          // that will never fill.
          const fate = r.sig ? await deployFate(cfg, r.sig).catch(() => null) : null;
          if (fate?.errored) {
            say(`  ✗ it ran in block ${fate.blockNumber} and errored (cost ${fate.cost ?? "?"}) — nothing was sent to return`);
            // The node records the reducer's first error against the deploy
            // (rholo#15). Older nodes leave it empty, so say so rather
            // than printing a blank line where the reason should be.
            if (fate.systemDeployError) say(`     ${fate.systemDeployError}`);
            else say(`     no reason recorded — this node predates rholo#15`);
          } else if (fate) {
            // The registry result slot is not written on every node — a
            // ProcessedWithSuccess deploy left it empty on the rebuilt
            // playground, so a program that ran perfectly reported nothing. A
            // program that also sends to `rho:rchain:deployId` (locker.js and
            // rgov-core.js both do) carries its answer inside the deploy's own
            // status, which is not subject to that. Ask there before reporting
            // silence, and only then say it has not reported.
            const direct = r.sig ? await deployAnswer(cfg, r.sig, 2).catch(() => null) : null;
            if (direct?.length) for (const v of direct) say("  → " + v);
            else say(`  it ran in block ${fate.blockNumber} but has not reported — /rholang read collects it whenever`);
          } else {
            say(`  not in a block yet — normal, this can take minutes. /rholang read collects it whenever; it waits on the name.`);
          }
        }
      }
    } catch (e) {
      say("✗ " + ((e as Error)?.message ?? e));
    }
  })();
}

/**
 * The name the last deploy will report on, so `/rholang read` can be typed with
 * no argument. A deploy's value sits on its name until something consumes it, so
 * "later" is any time at all — this just saves retyping a random-suffixed name.
 */

/** The last deploy's signature, so `/rholang read` can tell "still waiting" from "errored". */
let lastDeploySig = "";
/** The nonce that deploy wrote to, so `/rholang read` can tell a fresh answer from a stale one. */
let lastDeployNonce: number | null = null;

// ---------------------------------------------------------------------------
// Macro runtime — defining, retracting and running a `+command`
// ---------------------------------------------------------------------------

/** Is this macro mine to redefine or retract for everyone? Anchor first: a
 *  reload changes the peerId but not the identity behind it. */
/**
 * A macro definition off the wire, validated the way a lemma is: nothing is
 * trusted about it beyond the shape, and the body is re-read for its kind
 * rather than believed. Returns null if it is not a definition.
 */
function macroFromWire(d: Record<string, unknown>, from: string): MacroDef | null {
  const name = String(d.name ?? "").toLowerCase();
  if (!MACRO_NAME_RE.test(name)) return null;
  const body = String(d.body ?? "");
  if (!body.trim() || body.length > MAX_BODY) return null;
  const params = Array.isArray(d.params) ? d.params.map(String) : [];
  if (params.some((x) => !MACRO_NAME_RE.test(x))) return null;
  // The body decides the kind — never the sender's claim — so every peer
  // derives the same one for the same definition.
  return {
    name, params, body,
    doc: String(d.doc ?? "").slice(0, 200),
    kind: bodyKind(body),
    author: from,
    authorLabel: String(d.authorLabel ?? peerLabel(from)),
    at: typeof d.at === "number" ? d.at : Date.now(),
    anchor: (d.dyncap && typeof d.dyncap === "object")
      ? String((d.dyncap as DyncapField).anchor || "") || undefined
      : undefined,
  };
}

/** How a macro is called: `+name <arg>` for a command, `$name($arg)` for rholang / text. */
function macroCallForm(def: MacroDef): string {
  return def.kind === "command"
    ? `+${def.name}${def.params.map((x) => ` <${x}>`).join("")}`
    : `$${def.name}${def.params.length ? `(${def.params.map((x) => "$" + x).join(", ")})` : ""}`;
}

/** Is this macro mine to redefine or retract for everyone? Anchor first: a
 *  reload changes the peerId but not the identity behind it. */
function isMyMacro(def: MacroDef): boolean {
  const mine = dyncapState?.anchor;
  if (def.anchor && mine) return def.anchor === mine;
  return def.author === myPeerId();
}

/**
 * Define (or redefine) a macro and tell the room.
 *
 * First writer wins the name, and only that author may replace the definition —
 * the same author check the lemma retract and the note series use. That is
 * EIES's rule too: the owner of the file could edit it, and nobody else could.
 */
/**
 * A `/rholang` editor buffer that is actually a macro definition — `define
 * name(x) …` or `/macro define name(x) …`. Returns the definition text (what
 * `defineMacro` / `parseDefinition` want), or null if it is an ordinary program.
 */
function matchDefineBuffer(source: string): string | null {
  // `define` then something name-shaped — so a rholang program is not mistaken
  // for one (a bare `define` is not a rholang keyword anyway).
  const m = /^\s*(?:\/macro\s+)?define\s+([$+]?[A-Za-z][\s\S]*)$/.exec(source ?? "");
  return m ? m[1].trim() : null;
}

function defineMacro(text: string, say: (t: string) => void): void {
  let parsed;
  try { parsed = parseDefinition(text); }
  catch (e) { say(`· ${e instanceof MacroError ? e.message : String(e)}`); return; }

  const existing = macroStore.get(parsed.name);
  if (existing && !isMyMacro(existing)) {
    say(`· ${parsed.name} is defined by ${existing.authorLabel} — pick another name, or /forget macro ${parsed.name} to hide theirs`);
    return;
  }
  // Defining a name I previously retracted is me changing my mind about it.
  if (macroTombstones.delete(parsed.name)) {
    try { localStorage.setItem("qos-macro-tombstones", JSON.stringify([...macroTombstones])); } catch { /* */ }
  }

  const def: MacroDef = {
    ...parsed,
    author: myPeerId(),
    authorLabel: myName || myPeerId().slice(0, 8),
    at: Date.now(),
    anchor: dyncapState?.anchor,
  };
  macroStore.set(def.name, def);
  saveMacros();
  renderMacros();
  signedBroadcast({
    kind: "macro-define",
    name: def.name, params: def.params, body: def.body, doc: def.doc,
    macroKind: def.kind, authorLabel: def.authorLabel, at: def.at,
  });
  say(`${existing ? "redefined" : "defined"} ${macroCallForm(def)}${def.doc ? `  — ${def.doc}` : ""}`);
  if (def.kind === "rholang") say(`  rholang fragment — use it as a $${def.name}(…) site inside /rholang eval or deploy`);
  else if (def.kind === "text") say(`  text macro — $${def.name}${def.params.length ? "(…)" : ""} substitutes its body; nothing runs`);
}

/** Retract a macro — for everyone if it is mine, from my view otherwise. */
function forgetMacro(name: string): void {
  const key = String(name).toLowerCase();
  const def = macroStore.get(key);
  if (!def) { addMessage("", `no macro $${key}`, "system"); return; }
  const mine = isMyMacro(def);
  tombstoneMacro(key);
  macroStore.delete(key);
  saveMacros();
  renderMacros();
  if (mine) signedBroadcast({ kind: "retract", what: "macro", id: key });
  addMessage("", `  · $${key} ${mine ? "retracted" : "hidden from your view"}`, "system");
}

// A `+command` body may invoke another `+command`; expansion is bounded inside
// macro-lang, but a body that calls a body is runtime recursion and needs its
// own bound. Kept small deliberately: nesting this deep is a mistake, not a
// design.
const MACRO_RUN_DEPTH = 8;
let macroDepth = 0;

/**
 * Run `+name args`. Returns the lines it printed, so /script and a body can
 * carry it the way they carry a slash command.
 */
function runMacroLine(line: string): string[] {
  const out: string[] = [];
  const say = (t: string) => { addMessage("", t, "system"); out.push(t); };
  let call;
  try { call = parseInvocation(line); }
  catch (e) { say(`· ${e instanceof MacroError ? e.message : String(e)}`); return out; }

  const def = macroStore.get(call.name);
  if (!def) {
    say(`no +${call.name} command in this room — /macro list, or /macro define ${call.name}(…) <body> to write it`);
    return out;
  }
  if (def.kind !== "command") {
    say(def.kind === "text"
      ? `· $${def.name} is a text macro, not a command — use it as $${def.name}${def.params.length ? "(…)" : ""} (it substitutes its body)`
      : `· $${def.name} is rholang, not a command — use it as $${def.name}(…) inside /rholang eval`);
    return out;
  }
  if (macroDepth >= MACRO_RUN_DEPTH) {
    say(`· +${def.name}: commands nest more than ${MACRO_RUN_DEPTH} deep — stopping`);
    return out;
  }

  let expansion;
  try { expansion = expandCommand(def, call.args, macroLookup); }
  catch (e) { say(`· ${e instanceof MacroError ? e.message : String(e)}`); return out; }
  for (const err of expansion.errors) say(`· ${err.message}`);
  if (expansion.commands.length === 0) { say(`· +${def.name} expanded to nothing`); return out; }

  macroDepth++;
  let ran = 0;
  try {
    for (const cmd of expansion.commands) {
      if (cmd.trim().startsWith("//")) continue;
      try { runInput(cmd); ran++; }
      catch (e) { say(`· +${def.name} error on '${cmd.split("\n")[0]}': ${String(e)}`); }
    }
  } finally { macroDepth--; }
  say(`· +${def.name}: ${ran} command${ran === 1 ? "" : "s"}`);
  return out;
}

/** Route one line of input: `+name` runs a command macro, `$name(…)` runs a
 *  chain macro, anything else is a slash command. */
function runInput(text: string): string[] {
  const t = text.trim();
  if (t.startsWith("+")) return runMacroLine(t);
  if (t.startsWith("$")) return runDollarLine(t);
  return handleCommand(t.startsWith("/") ? t : "/" + t);
}

/**
 * A `$name(…)` line runs a chain macro. `$` is the room's macro sigil (illegal
 * in rholang, so a missed expansion is a hard error at rnode, never silent).
 *
 *   $verify(@x)                 — a local read, answered here
 *   $balance($me)              — a chain read, unsigned `/rholang eval` ($me = your address)
 *   $transfer(10, "1111…")     — a write, `/rholang deploy` (signs, opens the editor)
 *   $( new x in { $anchor(@d, "^v", "note") } )   — a full inline program
 *
 * Built-in macros are `rholang-macros.js`; a `$name` the library doesn't know
 * falls through to this room's `/macro`-defined ones.
 */
/**
 * Expand a room `$macro` call and show the result — without running it. A room
 * macro's intent is unknown (it can be plain substitution text or a rholang
 * fragment), so a `$name` line reports what it expands to and how to run it,
 * rather than silently deploying.
 */
function showRoomMacro(call: string, say: (t: string) => void, out: string[]): string[] {
  const x = expandCallSites(call, macroLookup);
  for (const err of x.errors) say(`✗ ${err.message}`);
  if (x.errors.length) return out;
  say("```\n" + x.source.trim() + "\n```");
  const def = macroLookup(call.replace(/^\$/, "").split("(")[0]);
  if (def?.kind === "rholang") {
    say(`  run it:  /rholang eval ${call}   ·   /rholang deploy ${call}`);
  } else {
    say(`  (${call.split("(")[0]} is a text macro — use it inside a command, a /rholang program, or paste it)`);
  }
  return out;
}

function runDollarLine(line: string): string[] {
  const out: string[] = [];
  const say = (t: string) => { addMessage("", t, "system"); out.push(t); };

  let body = line.trim();
  const wrapped = /^\$\s*\(([\s\S]*)\)\s*$/.exec(body);
  if (wrapped) body = wrapped[1].trim();

  // A single `$name(args)` call — the common case.
  const single = wrapped ? null : /^\$([A-Za-z][\w-]*)\s*\(([\s\S]*)\)\s*$/.exec(body);
  if (single) {
    const name = single[1].toLowerCase();
    let argStr = single[2].trim();
    const mode = macroMode(name);

    if (mode === null && !macroStore.get(name)) {
      say(`✗ no $${name} — \`/rholang macros\` lists the built-ins, \`/macro list\` this room's`);
      return out;
    }

    // A local read (verify / zfa): answer it here, no node.
    if (mode === "read-local") {
      const bareArgs = argStr.replace(/^["']|["']$/g, "").replace(/["']?\s*,\s*["']?/g, " ");
      try {
        const x = expandBareMacro(`/rholang macro ${name} ${bareArgs}`);
        if (x.kind === "result") { say(x.text); return out; }
      } catch (e) { say(`✗ ${(e as Error)?.message ?? e}`); return out; }
    }

    // `$balance(me)` — `rho:rchain:deployerId` is unbound in an exploratory
    // deploy, so resolve `me` to this browser's own REV address first.
    if (name === "balance" && /^["']?me["']?$/i.test(argStr)) {
      const key = loadNodeConfig().key;
      if (!key) { say("✗ $balance(me): no deploy key yet — `/rholang key generate`, or pass a REV address"); return out; }
      try { argStr = JSON.stringify(revAddressOf(key)); }
      catch { say("✗ $balance(me): the stored key is not a valid secp256k1 key"); return out; }
      body = `$balance(${argStr})`;
    }

    if (mode === "eval")   { runRholangProgram("eval", body); return out; }
    if (mode === "deploy") { runRholangProgram("deploy", body); return out; }
    // A room `$macro` — expand and show it. It may be plain text or a rholang
    // fragment; either way, *running* it is a separate, explicit step so a
    // stray `$x` in chat never signs a deploy.
    if (macroStore.get(name)) { return showRoomMacro(`$${name}(${single[2]})`, say, out); }
  }

  // A bare `$name` (no parens) that names a room macro — same: expand and show.
  const bare = /^\$([A-Za-z][\w-]*)\s*$/.exec(line.trim());
  if (bare && !macroMode(bare[1].toLowerCase()) && macroStore.get(bare[1].toLowerCase())) {
    return showRoomMacro(`$${bare[1].toLowerCase()}`, say, out);
  }

  // A `$( … )` inline program, or a line with several sites (or an `as … { }`
  // capture): expand once to see whether any site is a write, then run — eval
  // if every site is a read. Resolve `$me` first (silently — the real run
  // reports it) so the scanner does not read it as an unknown room macro.
  let writes = false, sites = 0;
  try {
    const p = expandMacroProgram(resolveClientTokens(body, () => {}));
    for (const err of p.errors) { say(`✗ line ${err.line}: ${err.message}`); }
    for (const inc of p.incomplete ?? []) { say(`✗ line ${inc.line}: ${inc.message} (add the closing \`}\`)`); }
    if (p.errors.length || (p.incomplete?.length ?? 0)) return out;
    for (const e of p.expansions) { sites++; if (e.write) writes = true; }
    const u = expandCallSites(p.source, macroLookup);
    for (const err of u.errors) { say(`✗ line ${err.line}: ${err.message}`); }
    if (u.errors.length) return out;
    for (const _ of u.expansions) { sites++; writes = true; }  // room fragments: treat as a write (confirmed)
  } catch (e) { say(`✗ ${(e as Error)?.message ?? e}`); return out; }
  if (sites === 0) { say(`✗ no macro call site in \`${line.trim()}\``); return out; }

  runRholangProgram(writes ? "deploy" : "eval", body);
  return out;
}

/**
 * In the `/help` list, make the leading `/command` a link to its own detail.
 * Rendered as a `[/cmd](help:cmd)` markdown link; the click handler on #messages
 * runs `/help cmd`. Only commands with a `CMD_HELP` entry are linked — the rest
 * have no detail page to open.
 */
function linkifyHelp(line: string): string {
  return line.replace(/^(\s*)(\/[a-z][a-z-]*)/i, (m, sp: string, tok: string) => {
    const key = tok.slice(1).toLowerCase();
    return CMD_HELP[key] ? `${sp}[${tok}](help:${key})` : m;
  });
}

function handleCommand(raw: string): string[] {
  const body = raw.slice(1).trim();
  const parts = body.split(/\s+/);
  const cmd = parts[0].toLowerCase();
  // A single-line argument is normalised the way it always was — whitespace
  // collapsed to single spaces. A multi-line one keeps its lines: joining them
  // would put a rholang `//` comment and the rest of the program on one line,
  // commenting out everything after it.
  const arg = body.includes("\n")
    ? body.slice(cmd.length).replace(/^[^\S\n]+/, "")
    : parts.slice(1).join(" ");
  const lines: string[] = [];
  const sys = (text: string) => { addMessage("", text, "system"); lines.push(text); };

  switch (cmd) {
    case "help": {
      const topic = arg.trim().replace(/^\//, "").toLowerCase();
      if (topic) {
        const detail = CMD_HELP[topic];
        if (detail) { sys(`/${topic}:`); for (const l of detail) sys("  " + l); }
        else sys(`no help for '/${topic}' — type /help for the full list`);
        break;
      }
      sys("QLF slash commands:  (click a command, or type /help <command>, for details)");
      for (const l of [
        "  /help            — show this help",
        "  /id              — your peer ID and ZFA proof",
        "  /name [your name] — set the display name peers see (blank shows it)",
        "  /password [show] — password-protect your identity (+ publish to your groups)",
        "  /login [handle]  — restore a former identity (from a group, or a recovery string)",
        "  /cap [label]     — generate a new ZFA capability",
        "  /grant [label]   — generate and share a ZFA capability token",
        "  /zfa [token]     — validate a capability token",
        "  /braket <state>  — evaluate bra-ket (states: 0 1 + - i -i)",
        "  /qucalc [twists] — evaluate RhoQuCalc twist sequence",
        "  /conj <twists>   — Hermitian adjoint (reverse + parity-flip); flags self-adjoint",
        "  /freq [n|twists] — ZFA frequency spectrum; C(2n,n) arrangements at level n",
        "  /qlf-action <tw> — propose a history string for the room to verify",
        "  /zfa-check <tw>  — verify ZFA closure locally (count-balanced ∧ pauli-closed)",
        "  /coupling [tw …] — was the room's closure shared, or several side by side?",
        "  /search [pos]    — the admissible next closures from a QuCalc position (computed locally)",
        "  /solve [pos]     — pick the one closure the substrate takes (least free action); residual if none",
        "  /estimate [sub]  — group numeric estimate: new <q> · <number> · status · close (median)",
        "  /dump            — summary of all logic shared this session",
        "  /lemma           — list named lemmas",
        "  /lemma <claim>   — register a claim; mark the handle: /lemma All men are @mortal  →  @mortal",
        "  /lemma <c> | <tw> — with explicit twists (else auto-allocated from the handle)",
        "  /request <n>     — request @n from whoever holds it",
        "  /pass <n> <peer> — transfer @n directly to a named peer",
        "  /note [sub]      — promissory notes (declare|grant [| terms]|pass|redeem|terms|accept|split|merge|balance)",
        "  /rdv [sub]       — n-party atomic rendezvous (swap|accept|reject|abort|list)",
        "  /poll [sub]      — group vote: new <q> [| seeds] [ranked] · add <opt> · vote · status · lock · close · remove · list",
        "  /forget <sub>    — remove an item: poll <id> · lemma <name> · note <token|cur denom> · group <name> · list",
        "  /gov <sub>       — liquid-democracy groups: new · member · issue · delegate · trust · censure · vote · treasury · kudos · uri · say · status",
        "  /dyncap [sub]    — hash-only dynamic capabilities (status|peers)",
        "  /probe [sub]     — discrepancy probe window state (status|clear)",
        "  /room [sub]      — multi-room tabs (list|join <cap>|leave|ref)",
        "  /share <sel> to <room>  — bridge a lemma/chat/note into another tab",
        "  /channel [sub]   — tagged messages (listen|unlisten|send <name> <text>|list)",
        "  /render          — animate this room (perspectives, closures, groups)",
        "  /script <c1>;…   — sequential command chain (// to skip a segment)",
        "  /persist [sub]   — agreed-replication of public state (@lemma|currency …)",
        "  /rholang locker  — your names and identity on chain: locker · register · bind · resolve · record · grant",
        "  /macro [sub]     — write a +command: define · list · show · find · echo (a body of / commands, or of rholang)",
        "  +name <args>     — run a command somebody here defined (++text to send a literal + line)",
        "  /rhoqu <src>     — RhoQu macro: process/new/parallel/call → /commands",
        "  /rholang <sub>   — run rholang on rnode: eval · deploy · echo · read · status · config (multi-line, end with a blank line)",
        "  @name in args    — expand named lemma (e.g. /qucalc @major @minor)",
        "  [multi word]      — a spaced name: /lemma [all men are mortal]  ·  cite as @[all men are mortal]",
        "  //message        — send a message starting with /",
      ]) sys(linkifyHelp(l));
      break;
    }

    case "id": {
      if (!qpeer) { sys("not connected"); break; }
      const id = qpeer.peerId;
      const tw = tokenTwists(id);
      if (tw) {
        const { pos, neg, gap, balanced } = twistStats(tw);
        sys(`peer ID: ${id}`);
        sys(`  twists: ${tw.length}  (${pos} positive, ${neg} negative)`);
        sys(`  ZFA-balanced: ${balanced ? "✓" : "✗"}  spectral gap: ${gap}`);
        sys(`  rho_process_always_zfa: ✓ (Lean-verified)`);
      } else {
        sys(`peer ID: ${id}`);
      }
      break;
    }

    case "name": {
      // Set (or show) your display name — the label peers see in chat and the
      // roster. Mirrors the name input field: persist + re-render + broadcast the
      // signed `name` envelope so peers relabel you. Agents advertise this command.
      const newName = arg.trim();
      if (!newName) { sys(myName ? `your name is "${myName}"  (change it: /name <new name>)` : "you have no name yet — set one: /name <your name>"); break; }
      myName = newName;
      myNameEl.value = myName;
      localStorage.setItem("qos-name", myName);
      renderPeers();
      if (qpeer) signedBroadcast({ kind: "name", name: myName });
      sys(`✓ name set to "${myName}"`);
      break;
    }

    case "cap": {
      const label = arg || "cap";
      const token = generateCapability(label);
      const tw = tokenTwists(token)!;
      const { pos, neg } = twistStats(tw);
      sys(`generated: ${token}`);
      sys(`  twists: ${tw.length}  (${pos} pos, ${neg} neg)  ZFA-balanced: ✓`);
      break;
    }

    case "grant": {
      const label = arg || "cap";
      const token = generateCapability(label);
      const tw = tokenTwists(token)!;
      const { pos, neg } = twistStats(tw);
      const grantWho = myName || (qpeer ? shortId(qpeer.peerId) : "local");
      lemmaStore.set(label, { twists: token, who: grantWho, cap: token });
      saveLemmas();
      renderLemmas();
      sys(`granted: ${token}`);
      sys(`  twists: ${tw.length}  (${pos} pos, ${neg} neg)  ZFA-balanced: ✓`);
      sys(`  registered as @${label} — use /pass ${label} <peer> to transfer`);
      if (qpeer) qpeer.broadcast({ kind: "cap-grant", token, label });
      break;
    }

    case "poll": {
      const sub = (parts[1] ?? "").toLowerCase();
      if (!sub || sub === "list") {
        if (pollStore.size === 0) {
          sys("no polls yet");
          sys("  /poll new <question> [| seed1, seed2] [ranked]   — then /poll add <option> to collect ideas");
        } else {
          sys(`polls (${pollStore.size}):`);
          for (const p of [...pollStore.values()].sort((a, b) => b.createdAt - a.createdAt)) {
            sys(`  ${p.status === "open" ? "●" : "✓"} ${p.id}  "${p.question}"  [${p.method}]  ${p.options.length} options · ${Object.keys(p.ballots).length} ballots`);
          }
        }
        break;
      }
      if (sub === "new") {
        let rest = parts.slice(2).join(" ");
        let method: PollMethod = "approval";
        if (/\s(ranked|irv)\s*$/i.test(" " + rest)) { method = "ranked"; rest = rest.replace(/\s*(ranked|irv)\s*$/i, "").trim(); }
        else if (/\sapproval\s*$/i.test(" " + rest)) { rest = rest.replace(/\s*approval\s*$/i, "").trim(); }
        const bar = rest.indexOf("|");
        const question = (bar < 0 ? rest : rest.slice(0, bar)).trim();
        const options = bar < 0 ? [] : rest.slice(bar + 1).split(",").map((s) => s.trim()).filter(Boolean);
        if (!question) { sys("a poll needs a question: /poll new <question> [| seed options] [ranked]"); break; }
        createPoll(question, options, method);
        sys(`poll created: "${question}" [${method}]${options.length ? ` — ${options.length} seed options` : " — open for nominations (use /poll add … or the card's add box)"}`);
        break;
      }
      if (sub === "add") {
        const a = parts.slice(2);
        let id: string | undefined; let text: string;
        if (a[0] && pollStore.has(a[0])) { id = a[0]; text = a.slice(1).join(" "); }
        else { text = a.join(" "); }
        const poll = findPoll(id);
        if (!poll) { sys("no open poll — start one with /poll new …"); break; }
        if (!text.trim()) { sys("usage: /poll add <option text>"); break; }
        addOption(poll, text);
        sys(`added option "${text.trim()}" to "${poll.question}"`);
        break;
      }
      if (sub === "vote") {
        const a = parts.slice(2);
        let id: string | undefined; let choiceStr: string;
        if (a[0] && pollStore.has(a[0])) { id = a[0]; choiceStr = a.slice(1).join(" "); }
        else { choiceStr = a.join(" "); }
        const poll = findPoll(id);
        if (!poll) { sys("no open poll to vote in — start one with /poll new …"); break; }
        if (poll.status !== "open") { sys("that poll is already closed"); break; }
        if (poll.options.length === 0) { sys("no options yet — add some with /poll add <option>"); break; }
        const choices = resolveChoices(poll, choiceStr);
        if (choices.length === 0) {
          sys(`could not match your choice. options: ${sortedOptions(poll).map((o, i) => `${i + 1}. ${o.text}`).join("   ")}`);
          break;
        }
        castVote(poll, choices);
        const names = choices.map((cid) => poll.options.find((o) => o.id === cid)?.text ?? cid);
        sys(`voted in "${poll.question}": ${names.join(poll.method === "ranked" ? " > " : ", ")}`);
        break;
      }
      if (sub === "status" || sub === "close" || sub === "lock" || sub === "remove" || sub === "delete") {
        const id = parts[2] && pollStore.has(parts[2]) ? parts[2] : undefined;
        const poll = findPoll(id);
        if (!poll) { sys("no poll found"); break; }
        if (sub === "remove" || sub === "delete") { forgetPoll(poll); break; }
        if (sub === "lock") { lockNominations(poll); sys(`nominations locked for "${poll.question}"`); break; }
        if (sub === "close") {
          closePoll(poll);
          if (poll.status === "closed" && poll.result) sys(`closed "${poll.question}" — ${summarizeWinners(poll, poll.result)}`);
          break;
        }
        const counts = liveCounts(poll);
        sys(`"${poll.question}" [${poll.method}] — ${poll.status}${poll.nominationsLocked ? " · locked" : ""} (${poll.options.length} options · ${Object.keys(poll.ballots).length} ballots)`);
        for (const o of sortedOptions(poll)) sys(`  ${o.text}: ${counts[o.id] ?? 0}`);
        if (poll.status === "closed" && poll.result) sys("  " + summarizeWinners(poll, poll.result));
        break;
      }
      sys("usage: /poll new <q> [| seeds] [ranked] · add <opt> · vote [id] <choices> · status · lock · close · remove · list");
      break;
    }

    case "gov": {
      const gParts = arg.trim().split(/\s+/);
      const gsub = (gParts[0] || "").toLowerCase();
      const grest = gParts.slice(1).join(" ").trim();
      const focused = (): Group | null =>
        focusedGroup ? (groupStore.get(focusedGroup) ?? null)
                     : (groupStore.size === 1 ? [...groupStore.values()][0] : null);

      if (!gsub || gsub === "list") {
        if (groupStore.size === 0) { sys("no groups yet — /gov new <name>"); break; }
        sys(`groups (${groupStore.size}):`);
        for (const grp of groupStore.values())
          sys(`  🏛 ${grp.name}  (${Object.keys(grp.members).length} members · ${grp.issues.length} issues)${grp.id === focusedGroup ? "  ◂ focused" : ""}`);
        sys("  /gov show <name>  to focus + view a group");
        break;
      }
      if (gsub === "new") {
        if (!grest) { sys("usage: /gov new <group name>"); break; }
        const ng = createGroup(grest);
        sys(`🏛 created group “${ng.name}” — you are admin. /gov member add <peer>, /gov issue <title>, /gov vote …`);
        showGroupCard(ng);
        break;
      }
      if (gsub === "show") {
        const sg = grest ? findGroup(grest) : focused();
        if (!sg) { sys("group not found — /gov list"); break; }
        showGroupCard(sg);
        sys(`focused “${sg.name}”`);
        break;
      }

      const g = focused();
      if (!g) { sys("no focused group — /gov show <name> first (or /gov new)"); break; }
      const meId = myPeerId();
      // The durable half of this identity. A peerId is per-tab and can change;
      // the anchor does not, and `memberKeyFor` falls back to it — but only if
      // it is actually passed, which none of these checks used to do.
      const meAnchor = dyncapState?.anchor;

      if (gsub === "status") {
        sys(`🏛 ${g.name} — ${Object.keys(g.members).length} members, ${g.issues.length} issues`);
        const tw = trustWeightsFor(g);
        const trusted = Object.values(tw).some((w) => w !== 1);   // any ratings present?
        const discredited = new Set(discreditedMembers(g));
        for (const m of Object.values(g.members)) {
          const del = g.delegations[m.peerId]?.delegate;
          const wt = trusted ? `  [wt ${tw[m.peerId] ?? 1}]` : "";
          const flag = discredited.has(m.peerId) ? "  ⚠ discredited" : "";
          sys(`  ${m.role === "admin" ? "★" : "·"} ${m.label}${del ? `  → ${memberLabel(g, del)}` : ""}${wt}${flag}`);
        }
        if (trusted) sys(`  (wt = 1 + trust level; admins are the root at ${TRUST_MAX}, each rating confers a level below the rater's own)`);
        if (discredited.size) sys("  (⚠ discredited = censured for undeserved trust; their vouchers were slashed)");
        for (const i of g.issues) sys(`  ▸ ${i.title} — ${issueResultText(g, i)}`);
        showGroupCard(g);
        break;
      }
      if (gsub === "member") {
        const op = (gParts[1] || "").toLowerCase();
        if (op === "add" || op === "remove") {
          if (!isAdmin(g, meId, meAnchor)) { sys("only an admin can manage members"); break; }
          const pid = gParts[2] ? findPeerByName(gParts[2]) : null;
          if (!pid) { sys(`usage: /gov member ${op} <peer>  (peer not found)`); break; }
          if (op === "add") { const role: Role = (gParts[3] || "").toLowerCase() === "admin" ? "admin" : "member"; govSetMember(g, pid, role, peerLabel(pid)); sys(`added ${peerLabel(pid)} as ${role}`); }
          else { if (pid === g.creator) { sys("can't remove the group creator"); break; } govRemoveMember(g, pid); sys(`removed ${peerLabel(pid)}`); }
          break;
        }
        for (const m of Object.values(g.members)) sys(`  ${m.role === "admin" ? "★" : "·"} ${m.label}`);
        break;
      }
      if (gsub === "issue") {
        if (!grest || grest.toLowerCase() === "list") {
          if (!g.issues.length) sys("no issues yet — /gov issue <title>");
          for (const i of g.issues) sys(`  ▸ ${i.title} — ${issueResultText(g, i)}`);
          break;
        }
        if (!isMember(g, meId, meAnchor)) { sys("only members can add issues"); break; }
        const iss = govNewIssue(g, grest); sys(`▸ issue recorded: ${iss.title}`);
        break;
      }
      if (gsub === "delegate") {
        if (!isMember(g, meId, meAnchor)) { sys("only members can delegate"); break; }
        // /gov delegate <member> [on <issue title>]
        const onIdx = gParts.findIndex((t) => t.toLowerCase() === "on");
        const pid = gParts[1] ? findPeerByName(gParts[1]) : null;
        if (!pid || !isMember(g, pid)) { sys("usage: /gov delegate <member> [on <issue>]"); break; }
        if (pid === meId) { sys("can't delegate to yourself"); break; }
        let iss: Issue | undefined;
        if (onIdx >= 0) {
          const title = gParts.slice(onIdx + 1).join(" ").trim();
          iss = findIssue(g, title); if (!iss) { sys(`no issue matching “${title}” — /gov issue <title> first`); break; }
        }
        govSetDelegate(g, pid, iss?.id);
        sys(iss ? `for “${iss.title}” you delegate to ${peerLabel(pid)} (overrides your global delegate on this issue)`
                : `you delegate to ${peerLabel(pid)} — your vote flows to them unless you vote`);
        break;
      }
      if (gsub === "undelegate") {
        const onIdx = gParts.findIndex((t) => t.toLowerCase() === "on");
        if (onIdx >= 0) {
          const title = gParts.slice(onIdx + 1).join(" ").trim();
          const iss = findIssue(g, title);
          if (!iss) { sys(`no issue matching “${title}”`); break; }
          govSetDelegate(g, null, iss.id); sys(`per-issue delegation cleared for “${iss.title}” (your global delegate applies again)`);
        } else { govSetDelegate(g, null); sys("global delegation cleared — you vote directly"); }
        break;
      }
      if (gsub === "trust") {
        // /gov trust <member> <level>  — confer a trust level STRICTLY BELOW your
        // own (0 clears). Admins are the root (level TRUST_MAX); trust descends.
        if (!isMember(g, meId, meAnchor)) { sys("only members can rate trust"); break; }
        const pid = gParts[1] ? findPeerByName(gParts[1]) : null;
        if (!pid || !isMember(g, pid)) { sys(`usage: /gov trust <member> <0-${TRUST_MAX}>   (0 clears; confers a level below your own)`); break; }
        if (pid === meId) { sys("can't rate your own trust — trust is given by others"); break; }
        const requested = Number(gParts[2]);
        if (gParts[2] === undefined || isNaN(requested)) { sys(`usage: /gov trust <member> <0-${TRUST_MAX}>`); break; }
        const myLevel = trustLevels(g)[meId] ?? 0;
        const maxAssign = myLevel - 1;                 // strictly below your own level
        if (maxAssign < 0) { sys(`you have no trust to confer yet (your level is ${myLevel}); only members trusted above level 0 can rate others`); break; }
        const r = Math.max(0, Math.min(maxAssign, Math.round(requested)));
        if (requested > maxAssign) sys(`capped to ${maxAssign}: you can only confer a level below your own (${myLevel})`);
        govSetTrust(g, pid, r);
        sys(r === 0 ? `cleared your trust rating for ${peerLabel(pid)}`
                    : `you confer trust level ${r} on ${peerLabel(pid)} (below your level ${myLevel}) — their voting weight becomes 1+level`);
        break;
      }
      if (gsub === "censure" || gsub === "uncensure") {
        // /gov censure <member> — flag a member as holding undeserved trust.
        // Credible only from equal-or-higher standing; discredits the target and
        // slashes everyone who vouched for them (accountability).
        if (!isMember(g, meId, meAnchor)) { sys("only members can censure"); break; }
        const pid = gParts[1] ? findPeerByName(gParts[1]) : null;
        if (!pid || !isMember(g, pid)) { sys(`usage: /gov ${gsub} <member>`); break; }
        if (pid === meId) { sys("can't censure yourself"); break; }
        const on = gsub === "censure";
        if (on) {
          const levels = trustLevels(g); const meLvl = levels[meId] ?? 0;
          if (meLvl <= 0) { sys("you have no standing to censure (your trust level is 0)"); break; }
          if (meLvl < (levels[pid] ?? 0)) sys(`your standing (${meLvl}) is below ${peerLabel(pid)}'s (${levels[pid] ?? 0}) — only equal-or-higher members are eligible to censure them; recorded but not counted`);
        }
        govSetCensure(g, pid, on);
        sys(on ? `you censure ${peerLabel(pid)} for undeserved trust — discredit needs a ⅔ quorum of eligible censurers (min 2); no single member, admin included, can do it alone`
               : `you withdraw your censure of ${peerLabel(pid)}`);
        break;
      }
      if (gsub === "vote") {
        if (!isMember(g, meId, meAnchor)) { sys("only members can open a vote"); break; }
        let rest = grest; let method: PollMethod = "approval";
        if (/\branked\b/i.test(rest)) { method = "ranked"; rest = rest.replace(/\branked\b/i, "").trim(); }
        const bar = rest.indexOf("|");
        const title = (bar === -1 ? rest : rest.slice(0, bar)).trim();
        const opts = bar === -1 ? [] : rest.slice(bar + 1).split(",").map((s) => s.trim()).filter(Boolean);
        if (!title) { sys("usage: /gov vote <issue> | option1, option2 [ranked]"); break; }
        if (opts.length < 2) { sys("provide at least two options after |"); break; }
        const issue = govNewIssue(g, title);
        govOpenVote(g, issue, method, opts);
        sys(`🗳 vote opened on “${issue.title}” (${method}). Members vote on the poll card; non-voters' weight flows to their delegate.`);
        showGroupCard(g);
        break;
      }
      if (gsub === "treasury") {
        // Group funds as a /note currency. Thin orchestration over /note.
        const op = (gParts[1] || "").toLowerCase();
        if (op === "declare") {
          if (!isAdmin(g, meId, meAnchor)) { sys("only an admin can set up the treasury"); break; }
          if (g.treasury) { sys(`treasury already set: ${g.treasury}`); break; }
          const cur = govCurrency(g, "");
          handleCommand(`/note declare ${cur}`);
          g.treasury = cur; saveGroups(); renderGroups(); refreshGroupCard(g);
          signedBroadcast({ kind: "group-meta", groupId: g.id, treasury: cur });
          sys(`🏦 treasury currency for ${g.name}: ${cur}  — /gov treasury grant <member> <amount>`);
          break;
        }
        if (!g.treasury) { sys("no treasury yet — an admin runs /gov treasury declare"); break; }
        if (op === "grant") {
          if (!isAdmin(g, meId, meAnchor)) { sys("only an admin can fund from the treasury"); break; }
          const pid = gParts[2] ? findPeerByName(gParts[2]) : null;
          const n = parseInt(gParts[3] ?? "", 10);
          if (!pid || !isMember(g, pid) || isNaN(n) || n < 1) { sys("usage: /gov treasury grant <member> <amount>"); break; }
          handleCommand(`/note grant ${g.treasury} ${n}`);
          handleCommand(`/note pass ${g.treasury} ${n} ${gParts[2]}`);
          sys(`🏦 funded ${peerLabel(pid)} ${n} ${g.treasury}`);
          break;
        }
        sys(`🏦 ${g.name} treasury: ${g.treasury}`);
        handleCommand(`/note balance ${g.treasury}`);
        break;
      }
      if (gsub === "kudos") {
        // Reputation as a /note currency. Members award kudos; the admin issues.
        const op = (gParts[1] || "").toLowerCase();
        if (op === "balance") { if (g.kudos) handleCommand(`/note balance ${g.kudos}`); else sys("no kudos awarded yet"); break; }
        const pid = gParts[1] ? findPeerByName(gParts[1]) : null;
        const n = parseInt(gParts[2] ?? "", 10);
        if (!pid || !isMember(g, pid) || isNaN(n) || n < 1) { sys("usage: /gov kudos <member> <amount>  ·  /gov kudos balance"); break; }
        if (pid === meId) { sys("award kudos to others, not yourself"); break; }
        if (!g.kudos) {
          if (!isAdmin(g, meId, meAnchor)) { sys("kudos isn't set up yet — an admin must award first"); break; }
          const cur = govCurrency(g, "K");
          handleCommand(`/note declare ${cur}`);
          g.kudos = cur; saveGroups(); renderGroups();
          signedBroadcast({ kind: "group-meta", groupId: g.id, kudos: cur });
        }
        const K = g.kudos!;
        const myBal = [...noteStore.values()].filter((nn) => nn.currency === K).reduce((s, nn) => s + nn.denomination, 0);
        if (currencyTokens.has(K)) { handleCommand(`/note grant ${K} ${n}`); handleCommand(`/note pass ${K} ${n} ${gParts[1]}`); }
        else if (myBal >= n) { handleCommand(`/note pass ${K} ${n} ${gParts[1]}`); }
        else { sys(`you hold ${myBal} kudos to give (need ${n}); only the issuer can mint more`); break; }
        sys(`👏 awarded ${peerLabel(pid)} ${n} kudos`);
        break;
      }
      if (gsub === "locker") {
        const want = grest.trim();
        if (!want) {
          sys(g.locker ? `${g.name} uses the locker at ${g.locker}`
                       : `${g.name} has no locker recorded. An admin: /gov locker rho:id:…  (/rholang locker install mints one)`);
          break;
        }
        if (!isAdmin(g, meId, meAnchor)) { sys("only an admin records the group's locker"); break; }
        if (!looksLikeRegistryUri(want)) { sys(`not a registry URI: ${want}`); break; }
        g.locker = want;
        saveGroups(); renderGroups(); refreshGroupCard(g);
        signedBroadcast({ kind: "group-meta", groupId: g.id, locker: want });
        sys(`📇 ${g.name} uses the locker at ${want} — every member's /rholang now finds it`);
        break;
      }
      if (gsub === "uri") {
        // Recorded by an admin, not derived: the deploy happened in someone's
        // browser with someone's key, and only they can say where it landed.
        const want = grest.trim();
        if (!want) {
          sys(g.uri ? `${g.name} on chain: ${g.uri}   (/rholang read ${g.uri})`
                    : `${g.name} has no on-chain record. Deploy one, then: /gov uri rho:id:…`);
          break;
        }
        if (!isAdmin(g, meId, meAnchor)) { sys("only an admin records the group's on-chain record"); break; }
        if (!looksLikeRegistryUri(want)) { sys(`not a registry URI: ${want}   (expected rho:id:…, as /rholang register prints)`); break; }
        g.uri = want;
        saveGroups(); renderGroups(); refreshGroupCard(g);
        signedBroadcast({ kind: "group-meta", groupId: g.id, uri: want });
        sys(`📇 ${g.name} on chain: ${want}  — every member now has it; /rholang read ${want} to fetch it`);
        break;
      }
      if (gsub === "claim") {
        // Re-attach an orphaned group to this identity.
        //
        // A member record written before anchors were stamped carries no
        // durable identity, so a creator whose peerId moved cannot be matched
        // back to it and loses admin of their own group with no way to regain
        // it. This is the way back — and it is deliberately narrow.
        //
        // THE GATE IS THAT THE GROUP HAS AT MOST ONE MEMBER. Then there is
        // nobody a claim could take anything from: either the sole record is
        // this identity under an old peerId, or the group is empty. It is not a
        // permission check that can be argued with, it is a situation in which
        // the question does not arise. A group with two members is somebody
        // else's to grant, and `/gov member add` is how they grant it.
        if (isAdmin(g, meId, meAnchor)) { sys(`you are already an admin of “${g.name}”`); break; }
        const keys = Object.keys(g.members);
        if (keys.length > 1) {
          sys(`“${g.name}” has ${keys.length} members — an existing admin adds you: /gov member add <peer>`);
          whoIsAdmin(g, meId, meAnchor, sys);
          break;
        }
        void (async () => {
          const okClaim = await confirmDialog("Claim this group?",
            `“${g.name}” has ${keys.length === 0 ? "no members" : "one member record that does not match this identity"}.\n` +
            `Claiming makes ${govLabel()} its admin and moves that record onto this peer.`,
            "Claim");
          if (!okClaim) { sys("cancelled"); return; }
          if (keys.length === 1 && keys[0] !== meId) rekeyMember(g, keys[0], meId);
          g.creator = meId;
          g.creatorLabel = govLabel();
          g.members[meId] = { peerId: meId, role: "admin", label: govLabel(), at: Date.now(),
                              ...(meAnchor ? { anchor: meAnchor } : {}) };
          saveGroups(); renderGroups(); refreshGroupCard(g);
          signedBroadcast({ kind: "group-member", groupId: g.id, peerId: meId, role: "admin", label: govLabel() });
          sys(`🏛 claimed “${g.name}” — you are admin, and this identity is now anchored to it`);
        })();
        break;
      }
      if (gsub === "chain") {
        // The group's governance on chain (RGov_Core.md). Three contracts that
        // hold state and nothing else — the trust metric, delegation, tallying
        // and censure are node natives that compute over what they hold.
        const parts = grest.trim().split(/\s+/).filter(Boolean);
        const verb = (parts[0] ?? "").toLowerCase();
        const cfg = loadNodeConfig();
        const refs = g.chain ?? {};
        const myAddr = cfg.key ? revAddressOf(cfg.key) : undefined;

        if (!verb) {
          sys(`${g.name} on chain:`);
          for (const k of ["inbox", "group", "issue"] as const) {
            sys(`  ${k.padEnd(6)} ${refs[k] ?? "— not recorded"}`);
          }
          sys(myAddr ? `  you are ${memberLabel(g, meId, meAnchor)} — ${myAddr}`
                     : "  you have no deploy key — /rholang key generate");
          const known = Object.values(g.members).filter((m) => m.revAddr).length;
          sys(`  ${known}/${Object.keys(g.members).length} members have published a chain address`);
          sys("  /gov chain install · push · pull · <inbox|group|issue> <uri>");
          break;
        }

        // `inbox|group|issue <uri>` records a contract. Bare `inbox` is the
        // receive verb below, so this branch requires the argument rather than
        // swallowing the word.
        if ((verb === "inbox" || verb === "group" || verb === "issue") && parts.length > 1) {
          const want = parts.slice(1).join(" ").trim();
          if (!isAdmin(g, meId, meAnchor)) { sys("only an admin records the group's contracts"); whoIsAdmin(g, meId, meAnchor, sys); break; }
          if (!looksLikeRegistryUri(want)) { sys(`not a registry URI: ${want}`); break; }
          g.chain = { ...refs, [verb]: want };
          saveGroups(); refreshGroupCard(g);
          signedBroadcast({ kind: "group-meta", groupId: g.id, chain: g.chain });
          sys(`📇 ${g.name}'s ${verb} contract: ${want}`);
          break;
        }

        if (verb === "install") {
          if (!isAdmin(g, meId, meAnchor)) { sys("only an admin installs the group's contracts"); whoIsAdmin(g, meId, meAnchor, sys); break; }
          if (!cfg.key) { sys("no key — /rholang key generate first"); break; }
          sys("installing Inbox, Group and Issue — three deploys, one each…");
          sys("  each uri is minted by the registry, so it comes back as that deploy's answer");
          void (async () => {
            const jobs: [keyof ChainRefs, string][] = [
              ["inbox", rgov.installInboxProgram()],
              ["group", rgov.installGroupProgram()],
              ["issue", rgov.installIssueProgram()],
            ];
            const found: ChainRefs = {};
            for (const [which, program] of jobs) {
              const r = await deployTerm(cfg, program);
              if (!r.ok || !r.sig) { addMessage("", `✗ ${which}: ${r.message}`, "system"); return; }
              const answer = await deployAnswer(cfg, r.sig);
              const uri = (answer ?? []).join(" ").match(/rho:id:[a-z0-9]+/)?.[0];
              if (!uri) { addMessage("", `✗ ${which}: deployed, but no uri came back`, "system"); return; }
              found[which] = uri;
              addMessage("", `✓ ${which} at ${uri}`, "system");
            }
            const gg = groupStore.get(g.id); if (!gg) return;
            gg.chain = { ...gg.chain, ...found };
            saveGroups(); refreshGroupCard(gg);
            signedBroadcast({ kind: "group-meta", groupId: gg.id, chain: gg.chain });
            addMessage("", `📇 ${gg.name}'s governance is on chain — members: /gov chain push`, "system");
          })();
          break;
        }

        if (verb === "push") {
          // What a push can and cannot do is the design showing through, not a
          // limitation: `delegate`, `rate` and `censure` are SELF verbs, so an
          // admin cannot push a member's rows and a member does not need one to
          // push their own. Everybody pushes themselves; an admin additionally
          // creates the group, because somebody has to.
          if (!refs.group) { sys("no group contract — an admin: /gov chain install"); break; }
          if (!cfg.key) { sys("no key — /rholang key generate first"); break; }
          if (!isMember(g, meId, meAnchor)) { sys("only members push"); break; }
          const mine = memberKeyFor(g, meId, meAnchor);
          if (mine && g.members[mine].revAddr !== myAddr && myAddr) {
            g.members[mine].revAddr = myAddr; saveGroups();
            signedBroadcast({ kind: "gov-chain", groupId: g.id, member: meId, revAddr: myAddr });
            sys(`published your chain address to the group: ${myAddr}`);
          }
          const addrOf = (pid: string): string | undefined => {
            const k = memberKeyFor(g, pid); return k ? g.members[k].revAddr : undefined;
          };
          void (async () => {
            const steps: [string, string][] = [];
            if (isAdmin(g, meId, meAnchor)) steps.push(["create the group", rgov.createGroupProgram(refs.group!, g.id, g.name, "open")]);
            steps.push(["join", rgov.joinGroupProgram(refs.group!, g.id, memberLabel(g, meId, meAnchor))]);
            const del = g.delegations[mine ?? meId];
            if (del) {
              const to = addrOf(del.delegate);
              if (to) steps.push([`delegate to ${peerLabel(del.delegate)}`, rgov.delegateProgram(refs.group!, g.id, to, null)]);
              else addMessage("", `  skipping your delegation — ${peerLabel(del.delegate)} has not published a chain address`, "system");
            }
            for (const [ratee, lvl] of Object.entries(g.trustRatings?.[mine ?? meId] ?? {})) {
              const to = addrOf(ratee);
              if (to) steps.push([`rate ${peerLabel(ratee)} ${lvl}`, rgov.rateProgram(refs.group!, g.id, to, lvl)]);
              else addMessage("", `  skipping your rating of ${peerLabel(ratee)} — no chain address published`, "system");
            }
            for (const target of Object.keys(g.censures?.[mine ?? meId] ?? {})) {
              const to = addrOf(target);
              if (to) steps.push([`censure ${peerLabel(target)}`, rgov.censureProgram(refs.group!, g.id, to)]);
            }
            // Issues and ballots, if the group has an Issue contract. An issue is
            // opened by whoever opened it in the room, and a ballot is cast by
            // whoever cast it — the same self-only rule as everything above, and
            // for the same reason: `open` records `by` from the derived address
            // and `cast` keys the ballot by it, so neither can be done on
            // somebody else's behalf however much an admin might want to.
            if (refs.issue) {
              const roll = Object.values(g.members).map((m) => m.revAddr).filter((a): a is string => !!a);
              for (const iss of g.issues) {
                const poll = iss.pollId ? pollStore.get(iss.pollId) : undefined;
                const opts = poll ? poll.options.map((o) => o.id) : [];
                if (iss.by === (mine ?? meId)) {
                  steps.push([`open issue “${iss.title}”`,
                    rgov.openIssueProgram(refs.issue!, iss.id, g.id, iss.title,
                      poll?.method === "ranked" ? "ranked" : "approval", opts, roll)]);
                  // `open` is idempotent, so on a re-push it reports "already"
                  // and the roll it recorded the first time stands. Members
                  // publish their chain addresses at their own pace, so that
                  // roll is whoever happened to have one at the moment the
                  // issue was first pushed — and anyone later could never cast.
                  // Refreshing it is the opener's job and nobody else's.
                  if (iss.status !== "closed") {
                    steps.push([`refresh the roll for “${iss.title}” (${roll.length})`,
                      rgov.setRollProgram(refs.issue!, iss.id, roll)]);
                  }
                }
                const myBallot = poll?.ballots?.[mine ?? meId];
                if (myBallot?.length) {
                  steps.push([`ballot on “${iss.title}”`, rgov.castProgram(refs.issue!, iss.id, myBallot)]);
                }
              }
            }
            addMessage("", `pushing ${steps.length} row${steps.length === 1 ? "" : "s"}, one deploy each…`, "system");
            for (const [what, program] of steps) {
              const r = await deployTerm(cfg, program);
              if (!r.ok || !r.sig) { addMessage("", `✗ ${what}: ${r.message}`, "system"); return; }
              const answer = await deployAnswer(cfg, r.sig);
              addMessage("", `  ${what}: ${(answer ?? ["(no answer)"]).join(" ")}`, "system");
            }
            addMessage("", "✓ pushed — /gov chain pull to read it back", "system");
          })();
          break;
        }

        if (verb === "pull") {
          // Read-only, and it REPORTS rather than merges: the chain is one
          // record of what the group decided, not an authority over the room's
          // own state, and silently overwriting a live group with it would make
          // a stale contract the last word.
          if (!refs.group) { sys("no group contract recorded"); break; }
          sys(`reading ${g.name} from ${refs.group}…`);
          void (async () => {
            const say = (l: string) => addMessage("", l, "system");
            // The chain keys every row by REV address, because a derived address
            // is the only identity a contract can be sure of. A room knows
            // people by name, so translate on the way out: a report nobody can
            // read is a report nobody will check, which defeats the point of
            // pull reporting rather than merging. Anyone whose address the room
            // has not learned stays an address, shortened — never guessed at.
            const known = new Map<string, string>();
            for (const m of Object.values(g.members)) {
              if (m.revAddr) known.set(m.revAddr, m.label || m.peerId.slice(0, 8));
            }
            let sawUnknown = false;
            const humanise = (t: string) =>
              t.replace(/1111[1-9A-HJ-NP-Za-km-z]{20,60}/g, (addr) => {
                const label = known.get(addr);
                if (label) return label;
                sawUnknown = true;
                return `${addr.slice(0, 8)}…${addr.slice(-4)}`;
              });
            const one = async (label: string, program: string) => {
              const r = await evalTerm(cfg, program);
              say(`  ${label.padEnd(14)} ${r.values.length ? humanise(r.values.join(" | ")) : "—"}`);
              return r;
            };
            await one("members", rgov.readProgram(refs.group!, "membersOf", [JSON.stringify(g.id)]));
            await one("admins", rgov.adminsOfProgram(refs.group!, g.id));
            await one("delegations", rgov.delegationsOfProgram(refs.group!, g.id, null));
            await one("ratings", rgov.ratingsOfProgram(refs.group!, g.id));
            await one("censures", rgov.censuresOfProgram(refs.group!, g.id));
            if (refs.issue) {
              await one("issues", rgov.issuesOfProgram(refs.issue, g.id));
              // The ballots are the authoritative state on chain; a result is
              // only ever a claim about them (see RGov_Core.md). Show a few
              // rather than every one, so a long-lived group still prints.
              for (const iss of g.issues.slice(0, 5)) {
                await one(iss.id.slice(0, 12), rgov.ballotsOfProgram(refs.issue!, iss.id));
                // The roll stays editable until close, so say when it was
                // changed after voting began rather than leave it to a reader
                // to diff votersOf against what it was (#244).
                const log = await evalTerm(cfg, rgov.readProgram(refs.issue!, "rollLogOf", [JSON.stringify(iss.id)]));
                const before = [...log.values.join(" ").matchAll(/"ballotsBefore": (\d+)/g)].map((m) => Number(m[1]));
                const late = before.filter((n) => n > 0).length;
                if (late) say(`  ⚠ ${iss.id.slice(0, 12)} voter list updated ${late} time${late === 1 ? "" : "s"} after voting began (${Math.max(...before)} ballots in)`);
              }
            }
            say("  (a report, not a merge — the room's own state is untouched)");
            if (sawUnknown) {
              say("  names shown for members this room knows; a shortened address is somebody it does not —");
              say("  they appear once they run /gov chain push, which is what publishes the mapping");
            }
          })();
          break;
        }

        // The inbox is the one part of this that is not a mirror of room state.
        // A room message is already replicated among the peers who were there;
        // an on-chain locker is for what must reach somebody who was NOT —
        // and, because a message body may be a capability, for handing over
        // authority rather than text. Hence send/receive rather than /gov say.
        if (verb === "send" || verb === "inbox") {
          if (!refs.inbox) { sys("no inbox contract — an admin: /gov chain install"); break; }
          if (!cfg.key) { sys("no key — /rholang key generate first"); break; }
          if (verb === "inbox") {
            sys("opening your locker if needed, then receiving…");
            void (async () => {
              const seq: [string, string][] = [
                ["locker", rgov.newLockerProgram(refs.inbox!, "inbox", "open")],
                ["receive", rgov.receiveProgram(refs.inbox!, "inbox")],
              ];
              for (const [what, program] of seq) {
                const r = await deployTerm(cfg, program);
                if (!r.ok || !r.sig) { addMessage("", `✗ ${what}: ${r.message}`, "system"); return; }
                const answer = await deployAnswer(cfg, r.sig);
                addMessage("", `  ${what}: ${(answer ?? ["(no answer)"]).join(" ")}`, "system");
              }
              // `receive` CONSUMES. That is the point — a capability read twice
              // by two readers who each think they hold it is the bug an inbox
              // of capabilities must not have — but it means the lines above are
              // the only copy, so say so rather than let it surprise anyone.
              addMessage("", "  (receive consumes — what printed above is no longer in the locker)", "system");
            })();
            break;
          }
          const who = parts[1] ?? "";
          const text = parts.slice(2).join(" ");
          if (!who || !text) { sys("usage: /gov chain send <peer> <message>"); break; }
          const pid = findPeerByName(who) ?? who;
          const k = memberKeyFor(g, pid, meAnchor);
          const to = k ? g.members[k].revAddr : undefined;
          if (!to) { sys(`no chain address for ${who} — they run /gov chain push first`); break; }
          void (async () => {
            const msg = `{"type": "msg", "body": ${JSON.stringify(text)}}`;
            const r = await deployTerm(cfg, rgov.sendProgram(refs.inbox!, to, "inbox", msg));
            if (!r.ok || !r.sig) { addMessage("", `✗ ${r.message}`, "system"); return; }
            const answer = await deployAnswer(cfg, r.sig);
            addMessage("", `  ${(answer ?? ["(no answer)"]).join(" ")}`, "system");
          })();
          break;
        }

        sys("usage: /gov chain · install · push · pull · inbox · send <peer> <msg> · inbox|group|issue <uri>");
        break;
      }
      if (gsub === "say") {
        if (!isMember(g, meId, meAnchor)) { sys("only members can post to the group"); break; }
        if (!grest) { sys("usage: /gov say <message>"); break; }
        signedBroadcast({ kind: "group-msg", groupId: g.id, text: grest });
        addMessage("", `🏛 ${g.name}: ${grest}`, "self");
        break;
      }
      sys("usage: /gov new <name> · show <name> · member add|remove <peer> · issue <title> · delegate <peer> [on <issue>] · undelegate [on <issue>] · vote <issue> | opts [ranked] · treasury declare|grant <m> <n>|balance · kudos <m> <n>|balance · say <msg> · chain · claim · status · list");
      break;
    }

    case "macro":
    case "macros": {
      // The verbs that manage definitions are built in, so they keep the `/`.
      // `+` is reserved for what a person wrote: a leading `/` is something the
      // app ships, a leading `+` is something somebody in this room defined.
      const sub = (parts[1] || "").toLowerCase();
      const rest = arg.slice(parts[1] ? arg.indexOf(parts[1]) + parts[1].length : 0).replace(/^[^\S\n]+/, "");

      if (sub === "define" || sub === "def") {
        if (!rest.trim()) {
          sys("usage: /macro define name body   —  or   /macro define name(arg, …) body");
          sys("  the body is the rest of the line, or the lines below (Shift+Enter for a new line):");
          sys("    /macro define greet(who) Hi $who, welcome!");
          sys("    /macro define standup(topic)  // opens a standup poll");
          sys("    /poll new $topic | yes, no, later");
          sys("  a body of slash/`+` commands → a +name command; rholang → a $name(…) fragment; plain text → $name substitutes it");
          sys("  /macro edit name(x)  — write the body in the editor instead");
          break;
        }
        // Signature but no body. `name(x)` on its own is ambiguous — a
        // forgotten body, or "open the editor to write it". Say both, and
        // catch the common slip where the parens were meant to *be* the body.
        try {
          parseDefinition(rest);
        } catch (e) {
          if (/no body/.test((e as Error)?.message ?? "")) {
            const pm = /^\s*[$+]?([A-Za-z][\w-]*)\s*\(([^)]*)\)\s*$/.exec(rest);
            if (pm && pm[2].trim() && !/[,=]/.test(pm[2])) {
              sys(`· ${pm[1]}: "(${pm[2].trim()})" reads as a parameter list, not a body.`);
              sys(`  did you mean:  /macro define ${pm[1]} ${pm[2].trim()}   (body = ${pm[2].trim()})`);
              sys(`  or, to give ${pm[1]} a parameter and write the body in the editor:  /macro edit ${rest.trim()}`);
              break;
            }
            sys(`· that is a signature with no body. Put the body after it, or on the next line — or /macro edit ${rest.trim()} to write it in the editor.`);
            break;
          }
        }
        defineMacro(rest, sys);
        break;
      }

      if (sub === "edit") {
        // Open the rholang editor to write (or rewrite) a macro body. The
        // editor registers a `define …` buffer on Ctrl+Enter.
        const spec = parts.slice(2).join(" ").trim();
        if (!spec) { sys("usage: /macro edit <name>[(args)]   — opens the editor to write the body"); break; }
        const existing = macroStore.get(spec.toLowerCase().replace(/^[$+]/, "").replace(/\(.*$/, ""));
        editRholang("eval", existing ? `define ${formatDefinition(existing)}` : `define ${spec}\n`);
        break;
      }

      if (sub === "show") {
        const def = macroStore.get((parts[2] || "").toLowerCase().replace(/^[$+]/, ""));
        if (!def) { sys("usage: /macro show <name>"); break; }
        sys(`${formatDefinition(def)}`);
        sys(`  (${def.kind}, by ${def.authorLabel})`);
        break;
      }

      if (sub === "find") {
        let found: MacroDef[];
        try { found = findMacros(macroStore.values(), parts.slice(2).join(" ")); }
        catch (e) { sys(`· ${e instanceof MacroError ? e.message : String(e)}`); break; }
        if (!found.length) { sys("nothing matches"); break; }
        for (const d of found) sys(`  ${macroCallForm(d)}${d.doc ? `  — ${d.doc}` : ""}`);
        break;
      }

      if (sub === "echo" || sub === "show") {
        // Evidence, not explanation: what the expansion actually produced,
        // before anything runs and before anything is signed.
        const def = macroStore.get((parts[2] || "").toLowerCase().replace(/^[$+]/, ""));
        if (!def) { sys("usage: /macro echo <name> [args…]"); break; }
        const args = parseInvocation(`+${def.name} ${parts.slice(3).join(" ")}`).args;
        try {
          if (def.kind === "command") {
            const x = expandCommand(def, args, macroLookup);
            for (const err of x.errors) sys(`✗ line ${err.line}: ${err.message}`);
            for (const c of x.commands) sys(`  ${c}`);
          } else {
            const x = expandCallSites(`$${def.name}(${args.join(", ")})`, macroLookup);
            for (const err of x.errors) sys(`✗ line ${err.line}: ${err.message}`);
            sys(x.source);
          }
        } catch (e) { sys(`· ${e instanceof MacroError ? e.message : String(e)}`); }
        break;
      }

      if (sub === "remove" || sub === "forget" || sub === "rm") {
        const name = (parts[2] || "").toLowerCase().replace(/^[$+]/, "");
        if (!name) { sys("usage: /macro remove <name>"); break; }
        forgetMacro(name);
        break;
      }

      if (sub === "help") {
        for (const l of CMD_HELP["macro"] ?? []) sys("  " + l);
        break;
      }

      // Bare /macro, or /macro list.
      if (macroStore.size === 0) {
        sys("no macros yet");
        sys("  /macro define name(arg) <body>  — write one; kept in this browser, shared with every room you join");
        sys("  /macro edit name(arg)           — …or write the body in the editor");
        sys("  /macro help                     — the whole verb list");
        break;
      }
      sys(`your macros (${macroStore.size}) — kept in this browser, contributed to every room:`);
      for (const d of [...macroStore.values()].sort((a, b) => a.name.localeCompare(b.name))) {
        const tag = d.kind === "command" ? "" : d.kind === "text" ? "  [text]" : "  [rholang]";
        sys(`  ${macroCallForm(d)}${tag}${d.doc ? `  — ${d.doc}` : ""}  (by ${d.authorLabel})`);
      }
      break;
    }

    case "remove":
    case "retract":
    case "rm":
    case "forget": {
      const sub = (parts[1] || "").toLowerCase();
      const rest = parts.slice(2).join(" ").trim();
      if (sub === "list") {
        if (retracted.size === 0) { sys("no retracted items in this room"); break; }
        sys(`retracted (${retracted.size}):`);
        for (const k of retracted) sys(`  ${k}`);
        break;
      }
      if (sub === "poll") {
        const poll = (rest && pollStore.get(rest)) || findPoll(rest || undefined);
        if (!poll) { sys("no poll found  (usage: /forget poll <id>; see the Polls list)"); break; }
        forgetPoll(poll);
        break;
      }
      if (sub === "lemma") {
        const name = parseLemmaNameArg(rest);
        if (!name) { sys("usage: /forget lemma <name>  (multi-word: /forget lemma [all men are mortal])"); break; }
        forgetLemma(name);
        break;
      }
      if (sub === "note") {
        if (!rest) { sys("usage: /forget note <token | currency denomination>"); break; }
        let token = rest;
        if (!noteStore.has(token)) {
          const np = rest.split(/\s+/);
          const cur = np[0]; const den = parseInt(np[1] ?? "", 10);
          const found = [...noteStore.values()].find(n => n.currency === cur && (isNaN(den) || n.denomination === den));
          if (found) token = found.token;
        }
        if (!noteStore.has(token)) { sys(`no held note matches '${rest}'`); break; }
        forgetNote(token);
        break;
      }
      if (sub === "group") {
        const g = findGroup(rest);
        if (!g) { sys("usage: /forget group <name>  (see Governance list)"); break; }
        forgetGroup(g);
        break;
      }
      if (sub === "macro" || sub === "command") {
        const name = rest.toLowerCase().replace(/^[$+]/, "");
        if (!name) { sys("usage: /forget macro <name>  (see the Commands list)"); break; }
        forgetMacro(name);
        break;
      }
      sys("usage: /forget <poll <id> | lemma <name> | note <token|currency denom> | group <name> | macro <name> | list>");
      sys("  aliases: /remove, /retract, /rm  (e.g. /remove lemma <name>; or click the ✕ next to it)");
      sys("  poll/lemma/group: creator/author retracts for everyone; otherwise hides for you. note: deletes (destroys value).");
      break;
    }

    case "lemma": {
      if (!arg) {
        if (lemmaStore.size === 0) {
          sys("no lemmas registered yet");
          sys("  usage: /lemma <statement> [| <twists>]   (mark the handle: /lemma All men are @mortal)");
        } else {
          sys(`lemmas (${lemmaStore.size}):`);
          for (const [name, entry] of lemmaStore) {
            sys(`  ${lemmaRefStr(name)}  =  ${entry.twists}${entry.text ? `  “${entry.text}”` : ""}${entry.cap ? `  [cap: ${entry.cap}]` : ""}  (by ${entry.who})`);
          }
        }
        break;
      }
      // /lemma <statement> [| <twists>] — the statement may mark one word as the
      // @handle (/lemma All men are @mortal), be a bare multi-word name, or use
      // the legacy [brackets] / `<word> <twists>` forms. See lemma-parse.ts.
      const decl = parseLemmaDecl(arg);
      if ("error" in decl) {
        sys(decl.error);
        sys("  e.g.  /lemma All men are @mortal   ·   /lemma @concl Socrates is mortal | @mortal @man");
        break;
      }
      const { name: lemmaName, twistsArg: lemmaTwistsArg, text: lemmaText } = decl;
      const isAutoAlloc = !lemmaTwistsArg;
      let resolvedTwistsStr: string;
      if (isAutoAlloc) {
        resolvedTwistsStr = twistsToSymbolic(allocateTwists(lemmaName));
      } else if (lemmaTwistsArg.includes("@")) {
        const result = expandLemmaRefs(lemmaTwistsArg);
        if (!result) {
          sys(`unknown lemma reference: ${firstUnknownRef(lemmaTwistsArg) ?? "@?"}`);
          break;
        }
        resolvedTwistsStr = result.expanded;
      } else {
        resolvedTwistsStr = lemmaTwistsArg;
      }
      const checkTw = resolveLemmaToBytes(resolvedTwistsStr);
      if (!checkTw || checkTw.length === 0) {
        sys(`cannot parse twists: '${resolvedTwistsStr}'`);
        sys("  valid: symbolic (^v<>/\\\\+-), hex digits 0-7, or cap:label:hex");
        break;
      }
      // Lemmas are content-addressed by name. Once @name is declared, it
      // binds to that value for the room's lifetime. Re-declaration with
      // different content would silently corrupt the shared vocabulary.
      const existing = lemmaStore.get(lemmaName);
      if (existing && existing.twists !== resolvedTwistsStr) {
        sys(`${lemmaRefStr(lemmaName)} already declared with different twists (${existing.twists})`);
        sys("  · refusing re-declaration; choose a new name");
        break;
      }
      if (existing && existing.twists === resolvedTwistsStr) {
        sys(`${lemmaRefStr(lemmaName)} already declared (no change)`);
        break;
      }
      const { pos: lPos, neg: lNeg, balanced: lBal } = twistStats(checkTw);
      const lemWho = myName || (qpeer ? shortId(qpeer.peerId) : "local");
      const lemCap = lBal ? lemmaToCapToken(lemmaName, checkTw) : undefined;
      // Keep `text` only when the name is a handle within a longer claim.
      const lemText = lemmaText && canonLemma(lemmaText) !== lemmaName ? canonLemma(lemmaText) : undefined;
      lemmaStore.set(lemmaName, { twists: resolvedTwistsStr, who: lemWho, cap: lemCap, text: lemText });
      sys(`lemma registered: ${lemmaRefStr(lemmaName)}  =  ${resolvedTwistsStr}${isAutoAlloc ? "  (auto-allocated)" : ""}`);
      if (lemText) sys(`  “${lemText}”`);
      sys(`  twists: ${checkTw.length}  (${lPos}+/${lNeg}-)  ZFA: ${lBal ? "✓" : "✗"}`);
      if (lemCap) sys(`  cap: ${lemCap}  (share with /zfa to verify)`);
      signedBroadcast({ kind: "lemma", name: lemmaName, twists: resolvedTwistsStr, cap: lemCap, who: lemWho, text: lemText });
      saveLemmas();
      renderLemmas();
      break;
    }

    case "zfa": {
      const token = arg.trim();
      if (!token) { sys("usage: /zfa <capability-token>"); break; }
      const valid = validateCapability(token);
      const tw = tokenTwists(token);
      sys(`token: ${token}`);
      if (tw) {
        const { pos, neg, gap } = twistStats(tw);
        sys(`  valid: ${valid ? "✓" : "✗"}  spectral gap: ${gap}`);
        sys(`  twists: ${tw.length}  (${pos} positive, ${neg} negative)`);
      } else {
        sys(`  not a capability token (expected cap:label:hex)`);
      }
      break;
    }

    case "braket": {
      if (!arg) {
        sys("usage: /braket <state> [state ...]");
        sys("  states: 0  1  +  -  i  -i  (space-separated = superposition)");
        sys("  examples: /braket 0   /braket + -   /braket -i");
        break;
      }
      const rawToks = arg.trim().split(/\s+/);
      const parsed: string[] = [];
      for (let k = 0; k < rawToks.length; k++) {
        if (rawToks[k] === "-" && k + 1 < rawToks.length && rawToks[k + 1] === "i") {
          parsed.push("-i"); k++;
        } else {
          parsed.push(rawToks[k]);
        }
      }
      const unknown = parsed.find(s => !(s in STATE_FORMS));
      if (unknown) { sys(`unknown state: '${unknown}'  (valid: 0 1 + - i -i)`); break; }
      let mat = formToMatrix(STATE_FORMS[parsed[0]]);
      for (let k = 1; k < parsed.length; k++) mat = addM(mat, formToMatrix(STATE_FORMS[parsed[k]]));
      const ketLabel = parsed.map(s => STATE_KET[s]).join(" + ");
      const braLabel = parsed.map(s => STATE_BRA[s]).join(" + ");
      const procLabel = parsed.length > 1
        ? `parallel(${parsed.map(s => `action(Form_${s})`).join(", ")})`
        : `action(Form_${parsed[0]})`;
      sys(`ket: ${ketLabel}`);
      sys(`  RhoProcess: ${procLabel}`);
      sys("  eval = Form.toMatrix:");
      for (const line of fmtMatrix(mat)) sys(line);
      sys(`bra: ${braLabel}  (eval = ket†  =  ket  [Hermitian: Form.toMatrix_adjoint ✓])`);
      sys("  ZFA: action [+,−]  lift [−,+]  both balanced: ✓");
      sys("  bra_ket_always_balanced: ✓ (BraKetRhoQuCalc.lean)");
      break;
    }

    case "qucalc": {
      let qtwists: Uint8Array | null = null;
      let srcLabel = "";
      let components: Array<{ label: string | null; twists: string }> | null = null;
      if (!arg) {
        const id = qpeer?.peerId ?? null;
        if (!id) { sys("not connected (no peer ID); or pass twists as argument"); break; }
        qtwists = tokenTwists(id);
        srcLabel = `peer: ${id}`;
      } else if (arg.trim().includes("@")) {
        const result = expandLemmaRefs(arg.trim());
        if (!result) {
          const badName = firstUnknownRef(arg.trim());
          sys(`unknown lemma: ${badName ?? "@?"}  (type /lemma to list)`);
          break;
        }
        qtwists = parseSymbolicTwists(result.expanded);
        components = result.components;
        srcLabel = `composed: ${arg.trim()}`;
      } else if (arg.trim().startsWith("cap:")) {
        qtwists = tokenTwists(arg.trim());
        srcLabel = `token: ${arg.trim()}`;
      } else {
        qtwists = parseSymbolicTwists(arg.trim());
        srcLabel = `input: ${arg.trim()}`;
      }
      if (!qtwists || qtwists.length === 0) {
        sys("usage: /qucalc [twists]");
        sys("  twists: symbolic (^v<>/\\+-) or hex digits 0-7 or cap:label:hex");
        sys("  examples: /qucalc +-+-+-+-   /qucalc ^v^v   /qucalc cap:peer:…");
        sys("  @name:   /qucalc @major @minor   (use named lemmas, see /lemma)");
        sys("  (no arg: show your peer as a RhoQuCalc process)");
        break;
      }
      const { pos, neg, gap, balanced } = twistStats(qtwists);
      const symbolic = twistsToSymbolic(qtwists);
      sys("RhoQuCalc process:");
      sys(`  ${srcLabel}`);
      if (components && components.filter(c => c.label !== null).length > 1) {
        sys("  deduction composition:");
        for (const c of components) {
          const tw = parseSymbolicTwists(c.twists);
          if (!tw) continue;
          const s = twistStats(tw);
          const lbl = c.label ? lemmaRefStr(c.label) : `(${c.twists})`;
          sys(`    ${lbl}  →  ${c.twists}  (${s.pos}+/${s.neg}-)  ZFA: ${s.balanced ? "✓" : "✗"}`);
        }
        sys(`  composed: ${symbolic}  (${qtwists.length} total)`);
      } else {
        sys(`  twists: ${symbolic}  (${qtwists.length} total)`);
      }
      sys(`  action (pos): count=${pos}   lift (neg): count=${neg}`);
      sys(`  spectral gap: ${gap}  ZFA-balanced: ${balanced ? "✓" : "✗"}`);
      if (balanced) {
        const freqN = zfaFreqLevel(qtwists);
        if (freqN !== null) {
          const mult = zfaMultiplicity(freqN);
          sys(`  frequency level: ${freqN}  C(${qtwists.length},${freqN}) = ${mult.toLocaleString()} arrangements`);
          sys(`  relative frequency: ${freqN === 1 ? "fundamental (highest)" : `×1/2^${freqN-1} of fundamental`}`);
        }
        sys("  process: parallel(action(Form), lift(Form))  → ZFA stable");
        sys("  achieves_ZFA: ✓  stable under full_zeno_prune");
        sys("  rho_process_always_zfa: ✓ (Lean-verified)");
      } else {
        sys("  process: UNBALANCED  → pruned by full_zeno_prune");
        sys(`  achieves_ZFA: ✗  gap=${gap}  (not a physical process)`);
      }
      break;
    }

    case "qlf-action": {
      // Propose a QuCalc history string to the room; the local kernel evaluates
      // it (the eval is broadcast as a `qlf` envelope). The collaborative-study
      // surface over the ZFA kernel (CollaborativeLearningCaseStudy.md).
      const src = arg.trim();
      if (!src) {
        sys("usage: /qlf-action <twists>   (symbolic ^v<>/\\+- or hex 0-7)");
        sys("  proposes a history string for the room to verify; e.g. /qlf-action ^v<>/\\+-");
        break;
      }
      const tw = parseSymbolicTwists(src);
      if (!tw || tw.length === 0) { sys(`not a twist string: ${src}`); break; }
      const sym = twistsToSymbolic(tw);
      const cb = (() => { const s = twistStats(tw); return s.pos === s.neg; })();
      const pc = isPauliClosed(tw);
      if (qpeer) actionProposals.set(qpeer.peerId, { twists: tw, at: Date.now() });
      sys(`/qlf-action: ${sym}  (${tw.length} twists)  proposed by ${myName || "you"}`);
      sys(`  count-balanced: ${cb ? "✓" : "✗"}   pauli-closed: ${pc ? "✓" : "✗"}   ZFA: ${cb && pc ? "✓" : "✗"}`);
      sys("  RhoProcess: action(history)  → broadcast for /zfa-check (rho_process_always_zfa)");
      if (actionProposals.size >= 2) sys(`  ${actionProposals.size} proposals on the table — /coupling to see if they form one shared closure`);
      break;
    }

    case "zfa-check": {
      // Verify a history string locally against the kernel's two conjuncts
      // (is_zfa = is_count_balanced ∧ is_pauli_closed). Each peer runs its own.
      const src = arg.trim();
      if (!src) {
        sys("usage: /zfa-check <twists>   (verify ZFA closure locally)");
        sys("  is_zfa = is_count_balanced ∧ is_pauli_closed  (mirrors zfa-core-wasm)");
        break;
      }
      const tw = parseSymbolicTwists(src);
      if (!tw || tw.length === 0) { sys(`not a twist string: ${src}`); break; }
      const s = twistStats(tw);
      const cb = s.pos === s.neg;
      const pc = isPauliClosed(tw);
      sys(`/zfa-check: ${twistsToSymbolic(tw)}  verified by ${myName || "you"}`);
      sys(`  is_count_balanced: ${cb ? "✓" : "✗"}  (${s.pos} pos / ${s.neg} neg)`);
      sys(`  is_pauli_closed:   ${pc ? "✓" : "✗"}  (folds to {±I, ±iI})`);
      sys(`  is_zfa = ${cb} ∧ ${pc} = ${cb && pc ? "✓ closed" : "✗ not closed"}   gap=${s.gap}`);
      break;
    }

    case "coupling": {
      // Was this one shared closure, or several closures that happened side by
      // side? A room process is parallel(peer1, peer2, …) and is ZFA-balanced
      // by construction, so its balance distinguishes nothing. Cutting it into
      // one factor per contributor does: see crates/zfa-core/src/coupling.rs.
      // With no arguments the factors are the room's /qlf-action proposals — see
      // actionProposals for why peer tokens are the wrong cut.
      const src = arg.trim();
      let labels: string[] = [];
      let parts: Uint8Array[] = [];

      if (src) {
        const chunks = src.split(/[|\s]+/).filter(Boolean);
        if (chunks.length < 2) {
          sys("usage: /coupling [<twists> <twists> …]");
          sys("  with no arguments, classifies the room's /qlf-action proposals");
          sys("  e.g. /coupling ^ v      ·   /coupling +- ^v<>");
          break;
        }
        for (const c of chunks) {
          const tw = parseSymbolicTwists(c);
          if (!tw) { sys(`not a twist string: ${c}`); parts = []; break; }
          parts.push(tw);
          labels.push(twistsToSymbolic(tw));
        }
        if (parts.length === 0) break;
      } else {
        // Cut the room along what peers CONTRIBUTED, not along who they are.
        // A capability token is a random identity bearer minted against the
        // aggregate predicate; joining two of them is not a process, and the
        // verdict came back `open` for essentially every real room. A history
        // someone deliberately typed with /qlf-action is a contribution, so a
        // join of two peers' proposals closing means they built one closure
        // together — which is the question this command exists to ask.
        const entries = [...actionProposals.entries()]
          .filter(([id]) => id === qpeer?.peerId || peers.has(id))
          .sort((a, b) => a[1].at - b[1].at);
        for (const [id, p] of entries) {
          parts.push(p.twists);
          labels.push(id === qpeer?.peerId ? (myName || shortId(id)) + " (you)" : peerLabel(id));
        }
        if (parts.length < 2) {
          sys("/coupling: needs at least two /qlf-action proposals from peers in the room");
          sys("  each peer proposes a history (/qlf-action ^v), then /coupling asks whether");
          sys("  they formed one shared closure or several side by side");
          sys("  or pass histories directly: /coupling ^ v");
          break;
        }
      }

      const reading = classifyCoupling(parts);
      sys(`/coupling: parallel(${labels.join(", ")})`);
      parts.forEach((tw, i) => {
        const state = isPairwiseBalanced(tw) ? "closes alone"
                    : foldsToScalar(tw)      ? "folds to a scalar"
                    :                          "open";
        sys(`  ${labels[i]}  ${twistsToSymbolic(tw)}  — ${state}`);
      });
      sys(`  verdict: ${reading.verdict}`);
      switch (reading.verdict) {
        case "coupled":
          sys("    only the join closes — a shared closure (QLF's entanglement)");
          sys(`    census baseline: ${(COUPLED_BASELINE * 100).toFixed(1)}% of shared closures are coupled`);
          break;
        case "product":
          sys("    separable — each part folds to a scalar on its own");
          break;
        case "independent":
          sys("    each part closed alone — two closures, not one shared event");
          break;
        case "open":
          sys(`    the join is not a ZFA closure; signed action = (${signedAction(
                new Uint8Array(parts.flatMap(p => [...p]))).join(", ")})`);
          break;
      }
      break;
    }

    case "search": {
      // "What closes next" from a QuCalc position — the admissible next closures
      // (twist words you can append so the whole history is a ZFA closure),
      // shortest first. #119: computed in the browser (qucalc-enum.ts, ported
      // from quantum-logical-framework/qucalc_search.py, run in a Web Worker) —
      // no service, no endpoint. The search IS the experiment: it asks the
      // substrate which a-priori possibilities close from here, not a lookup.
      // Its result is broadcast to the room (the "meeting of minds" — peers'
      // positions co-read through one set of listeners), so /search is excluded
      // from the generic qlf rebroadcast and sends its own envelope when the
      // async enumeration completes.
      const rawArg = arg.trim();
      const tokens = rawArg ? rawArg.split(/\s+/) : [];
      const sub = (tokens[0] ?? "").toLowerCase();

      if (sub === "url" || sub === "info" || sub === "status") {
        sys("/search runs locally now — there is no endpoint to configure (qos#119)");
        sys("  the enumerator is packages/browser/src/qucalc-enum.ts, a port of");
        sys("  quantum-logical-framework/qucalc_search.py — the same algebra on every peer");
        break;
      }

      // Flags, then whatever is left is the seed position.
      let maxDepth: number | undefined;
      let limit: number | undefined;
      let mode: "possibilities" | "events" = "events";
      let full = false;
      let noSave = false;
      let saveCap: number | undefined;
      let badFlag = false;
      const seedTokens: string[] = [];
      for (let i = 0; i < tokens.length; i++) {
        const t = tokens[i];
        if (t === "--events") mode = "events";
        else if (t === "--possibilities" || t === "--poss") mode = "possibilities";
        else if (t === "--full") full = true;
        else if (t === "--no-save") noSave = true;
        else if (t === "--save-cap") saveCap = parseInt(tokens[++i] ?? "", 10);
        else if (t === "--depth" || t === "-d") maxDepth = parseInt(tokens[++i] ?? "", 10);
        else if (t === "--limit" || t === "-n") limit = parseInt(tokens[++i] ?? "", 10);
        else if (t.startsWith("--") || (t.startsWith("-") && t.length === 2 && !/[0-9]/.test(t[1]))) {
          sys(`unknown option: ${t}`); badFlag = true;
        } else seedTokens.push(t);
      }
      if (badFlag) break;
      if (maxDepth !== undefined && (!Number.isFinite(maxDepth) || maxDepth < 1)) { sys("--depth must be an integer ≥ 1"); break; }
      if (limit !== undefined && (!Number.isFinite(limit) || limit < 1)) { sys("--limit must be an integer ≥ 1"); break; }
      if (saveCap !== undefined && (!Number.isFinite(saveCap) || saveCap < 1)) { sys("--save-cap must be an integer ≥ 1"); break; }
      // Each discovered event becomes a room lemma, integer-named in discovery
      // order, so a re-run finds them already known. Only `events` (prefix-free
      // first-closures) are saved — a `possibilities` closure may just be a
      // prefix that already closed. Bounded so a deep search can't flood the
      // room's vocabulary; --no-save opts out, --save-cap raises the ceiling.
      const EVENT_LEMMA_CAP = Math.min(saveCap ?? 32, 256);
      const save = mode === "events" && !noSave;

      // Resolve the seed(s). An explicit position — symbolic twists, @lemma, or
      // a cap:token — or, with none given, the room's /qlf-action proposals as a
      // concurrent search (peers' positions, one set of listeners).
      const seeds: string[] = [];
      const seedLabels: string[] = [];
      const seedArg = seedTokens.join(" ").trim();
      if (seedArg) {
        if (seedArg.includes("@")) {
          const result = expandLemmaRefs(seedArg);
          if (!result) { sys(`unknown lemma: ${firstUnknownRef(seedArg) ?? "@?"}  (type /lemma to list)`); break; }
          const tw = parseSymbolicTwists(result.expanded);
          if (!tw) { sys(`not a twist string: ${seedArg}`); break; }
          seeds.push(twistsToSymbolic(tw)); seedLabels.push(seedArg);
        } else if (seedArg.startsWith("cap:")) {
          const tw = tokenTwists(seedArg);
          if (!tw) { sys(`not a capability token: ${seedArg}`); break; }
          seeds.push(twistsToSymbolic(tw)); seedLabels.push(seedArg.slice(0, 20) + "…");
        } else {
          const tw = parseSymbolicTwists(seedArg);
          if (!tw) { sys(`not a twist string: ${seedArg}  (symbolic ^v<>/\\+- or hex 0-7)`); break; }
          seeds.push(twistsToSymbolic(tw)); seedLabels.push(twistsToSymbolic(tw));
        }
      } else {
        const entries = [...actionProposals.entries()]
          .filter(([id]) => id === qpeer?.peerId || peers.has(id))
          .sort((a, b) => a[1].at - b[1].at);
        for (const [id, p] of entries) {
          seeds.push(twistsToSymbolic(p.twists));
          seedLabels.push(id === qpeer?.peerId ? (myName || shortId(id)) + " (you)" : peerLabel(id));
        }
        if (seeds.length === 0) {
          sys("/search: no position to search from");
          sys("  pass one:  /search ^v<>   ·   /search @lemma   ·   /search cap:…");
          sys("  or have peers propose histories with /qlf-action, then bare /search reads the room");
          break;
        }
      }

      // Drop the `head` listener when saving — the saved lemma names are the sample.
      const listeners = "phase,depth,capacity:2,capacity:3" + (full || save ? "" : ",head:20");
      const searchCtx = activeRoom;
      const out: string[] = [];
      const say = (t: string) => { inRoom(searchCtx, () => addMessage("", t, "system")); out.push(t); };
      const posDesc = seeds.length === 1
        ? seeds[0]
        : `${seeds.length} positions (${seedLabels.join(" , ")})`;
      sys(`/search ${mode} from ${posDesc} …`);

      void (async () => {
        try {
          const gen = qucalcSearch(seeds.length === 1 ? seeds[0] : seeds, {
            // Saving needs the events streamed; keep the run bounded so a deep
            // search can't stall on tens of thousands of lines.
            maxDepth,
            limit: limit ?? (save ? Math.max(EVENT_LEMMA_CAP * 6, 128) : null),
            mode, listeners,
          });
          say(`from ${posDesc} · ${mode}`);
          let shown = 0;
          const foundHistories: string[] = [];
          let step: IteratorResult<{ cont: string; history: string; depth: number; phase: string; qc?: string }, QucalcSearchDone>;
          while (!(step = await gen.next()).done) {
            const c = step.value;
            if (full && shown < 40) {
              say(`  ${c.cont.padEnd(8)} → ${c.history}  [${c.phase}]  d${c.depth}` + (c.qc ? `  <${c.qc}>` : ""));
              shown++;
            }
            if (save && foundHistories.length < EVENT_LEMMA_CAP * 4) foundHistories.push(c.history);
          }
          const done = step.value;
          say(`  ${done.found} closure${done.found === 1 ? "" : "s"} in ${done.elapsedS}s`
            + (done.truncated ? "  (hit limit — raise --limit for the rest)" : ""));

          // Turn the discovered events into room lemmas, integer-named in
          // discovery order. All state touches go through the captured room.
          if (save) {
            let firstName = "", lastName = "", saved = 0, dup = 0;
            const newEntries: Array<{ name: string; twists: string; who: string; cap?: string; event: boolean }> = [];
            inRoom(searchCtx, () => {
              const who = myName || (qpeer ? shortId(qpeer.peerId) : "local");
              const known = new Set([...lemmaStore.values()].map(e => e.twists));
              let n = nextEventNumber();
              for (const hist of foundHistories) {
                if (saved >= EVENT_LEMMA_CAP) break;
                if (known.has(hist)) { dup++; continue; }
                const tw = parseSymbolicTwists(hist);
                if (!tw || !achievesZfa(tw)) continue;   // enumerator gates on the stronger QLF predicate; be safe
                while (lemmaStore.has(String(n)) || isRetracted("lemma", String(n))) n++;
                const name = String(n);
                const cap = lemmaToCapToken(name, tw);
                lemmaStore.set(name, { twists: hist, who, cap, event: true });
                known.add(hist);
                newEntries.push({ name, twists: hist, who, cap, event: true });
                if (!firstName) firstName = name;
                lastName = name;
                saved++; n++;
              }
              if (newEntries.length) {
                saveLemmas();
                renderLemmas();
                signedBroadcast({ kind: "sync-lemmas", entries: newEntries });
              }
            });
            const overflow = foundHistories.length >= EVENT_LEMMA_CAP * 4 || (done.found > foundHistories.length && saved >= EVENT_LEMMA_CAP);
            if (saved > 0) {
              say(`  saved ${saved} new event${saved === 1 ? "" : "s"} as @${firstName}${saved > 1 ? `–@${lastName}` : ""}`
                + (dup ? `  (${dup} already known)` : "")
                + (overflow ? `  · more found — raise --save-cap or narrow --depth` : ""));
            } else {
              say(`  no new events to save${dup ? ` (${dup} already known)` : ""}`);
            }
          }
          const ph = done.listeners.phase as Record<string, number> | undefined;
          if (ph) {
            const parts = Object.entries(ph).filter(([, n]) => n > 0).map(([k, n]) => `${k}×${n}`);
            if (parts.length) say(`  phase: ${parts.join("  ")}`);
          }
          const dp = done.listeners.depth as Record<string, number> | undefined;
          if (dp && Object.keys(dp).length) {
            say(`  by depth: ${Object.entries(dp).map(([k, n]) => `+${k}:${n}`).join("  ")}`);
          }
          for (const key of Object.keys(done.listeners)) {
            if (!key.startsWith("capacity:")) continue;
            const cap = done.listeners[key] as { R: number; heard: number; missed: number };
            say(`  horizon R=${cap.R}: hears ${cap.heard} · misses ${cap.missed}`);
          }
          if (done.perSeed) {
            for (const [s, n] of Object.entries(done.perSeed)) say(`  ${s}: ${n}`);
          }
          const hd = done.listeners.head as { conts: string[] } | undefined;
          if (!full && hd && hd.conts.length) {
            say(`  next: ${hd.conts.slice(0, 20).join("  ")}`);
          }
        } catch (e) {
          say(`  ✗ ${(e as Error)?.message ?? e}`);
        } finally {
          inRoom(searchCtx, () => {
            if (qpeer && out.length) qpeer.broadcast({ kind: "qlf", cmd: "search", arg: rawArg, lines: out });
          });
        }
      })();
      break;
    }

    case "solve": {
      // The complement of /search. /search renders every way to close from a
      // position; /solve picks the one the substrate takes and hands you that
      // path. Selection is a deterministic cascade — least free action first —
      // so every peer computes the same winner (joiner-local, like /poll).
      // #119: computed locally (qucalc-enum.ts, in a worker). When nothing
      // closes within reach, it reports the residual: the exact action vector a
      // completion still owes.
      const rawArg2 = arg.trim();
      const solveTokens = rawArg2 ? rawArg2.split(/\s+/) : [];

      if (solveTokens[0]?.toLowerCase() === "url" || solveTokens[0]?.toLowerCase() === "info") {
        sys("/solve runs locally now — there is no endpoint (qos#119)");
        break;
      }

      let showAll = false;
      let solveNoSave = false;
      let solveBad = false;
      const posTokens: string[] = [];
      for (const t of solveTokens) {
        if (t === "--all") showAll = true;
        else if (t === "--no-save") solveNoSave = true;
        else if (t.startsWith("--")) { sys(`unknown option: ${t}`); solveBad = true; }
        else posTokens.push(t);
      }
      if (solveBad) break;

      const posArg = posTokens.join(" ").trim();
      let history = "";
      let label = "";
      if (posArg) {
        if (posArg.includes("@")) {
          const r = expandLemmaRefs(posArg);
          if (!r) { sys(`unknown lemma: ${firstUnknownRef(posArg) ?? "@?"}  (type /lemma to list)`); break; }
          const tw = parseSymbolicTwists(r.expanded);
          if (!tw) { sys(`not a twist string: ${posArg}`); break; }
          history = twistsToSymbolic(tw); label = posArg;
        } else if (posArg.startsWith("cap:")) {
          const tw = tokenTwists(posArg);
          if (!tw) { sys(`not a capability token: ${posArg}`); break; }
          history = twistsToSymbolic(tw); label = posArg.slice(0, 20) + "…";
        } else {
          const tw = parseSymbolicTwists(posArg);
          if (!tw) { sys(`not a twist string: ${posArg}  (symbolic ^v<>/\\+- or hex 0-7)`); break; }
          history = twistsToSymbolic(tw); label = history;
        }
      } else {
        // The room's joint position: peers' latest /qlf-action proposals, in the
        // order they were put on the table.
        const entries = [...actionProposals.entries()]
          .filter(([id]) => id === qpeer?.peerId || peers.has(id))
          .sort((a, b) => a[1].at - b[1].at);
        if (entries.length === 0) {
          sys("/solve: no position to solve");
          sys("  pass one:  /solve ^v<>   ·   /solve @lemma   ·   /solve cap:…");
          sys("  or have peers propose histories with /qlf-action, then bare /solve completes the room's joint position");
          break;
        }
        const merged: number[] = [];
        for (const [, p] of entries) merged.push(...p.twists);
        history = twistsToSymbolic(new Uint8Array(merged));
        label = `room (${entries.length} proposal${entries.length === 1 ? "" : "s"})`;
      }

      const seedTw = parseSymbolicTwists(history);
      if (!seedTw || seedTw.length === 0) { sys(`nothing to solve from '${history}'`); break; }

      const solveCtx = activeRoom;
      const sOut: string[] = [];
      const sSay = (t: string) => { inRoom(solveCtx, () => addMessage("", t, "system")); sOut.push(t); };

      const resid = signedAction(seedTw).map(x => -x);
      const floor = resid.reduce((s, x) => s + Math.abs(x), 0);
      sys(`/solve ${label}  →  ${history}  ·  residual (${resid.join(",")})  ·  floor depth ${floor} …`);

      void (async () => {
        try {
          const r = await qucalcSolve(history, { withShortlist: showAll });

          if (r.solved && r.alreadyClosed) {
            const st = twistStats(seedTw);
            sSay(`/solve ${label}: ${history} is already a ZFA closure — no path needed  (${st.pos}+/${st.neg}-)`);
            return;
          }

          if (!r.solved) {
            const reach = r.searchedDepth;
            sSay(`  ✗ no closure within depth ${reach}`);
            sSay(`  residual action (v,h,d,l) = (${r.residual.join(", ")}) — a completion must supply exactly this`);
            if (r.reason === "beyond max_depth" && r.completion) {
              sSay(`  the shortest possible completion is  ${r.completion}  (${r.completion.length} twists, depth ${r.floorDepth}) — beyond the depth-${reach} horizon`);
              sSay(`  → on a path to closure, but a deep one`);
            } else if (r.completion) {
              sSay(`  it count-balances with  ${r.completion}  (depth ${r.floorDepth}) but no ordering within depth ${reach} folds to a Pauli scalar`);
              sSay(`  → no event on a short path from here`);
            }
            return;
          }

          const bestTw = parseSymbolicTwists(r.history)!;
          const cont = r.cont;
          sSay(`  path:  ${cont}  →  ${r.history}`);
          sSay(`  depth ${r.depth} · phase ${r.phase} · peak excursion ${r.peakExcursion}`
            + ` · C(${bestTw.length},${bestTw.length / 2}) = ${r.arrangements.toLocaleString()} arrangements`);
          sSay(`  of ${r.considered} closure${r.considered === 1 ? "" : "s"} within depth ${r.searchedDepth}, the least-free-action path`
            + ` (min peak excursion, then shortest, then phase +1)`);
          if (showAll && r.shortlist && r.shortlist.length) {
            sSay(`  ranked:`);
            for (const e of r.shortlist.slice(0, 10)) {
              sSay(`    ${e.history.slice(history.length).padEnd(8)} → ${e.history}   x${peakExcursion(e.history)}  d${e.depth}  [${e.phase}]`);
            }
          }

          if (!solveNoSave) {
            inRoom(solveCtx, () => {
              const who = myName || (qpeer ? shortId(qpeer.peerId) : "local");
              const already = [...lemmaStore.entries()].find(([, en]) => en.twists === r.history);
              if (already) { sSay(`  already recorded as @${already[0]}`); return; }
              let n = nextEventNumber();
              while (lemmaStore.has(String(n)) || isRetracted("lemma", String(n))) n++;
              const name = String(n);
              const cap = lemmaToCapToken(name, bestTw);
              lemmaStore.set(name, { twists: r.history, who, cap, event: true });
              saveLemmas();
              renderLemmas();
              signedBroadcast({ kind: "sync-lemmas", entries: [{ name, twists: r.history, who, cap, event: true }] });
              sSay(`  saved @${name}  ·  /lemma @${name} to record it as the solution`);
            });
          }
        } catch (e) {
          sSay(`  ✗ ${(e as Error)?.message ?? e}`);
        } finally {
          inRoom(solveCtx, () => {
            if (qpeer && sOut.length) qpeer.broadcast({ kind: "qlf", cmd: "solve", arg: rawArg2, lines: sOut });
          });
        }
      })();
      break;
    }

    case "estimate": {
      handleEstimate(arg, sys);
      break;
    }


    case "conj": {
      let ctwists: Uint8Array | null = null;
      let csrc = "";
      if (!arg) {
        sys("usage: /conj <twists>");
        sys("  twists: symbolic (^v<>/\\+-) or hex digits 0-7 or cap:label:hex or @name");
        sys("  Hermitian adjoint: reverse + parity-flip (XOR 1).  Identity: E + E† ≡ ZFA.");
        break;
      } else if (arg.trim().includes("@")) {
        const result = expandLemmaRefs(arg.trim());
        if (!result) {
          const badName = firstUnknownRef(arg.trim());
          sys(`unknown lemma: ${badName ?? "@?"}  (type /lemma to list)`);
          break;
        }
        ctwists = parseSymbolicTwists(result.expanded);
        csrc = `composed: ${arg.trim()}`;
      } else if (arg.trim().startsWith("cap:")) {
        ctwists = tokenTwists(arg.trim());
        csrc = `token: ${arg.trim()}`;
      } else {
        ctwists = parseSymbolicTwists(arg.trim());
        csrc = `input: ${arg.trim()}`;
      }
      if (!ctwists || ctwists.length === 0) {
        sys("/conj: could not parse twists");
        break;
      }
      const adj = adjointHistory(ctwists);
      const selfAdj = isSelfAdjoint(ctwists);
      const hSym = twistsToSymbolic(ctwists);
      const aSym = twistsToSymbolic(adj);
      const combined = new Uint8Array(ctwists.length + adj.length);
      combined.set(ctwists, 0);
      combined.set(adj, ctwists.length);
      const combinedStats = twistStats(combined);
      sys("Hermitian adjoint (H†):");
      sys(`  ${csrc}`);
      sys(`  H  = ${hSym}   (n=${ctwists.length})`);
      sys(`  H† = ${aSym}   (reversed + parity-flipped)`);
      sys(`  self-adjoint (H = H†): ${selfAdj ? "✓" : "✗"}`);
      sys(`  H || H† balanced: ${combinedStats.balanced ? "✓" : "✗"}  (E + E† ≡ ZFA)`);
      if (selfAdj) {
        sys(`  member of Σ_sa  → fixed locus of QLF adjoint involution`);
        sys(`  (counterpart of Re(s)=1/2 in Riemann ξ;  see ReverseMathematics §4.9)`);
      }
      break;
    }

    case "dump": {
      if (sessionLog.length === 0) { sys("no logic shared yet this session"); break; }
      sys("logic shared this session:");
      for (const e of sessionLog) {
        const argPart = e.arg ? ` ${e.arg}` : "";
        sys(`  ${e.who}: /${e.cmd}${argPart}`);
        if (e.summary) sys(`    → ${e.summary}`);
      }
      break;
    }

    case "freq": {
      let highlight: number | null = null;
      if (!arg && qpeer) {
        const tw = tokenTwists(qpeer.peerId);
        if (tw) highlight = zfaFreqLevel(tw);
      } else if (arg) {
        const trimmed = arg.trim();
        if (/^\d+$/.test(trimmed)) {
          highlight = parseInt(trimmed, 10);
        } else if (trimmed.startsWith("cap:")) {
          const tw = tokenTwists(trimmed);
          if (tw) highlight = zfaFreqLevel(tw);
        } else {
          const tw = parseSymbolicTwists(trimmed);
          if (tw) {
            if (!achievesZfa(tw)) { sys("not ZFA-balanced — frequency level undefined"); break; }
            highlight = zfaFreqLevel(tw);
          }
        }
      }
      sys("ZFA frequency spectrum:");
      sys("  level n = length 2n  |  C(2n,n) arrangements  |  relative frequency");
      sys("  each level resolves 2× before the next (2:1 harmonic)");
      sys("");
      for (let i = 1; i <= Math.max(10, highlight ?? 0) && i <= 10; i++) {
        const mult = zfaMultiplicity(i);
        const freqStr = (i === 1 ? "×1" : `×1/2^${i-1}`).padEnd(8);
        const bar = "█".repeat(Math.max(1, Math.round(Math.log2(mult + 1))));
        const marker = i === highlight ? "  ← you" : "";
        sys(`  n=${String(i).padEnd(2)} len=${String(2*i).padEnd(3)} C(${2*i},${i})=${String(mult).padStart(12)}  ${freqStr} ${bar}${marker}`);
      }
      if (highlight !== null && highlight > 10) {
        sys("  ...");
        const mult = zfaMultiplicity(highlight);
        sys(`  n=${highlight} len=${2*highlight} C(${2*highlight},${highlight})=${mult.toLocaleString()}  ×1/2^${highlight-1}  ← you`);
      }
      sys("");
      sys("  C(2n,n) ~ 4^n/√(πn)  proven: QLF_Riemann.find_stable_states_length_even");
      break;
    }

    case "request": {
      const lemmaName = parseLemmaNameArg(arg);
      if (!lemmaName) { sys("usage: /request <lemma-name>  (multi-word: /request [name with spaces])"); break; }
      if (!qpeer) { sys("not connected"); break; }
      if (lemmaStore.has(lemmaName)) { sys(`you already hold ${lemmaRefStr(lemmaName)}`); break; }
      const myLabel = myName || shortId(qpeer.peerId);
      qpeer.broadcast({ kind: "lemma-request", name: lemmaName, fromName: myLabel });
      sys(`· requested ${lemmaRefStr(lemmaName)} — waiting for holder to /pass it`);
      break;
    }

    case "pass": {
      // Name may be bracketed for multi-word: /pass [all men are mortal] Alice.
      const [passLemma, targetName] = splitLemmaNameArg(arg);
      if (!passLemma || !targetName) { sys("usage: /pass <lemma-name> <peer-name>  (multi-word: /pass [name] peer)"); break; }
      if (!qpeer) { sys("not connected"); break; }
      const passEntry = lemmaStore.get(passLemma);
      if (!passEntry) { sys(`you don't hold ${lemmaRefStr(passLemma)} — nothing to pass`); break; }
      const targetId = findPeerByName(targetName);
      if (!targetId) { sys(`unknown peer: '${targetName}'  (check Peers list for exact name)`); break; }
      const sent = qpeer.send(targetId, { kind: "lemma-pass", name: passLemma, twists: passEntry.twists, cap: passEntry.cap });
      if (!sent) { sys(`cannot reach ${targetName} — data channel not open`); break; }
      lemmaStore.delete(passLemma);
      saveLemmas();
      renderLemmas();
      sys(`· ${lemmaRefStr(passLemma)} transferred to ${targetName} — removed from your lemmas`);
      if (passEntry.cap) sys(`  cap: ${passEntry.cap}`);
      break;
    }

    case "note": {
      const nParts = arg.trim().split(/\s+/);
      const sub = (nParts[0] || "").toLowerCase();
      const a1 = nParts[1] ?? "";
      const a2 = nParts[2] ?? "";
      const aRest = nParts.slice(2).join(" ").trim();

      // Helper: pick a held note of `currency` with denomination ≥ N (prefer exact match).
      const pickNote = (currency: string, N: number): NoteEntry | null => {
        let exact: NoteEntry | null = null;
        let larger: NoteEntry | null = null;
        for (const n of noteStore.values()) {
          if (n.currency !== currency) continue;
          if (n.denomination === N) { exact = n; break; }
          if (n.denomination > N && (!larger || n.denomination < larger.denomination)) larger = n;
        }
        return exact ?? larger;
      };

      // Helper: detach a denomination-N piece from a held note. Returns the
      // outgoing token and (if split) the change note already re-registered.
      // Always undoable by re-adding `chosen` and removing `change`.
      const detach = (chosen: NoteEntry, N: number): { outgoing: string; change: NoteEntry | null } | null => {
        if (chosen.denomination === N) {
          noteStore.delete(chosen.token);
          return { outgoing: chosen.token, change: null };
        }
        const split = splitNote(chosen.token, N);
        if (!split) return null;
        const [paid, changeTok] = split;
        const change: NoteEntry = { token: changeTok, currency: chosen.currency, denomination: chosen.denomination - N };
        noteStore.delete(chosen.token);
        noteStore.set(changeTok, change);
        return { outgoing: paid, change };
      };

      const undoDetach = (chosen: NoteEntry, change: NoteEntry | null) => {
        if (change) noteStore.delete(change.token);
        noteStore.set(chosen.token, chosen);
      };

      switch (sub) {
        case "":
        case "list": {
          if (currencyTokens.size === 0 && noteStore.size === 0 && receiptStore.size === 0) {
            sys("no notes, currencies, or receipts in this room");
            sys("  /note declare <currency>            — issue a new currency");
            sys("  /note grant <currency> <N>          — mint a denomination-N note");
            sys("  /note pass <currency> <N> <peer>    — transfer to a peer (auto-splits)");
            sys("  /note redeem <currency> <N> <peer>  — redeem with issuer, get receipt");
            sys("  /note split <token> <a>             — split into (a, N-a)");
            sys("  /note merge <token1> <token2>       — combine two notes");
            sys("  /note balance [currency]            — sum denominations");
            break;
          }
          if (currencyTokens.size > 0) {
            sys(`currency authorities (${currencyTokens.size}):`);
            for (const [cur, tok] of currencyTokens) sys(`  ${cur}  ${tok}`);
          }
          if (noteStore.size > 0) {
            sys(`notes you hold (${noteStore.size}):`);
            for (const n of noteStore.values()) {
              const from = n.receivedFrom ? `  (from ${n.receivedFrom})` : "";
              sys(`  ${n.currency} ${n.denomination}${from}`);
              sys(`    ${n.token}`);
            }
          }
          if (receiptStore.size > 0) {
            sys(`receipts (${receiptStore.size}):`);
            for (const r of receiptStore.values()) {
              sys(`  ${r.currency} ${r.denomination}  honored by ${r.issuer}`);
              sys(`    ${r.token}`);
            }
          }
          if (redemptionsHonored.size > 0) {
            sys(`redemptions you honored (${redemptionsHonored.size}):`);
            for (const r of redemptionsHonored.values()) {
              sys(`  ${r.currency} ${r.denomination}  for ${r.redeemer}`);
            }
          }
          break;
        }

        case "balance": {
          const want = a1;
          const sums = new Map<string, number>();
          for (const n of noteStore.values()) {
            if (want && n.currency !== want) continue;
            sums.set(n.currency, (sums.get(n.currency) ?? 0) + n.denomination);
          }
          if (sums.size === 0) { sys(want ? `no ${want} notes` : "no notes"); break; }
          sys("balances:");
          for (const [cur, sum] of sums) sys(`  ${cur}: ${sum}`);
          break;
        }

        case "declare": {
          const currency = a1;
          if (!currency || !/^[A-Za-z0-9_]+$/.test(currency)) {
            sys("usage: /note declare <currency>   (currency: letters, digits, _)");
            break;
          }
          if (currencyTokens.has(currency)) {
            sys(`you already issue ${currency}: ${currencyTokens.get(currency)}`);
            break;
          }
          const token = mintCurrencyToken(currency);
          currencyTokens.set(currency, token);
          const who = myName || (qpeer ? shortId(qpeer.peerId) : "local");
          knownCurrencies.set(token, { currency, token, issuer: who });
          saveNotes();
          renderNotes();
          sys(`declared currency: ${currency}`);
          sys(`  authority: ${token}`);
          sys(`  you can now /note grant ${currency} <N>`);
          signedBroadcast({ kind: "note-declare", currency, token, who });
          break;
        }

        case "grant": {
          // /note grant <currency> <N> [| terms text]. With terms, mint a
          // terms-stamped note (cap:note-<cur>~<hash>) and publish the series.
          const gFull = nParts.slice(1).join(" ");
          const gPipe = gFull.indexOf("|");
          const gHead = (gPipe === -1 ? gFull : gFull.slice(0, gPipe)).trim();
          const gTerms = gPipe === -1 ? "" : gFull.slice(gPipe + 1).trim();
          const gh = gHead.split(/\s+/);
          const currency = gh[0] || "";
          const N = parseInt(gh[1] ?? "", 10);
          if (!currency || !/^[A-Za-z0-9_]+$/.test(currency) || isNaN(N) || N < 1) {
            sys("usage: /note grant <currency> <N> [| terms & conditions text]");
            break;
          }
          if (!currencyTokens.has(currency)) {
            sys(`you don't hold cap:token-${currency}: declare it first with /note declare ${currency}`);
            break;
          }
          const who = myName || (qpeer ? shortId(qpeer.peerId) : "local");
          let note: string; let unit: string; let hash8 = "";
          if (gTerms) {
            hash8 = termsHash8(gTerms);
            unit = makeSeriesKey(currency, hash8);             // "USD~a1b2c3d4"
            note = mintNoteSeries(currency, hash8, N);
            if (!seriesTerms.has(unit)) {
              seriesTerms.set(unit, { seriesKey: unit, baseCurrency: currency, termsHash: hash8, terms: gTerms, issuer: who });
            }
            signedBroadcast({ kind: "note-series", seriesKey: unit, baseCurrency: currency, termsHash: hash8, terms: gTerms, who });
          } else {
            unit = currency;
            note = mintNote(currency, N);
          }
          noteStore.set(note, { token: note, currency: unit, denomination: N });
          saveNotes();
          renderNotes();
          sys(`minted: ${unit} ${N}${gTerms ? `  · 📜 terms ${hash8}` : ""}`);
          sys(`  ${note}`);
          if (gTerms) sys(`  terms: ${gTerms}`);
          if (qpeer) qpeer.broadcast({ kind: "note-grant", currency: unit, denomination: N, who });
          break;
        }

        case "pass": {
          const currency = a1;
          const N = parseInt(a2, 10);
          const targetName = nParts.slice(3).join(" ").trim();
          if (!currency || isNaN(N) || N < 1 || !targetName) {
            sys("usage: /note pass <currency> <N> <peer-name>");
            break;
          }
          if (!qpeer) { sys("not connected"); break; }
          const chosen = pickNote(currency, N);
          if (!chosen) { sys(`no ${currency} note of denomination ≥ ${N}`); break; }
          const targetId = findPeerByName(targetName);
          if (!targetId) { sys(`unknown peer: '${targetName}'`); break; }
          const detached = detach(chosen, N);
          if (!detached) { sys("split failed"); break; }
          const passTerms = seriesTerms.get(currency);
          const sent = qpeer.send(targetId, { kind: "note-pass", currency, denomination: N, token: detached.outgoing,
            ...(passTerms ? { terms: passTerms.terms, termsHash: passTerms.termsHash } : {}) });
          if (!sent) {
            undoDetach(chosen, detached.change);
            sys(`cannot reach ${targetName} — data channel not open`);
            break;
          }
          saveNotes();
          renderNotes();
          sys(`· ${currency} ${N} → ${targetName}`);
          sys(`  ${detached.outgoing}`);
          if (detached.change) sys(`  (change ${detached.change.denomination} returned to your wallet)`);
          break;
        }

        case "redeem": {
          const currency = a1;
          const N = parseInt(a2, 10);
          const issuerName = nParts.slice(3).join(" ").trim();
          if (!currency || isNaN(N) || N < 1 || !issuerName) {
            sys("usage: /note redeem <currency> <N> <issuer-peer>");
            break;
          }
          if (!qpeer) { sys("not connected"); break; }
          // Terms gate: redeeming a stamped note requires accepting its terms first.
          const redeemTerms = seriesTerms.get(currency);
          if (redeemTerms && !acceptedTerms.has(currency)) {
            sys(`⚠ ${currency} carries terms you have not accepted:`);
            sys(`  ${redeemTerms.terms}`);
            sys(`  review, then:  /note accept ${currency}   (then re-run redeem)`);
            break;
          }
          const chosen = pickNote(currency, N);
          if (!chosen) { sys(`no ${currency} note of denomination ≥ ${N} to redeem`); break; }
          const issuerId = findPeerByName(issuerName);
          if (!issuerId) { sys(`unknown peer: '${issuerName}'`); break; }
          const detached = detach(chosen, N);
          if (!detached) { sys("split failed"); break; }
          const sent = qpeer.send(issuerId, { kind: "note-redeem", currency, denomination: N, token: detached.outgoing });
          if (!sent) {
            undoDetach(chosen, detached.change);
            sys(`cannot reach ${issuerName} — data channel not open`);
            break;
          }
          saveNotes();
          renderNotes();
          sys(`· redeemed ${currency} ${N} → ${issuerName}`);
          sys(`  awaiting receipt…`);
          if (detached.change) sys(`  (change ${detached.change.denomination} returned to your wallet)`);
          break;
        }

        case "split": {
          const tokenArg = a1;
          const a = parseInt(a2, 10);
          if (!tokenArg || isNaN(a)) { sys("usage: /note split <token> <a>"); break; }
          const held = noteStore.get(tokenArg);
          if (!held) { sys(`you don't hold that note`); break; }
          const split = splitNote(tokenArg, a);
          if (!split) { sys(`invalid split: a must be 1..${held.denomination - 1}`); break; }
          const [t1, t2] = split;
          noteStore.delete(tokenArg);
          noteStore.set(t1, { token: t1, currency: held.currency, denomination: a });
          noteStore.set(t2, { token: t2, currency: held.currency, denomination: held.denomination - a });
          saveNotes();
          renderNotes();
          sys(`split ${held.currency} ${held.denomination}:`);
          sys(`  ${a}  ${t1}`);
          sys(`  ${held.denomination - a}  ${t2}`);
          break;
        }

        case "merge": {
          const t1Arg = a1;
          const t2Arg = aRest;
          if (!t1Arg || !t2Arg) { sys("usage: /note merge <token1> <token2>"); break; }
          const h1 = noteStore.get(t1Arg);
          const h2 = noteStore.get(t2Arg);
          if (!h1 || !h2) { sys("both tokens must be notes you hold"); break; }
          if (h1.currency !== h2.currency) { sys(`currency mismatch: ${h1.currency} vs ${h2.currency}`); break; }
          const merged = mergeNotes(t1Arg, t2Arg);
          if (!merged) { sys("merge failed"); break; }
          noteStore.delete(t1Arg);
          noteStore.delete(t2Arg);
          noteStore.set(merged, { token: merged, currency: h1.currency, denomination: h1.denomination + h2.denomination });
          saveNotes();
          renderNotes();
          sys(`merged ${h1.currency}: ${h1.denomination} + ${h2.denomination} = ${h1.denomination + h2.denomination}`);
          sys(`  ${merged}`);
          break;
        }

        case "terms":
        case "series": {
          const key = a1;
          if (!key) { sys("usage: /note terms <currency~hash | currency>"); break; }
          if (key.includes("~")) {
            const st = seriesTerms.get(key);
            if (!st) { sys(`no terms known for ${key} (not yet synced from its issuer)`); break; }
            sys(`terms for ${key}  (issuer ${st.issuer}):`);
            sys(`  ${st.terms}`);
            sys(`  hash ${st.termsHash}  ·  accepted: ${acceptedTerms.has(key) ? "✓" : "—  (/note accept " + key + ")"}`);
          } else {
            const list = [...seriesTerms.values()].filter(s => s.baseCurrency === key);
            if (list.length === 0) { sys(`no terms-series under ${key}`); break; }
            sys(`${key} terms-series (${list.length}):`);
            for (const s of list) sys(`  ${s.seriesKey}  — ${s.terms.slice(0, 56)}${s.terms.length > 56 ? "…" : ""}`);
          }
          break;
        }

        case "accept": {
          const key = a1;
          const st = key ? seriesTerms.get(key) : undefined;
          if (!st) { sys(`no terms known for '${key}' — cannot accept (try /note terms <currency>)`); break; }
          acceptedTerms.set(key, { termsHash: st.termsHash, at: Date.now() });
          saveNotes();
          renderNotes();
          sys(`✓ accepted terms for ${key}  (hash ${st.termsHash})`);
          break;
        }

        default:
          sys(`unknown subcommand: /note ${sub}`);
          sys("  /note [list]                        — show held notes / currencies / receipts");
          sys("  /note balance [currency]            — sum denominations");
          sys("  /note declare <currency>            — issue a new currency");
          sys("  /note grant <currency> <N> [| terms] — mint a note (with terms → a stamped series)");
          sys("  /note pass <currency> <N> <peer>    — transfer (auto-splits)");
          sys("  /note redeem <currency> <N> <peer>  — redeem with issuer, get receipt");
          sys("  /note terms <currency[~hash]>       — show a series' terms / list a currency's series");
          sys("  /note accept <currency~hash>        — accept a series' terms (required before redeem)");
          sys("  /note split <token> <a>             — split into (a, N-a)");
          sys("  /note merge <token1> <token2>       — combine two notes");
      }
      break;
    }

    case "rdv": {
      const rParts = arg.trim().split(/\s+/);
      const sub = (rParts[0] || "").toLowerCase();
      const a = rParts.slice(1);

      const findByPrefix = (prefix: string): ProposalState | null => {
        for (const [id, s] of proposals) if (id.startsWith(prefix)) return s;
        return null;
      };

      switch (sub) {
        case "":
        case "list": {
          if (proposals.size === 0 && lockedNotes.size === 0) {
            sys("no pending rendezvous proposals");
            sys("  /rdv swap <giveCur> <giveN> <getCur> <getN> <peer>  propose a 2-party swap");
            sys("  /rdv accept <id>   — accept a pending proposal");
            sys("  /rdv reject <id>   — decline");
            sys("  /rdv abort  <id>   — cancel a proposal you proposed");
            break;
          }
          if (proposals.size > 0) {
            sys(`proposals (${proposals.size}):`);
            const myId = qpeer?.peerId ?? "";
            for (const [id, s] of proposals) {
              const role = s.role === "proposer" ? "(yours)" : `from ${s.proposal.proposerName}`;
              const myRow = s.proposal.rows.find(r => r.participant === myId);
              const summary = myRow
                ? `you give ${myRow.gives.currency} ${myRow.gives.denomination}, get ${myRow.gets.currency} ${myRow.gets.denomination}`
                : "no row for you";
              sys(`  ${shortRdvId(id)}  ${role}  — ${summary}  [${s.myStatus}]`);
            }
          }
          if (lockedNotes.size > 0) {
            sys(`locked notes (${lockedNotes.size}):`);
            for (const lock of lockedNotes.values()) {
              sys(`  ${lock.currency} ${lock.denomination}  (for rdv ${shortRdvId(lock.proposalId)})`);
            }
          }
          break;
        }

        case "swap": {
          const giveCur    = a[0];
          const giveN      = parseInt(a[1] ?? "", 10);
          const getCur     = a[2];
          const getN       = parseInt(a[3] ?? "", 10);
          const targetName = a.slice(4).join(" ").trim();
          if (!giveCur || !getCur || isNaN(giveN) || isNaN(getN) || giveN < 1 || getN < 1 || !targetName) {
            sys("usage: /rdv swap <giveCur> <giveN> <getCur> <getN> <peer>");
            sys("  example: /rdv swap USD 30 EUR 20 Bob");
            break;
          }
          if (!qpeer) { sys("not connected"); break; }
          const targetId = findPeerByName(targetName);
          if (!targetId) { sys(`unknown peer: '${targetName}'`); break; }

          const chosen = pickFreeNote(giveCur, giveN);
          if (!chosen) { sys(`no ${giveCur} note of denomination ≥ ${giveN}`); break; }
          const detached = detachFromFree(chosen, giveN);
          if (!detached) { sys("split failed"); break; }

          const id = newProposalId();
          const myId = qpeer.peerId;
          const myLabel = myName || shortId(myId);
          const rows: Row[] = cyclicSwap(
            myId,    { currency: giveCur, denomination: giveN },
            targetId,{ currency: getCur,  denomination: getN  },
          );
          const proposal: Proposal = {
            id, proposer: myId, proposerName: myLabel, rows,
            expiresAt: Date.now() + RDV_TIMEOUT_MS,
          };
          const lockEntry: NoteEntry = {
            token: detached.outgoing, currency: giveCur, denomination: giveN,
            receivedFrom: chosen.receivedFrom,
          };
          lockToken(detached.outgoing, lockEntry, id);
          proposals.set(id, {
            proposal, role: "proposer", myStatus: "accepted",
            acceptedBy: new Map([[myId, detached.outgoing]]),
          });
          scheduleProposalTimeout(id, RDV_TIMEOUT_MS);
          saveNotes();
          renderNotes();

          const sent = qpeer.send(targetId, { kind: "rdv-propose", proposal });
          if (!sent) {
            releaseLockedFor(id);
            proposals.delete(id);
            clearProposalTimeout(id);
            saveNotes();
            renderNotes();
            sys(`cannot reach ${targetName} — data channel not open`);
            break;
          }
          sys(`· proposed rendezvous ${shortRdvId(id)} to ${targetName}`);
          sys(`  you give ${giveCur} ${giveN}, get ${getCur} ${getN}`);
          sys(`  expires in ${Math.round(RDV_TIMEOUT_MS / 1000)}s — /rdv abort ${shortRdvId(id)} to cancel`);
          if (detached.change) sys(`  (change ${detached.change.denomination} returned to your wallet)`);
          break;
        }

        case "accept": {
          const prefix = a[0];
          if (!prefix) { sys("usage: /rdv accept <id>"); break; }
          if (!qpeer) { sys("not connected"); break; }
          const state = findByPrefix(prefix);
          if (!state) { sys(`no proposal matching '${prefix}'`); break; }
          const myId = qpeer.peerId;
          const isProposer = state.role === "proposer";
          // Proposer-after-counter case: state.role is still "proposer" but
          // acceptedBy was cleared by the inbound counter handler, so the
          // proposer must re-accept the new terms. For a participant, the
          // myStatus flag tracks acceptance.
          const alreadyAccepted = isProposer
            ? state.acceptedBy.has(myId)
            : state.myStatus === "accepted";
          if (alreadyAccepted) { sys(`already accepted`); break; }
          const myRows = state.proposal.rows.filter(r => r.participant === myId);
          if (myRows.length === 0) { sys("you have no row in this rendezvous"); break; }
          if (myRows.length > 1) { sys("multi-row participation not yet supported"); break; }
          const row = myRows[0];

          const chosen = pickFreeNote(row.gives.currency, row.gives.denomination);
          if (!chosen) {
            sys(`cannot accept: no free ${row.gives.currency} note of denomination ≥ ${row.gives.denomination}`);
            break;
          }
          const detached = detachFromFree(chosen, row.gives.denomination);
          if (!detached) { sys("split failed"); break; }
          const lockEntry: NoteEntry = {
            token: detached.outgoing, currency: row.gives.currency, denomination: row.gives.denomination,
            receivedFrom: chosen.receivedFrom,
          };
          lockToken(detached.outgoing, lockEntry, state.proposal.id);

          if (isProposer) {
            // Local accept: record in acceptedBy and run the same
            // "all-accepted → commit" path the inbound rdv-accept handler
            // does. No envelope sent (we *are* the proposer).
            state.acceptedBy.set(myId, detached.outgoing);
            saveNotes();
            renderNotes();
            sys(`· re-accepted rendezvous ${shortRdvId(state.proposal.id)} on the new terms`);
            sys(`  locked ${row.gives.currency} ${row.gives.denomination}`);
            if (detached.change) sys(`  (change ${detached.change.denomination} returned to your wallet)`);
            const participants = uniqueParticipants(state.proposal);
            if (!participants.every(p => state.acceptedBy.has(p))) break;
            // All-accepted — build and dispatch the commit.
            const N = state.proposal.rows.length;
            const commitRows: CommitRow[] = state.proposal.rows.map((r, i) => {
              const nextRow = state.proposal.rows[(i + 1) % N];
              return {
                participant: r.participant,
                givesToken: state.acceptedBy.get(r.participant)!,
                getsToken:  state.acceptedBy.get(nextRow.participant)!,
              };
            });
            for (const p of participants) {
              if (p === myId) continue;
              qpeer.send(p, { kind: "rdv-commit", id: state.proposal.id, rows: commitRows });
            }
            const ok = applyCommit(state, commitRows);
            proposals.delete(state.proposal.id);
            clearProposalTimeout(state.proposal.id);
            saveNotes();
            renderNotes();
            sys(ok ? `  · committed rdv ${shortRdvId(state.proposal.id)}` : `  · commit application failed locally`);
            break;
          }

          // Participant path — original behavior.
          state.myStatus = "accepted";
          saveNotes();
          renderNotes();

          const sent = qpeer.send(state.proposal.proposer, {
            kind: "rdv-accept", id: state.proposal.id, token: detached.outgoing,
          });
          if (!sent) {
            releaseLockedFor(state.proposal.id);
            state.myStatus = "pending";
            saveNotes();
            renderNotes();
            sys("cannot reach proposer — try again");
            break;
          }
          sys(`· accepted rendezvous ${shortRdvId(state.proposal.id)}`);
          sys(`  locked ${row.gives.currency} ${row.gives.denomination}; awaiting commit…`);
          if (detached.change) sys(`  (change ${detached.change.denomination} returned to your wallet)`);
          break;
        }

        case "reject": {
          const prefix = a[0];
          if (!prefix) { sys("usage: /rdv reject <id>"); break; }
          const state = findByPrefix(prefix);
          if (!state) { sys(`no proposal matching '${prefix}'`); break; }
          if (state.role !== "participant") { sys("you proposed this; use /rdv abort instead"); break; }
          if (state.myStatus !== "pending") { sys(`already ${state.myStatus}`); break; }
          if (qpeer) qpeer.send(state.proposal.proposer, { kind: "rdv-reject", id: state.proposal.id });
          proposals.delete(state.proposal.id);
          clearProposalTimeout(state.proposal.id);
          saveNotes();
          renderNotes();
          sys(`· rejected rendezvous ${shortRdvId(state.proposal.id)}`);
          break;
        }

        case "abort": {
          const prefix = a[0];
          if (!prefix) { sys("usage: /rdv abort <id>"); break; }
          const state = findByPrefix(prefix);
          if (!state) { sys(`no proposal matching '${prefix}'`); break; }
          if (state.role !== "proposer") { sys("you didn't propose this; use /rdv reject instead"); break; }
          releaseLockedFor(state.proposal.id);
          if (qpeer) {
            const self = qpeer.peerId;
            const targets = uniqueParticipants(state.proposal).filter(p => p !== self);
            for (const t of targets) qpeer.send(t, { kind: "rdv-abort", id: state.proposal.id, reason: "proposer-cancel" });
          }
          proposals.delete(state.proposal.id);
          clearProposalTimeout(state.proposal.id);
          saveNotes();
          renderNotes();
          sys(`· aborted rendezvous ${shortRdvId(state.proposal.id)}`);
          break;
        }

        case "counter": {
          // /rdv counter <id> <giveCur> <giveN> <getCur> <getN>
          //
          // Propose new terms in an existing 2-party rendezvous. The current
          // round's locks (mine and theirs, if accepted) are released; the
          // proposal's rows are replaced with the new cyclic swap; my new
          // gives token is locked; an rdv-counter envelope is sent to the
          // other participant; my status is "accepted" (I just chose these
          // terms); their status is reset to "pending". Either party can
          // counter at any pending state; this round-robins until accept,
          // reject, abort, or timeout.
          if (!qpeer) { sys("not connected"); break; }
          const prefix = a[0];
          const giveCur = a[1];
          const giveN   = parseInt(a[2] ?? "", 10);
          const getCur  = a[3];
          const getN    = parseInt(a[4] ?? "", 10);
          if (!prefix || !giveCur || !getCur || isNaN(giveN) || isNaN(getN) || giveN < 1 || getN < 1) {
            sys("usage: /rdv counter <id> <giveCur> <giveN> <getCur> <getN>");
            sys("  example: /rdv counter a3f1c2 USD 25 EUR 20");
            break;
          }
          const state = findByPrefix(prefix);
          if (!state) { sys(`no proposal matching '${prefix}'`); break; }
          const myId = qpeer.peerId;
          const otherId = uniqueParticipants(state.proposal).find(p => p !== myId);
          if (!otherId) { sys("no other participant to counter to"); break; }

          // Release current locks (both my own and the other's, if any).
          releaseLockedFor(state.proposal.id);
          state.acceptedBy.clear();

          // Replace the proposal's rows with the new cyclic swap.
          const myName2 = myName || shortId(myId);
          const newRows: Row[] = cyclicSwap(
            myId,    { currency: giveCur, denomination: giveN },
            otherId, { currency: getCur,  denomination: getN  },
          );
          state.proposal.rows = newRows;
          state.proposal.proposerName = myName2;   // attribute the latest terms to the counterer
          state.proposal.expiresAt = Date.now() + RDV_TIMEOUT_MS;
          clearProposalTimeout(state.proposal.id);
          scheduleProposalTimeout(state.proposal.id, RDV_TIMEOUT_MS);

          // Lock my new gives token.
          const chosen = pickFreeNote(giveCur, giveN);
          if (!chosen) {
            sys(`cannot counter: no free ${giveCur} note of denomination ≥ ${giveN}`);
            break;
          }
          const detached = detachFromFree(chosen, giveN);
          if (!detached) { sys("split failed"); break; }
          const lockEntry: NoteEntry = {
            token: detached.outgoing, currency: giveCur, denomination: giveN,
            receivedFrom: chosen.receivedFrom,
          };
          lockToken(detached.outgoing, lockEntry, state.proposal.id);
          state.acceptedBy.set(myId, detached.outgoing);
          state.myStatus = "accepted";   // I implicitly accept my own counter
          saveNotes();
          renderNotes();

          // Send the counter envelope, including the token I just locked so
          // the recipient can record it in their acceptedBy for the eventual
          // commit construction.
          const sent = qpeer.send(otherId, {
            kind: "rdv-counter", id: state.proposal.id, rows: newRows,
            proposerName: myName2, token: detached.outgoing,
          });
          if (!sent) {
            releaseLockedFor(state.proposal.id);
            state.acceptedBy.delete(myId);
            sys("cannot reach the other participant — counter not delivered");
            break;
          }
          sys(`· counter sent for rendezvous ${shortRdvId(state.proposal.id)}`);
          sys(`  new terms: you give ${giveCur} ${giveN}, get ${getCur} ${getN}`);
          if (detached.change) sys(`  (change ${detached.change.denomination} returned to your wallet)`);
          break;
        }

        default:
          sys(`unknown subcommand: /rdv ${sub}`);
          sys("  /rdv [list]                                        — show pending proposals");
          sys("  /rdv swap <giveCur> <giveN> <getCur> <getN> <peer> — propose a 2-party swap");
          sys("  /rdv counter <id> <giveCur> <giveN> <getCur> <getN> — propose new terms in an existing rendezvous");
          sys("  /rdv accept <id>                                   — accept current terms");
          sys("  /rdv reject <id>                                   — decline");
          sys("  /rdv abort  <id>                                   — cancel your proposal");
      }
      break;
    }

    case "probe": {
      const sub = (arg.trim().split(/\s+/)[0] || "status").toLowerCase();
      if (sub === "status") {
        sys(`probe window: ${probe.open ? "open" : "closed"}`);
        if (probe.open) {
          sys(`  contributors so far: ${probe.contributors.size}/${SAMPLE_SIZE}`);
          sys(`  observations: ${probe.observations.length}`);
        }
        sys(`ignored-for-sync peers (${ignoredForSync.size}):`);
        for (const p of ignoredForSync) sys(`  ${peerLabel(p)}  (${p.slice(0, 16)}…)`);
      } else if (sub === "clear") {
        const n = ignoredForSync.size;
        ignoredForSync.clear();
        saveNotes();
        sys(`cleared ${n} ignored-for-sync entries`);
      } else {
        sys(`unknown subcommand: /probe ${sub}`);
        sys("  /probe [status]  — show probe window state and ignored peers");
        sys("  /probe clear     — clear the ignored-for-sync list");
      }
      break;
    }

    case "dyncap": {
      const sub = (arg.trim().split(/\s+/)[0] || "status").toLowerCase();
      if (sub === "whoami" || sub === "status") {
        if (!dyncapState) { sys("dyncap not initialized"); break; }
        const currentRoom = activeRoom.roomId;
        const seqHere = dyncapState.seqByRoom[currentRoom] ?? 0;
        sys(`dyncap anchor: cap:peer/dyn:${dyncapState.anchor}`);
        sys(`  seq in this room: ${seqHere}`);
        const roomCount = Object.keys(dyncapState.seqByRoom).length;
        if (roomCount > 1) sys(`  rooms with chain history: ${roomCount}`);
        sys(`  chain peers:      ${dyncapChains.size}`);
      } else if (sub === "peers") {
        if (dyncapChains.size === 0) { sys("no dyncap peers tracked yet"); break; }
        sys(`tracked peers (${dyncapChains.size}):`);
        for (const [peerId, entry] of dyncapChains) {
          const flag = entry.contested ? "  ⚠ CONTESTED" : "";
          sys(`  ${peerLabel(peerId)}  anchor: ${entry.anchor.slice(0, 16)}…  lastSeq: ${entry.lastSeq}${flag}`);
        }
      } else {
        sys(`unknown subcommand: /dyncap ${sub}`);
        sys("  /dyncap [status]  — show your anchor, current seq, tracked peer count");
        sys("  /dyncap peers     — list tracked peers with their pinned anchors");
      }
      break;
    }

    case "persist": {
      // /persist <selector> to <peer>   — ask peer to also store this item
      // /persist accept <id>            — accept a pending inbound request
      // /persist reject <id>            — discard a pending inbound request
      // /persist list                   — show pending inbound requests
      //
      // Cross-peer redundancy of public room knowledge. The receiver
      // explicitly opts in, so persistence is "by agreement" — the asker
      // requests, the receiver consents. On future startups, the existing
      // consensus probe + supermajority resolution reconciles any drift
      // across the now-redundant copies.
      const pParts = arg.trim().split(/\s+/);
      const sub = (pParts[0] || "list").toLowerCase();
      if (sub === "list" || sub === "") {
        if (pendingPersistRequests.size === 0) {
          sys("no pending persist requests");
          sys("  /persist @<lemma> to <peer>       — ask peer to store the lemma too");
          sys("  /persist currency <name> to <peer> — ask peer to store the currency declaration");
          sys("  /persist accept <id>              — accept an incoming request");
          break;
        }
        sys(`pending persist requests (${pendingPersistRequests.size}):`);
        for (const [id, req] of pendingPersistRequests) {
          const desc = req.kind === "lemma"
            ? `@${req.lemmaName} = ${req.lemmaEntry?.twists ?? "?"}`
            : `currency ${req.currencyEntry?.currency ?? "?"}  (token ${req.currencyToken?.slice(0, 24) ?? "?"}…)`;
          sys(`  ${id.slice(0, 8)}  from ${req.fromName}  →  ${desc}`);
        }
      } else if (sub === "accept") {
        const prefix = pParts[1] ?? "";
        if (!prefix) { sys("usage: /persist accept <id>"); break; }
        let found: PersistRequest | null = null;
        let foundId = "";
        for (const [id, req] of pendingPersistRequests) {
          if (id.startsWith(prefix)) { found = req; foundId = id; break; }
        }
        if (!found) { sys(`no pending request matching '${prefix}'`); break; }
        if (found.kind === "lemma" && found.lemmaName && found.lemmaEntry) {
          const name = found.lemmaName;
          const entry = found.lemmaEntry;
          const existing = lemmaStore.get(name);
          if (existing && existing.twists !== entry.twists) {
            sys(`· refused: you already hold @${name} with different twists (${existing.twists})`);
            sys(`  (the room's consensus probe will resolve this on next join)`);
            break;
          }
          if (!existing) {
            lemmaStore.set(name, entry);
            saveLemmas();
            renderLemmas();
          }
          sys(`· accepted: now persisting @${name} (${entry.twists})`);
        } else if (found.kind === "currency" && found.currencyToken && found.currencyEntry) {
          const tok = found.currencyToken;
          if (!knownCurrencies.has(tok)) {
            knownCurrencies.set(tok, found.currencyEntry);
            saveNotes();
            renderNotes();
          }
          sys(`· accepted: now persisting currency ${found.currencyEntry.currency} (issued by ${found.currencyEntry.issuer})`);
        }
        pendingPersistRequests.delete(foundId);
      } else if (sub === "reject") {
        const prefix = pParts[1] ?? "";
        if (!prefix) { sys("usage: /persist reject <id>"); break; }
        let foundId = "";
        for (const id of pendingPersistRequests.keys()) {
          if (id.startsWith(prefix)) { foundId = id; break; }
        }
        if (!foundId) { sys(`no pending request matching '${prefix}'`); break; }
        pendingPersistRequests.delete(foundId);
        sys(`· rejected persist request ${foundId.slice(0, 8)}`);
      } else if (sub.startsWith("@") || sub === "currency") {
        // Outbound request: /persist <selector> to <peer>
        if (!qpeer) { sys("not connected"); break; }
        const toIdx = pParts.lastIndexOf("to");
        if (toIdx < 1 || toIdx >= pParts.length - 1) {
          sys("usage: /persist <@lemma | currency <name>> to <peer>");
          break;
        }
        const targetName = pParts.slice(toIdx + 1).join(" ").trim();
        const targetId = findPeerByName(targetName);
        if (!targetId) { sys(`unknown peer: '${targetName}'`); break; }

        const reqId = Array.from(crypto.getRandomValues(new Uint8Array(8)))
          .map(b => b.toString(16).padStart(2, "0")).join("");
        const myLabel = myName || (qpeer ? shortId(qpeer.peerId) : "local");
        let payload: Record<string, unknown> | null = null;

        if (sub.startsWith("@")) {
          const name = parseLemmaNameArg(sub);
          const entry = lemmaStore.get(name);
          if (!entry) { sys(`you don't hold ${lemmaRefStr(name)}`); break; }
          payload = {
            kind: "persist-request", id: reqId, persistKind: "lemma",
            fromName: myLabel,
            lemmaName: name, lemmaEntry: entry,
          };
          sys(`· requesting ${targetName} to also persist @${name}`);
        } else {
          // sub === "currency"
          const cname = pParts[1] ?? "";
          if (!cname) { sys("usage: /persist currency <name> to <peer>"); break; }
          // Find the currency entry in knownCurrencies (any token I know with this name).
          let cEntry: KnownCurrency | null = null;
          let cTok = "";
          for (const [tok, e] of knownCurrencies) {
            if (e.currency === cname) { cEntry = e; cTok = tok; break; }
          }
          if (!cEntry) { sys(`unknown currency '${cname}' in this room`); break; }
          payload = {
            kind: "persist-request", id: reqId, persistKind: "currency",
            fromName: myLabel,
            currencyToken: cTok, currencyEntry: cEntry,
          };
          sys(`· requesting ${targetName} to also persist currency ${cname}`);
        }
        if (payload) qpeer.send(targetId, payload);
      } else {
        sys(`unknown subcommand: /persist ${sub}`);
        sys("  /persist @<lemma> to <peer>        — request peer to also persist");
        sys("  /persist currency <name> to <peer> — request peer to also persist");
        sys("  /persist accept <id>               — accept a pending inbound request");
        sys("  /persist reject <id>               — discard a pending inbound request");
        sys("  /persist list                      — show pending requests");
      }
      break;
    }

    case "channel": {
      // /channel listen <name>        — subscribe in this room
      // /channel unlisten <name>      — unsubscribe
      // /channel send <name> <text>   — broadcast a tagged message
      // /channel list                 — show subscriptions
      const cParts = arg.trim().split(/\s+/);
      const sub = (cParts[0] || "list").toLowerCase();
      const name = cParts[1] ?? "";
      if (sub === "list" || sub === "") {
        if (channelSubscriptions.size === 0) {
          sys("no channel subscriptions in this room");
          sys("  /channel listen <name>      — subscribe");
          sys("  /channel send <name> <text> — broadcast");
        } else {
          sys(`channel subscriptions (${channelSubscriptions.size}):`);
          for (const n of channelSubscriptions) sys(`  ${n}`);
        }
      } else if (sub === "listen") {
        if (!name) { sys("usage: /channel listen <name>"); break; }
        if (channelSubscriptions.has(name)) { sys(`already listening on '${name}'`); break; }
        channelSubscriptions.add(name);
        saveNotes();
        sys(`· listening on channel '${name}'`);
      } else if (sub === "unlisten") {
        if (!name) { sys("usage: /channel unlisten <name>"); break; }
        if (!channelSubscriptions.has(name)) { sys(`not listening on '${name}'`); break; }
        channelSubscriptions.delete(name);
        saveNotes();
        sys(`· unlistened from channel '${name}'`);
      } else if (sub === "send") {
        const text = cParts.slice(2).join(" ");
        if (!name || !text) { sys("usage: /channel send <name> <text>"); break; }
        if (!qpeer) { sys("not connected"); break; }
        // Tagged broadcast. Receivers without a matching subscription drop it.
        qpeer.broadcast({ kind: "channel-msg", channel: name, payload: text });
        sys(`· sent on channel '${name}': ${text}`);
      } else {
        sys(`unknown subcommand: /channel ${sub}`);
        sys("  /channel [list]              — show subscriptions");
        sys("  /channel listen <name>       — subscribe");
        sys("  /channel unlisten <name>     — unsubscribe");
        sys("  /channel send <name> <text>  — broadcast a tagged message");
      }
      break;
    }

    case "rhoqu": {
      const src = arg.trim();
      // Subcommands for managing registered on-handlers.
      if (src === "list") {
        if (rhoquHandlers.length === 0) {
          sys("no rhoqu on-handlers registered in this room");
        } else {
          sys(`rhoqu on-handlers (${rhoquHandlers.length}):`);
          for (const h of rhoquHandlers) sys(`  on ${h.channel}(${h.binding}) { … }`);
        }
        break;
      }
      if (src === "clear") {
        const n = rhoquHandlers.length;
        rhoquHandlers.length = 0;
        activeRoom.rhoquHandlers = rhoquHandlers;   // keep RoomContext field in sync
        sys(`cleared ${n} rhoqu on-handler${n === 1 ? "" : "s"}`);
        break;
      }
      if (!src) {
        sys("usage: /rhoqu <source>");
        sys("  /rhoqu list                          — show registered on-handlers");
        sys("  /rhoqu clear                         — drop all on-handlers in this room");
        sys("  process P(a, b) { /grant $a; /lemma $b; } P(fork-a, alice);");
        sys("  if has(@met-bob) { /qucalc @met-bob; } else { /lemma met-bob ^v; }");
        sys("  on forks(msg) { /qucalc @msg; }      — register a channel-msg handler");
        break;
      }
      const rhoCtx: RhoQuContext = {
        hasLemma:  (name) => lemmaStore.has(canonLemma(name)),
        balance:   (currency) => {
          let total = 0;
          for (const n of noteStore.values()) if (n.currency === currency) total += n.denomination;
          return total;
        },
        isCurrencyDeclared: (name) => {
          for (const e of knownCurrencies.values()) if (e.currency === name) return true;
          return false;
        },
        peerCount:    () => peers.size,
        isConnected:  () => qpeer !== null,
        myCurrentSeq: () => dyncapState?.seqByRoom[activeRoom.roomId] ?? 0,
        registerOnHandler: (h) => { rhoquHandlers.push(h); },
      };
      let cmds: string[];
      try {
        cmds = rhoquTranspile(src, rhoCtx);
      } catch (e) {
        if (e instanceof RhoQuError) sys(`· ${e.message}`);
        else sys(`· rhoqu parse error: ${String(e)}`);
        break;
      }
      const handlersAfter = rhoquHandlers.length;
      sys(`· rhoqu transpiled to ${cmds.length} command${cmds.length === 1 ? "" : "s"}`);
      let executed = 0;
      for (const c of cmds) {
        try { runInput(c); executed++; }
        catch (err) { sys(`· rhoqu error on '${c}': ${String(err)}`); }
      }
      sys(`· rhoqu: ${executed} executed${handlersAfter > 0 ? `, ${handlersAfter} on-handler${handlersAfter === 1 ? "" : "s"} active` : ""}`);
      break;
    }

    case "script": {
      // /script cmd1; cmd2; cmd3
      //
      // Sequential command chain — each `;`-separated segment is run
      // through handleCommand exactly as if typed individually. Comments
      // (// prefix on a segment after trimming) are skipped. Errors in
      // one segment don't stop subsequent ones; each segment's output
      // appears in chat in order.
      const segments = arg.split(";").map(s => s.trim()).filter(s => s.length > 0);
      if (segments.length === 0) {
        sys("usage: /script <cmd1>; <cmd2>; <cmd3>");
        sys("  example: /script /grant fork-a; /lemma alice-thinking; /qucalc @alice-thinking");
        sys("  comments: //  (a segment beginning with // is skipped)");
        break;
      }
      let executed = 0;
      let skipped  = 0;
      for (const seg of segments) {
        if (seg.startsWith("//")) { skipped++; continue; }
        const cmdStr = seg.startsWith("/") || seg.startsWith("+") ? seg : "/" + seg;
        try {
          runInput(cmdStr);
          executed++;
        } catch (e) {
          sys(`· script error on '${seg}': ${String(e)}`);
        }
      }
      sys(`· script: ${executed} executed${skipped > 0 ? `, ${skipped} skipped (comments)` : ""}`);
      break;
    }

    case "share": {
      // /share <selector> to <room-prefix>
      // Selectors:
      //   @<lemma-name>            re-declare the lemma in the target room
      //   msg <text>               post a chat-text message into the target room
      //   note <currency> <N>      re-mint a note (target room must hold cap:token-<currency>)
      //
      // The bridge is application-level: we briefly swap activeRoom to the
      // target context and call the existing dispatcher commands there. The
      // target room sees the action exactly as if the user typed it locally.
      const sParts = arg.trim().split(/\s+/);
      const toIdx = sParts.lastIndexOf("to");
      if (toIdx < 1 || toIdx >= sParts.length - 1) {
        sys("usage: /share <selector> to <room-prefix>");
        sys("  selectors: @<lemma>  |  msg <text>  |  note <currency> <N>");
        break;
      }
      const selector  = sParts.slice(0, toIdx).join(" ");
      const targetArg = sParts.slice(toIdx + 1).join(" ");

      // Resolve target room by prefix-match on roomId; reject ambiguous/empty.
      let target: RoomContext | null = null;
      const matches: RoomContext[] = [];
      for (const ctx of rooms.values()) {
        if (ctx.roomId === activeRoom.roomId) continue;
        if (ctx.roomId.startsWith(targetArg) || ctx.roomId === targetArg) matches.push(ctx);
      }
      if (matches.length === 0) { sys(`no other room matches '${targetArg}'`); break; }
      if (matches.length > 1) {
        sys(`ambiguous target '${targetArg}' — matches:`);
        for (const m of matches) sys(`  ${m.roomId}`);
        break;
      }
      target = matches[0];

      // Selector dispatch. We swap activeRoom to the target for the duration
      // of the bridged action, run the same handleCommand path that a local
      // tab would use, then restore. The bridged action lands in the target
      // room with the bridge peer's dyncap chain in *that* room — no new
      // wire kinds, no infrastructure relay.
      const runIn = (ctx: RoomContext, cmd: string): string[] => {
        const prev = activeRoom; setActiveRoom(ctx);
        try { return handleCommand(cmd); } finally { setActiveRoom(prev); }
      };

      if (selector.startsWith("@")) {
        const lemmaName = parseLemmaNameArg(selector);
        const entry = lemmaStore.get(lemmaName);
        if (!entry) { sys(`you don't hold ${lemmaRefStr(lemmaName)} in this room — nothing to share`); break; }
        sys(`· sharing ${lemmaRefStr(lemmaName)} → ${shortId(target.roomId)}`);
        runIn(target, `/lemma ${lemmaArgStr(lemmaName)} ${entry.twists}`);
      } else if (selector.startsWith("msg ")) {
        const text = selector.slice(4);
        sys(`· sharing chat → ${shortId(target.roomId)}`);
        // Direct chat envelope; this is the only path that doesn't reuse a
        // dispatcher command (because chat doesn't have one). Send it raw
        // through the target room's qpeer if connected.
        if (target.qpeer) {
          target.qpeer.broadcast({ kind: "chat", text });
          // Also reflect into the target's local chat log so the bridge peer
          // sees what they sent.
          const prev = activeRoom; setActiveRoom(target);
          try { addMessage("", text, "self"); } finally { setActiveRoom(prev); }
        } else {
          sys(`  · target room not connected — message not sent`);
        }
      } else if (selector.startsWith("note ")) {
        const noteParts = selector.slice(5).trim().split(/\s+/);
        const currency = noteParts[0];
        const N = parseInt(noteParts[1] ?? "", 10);
        if (!currency || isNaN(N) || N < 1) {
          sys("usage: /share note <currency> <N> to <room-prefix>");
          break;
        }
        sys(`· minting ${currency} ${N} in ${shortId(target.roomId)} (requires target to hold cap:token-${currency})`);
        runIn(target, `/note grant ${currency} ${N}`);
      } else {
        sys(`unknown selector: '${selector}'`);
        sys("  selectors: @<lemma>  |  msg <text>  |  note <currency> <N>");
        sys("  example: /share @met-bob to 02460246");
      }
      break;
    }

    case "room": {
      const rParts = arg.trim().split(/\s+/);
      const sub = (rParts[0] || "list").toLowerCase();
      if (sub === "list" || sub === "") {
        const room = activeRoom.roomId;
        const tw = tokenTwists(room);
        // The transcript is on screen and in any recording of it, so a hidden
        // cap stays hidden here too. `/room ref` is the deliberate way to say it.
        sys(`active room: ${hideRoom ? shortId(room) + "   (hidden — /room ref to print it)" : room}`);
        if (tw) {
          const { pos, neg, gap, balanced } = twistStats(tw);
          sys(`  twists: ${tw.length}  (${pos} pos, ${neg} neg)  gap: ${gap}  ZFA: ${balanced ? "✓" : "✗"}`);
        }
        sys(`joined rooms (${rooms.size}):`);
        for (const ctx of rooms.values()) {
          const active = ctx.roomId === activeRoom.roomId ? " ←" : "";
          const connected = ctx.qpeer ? "  ●" : "";
          const full = hideRoom ? "" : `  ${ctx.roomId}`;
          sys(`  ${shortId(ctx.roomId)}${full}${connected}${active}`);
        }
      } else if (sub === "join") {
        const target = rParts.slice(1).join(" ").trim();
        const roomId = extractRoomCap(target);
        if (!roomId) { sys("usage: /room join <cap:room:…> | <share-url>"); break; }
        // Warn, don't refuse: a room minted before v0.17's Pauli-closure
        // requirement (the public room, cap:room:0521…4721, is one) fails
        // validateCapability yet is exactly what the share link opens — the
        // URL-hash path and connect() both only warn, and the agents
        // "continue" past the same check. Refusing here made the documented
        // public room unjoinable by command while its link worked, which
        // read as "0 peers" with no explanation.
        if (!validateCapability(roomId)) sys(`⚠ room cap is not ZFA-closed (a legacy token?) — joining anyway: ${roomId}`);
        openRoomTab(roomId);
        sys(`joined room ${shortId(roomId)} (switched to new tab)`);
      } else if (sub === "leave") {
        if (rooms.size <= 1) { sys("cannot leave the last room"); break; }
        const leavingId = activeRoom.roomId;
        closeRoomTab(leavingId);
        sys(`left room ${shortId(leavingId)}`);
      } else if (sub === "hide" || sub === "show") {
        setHideRoom(sub === "hide");
        sys(hideRoom
          ? "room capability hidden — out of the address bar, the share row and the sidebar. "
            + "Anyone watching your screen can no longer read it; copy (or /room ref) still shares it."
          : `room capability visible — ${activeRoom.roomId}`);
      } else if (sub === "ref") {
        const target = rParts.slice(1).join(" ").trim();
        const roomId = extractRoomCap(target) || activeRoom.roomId;
        sys(`room: ${roomId}`);
        sys(`  share URL: ${window.location.origin}${window.location.pathname}#room=${roomId}`);
      } else {
        sys(`unknown subcommand: /room ${sub}`);
        sys("  /room list                       — list joined rooms");
        sys("  /room join <cap:room:…|url>      — open a new tab for the named room");
        sys("  /room leave                      — close the active tab");
        sys("  /room ref [cap:room:…]           — print a shareable URL for a room");
        sys("  /room hide | show                — keep the room capability off screen, or put it back");
      }
      break;
    }

    // Room-agent commands (agent.mjs roles). The browser doesn't implement any of
    // these — it relays the command into the room as chat so an agent daemon (a peer)
    // can parse and answer it. Add new role command-prefixes here when you add a role.
    case "facil":
    case "facilitator":
    case "scribe":
    case "skeptic":
    case "observer":
    case "greeter": {
      // An agent cannot know your REV address — it is derived from a key only
      // this browser holds — so anything that needs one has to carry it. A
      // bare `faucet` is the case that matters: being asked "what's your REV
      // address?" by something that could not possibly know it, when the
      // browser knows it perfectly well, is a question that should not be
      // asked. `$me` is resolved here too, so it works in any agent command.
      let relayArg = arg;
      const agentVerb = arg.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
      if ((agentVerb === "faucet" || agentVerb === "testrev") && !arg.trim().slice(agentVerb.length).trim()) {
        const k = loadNodeConfig().key;
        if (k) {
          try { relayArg = `${agentVerb} ${revAddressOf(k)}`; } catch { /* keep the bare form */ }
        } else {
          sys("no deploy key yet, so there is no address to ask for — /rholang key generate first");
          break;
        }
      } else if (/\$me\b/.test(arg)) {
        relayArg = resolveClientTokens(arg, sys);
        // resolveClientTokens quotes it for rholang; an agent wants it bare.
        relayArg = relayArg.replace(/"(1111[1-9A-HJ-NP-Za-km-z]{20,60})"/g, "$1");
      }
      const out = "/" + cmd + (relayArg ? " " + relayArg : "");
      if (qpeer) qpeer.broadcast({ kind: "chat", text: out });
      sys(`→ relayed to the room's ${cmd} agent(s) — each answers for itself (there may be several, or none). The browser doesn't vouch for any.`);
      break;
    }

    case "password": {
      // Encrypt the current identity (the dyncap seed) under a password and
      // hand back a recovery string. The password is collected via a masked
      // dialog, never inline, so it never touches the chat log or a broadcast.
      if (arg.trim().toLowerCase() === "show") {
        const saved = localStorage.getItem("qos-vault");
        if (saved) { sys("your saved recovery string (keep it private):"); sys(saved); }
        else sys("no recovery string saved yet — run /password to create one");
        break;
      }
      if (!dyncapState) { sys("identity not ready yet — try again in a moment"); break; }
      void (async () => {
        const res = await secureDialog("Set identity password", [
          { label: "Password", type: "password", placeholder: "choose a strong password" },
          { label: "Confirm password", type: "password" },
        ], "Encrypt");
        if (!res) { addMessage("", "password: cancelled", "system"); return; }
        const [pw, confirm] = res;
        if (!pw) { addMessage("", "password was empty — nothing changed", "system"); return; }
        if (pw !== confirm) { addMessage("", "passwords did not match — nothing changed", "system"); return; }
        if (!dyncapState) { addMessage("", "identity not ready", "system"); return; }
        const anchor = dyncapState.anchor;
        const plaintext = JSON.stringify({ v: 1, state: serializeState(dyncapState), name: myName });
        const vault = await encryptVault(pw, plaintext);
        localStorage.setItem("qos-vault", vault);
        addMessage("", "🔐 identity encrypted. Save this recovery string to restore your identity in another browser (re-show later with /password show):", "system");
        addMessage("", vault, "system");
        addMessage("", "⚠ anyone with this string AND your password can become you — keep it private.", "system");
        // Also replicate it into any group I'm a member of (pure p2p), so I can
        // recover with just a handle + password after rejoining — no blob to carry.
        const handle = canonHandle(myName);
        const myGroups = [...groupStore.values()].filter((g) => isMember(g, myPeerId(), anchor));
        if (myGroups.length && handle) {
          const now = Date.now();
          for (const g of myGroups) govPublishVault(g, { handle, anchor, blob: vault, at: now });
          addMessage("", `↪ published to ${myGroups.length} group(s) as handle “${handle}”. In a new browser, join the group's room and run /login ${handle}.`, "system");
        } else if (myGroups.length && !handle) {
          addMessage("", "set a display name first — it's your recovery handle — then re-run /password to publish to your group(s).", "system");
        }
      })();
      break;
    }

    case "login": {
      // Restore a former identity. Two paths, both password-gated via a dialog
      // (never inline): `/login <handle>` fetches the encrypted vault replicated
      // in a joined group (pure p2p — no blob to carry); bare `/login` takes a
      // pasted recovery string (or this browser's saved one). On success the
      // dyncap seed is replaced, group membership re-linked to the restored
      // anchor, and the identity re-announced so peers re-recognize this user.
      const handleArg = canonHandle(arg);
      void (async () => {
        let groupVault: string | null = null;
        if (handleArg) {
          const hits: VaultRecord[] = [];
          for (const g of groupStore.values()) { const v = g.vaults?.[handleArg]; if (v) hits.push(v); }
          if (hits.length === 0) {
            addMessage("", `no identity vault for handle “${handleArg}” in any joined group — join the group's room first, or paste your recovery string with a bare /login.`, "system");
            return;
          }
          hits.sort((a, b) => b.at - a.at);   // newest wins if several groups hold it
          groupVault = hits[0].blob;
        }
        const fields: SecureField[] = groupVault
          ? [{ label: "Password", type: "password" }]
          : [{ label: "Recovery string", type: "textarea", placeholder: "paste your qos-vault:v1:… string (blank = use this browser's saved one)" },
             { label: "Password", type: "password" }];
        const res = await secureDialog(groupVault ? `Restore identity “${handleArg}”` : "Restore identity", fields, "Restore");
        if (!res) { addMessage("", "login: cancelled", "system"); return; }
        const pw = groupVault ? res[0] : res[1];
        const vault = groupVault ?? (res[0].trim() || localStorage.getItem("qos-vault") || "").trim();
        if (!vault) { addMessage("", "no recovery string provided or saved on this browser", "system"); return; }
        if (!looksLikeVault(vault)) { addMessage("", "that doesn't look like a qos-vault:v1:… recovery string", "system"); return; }
        const plaintext = await decryptVault(pw, vault);
        if (!plaintext) { addMessage("", "wrong password or corrupt recovery string", "system"); return; }
        let parsed: { state?: string; name?: string };
        try { parsed = JSON.parse(plaintext) as { state?: string; name?: string }; }
        catch { addMessage("", "recovery string is corrupt", "system"); return; }
        if (!parsed.state) { addMessage("", "recovery string is missing identity data", "system"); return; }
        const restored = await deserializeState(parsed.state, activeRoom.roomId);
        if (!restored) { addMessage("", "recovery string is corrupt (bad seed)", "system"); return; }
        dyncapState = restored;
        saveDyncap();
        if (typeof parsed.name === "string" && parsed.name.trim()) {
          myName = parsed.name.trim();
          myNameEl.value = myName;
          localStorage.setItem("qos-name", myName);
        }
        localStorage.setItem("qos-vault", vault); // keep it available on this browser too
        reconcileGroups(myPeerId(), restored.anchor);   // re-link my group membership to the restored anchor
        renderPeers();
        if (qpeer) signedBroadcast({ kind: "name", name: myName });
        addMessage("", `✓ identity restored — anchor ${restored.anchor.slice(0, 16)}…${myName ? ` (${myName})` : ""}`, "system");
        addMessage("", "peers who knew this identity — and groups you belong to — will re-recognize you as it re-announces.", "system");
      })();
      break;
    }

    case "file":
    case "files": {
      // Verbs, not a feature. Each does one thing and answers in lines, so a
      // room composes its own workflow in a macro body rather than waiting for
      // the workflow it wants to be built. See Media_Libraries.md.
      const fParts = arg.trim().split(/\s+/);
      const fsub = (fParts[0] || "list").toLowerCase();
      const frest = fParts.slice(1).join(" ").trim();

      if (fsub === "list" || fsub === "") {
        const mine = /^--?mine$/i.test(frest);
        const here = /^--?here$/i.test(frest);
        const all = sortEntries(libraryStore.values()).filter((e) => {
          const a = availabilityFor(e.hash);
          if (mine) return a === "held";
          if (here) return a === "held" || a === "here";      // what can be had now
          return true;
        });
        if (all.length === 0) {
          sys(mine ? "you are holding nothing in this room"
            : here ? "nothing in the library can be had right now — no holder is present"
            : "the room's library is empty — /file add");
          break;
        }
        const reachable = all.filter((e) => availabilityFor(e.hash) !== "known"
                                         && availabilityFor(e.hash) !== "gone").length;
        sys(`library — ${all.length} entr${all.length === 1 ? "y" : "ies"}, ${reachable} available now`
          + "  (● you hold · ◉ a peer here holds · ○ no holder present · ⚠ none seen in a week)");
        const thin: LibraryEntry[] = [];
        for (const e of all) {
          const copies = copiesOf(e.hash);
          if (atRisk(copies)) thin.push(e);
          sys("  " + describeEntry(e, availabilityFor(e.hash), fileHolders.get(e.hash)?.size ?? 0)
            + (atRisk(copies) ? "  · only copy" : ""));
        }
        // Nothing here is backed up by anything but other people, so the count
        // of copies is the thing worth saying out loud.
        if (thin.length) {
          const mine = thin.filter((e) => heldFiles.has(e.hash)).length;
          sys(`⚠ ${thin.length} entr${thin.length === 1 ? "y has" : "ies have"} a single copy`
            + (mine ? ` — ${mine} of them only here, so nobody else has it` : "")
            + ". A second copy is somebody running /file get while the first is still reachable.");
        }
        break;
      }

      if (fsub === "get") {
        const target = findEntry(libraryStore.values(), frest);
        if (!target) { sys(frest ? `no single entry matches "${frest}"` : "usage: /file get <hash|name>"); break; }
        if (heldFiles.has(target.hash)) { sys(`you already hold ${target.name}`); break; }
        if (target.size > FETCH_MAX) {
          sys(`${target.name} is ${fmtFileSize(target.size)} — over the ${fmtFileSize(FETCH_MAX)} a fetch will carry today`);
          break;
        }
        // Ask one holder rather than the room: a fetch is between two peers,
        // and asking everyone would be the broadcast this is not.
        const holders = [...(fileHolders.get(target.hash) ?? [])].filter((p) => peers.has(p));
        if (!holders.length) {
          sys(`nobody here is holding ${target.name} — /file holders ${shortHash(target.hash)}`);
          break;
        }
        libraryFetch.want(target.hash, holders[0], target.name);
        break;
      }

      if (fsub === "cancel") {
        const target = frest ? findEntry(libraryStore.values(), frest) : null;
        libraryFetch.cancel(target?.hash);
        if (!frest) sys("cancelled every fetch in flight");
        break;
      }

      if (fsub === "holders") {
        const target = findEntry(libraryStore.values(), frest);
        if (!target) { sys(frest ? `no single entry matches "${frest}"` : "usage: /file holders <hash|name>"); break; }
        const who = [...(fileHolders.get(target.hash) ?? [])];
        sys(`${target.name}  ${shortHash(target.hash)}`);
        if (heldFiles.has(target.hash)) sys("  ● you");
        for (const p of who) sys(`  ◉ ${peerLabel(p)}`);
        if (!who.length && !heldFiles.has(target.hash)) {
          const seen = holderSeen.get(target.hash);
          sys(seen ? `  ○ nobody here now — last seen with a holder ${new Date(seen).toLocaleString()}`
                   : "  ⚠ no holder has ever been seen from this browser");
        }
        break;
      }

      if (fsub === "add") {
        // Pick, hash, keep the bytes, announce the entry. The hash is the name,
        // so adding the same file twice is one entry and needs no arbitration.
        void addFilesToLibrary();
        break;
      }

      if (fsub === "forget") {
        const target = findEntry(libraryStore.values(), frest);
        if (!target) { sys(frest ? `no single entry matches "${frest}"` : "usage: /file forget <hash|name>"); break; }
        forgetLibraryEntry(target);
        break;
      }

      if (fsub === "drop") {
        // Stop holding the bytes; the entry stays, because what the room has is
        // a different fact from what this browser is keeping.
        const target = findEntry(libraryStore.values(), frest);
        if (!target) { sys(frest ? `no single entry matches "${frest}"` : "usage: /file drop <hash|name>"); break; }
        if (!heldFiles.has(target.hash)) { sys(`you are not holding ${target.name}`); break; }
        heldFiles.delete(target.hash);
        saveLibrary();
        announceHeld();
        renderLibrary();
        void dropBytes(target.hash);
        sys(`dropped the bytes for ${target.name} — the entry stays (${shortHash(target.hash)})`);
        break;
      }

      sys(`unknown subcommand: /file ${fsub}`);
      sys("  /file add                  — pick files to hash, hold and index");
      sys("  /file list [--mine|--here] — what the room has; only yours, or only what can be had now");
      sys("  /file get <hash|name>      — fetch it from a holder, verified against its hash");
      sys("  /file holders <hash|name>  — who has these bytes right now");
      sys("  /file cancel [hash|name]   — give up on a fetch");
      sys("  /file drop <hash|name>     — stop holding the bytes, keep the entry");
      sys("  /file forget <hash|name>   — retract the entry (yours to retract for everyone)");
      break;
    }

    case "conn": {
      // What each connection is actually doing. The roster says reachable or
      // not; this says why not, which is the difference between a network that
      // cannot be crossed and one that simply has not finished.
      const p = qpeer;
      if (!p) { sys("not connected to a room"); break; }
      const rows = p.connectionReport();
      if (!rows.length) { sys("no peer connections yet"); break; }
      sys(`connections (${rows.length}):`);
      for (const r of rows) {
        sys(`  ${peerLabel(r.peerId).padEnd(14)} channel ${r.channel.padEnd(11)} conn ${r.connection.padEnd(12)} ice ${r.ice}`);
      }
      sys("  channel open is the only one that means you can talk;");
      sys("  ice 'checking' forever = candidates that never pair · 'failed' = no path (/ice test)");
      break;
    }

    case "socket": {
      // POSIX-style sockets over the mesh (docs/connection.md "posix-net") —
      // a prototype. connect(peer, port) reaches another quantum-os peer
      // directly and only: never an arbitrary external host (no browser
      // ever can), and never through the chat flood relay (a socket is
      // point-to-point by definition — see peer.ts's SocketChannelKind).
      // No capability gating yet — anyone can /socket listen or connect.
      if (!qpeer || !posixNet) { sys("not connected to a room"); break; }
      const net = posixNet;
      // accept()/onData/onClose fire later, possibly after the user has
      // switched tabs — capture the room this command was typed in, the same
      // way connect()'s QOSPeer callbacks capture `ctx`, so a background
      // socket event lands in its own room rather than whichever is active.
      const cmdCtx = activeRoom;
      const sParts = arg.trim().split(/\s+/).filter(Boolean);
      const ssub = (sParts[0] || "list").toLowerCase();

      const resolvePeer = (token: string): string | null =>
        token && peers.has(token) ? token : findPeerByName(token);

      const wireSocket = (socket: QosSocket, label: string): void => {
        socketConns.set(socket.connId, socket);
        socket.onData = (payload) => {
          const prev = activeRoom; setActiveRoom(cmdCtx);
          try { addMessage("", `[${socket.connId}] ${label}: ${payload}`, "system"); }
          finally { setActiveRoom(prev); }
        };
        socket.onClose = () => {
          const prev = activeRoom; setActiveRoom(cmdCtx);
          try { socketConns.delete(socket.connId); addMessage("", `[${socket.connId}] closed`, "system"); }
          finally { setActiveRoom(prev); }
        };
      };

      if (ssub === "listen") {
        const port = Number(sParts[1]);
        const type: SocketType = sParts[2] === "dgram" ? "dgram" : "stream";
        if (!Number.isInteger(port) || port < 0) { sys("usage: /socket listen <port> [stream|dgram]"); break; }
        const key = `${type}:${port}`;
        if (socketListeners.has(key)) { sys(`already listening on ${key}`); break; }
        const unlisten = net.listen(port, type, (socket, fromPeerId) => {
          const prev = activeRoom; setActiveRoom(cmdCtx);
          try {
            addMessage("", `↳ ${peerLabel(fromPeerId)} connected on ${key}  (conn ${socket.connId})`, "system");
            wireSocket(socket, peerLabel(fromPeerId));
          } finally { setActiveRoom(prev); }
        });
        socketListeners.set(key, { port, type, unlisten });
        sys(`✓ listening on ${key}`);
        break;
      }

      if (ssub === "unlisten") {
        const port = Number(sParts[1]);
        const type: SocketType = sParts[2] === "dgram" ? "dgram" : "stream";
        const key = `${type}:${port}`;
        const l = socketListeners.get(key);
        if (!l) { sys(`not listening on ${key}`); break; }
        l.unlisten();
        socketListeners.delete(key);
        sys(`✓ stopped listening on ${key}`);
        break;
      }

      if (ssub === "connect") {
        const targetToken = sParts[1] ?? "";
        const port = Number(sParts[2]);
        const type: SocketType = sParts[3] === "dgram" ? "dgram" : "stream";
        const targetId = resolvePeer(targetToken);
        if (!targetId || !Number.isInteger(port)) { sys("usage: /socket connect <peer> <port> [stream|dgram]"); break; }
        const label = peerLabel(targetId);
        sys(`connecting to ${label}:${port} (${type})…`);
        void net.connect(targetId, port, type).then((socket) => {
          const prev = activeRoom; setActiveRoom(cmdCtx);
          try {
            wireSocket(socket, label);
            addMessage("", `✓ connected to ${label}:${port} — conn ${socket.connId}`, "system");
          } finally { setActiveRoom(prev); }
        }).catch((e: Error) => {
          const prev = activeRoom; setActiveRoom(cmdCtx);
          try { addMessage("", `✗ ${label}:${port} — ${e.message}`, "system"); }
          finally { setActiveRoom(prev); }
        });
        break;
      }

      if (ssub === "send") {
        const connId = sParts[1] ?? "";
        const text = sParts.slice(2).join(" ");
        const socket = socketConns.get(connId);
        if (!socket || !text) { sys("usage: /socket send <connId> <text>"); break; }
        if (!socket.send(text)) sys("✗ send failed — channel not open");
        break;
      }

      if (ssub === "close") {
        const connId = sParts[1] ?? "";
        const socket = socketConns.get(connId);
        if (!socket) { sys(`no open socket ${connId}`); break; }
        socket.close();
        socketConns.delete(connId);
        sys(`✓ closed ${connId}`);
        break;
      }

      if (ssub === "list") {
        sys(`listening (${socketListeners.size}):`);
        for (const { port, type } of socketListeners.values()) sys(`  ${type}:${port}`);
        sys(`open sockets (${socketConns.size}):`);
        for (const s of socketConns.values()) sys(`  ${s.connId}  ${peerLabel(s.peerId)}:${s.port} (${s.type})`);
        break;
      }

      sys(`unknown subcommand: /socket ${ssub}`);
      sys("  /socket listen <port> [stream|dgram]        — accept inbound connections");
      sys("  /socket unlisten <port> [stream|dgram]      — stop accepting them");
      sys("  /socket connect <peer> <port> [stream|dgram] — open a socket to a mesh peer");
      sys("  /socket send <connId> <text>                 — send over an open socket");
      sys("  /socket close <connId>                       — close it");
      sys("  /socket list                                 — listeners + open sockets");
      break;
    }

    case "reset": {
      // A fresh start for this browser's *connection identity*, without the
      // Android-Chrome site-settings dance. The common case: after a /login
      // recovery or a half-cleared storage, this browser is on a peerId that
      // other peers TOFU-pinned to a now-stale dyncap anchor, so they show it
      // as a hex id or "contested" and refuse its signed envelopes. Minting a
      // fresh peerId and dropping this browser's own TOFU pins makes everyone
      // re-recognise it cleanly on the next join.
      //
      //   /reset            — fresh peerId + drop TOFU pins. Identity, name,
      //                       groups and vault are all kept.
      //   /reset identity   — ALSO a brand-new dyncap seed: you rejoin as a
      //                       different person. Room content is untouched.
      const hard = /^(identity|hard|all)$/i.test(arg.trim());
      void (async () => {
        const ok = await confirmDialog(
          hard ? "New identity for this browser?" : "Reset this browser's connection identity?",
          hard
            ? "This browser gets a brand-new identity (a new dyncap seed) and a new peer ID, then reloads.\n\n"
              + "You rejoin as a different person: your name, your standing, and any group membership tied to your identity are left behind. An encrypted vault you saved still matches only its original identity.\n\n"
              + "Room content — lemmas, notes, polls, macros — is NOT touched."
            : "This browser gets a fresh peer ID and forgets which dyncap anchors it has seen, then reloads.\n\n"
              + "Your identity, name, groups and vault are all kept — peers just re-recognise you cleanly. Use this when peers show you as a hex id, or as ⚠ / contested, after an identity change.",
          hard ? "New identity" : "Reset",
        );
        if (!ok) { addMessage("", "reset: cancelled", "system"); return; }
        try {
          sessionStorage.removeItem("qos-peer-id");
          for (const k of Object.keys(localStorage)) {
            if (k.startsWith("qos-peer-lease:") || k.startsWith("qos-dyncap-chains-")) localStorage.removeItem(k);
            if (hard && k === "qos-dyncap-state") localStorage.removeItem(k);
          }
        } catch { /* storage off — nothing to clear, reload still helps */ }
        addMessage("", "reset — reloading…", "system");
        setTimeout(() => location.reload(), 150);
      })();
      sys(hard ? "reset identity: confirm in the dialog…" : "reset: confirm in the dialog…");
      break;
    }

    case "version":
    case "build": {
      // Asked constantly while debugging a room, and answered until now only by
      // a line at the foot of the sidebar, below everything, behind a drawer on
      // a phone. "Which build are you on" needs an answer you can type.
      sys(`quantum-os ${__APP_VERSION__} · build ${__APP_BUILD__}`);
      sys(`  signaling  ${activeRoom.signalingUrl}`);
      sys(`  rnode      ${loadNodeConfig().url}`);
      sys(`  webrtc     ${webrtcMissing() ? "MISSING — this browser cannot connect to anyone" : "available"}`);
      sys("  https://github.com/rhovision-org/quantum-os");
      break;
    }

    case "ice": {
      // Whether two peers can connect at all is decided here, and it is the one
      // piece of the room that no amount of retrying can substitute for: two
      // peers behind symmetric NAT have no direct path, and only a relay makes
      // one.
      const iParts = arg.trim().split(/\s+/).filter(Boolean);
      const isub = (iParts[0] || "list").toLowerCase();

      if (isub === "list" || isub === "") {
        const list = iceServersFor(stunUrlEl.value.trim());
        sys(`ice servers (${list.length}):`);
        for (const srv of list) {
          const urls = Array.isArray(srv.urls) ? srv.urls.join(", ") : srv.urls;
          sys(`  ${urls}${srv.username ? "   (with credentials)" : ""}`);
        }
        sys(`  auto relay: ${autoTurnEnabled() ? "on — a short-lived Cloudflare TURN credential is fetched at every connect" : "off (/ice auto on)"}`);
        const last = (() => { try { return localStorage.getItem(ICE_TEST_KEY); } catch { return null; } })();
        if (last) { sys("last test:"); sys("```\n" + last + "\n```"); }
        if (!list.some((srv) => String(srv.urls).includes("turn:")) && !autoTurnEnabled()) {
          sys("  no relay (turn:) — two peers behind restrictive NAT cannot connect without one");
          sys("  /ice auto on   ·   /ice turn turn:host:3478 <user> <pass>   ·   /ice test  to see what your network allows");
        }
        break;
      }

      if (isub === "auto") {
        const on = (iParts[1] ?? "").toLowerCase();
        if (on !== "on" && on !== "off") { sys(`auto relay is ${autoTurnEnabled() ? "on" : "off"} — /ice auto on|off`); break; }
        if (on === "on") localStorage.removeItem(ICE_AUTO_KEY); else localStorage.setItem(ICE_AUTO_KEY, "off");
        sys(`✓ auto relay ${on} — reconnect for it to take effect (Disconnect, then Connect)`);
        if (on === "off") sys("  calls between peers who can't form a direct connection will have no video until you add your own /ice turn");
        break;
      }

      if (isub === "turn" || isub === "stun") {
        // Never broadcast (see the exclusion list in send()): a TURN entry
        // carries a username and password, and the qlf envelope would have
        // carried them to everyone in the room along with the command.
        const url = iParts[1];
        if (!url || !url.startsWith(isub + ":")) { sys(`usage: /ice ${isub} ${isub}:host:port` + (isub === "turn" ? " <user> <pass>" : "")); break; }
        const entry: RTCIceServer = isub === "turn"
          ? { urls: url, username: iParts[2] ?? "", credential: iParts[3] ?? "" }
          : { urls: url };
        const list = loadIceServers().filter((srv) => srv.urls !== url);
        saveIceServers([...list, entry]);
        sys(`✓ added ${url} — reconnect for it to take effect (Disconnect, then Connect)`);
        if (isub === "turn") sys("  a relay carries your traffic; DTLS keeps it unreadable, but it passes through that machine");
        break;
      }

      if (isub === "last") {
        const last = (() => { try { return localStorage.getItem(ICE_TEST_KEY); } catch { return null; } })();
        if (last) sys("```\n" + last + "\n```");
        else sys("no test on this device yet — /ice test");
        break;
      }

      if (isub === "reset") { saveIceServers(null); sys("ice servers back to the default (stun only) — reconnect to apply"); break; }

      if (isub === "test") {
        // Ask the network what it will give us. Only a relay candidate answers
        // "can I reach somebody whose network is as awkward as mine". Probed
        // with the SAME servers a real connect would use — including the
        // auto-fetched relay, if on — so "relay ✓/✗" answers "will MY next
        // call actually cross a hard NAT", not just "is a STUN server up".
        sys("gathering candidates… (5 seconds)");
        const iceCtx = activeRoom;
        void (async () => {
          const seen = new Set<string>();
          let pc: RTCPeerConnection | null = null;
          try {
            const autoTurn = await fetchAutoTurn(signalUrlEl.value.trim() || DEFAULT_SIGNAL);
            pc = new RTCPeerConnection({ iceServers: [...iceServersFor(stunUrlEl.value.trim()), ...autoTurn] });
            pc.createDataChannel("probe");
            pc.onicecandidate = (e) => {
              if (!e.candidate) return;
              const type = /\btyp (\w+)/.exec(e.candidate.candidate)?.[1];
              if (type) seen.add(type);
            };
            await pc.setLocalDescription(await pc.createOffer());
            // Stop as soon as the browser says it has finished, rather than
            // always waiting the full five seconds.
            const done = new Promise<void>((r) => {
              const t = setTimeout(r, 5000);
              pc!.onicegatheringstatechange = () => {
                if (pc!.iceGatheringState === "complete") { clearTimeout(t); r(); }
              };
            });
            await done;
          } catch (e) {
            // Never end without an answer: a test that fails silently is worse
            // than no test, because it looks like the network is the problem.
            inRoom(iceCtx, () => {
              addMessage("", `✗ the test itself failed: ${(e as Error)?.message ?? String(e)}`, "system");
              addMessage("", "  this browser refused to open a connection at all — which is itself the answer", "system");
            });
            return;
          } finally {
            pc?.close();
          }
          const kinds = [...seen];
          // One message, not five: a single block survives a scroll, copies in
          // one gesture, and cannot be half-lost.
          const report = [
            `candidates: ${kinds.join(", ") || "none"}`,
            kinds.includes("host") ? "host ✓ same machine or same LAN" : "host ✗ no host candidate, which is unusual",
            kinds.includes("srflx") ? "srflx ✓ STUN answered: reachable from outside this NAT"
                                    : "srflx ✗ STUN did not answer; a firewall may be blocking UDP",
            kinds.includes("relay") ? "relay ✓ a TURN server is available, so even a hard NAT can be crossed"
                                    : "relay ✗ no TURN, so a peer behind a restrictive NAT cannot be reached (/ice turn …)",
          ].join("\n");
          try { localStorage.setItem(ICE_TEST_KEY, report); } catch { /* not worth failing over */ }
          inRoom(iceCtx, () => {
            addMessage("", "```\n" + report + "\n```", "system");
            addMessage("", "  /ice last  shows this again — paste it to whoever is helping", "system");
          });
        })();
        break;
      }

      sys(`unknown subcommand: /ice ${isub}`);
      sys("  /ice list                          — what a connection may use");
      sys("  /ice auto on|off                   — the default relay, fetched fresh per connect (on by default)");
      sys("  /ice stun stun:host:3478           — add a STUN server");
      sys("  /ice turn turn:host:3478 <u> <p>   — add your own relay instead, for networks direct connection cannot cross");
      sys("  /ice test                          — what your network actually allows");
      sys("  /ice last                          — show the last test again");
      sys("  /ice reset                         — back to the default");
      break;
    }

    case "record": {
      // Local, and deliberately not a broadcast of its own output: the recorder
      // tells the room itself, on start and on stop.
      recorder.toggle();
      break;
    }

    case "render":
    case "animate": {
      // Open an animation of THIS room: its perspectives (peers, you included)
      // bound to the shared room closure, their closures (lemmas), and groups —
      // the QLF / ER=EPR picture applied to the live room. Snapshot at open time.
      const roomLabel = activeRoom.roomId.replace(/^cap:room:/, "").slice(0, 8);
      const trim = (s: string) => s.slice(0, 24);
      const selfLabel = trim(myName || "me");
      const peerLabels = [...peers]
        .map((p) => trim(peerNames.get(p) || p.replace(/^cap:peer:/, "").slice(0, 8)))
        .slice(0, 48);
      const lemmaLabels = [...lemmaStore.keys()].map(trim).slice(0, 64);
      const chanLabels = [...channelSubscriptions].map(trim).slice(0, 24);
      const url = new URL("render.html", location.href);
      url.searchParams.set("room", roomLabel);
      url.searchParams.set("self", selfLabel);
      if (peerLabels.length) url.searchParams.set("peers", peerLabels.join("\n"));
      if (lemmaLabels.length) url.searchParams.set("lemmas", lemmaLabels.join("\n"));
      if (chanLabels.length) url.searchParams.set("channels", chanLabels.join("\n"));
      url.searchParams.set("groups", String(groupStore.size));
      const win = window.open(url.href, "_blank", "noopener");
      if (!win) {
        sys("couldn't open the animation — allow pop-ups for this site, then retry /render");
      } else {
        sys(`rendering room ${roomLabel} — ${peerLabels.length + 1} perspective(s), ` +
            `${lemmaLabels.length} closure(s), ${groupStore.size} group(s). Snapshot; re-run to refresh.`);
      }
      break;
    }

    case "rholang": {
      // Talk to an RChain node: run a program, or sign and submit one. A room is
      // ephemeral; a deploy is not. `eval` and `deploy` take their program from
      // the lines that follow, so a multi-line program needs no escaping.
      const parts2 = arg.trim().split(/\s+/);
      const sub = (parts2[0] ?? "").toLowerCase();
      const rest = arg.trim().slice(sub.length).trim();
      const cfg = loadNodeConfig();

      switch (sub) {
        case "":
        case "help": {
          for (const l of RHOLANG_HELP) sys(l);
          break;
        }

        case "status": {
          sys(`asking ${cfg.url}…`);
          void (async () => {
            try {
              const st = await nodeStatus(cfg);
              sys(`✓ rnode ${st.version?.node ?? "?"} (api ${st.version?.api ?? "?"})`);
              sys(`  network ${st.networkId ?? "?"} · shard ${st.shardId ?? "?"} · peers ${st.peers ?? 0}`);
              sys(`  latest block ${st.latestBlockNumber ?? "?"} · min phlo price ${st.minPhloPrice ?? "?"}`);
              if (st.shardId && st.shardId !== cfg.shard) {
                sys(`  ⚠ your shard is "${cfg.shard}" but rnode is "${st.shardId}" — deploys will be rejected`);
                sys(`    fix with /rholang shard ${st.shardId}`);
              }
            } catch (e) {
              sys(`✗ cannot reach ${cfg.url} — ${(e as Error)?.message ?? e}`);
              sys("  is rnode running, and is --api-host set so it listens for the browser?");
            }
          })();
          break;
        }

        case "explain": {
          // One verb for the question, wherever it is asked from: the button and
          // the command reach the same place, and the phrasing of the question
          // lives in one spot rather than in a prefill.
          const body = rest.trim().replace(/^(eval|deploy)\b\s*/, "");
          const mode2: "eval" | "deploy" = /^deploy\b/.test(rest.trim()) ? "deploy" : "eval";
          if (body) explainRholang(mode2, body, true);
          else editRholang(mode2, "", false, true);
          break;
        }

        case "show":
        case "echo": {
          // Show what would actually be sent, and run nothing. A program is
          // rewritten before it leaves the browser — wrapped so `return` and the
          // powerbox are in scope, and for a deploy also forwarded onto a public
          // name — and until now none of that was visible. What you sign should
          // not be something you have never seen.
          const mode: "eval" | "deploy" = /^deploy\b/.test(rest.trim()) ? "deploy" : "eval";
          const body = rest.trim().replace(/^(eval|deploy)\b\s*/, "");
          if (body) echoRholang(mode, body);
          else editRholang(mode === "deploy" ? "deploy" : "eval", "", true);
          break;
        }

        case "eval":
        case "deploy": {
          // A program given inline runs as typed — that keeps `/rholang eval
          // return!(42)` scriptable. With nothing after the verb, open the
          // editor rather than printing help at someone who asked to write code.
          if (rest) runRholangProgram(sub, rest);
          else editRholang(sub, "");
          break;
        }

        case "locker": {
          // Where the locker is. Installing publishes it to the uri derived
          // from your own key, so the address is known before the deploy is
          // sent and nothing has to be read back to learn it.
          if (rest === "install") {
            if (!cfg.key) { sys("no key — /rholang key generate first"); break; }
            sys("installing the locker…");
            sys("  its uri is minted by the registry, so it comes back as the deploy's answer");
            void (async () => {
              const r = await deployTerm(cfg, installProgram());
              addMessage("", (r.ok ? "✓ " : "✗ ") + r.message, "system");
              if (!r.ok || r.resultNonce === undefined) return;
              const fresh = await readResultsFresh(cfg, r.resultNonce, 40);
              const uri = fresh && fresh.startsWith("rho:id:") ? fresh : undefined;
              if (!uri) { addMessage("", "  deployed, but no uri came back yet — /rholang read, then /rholang locker <uri>", "system"); return; }
              saveNodeConfig({ ...loadNodeConfig(), locker: uri });
              addMessage("", `✓ locker at ${uri}`, "system");
            })();
            break;
          }
          if (rest) { saveNodeConfig({ ...cfg, locker: rest }); sys(`✓ locker set to ${rest}`); break; }
          if (cfg.locker) sys(`locker ${cfg.locker}`);
          else {
            const fromGroup = lockerFromGroups();
            sys(fromGroup ? `no locker of your own — using ${fromGroup.group}'s: ${fromGroup.uri}`
                          : "no locker set");
          }
          sys("  /rholang locker <uri>    — point at one somebody installed");
          sys("  /rholang locker install  — publish one at the uri your key derives");
          break;
        }

        case "register":
        case "bind":
        case "resolve":
        case "record":
        case "grant": {
          // Being in a group is enough to reach the group's locker. A member
          // should not have to be handed a uri out of band that the group
          // already knows, so an unset local locker falls back to one a group
          // you belong to has recorded — named, so it is never a silent
          // substitution of somebody else's directory for your own.
          const groupLocker = lockerFromGroups();
          // Every locker verb is its own deploy. `deployerId` exists only
          // inside one, and a facet reached through the registry answers the
          // first call in a program and nothing after it (rholo#21) — so
          // one verb per program is the shape either way.
          const locker = cfg.locker ?? groupLocker?.uri;
          if (!locker) {
            sys("no locker — /rholang locker <uri>, or /rholang locker install");
            sys("  a group can carry one for its members: /gov locker rho:id:…");
            break;
          }
          if (!cfg.locker && groupLocker) sys(`using ${groupLocker.group}'s locker  ${groupLocker.uri}`);
          if (!cfg.key)    { sys("no key — /rholang key generate first"); break; }
          const a = rest.split(/\s+/).filter(Boolean);
          let program: string | null = null;
          if (sub === "register") {
            program = registerProgram(locker, revAddressOf(cfg.key));
            sys(`registering ${revAddressOf(cfg.key)}`);
          } else if (sub === "bind") {
            if (a.length < 2) sys("usage: /rholang bind <name> <uri>");
            else program = bindProgram(locker, a[0], a.slice(1).join(" "));
          } else if (sub === "resolve") {
            if (!a[0]) sys("usage: /rholang resolve <name>");
            else program = resolveProgram(locker, a[0]);
          } else if (sub === "record") {
            program = readProgram(locker);
          } else if (sub === "grant") {
            if (!a[0]) sys("usage: /rholang grant <name>  — a write-only cap for that one name");
            else program = grantProgram(locker, a[0]);
          }
          if (program) runRholangProgram("deploy", program);
          break;
        }

        case "macros": {
          for (const l of listRholangMacros().split("\n")) sys(l);
          sys("  use one in a program: /rholang eval  with $name(…) call sites in it");
          sys("  or on its own:        /rholang macro <name> <args…>");
          break;
        }

        case "macro": {
          // The bare form: the whole program is one macro. A `term`-typed
          // argument (the rho:gov:* maps) needs the program form instead,
          // because this form splits on whitespace.
          if (!rest) { sys("usage: /rholang macro <name> <args…>   ·   /rholang macros to list them"); break; }
          try {
            const x = expandBareMacro(`/rholang macro ${rest}`);
            if (x.kind === "help") { for (const l of RHOLANG_HELP) sys(l); break; }
            if (x.kind === "list") { for (const l of listRholangMacros().split("\n")) sys(l); break; }
            if (x.kind === "result") { sys(x.text); break; }   // a local read: answered here
            runRholangProgram(x.kind === "rholang" && x.mode === "eval" ? "eval" : "deploy", x.source);
          } catch (e) { sys(`✗ ${(e as Error)?.message ?? e}`); }
          break;
        }

        case "powerbox":
        case "names": {
          sys("declared for you in every program — send to these, read the answer on return:");
          sys("");
          sys("```\n" + powerboxSpec("deploy").join("\n") + "\n```");
          sys("");
          sys("These answer under eval too. What eval cannot give you is a deploy's own");
          sys("identity — rho:rchain:deployId and deployerId are unbound there.");
          break;
        }

        case "read": {
          // Answers "my deploy has not reported yet". The value stays where it
          // was written until something reads it, so there is no window to miss
          // and nothing is lost by collecting it later.
          if (!cfg.key) { sys("no key — /rholang key generate first"); break; }
          const target = rest.trim().replace(/^@/, "").replace(/^"|"$/g, "");
          void (async () => {
            try {
              if (target) {
                const values = await readName(cfg, target);
                if (values.length) { for (const v of values) addMessage("", "  → " + v, "system"); return; }
                addMessage("", `  nothing at @"${target}" yet — no block carries that deploy so far, which can take minutes`, "system");
                return;
              }
              // No target: the deployer's own record. It carries its nonce, so a
              // value from an earlier deploy can be told apart from this one's.
              const rec = await readResultRecord(cfg);
              // What nonce the record should be at if the last deploy reported:
              // the tracked one, else the local counter's last write.
              const expected = lastDeployNonce ?? ((cfg.resultNonce ?? 1) - 1);
              if (rec.value != null) {
                addMessage("", "  → " + rec.value, "system");
                if (rec.nonce != null && rec.nonce < expected) {
                  addMessage("", `  ⚠ that is from an earlier deploy — the record is at nonce ${rec.nonce}, your last deploy wrote ${expected}`, "system");
                  const fate = lastDeploySig ? await deployFate(cfg, lastDeploySig).catch(() => null) : null;
                  if (fate?.errored) {
                    addMessage("", `  ✗ your last deploy ran in block ${fate.blockNumber} and errored (cost ${fate.cost ?? "?"}) — it sent nothing to \`return\``, "system");
                    if (fate.systemDeployError) addMessage("", `     ${fate.systemDeployError}`, "system");
                  } else if (fate) {
                    addMessage("", `  it ran in block ${fate.blockNumber} without sending to \`return\` — check the program actually \`return!\`s`, "system");
                  } else {
                    addMessage("", `  its block may not be in yet (can take minutes) — /rholang read again later`, "system");
                  }
                }
                return;
              }
              // Empty is ambiguous — waiting, or errored and never coming. Ask the block.
              const fate = lastDeploySig ? await deployFate(cfg, lastDeploySig).catch(() => null) : null;
              if (fate?.errored) addMessage("", `  ✗ that deploy ran in block ${fate.blockNumber} and errored (cost ${fate.cost ?? "?"}) — it sent nothing to return`, "system");
              else if (fate) addMessage("", `  nothing at your record — it ran in block ${fate.blockNumber} without sending to return`, "system");
              else addMessage("", `  nothing at your record yet — no block carries that deploy so far, which can take minutes`, "system");
            } catch (e) {
              addMessage("", "✗ " + ((e as Error)?.message ?? e), "system");
            }
          })();
          break;
        }

        case "nonce": {
          // The counter beside the key is a convenience; the slot is the truth.
          // They part company when the same key deploys from a second browser.
          void (async () => {
            const n = await syncResultNonce(cfg).catch(() => null);
            addMessage("", n === null ? "  no record yet — /rholang register, or deploy once"
                                      : `  record is at nonce ${n}; next write uses ${n + 1}`, "system");
          })();
          break;
        }

        case "config": {
          for (const l of describeNodeConfig(cfg)) sys("  " + l);
          break;
        }

        case "rnode":
        case "node": {           // `node` still answers; everything says rnode
          if (!rest) { sys(`rnode ${cfg.url}`); break; }
          saveNodeConfig({ ...cfg, url: rest });
          sys(`✓ rnode set to ${rest}`);
          break;
        }

        case "shard": {
          if (!rest) { sys(`shard ${cfg.shard}`); break; }
          saveNodeConfig({ ...cfg, shard: rest });
          sys(`✓ shard set to ${rest}`);
          break;
        }

        case "phlo": {
          const [limitTxt, priceTxt] = rest.split(/\s+/);
          const limit = Number(limitTxt);
          if (!limitTxt || !Number.isFinite(limit) || limit <= 0) {
            sys(`phlo limit ${cfg.phloLimit}, price ${cfg.phloPrice}   (set with /rholang phlo <limit> [price])`);
            break;
          }
          const price = priceTxt ? Number(priceTxt) : cfg.phloPrice;
          if (!Number.isFinite(price) || price <= 0) { sys("✗ phlo price must be a positive number"); break; }
          saveNodeConfig({ ...cfg, phloLimit: limit, phloPrice: price });
          sys(`✓ phlo limit ${limit}, price ${price}`);
          break;
        }

        case "key": {
          if (!rest || rest.toLowerCase() === "show") {
            // The REV address, not the public key: the address is what a wallet
            // funds and what a deploy is pre-charged against, so it is the one
            // you can act on. The public key answers no question you have here.
            sys(cfg.key ? `address ${revAddressOf(cfg.key)}` : "no deploy key — /rholang key generate, or /rholang key <hex>");
            break;
          }
          if (rest.toLowerCase() === "generate") {
            // handleCommand answers in lines, so the question is asked without
            // blocking it: the dialog resolves later and finishes the work.
            void (async () => {
              if (cfg.key && !(await confirmDialog("Replace the deploy key?",
                  "The existing one is not recoverable, and anything registered under it stays there.",
                  "Replace it"))) {
                addMessage("", "cancelled — key unchanged", "system");
                return;
              }
              const k = generateDeployKey();
              saveNodeConfig({ ...loadNodeConfig(), key: k });
              addMessage("", "✓ deploy key generated (stored in this browser only)", "system");
              addMessage("", `  address ${revAddressOf(k)}`, "system");
              addMessage("", "  it holds no REV until a wallet funds it — a deploy from an unfunded key fails at pre-charge", "system");
            })();
            break;
          }
          if (rest.toLowerCase() === "forget") {
            const { key: _drop, ...without } = cfg;
            saveNodeConfig(without as NodeConfig);
            sys("✓ deploy key removed from this browser");
            break;
          }
          try {
            const addr = revAddressOf(rest);
            saveNodeConfig({ ...cfg, key: rest.trim().replace(/^0x/, "") });
            sys("✓ deploy key set (stored in this browser only)");
            sys(`  address ${addr}`);
            sys("  it holds no REV until a wallet funds it — a deploy from an unfunded key fails at pre-charge");
          } catch {
            sys("✗ not a secp256k1 secret key — expected 32 bytes of base16");
          }
          break;
        }

        default:
          sys(`unknown: /rholang ${sub}  — try /rholang help`);
      }
      break;
    }

    default:
      sys(`unknown command: /${cmd}  (type /help for list)`);
  }

  return lines;
}

// ---------------------------------------------------------------------------
// Connect
// ---------------------------------------------------------------------------

/**
 * Can this browser peer at all?
 *
 * `RTCPeerConnection` missing is not a network problem and no relay, retry or
 * reload touches it: a browser without WebRTC cannot reach anybody, ever. It is
 * usually a privacy extension, a disabled setting, or an in-app browser — a
 * link opened inside a chat app rather than in a browser — and each of those
 * has a different fix, so the message names all three.
 */
function webrtcMissing(): boolean {
  return typeof RTCPeerConnection === "undefined";
}

async function connect(): Promise<void> {
  if (webrtcMissing()) {
    addMessage("", "✗ this browser has no WebRTC (RTCPeerConnection is missing), so it cannot connect to anybody here.", "system");
    addMessage("", "  · a privacy extension or shield blocking WebRTC — allow it for this site", "system");
    addMessage("", "  · WebRTC disabled in the browser's own settings", "system");
    addMessage("", "  · an in-app browser (a link opened inside a chat or mail app) — open it in Chrome, Firefox or Safari instead", "system");
    setStatus("disconnected", "no WebRTC in this browser");
    return;
  }
  if (qpeer) {
    qpeer.disconnect();
    setQpeer(null);
    posixNet?.close();
    setPosixNet(null);
    socketListeners.clear();
    socketConns.clear();
    peers.clear();
    peerNames.clear();
    renderPeers();
    if (isUiActive()) {
      msgInput.disabled = true;
      sendBtn.disabled = true;
      connectBtn.textContent = "Connect";
    }
    setStatus("disconnected", "disconnected");
    return;
  }

  // Capture the room being connected. All this QOSPeer's callbacks
  // operate against this context regardless of which tab the user is
  // looking at when the callback fires; setActiveRoom(ctx) at callback
  // entry temporarily redirects the module-level state aliases so
  // mutations land in this room, and DOM-touching code further guards
  // with isUiActive() so the visible tab isn't disturbed.
  const ctx = activeRoom;
  const roomId = ctx.roomId;
  const signalingUrl = signalUrlEl.value.trim() || DEFAULT_SIGNAL;
  ctx.signalingUrl = signalingUrl;
  const stunUrl = stunUrlEl.value.trim();

  setStatus("connecting", "connecting… (first connect may take ~30s to wake server)");
  connectBtn.textContent = "Disconnect";
  // Guard the gap below: fetchAutoTurn awaits an HTTP round trip, and qpeer
  // stays null (the `if (qpeer)` guard above is the only re-entrancy check)
  // until setQpeer(newPeer) at the very end of this function — a second click
  // during that window would pass the guard and start a duplicate connection.
  connectBtn.disabled = true;
  const autoTurn = await fetchAutoTurn(signalingUrl);
  connectBtn.disabled = false;

  // Forward-declared: the QOSPeer config below references `net` from its
  // onSocketChannelOpen/onSocketMessage callbacks, but those only ever fire
  // after connect() returns — by which point `net` (built just below, from
  // `newPeer` itself) is assigned. See docs/connection.md "posix-net".
  let net: PosixNet;
  const newPeer = new QOSPeer({
    signalingUrl,
    roomId,
    iceServers: [...iceServersFor(stunUrl), ...autoTurn],
    onSignalingOpen() {
      const prev = activeRoom; setActiveRoom(ctx);
      try {
        setStatus("connected", connectedLabel());
        if (isUiActive()) {
          msgInput.disabled = false;
          sendBtn.disabled = false;
          toggleSidebar(false);
        }
        renderPeers();
        // Log the join only once per room. onSignalingOpen also fires on every
        // signaling reconnect (e.g. a backgrounded tab dropped by the server's
        // heartbeat), so logging here unconditionally floods the room with
        // "joined room" lines. The persistent connected status already reflects
        // reconnects.
        if (!ctx.hasJoinedOnce) {
          addMessage("", `joined room ${shortId(roomId)}`, "system");
          ctx.hasJoinedOnce = true;
        }
        openProbeWindow();
      } finally { setActiveRoom(prev); }
    },
    onSignalingClose() {
      const prev = activeRoom; setActiveRoom(ctx);
      try {
        setStatus("connecting", "reconnecting…");
        if (isUiActive()) {
          msgInput.disabled = true;
          sendBtn.disabled = true;
        }
      } finally { setActiveRoom(prev); }
    },
    onSignalingError(message) {
      // The server refused something. Into the room, not only the console —
      // "rate limit exceeded" or "older build" is a thing to read, not argue about.
      const prev = activeRoom; setActiveRoom(ctx);
      try { addMessage("", `⚠ signaling: ${message}`, "system"); }
      finally { setActiveRoom(prev); }
    },
    async onMessage(from, data) {
      const prev = activeRoom; setActiveRoom(ctx);
      try {
      // Hearing from a peer is proof it is present. A peer reached only over
      // the flood relay (no direct channel — common for an agent that is a
      // ring neighbor of someone else) never fires onChannelOpen, and if a
      // flap removed it from the roster nothing re-adds it: onPeerJoined only
      // fires on a signaling join/list, which does not repeat while signaling
      // stays up. Result: "the agent replies but is not listed." So a message
      // from an untracked peer puts it (back) on the roster. renderPeers marks
      // it ⚠ only if isReachable is also false, so a relay-reachable agent
      // shows normally.
      if (from && from !== qpeer?.peerId && !peers.has(from)) {
        const pend = pendingLeaves.get(from);
        if (pend !== undefined) { clearTimeout(pend); pendingLeaves.delete(from); }
        peers.add(from);
        if (!peerSeenAt.has(from)) peerSeenAt.set(from, Date.now());
        renderPeers();
      }
      if (typeof data === "object" && data !== null) {
        const d = data as Record<string, unknown>;
        // The overlay's own liveness beacon (peer.ts's periodic flood, kept
        // for isReachable) — nothing to do here, receiving it at all is the
        // point (it updates lastHeardVia inside peer.ts before this fires).
        if (d.kind === "presence") return;
        if (d.kind === "name") {
          const status = await verifyDyncapIfPresent(from, d); setActiveRoom(ctx);
          const nm = String(d.name ?? "");
          if (status.startsWith("  · refused")) {
            // A display name is cosmetic — anyone can `/name` anything, and the
            // dyncap chain never owned it. Refusing to *show* a name because the
            // chain is contested (a /login recovery, a reused peerId) just left
            // the peer as a permanent hex id and the room unusable with them.
            // So apply the label and flag it — but skip the parts that DO trust
            // the chain: the agent pin, and reconcileGroups (which would move
            // group membership / delegations onto this peerId).
            if (nm.trim()) {
              peerNames.set(from, `${nm} ⚠`);
              lastKnownNames.set(from, `${nm} ⚠`);
              renderPeers();
              announceJoin(from);
            }
            addMessage("", `${peerLabel(from)} ${status.trim()} — showing its claimed name with ⚠; treat its identity as unverified`, "system");
            return;
          }
          peerNames.set(from, nm);
          if (nm.trim()) lastKnownNames.set(from, nm);   // sticky cache — survives flaps so the label persists across reconnects
          if (typeof d.agent === "string" && d.agent.trim()) {
            peerAgents.set(from, d.agent.trim());
            qpeer?.dataOnly.add(from);
            // Always keep a direct link to an AI agent regardless of ring
            // position — pins every agent-tagged peer in the room, not
            // specifically "yours"; there's no way from this envelope alone
            // to tell whose agent it is.
            qpeer?.pinNeighbor(from);
          } else {
            peerAgents.delete(from);
            qpeer?.dataOnly.delete(from);
            qpeer?.unpinNeighbor(from);
          }
          // Stamp/reconcile this identity's anchor onto any group membership, so a
          // member returning on a new browser (same anchor, new peerId) is re-linked.
          reconcileGroups(from, (d.dyncap as DyncapField | undefined)?.anchor);
          renderPeers();
          if (nm.trim()) announceJoin(from);   // real name → show "<name> joined" now (else the timeout shows the id)
          if (status) addMessage("", `${peerLabel(from)} ${status.trim()}`, "system");
          return;
        }
        if (d.kind === "qlf") {
          const cmdStr = String(d.cmd ?? "");
          const argStr = String(d.arg ?? "");
          const pLines = d.lines as string[];
          addMessage(from, `/${cmdStr}${argStr ? " " + argStr : ""}`, "peer", peerLabel(from));
          for (const line of pLines) addMessage("", line, "system");
          sessionLog.push({ who: peerLabel(from), cmd: cmdStr, arg: argStr, summary: pLines[0] ?? "" });
          // Keep each peer's latest proposed history so /coupling can cut the room
          // along what people actually contributed (see actionProposals).
          if (cmdStr === "qlf-action") {
            const ptw = parseSymbolicTwists(argStr.trim());
            if (ptw && ptw.length) actionProposals.set(from, { twists: ptw, at: Date.now() });
          }
          return;
        }
        if (d.kind === "cap-grant") {
          const who = peerLabel(from);
          addMessage(from, `/grant ${String(d.label ?? "")}`, "peer", who);
          addMessage("", `  ${String(d.token ?? "")}`, "system");
          addMessage("", `  run /zfa ${String(d.token ?? "")} to verify`, "system");
          return;
        }
        if (d.kind === "lemma") {
          const status = await verifyDyncapIfPresent(from, d); setActiveRoom(ctx);
          if (status.startsWith("  · refused")) {
            addMessage(from, `/lemma ${String(d.name ?? "")}`, "peer", peerLabel(from));
            addMessage("", status, "system");
            return;
          }
          const name = canonLemma(String(d.name ?? ""));
          if (isRetracted("lemma", name)) return;                  // tombstoned — don't heal back
          const twists = String(d.twists ?? "").trim();
          const cap = d.cap ? String(d.cap) : undefined;
          const text = d.text ? canonLemma(String(d.text)) : undefined;
          const who = peerLabel(from);
          const dyncap = (d.dyncap as DyncapField | undefined);
          // Lemmas are content-addressed by name. First-write-wins: if we
          // already have @name with different twists, refuse the new claim
          // and surface the disagreement; the consensus probe will catch up.
          // `text` is cosmetic — first-write-wins, not part of this check.
          const existing = lemmaStore.get(name);
          if (existing && existing.twists !== twists) {
            addMessage(from, `/lemma ${lemmaArgStr(name)} ${twists}`, "peer", who);
            addMessage("", `  ⚠ refused: ${lemmaRefStr(name)} already declared with different twists (${existing.twists})`, "system");
            return;
          }
          if (existing && existing.twists === twists) {
            return;   // idempotent re-broadcast, silent
          }
          if (name && twists) {
            lemmaStore.set(name, { twists, who, cap, dyncap, text: text && text !== name ? text : undefined });
            addMessage(from, `/lemma ${text ?? lemmaArgStr(name)}${text ? "" : ` ${twists}`}`, "peer", who);
            addMessage("", `  ${lemmaRefStr(name)} registered from ${who}${text ? `  “${text}”` : ""}${cap ? `  [cap: ${cap}]` : ""}${dyncap ? `  [signed seq=${dyncap.seq}]` : ""}`, "system");
            saveLemmas();
            renderLemmas();
          }
          return;
        }
        if (d.kind === "lemma-request") {
          const name = canonLemma(String(d.name ?? ""));
          const fromName = String(d.fromName ?? peerLabel(from));
          addMessage(from, `requests ${lemmaRefStr(name)}`, "peer", fromName);
          if (lemmaStore.has(name)) {
            addMessage("", `  · you hold ${lemmaRefStr(name)} — type /pass ${lemmaArgStr(name)} ${fromName} to transfer`, "system");
          }
          return;
        }
        if (d.kind === "lemma-pass") {
          const name = canonLemma(String(d.name ?? ""));
          const twists = String(d.twists ?? "").trim();
          const cap = d.cap ? String(d.cap) : undefined;
          const who = peerLabel(from);
          if (name && twists) {
            lemmaStore.set(name, { twists, who, cap });
            saveLemmas();
            renderLemmas();
            addMessage(from, `passes ${lemmaRefStr(name)}`, "peer", who);
            addMessage("", `  · ${lemmaRefStr(name)} received from ${who}${cap ? `  [cap: ${cap}]` : ""}`, "system");
            if (cap) addMessage("", `  · run /zfa ${cap} to verify`, "system");
          }
          return;
        }
        if (d.kind === "note-declare") {
          const status = await verifyDyncapIfPresent(from, d); setActiveRoom(ctx);
          if (status.startsWith("  · refused")) {
            addMessage(from, `/note declare ${String(d.currency ?? "")}`, "peer", peerLabel(from));
            addMessage("", status, "system");
            return;
          }
          const currency = String(d.currency ?? "");
          const token    = String(d.token ?? "");
          const who      = peerLabel(from);
          const dyncap   = (d.dyncap as DyncapField | undefined);
          addMessage(from, `/note declare ${currency}`, "peer", who);
          const parsed = parseNoteLabel(token);
          const valid  = parsed?.kind === "token" && parsed.currency === currency && validateCapability(token);
          if (!valid) {
            addMessage("", `  · refused: malformed currency authority token`, "system");
            return;
          }
          if (!knownCurrencies.has(token)) {
            knownCurrencies.set(token, { currency, token, issuer: who, dyncap });
            saveNotes();
            renderNotes();
          }
          addMessage("", `  · ${who} issues ${currency}  authority: ${token}${dyncap ? `  [signed seq=${dyncap.seq}]` : ""}`, "system");
          return;
        }
        if (d.kind === "note-grant") {
          const currency = String(d.currency ?? "");
          const N        = Number(d.denomination ?? 0);
          const who      = peerLabel(from);
          addMessage(from, `/note grant ${currency} ${N}`, "peer", who);
          addMessage("", `  · ${who} minted ${currency} ${N}`, "system");
          return;
        }
        if (d.kind === "note-pass") {
          const currency = String(d.currency ?? "");
          const N        = Number(d.denomination ?? 0);
          const token    = String(d.token ?? "");
          const who      = peerLabel(from);
          // Validate format and balance before accepting.
          const parsed = parseNoteLabel(token);
          const valid  = parsed?.kind === "note" && parsed.currency === currency
                       && noteDenomination(token) === N && validateCapability(token);
          if (!valid) {
            addMessage(from, `passes ${currency} ${N}`, "peer", who);
            addMessage("", `  · refused: malformed or unbalanced note token`, "system");
            return;
          }
          noteStore.set(token, { token, currency, denomination: N, receivedFrom: who });
          // Absorb a terms cache if the note is stamped: the passed text must
          // hash to the stamp baked in the token (self-verifying). The issuer's
          // dyncap-signed note-series, when present/synced, is authoritative and
          // overrides this. We don't overwrite an already-known series.
          if (parsed.series && typeof d.terms === "string" && !seriesTerms.has(currency)) {
            const t = String(d.terms);
            if (termsHash8(t) === parsed.series) {
              seriesTerms.set(currency, { seriesKey: currency, baseCurrency: parsed.baseCurrency, termsHash: parsed.series, terms: t, issuer: "(unconfirmed)" });
            }
          }
          saveNotes();
          renderNotes();
          addMessage(from, `passes ${currency} ${N}`, "peer", who);
          addMessage("", `  · received ${currency} ${N} from ${who}${parsed.series ? "  · 📜 terms " + parsed.series : ""}`, "system");
          if (parsed.series && seriesTerms.has(currency)) addMessage("", `    terms: ${seriesTerms.get(currency)!.terms}  (/note accept ${currency} to agree)`, "system");
          addMessage("", `    ${token}`, "system");
          return;
        }
        if (d.kind === "note-redeem") {
          const currency = String(d.currency ?? "");
          const N        = Number(d.denomination ?? 0);
          const token    = String(d.token ?? "");
          const who      = peerLabel(from);
          addMessage(from, `redeems ${currency} ${N}`, "peer", who);
          const parsed = parseNoteLabel(token);
          const valid  = parsed?.kind === "note" && parsed.currency === currency
                       && noteDenomination(token) === N && validateCapability(token);
          if (!valid) {
            addMessage("", `  · refused: malformed or unbalanced note token`, "system");
            return;
          }
          // Issuance is on the BASE currency; a stamped note (USD~hash) is still
          // issued by whoever issues USD.
          if (!currencyTokens.has(parsed.baseCurrency)) {
            addMessage("", `  · refused: you don't issue ${parsed.baseCurrency}`, "system");
            return;
          }
          const receipt = mintReceipt(currency, N);
          const myLabel = myName || (qpeer ? shortId(qpeer.peerId) : "local");
          redemptionsHonored.set(token, { token, currency, denomination: N, redeemer: who, at: Date.now() });
          saveNotes();
          renderNotes();
          const ok = qpeer?.send(from, { kind: "note-receipt", currency, denomination: N, token: receipt, original: token, issuer: myLabel });
          if (!ok) {
            addMessage("", `  · receipt minted but could not deliver — peer unreachable`, "system");
            return;
          }
          addMessage("", `  · honored: ${currency} ${N} for ${who}`, "system");
          addMessage("", `    receipt: ${receipt}`, "system");
          return;
        }
        if (d.kind === "note-receipt") {
          const currency = String(d.currency ?? "");
          const N        = Number(d.denomination ?? 0);
          const token    = String(d.token ?? "");
          const issuer   = String(d.issuer ?? peerLabel(from));
          const parsed = parseNoteLabel(token);
          const valid  = parsed?.kind === "receipt" && parsed.currency === currency
                       && noteDenomination(token) === N && validateCapability(token);
          if (!valid) {
            addMessage(from, `sends receipt`, "peer", issuer);
            addMessage("", `  · refused: malformed receipt token`, "system");
            return;
          }
          receiptStore.set(token, { token, currency, denomination: N, issuer });
          saveNotes();
          renderNotes();
          addMessage(from, `issues receipt for ${currency} ${N}`, "peer", issuer);
          addMessage("", `  · ${currency} ${N} redemption honored by ${issuer}`, "system");
          addMessage("", `    ${token}`, "system");
          return;
        }
        if (d.kind === "note-series") {
          const status = await verifyDyncapIfPresent(from, d); setActiveRoom(ctx);
          if (status.startsWith("  · refused")) return;
          const seriesKey    = String(d.seriesKey ?? "");
          const baseCurrency = String(d.baseCurrency ?? "");
          const termsHash    = String(d.termsHash ?? "");
          const terms        = String(d.terms ?? "");
          // Self-consistency: the series id must be base~hash and the stamp must
          // commit to exactly these terms.
          if (!seriesKey || !baseCurrency || !termsHash || !terms) return;
          if (termsHash8(terms) !== termsHash || seriesKey !== `${baseCurrency}~${termsHash}`) return;
          // Issuer authority: if we know who issues baseCurrency, the sender's
          // verified anchor must match (like the lemma-retract author check).
          const senderAnchor = dyncapChains.get(from)?.anchor;
          const known = [...knownCurrencies.values()].find((c) => c.currency === baseCurrency);
          if (known?.dyncap && senderAnchor && known.dyncap.anchor !== senderAnchor) return;
          const dyncap = d.dyncap as DyncapField | undefined;
          const prev = seriesTerms.get(seriesKey);
          // A signed declaration is authoritative; overwrite an unconfirmed cache.
          if (!prev || prev.issuer === "(unconfirmed)") {
            seriesTerms.set(seriesKey, { seriesKey, baseCurrency, termsHash, terms, issuer: peerLabel(from), dyncap });
            saveNotes();
            renderNotes();
            addMessage(from, `📜 terms for ${seriesKey}`, "peer", peerLabel(from));
            addMessage("", `  · ${terms}`, "system");
          }
          return;
        }
        if (d.kind === "sync-series") {
          const raw = d.entries;
          if (!Array.isArray(raw)) return;
          let added = 0;
          for (const e of raw as Array<Record<string, unknown>>) {
            const seriesKey    = String(e.seriesKey ?? "");
            const baseCurrency = String(e.baseCurrency ?? "");
            const termsHash    = String(e.termsHash ?? "");
            const terms        = String(e.terms ?? "");
            if (!seriesKey || !terms) continue;
            if (termsHash8(terms) !== termsHash || seriesKey !== `${baseCurrency}~${termsHash}`) continue;
            const prev = seriesTerms.get(seriesKey);
            if (prev && prev.issuer !== "(unconfirmed)") continue;
            seriesTerms.set(seriesKey, { seriesKey, baseCurrency, termsHash, terms, issuer: String(e.issuer ?? peerLabel(from)), dyncap: e.dyncap as DyncapField | undefined });
            added++;
          }
          if (added > 0) { saveNotes(); renderNotes(); }
          return;
        }
        if (d.kind === "sync-lemmas") {
          const raw = d.entries;
          if (!Array.isArray(raw)) return;
          if (ignoredForSync.has(from)) {
            addMessage("", `  · dropped sync-lemmas from ${peerLabel(from)} (ignored: losing observer)`, "system");
            return;
          }
          const entries = raw as Array<{ name?: string; twists?: string; who?: string; cap?: string; dyncap?: DyncapField; event?: boolean; text?: string }>;
          const who = peerLabel(from);
          // Record observations for the probe window even when we also apply.
          // Pair with sync-currencies if it arrives in the same handshake.
          if (probe.open) recordSyncObservations(from, entries, []);
          let added = 0;
          let addedEvents = 0;
          for (const e of entries) {
            const name   = canonLemma(String(e.name ?? ""));
            const twists = String(e.twists ?? "").trim();
            if (!name || !twists) continue;
            if (lemmaStore.has(name) || isRetracted("lemma", name)) continue;
            const tw = resolveLemmaToBytes(twists);
            if (!tw || !achievesZfa(tw)) continue;
            const text = e.text ? canonLemma(String(e.text)) : undefined;
            lemmaStore.set(name, { twists, who: e.who || who, cap: e.cap, dyncap: e.dyncap, event: e.event, text: text && text !== name ? text : undefined });
            added++;
            if (e.event) addedEvents++;
          }
          if (added > 0) {
            saveLemmas();
            renderLemmas();
            addMessage(from, `sync`, "peer", who);
            const evNote = addedEvents === added ? " (discovered events)" : addedEvents ? ` (${addedEvents} events)` : "";
            addMessage("", `  · synced ${added} lemma${added === 1 ? "" : "s"} from ${who}${evNote}`, "system");
          }
          return;
        }
        if (d.kind === "sync-currencies") {
          const raw = d.entries;
          if (!Array.isArray(raw)) return;
          if (ignoredForSync.has(from)) {
            addMessage("", `  · dropped sync-currencies from ${peerLabel(from)} (ignored: losing observer)`, "system");
            return;
          }
          const entries = raw as Array<{ currency?: string; token?: string; issuer?: string; dyncap?: DyncapField }>;
          const who = peerLabel(from);
          if (probe.open) recordSyncObservations(from, [], entries);
          let added = 0;
          for (const e of entries) {
            const currency = String(e.currency ?? "").trim();
            const token    = String(e.token    ?? "").trim();
            if (!currency || !token) continue;
            if (knownCurrencies.has(token)) continue;
            const parsed = parseNoteLabel(token);
            if (!parsed || parsed.kind !== "token" || parsed.currency !== currency) continue;
            if (!validateCapability(token)) continue;
            knownCurrencies.set(token, { currency, token, issuer: e.issuer || who, dyncap: e.dyncap });
            added++;
          }
          if (added > 0) {
            saveNotes();
            renderNotes();
            addMessage(from, `sync`, "peer", who);
            addMessage("", `  · synced ${added} currenc${added === 1 ? "y" : "ies"} from ${who}`, "system");
          }
          return;
        }
        if (d.kind === "state-discrepancy") {
          await verifyDyncapIfPresent(from, d); setActiveRoom(ctx);
          const storeName = String(d.storeName ?? "");
          const key       = String(d.key       ?? "");
          const obsRaw    = d.observations;
          const observations = Array.isArray(obsRaw) ? obsRaw as Array<{ peers: string[]; count: number; weight: number }> : [];
          const winnerLeader = observations[0];
          const tally = winnerLeader
            ? `weight ${winnerLeader.weight} vs ${observations.slice(1).map(o => o.weight).join(", ")} · ${winnerLeader.count} vs ${observations.slice(1).map(o => o.count).join(", ")} peers`
            : "no observations";
          addMessage(from, `⚠ discrepancy on ${storeName}/${key}`, "peer", peerLabel(from));
          if (d.winner === null || d.winner === undefined) {
            addMessage("", `  · contested by ${peerLabel(from)} (no supermajority); ${tally}`, "system");
          } else {
            addMessage("", `  · supermajority winner declared by ${peerLabel(from)}; ${tally}`, "system");
          }
          return;
        }
        if (d.kind === "rdv-propose") {
          const proposalRaw = d.proposal;
          if (!proposalRaw || typeof proposalRaw !== "object") return;
          const proposal = proposalRaw as Proposal;
          if (!proposal.id || !Array.isArray(proposal.rows) || typeof proposal.expiresAt !== "number") return;
          if (proposal.expiresAt < Date.now()) return;
          if (!conservationCheck(proposal.rows)) {
            addMessage(from, `proposes rendezvous`, "peer", peerLabel(from));
            addMessage("", `  · refused: conservation violation`, "system");
            return;
          }
          if (proposals.has(proposal.id)) return;
          const myId = qpeer?.peerId ?? "";
          const myRow = proposal.rows.find(r => r.participant === myId);
          if (!myRow) return;
          proposals.set(proposal.id, {
            proposal, role: "participant", myStatus: "pending",
            acceptedBy: new Map(),
          });
          scheduleProposalTimeout(proposal.id, proposal.expiresAt - Date.now());
          saveNotes();
          renderNotes();
          addMessage(from, `proposes rendezvous ${shortRdvId(proposal.id)}`, "peer", peerLabel(from));
          addMessage("", `  · you give ${myRow.gives.currency} ${myRow.gives.denomination}, get ${myRow.gets.currency} ${myRow.gets.denomination}`, "system");
          addMessage("", `  · /rdv accept ${shortRdvId(proposal.id)}   or   /rdv reject ${shortRdvId(proposal.id)}`, "system");
          return;
        }
        if (d.kind === "rdv-accept") {
          const id = String(d.id ?? "");
          const token = String(d.token ?? "");
          const state = proposals.get(id);
          if (!state || state.role !== "proposer") return;
          const senderRow = state.proposal.rows.find(r => r.participant === from);
          if (!senderRow) return;
          const parsed = parseNoteLabel(token);
          if (!parsed || parsed.kind !== "note"
              || parsed.currency !== senderRow.gives.currency
              || noteDenomination(token) !== senderRow.gives.denomination
              || !validateCapability(token)) {
            addMessage(from, `accepts rdv ${shortRdvId(id)}`, "peer", peerLabel(from));
            addMessage("", `  · refused: token mismatch or invalid`, "system");
            return;
          }
          state.acceptedBy.set(from, token);
          addMessage(from, `accepts rdv ${shortRdvId(id)}`, "peer", peerLabel(from));
          const participants = uniqueParticipants(state.proposal);
          if (!participants.every(p => state.acceptedBy.has(p))) return;

          // All accepted — build commit (cyclic: row[i].gets = next row's gives)
          const N = state.proposal.rows.length;
          const commitRows: CommitRow[] = state.proposal.rows.map((r, i) => {
            const nextRow = state.proposal.rows[(i + 1) % N];
            return {
              participant: r.participant,
              givesToken: state.acceptedBy.get(r.participant)!,
              getsToken:  state.acceptedBy.get(nextRow.participant)!,
            };
          });
          const self = qpeer?.peerId ?? "";
          if (qpeer) {
            for (const p of participants) {
              if (p === self) continue;
              qpeer.send(p, { kind: "rdv-commit", id, rows: commitRows });
            }
          }
          const ok = applyCommit(state, commitRows);
          proposals.delete(id);
          clearProposalTimeout(id);
          saveNotes();
          renderNotes();
          addMessage("", ok ? `  · committed rdv ${shortRdvId(id)}` : `  · commit application failed locally`, "system");
          return;
        }
        if (d.kind === "rdv-reject") {
          const id = String(d.id ?? "");
          const state = proposals.get(id);
          if (!state || state.role !== "proposer") return;
          addMessage(from, `rejects rdv ${shortRdvId(id)}`, "peer", peerLabel(from));
          releaseLockedFor(id);
          if (qpeer) {
            const self = qpeer.peerId;
            const targets = uniqueParticipants(state.proposal).filter(p => p !== self && p !== from);
            for (const t of targets) qpeer.send(t, { kind: "rdv-abort", id, reason: "peer-rejected" });
          }
          proposals.delete(id);
          clearProposalTimeout(id);
          saveNotes();
          renderNotes();
          addMessage("", `  · rdv ${shortRdvId(id)} aborted`, "system");
          return;
        }
        if (d.kind === "rdv-commit") {
          const id = String(d.id ?? "");
          const rowsRaw = d.rows;
          if (!Array.isArray(rowsRaw)) return;
          const commitRows = rowsRaw as CommitRow[];
          const state = proposals.get(id);
          if (!state || state.role !== "participant") return;
          if (state.myStatus !== "accepted") return;
          const ok = applyCommit(state, commitRows);
          proposals.delete(id);
          clearProposalTimeout(id);
          saveNotes();
          renderNotes();
          addMessage(from, `commits rdv ${shortRdvId(id)}`, "peer", peerLabel(from));
          addMessage("", ok ? `  · rdv ${shortRdvId(id)} settled` : `  · commit application failed`, "system");
          return;
        }
        if (d.kind === "rdv-abort") {
          const id = String(d.id ?? "");
          const reason = String(d.reason ?? "");
          const state = proposals.get(id);
          if (!state) return;
          releaseLockedFor(id);
          proposals.delete(id);
          clearProposalTimeout(id);
          saveNotes();
          renderNotes();
          addMessage(from, `aborts rdv ${shortRdvId(id)}`, "peer", peerLabel(from));
          addMessage("", `  · rdv ${shortRdvId(id)} cancelled${reason ? ` (${reason})` : ""}`, "system");
          return;
        }
        if (d.kind === "rdv-counter") {
          // The other participant proposed new terms for an in-flight rdv.
          // Validate, release any locks we hold for it (terms changed —
          // any token we had reserved is no longer the right one), and
          // replace the proposal's rows. Our status resets to pending; the
          // counterer's status is "accepted" (acceptedBy tracks them).
          const id = String(d.id ?? "");
          const rowsRaw = d.rows;
          if (!Array.isArray(rowsRaw)) return;
          const newRows = rowsRaw as Row[];
          const state = proposals.get(id);
          if (!state) {
            addMessage(from, `counters rdv ${shortRdvId(id)}`, "peer", peerLabel(from));
            addMessage("", `  · refused: no matching proposal`, "system");
            return;
          }
          if (!conservationCheck(newRows)) {
            addMessage(from, `counters rdv ${shortRdvId(id)}`, "peer", peerLabel(from));
            addMessage("", `  · refused: conservation violation`, "system");
            return;
          }
          const myId = qpeer?.peerId ?? "";
          const myNewRow = newRows.find(r => r.participant === myId);
          if (!myNewRow) {
            addMessage(from, `counters rdv ${shortRdvId(id)}`, "peer", peerLabel(from));
            addMessage("", `  · refused: I have no row in the new terms`, "system");
            return;
          }

          // Validate the counterer's committed token: must be a real note
          // matching their new row's gives spec, and ZFA-balanced.
          const counterToken = String(d.token ?? "");
          const senderRow = newRows.find(r => r.participant === from);
          if (!senderRow) {
            addMessage(from, `counters rdv ${shortRdvId(id)}`, "peer", peerLabel(from));
            addMessage("", `  · refused: counterer has no row in new terms`, "system");
            return;
          }
          const parsedTok = parseNoteLabel(counterToken);
          if (!parsedTok || parsedTok.kind !== "note"
              || parsedTok.currency !== senderRow.gives.currency
              || noteDenomination(counterToken) !== senderRow.gives.denomination
              || !validateCapability(counterToken)) {
            addMessage(from, `counters rdv ${shortRdvId(id)}`, "peer", peerLabel(from));
            addMessage("", `  · refused: counterer's token doesn't match new terms`, "system");
            return;
          }

          // Release any locks held for the previous round.
          releaseLockedFor(id);
          state.acceptedBy.clear();
          state.acceptedBy.set(from, counterToken);   // counterer implicitly accepted with this token
          state.proposal.rows = newRows;
          state.proposal.proposerName = String(d.proposerName ?? peerLabel(from));
          state.proposal.expiresAt = Date.now() + RDV_TIMEOUT_MS;
          state.myStatus = "pending";
          clearProposalTimeout(id);
          scheduleProposalTimeout(id, RDV_TIMEOUT_MS);
          saveNotes();
          renderNotes();

          addMessage(from, `counters rdv ${shortRdvId(id)}`, "peer", peerLabel(from));
          addMessage("", `  · new terms: you give ${myNewRow.gives.currency} ${myNewRow.gives.denomination}, get ${myNewRow.gets.currency} ${myNewRow.gets.denomination}`, "system");
          addMessage("", `  · /rdv accept ${shortRdvId(id)}  |  /rdv reject ${shortRdvId(id)}  |  /rdv counter ${shortRdvId(id)} <giveCur> <giveN> <getCur> <getN>`, "system");
          return;
        }
        if (d.kind === "persist-request") {
          const id = String(d.id ?? "");
          const persistKind = String(d.persistKind ?? "");
          const fromName = String(d.fromName ?? peerLabel(from));
          if (!id || (persistKind !== "lemma" && persistKind !== "currency")) return;
          const req: PersistRequest = {
            id, kind: persistKind as PersistKind,
            fromPeer: from, fromName,
          };
          if (persistKind === "lemma") {
            req.lemmaName = String(d.lemmaName ?? "");
            req.lemmaEntry = d.lemmaEntry as LemmaEntry | undefined;
            if (!req.lemmaName || !req.lemmaEntry?.twists) return;
            addMessage(from, `requests you persist @${req.lemmaName}`, "peer", fromName);
            addMessage("", `  · twists: ${req.lemmaEntry.twists}${req.lemmaEntry.cap ? `  [cap: ${req.lemmaEntry.cap}]` : ""}`, "system");
          } else {
            req.currencyToken = String(d.currencyToken ?? "");
            req.currencyEntry = d.currencyEntry as KnownCurrency | undefined;
            if (!req.currencyToken || !req.currencyEntry?.currency) return;
            addMessage(from, `requests you persist currency ${req.currencyEntry.currency}`, "peer", fromName);
            addMessage("", `  · authority: ${req.currencyToken.slice(0, 24)}…  (issued by ${req.currencyEntry.issuer})`, "system");
          }
          pendingPersistRequests.set(id, req);
          addMessage("", `  · /persist accept ${id.slice(0, 8)}  or  /persist reject ${id.slice(0, 8)}`, "system");
          return;
        }
        if (d.kind === "channel-msg") {
          const ch = String(d.channel ?? "");
          const payload = String(d.payload ?? "");
          // Subscribed channels surface in chat; unsubscribed channels are
          // silently dropped — the tagged broadcast is a public envelope but
          // the filter is per-receiver.
          if (channelSubscriptions.has(ch)) {
            addMessage(from, `[#${ch}] ${payload}`, "peer", peerLabel(from));
          }
          // RhoQu `on channel(x) { … }` handlers fire on every matching
          // channel-msg regardless of subscription. Each fires once per
          // delivery; the body runs with `x` bound to the payload.
          for (const h of rhoquHandlers) {
            if (h.channel !== ch) continue;
            try {
              const cmds = h.trigger(payload);
              if (cmds.length === 0) continue;
              addMessage("", `  · rhoqu on ${ch}(${h.binding}=${payload}) → ${cmds.length} cmd${cmds.length === 1 ? "" : "s"}`, "system");
              for (const c of cmds) {
                try { handleCommand(c); }
                catch (err) { addMessage("", `  · rhoqu trigger error: ${String(err)}`, "system"); }
              }
            } catch (err) {
              addMessage("", `  · rhoqu on-handler error for ${ch}: ${String(err)}`, "system");
            }
          }
          return;
        }
        if (d.kind === "poll-open") {
          const status = await verifyDyncapIfPresent(from, d); setActiveRoom(ctx);
          if (status.startsWith("  · refused")) return;
          const id = String(d.id ?? "");
          if (!id || pollStore.has(id)) return;                    // idempotent
          if (isRetracted("poll", id)) return;                     // tombstoned — don't heal back
          const options: PollOption[] = [];
          if (Array.isArray(d.options)) {
            for (const o of d.options as unknown[]) {
              if (o && typeof o === "object") {
                const r = o as Record<string, unknown>;
                const text = String(r.text ?? "").trim();
                if (!text) continue;
                options.push({ id: String(r.id ?? optionId(text)), text, by: String(r.by ?? "?"), at: typeof r.at === "number" ? r.at : Date.now() });
              }
            }
          }
          const poll: Poll = {
            id, question: String(d.question ?? ""), options,
            method: d.method === "ranked" ? "ranked" : "approval",
            creator: from, creatorLabel: String(d.creatorLabel ?? peerLabel(from)),
            createdAt: typeof d.createdAt === "number" ? d.createdAt : Date.now(),
            status: "open", ballots: {},
          };
          flushBufferedOptions(poll);                              // out-of-order options
          flushBufferedBallots(poll);                              // out-of-order ballots
          pollStore.set(id, poll);
          savePolls();
          renderPolls();
          addPollCard(poll);
          return;
        }
        if (d.kind === "poll-option") {
          const status = await verifyDyncapIfPresent(from, d); setActiveRoom(ctx);
          if (status.startsWith("  · refused")) return;
          const pollId = String(d.pollId ?? "");
          if (isRetracted("poll", pollId)) return;                     // tombstoned
          const text = String(d.text ?? "").trim();
          if (!text) return;
          const opt: PollOption = {
            id: String(d.id ?? optionId(text)), text,
            by: String(d.by ?? peerLabel(from)),
            at: typeof d.at === "number" ? d.at : Date.now(),
          };
          const poll = pollStore.get(pollId);
          if (!poll) { bufferOption(pollId, opt); return; }            // arrived before poll-open
          if (poll.nominationsLocked || poll.status === "closed") return;
          if (!mergeOption(poll, opt)) return;                         // duplicate
          savePolls();
          refreshPollCard(poll);
          renderPolls();
          return;
        }
        if (d.kind === "poll-lock") {
          const status = await verifyDyncapIfPresent(from, d); setActiveRoom(ctx);
          if (status.startsWith("  · refused")) return;
          const poll = pollStore.get(String(d.pollId ?? ""));
          if (!poll || from !== poll.creator) return;
          poll.nominationsLocked = true;
          savePolls();
          refreshPollCard(poll);
          return;
        }
        if (d.kind === "poll-ballot") {
          const status = await verifyDyncapIfPresent(from, d); setActiveRoom(ctx);
          if (status.startsWith("  · refused")) return;
          const pollId = String(d.pollId ?? "");
          if (isRetracted("poll", pollId)) return;                     // tombstoned
          const choices = Array.isArray(d.choices)
            ? (d.choices as unknown[]).map(String).filter((x) => x.length > 0) : [];
          const poll = pollStore.get(pollId);
          if (!poll) { bufferBallot(pollId, from, choices); return; }   // arrived before poll-open
          if (poll.status === "closed") return;                        // late ballot ignored
          poll.ballots[from] = choices;                                // latest wins
          savePolls();
          refreshPollCard(poll);
          renderPolls();
          return;
        }
        if (d.kind === "poll-close") {
          const status = await verifyDyncapIfPresent(from, d); setActiveRoom(ctx);
          if (status.startsWith("  · refused")) return;
          const poll = pollStore.get(String(d.pollId ?? ""));
          if (!poll || poll.status === "closed") return;               // idempotent
          if (from !== poll.creator) return;                           // only creator closes
          poll.status = "closed";
          poll.result = tally(poll);
          savePolls();
          refreshPollCard(poll);
          renderPolls();
          postPollClosedMessage(poll);
          return;
        }
        if (d.kind === "estimate-open") {
          const status = await verifyDyncapIfPresent(from, d); setActiveRoom(ctx);
          if (status.startsWith("  · refused")) return;
          const id = String(d.id ?? "");
          if (!id || estimateRound?.id === id) return;                 // idempotent
          estimateRound = {
            id, question: String(d.question ?? ""), creator: from,
            values: new Map(), open: true,
            tally: d.tally === "mean" ? "mean" : "median",
          };
          addMessage("", `📊 estimate round opened by ${peerLabel(from)} — “${estimateRound.question}” (submit with /estimate <number>)`, "system");
          return;
        }
        if (d.kind === "estimate-value") {
          const status = await verifyDyncapIfPresent(from, d); setActiveRoom(ctx);
          if (status.startsWith("  · refused")) return;
          if (!estimateRound || estimateRound.id !== String(d.id ?? "") || !estimateRound.open) return;
          const v = Number(d.value);
          if (isNaN(v)) return;
          estimateRound.values.set(from, v);                           // latest wins
          return;
        }
        if (d.kind === "estimate-close") {
          const status = await verifyDyncapIfPresent(from, d); setActiveRoom(ctx);
          if (status.startsWith("  · refused")) return;
          if (!estimateRound || estimateRound.id !== String(d.id ?? "")) return;
          if (from !== estimateRound.creator) return;                  // only opener closes
          estimateRound.open = false;
          addMessage("", `📊 estimate round closed by ${peerLabel(from)} — “${estimateRound.question}” (type /estimate status)`, "system");
          return;
        }
        if (d.kind === "sync-polls") {
          const status = await verifyDyncapIfPresent(from, d); setActiveRoom(ctx);
          if (status.startsWith("  · refused")) return;
          if (!Array.isArray(d.polls)) return;
          let added = 0, updated = 0;
          for (const raw of d.polls as unknown[]) {
            const r = mergePollFromSync(raw);
            if (r === "added") { added++; const p = pollStore.get(String((raw as Record<string, unknown>).id)); if (p) { addPollCard(p); if (p.status === "closed") postPollClosedMessage(p); } }
            else if (r === "updated") { updated++; const p = pollStore.get(String((raw as Record<string, unknown>).id)); if (p) refreshPollCard(p); }
          }
          if (added > 0 || updated > 0) {
            savePolls();
            renderPolls();
            if (added > 0) addMessage("", `  · synced ${added} poll${added === 1 ? "" : "s"} from ${peerLabel(from)}`, "system");
          }
          return;
        }
        if (d.kind === "retract") {
          const status = await verifyDyncapIfPresent(from, d); setActiveRoom(ctx);
          if (status.startsWith("  · refused")) return;
          const what = String(d.what ?? "");
          const id = String(d.id ?? "");
          if (!id) return;
          if (what === "library") {
            // Only whoever added it, as with a poll's creator: an entry names
            // content by its hash, so a retract from anyone else would be one
            // peer deciding what a room may remember.
            const entry = libraryStore.get(id.toLowerCase());
            if (!entry || entry.addedBy !== from) return;
            markRetracted("library", entry.hash);
            libraryStore.delete(entry.hash);
            if (heldFiles.has(entry.hash)) { heldFiles.delete(entry.hash); void dropBytes(entry.hash); }
            saveLibrary();
            addMessage("", `${peerLabel(from)} retracted ${entry.name} from the library`, "system");
            return;
          }
          if (what === "poll") {
            const poll = pollStore.get(id);
            if (!poll || from !== poll.creator) return;   // only the creator can retract a poll for everyone
            markRetracted("poll", id);
            removePollLocal(poll);
            renderPolls();
            addMessage("", `🗳 poll retracted by ${peerLabel(from)} — “${poll.question}”`, "system");
          } else if (what === "lemma") {
            const name = canonLemma(id);
            const entry = lemmaStore.get(name);
            // Honor only the author: the sender's verified anchor must match the
            // anchor we recorded when the lemma was declared. Unverifiable
            // retracts (we don't hold it, or it carried no dyncap) are ignored,
            // so a peer can't tombstone lemmas it doesn't own.
            const senderAnchor = dyncapChains.get(from)?.anchor;
            if (!entry || !entry.dyncap || !senderAnchor || entry.dyncap.anchor !== senderAnchor) return;
            markRetracted("lemma", name);
            lemmaStore.delete(name);
            saveLemmas();
            renderLemmas();
            addMessage("", `  · ${lemmaRefStr(name)} retracted by ${peerLabel(from)}`, "system");
          } else if (what === "macro") {
            const def = macroStore.get(id.toLowerCase());
            // Author only, by anchor — same check as a lemma retract.
            const senderAnchor = dyncapChains.get(from)?.anchor;
            if (!def || !def.anchor || !senderAnchor || def.anchor !== senderAnchor) return;
            tombstoneMacro(id.toLowerCase());
            macroStore.delete(id.toLowerCase());
            saveMacros();
            renderMacros();
            addMessage("", `  · $${id.toLowerCase()} retracted by ${peerLabel(from)}`, "system");
          } else if (what === "group") {
            const g = groupStore.get(id);
            if (!g || from !== g.creator) return;          // only the creator disbands for everyone
            markRetracted("group", id);
            groupStore.delete(id);
            const node = govCards.get(id); if (node?.isConnected) node.remove();
            govCards.delete(id);
            saveGroups();
            renderGroups();
            addMessage("", `🏛 group “${g.name}” disbanded by ${peerLabel(from)}`, "system");
          }
          return;
        }
        if (d.kind === "macro-define") {
          const status = await verifyDyncapIfPresent(from, d); setActiveRoom(ctx);
          if (status.startsWith("  · refused")) return;
          const def = macroFromWire(d, from);
          if (!def) return;
          if (isMacroTombstoned(def.name)) return;             // I removed it; don't heal it back
          const existing = macroStore.get(def.name);
          // First writer wins the name, and only that author may replace the
          // definition. Without the anchor check any peer could redefine
          // somebody's `+command` under them, which is the one thing a shared
          // command library cannot survive.
          if (existing) {
            if (!existing.anchor || !def.anchor || existing.anchor !== def.anchor) return;
            if (def.at <= existing.at) return;                    // stale or replayed
          }
          macroStore.set(def.name, def);
          saveMacros();
          renderMacros();
          addMessage(from, `${existing ? "redefined" : "defined"} ${macroCallForm(def)}${def.doc ? `  — ${def.doc}` : ""}`,
                     "peer", def.authorLabel);
          return;
        }
        if (d.kind === "sync-macros") {
          const status = await verifyDyncapIfPresent(from, d); setActiveRoom(ctx);
          if (status.startsWith("  · refused")) return;
          if (ignoredForSync.has(from)) return;
          const raws = Array.isArray(d.macros) ? d.macros : [];
          let added = 0;
          for (const raw of raws) {
            if (!raw || typeof raw !== "object") continue;
            const def = macroFromWire(raw as Record<string, unknown>, from);
            if (!def) continue;
            if (isMacroTombstoned(def.name)) continue;
            const existing = macroStore.get(def.name);
            // A forwarded definition carries its original author's chain step,
            // so a later edit still only lands under the same anchor.
            if (existing) {
              if (!existing.anchor || !def.anchor || existing.anchor !== def.anchor || def.at <= existing.at) continue;
            }
            macroStore.set(def.name, def);
            added++;
          }
          if (added > 0) {
            saveMacros();
            renderMacros();
            addMessage("", `  · ${added} command${added === 1 ? "" : "s"} from ${peerLabel(from)}`, "system");
          }
          return;
        }
        if (d.kind === "group-open") {
          const status = await verifyDyncapIfPresent(from, d); setActiveRoom(ctx);
          if (status.startsWith("  · refused")) return;
          const id = String(d.id ?? "");
          if (!id || groupStore.has(id) || isRetracted("group", id)) return;
          const creatorLabel = String(d.creatorLabel ?? peerLabel(from));
          const g: Group = {
            id, name: String(d.name ?? ""), creator: from, creatorLabel,
            createdAt: typeof d.createdAt === "number" ? d.createdAt : Date.now(),
            members: { [from]: { peerId: from, role: "admin", label: creatorLabel, at: Date.now() } },
            delegations: {}, issues: [],
          };
          groupStore.set(id, g);
          saveGroups(); renderGroups();
          addMessage(from, `created group “${g.name}”`, "peer", creatorLabel);
          addGroupCard(g);
          return;
        }
        if (d.kind === "group-member") {
          const status = await verifyDyncapIfPresent(from, d); setActiveRoom(ctx);
          if (status.startsWith("  · refused")) return;
          const g = groupStore.get(String(d.groupId ?? ""));
          if (!g || !isAdmin(g, from, dyncapChains.get(from)?.anchor)) return;   // only admins manage membership
          const peerId = String(d.peerId ?? ""); if (!peerId) return;
          if (d.remove === true) { delete g.members[peerId]; delete g.delegations[peerId]; }
          else g.members[peerId] = { peerId, role: d.role === "admin" ? "admin" : "member", label: String(d.label ?? peerLabel(peerId)), at: Date.now() };
          saveGroups(); renderGroups(); refreshGroupCard(g);
          return;
        }
        if (d.kind === "group-meta") {
          const status = await verifyDyncapIfPresent(from, d); setActiveRoom(ctx);
          if (status.startsWith("  · refused")) return;
          const g = groupStore.get(String(d.groupId ?? ""));
          if (!g || !isAdmin(g, from, dyncapChains.get(from)?.anchor)) return;    // only admins set group currencies
          if (typeof d.treasury === "string") g.treasury = d.treasury;
          if (typeof d.kudos === "string") g.kudos = d.kudos;
          if (typeof d.uri === "string" && looksLikeRegistryUri(d.uri)) g.uri = d.uri;
          if (typeof d.locker === "string" && looksLikeRegistryUri(d.locker)) g.locker = d.locker;
          if (d.chain && typeof d.chain === "object") g.chain = { ...g.chain, ...sanitizeChain(d.chain as Record<string, unknown>) };
          saveGroups(); renderGroups(); refreshGroupCard(g);
          return;
        }
        // A member's own REV address — the id the on-chain contracts key by.
        // Self-signed only: nobody publishes somebody else's chain identity,
        // and a wrong one would silently misdirect a delegation.
        if (d.kind === "gov-chain") {
          const status = await verifyDyncapIfPresent(from, d); setActiveRoom(ctx);
          if (status.startsWith("  · refused")) return;
          const g = groupStore.get(String(d.groupId ?? ""));
          const who = String(d.member ?? from);
          if (!g || from !== who || !isMember(g, who)) return;
          const addr = String(d.revAddr ?? "");
          const key = memberKeyFor(g, who);
          if (!key || !/^1111[1-9A-HJ-NP-Za-km-z]{20,60}$/.test(addr)) return;
          g.members[key].revAddr = addr;
          saveGroups(); refreshGroupCard(g);
          return;
        }
        if (d.kind === "gov-delegate") {
          const status = await verifyDyncapIfPresent(from, d); setActiveRoom(ctx);
          if (status.startsWith("  · refused")) return;
          const g = groupStore.get(String(d.groupId ?? ""));
          const delegator = String(d.delegator ?? from);
          if (!g || from !== delegator || !isMember(g, delegator)) return;   // self-signed only
          const delegate = d.delegate == null ? null : String(d.delegate);
          const issueId2 = d.issueId ? String(d.issueId) : null;
          const ok = delegate === null || (isMember(g, delegate) && delegate !== delegator);
          if (!ok) return;
          if (issueId2) {                                                    // per-issue delegate
            g.topicDelegations ??= {};
            const m = (g.topicDelegations[issueId2] ??= {});
            if (delegate === null) delete m[delegator]; else m[delegator] = { delegate, at: Date.now() };
            if (Object.keys(m).length === 0) delete g.topicDelegations[issueId2];
          } else if (delegate === null) delete g.delegations[delegator];
          else g.delegations[delegator] = { delegate, at: Date.now() };
          saveGroups(); renderGroups(); refreshGroupCard(g);
          return;
        }
        if (d.kind === "gov-trust") {
          const status = await verifyDyncapIfPresent(from, d); setActiveRoom(ctx);
          if (status.startsWith("  · refused")) return;
          const g = groupStore.get(String(d.groupId ?? ""));
          const rater = String(d.rater ?? from);
          const ratee = String(d.ratee ?? "");
          if (!g || from !== rater || !isMember(g, rater)) return;   // self-signed only
          if (!ratee || ratee === rater || !isMember(g, ratee)) return;
          const rating = Math.max(0, Math.min(TRUST_MAX, Math.round(Number(d.rating))));
          if (isNaN(rating)) return;
          g.trustRatings ??= {};
          const row = (g.trustRatings[rater] ??= {});
          if (rating === 0) delete row[ratee]; else row[ratee] = rating;
          if (Object.keys(row).length === 0) delete g.trustRatings[rater];
          saveGroups(); renderGroups(); refreshGroupCard(g);
          return;
        }
        if (d.kind === "gov-censure") {
          const status = await verifyDyncapIfPresent(from, d); setActiveRoom(ctx);
          if (status.startsWith("  · refused")) return;
          const g = groupStore.get(String(d.groupId ?? ""));
          const censurer = String(d.censurer ?? from);
          const target = String(d.target ?? "");
          if (!g || from !== censurer || !isMember(g, censurer)) return;   // self-signed only
          if (!target || target === censurer || !isMember(g, target)) return;
          g.censures ??= {};
          const row = (g.censures[censurer] ??= {});
          if (d.on === false) delete row[target]; else row[target] = 1;
          if (Object.keys(row).length === 0) delete g.censures[censurer];
          saveGroups(); renderGroups(); refreshGroupCard(g);
          return;
        }
        if (d.kind === "gov-vault") {
          // A member publishes their own password-encrypted identity into the
          // group so they can recover it in a new browser. Self-signed: the
          // publisher's verified anchor must equal the vault's anchor. FWW by
          // handle; only the same anchor may overwrite (with a newer `at`).
          const status = await verifyDyncapIfPresent(from, d); setActiveRoom(ctx);
          if (status.startsWith("  · refused")) return;
          const g = groupStore.get(String(d.groupId ?? ""));
          const fromAnchor = (d.dyncap as DyncapField | undefined)?.anchor;
          if (!g || !isMember(g, from, fromAnchor)) return;
          const handle = canonHandle(String(d.handle ?? ""));
          const blob = String(d.blob ?? "");
          const anchor = String(d.anchor ?? "");
          const at = typeof d.at === "number" ? d.at : Date.now();
          if (!handle || anchor.length !== 64 || !looksLikeVault(blob) || fromAnchor !== anchor) return;
          g.vaults ??= {};
          const cur = g.vaults[handle];
          if (cur && (cur.anchor !== anchor || at <= cur.at)) return;   // squat-proof: same-anchor, newer-only
          g.vaults[handle] = { handle, anchor, blob, at };
          saveGroups(); renderGroups(); refreshGroupCard(g);
          return;
        }
        if (d.kind === "group-issue") {
          const status = await verifyDyncapIfPresent(from, d); setActiveRoom(ctx);
          if (status.startsWith("  · refused")) return;
          const g = groupStore.get(String(d.groupId ?? ""));
          if (!g || !isMember(g, from)) return;
          const r = d.issue as Record<string, unknown> | undefined;
          const title = r ? String(r.title ?? "").trim() : "";
          if (!title) return;
          const iid = String(r!.id ?? issueId(title));
          if (!g.issues.find((i) => i.id === iid)) {
            const iss: Issue = { id: iid, title, by: String(r!.by ?? peerLabel(from)), at: typeof r!.at === "number" ? r!.at as number : Date.now(), status: "open" };
            g.issues.push(iss);
            saveGroups(); renderGroups(); refreshGroupCard(g);
            addIssueCard(g, iss);
          }
          return;
        }
        if (d.kind === "group-vote") {
          const status = await verifyDyncapIfPresent(from, d); setActiveRoom(ctx);
          if (status.startsWith("  · refused")) return;
          const g = groupStore.get(String(d.groupId ?? ""));
          if (!g || !isMember(g, from)) return;
          const issue = g.issues.find((i) => i.id === String(d.issueId ?? ""));
          if (issue) { issue.pollId = String(d.pollId ?? ""); issue.status = "open"; saveGroups(); renderGroups(); refreshGroupCard(g); refreshIssueCard(g, issue); }
          return;
        }
        if (d.kind === "group-msg") {
          // Per-group inbox: a member's message, surfaced only to fellow members.
          const status = await verifyDyncapIfPresent(from, d); setActiveRoom(ctx);
          if (status.startsWith("  · refused")) return;
          const g = groupStore.get(String(d.groupId ?? ""));
          const text = String(d.text ?? "");
          if (!g || !isMember(g, from) || !isMember(g, myPeerId()) || !text) return;
          addMessage(from, `🏛 ${g.name}: ${text}`, "peer", peerLabel(from));
          return;
        }
        if (d.kind === "sync-gov") {
          const status = await verifyDyncapIfPresent(from, d); setActiveRoom(ctx);
          if (status.startsWith("  · refused")) return;
          if (!Array.isArray(d.groups)) return;
          let changed = 0;
          for (const raw of d.groups as unknown[]) {
            const gid = String((raw as Record<string, unknown>).id ?? "");
            const had = groupStore.has(gid);
            if (mergeGroupFromSync(raw)) {
              changed++;
              const g = groupStore.get(gid);
              if (g) { if (!had) addGroupCard(g); else refreshGroupCard(g); }
            }
          }
          if (changed) { saveGroups(); renderGroups(); }
          return;
        }
        if (d.kind === "file-start") { attachments.fileStart(d); return; }
        if (d.kind === "file-chunk") { attachments.fileChunk(from, d); return; }
        if (d.kind === "call-start") {
          addMessage("", `📞 ${peerLabel(from)} started a call — click Call to join`, "system");
          return;
        }
        if (d.kind === "call-end") {
          calls.peerGone(from);
          addMessage("", `📵 ${peerLabel(from)} left the call`, "system");
          return;
        }
        if (d.kind === "library-entry") {
          const status = await verifyDyncapIfPresent(from, d); setActiveRoom(ctx);
          if (status.startsWith("  · refused")) return;
          const entry = addLibraryEntry(d.entry);
          if (entry) {
            addMessage("", `○ ${peerLabel(from)} added ${entry.name}  ${fmtFileSize(entry.size)}  `
              + `${shortHash(entry.hash)}  — /file list`, "system");
          }
          return;
        }
        // The lib-* transfer envelopes are the fetch module's, and are not
        // dyncap-signed: the hash is what makes an arrival trustworthy, so a
        // signature would prove only who sent bytes that are checked anyway.
        if (String(d.kind ?? "").startsWith("lib-")) { libraryFetch.inbound(from, d); return; }
        if (d.kind === "library-have") {
          const status = await verifyDyncapIfPresent(from, d); setActiveRoom(ctx);
          if (status.startsWith("  · refused")) return;
          noteHolder(from, d.hashes);
          return;
        }
        if (d.kind === "sync-library") {
          const status = await verifyDyncapIfPresent(from, d); setActiveRoom(ctx);
          if (status.startsWith("  · refused")) return;
          const list = Array.isArray(d.entries) ? d.entries : [];
          let added = 0;
          for (const raw of list.slice(0, 500)) if (addLibraryEntry(raw)) added++;
          if (added) addMessage("", `+${added} librar${added === 1 ? "y entry" : "y entries"} via sync`, "system");
          return;
        }
        if (d.kind === "record") {
          addMessage("", `${d.on ? "⏺" : "⏹"} ${peerLabel(from)} ${d.on ? "is recording their screen" : "stopped recording"}`, "system");
          return;
        }
        if (d.kind === "chat" || "text" in d) {
          const text = "text" in d ? String(d.text) : String(d.message ?? JSON.stringify(d));
          addMessage(from, text, "peer", peerLabel(from));
          return;
        }
      }
      addMessage(from, JSON.stringify(data), "peer", peerLabel(from));
      } finally { setActiveRoom(prev); }
    },
    onChannelOpen(peerId) {
      const prev = activeRoom; setActiveRoom(ctx);
      try {
        // A direct WebRTC link — what a call or a file transfer needs. The
        // handshake (name, sync-*) no longer hangs off this: it rides the
        // relayed control plane in onPeerReady below, so a peer we never get
        // a direct path to still gets it. Here: the roster (a remote-
        // initiated link is proof of presence too) and the ⚠ that this
        // link resolves.
        peers.add(peerId);
        // If we said this peer was unreachable, say that it worked out — a
        // warning left standing after the thing it warned about has fixed
        // itself teaches people to ignore warnings.
        if (unreachableWarned.delete(peerId)) {
          addMessage("", `✓ connected to ${peerLabel(peerId)} after all`, "system");
        }
        renderPeers();
      } finally { setActiveRoom(prev); }
    },
    onPeerReady(peerId) {
      const prev = activeRoom; setActiveRoom(ctx);
      try {
        // This peer can be sent to (fresh in the room, or we are): the
        // handshake — who we are and everything the room has agreed so far.
        // Fires once per session pairing, never on a silent resume, so a
        // socket blip does not re-serve the room's whole state.
        peers.add(peerId);
        renderPeers();
        signedSend(peerId, { kind: "name", name: myName });
        if (lemmaStore.size > 0) {
          const entries = Array.from(lemmaStore.entries()).map(([name, e]) => ({
            name, twists: e.twists, who: e.who, cap: e.cap, dyncap: e.dyncap, event: e.event, text: e.text,
          }));
          signedSend(peerId, { kind: "sync-lemmas", entries });
        }
        if (knownCurrencies.size > 0) {
          const entries = Array.from(knownCurrencies.values());
          signedSend(peerId, { kind: "sync-currencies", entries });
        }
        if (seriesTerms.size > 0) {
          const entries = Array.from(seriesTerms.values());
          signedSend(peerId, { kind: "sync-series", entries });
        }
        if (pollStore.size > 0) {
          const polls = Array.from(pollStore.values());
          signedSend(peerId, { kind: "sync-polls", polls });
        }
        if (libraryStore.size > 0) {
          // The index, never the bytes: a joiner learns what the room has and
          // asks for what it wants.
          signedSend(peerId, { kind: "sync-library", entries: Array.from(libraryStore.values()) });
        }
        // And what we are holding, so their list says what can be had rather
        // than only what once existed.
        announceHeld(peerId);
        if (groupStore.size > 0) {
          const groups = Array.from(groupStore.values());
          signedSend(peerId, { kind: "sync-gov", groups });
        }
        if (macroStore.size > 0) {
          const macros = Array.from(macroStore.values());
          signedSend(peerId, { kind: "sync-macros", macros });
        }
      } finally { setActiveRoom(prev); }
    },
    onPeerJoined(id) {
      const prev = activeRoom; setActiveRoom(ctx);
      try {
        // A call in progress has no invite list — it's for whoever's in the
        // room — so a peer who joins mid-call needs the same guaranteed
        // direct connection start() gives everyone already present (media
        // can't be relayed the way a data-channel message can under the
        // bounded-degree overlay). Harmless no-op when no call is active.
        if (calls.inCall()) qpeer?.pinNeighbor(id);
        const pending = pendingLeaves.get(id);
        if (pending !== undefined) {
          clearTimeout(pending);
          pendingLeaves.delete(id);
          peers.add(id);
          if (!peerSeenAt.has(id)) peerSeenAt.set(id, Date.now());
          renderPeers();
          return;
        }
        if (peers.has(id)) return;
        peers.add(id);
        peerSeenAt.set(id, Date.now());
        renderPeers();
        // Wait for the peer's name before announcing — browsers send it right after
        // the channel opens — so the line shows a name, not a raw id; fall back to the
        // id after a timeout. Fired early by the name handler; cleared on leave.
        if (!pendingJoins.has(id)) {
          pendingJoins.set(id, setTimeout(() => {
            const p2 = activeRoom; setActiveRoom(ctx);
            try { announceJoin(id); } finally { setActiveRoom(p2); }
          }, 5000));
        }
      } finally { setActiveRoom(prev); }
    },
    onPeerLeft(id) {
      // Idempotent: the data-channel close, a connection "failed"/"closed", and
      // the signaling "left" broadcast can all report the same departure. Don't
      // stack grace timers — one pending leave per peer.
      if (pendingLeaves.has(id)) return;
      // The setTimeout fires later — capture ctx in the closure so the
      // delayed work runs against the right room even if activeRoom has
      // changed in the meantime.
      const timer = setTimeout(() => {
        const prev = activeRoom; setActiveRoom(ctx);
        try {
          pendingLeaves.delete(id);
          peers.delete(id);
          // Their bytes left with them: availability is about who is here, and
          // a departed holder listed as one is the broken link this design is
          // built to avoid.
          forgetHolder(id);
          peerSeenAt.delete(id);
          // A peer that has left and comes back is announced as joining, so the
          // "connected after all" line would be a second announcement of the
          // same event, out of order with it. That line is for a peer that was
          // flagged and then connected without ever leaving.
          unreachableWarned.delete(id);
          renderPeers();
          // If their join was never announced (no name arrived / a quick refresh),
          // stay silent on the leave too — no "<id> joined"/"left" noise.
          const pj = pendingJoins.get(id);
          if (pj !== undefined) { clearTimeout(pj); pendingJoins.delete(id); }
          else addMessage("", `${peerLabel(id)} left`, "system");
          peerNames.delete(id);
          // NOTE: peerAgents is deliberately NOT cleared here — it is a sticky
          // cache (like lastKnownNames). A flapping AI daemon whose signaling
          // drops keeps its 🤖 badge across the reconnect instead of flashing an
          // unlabelled peer; a genuinely-departed peer's stale role never renders
          // (renderPeers only badges ids still in `peers`). It is only reset if
          // the peer re-announces itself as a non-agent (see the `name` handler).
          calls.peerGone(id);
        } finally { setActiveRoom(prev); }
        // 15s grace (was 6s): a flaky free-tier signaling server can take >6s to
        // reconnect a dropped agent, so a shorter window logs a spurious left/join
        // pair on every hiccup. 15s absorbs the common reconnect cycle silently;
        // a genuinely-departed peer just lingers in the roster a few extra seconds.
      }, 15_000);
      // The pendingLeaves mutation happens synchronously; wrap it too.
      const prev = activeRoom; setActiveRoom(ctx);
      try { pendingLeaves.set(id, timer); } finally { setActiveRoom(prev); }
    },
    onRemoteTrack(peerId, stream) {
      const prev = activeRoom; setActiveRoom(ctx);
      try {
        if (isUiActive()) calls.remoteStream(peerId, stream);
        // A peer who arrives mid-recording still belongs on it.
        recorder.addAudio(stream);
      }
      finally { setActiveRoom(prev); }
    },
    // posix-net's socket channels — see docs/connection.md "posix-net".
    // Distinct from onChannelOpen/onMessage above: this traffic never rides
    // the chat flood relay, so it gets its own dispatch straight into `net`.
    onSocketChannelOpen(peerId, kind) {
      const prev = activeRoom; setActiveRoom(ctx);
      try { net.onTransportChannelOpen(peerId, kind); } finally { setActiveRoom(prev); }
    },
    onSocketMessage(peerId, kind, data) {
      const prev = activeRoom; setActiveRoom(ctx);
      try { net.onTransportMessage(peerId, kind, data); } finally { setActiveRoom(prev); }
    },
  });
  // Built from newPeer, which now exists — see the forward-declaration note
  // above. posix-net.ts never touches QOSPeer directly; these three methods
  // are its entire surface (SocketTransport in posix-net.ts).
  net = new PosixNet({
    selfId: newPeer.peerId,
    pinNeighbor: (peerId) => newPeer.pinNeighbor(peerId),
    hasSocketChannel: (peerId, kind) => newPeer.hasSocketChannel(peerId, kind),
    sendSocketFrame: (peerId, kind, data) => newPeer.sendSocketFrame(peerId, kind, data),
  });
  setQpeer(newPeer);
  setPosixNet(net);
  newPeer.connect();
}

// ---------------------------------------------------------------------------
// Send
// ---------------------------------------------------------------------------

/**
 * Lines held back from a `\`-continued entry or a multi-line paste, waiting for
 * the line that finishes the message. The composer is a single-line <input> —
 * it cannot show a newline, let alone hold one — so this is where a message's
 * earlier lines live until it is sent.
 */
let pendingLines: string[] = [];
const MSG_PLACEHOLDER = msgInput.placeholder;

/** Show how many lines are held, so a half-entered message is never invisible. */
function paintPending(): void {
  const n = pendingLines.length;
  msgInput.placeholder = n
    ? `${n} line${n === 1 ? "" : "s"} held · Shift+Enter for another · Enter sends · Esc discards`
    : MSG_PLACEHOLDER;
  msgInput.classList.toggle("continued", n > 0);
}

function discardPending(): void { pendingLines = []; paintPending(); }

/**
 * Hold the line in the box and start a new one. Two ways to ask for it: end the
 * line with `\`, or press Shift+Enter. The backslash is the join itself, so it
 * is dropped; Shift+Enter adds no character, so the line is held as typed —
 * including an empty one, which is how a blank line gets into a message.
 */
function holdLine(dropTrailingBackslash: boolean): void {
  const line = msgInput.value;
  pendingLines.push(dropTrailingBackslash ? line.trimEnd().slice(0, -1) : line);
  msgInput.value = "";
  // The box is empty now, so any open completion menu is stale. Assigning
  // .value fires no "input" event, so it will not close itself.
  palette.hide();
  paintPending();
}

function send(): void {
  const line = msgInput.value;
  if (/\\$/.test(line.trimEnd())) { holdLine(true); return; }
  // With lines held, drop only surrounding blank lines — trimming the whole
  // block would eat the first line's indentation, and a pasted program is
  // usually indented.
  const text = pendingLines.length
    ? pendingLines.concat(line).join("\n").replace(/^\n+/, "").replace(/\s+$/, "")
    : line.trim();
  // Nothing to send: let go of any held lines too, or Enter on an empty box
  // would sit there doing nothing with the box still marked as holding some.
  if (!text) { discardPending(); return; }
  if (!qpeer) return;
  discardPending();
  pushHistory(text);
  msgInput.value = "";
  // The box is empty now, so any open completion/usage menu is stale.
  // Assigning .value fires no "input" event, so it will not close itself —
  // same fix as holdLine() above, applied here too: without it, a usage hint
  // painted while typing a command (e.g. "/facil ") is left on screen after
  // Enter sends the line, sitting over the transcript until something else
  // happens to touch the palette.
  palette.hide();
  if (text.startsWith("//")) {
    const escaped = text.slice(1);
    qpeer.broadcast({ kind: "chat", text: escaped });
    addMessage("", escaped, "self");
    return;
  }
  // `++text` escapes a literal `+` line into chat, the way `//` does for `/`.
  if (text.startsWith("++")) {
    const escaped = text.slice(1);
    qpeer.broadcast({ kind: "chat", text: escaped });
    addMessage("", escaped, "self");
    return;
  }
  // `+name` is a user-defined command. Only an identifier-shaped name is taken
  // as one: "+1" is agreement, not a call, and goes to chat like any other
  // message. The commands a macro runs broadcast on their own terms, so the
  // room sees what happened without the invocation needing its own envelope.
  if (/^\+[A-Za-z][A-Za-z0-9_-]*/.test(text)) {
    addMessage("", text, "self");
    runMacroLine(text);
    return;
  }
  // `$name(…)` runs a chain macro (see runDollarLine); `$( … )` is an inline
  // program. `$1`, `$5 agreed`, a bare `$` — all chat.
  if (/^\$[A-Za-z][A-Za-z0-9_-]*/.test(text) || /^\$\s*\(/.test(text)) {
    addMessage("", text, "self");
    runDollarLine(text);
    return;
  }
  if (text.startsWith("/")) {
    const parts = text.slice(1).trim().split(/\s+/);
    const cmd = parts[0].toLowerCase();
    const arg = parts.slice(1).join(" ");
    addMessage("", text, "self");
    const lines = handleCommand(text);
    if (cmd !== "help" && cmd !== "dump") {
      sessionLog.push({ who: myName || "you", cmd, arg, summary: lines[0] ?? "" });
    }
    if (lines.length > 0 && cmd !== "help" && cmd !== "grant" && cmd !== "lemma" && cmd !== "note" && cmd !== "rdv" && cmd !== "forget" && cmd !== "remove" && cmd !== "retract" && cmd !== "rm" && cmd !== "gov" && cmd !== "dyncap" && cmd !== "probe" && cmd !== "room" && cmd !== "share" && cmd !== "channel" && cmd !== "script" && cmd !== "persist" && cmd !== "rhoqu" && cmd !== "macro" && cmd !== "macros" && cmd !== "rholang" && cmd !== "estimate" && cmd !== "facil" && cmd !== "facilitator" && cmd !== "scribe" && cmd !== "skeptic" && cmd !== "observer" && cmd !== "greeter" && cmd !== "password" && cmd !== "login" && cmd !== "name" && cmd !== "render" && cmd !== "animate" && cmd !== "record" && cmd !== "ice" && cmd !== "conn" && cmd !== "socket" && cmd !== "search" && cmd !== "solve" && cmd !== "reset") {
      qpeer.broadcast({ kind: "qlf", cmd, arg, lines });
    }
    return;
  }
  qpeer.broadcast({ kind: "chat", text });
  addMessage("", text, "self");
}

// ---------------------------------------------------------------------------
// Share link
// ---------------------------------------------------------------------------

/**
 * The URL that lets someone else in. Built from the active room rather than
 * read off the address bar, which may deliberately no longer carry it.
 */
function roomUrl(): string {
  return `${window.location.origin}${window.location.pathname}#room=${activeRoom.roomId}`;
}

function updateShareLink(): void {
  const url = roomUrl();
  // The sidebar's room line is on screen the whole time, so it is the same
  // surface as the address bar and is masked with it.
  roomIdEl.textContent = hideRoom ? shortId(activeRoom.roomId) : activeRoom.roomId;
  if (hideRoom) {
    // No href either: the real URL shows in the status bar on hover, which is
    // the same screen the point of hiding it was to keep it off.
    shareLink.removeAttribute("href");
    shareLink.className = "hidden-cap";
    shareLink.textContent = "hidden — copy to share it";
    shareLink.title = "The room capability is hidden. Copy puts it on your clipboard; 👁 reveals it.";
  } else {
    shareLink.href = url;
    shareLink.className = "";
    shareLink.textContent = url;
    shareLink.title = url;
  }
  hideBtn.textContent = hideRoom ? "👁" : "🙈";
  hideBtn.title = hideRoom
    ? "Reveal the room capability (it goes back into the address bar)"
    : "Hide the room capability — keep it off screen shares and recordings";
}

copyBtn.addEventListener("click", () => {
  navigator.clipboard.writeText(roomUrl()).then(() => {
    copyBtn.textContent = "copied!";
    setTimeout(() => { copyBtn.textContent = "copy"; }, 1500);
  });
});

hideBtn.addEventListener("click", () => setHideRoom(!hideRoom));

// A `[label](help:cmd)` link anywhere in the transcript (the /help list, mostly)
// opens that command's detail — same as typing `/help cmd`. Delegated, so it
// works for lines replayed on a room switch too.
messagesEl.addEventListener("click", (e) => {
  const a = (e.target as HTMLElement | null)?.closest?.("a.cmd-link") as HTMLElement | null;
  if (!a) return;
  e.preventDefault();
  const cmd = a.dataset.help;
  if (!cmd) return;
  // Straight to handleCommand (not send()) so it works before a connection too —
  // /help is local and broadcasts nothing.
  addMessage("", `/help ${cmd}`, "self");
  handleCommand(`/help ${cmd}`);
});

function toggleSidebar(open?: boolean): void {
  const isOpen = open ?? !sidebarEl.classList.contains("open");
  sidebarEl.classList.toggle("open", isOpen);
  overlayEl.classList.toggle("open", isOpen);
}
toggleBtn.addEventListener("click", () => toggleSidebar());
overlayEl.addEventListener("click", () => toggleSidebar(false));

// ---------------------------------------------------------------------------
// Rich text (safe Markdown subset) + persistent chat transcript
// ---------------------------------------------------------------------------

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** A deliberately small, XSS-safe Markdown renderer: everything is HTML-escaped
 *  first, then a fixed set of tags is re-introduced. No raw peer HTML is ever
 *  inserted, and link hrefs are constrained to http(s). */
function renderMarkdown(src: string): string {
  const codes: string[] = [];
  let s = escapeHtml(src);
  // fenced code blocks ``` … ``` (protect from further formatting)
  s = s.replace(/```([\s\S]*?)```/g, (_m, c: string) => {
    codes.push(`<pre class="code">${c.replace(/^\n/, "").replace(/\n$/, "")}</pre>`);
    return `@@@${codes.length - 1}@@@`;
  });
  // inline code `…`
  s = s.replace(/`([^`\n]+)`/g, (_m, c: string) => {
    codes.push(`<code>${c}</code>`);
    return `@@@${codes.length - 1}@@@`;
  });
  s = s.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>");
  // `[label](help:command)` — an in-app link to a command's detailed help.
  // The delegated click handler on #messages turns it into `/help command`.
  s = s.replace(/\[([^\]\n]+)\]\(help:([a-z][a-z-]*)\)/gi,
    '<a href="#" class="cmd-link" data-help="$2">$1</a>');
  s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  s = s.replace(/(^|\s)(https?:\/\/[^\s<]+)/g,
    '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>');
  s = s.replace(/\n/g, "<br>");
  s = s.replace(/@@@(\d+)@@@/g, (_m, i: string) => codes[Number(i)]);
  return s;
}

function loadChat(roomId: string): ChatLine[] {
  try {
    const raw = localStorage.getItem(`qos-chat-${roomId}`);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

function saveChat(room: RoomContext): void {
  try {
    // Persist the transcript, but drop large media data-URLs (they'd blow the
    // localStorage quota). A media line reloads as a labelled placeholder.
    const slim = room.chatLog.slice(-200).map((l) =>
      l.media ? { ...l, media: { ...l.media, url: "" } } : l);
    localStorage.setItem(`qos-chat-${room.roomId}`, JSON.stringify(slim));
  } catch { /* storage quota — drop silently */ }
}

function addMedia(from: string, media: MediaAttachment, kind: "peer" | "self", label?: string): void {
  const line: ChatLine = { from, text: "", kind, label, media };
  activeRoom.chatLog.push(line);
  trimChatLog(activeRoom);
  saveChat(activeRoom);
  if (isUiActive()) {
    renderChatLine(line);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  } else {
    markUnread(activeRoom);
  }
}

// Shell-style input history: ArrowUp recalls previous submissions to edit and
// resend (handy after a command errors), ArrowDown walks forward and restores
// the in-progress draft at the end.
const inputHistory: string[] = [];
let histIdx = -1;     // -1 = editing the live draft; else an index into inputHistory
let histDraft = "";   // draft stashed when history navigation begins

function pushHistory(text: string): void {
  if (!text) return;
  if (inputHistory[inputHistory.length - 1] !== text) inputHistory.push(text);
  if (inputHistory.length > 200) inputHistory.shift();
  histIdx = -1;
  histDraft = "";
}

function setComposer(v: string): void {
  msgInput.value = v;
  const p = v.length;
  msgInput.setSelectionRange(p, p);
  palette.hide();      // don't pop the command menu while recalling history
}

// delta: -1 = older (ArrowUp), +1 = newer (ArrowDown). Returns true if handled.
function navHistory(delta: number): boolean {
  if (inputHistory.length === 0) return false;
  if (histIdx === -1) {
    if (delta > 0) return false;                 // ArrowDown while editing draft: ignore
    histDraft = msgInput.value;
    histIdx = inputHistory.length - 1;
  } else {
    const next = histIdx + delta;
    if (next >= inputHistory.length) {           // moved past newest → restore the draft
      histIdx = -1;
      setComposer(histDraft);
      return true;
    }
    histIdx = next < 0 ? 0 : next;               // clamp at oldest
  }
  setComposer(inputHistory[histIdx]);
  return true;
}

function showWelcome(): void {
  const div = document.createElement("div");
  div.className = "welcome";
  div.innerHTML =
    "<h3>⬡ Welcome to QuantumOS</h3>" +
    "A peer-to-peer room — no server holds your data. To get started:" +
    "<ol>" +
    "<li>Set a <strong>display name</strong> in the left sidebar.</li>" +
    "<li>Click <strong>Connect</strong>, then <strong>copy</strong> the share link and send it to a peer.</li>" +
    "<li>Type a message — <strong>Markdown</strong> works: <code>**bold**</code>, <code>*italic*</code>, <code>`code`</code>, links.</li>" +
    "<li>Use the <strong>action buttons</strong> above, or type <code>/</code> to browse every command.</li>" +
    "</ol>" +
    "<div class=\"tip\">Capabilities, lemmas, promissory notes and atomic swaps are all one click — or one slash — away.</div>";
  messagesEl.appendChild(div);
}

function initUx(): void {
  palette = createPalette(
    {
      input: msgInput,
      say: (t) => addMessage("", t, "system"),
      // The Call action belongs to calls.ts; the palette only offers it.
      toggleCall: () => calls.toggle(),
      toggleRecord: () => recorder.toggle(),
      // A built line goes through the box, so it echoes, logs and reaches the
      // history exactly like one that was typed.
      run: (text) => { msgInput.value = text; send(); },
    },
    document.getElementById("cmd-menu"),
  );
  palette.mountActions(document.getElementById("actions-row"));

  // Autocomplete: surface matching commands while the user types the command word.
  msgInput.addEventListener("input", () => {
    histIdx = -1;   // manual typing exits history recall; the text is now the draft
    palette.onInput(msgInput.value);
  });
  // Losing focus closes the panel — unless the panel is what took the focus.
  // Touching it to read it is not asking for it to go away.
  msgInput.addEventListener("blur", () => setTimeout(() => {
    if (!palette.justTouched()) palette.hide();
  }, 120));

  // Attachments: picker button, drag-and-drop, clipboard paste.
  const attachBtn = document.getElementById("attach-btn");
  const fileInput = document.getElementById("file-input") as HTMLInputElement | null;
  if (attachBtn && fileInput) {
    attachBtn.addEventListener("click", () => fileInput.click());
    fileInput.addEventListener("change", () => {
      if (fileInput.files && fileInput.files.length) attachments.send(fileInput.files);
      fileInput.value = "";
    });
  }
  const dropTarget = (messagesEl.closest(".main") as HTMLElement | null) ?? messagesEl;
  dropTarget.addEventListener("dragover", (e) => { e.preventDefault(); dropTarget.classList.add("dragover"); });
  dropTarget.addEventListener("dragleave", () => dropTarget.classList.remove("dragover"));
  dropTarget.addEventListener("drop", (e) => {
    e.preventDefault();
    dropTarget.classList.remove("dragover");
    if (e.dataTransfer?.files?.length) attachments.send(e.dataTransfer.files);
  });
  // Dropping on the library adds to the library; dropping on the chat sends an
  // attachment. Two drop targets because they are two different intentions —
  // one is "keep this and tell the room it exists", the other is "look at this".
  if (libraryDropEl) {
    const over = (on: boolean) => libraryDropEl.classList.toggle("over", on);
    libraryDropEl.addEventListener("dragover", (e) => { e.preventDefault(); over(true); });
    libraryDropEl.addEventListener("dragleave", () => over(false));
    libraryDropEl.addEventListener("drop", (e) => {
      e.preventDefault();
      // Stop it reaching the chat's drop target underneath, or one drop would
      // both index the file and broadcast it.
      e.stopPropagation();
      over(false);
      if (e.dataTransfer?.files?.length) addFilesToLibrary(e.dataTransfer.files);
    });
    libraryDropEl.addEventListener("click", () => addFilesToLibrary());
  }

  msgInput.addEventListener("paste", (e) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const files: File[] = [];
    for (const it of Array.from(items)) {
      if (it.kind === "file") { const f = it.getAsFile(); if (f) files.push(f); }
    }
    if (files.length) { e.preventDefault(); attachments.send(files); return; }
    // Multi-line text. An <input> cannot hold a newline: the browser flattens
    // the paste, so a pasted program silently arrived as one line — which for
    // rholang means a `//` comment swallowing everything after it. Hold every
    // line but the last, and leave the last in the box, so what you see is
    // where you are and Enter sends the whole paste.
    const pasted = e.clipboardData?.getData("text") ?? "";
    if (!pasted.includes("\n")) return;
    e.preventDefault();
    const lines = pasted.replace(/\r\n?/g, "\n").split("\n");
    const last = lines.pop() ?? "";
    const caret = msgInput.selectionStart ?? msgInput.value.length;
    const end = msgInput.selectionEnd ?? msgInput.value.length;
    // Paste at the caret, the same as a single-line paste would.
    lines[0] = msgInput.value.slice(0, caret) + lines[0];
    const after = msgInput.value.slice(end);
    pendingLines.push(...lines);
    msgInput.value = last + after;
    msgInput.setSelectionRange(last.length, last.length);
    paintPending();
  });

  // Live-call controls.
  calls = createCalls(
    {
      // Asked for rather than held: which peer is current changes as the user
      // switches room tabs.
      peer: () => qpeer,
      say: (t) => addMessage("", t, "system"),
      label: (id) => peerLabel(id),
      isAgent: (id) => peerAgents.has(id),
      roomPeers: () => [...peers],
      mediaBlocked: (strict) => {
        const p = qpeer;
        if (!p) return [];
        const stuck = strict
          ? new Set(["failed", "disconnected", "checking", "connecting", "new", "none"])
          : new Set(["failed", "disconnected"]);
        return p.connectionReport()
          .filter((r) => peers.has(r.peerId) && !peerAgents.has(r.peerId)
            && (stuck.has(r.connection) || r.ice === "failed"))
          .map((r) => r.peerId);
      },
    },
    {
      bar:   document.getElementById("call-bar"),
      tiles: document.getElementById("call-tiles"),
      mute:  document.getElementById("call-mute")  as HTMLButtonElement | null,
      cam:   document.getElementById("call-cam")   as HTMLButtonElement | null,
      share: document.getElementById("call-share") as HTMLButtonElement | null,
    },
  );
  recorder = createRecorder(
    {
      say: (t) => addMessage("", t, "system"),
      // Nobody should be recorded silently, and the room cannot see the
      // browser's own recording indicator.
      announce: (on) => qpeer?.broadcast({ kind: "record", on }),
      // The room's voices, taken from the call rather than from whatever
      // surface was captured — a window share carries no audio at all.
      callAudio: () => calls.audioTracks(),
    },
    document.querySelector('#actions-row [data-action="record"]'),
  );
  libraryFetch = createLibraryFetch({
    peer: () => qpeer,
    say: (t) => addMessage("", t, "system"),
    label: (id) => peerLabel(id),
    // Serving only what we actually hold — the index is public, the bytes are
    // not, and a hash we never kept is not ours to answer for.
    bytesFor: (hash) => (heldFiles.has(hash) ? getBytes(hash) : Promise.resolve(null)),
    received: async (hash, file, name, mime) => {
      await putBytes(hash, file);
      heldFiles.add(hash);
      // An entry for something fetched from a peer who had it but never
      // indexed it: keep the name it arrived under.
      if (!libraryStore.has(hash) && !isRetracted("library", hash)) {
        const entry: LibraryEntry = {
          hash, name, mime, size: file.size,
          addedBy: myPeerId(), addedLabel: myName || shortId(myPeerId()), at: Date.now(),
        };
        libraryStore.set(hash, entry);
        signedBroadcast({ kind: "library-entry", entry });
      }
      saveLibrary();
      announceHeld();
      renderLibrary();
    },
  });
  attachments = createAttachments({
    peer: () => qpeer,
    say: (t) => addMessage("", t, "system"),
    label: (id) => peerLabel(id),
    // The transcript is app.ts's to keep, so appending to it stays here.
    addMedia,
  });
  document.getElementById("call-hangup")?.addEventListener("click", () => calls.end());
  document.getElementById("call-mute")?.addEventListener("click", () => calls.toggleMute());
  document.getElementById("call-cam")?.addEventListener("click", () => calls.toggleCam());
  document.getElementById("call-share")?.addEventListener("click", () => calls.toggleScreen());
}

// ---------------------------------------------------------------------------
// Polls: group decisions (approval / ranked-choice), dyncap-signed ballots,
// deterministic joiner-local tally
// ---------------------------------------------------------------------------

const RANK_CIRCLED = ["①", "②", "③", "④", "⑤", "⑥", "⑦", "⑧", "⑨"];

// Out-of-order: ballots / options that arrive before their poll-open are buffered.
const pollBallotBuffer = new Map<string, Array<{ peer: string; choices: string[] }>>();
function bufferBallot(pollId: string, peer: string, choices: string[]): void {
  const arr = pollBallotBuffer.get(pollId) ?? [];
  arr.push({ peer, choices });
  pollBallotBuffer.set(pollId, arr);
}
function flushBufferedBallots(poll: Poll): void {
  const arr = pollBallotBuffer.get(poll.id);
  if (!arr) return;
  for (const { peer, choices } of arr) poll.ballots[peer] = choices;
  pollBallotBuffer.delete(poll.id);
}
const pollOptionBuffer = new Map<string, PollOption[]>();
function bufferOption(pollId: string, opt: PollOption): void {
  const arr = pollOptionBuffer.get(pollId) ?? [];
  arr.push(opt);
  pollOptionBuffer.set(pollId, arr);
}
function flushBufferedOptions(poll: Poll): void {
  const arr = pollOptionBuffer.get(poll.id);
  if (!arr) return;
  for (const o of arr) mergeOption(poll, o);
  pollOptionBuffer.delete(poll.id);
}

function myPeerId(): string { return qpeer?.peerId ?? "self"; }

function defaultOpenPoll(): Poll | null {
  let best: Poll | null = null;
  for (const p of pollStore.values()) {
    if (p.status === "open" && (!best || p.createdAt > best.createdAt)) best = p;
  }
  return best;
}
function findPoll(id?: string): Poll | null {
  return id ? (pollStore.get(id) ?? null) : defaultOpenPoll();
}

// Add/merge an option idempotently (dedupe by content id; keep earliest add-time).
function mergeOption(poll: Poll, opt: PollOption): boolean {
  const existing = poll.options.find((o) => o.id === opt.id);
  if (existing) { if (opt.at < existing.at) existing.at = opt.at; return false; }
  poll.options.push(opt);
  return true;
}

// Sanitize one inbound option object (sync / wire) into a PollOption, or null.
function coercePollOption(o: unknown): PollOption | null {
  if (!o || typeof o !== "object") return null;
  const r = o as Record<string, unknown>;
  const text = String(r.text ?? "").trim();
  if (!text) return null;
  return {
    id: String(r.id ?? optionId(text)),
    text,
    by: String(r.by ?? "?"),
    at: typeof r.at === "number" ? r.at : 0,
  };
}

// Merge a whole poll received in a join handshake (sync-polls) into the store.
// New poll -> adopt verbatim (options, ballots, status, result, lock). Known
// poll -> union options (by id), adopt ballots only for peers we have none for
// (live poll-ballot envelopes reconcile re-votes), OR the lock flag, and adopt
// a closed result if the sender has closed it and we have not. Returns whether
// the poll was newly added, merely updated, or unchanged.
function mergePollFromSync(raw: unknown): "added" | "updated" | "none" {
  if (!raw || typeof raw !== "object") return "none";
  const r = raw as Record<string, unknown>;
  const id = String(r.id ?? "");
  if (!id) return "none";
  if (isRetracted("poll", id)) return "none";                    // tombstoned — don't heal back
  const inOpts = Array.isArray(r.options)
    ? (r.options as unknown[]).map(coercePollOption).filter((o): o is PollOption => o !== null)
    : [];
  const inBallots: Record<string, string[]> =
    r.ballots && typeof r.ballots === "object"
      ? Object.fromEntries(
          Object.entries(r.ballots as Record<string, unknown>).map(([peer, ch]) => [
            peer,
            Array.isArray(ch) ? (ch as unknown[]).map(String).filter((x) => x.length > 0) : [],
          ]),
        )
      : {};
  const inClosed = r.status === "closed";

  const existing = pollStore.get(id);
  if (!existing) {
    const poll: Poll = {
      id,
      question: String(r.question ?? ""),
      options: inOpts,
      method: r.method === "ranked" ? "ranked" : "approval",
      creator: String(r.creator ?? ""),
      creatorLabel: String(r.creatorLabel ?? "?"),
      createdAt: typeof r.createdAt === "number" ? r.createdAt : 0,
      status: inClosed ? "closed" : "open",
      nominationsLocked: r.nominationsLocked === true,
      ballots: inBallots,
    };
    flushBufferedOptions(poll);
    flushBufferedBallots(poll);
    if (inClosed) poll.result = tally(poll);
    pollStore.set(id, poll);
    return "added";
  }

  let changed = false;
  for (const opt of inOpts) if (mergeOption(existing, opt)) changed = true;
  for (const [peer, ch] of Object.entries(inBallots)) {
    if (!(peer in existing.ballots)) { existing.ballots[peer] = ch; changed = true; }
  }
  if (r.nominationsLocked === true && !existing.nominationsLocked) { existing.nominationsLocked = true; changed = true; }
  if (inClosed && existing.status !== "closed") {
    existing.status = "closed";
    existing.result = tally(existing);
    changed = true;
  }
  return changed ? "updated" : "none";
}

// Merge a Group received in a join handshake (sync-gov): adopt an unknown group
// whole; for a known group, union members / delegations / issues by latest `at`.
// Tombstoned groups are skipped. Returns whether anything changed.
/**
 * A registry URI, as `/rholang` writes and reads them: `rho:id:` + zbase32 of
 * the deployer key's hash. Checked rather than trusted because it arrives over
 * the wire — a group's durable name should not become a place to park text.
 */
/**
 * A locker a group you belong to has recorded.
 *
 * The focused group first, because that is the one you are working in; then any
 * other you are a member of, so a single group with a locker just works. Only
 * groups you are actually a member of — a locker is a directory somebody else
 * installed, and adopting one from a group you merely see would be adopting a
 * stranger's.
 */
function lockerFromGroups(): { group: string; uri: string } | null {
  const me = myPeerId();
  const focused = focusedGroup ? groupStore.get(focusedGroup) : undefined;
  const ordered = [focused, ...groupStore.values()].filter((g): g is Group => !!g);
  for (const g of ordered) {
    if (g.locker && isMember(g, me, dyncapState?.anchor)) return { group: g.name, uri: g.locker };
  }
  return null;
}

/**
 * Would the browser refuse this URL as mixed content?
 *
 * Only for http to a host that is not loopback. Loopback is "potentially
 * trustworthy" by the spec every browser implements, so an https page reaching
 * http://127.0.0.1 is allowed and refusing it here would block a node that
 * works. Note 127.0.0.1 is the loopback of whichever machine the *browser* runs
 * on — a node on another box needs that box's address, and then this rule bites
 * for real.
 */
function isBlockedMixedContent(url: string): boolean {
  if (!url.startsWith("http://")) return false;
  try {
    const h = new URL(url).hostname;
    const loopback = h === "localhost" || h.endsWith(".localhost") || h === "::1"
      || h === "[::1]" || /^127\./.test(h);
    return !loopback;
  } catch { return false; }
}

function looksLikeRegistryUri(s: string): boolean {
  return /^rho:id:[a-z0-9]{40,60}$/.test(s.trim());
}

/**
 * The three contract uris a group may carry, keeping only what is actually a
 * registry uri. Everything here arrives from a peer, so every field is checked
 * on the way in — a bad uri would send a member's delegation to a contract that
 * is not the group's, and nothing downstream would notice.
 */
function sanitizeChain(raw: Record<string, unknown>): ChainRefs {
  const out: ChainRefs = {};
  for (const k of ["inbox", "group", "issue"] as const) {
    const v = raw[k];
    if (typeof v === "string" && looksLikeRegistryUri(v)) out[k] = v.trim();
  }
  return out;
}

function mergeGroupFromSync(raw: unknown): boolean {
  if (!raw || typeof raw !== "object") return false;
  const r = raw as Record<string, unknown>;
  const id = String(r.id ?? "");
  if (!id || isRetracted("group", id)) return false;
  const inMembers = (r.members && typeof r.members === "object") ? r.members as Record<string, { peerId?: string; role?: string; label?: string; at?: number; anchor?: string; revAddr?: string }> : {};
  const inVaults = (r.vaults && typeof r.vaults === "object") ? r.vaults as Record<string, { handle?: string; anchor?: string; blob?: string; at?: number }> : {};
  const inDeleg = (r.delegations && typeof r.delegations === "object") ? r.delegations as Record<string, { delegate?: string; at?: number }> : {};
  const inTopic = (r.topicDelegations && typeof r.topicDelegations === "object") ? r.topicDelegations as Record<string, Record<string, { delegate?: string; at?: number }>> : {};
  const inIssues = Array.isArray(r.issues) ? r.issues as Array<Record<string, unknown>> : [];

  const existing = groupStore.get(id);
  if (!existing) {
    const members: Group["members"] = {};
    for (const [pid, m] of Object.entries(inMembers)) members[pid] = { peerId: pid, role: m.role === "admin" ? "admin" : "member", label: String(m.label ?? pid.slice(0, 8)), at: typeof m.at === "number" ? m.at : 0, ...(typeof m.anchor === "string" && m.anchor.length === 64 ? { anchor: m.anchor } : {}) };
    const vaults: NonNullable<Group["vaults"]> = {};
    for (const [h, v] of Object.entries(inVaults)) if (typeof v.blob === "string" && looksLikeVault(v.blob) && typeof v.anchor === "string" && v.anchor.length === 64) vaults[canonHandle(String(v.handle ?? h))] = { handle: canonHandle(String(v.handle ?? h)), anchor: v.anchor, blob: v.blob, at: typeof v.at === "number" ? v.at : 0 };
    const delegations: Group["delegations"] = {};
    for (const [pid, dl] of Object.entries(inDeleg)) if (dl.delegate) delegations[pid] = { delegate: String(dl.delegate), at: typeof dl.at === "number" ? dl.at : 0 };
    const topicDelegations: NonNullable<Group["topicDelegations"]> = {};
    for (const [iid, mp] of Object.entries(inTopic)) { const t: Record<string, { delegate: string; at: number }> = {}; for (const [pid, dl] of Object.entries(mp)) if (dl.delegate) t[pid] = { delegate: String(dl.delegate), at: typeof dl.at === "number" ? dl.at : 0 }; if (Object.keys(t).length) topicDelegations[iid] = t; }
    const issues: Issue[] = inIssues.map((i): Issue => ({ id: String(i.id ?? issueId(String(i.title ?? ""))), title: String(i.title ?? ""), by: String(i.by ?? "?"), at: typeof i.at === "number" ? i.at as number : 0, status: i.status === "closed" ? "closed" : "open", pollId: i.pollId ? String(i.pollId) : undefined })).filter((i) => i.title);
    groupStore.set(id, {
      id, name: String(r.name ?? ""), creator: String(r.creator ?? ""), creatorLabel: String(r.creatorLabel ?? "?"),
      createdAt: typeof r.createdAt === "number" ? r.createdAt : 0, members, delegations,
      ...(Object.keys(topicDelegations).length ? { topicDelegations } : {}),
      ...(typeof r.treasury === "string" ? { treasury: r.treasury } : {}),
      ...(typeof r.kudos === "string" ? { kudos: r.kudos } : {}),
      ...(typeof r.uri === "string" && looksLikeRegistryUri(r.uri) ? { uri: r.uri } : {}),
      ...(typeof r.locker === "string" && looksLikeRegistryUri(r.locker) ? { locker: r.locker } : {}),
      ...(r.chain && typeof r.chain === "object" ? { chain: sanitizeChain(r.chain as Record<string, unknown>) } : {}),
      ...(Object.keys(vaults).length ? { vaults } : {}), issues,
    });
    return true;
  }

  let changed = false;
  if (typeof r.treasury === "string" && !existing.treasury) { existing.treasury = r.treasury; changed = true; }
  if (typeof r.kudos === "string" && !existing.kudos) { existing.kudos = r.kudos; changed = true; }
  if (typeof r.uri === "string" && looksLikeRegistryUri(r.uri) && !existing.uri) { existing.uri = r.uri; changed = true; }
  if (typeof r.locker === "string" && looksLikeRegistryUri(r.locker) && !existing.locker) { existing.locker = r.locker; changed = true; }
  if (r.chain && typeof r.chain === "object") {
    const inc = sanitizeChain(r.chain as Record<string, unknown>);
    for (const k of ["inbox", "group", "issue"] as const) {
      if (inc[k] && !existing.chain?.[k]) { existing.chain = { ...existing.chain, [k]: inc[k] }; changed = true; }
    }
  }
  for (const [pid, m] of Object.entries(inMembers)) {
    const cur = existing.members[pid];
    const at = typeof m.at === "number" ? m.at : 0;
    const anchor = typeof m.anchor === "string" && m.anchor.length === 64 ? m.anchor : undefined;
    const revAddr = typeof m.revAddr === "string" && /^1111[1-9A-HJ-NP-Za-km-z]{20,60}$/.test(m.revAddr) ? m.revAddr : undefined;
    if (!cur || at > cur.at) { existing.members[pid] = { peerId: pid, role: m.role === "admin" ? "admin" : "member", label: String(m.label ?? pid.slice(0, 8)), at, ...((anchor ?? cur?.anchor) ? { anchor: anchor ?? cur?.anchor } : {}), ...((revAddr ?? cur?.revAddr) ? { revAddr: revAddr ?? cur?.revAddr } : {}) }; changed = true; }
    else {
      if (anchor && !cur.anchor) { cur.anchor = anchor; changed = true; }   // stamp a newly-learned anchor without a full replace
      if (revAddr && !cur.revAddr) { cur.revAddr = revAddr; changed = true; }
    }
  }
  // Union vaults (LWW by `at`; same-anchor overwrite only — squat-proof).
  for (const [h, v] of Object.entries(inVaults)) {
    const handle = canonHandle(String(v.handle ?? h));
    if (!handle || typeof v.blob !== "string" || !looksLikeVault(v.blob) || typeof v.anchor !== "string" || v.anchor.length !== 64) continue;
    const at = typeof v.at === "number" ? v.at : 0;
    existing.vaults ??= {};
    const cur = existing.vaults[handle];
    if (cur && (cur.anchor !== v.anchor || at <= cur.at)) continue;
    existing.vaults[handle] = { handle, anchor: v.anchor, blob: v.blob, at };
    changed = true;
  }
  for (const [pid, dl] of Object.entries(inDeleg)) {
    const cur = existing.delegations[pid];
    const at = typeof dl.at === "number" ? dl.at : 0;
    if (dl.delegate && (!cur || at > cur.at)) { existing.delegations[pid] = { delegate: String(dl.delegate), at }; changed = true; }
  }
  for (const [iid, mp] of Object.entries(inTopic)) {
    for (const [pid, dl] of Object.entries(mp)) {
      const cur = existing.topicDelegations?.[iid]?.[pid];
      const at = typeof dl.at === "number" ? dl.at : 0;
      if (dl.delegate && (!cur || at > cur.at)) { existing.topicDelegations ??= {}; (existing.topicDelegations[iid] ??= {})[pid] = { delegate: String(dl.delegate), at }; changed = true; }
    }
  }
  for (const i of inIssues) {
    const iid = String(i.id ?? issueId(String(i.title ?? "")));
    const title = String(i.title ?? "");
    if (!title) continue;
    const cur = existing.issues.find((x) => x.id === iid);
    if (!cur) { existing.issues.push({ id: iid, title, by: String(i.by ?? "?"), at: typeof i.at === "number" ? i.at as number : 0, status: i.status === "closed" ? "closed" : "open", pollId: i.pollId ? String(i.pollId) : undefined }); changed = true; }
    else if (i.pollId && !cur.pollId) { cur.pollId = String(i.pollId); changed = true; }
  }
  return changed;
}

// Resolve a free-text choice list to option ids: option text (exact then prefix)
// or 1-based number into the displayed order. Ranked uses ">".
function resolveChoices(poll: Poll, raw: string): string[] {
  const opts = sortedOptions(poll);
  const parts = (poll.method === "ranked" ? raw.split(">") : raw.split(/[\s,]+/))
    .map((s) => s.trim()).filter(Boolean);
  const out: string[] = [];
  for (const tok of parts) {
    let opt: PollOption | undefined;
    if (/^\d+$/.test(tok)) {
      opt = opts[parseInt(tok, 10) - 1];
    } else {
      const low = tok.toLowerCase();
      opt = opts.find((o) => o.text.toLowerCase() === low) ?? opts.find((o) => o.text.toLowerCase().startsWith(low));
    }
    if (opt && !out.includes(opt.id)) out.push(opt.id);
  }
  return out;
}

// ---------------------------------------------------------------------------
// /estimate — robust group numeric estimate (median by default, whale-resistant)
// One round at a time (like the probe window). Each peer submits one value;
// the round computes a median + quartiles. Used by gov-9stage (Evaluate & size)
// and colab-study (group impact). See RhoQuCalc_Macros.md.
// ---------------------------------------------------------------------------

interface EstimateRound {
  id: string;
  question: string;
  creator: string;        // peer id of the opener
  values: Map<string, number>;   // peerId → latest value
  open: boolean;
  tally: "median" | "mean";
}
let estimateRound: EstimateRound | null = null;

function quantileOf(sorted: number[], q: number): number {
  if (sorted.length === 0) return NaN;
  if (sorted.length === 1) return sorted[0];
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function estimateSummary(round: EstimateRound, sys: (t: string) => void): void {
  const xs = [...round.values.values()].sort((a, b) => a - b);
  const n = xs.length;
  sys(`/estimate "${round.question}"  [${round.open ? "open" : "closed"}]  — ${n} estimate${n === 1 ? "" : "s"}`);
  if (n === 0) { sys("  no estimates yet — submit one with /estimate <number>"); return; }
  const med = quantileOf(xs, 0.5);
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  const headline = round.tally === "mean" ? mean : med;
  sys(`  ${round.tally}: ${headline.toLocaleString(undefined, { maximumFractionDigits: 4 })}   (whale/outlier-resistant: median)`);
  sys(`  median: ${med.toLocaleString(undefined, { maximumFractionDigits: 4 })}   mean: ${mean.toLocaleString(undefined, { maximumFractionDigits: 4 })}`);
  sys(`  range: [${xs[0]}, ${xs[n - 1]}]   IQR: [${quantileOf(xs, 0.25).toLocaleString(undefined, { maximumFractionDigits: 4 })}, ${quantileOf(xs, 0.75).toLocaleString(undefined, { maximumFractionDigits: 4 })}]`);
}

function handleEstimate(arg: string, sys: (t: string) => void): void {
  // Strip a leading/trailing --median | --mean flag (median is the default).
  let tally: "median" | "mean" = "median";
  let rest = arg.replace(/--mean\b/g, () => { tally = "mean"; return ""; })
                .replace(/--median\b/g, "").trim();
  const parts = rest.length ? rest.split(/\s+/) : [];
  const sub = (parts[0] ?? "").toLowerCase();

  if (sub === "status" || (sub === "" && estimateRound)) {
    if (!estimateRound) { sys("no estimate round open — start one with /estimate new <question>"); return; }
    estimateSummary(estimateRound, sys);
    return;
  }
  if (sub === "close") {
    if (!estimateRound) { sys("no estimate round to close"); return; }
    if (estimateRound.creator !== myPeerId()) { sys("only the round's opener can close it"); return; }
    estimateRound.open = false;
    estimateSummary(estimateRound, sys);
    signedBroadcast({ kind: "estimate-close", id: estimateRound.id });
    return;
  }
  if (sub === "new" || (sub !== "" && isNaN(Number(parts[0])))) {
    // Open a new round. "/estimate new <q>" or "/estimate <non-numeric question>".
    const question = (sub === "new" ? parts.slice(1).join(" ") : rest).trim();
    if (!question) { sys("usage: /estimate new <question>   then /estimate <number>"); return; }
    const id = `est-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e4).toString(36)}`;
    estimateRound = { id, question, creator: myPeerId(), values: new Map(), open: true, tally };
    sys(`estimate round open: "${question}"  [${tally}]  — submit with /estimate <number>`);
    signedBroadcast({ kind: "estimate-open", id, question, tally });
    return;
  }
  // A bare number = submit your estimate into the open round.
  const v = Number(parts[0]);
  if (isNaN(v)) {
    sys("usage: /estimate new <question> · <number> · status · close   (--median default, --mean opt)");
    return;
  }
  if (!estimateRound || !estimateRound.open) { sys("no open estimate round — start one with /estimate new <question>"); return; }
  estimateRound.values.set(myPeerId(), v);
  sys(`estimate recorded: ${v}  ("${estimateRound.question}")`);
  estimateSummary(estimateRound, sys);
  signedBroadcast({ kind: "estimate-value", id: estimateRound.id, value: v });
}

function addOption(poll: Poll, text: string): void {
  const t = text.trim();
  if (!t) return;
  if (poll.status !== "open" || poll.nominationsLocked) { addMessage("", "nominations are closed for this poll", "system"); return; }
  const opt: PollOption = { id: optionId(t), text: t, by: myName || shortId(myPeerId()), at: Date.now() };
  if (!mergeOption(poll, opt)) return;          // duplicate — already present
  savePolls();
  refreshPollCard(poll);
  renderPolls();
  signedBroadcast({ kind: "poll-option", pollId: poll.id, id: opt.id, text: opt.text, by: opt.by, at: opt.at });
}

function castVote(poll: Poll, choices: string[]): void {
  if (poll.status !== "open") return;
  poll.ballots[myPeerId()] = choices;
  savePolls();
  refreshPollCard(poll);
  renderPolls();
  signedBroadcast({ kind: "poll-ballot", pollId: poll.id, choices });
}

function lockNominations(poll: Poll): void {
  if (poll.creator !== myPeerId() || poll.nominationsLocked) return;
  poll.nominationsLocked = true;
  savePolls();
  refreshPollCard(poll);
  signedBroadcast({ kind: "poll-lock", pollId: poll.id });
}

// Append a permanent, human-readable result line to the transcript so the
// outcome survives independently of the interactive card (chat scroll-back,
// the 500-line card cap, export). Idempotent callers ensure it logs once.
function postPollClosedMessage(poll: Poll): void {
  const result = poll.result ?? tally(poll);
  addMessage("", `🗳 poll closed — “${poll.question}” · ${summarizeWinners(poll, result)} (${result.totalBallots} vote${result.totalBallots === 1 ? "" : "s"})`, "system");
}

function closePoll(poll: Poll): void {
  if (poll.status !== "open") return;
  if (poll.creator !== myPeerId()) { addMessage("", "only the poll creator can close it", "system"); return; }
  poll.status = "closed";
  poll.result = tally(poll);
  savePolls();
  refreshPollCard(poll);
  renderPolls();
  postPollClosedMessage(poll);
  signedBroadcast({ kind: "poll-close", pollId: poll.id });
}

// Drop a poll from local state and replace its live card with a "removed" note.
// The chat marker line is left in place; on reload renderPollCardInto sees the
// missing-but-tombstoned poll and shows the same placeholder.
function removePollLocal(poll: Poll): void {
  pollStore.delete(poll.id);
  savePolls();
  const node = pollCards.get(poll.id);
  if (node && node.isConnected && isUiActive()) {
    const ph = document.createElement("span");
    ph.className = "poll-you";
    ph.textContent = `🗳 poll removed — “${poll.question}”`;
    node.replaceWith(ph);
  }
  pollCards.delete(poll.id);
  renderPolls();
}

// Forget a poll. The creator broadcasts a retraction everyone honors (so it
// can't re-sync back); anyone else removes it from their own view only. Either
// way it is tombstoned locally so a peer's sync can't heal it back here.
function forgetPoll(poll: Poll): void {
  const mine = poll.creator === myPeerId();
  markRetracted("poll", poll.id);
  removePollLocal(poll);
  if (mine) {
    signedBroadcast({ kind: "retract", what: "poll", id: poll.id });
    addMessage("", `🗳 poll retracted — “${poll.question}”`, "system");
  } else {
    addMessage("", `🗳 poll hidden for you — “${poll.question}” (only the creator can retract it for everyone)`, "system");
  }
}

// Forget a lemma. If we authored it (it carries our anchor, or none — locally
// declared lemmas store no dyncap), broadcast a retraction peers honor; either
// way tombstone + drop it locally so sync can't heal it back.
function forgetLemma(name: string): void {
  const entry = lemmaStore.get(name);
  if (!entry) { addMessage("", `no lemma ${lemmaRefStr(name)} to forget`, "system"); return; }
  const myAnchor = dyncapState?.anchor;
  const mine = !entry.dyncap || (!!myAnchor && entry.dyncap.anchor === myAnchor);
  markRetracted("lemma", name);
  lemmaStore.delete(name);
  saveLemmas();
  renderLemmas();
  if (mine) {
    signedBroadcast({ kind: "retract", what: "lemma", id: name });
    addMessage("", `· ${lemmaRefStr(name)} retracted`, "system");
  } else {
    addMessage("", `· ${lemmaRefStr(name)} hidden for you (only its author can retract it for everyone)`, "system");
  }
}

// Forget a held note. Private bearer value — local only, no broadcast, no
// tombstone (the same token can legitimately be received again later).
function forgetNote(token: string): void {
  const n = noteStore.get(token);
  if (!n) { addMessage("", "no such note to forget", "system"); return; }
  if (!confirm(`Delete your ${n.currency} ${n.denomination} note? This destroys its value and cannot be undone.`)) return;
  noteStore.delete(token);
  saveNotes();
  renderNotes();
  addMessage("", `· deleted ${n.currency} ${n.denomination} note (value destroyed)`, "system");
}

function createPoll(question: string, optionTexts: string[], method: PollMethod): Poll {
  const id = `poll-${myPeerId().slice(-4)}-${Date.now().toString(36)}`;
  const by = myName || shortId(myPeerId());
  const options: PollOption[] = optionTexts.map((t, k) => ({ id: optionId(t), text: t, by, at: Date.now() + k }));
  const poll: Poll = {
    id, question, options, method,
    creator: myPeerId(), creatorLabel: by,
    createdAt: Date.now(), status: "open", ballots: {},
  };
  pollStore.set(id, poll);
  savePolls();
  renderPolls();
  addPollCard(poll);
  signedBroadcast({
    kind: "poll-open", id, question, method, options,
    creator: poll.creator, creatorLabel: poll.creatorLabel, createdAt: poll.createdAt,
  });
  return poll;
}

function buildPollCard(poll: Poll): HTMLElement {
  const card = document.createElement("div");
  card.className = "poll-card";
  card.dataset.poll = poll.id;

  const q = document.createElement("div");
  q.className = "poll-q";
  q.textContent = poll.question + " ";
  const badge = document.createElement("span");
  badge.className = "poll-badge";
  badge.textContent = poll.method === "ranked" ? "ranked-choice" : "approval";
  q.appendChild(badge);
  if (poll.status === "closed") {
    const cl = document.createElement("span"); cl.className = "poll-badge"; cl.textContent = "closed"; q.appendChild(cl);
  } else if (!poll.nominationsLocked) {
    const op = document.createElement("span"); op.className = "poll-badge"; op.textContent = "open for ideas"; q.appendChild(op);
  }
  card.appendChild(q);

  const opts = sortedOptions(poll);
  const counts = liveCounts(poll);
  const maxCount = Math.max(1, ...Object.values(counts));
  const mine = poll.ballots[myPeerId()] ?? [];
  const result = poll.status === "closed" ? (poll.result ?? tally(poll)) : null;

  for (const opt of opts) {
    const row = document.createElement("div");
    row.className = "poll-opt";
    if (result && result.winners.includes(opt.id)) row.classList.add("winner");
    if (mine.includes(opt.id)) row.classList.add("voted");

    const bar = document.createElement("div");
    bar.className = "poll-bar";
    bar.style.width = `${Math.round(((counts[opt.id] ?? 0) / maxCount) * 100)}%`;
    row.appendChild(bar);

    if (poll.method === "ranked") {
      const rk = document.createElement("span");
      rk.className = "poll-rank";
      const pos = mine.indexOf(opt.id);
      rk.textContent = pos >= 0 ? (RANK_CIRCLED[pos] ?? `#${pos + 1}`) : "";
      row.appendChild(rk);
    }

    const label = document.createElement("span");
    label.style.flex = "1";
    label.textContent = opt.text;
    label.title = `suggested by ${opt.by}`;
    row.appendChild(label);

    const count = document.createElement("span");
    count.className = "poll-count";
    count.textContent = String(counts[opt.id] ?? 0);
    row.appendChild(count);

    if (poll.status === "open") {
      const btn = document.createElement("button");
      const isMine = mine.includes(opt.id);
      btn.textContent = poll.method === "approval"
        ? (isMine ? "✓ approved" : "approve")
        : (isMine ? "ranked" : "rank");
      btn.addEventListener("click", () => {
        const next = isMine ? mine.filter((x) => x !== opt.id) : [...mine, opt.id];
        castVote(poll, next);
      });
      row.appendChild(btn);
    }
    card.appendChild(row);
  }

  // "add an option" row — open nominations
  if (poll.status === "open" && !poll.nominationsLocked) {
    const addRow = document.createElement("div");
    addRow.className = "poll-add";
    const input = document.createElement("input");
    input.type = "text"; input.placeholder = "add an option…"; input.className = "poll-add-input";
    const go = document.createElement("button");
    go.className = "poll-ctlbtn"; go.textContent = "+ add";
    const submit = () => { if (input.value.trim()) { addOption(poll, input.value); input.value = ""; } };
    go.addEventListener("click", submit);
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); submit(); } });
    addRow.appendChild(input);
    addRow.appendChild(go);
    card.appendChild(addRow);
  }

  const foot = document.createElement("div");
  foot.className = "poll-you";
  if (poll.status === "closed" && result) {
    foot.textContent = summarizeWinners(poll, result);
  } else if (mine.length > 0) {
    foot.textContent = "you voted: " +
      mine.map((id) => poll.options.find((o) => o.id === id)?.text ?? id).join(poll.method === "ranked" ? " > " : ", ");
  } else if (opts.length > 0) {
    foot.textContent = poll.method === "ranked"
      ? "click options in your order of preference"
      : "click every option you'd be happy with";
  } else {
    foot.textContent = "no options yet — add the first one above";
  }
  card.appendChild(foot);

  if (poll.status === "closed" && result && result.method === "ranked" && result.rounds.length > 1) {
    const rd = document.createElement("div");
    rd.className = "poll-rounds";
    rd.textContent = result.rounds.map((r, k) => {
      const line = opts.map((o) => (r.counts[o.id] < 0 ? `${o.text}:✗` : `${o.text}:${r.counts[o.id] ?? 0}`)).join("  ");
      return `round ${k + 1}: ${line}${r.eliminated ? `  — out: ${poll.options.find((o) => o.id === r.eliminated)?.text ?? ""}` : ""}`;
    }).join("\n");
    card.appendChild(rd);
  }

  const ctrls = document.createElement("div");
  ctrls.style.marginTop = "0.4rem";
  if (poll.status === "open") {
    if (poll.method === "ranked" && mine.length > 0) {
      const clear = document.createElement("button");
      clear.className = "poll-ctlbtn"; clear.textContent = "clear ranking";
      clear.addEventListener("click", () => castVote(poll, []));
      ctrls.appendChild(clear);
    }
    if (poll.creator === myPeerId() && !poll.nominationsLocked && opts.length > 0) {
      const lk = document.createElement("button");
      lk.className = "poll-ctlbtn"; lk.textContent = "lock nominations";
      lk.addEventListener("click", () => lockNominations(poll));
      ctrls.appendChild(lk);
    }
    if (poll.creator === myPeerId()) {
      const cl = document.createElement("button");
      cl.className = "poll-ctlbtn poll-close"; cl.textContent = "close poll";
      cl.addEventListener("click", () => closePoll(poll));
      ctrls.appendChild(cl);
    }
  }
  // Remove is always available: the creator retracts it for everyone, anyone
  // else hides it from their own view.
  const rm = document.createElement("button");
  rm.className = "poll-ctlbtn poll-remove";
  rm.textContent = poll.creator === myPeerId() ? "remove" : "hide";
  rm.title = poll.creator === myPeerId()
    ? "retract this poll for everyone"
    : "hide this poll from your view";
  rm.addEventListener("click", () => forgetPoll(poll));
  ctrls.appendChild(rm);
  card.appendChild(ctrls);
  return card;
}

function renderPollCardInto(host: HTMLElement, pollId: string): void {
  const poll = pollStore.get(pollId);
  if (!poll) {
    const ph = document.createElement("span");
    ph.className = "poll-you";
    ph.textContent = isRetracted("poll", pollId) ? "🗳 poll removed" : "🗳 poll unavailable";
    host.appendChild(ph);
    return;
  }
  const card = buildPollCard(poll);
  pollCards.set(pollId, card);
  host.appendChild(card);
}

function refreshPollCard(poll: Poll): void {
  if (!isUiActive()) return;
  const node = pollCards.get(poll.id);
  if (!node || !node.isConnected) return;
  // Preserve a half-typed "add an option" draft + focus across the re-render
  // that an inbound ballot/option would otherwise wipe out.
  const active = document.activeElement;
  const editing = active instanceof HTMLInputElement && node.contains(active) && active.classList.contains("poll-add-input");
  const draft = editing ? active.value : null;
  const fresh = buildPollCard(poll);
  node.replaceWith(fresh);
  pollCards.set(poll.id, fresh);
  if (draft !== null) {
    const inp = fresh.querySelector(".poll-add-input") as HTMLInputElement | null;
    if (inp) { inp.value = draft; inp.focus(); }
  }
  refreshIssueCardsForPoll(poll.id);   // keep a governance issue card's result in sync
}

function addPollCard(poll: Poll): void {
  const line: ChatLine = { from: poll.creator, text: poll.question, kind: "peer", pollId: poll.id };
  activeRoom.chatLog.push(line);
  trimChatLog(activeRoom);
  saveChat(activeRoom);
  if (isUiActive()) {
    renderChatLine(line);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  } else {
    markUnread(activeRoom);
  }
}

function renderPolls(): void {
  if (!isUiActive()) return;
  pollCountEl.textContent = String(pollStore.size);
  pollListEl.innerHTML = "";
  for (const poll of [...pollStore.values()].sort((a, b) => b.createdAt - a.createdAt)) {
    const li = document.createElement("li");
    const nb = Object.keys(poll.ballots).length;
    li.className = "row-item";
    li.style.cssText = "font-size:0.7rem;color:#aaa;padding:0.3rem 0;border-bottom:1px solid #1a1a1a;";
    const label = document.createElement("span");
    label.textContent = `${poll.status === "open" ? "●" : "✓"} ${poll.question.slice(0, 24)} (${poll.options.length}◦ ${nb}✓)`;
    label.style.cursor = "pointer";
    label.style.flex = "1";
    label.addEventListener("click", () => { msgInput.value = `/poll vote ${poll.id} `; msgInput.focus(); });
    li.title = `${poll.method} · ${poll.options.map((o) => o.text).join(", ") || "no options yet"}`;
    li.appendChild(label);
    appendRemoveBtn(li, poll.creator === myPeerId() ? "retract this poll for everyone" : "hide this poll from your view", () => forgetPoll(poll));
    pollListEl.appendChild(li);
  }
}

// ---------------------------------------------------------------------------
// Governance — liquid-democracy groups (gov.ts)
// ---------------------------------------------------------------------------

const macroListEl  = document.getElementById("macro-list");
const macroCountEl = document.getElementById("macro-count");
const govListEl  = document.getElementById("gov-list");
const govCountEl = document.getElementById("gov-count");
const govCards = new Map<string, HTMLElement>();   // groupId -> live card node
const issueCards = new Map<string, HTMLElement>(); // "groupId::issueId" -> live card node
const issueCardKey = (groupId: string, issueId: string): string => `${groupId}::${issueId}`;

function govLabel(): string { return myName || shortId(myPeerId()); }

function findGroup(arg: string): Group | null {
  if (!arg) return null;
  if (groupStore.has(arg)) return groupStore.get(arg)!;
  const low = arg.trim().toLowerCase();
  let pfx: Group | null = null;
  for (const g of groupStore.values()) {
    if (g.name.toLowerCase() === low) return g;
    if (!pfx && g.name.toLowerCase().startsWith(low)) pfx = g;
  }
  return pfx;
}

// Delegation-resolved effective weights for a group's issue poll (members only).
// Uses the per-issue delegation map (topic overrides global) for `issue`.
function govWeights(g: Group, issue: Issue, poll: Poll): Record<string, number> {
  const members = Object.keys(g.members);
  const deleg = delegationMapFor(g, issue.id);
  const direct = new Set(members.filter((p) => (poll.ballots[p]?.length ?? 0) > 0));
  // Trust-weighted liquid democracy: a member carries 1 + the affirmative trust
  // others place in them (flat 1 each when no ratings exist → plain one-vote).
  return resolveWeights(members, deleg, direct, trustWeightsFor(g)).weightByVoter;
}

function createGroup(name: string): Group {
  const id = `grp-${myPeerId().slice(-4)}-${Date.now().toString(36)}`;
  const me = myPeerId(); const label = govLabel();
  // Stamp the creator's own anchor. A peerId is per-tab and can change — a new
  // lease, a cleared storage, a /login in another browser — while the anchor is
  // the durable identity. Without it `memberKeyFor` has nothing to fall back on,
  // so a creator whose peerId moved stopped being recognised as a member at all
  // and lost admin of their own group with no way to get it back.
  const anchor = dyncapState?.anchor;
  const g: Group = { id, name, creator: me, creatorLabel: label, createdAt: Date.now(),
    members: { [me]: { peerId: me, role: "admin", label, at: Date.now(), ...(anchor ? { anchor } : {}) } }, delegations: {}, issues: [] };
  groupStore.set(id, g); saveGroups(); renderGroups();
  signedBroadcast({ kind: "group-open", id, name, creatorLabel: label, createdAt: g.createdAt });
  return g;
}

/**
 * Why a permission was refused, in the one case that is almost never the
 * obvious one: your identity moved.
 *
 * A peerId is per-tab and can change — a new lease, cleared storage, a /login
 * in another browser. The anchor is durable and a member record carries it, so
 * a moved identity is normally re-attached. A record written before anchors
 * were stamped has none, and then the only symptom is a flat refusal on a group
 * you created. Say enough to recognise that, without printing a wall.
 */
function whoIsAdmin(g: Group, meId: string, meAnchor: string | undefined,
                    say: (t: string) => void): void {
  const admins = Object.values(g.members).filter((m) => m.role === "admin" || m.peerId === g.creator);
  say(`  admins of “${g.name}”: ${admins.map((m) => `${m.label} (${m.peerId.slice(0, 8)}…)`).join(", ") || "none recorded"}`);
  say(`  you are ${meId.slice(0, 8)}…${meAnchor ? ` · anchor ${meAnchor.slice(0, 8)}…` : " · no dyncap anchor"}`);
  const anchorless = admins.filter((m) => !m.anchor);
  if (anchorless.length && !admins.some((m) => m.peerId === meId)) {
    say("  those admin records carry no durable anchor, so an identity that moved cannot be");
    say("  matched back to them. If that group was yours: /gov claim — it only works while you");
    say("  are the sole member, which is the one case where it cannot take anything from anyone.");
  }
}

function govSetMember(g: Group, peerId: string, role: Role, label: string): void {
  // Carry whatever durable identity we already have for them: their own
  // verified dyncap anchor if this browser has seen one, or an anchor already
  // on record. See createGroup for why a member record without one is a member
  // who can silently stop being one.
  const anchor = dyncapChains.get(peerId)?.anchor ?? g.members[peerId]?.anchor;
  g.members[peerId] = { peerId, role, label, at: Date.now(), ...(anchor ? { anchor } : {}) };
  saveGroups(); renderGroups(); refreshGroupCard(g);
  signedBroadcast({ kind: "group-member", groupId: g.id, peerId, role, label });
}
function govRemoveMember(g: Group, peerId: string): void {
  delete g.members[peerId]; delete g.delegations[peerId];
  saveGroups(); renderGroups(); refreshGroupCard(g);
  signedBroadcast({ kind: "group-member", groupId: g.id, peerId, remove: true });
}
// Set/clear your delegate. With `issueId`, it's a per-issue delegate that
// overrides your global one for that issue only; without, it's the global one.
function govSetDelegate(g: Group, delegate: string | null, issueId?: string): void {
  const me = myPeerId();
  if (issueId) {
    g.topicDelegations ??= {};
    const m = (g.topicDelegations[issueId] ??= {});
    if (delegate === null) delete m[me]; else m[me] = { delegate, at: Date.now() };
    if (Object.keys(m).length === 0) delete g.topicDelegations[issueId];
  } else {
    if (delegate === null) delete g.delegations[me];
    else g.delegations[me] = { delegate, at: Date.now() };
  }
  saveGroups(); renderGroups(); refreshGroupCard(g);
  signedBroadcast({ kind: "gov-delegate", groupId: g.id, delegator: me, delegate, ...(issueId ? { issueId } : {}) });
}
// Set/clear your affirmative-trust rating for another member (the RGOV liquid-
// trust extension). rating 0 clears. Self-signed — you set only your own row.
function govSetTrust(g: Group, ratee: string, rating: number): void {
  const me = myPeerId();
  const r = Math.max(0, Math.min(TRUST_MAX, Math.round(rating)));
  g.trustRatings ??= {};
  const row = (g.trustRatings[me] ??= {});
  if (r === 0) delete row[ratee]; else row[ratee] = r;
  if (Object.keys(row).length === 0) delete g.trustRatings[me];
  saveGroups(); renderGroups(); refreshGroupCard(g);
  signedBroadcast({ kind: "gov-trust", groupId: g.id, rater: me, ratee, rating: r });
}
// Set/clear your accountability censure of another member. Self-signed.
function govSetCensure(g: Group, target: string, on: boolean): void {
  const me = myPeerId();
  g.censures ??= {};
  const row = (g.censures[me] ??= {});
  if (on) row[target] = 1; else delete row[target];
  if (Object.keys(row).length === 0) delete g.censures[me];
  saveGroups(); renderGroups(); refreshGroupCard(g);
  signedBroadcast({ kind: "gov-censure", groupId: g.id, censurer: me, target, on });
}
// Normalize a recovery handle (the public label a user types to recover their
// identity): trim, lowercase, collapse internal whitespace. Matches the memorable
// display-name style so `/login <handle>` is forgiving.
function canonHandle(s: string): string { return s.trim().toLowerCase().replace(/\s+/g, " "); }

// Bind a verified identity (peerId + its durable dyncap anchor) to group
// membership: stamp the anchor onto the member record, and if the anchor is
// already a member under a DIFFERENT (stale) peerId — e.g. they recovered their
// identity in a new browser — move that membership onto the live peerId so their
// standing follows their identity. Only ever driven by a dyncap-verified anchor,
// so it cannot hijack a membership without control of the seed. Returns true if
// anything changed.
function reconcileGroups(peerId: string, anchor?: string): boolean {
  if (!anchor || !peerId) return false;
  let changed = false;
  for (const g of groupStore.values()) {
    const cur = g.members[peerId];
    if (cur) { if (cur.anchor !== anchor) { cur.anchor = anchor; changed = true; } continue; }
    const oldKey = Object.keys(g.members).find((k) => g.members[k].anchor === anchor);
    if (oldKey) { rekeyMember(g, oldKey, peerId); g.members[peerId].anchor = anchor; changed = true; }
  }
  if (changed) { saveGroups(); renderGroups(); }
  return changed;
}

// Publish (or update) my password-encrypted identity into a group I'm a member
// of, so I can recover it by rejoining. Self-signed; FWW-by-handle enforced on
// receipt. Replicated via `gov-vault` + carried in `sync-gov`.
function govPublishVault(g: Group, rec: VaultRecord): void {
  g.vaults ??= {};
  g.vaults[rec.handle] = rec;
  saveGroups(); renderGroups(); refreshGroupCard(g);
  signedBroadcast({ kind: "gov-vault", groupId: g.id, handle: rec.handle, anchor: rec.anchor, blob: rec.blob, at: rec.at });
}

function govNewIssue(g: Group, title: string): Issue {
  const iid = issueId(title);
  let iss = g.issues.find((i) => i.id === iid);
  if (!iss) {
    iss = { id: iid, title, by: govLabel(), at: Date.now(), status: "open" };
    g.issues.push(iss); saveGroups(); renderGroups(); refreshGroupCard(g);
    addIssueCard(g, iss);
    signedBroadcast({ kind: "group-issue", groupId: g.id, issue: iss });
  } else {
    addIssueCard(g, iss);   // surface the existing issue's card
  }
  return iss;
}
function govOpenVote(g: Group, issue: Issue, method: PollMethod, optionTexts: string[]): void {
  const poll = createPoll(`[${g.name}] ${issue.title}`, optionTexts, method);
  issue.pollId = poll.id; issue.status = "open";
  saveGroups(); renderGroups(); refreshGroupCard(g); refreshIssueCard(g, issue);
  signedBroadcast({ kind: "group-vote", groupId: g.id, issueId: issue.id, pollId: poll.id });
}
function forgetGroup(g: Group): void {
  const mine = g.creator === myPeerId();
  markRetracted("group", g.id);
  groupStore.delete(g.id);
  saveGroups(); renderGroups();
  const node = govCards.get(g.id); if (node?.isConnected) node.remove();
  govCards.delete(g.id);
  if (mine) { signedBroadcast({ kind: "retract", what: "group", id: g.id }); addMessage("", `🏛 group “${g.name}” disbanded`, "system"); }
  else addMessage("", `🏛 group “${g.name}” hidden for you`, "system");
}

// One issue's weighted result line: leader (open) / winner (closed) + total weight.
function issueResultText(g: Group, issue: Issue): string {
  if (!issue.pollId) return "no vote yet";
  const poll = pollStore.get(issue.pollId);
  if (!poll) return "vote pending sync";
  const weights = govWeights(g, issue, poll);
  const res = tally(poll, weights);
  const verb = poll.status === "closed" ? "winner" : "leading";
  return `${verb}: ${summarizeWinners(poll, res).replace(/^.*?: /, "")} · ${res.totalBallots} weight`;
}

function buildGroupCard(g: Group): HTMLElement {
  const me = myPeerId();
  const admin = isAdmin(g, me, dyncapState?.anchor);
  const member = isMember(g, me, dyncapState?.anchor);
  const card = document.createElement("div");
  card.className = "gov-card";

  const h = document.createElement("div");
  h.className = "gov-title";
  h.textContent = `🏛 ${g.name} `;
  const badge = document.createElement("span");
  badge.className = "poll-badge";
  badge.textContent = `${Object.keys(g.members).length} member${Object.keys(g.members).length === 1 ? "" : "s"}`;
  h.appendChild(badge);
  if (admin) { const a = document.createElement("span"); a.className = "poll-badge"; a.textContent = "you: admin"; h.appendChild(a); }
  card.appendChild(h);

  // Members + delegation + liquid trust
  const myDelegate = g.delegations[me]?.delegate;
  const tw = trustWeightsFor(g);
  const levels = trustLevels(g);
  const discredited = new Set(discreditedMembers(g));
  const anyTrust = Object.values(tw).some((w) => w !== 1);
  const myLevel = levels[me] ?? 0;
  const maxAssign = myLevel - 1;                 // highest trust level I may confer (strictly below my own)
  for (const m of Object.values(g.members).sort((a, b) => a.at - b.at)) {
    const row = document.createElement("div"); row.className = "gov-row";
    const del = g.delegations[m.peerId]?.delegate;
    const wt = anyTrust ? `  [wt ${tw[m.peerId] ?? 1}]` : "";
    const flag = discredited.has(m.peerId) ? "  ⚠" : "";
    const tag = `${m.role === "admin" ? "★" : "·"} ${m.label}${del ? `  → ${memberLabel(g, del)}` : ""}${m.peerId === me ? "  (you)" : ""}${wt}${flag}`;
    const lab = document.createElement("span"); lab.style.flex = "1"; lab.textContent = tag; row.appendChild(lab);
    // delegate-to-this-member control (members only; not yourself)
    if (member && m.peerId !== me) {
      const b = document.createElement("button"); b.className = "poll-ctlbtn";
      b.textContent = myDelegate === m.peerId ? "↩ undelegate" : "delegate →";
      b.addEventListener("click", () => govSetDelegate(g, myDelegate === m.peerId ? null : m.peerId));
      row.appendChild(b);
    }
    // trust-level selector — confer a level strictly below your own (members with standing)
    if (member && m.peerId !== me && maxAssign >= 0) {
      const sel = document.createElement("select"); sel.className = "poll-ctlbtn";
      sel.title = `confer a trust level below your own (you are level ${myLevel})`;
      const cur = Math.min(g.trustRatings?.[me]?.[m.peerId] ?? 0, maxAssign);
      for (let lvl = 0; lvl <= maxAssign; lvl++) {
        const opt = document.createElement("option"); opt.value = String(lvl);
        opt.textContent = lvl === 0 ? "trust ·" : `trust ${lvl}`;
        if (lvl === cur) opt.selected = true;
        sel.appendChild(opt);
      }
      sel.addEventListener("change", () => govSetTrust(g, m.peerId, Number(sel.value)));
      row.appendChild(sel);
    }
    // censure toggle — flag undeserved trust (needs standing; a ⅔ quorum discredits)
    if (member && m.peerId !== me && myLevel >= 1) {
      const censured = !!g.censures?.[me]?.[m.peerId];
      const c = document.createElement("button");
      c.className = censured ? "poll-ctlbtn poll-remove" : "poll-ctlbtn";
      c.textContent = censured ? "✓ censured" : "censure";
      c.title = "flag undeserved trust — a ⅔ quorum of eligible peers discredits them and slashes their vouchers";
      c.addEventListener("click", () => govSetCensure(g, m.peerId, !censured));
      row.appendChild(c);
    }
    if (admin && m.peerId !== g.creator) appendRemoveBtn(row, "remove member", () => govRemoveMember(g, m.peerId));
    card.appendChild(row);
  }
  if (member) {
    const note = document.createElement("div"); note.className = "poll-you";
    note.textContent = myDelegate ? `your vote flows to ${memberLabel(g, myDelegate)} unless you vote` : "you vote directly (no delegate set)";
    card.appendChild(note);
  }
  if (member && anyTrust) {
    const tn = document.createElement("div"); tn.className = "poll-you";
    tn.textContent = `liquid trust: vote weight = 1 + level (admins root at ${TRUST_MAX}); ⚠ = discredited by a ⅔ censure quorum`;
    card.appendChild(tn);
  }

  // Issues
  for (const issue of g.issues) {
    const row = document.createElement("div"); row.className = "gov-row";
    const lab = document.createElement("span"); lab.style.flex = "1";
    lab.textContent = `▸ ${issue.title} — ${issueResultText(g, issue)}`;
    row.appendChild(lab);
    if (issue.pollId && pollStore.has(issue.pollId)) {
      const v = document.createElement("button"); v.className = "poll-ctlbtn"; v.textContent = "vote";
      v.addEventListener("click", () => { msgInput.value = `/poll vote ${issue.pollId} `; msgInput.focus(); });
      row.appendChild(v);
    } else if (member) {
      const o = document.createElement("button"); o.className = "poll-ctlbtn"; o.textContent = "open vote";
      o.addEventListener("click", () => { setFocusedGroup(g.id); msgInput.value = `/gov vote ${issue.title} | `; msgInput.focus(); });
      row.appendChild(o);
    }
    card.appendChild(row);
  }

  // Treasury / kudos readout (balances are bearer-private, so this shows yours)
  if (g.treasury || g.kudos) {
    const myBal = (cur?: string) => cur ? [...noteStore.values()].filter((n) => n.currency === cur).reduce((s, n) => s + n.denomination, 0) : 0;
    const fin = document.createElement("div"); fin.className = "poll-you";
    const parts: string[] = [];
    if (g.treasury) parts.push(`🏦 treasury: you hold ${myBal(g.treasury)} ${g.treasury}`);
    if (g.kudos) parts.push(`👏 kudos: you hold ${myBal(g.kudos)}`);
    fin.textContent = parts.join("  ·  ");
    card.appendChild(fin);
  }

  // The group's durable name, when it has one. Clicking reads it back, which is
  // the only way to tell a recorded URI from a remembered one.
  if (g.uri) {
    const u = document.createElement("div");
    u.className = "poll-you";
    u.textContent = `📇 on chain: ${g.uri}`;
    u.title = "click to read the record back from the node";
    u.style.cursor = "pointer";
    u.addEventListener("click", () => { prefill(`/rholang read ${g.uri}`); });
    card.appendChild(u);
  }

  // Admin / member controls
  const ctrls = document.createElement("div"); ctrls.style.marginTop = "0.4rem";
  // Card-button clicks set the focused group, so the prefilled command targets
  // THIS group (after a reload the typed-command focus would otherwise be unset).
  const prefill = (text: string) => { setFocusedGroup(g.id); msgInput.value = text; msgInput.focus(); };
  if (member) {
    const s = document.createElement("button"); s.className = "poll-ctlbtn"; s.textContent = "💬 say";
    s.addEventListener("click", () => prefill("/gov say "));
    ctrls.appendChild(s);
    const k = document.createElement("button"); k.className = "poll-ctlbtn"; k.textContent = "👏 kudos";
    k.addEventListener("click", () => prefill("/gov kudos "));
    ctrls.appendChild(k);
  }
  if (admin && !g.treasury) {
    const t = document.createElement("button"); t.className = "poll-ctlbtn"; t.textContent = "🏦 set up treasury";
    t.addEventListener("click", () => { setFocusedGroup(g.id); handleCommand("/gov treasury declare"); });
    ctrls.appendChild(t);
  } else if (admin && g.treasury) {
    const t = document.createElement("button"); t.className = "poll-ctlbtn"; t.textContent = "🏦 fund member";
    t.addEventListener("click", () => prefill("/gov treasury grant "));
    ctrls.appendChild(t);
  }
  if (admin) {
    const am = document.createElement("button"); am.className = "poll-ctlbtn"; am.textContent = "+ member";
    am.addEventListener("click", () => prefill("/gov member add "));
    ctrls.appendChild(am);
  }
  if (member) {
    const ni = document.createElement("button"); ni.className = "poll-ctlbtn"; ni.textContent = "+ issue";
    ni.addEventListener("click", () => prefill("/gov issue "));
    ctrls.appendChild(ni);
  }
  if (g.creator === me) {
    const rm = document.createElement("button"); rm.className = "poll-ctlbtn poll-remove"; rm.textContent = "disband";
    rm.addEventListener("click", () => forgetGroup(g));
    ctrls.appendChild(rm);
  }
  if (ctrls.childElementCount) card.appendChild(ctrls);
  return card;
}

function renderGroupCardInto(host: HTMLElement, groupId: string): void {
  const g = groupStore.get(groupId);
  if (!g) {
    const ph = document.createElement("span");
    ph.className = "poll-you";
    ph.textContent = isRetracted("group", groupId) ? "🏛 group disbanded" : "🏛 group unavailable";
    host.appendChild(ph);
    return;
  }
  const card = buildGroupCard(g);
  govCards.set(groupId, card);
  host.appendChild(card);
}

// Add a persistent group-card marker to the transcript (one per group, like a
// poll card) so it replays on reload / tab switch instead of vanishing.
function addGroupCard(g: Group): void {
  if (activeRoom.chatLog.some((l) => l.groupId === g.id)) { refreshGroupCard(g); return; }
  const line: ChatLine = { from: g.creator, text: g.name, kind: "peer", groupId: g.id };
  activeRoom.chatLog.push(line);
  trimChatLog(activeRoom);
  saveChat(activeRoom);
  if (isUiActive()) { renderChatLine(line); messagesEl.scrollTop = messagesEl.scrollHeight; }
  else markUnread(activeRoom);
}

function showGroupCard(g: Group): void {
  setFocusedGroup(g.id);
  if (!isUiActive()) return;
  const existing = govCards.get(g.id);
  if (existing?.isConnected) { refreshGroupCard(g); existing.scrollIntoView?.({ block: "nearest" }); return; }
  addGroupCard(g);
}
function refreshGroupCard(g: Group): void {
  if (!isUiActive()) return;
  const node = govCards.get(g.id);
  if (!node || !node.isConnected) return;
  const fresh = buildGroupCard(g);
  node.replaceWith(fresh);
  govCards.set(g.id, fresh);
}

// A standalone card for one issue: title, group, delegation-weighted result, and
// an open-vote / vote control. Like a poll card, it persists in the transcript.
function buildIssueCard(g: Group, issue: Issue): HTMLElement {
  const me = myPeerId();
  const member = isMember(g, me, dyncapState?.anchor);
  const card = document.createElement("div"); card.className = "gov-card";
  const h = document.createElement("div"); h.className = "gov-title";
  h.textContent = `▸ ${issue.title} `;
  const badge = document.createElement("span"); badge.className = "poll-badge"; badge.textContent = `🏛 ${g.name}`; h.appendChild(badge);
  card.appendChild(h);

  const res = document.createElement("div"); res.className = "poll-you"; res.textContent = issueResultText(g, issue); card.appendChild(res);

  if (member) {
    const myDelegate = g.topicDelegations?.[issue.id]?.[me]?.delegate ?? g.delegations[me]?.delegate;
    const dn = document.createElement("div"); dn.className = "poll-you";
    dn.textContent = myDelegate ? `your vote flows to ${memberLabel(g, myDelegate)} unless you vote` : "you vote directly";
    card.appendChild(dn);
  }

  const ctrls = document.createElement("div"); ctrls.style.marginTop = "0.4rem";
  if (issue.pollId && pollStore.has(issue.pollId)) {
    const v = document.createElement("button"); v.className = "poll-ctlbtn"; v.textContent = "vote";
    v.addEventListener("click", () => { msgInput.value = `/poll vote ${issue.pollId} `; msgInput.focus(); });
    ctrls.appendChild(v);
    const g2 = document.createElement("button"); g2.className = "poll-ctlbtn"; g2.textContent = "🏛 group";
    g2.addEventListener("click", () => showGroupCard(g));
    ctrls.appendChild(g2);
  } else if (member) {
    const o = document.createElement("button"); o.className = "poll-ctlbtn"; o.textContent = "open vote";
    o.addEventListener("click", () => { setFocusedGroup(g.id); msgInput.value = `/gov vote ${issue.title} | `; msgInput.focus(); });
    ctrls.appendChild(o);
  }
  if (ctrls.childElementCount) card.appendChild(ctrls);
  return card;
}

function renderIssueCardInto(host: HTMLElement, groupId: string, issueId: string): void {
  const g = groupStore.get(groupId);
  const issue = g?.issues.find((i) => i.id === issueId);
  if (!g || !issue) {
    const ph = document.createElement("span"); ph.className = "poll-you"; ph.textContent = "▸ issue unavailable";
    host.appendChild(ph); return;
  }
  const card = buildIssueCard(g, issue);
  issueCards.set(issueCardKey(groupId, issueId), card);
  host.appendChild(card);
}

function refreshIssueCard(g: Group, issue: Issue): void {
  if (!isUiActive()) return;
  const node = issueCards.get(issueCardKey(g.id, issue.id));
  if (!node || !node.isConnected) return;
  const fresh = buildIssueCard(g, issue);
  node.replaceWith(fresh);
  issueCards.set(issueCardKey(g.id, issue.id), fresh);
}

// Update any issue card whose vote is this poll (called when the poll changes).
function refreshIssueCardsForPoll(pollId: string): void {
  for (const g of groupStore.values())
    for (const issue of g.issues)
      if (issue.pollId === pollId) refreshIssueCard(g, issue);
}

// Add a persistent issue-card marker to the transcript (one per issue).
function addIssueCard(g: Group, issue: Issue): void {
  if (activeRoom.chatLog.some((l) => l.groupId === g.id && l.issueId === issue.id)) { refreshIssueCard(g, issue); return; }
  const line: ChatLine = { from: g.creator, text: issue.title, kind: "peer", groupId: g.id, issueId: issue.id };
  activeRoom.chatLog.push(line);
  trimChatLog(activeRoom);
  saveChat(activeRoom);
  if (isUiActive()) { renderChatLine(line); messagesEl.scrollTop = messagesEl.scrollHeight; }
  else markUnread(activeRoom);
}

function renderMacros(): void {
  if (!isUiActive() || !macroListEl || !macroCountEl) return;
  macroCountEl.textContent = String(macroStore.size);
  macroListEl.innerHTML = "";
  for (const def of [...macroStore.values()].sort((a, b) => a.name.localeCompare(b.name))) {
    const li = document.createElement("li");
    li.className = "row-item";
    const label = document.createElement("span");
    label.className = "row-label";
    // A rholang macro is not invokable on its own, so it is shown the way it is
    // used — as a `$name(…)` call site inside a program — rather than as `+name`.
    label.textContent = macroCallForm(def);
    label.addEventListener("click", () => {
      msgInput.value = def.kind === "command" ? `+${def.name} ` : `/macro show ${def.name}`;
      msgInput.focus();
    });
    const kindWord = def.kind === "command" ? "a command" : def.kind === "text" ? "a text macro" : "a rholang fragment";
    li.title = `${def.doc || kindWord}\n(by ${def.authorLabel})\n\n${def.body}`;
    li.appendChild(label);
    appendRemoveBtn(li, def.author === myPeerId() ? "retract this command" : "hide from your view", () => forgetMacro(def.name));
    macroListEl.appendChild(li);
  }
}

function renderGroups(): void {
  if (!isUiActive() || !govListEl || !govCountEl) return;
  govCountEl.textContent = String(groupStore.size);
  govListEl.innerHTML = "";
  for (const g of [...groupStore.values()].sort((a, b) => b.createdAt - a.createdAt)) {
    const li = document.createElement("li");
    li.className = "row-item";
    li.style.cssText = "font-size:0.7rem;color:#aaa;padding:0.3rem 0;border-bottom:1px solid #1a1a1a;";
    const label = document.createElement("span");
    label.style.cursor = "pointer"; label.style.flex = "1";
    const open = g.issues.filter((i) => i.status === "open" && i.pollId).length;
    label.textContent = `🏛 ${g.name.slice(0, 22)} (${Object.keys(g.members).length}● ${open}🗳)`;
    label.addEventListener("click", () => showGroupCard(g));
    li.title = `${Object.keys(g.members).length} members · ${g.issues.length} issues`;
    li.appendChild(label);
    appendRemoveBtn(li, g.creator === myPeerId() ? "disband this group" : "hide from your view", () => forgetGroup(g));
    govListEl.appendChild(li);
  }
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

/** Live calls. Built in init, once the toolbar elements exist. */
let calls: Calls;

/** Screen recording. Built in init, once the toolbar button exists. */
let recorder: Recorder;

/** Fetching a library file from whoever holds it. */
let libraryFetch: LibraryFetch;

/** Attachments over the data channel. Built in init alongside calls. */
let attachments: Attachments;

/** The command menu and quick-action toolbar. Built in initUx. */
let palette: Palette;

/** Injected by vite from package.json — see vite.config.ts. */
declare const __APP_VERSION__: string;
/** The commit this bundle was built from, so "are you on the new build?" has an answer. */
declare const __APP_BUILD__: string;

async function init(): Promise<void> {
  // Which build you are looking at, in the corner where nothing else wants the
  // space. A bug report that names a version is worth several that do not.
  if (appVersionEl) appVersionEl.textContent = `version ${__APP_VERSION__} · build ${__APP_BUILD__}`;
  const roomId = getRoomId();

  // The URL-hash room is the first joined room and becomes the active one.
  const firstRoom = createRoom(roomId);
  rooms.set(roomId, firstRoom);
  setActiveRoom(firstRoom);
  // A share link has just been read: take the cap back out of the address bar
  // before anything else can be looking at the screen.
  syncRoomHash();
  updateShareLink();
  uiActiveRoom = firstRoom;

  // Look over the room every so often rather than arming a timer per join: a
  // peer can enter the roster by several paths (a clean join, a rejoin inside
  // the leave grace, a channel opening from their side) and only one of them
  // used to schedule the check — so exactly the peers that were flapping went
  // undiagnosed.
  setInterval(() => {
    for (const ctx of rooms.values()) {
      inRoom(ctx, () => { for (const id of peers) reportUnreachable(id); });
    }
  }, 10_000);

  // Background tabs get throttled/frozen by the browser, which starves WebRTC's
  // keepalive (peers drop) and clamps our reconnect timer (they return only slowly).
  // Kick every room's signaling the instant the tab is visible / focused / back
  // online, so peers reconnect immediately instead of "eventually".
  const wakeAllRooms = (): void => {
    for (const ctx of rooms.values()) ctx.qpeer?.wake();
    // Flash "reconnecting…" so the recovery is visible; renderPeers / onSignalingOpen
    // restore "connected · N peers" as channels reopen (guarded so a real signaling
    // drop isn't masked, and the fallback only clears once signaling is actually up).
    if (qpeer?.isSignalingUp()) {
      setStatus("connecting", "reconnecting…");
      setTimeout(() => { if (qpeer?.isSignalingUp()) setStatus("connected", connectedLabel()); }, 2500);
    }
  };
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") wakeAllRooms(); });
  window.addEventListener("pageshow", wakeAllRooms);
  window.addEventListener("focus", wakeAllRooms);
  window.addEventListener("online", wakeAllRooms);
  // Page Lifecycle: a backgrounded tab on a phone is frozen after a while and
  // resumed on return — a distinct event from visibility on some builds.
  document.addEventListener("resume", wakeAllRooms);
  // Closing the tab is a departure; the server must not hold the seat for a
  // person who has gone. Only a socket that *vanishes* (a phone switching
  // apps, a wifi handoff, a lid) is grace-held and resumed — that case fires
  // no pagehide, or one with `persisted` (the page is kept for a return).
  // Send the leave on the live socket; there is no time to do more.
  window.addEventListener("pagehide", (e) => {
    if (e.persisted) return;
    for (const ctx of rooms.values()) ctx.qpeer?.leave();
  });

  // Restore saved name
  myNameEl.value = myName;
  myNameEl.addEventListener("input", () => {
    myName = myNameEl.value.trim();
    localStorage.setItem("qos-name", myName);
    renderPeers();
    if (qpeer) signedBroadcast({ kind: "name", name: myName });
  });

  await loadZfa();
  await loadDyncap();
  loadLemmas();
  loadLibrary();
  renderLibrary();
  loadNotes();
  loadPolls();
  loadGroups();
  loadMacros();

  // Restore any rooms the user had joined in previous sessions (besides the
  // URL-hash one we already initialised). State for each is loaded from
  // per-room localStorage. The hash-room remains active.
  for (const otherRoomId of loadJoinedRooms()) {
    if (otherRoomId === roomId) continue;
    if (!validateCapability(otherRoomId)) continue;     // skip malformed
    const ctx = createRoom(otherRoomId);
    rooms.set(otherRoomId, ctx);
    loadRoomState(ctx);
  }
  saveJoinedRooms();
  // loadRoomState briefly switched aliases per room during restore; force the
  // UI back to the hash-room's view so the sidebar reflects the active room.
  setActiveRoom(firstRoom);
  renderTabs();
  renderPeers();
  renderLemmas();
  renderLibrary();
  renderNotes();

  // The tab-add button prompts for a cap:room:… URL or token.
  tabAddBtn.addEventListener("click", () => promptJoinRoom());

  const cap = generateCapability("peer");
  myIdEl.textContent = cap;

  connectBtn.addEventListener("click", connect);
  sendBtn.addEventListener("click", send);
  msgInput.addEventListener("keydown", (e) => {
    // A quick action collecting its arguments owns Enter and Esc: the box holds
    // an answer, not a message.
    //
    // Except a command. Somebody who types "/facil help" while a prompt is open
    // is not answering the prompt, and binding it as an argument means their
    // command silently does not run — which reads as the app ignoring Enter.
    // The collection is abandoned and the command goes through.
    if (palette.guiding()) {
      const typedCommand = msgInput.value.trimStart().startsWith("/");
      if (e.key === "Escape") { e.preventDefault(); palette.cancel(); return; }
      if (e.key === "Enter" && !e.shiftKey && typedCommand) {
        palette.cancel();
        // fall through to send(), below
      } else if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault(); palette.submitArg(); return;
      }
    }
    // Only when there is something to pick. A usage hint is not a menu: Enter
    // has to send the line it is a hint about.
    if (palette.isPicking()) {
      if (e.key === "ArrowDown") { e.preventDefault(); palette.move(1); return; }
      if (e.key === "ArrowUp")   { e.preventDefault(); palette.move(-1); return; }
      // Shift+Enter is a continuation, not a completion: let it fall through.
      if ((e.key === "Enter" && !e.shiftKey) || e.key === "Tab") { e.preventDefault(); palette.accept(); return; }
    }
    if (palette.isOpen() && e.key === "Escape") { e.preventDefault(); palette.hide(); return; }
    // Esc drops held lines. The line in the box is left alone — you may well
    // want to keep typing it; it is the earlier lines you are taking back.
    if (e.key === "Escape" && pendingLines.length) { e.preventDefault(); discardPending(); return; }
    // Command menu closed: ArrowUp/Down recall input history (shell-style).
    if (e.key === "ArrowUp"   && navHistory(-1)) { e.preventDefault(); return; }
    if (e.key === "ArrowDown" && navHistory(+1)) { e.preventDefault(); return; }
    // Shift+Enter continues the message on a new line. An <input> cannot hold a
    // newline, so nothing would happen otherwise — the keystroke is ours to use.
    if (e.key === "Enter" && e.shiftKey) { e.preventDefault(); holdLine(false); return; }
    if (e.key === "Enter") send();
  });
  // Mobile keyboard fallback: when input gains focus, scroll it into view.
  // For browsers that honor `interactive-widget=resizes-content` (modern
  // Chrome/Firefox/Safari) this is a no-op; for the rest it ensures the
  // input doesn't end up underneath the soft keyboard.
  msgInput.addEventListener("focus", () => {
    // Defer to next tick so the keyboard has begun to open before we scroll.
    setTimeout(() => msgInput.scrollIntoView({ block: "end", behavior: "smooth" }), 200);
  });
  // Some browsers expose the visualViewport API. When the keyboard opens,
  // visualViewport's height shrinks; re-scroll the input to stay visible.
  if (typeof window !== "undefined" && window.visualViewport) {
    window.visualViewport.addEventListener("resize", () => {
      if (document.activeElement === msgInput) {
        msgInput.scrollIntoView({ block: "end" });
      }
    });
  }

  const qp = new URLSearchParams(window.location.search);
  const sig = qp.get("signal");
  if (sig) {
    signalUrlEl.value = sig;
    activeRoom.signalingUrl = sig;
  } else {
    signalUrlEl.value = activeRoom.signalingUrl;
  }
  signalUrlEl.addEventListener("change", () => {
    activeRoom.signalingUrl = signalUrlEl.value.trim() || DEFAULT_SIGNAL;
  });

  // Keep the sidebar visible on narrow screens until the user connects, so
  // the Connect button is reachable without finding the hamburger toggle.
  toggleSidebar(true);

  // Self-evident UI: quick-action toolbar + command palette.
  initUx();

  // Restore the saved transcript, or show the onboarding welcome on a fresh room.
  if (activeRoom.chatLog.length > 0) {
    for (const line of activeRoom.chatLog) renderChatLine(line);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  } else {
    showWelcome();
  }
}

/**
 * A startup failure used to be invisible: `init` is async, nothing awaited it,
 * so a throw became an unhandled rejection and every line after the throw —
 * including the `connectBtn` listener — simply never ran. The button rendered
 * and did nothing, with no clue anywhere but a devtools console nobody had open.
 *
 * Report it in the page instead. This deliberately touches the DOM directly
 * rather than going through `addMessage`/`renderChatLine`: init may have died
 * before the state those depend on exists.
 */
init().catch((err: unknown) => {
  const detail = err instanceof Error ? err.message : String(err);
  console.error("[quantum-os] startup failed:", err);
  try {
    setStatus("disconnected", "startup failed");
  } catch { /* status bar may not be wired yet */ }
  try {
    const box = document.createElement("div");
    box.className = "msg system-line";
    const who = document.createElement("span");
    who.className = "from system";
    who.textContent = "·";
    const what = document.createElement("span");
    what.className = "text";
    what.textContent = `quantum-os failed to start: ${detail}`;
    box.appendChild(who);
    box.appendChild(what);
    messagesEl.appendChild(box);
  } catch {
    // Even the chat pane is unavailable — the console line above is all we have.
  }
});
