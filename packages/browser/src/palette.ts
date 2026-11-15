// palette.ts — what commands exist, and the UI that offers them.
//
// The catalogue and the menu belong together: `SLASH_COMMANDS` is what the
// autocomplete matches against, `CMD_HELP` is what `/help <command>` prints, and
// `QUICK_ACTIONS` is the toolbar above the input. All three answer the same
// question — what can be typed here — and drift apart when they live apart.
//
// app.ts keeps the input element and the command dispatcher; this keeps what
// they offer.

// Per-command detailed help, shown by `/help <command>`. Keep each entry to a
// few scannable lines: syntax, key subcommands, and a short note/example.
export const CMD_HELP: Record<string, string[]> = {
  help: ["/help — list all commands.", "/help <command> — detailed help for one command (e.g. /help note)."],
  id: ["/id — show your peer ID and its ZFA proof (twist counts, spectral gap)."],
  name: ["/name <your name> — set the display name peers see in chat and the roster (same as the name field at the top).",
         "/name — with no argument, shows your current name.",
         "Your name is broadcast to peers (a signed `name` envelope) so they relabel you; it persists on this browser."],
  password: ["/password — encrypt your identity (the dyncap seed behind your anchor) under a password and get a qos-vault:v1:… recovery string.",
             "Prompts for the password in a masked dialog — it never enters the chat. Keeps your current anchor, so restoring it elsewhere is still you.",
             "If you're in any groups, it also replicates the encrypted vault into them (pure p2p) under your display-name handle — so you can recover with just /login <handle> after rejoining, no string to carry.",
             "/password show — re-display the recovery string saved on this browser.",
             "The vault is ciphertext (safe for peers to hold); only your password decrypts it. Don't run the same identity live in two browsers at once (it forks)."],
  login: ["/login <handle> — restore a former identity from the encrypted vault replicated in a group you've rejoined (pure p2p, no blob to carry). Prompts only for the password.",
          "/login — restore from a recovery string instead: paste your qos-vault:v1:… string (or leave blank to use this browser's saved one) + password.",
          "On success your seed/anchor and display name are restored, your group membership is re-linked to the restored identity, and it's re-announced so peers recognize you again. Wrong password fails cleanly with no change."],
  cap: ["/cap [label] — mint a new random ZFA capability token, local only (not broadcast).", "e.g. /cap alice-read"],
  grant: ["/grant [label] — mint a ZFA capability token AND broadcast it to the room.", "e.g. /grant moderator"],
  record: ["/record — start recording your screen with audio; /record again (or the ⏹ button) stops and saves it.",
           "Records what is on your screen, so it keeps whatever you had up — call tiles, chat, another window — and needs no call in progress.",
           "Audio: your mic, plus the tab's audio if you tick “Share tab audio” in the picker — that is what captures the other voices in the room.",
           "Saved as a .webm download (15 fps, ~540 MB/hour). The room is told when you start and stop."],
  file: ["/file add — pick files: each is hashed, its bytes kept in this browser, and an entry announced to the room.",
         "/file list [--mine|--here] — what the room has: ● you hold it · ◉ a peer here holds it · ○ no holder present · ⚠ none seen in a week.",
         "/file holders <hash|name> — who has these bytes right now, and when a holder was last seen if nobody does.",
         "/file get <hash|name> — fetch it from a holder: asked of one peer, written as it arrives, and verified against its hash before it is kept (up to 64 MB). /file cancel gives up.",
         "/file drop <hash|name> — stop holding the bytes; the entry stays, because what the room has and what you keep are different facts.",
         "/file forget <hash|name> — retract the entry: for everyone if you added it, from your view otherwise.",
         "A file's name IS its content hash, so adding the same file twice is one entry and a copy from anyone is verifiable. Fetching from another peer comes next (#100); today the index is the useful part."],
  conn: ["/conn — every peer connection with its channel, connection and ICE state. The room already says this by itself when a peer will not connect; this is for looking before that, or at everyone at once.",
         "channel open is the only state that means you can talk. ice 'checking' that never ends means candidates that never pair; 'failed' means no path at all (/ice test); connected-with-no-channel is a different fault again.",
         "Local only — nothing is broadcast."],
  reset: ["/reset — give this browser a fresh peer ID and forget which dyncap anchors it has seen, then reload. Identity, name, groups and vault are kept.",
          "For when peers show you as a bare hex id, or ⚠ / contested, after a /login recovery or a half-cleared storage — a fresh peer ID lets everyone re-recognise you cleanly.",
          "/reset identity — the harder version: a brand-new dyncap seed too, so you rejoin as a different person. Room content (lemmas, notes, polls) is untouched either way. Local only, asks first."],
  version: ["/version — the build this browser is running, the signaling server and rnode it is pointed at, and whether WebRTC exists here.",
            "The first question of any connection puzzle is whether everyone is on the same build; this is how it gets answered without opening the sidebar."],
  ice: ["/ice last — show the last test result again; it is kept on this device, so whatever closed it does not lose it.",
        "/ice test — what your network actually allows: host (same LAN), srflx (STUN answered), relay (a TURN server is available).",
        "/ice list — the servers a connection may use. /ice turn turn:host:3478 <user> <pass> adds your own relay instead; /ice stun stun:host:3478 adds a STUN server; /ice reset restores the default.",
        "Why it matters: STUN only tells each side its public address — the connection is still direct. Two peers behind symmetric NAT (corporate networks, mobile CGNAT, a NAT'd container) have no address pair that works, so the handshake fails permanently and no amount of retrying helps. Chat can survive this over the room's relay overlay; a call cannot — a MediaStreamTrack can't flood the same way, so without a relay two networks means no video, silently.",
        "/ice auto on|off — by default a short-lived, Cloudflare-minted TURN credential is fetched fresh from the signaling server at every connect, so calls across networks work out of the box. /ice auto off opts out (whose machine your media passes through is still your call); /ice turn substitutes your own relay instead.",
        "/ice is local: its output is never broadcast, because a TURN entry carries a username and password.",
        "Reconnect (Disconnect, then Connect) after changing any of this."],
  zfa: ["/zfa <token> — validate a cap:label:hex capability; shows ZFA balance, spectral gap, twist counts."],
  braket: ["/braket <state> [state …] — evaluate bra-ket states as 2×2 density matrices.", "states: 0 1 + - i -i  (space-separated = superposition).", "e.g. /braket 0 1   ·   /braket -i"],
  qucalc: ["/qucalc [twists | @name | cap:token] — evaluate a RhoQuCalc twist sequence's ZFA balance.", "twists: symbolic ^v<>/\\+- or hex 0-7; compose lemmas with @name (or @[multi word]).", "e.g. /qucalc +-+-   ·   /qucalc @major @minor"],
  conj: ["/conj <twists> — Hermitian adjoint (reverse + parity-flip); flags self-adjoint inputs.", "Identity: E + E† ≡ ZFA. Accepts @name and cap:token too."],
  freq: ["/freq [n | twists] — ZFA frequency spectrum; C(2n,n) arrangements at level n (the 2:1 harmonic ladder)."],
  "qlf-action": ["/qlf-action <twists> — propose a QuCalc history string for the room to verify.", "The collaborative-study surface over the ZFA kernel; broadcast for /zfa-check.", "e.g. /qlf-action ^v<>/\\+-"],
  "zfa-check": ["/zfa-check <twists> — verify ZFA closure locally: is_zfa = is_count_balanced ∧ is_pauli_closed.", "Each peer runs its own kernel; no trusted evaluator. e.g. /zfa-check ^v^v"],
  coupling: ["/coupling [<twists> …] — classify a joint closure: independent, product, or coupled.",
             "No arguments cuts the room along what peers proposed with /qlf-action, one part each.",
             "Coupled means only the join closes — a shared closure, not two side by side.",
             "Sector counts are the QLF census's; baseline 80.3% coupled. e.g. /coupling ^ v"],
  search: ["/search [position] — the admissible next closures from a QuCalc position, computed in your browser (no service).",
           "The search is the experiment — truth divination: it asks the substrate which a-priori possibilities close from here (truth is what closes).",
           "No position cuts the room along peers' /qlf-action proposals — one enumeration, shared listeners, a meeting of minds.",
           "Each discovered event becomes a room lemma, integer-named in discovery order (@1, @2, …), so a re-run finds them already known. --no-save opts out; --save-cap N raises the ceiling (default 32).",
           "Position: symbolic ^v<>/\\+-, @lemma, or cap:token. Flags: --depth N · --limit N · --events|--possibilities · --full · --no-save · --save-cap N.",
           "Result is broadcast (the room's shared experiment). A port of quantum-logical-framework's qucalc_search.py, run in a Web Worker — every peer computes the same closures from the same algebra."],
  solve: ["/solve [position] — pick the one closure the substrate takes from a position, and hand you that path.",
          "The complement of /search: search renders every way to close (the experiment); solve selects one (least free action).",
          "Cascade: min peak excursion → min depth → phase +1 → lexicographic — deterministic, so every peer computes the same path.",
          "Widens the search horizon until something closes; if nothing does within depth 7, reports the residual action vector still owed.",
          "Position: symbolic ^v<>/\\+-, @lemma, cap:token, or none (the room's joined /qlf-action proposals). --all shows the ranked shortlist; --no-save skips the lemma. The chosen path is saved as an integer-named lemma and broadcast."],
  estimate: ["/estimate new <question> — open a robust group numeric estimate (median by default).",
             "/estimate <number> — submit your estimate · /estimate status — median + IQR · /estimate close.",
             "--mean for the mean tally; median is whale/outlier-resistant. Used by gov-9stage & colab-study."],
  dump: ["/dump — summary of all logic shared this session."],
  lemma: ["/lemma — list named lemmas.",
    "/lemma <claim> [| <twists>] — register a claim. Mark one word as the handle with @:",
    "  /lemma All men are @mortal   →  name @mortal, claim “All men are mortal”",
    "  /lemma @concl Socrates is mortal | @mortal @man   →  explicit twists composed from refs",
    "A bare multi-word name works too (/lemma socrates is a man → @[socrates is a man]); so does the old /lemma [name] twists.",
    "Twists (after |, or legacy space form): symbolic ^v<>/\\+- · hex 0-7 · cap:token · @ref1 @ref2. Omitted → auto-allocated from the handle."],
  request: ["/request <name> — broadcast that you need @name; whoever holds it sees a /pass prompt."],
  pass: ["/pass <name> <peer> — transfer a lemma @name directly to a named peer (removed from yours).", "multi-word: /pass [name with spaces] Alice"],
  note: ["/note [list] — held notes / currencies / receipts.   /note balance [currency]",
         "/note declare <currency> — issue a currency.",
         "/note grant <cur> <N> [| terms] — mint a denomination-N note; with terms → a stamped series cap:note-cur~hash.",
         "/note pass <cur> <N> <peer> · redeem <cur> <N> <issuer> · split <token> <a> · merge <t1> <t2>",
         "/note terms <cur[~hash]> · accept <cur~hash> — terms must be accepted before redeeming."],
  poll: ["/poll new <q> [| seed1, seed2] [ranked] — open a poll (approval or ranked-choice IRV); no seeds = open nominations.",
         "/poll add <option> · vote [id] <choices> · lock · close · status · remove · list",
         "ranked vote uses >, e.g. /poll vote pizza > salad > tacos"],
  forget: ["/forget <poll <id> | lemma <name> | note <token|cur denom> | group <name>> — remove an item.",
           "poll/lemma/group: the owner retracts for everyone (tombstoned, won't re-sync back); others hide it locally.",
           "note: deletes a held note (destroys its value, confirm required)."],
  gov: ["/gov new <name> · show <name> · list — liquid-democracy groups.",
        "/gov member add|remove <peer> [admin] · issue <title>",
        "/gov uri [rho:id:…] — show the group's on-chain record, or (admin) record where it was deployed; every member gets it and /rholang read fetches it.",
        "/gov locker [rho:id:…] — show, or (admin) record, the locker the group shares. A member with no locker of their own then reaches the group's automatically.",
        "/gov delegate <member> [on <issue>] · undelegate [on <issue>] — your vote flows to your delegate unless you vote (per-issue overrides global).",
        "/gov trust <member> <0-5> — confer a trust level BELOW your own (0 clears); admins are the root (5), vote weight = 1 + level (liquid trust).",
        "/gov censure <member> · uncensure <member> — flag undeserved trust; a ⅔ quorum of eligible censurers (min 2, even over an admin) discredits the target and slashes their vouchers.",
        "/gov vote <issue> | opt1, opt2 [ranked] — opens a delegation- and trust-weighted poll bound to the issue.",
        "/gov treasury declare|grant <m> <n>|balance · kudos <m> <n>|balance · say <msg> · status",
        "full reference: Governance.md"],
  rdv: ["/rdv swap <giveCur> <giveN> <getCur> <getN> <peer> — propose an atomic N-party swap (all-or-nothing).",
        "/rdv accept <id> · reject <id> · abort <id> · counter <id> <giveCur> <giveN> <getCur> <getN> · list"],
  dyncap: ["/dyncap status — your anchor / current seq / chain depth.", "/dyncap peers — all peers' anchors and seq depths (fork/contested flags)."],
  probe: ["/probe status — discrepancy-probe window state + ignored-for-sync peers.", "/probe clear — clear the ignored-for-sync list. (The probe runs automatically on join.)"],
  room: ["/room list · join <cap|url> · leave · ref — multi-room tabs (each room is a separate ZFA process).",
         "/room hide | show — keep the room capability out of the address bar, the share row and the sidebar, or put it back.",
         "Hidden is the default: reading a room cap IS joining it, and the address bar is in every screen share, screenshot and recording.",
         "Hiding loses nothing — joined rooms come back as tabs, copy still puts the link on your clipboard, and /room ref prints it."],
  share: ["/share <selector> to <room> — bridge an item into another joined room.", "selectors: @lemma · msg <text> · note <cur> <N>"],
  channel: ["/channel listen <name> · unlisten <name> · send <name> <text> · list — tagged broadcast messages (per-room subscriptions).",
            "/channel chain open <name> [invite] · post <name> <text> · subscribe <address/name> [--all] · read <address/name> · close · allow|disallow <name> <address> [--write] · info · list · install|use <uri> — a channel on chain, which outlives the room."],
  facil: ["/facil [help|ask <question>|off|on] — relayed to facilitator daemon(s) in the room.", "The browser does NOT run facilitation and does not vouch for any facilitator — it only forwards the command. Each facilitator answers for ITSELF; trust its self-description only, judge it by its own (signed-name) replies, and note more than one may be present (or none).", "Typical: /facil (present?) · /facil help (it describes itself) · /facil ask <q> (brief AI answer, if it runs --ai) · /facil off|on (mute/unmute)."],
  script: ["/script <c1>; <c2>; … — run a sequential command chain; // skips a segment."],
  persist: ["/persist <@lemma | currency <name>> to <peer> — ask a peer to also hold your public state for redundancy.", "/persist accept <id> · reject <id> · list"],
  rhoqu: ["/rhoqu <source> — RhoQu macro language: process / new / | parallel / if / on channel / call → /commands.", "/rhoqu list · clear — manage registered on-channel handlers."],
  rholang: [
    "/rholang eval — run a rholang program on rnode and read the result back. Nothing is signed, nothing stored, no block.",
    "Both verbs open the same editor and it offers all three actions: Echo (shows what would be sent, sends nothing), Evaluate (Ctrl+Enter) or Sign and deploy (Ctrl+Shift+Enter). The verb you typed only decides which is the blue button.",
    "/rholang deploy — sign the program with your browser-held secp256k1 key and submit it. Costs phlo; lands in a block; outlives the room.",
    "/rholang status — rnode's version, network, shard, height and phlo floor. Warns when your shard does not match rnode's.",
    "eval and deploy open a syntax-highlighted editor (Ctrl+Enter runs, Esc cancels) that can load a .rho from disk, accept one dropped on it, and save the program back out. It keeps your last program so you can iterate on it, and Clear empties it. A program written inline — /rholang eval return!(42) — runs as typed.",
    "A deploy writes what it answered to your own registry slot — the uri your key derives, which only your key can write to. /rholang read collects it; /rholang nonce re-syncs the write counter if a second browser used the same key.",
    "/rholang locker — where the locker is; `locker <uri>` points at one, `locker install` publishes one at the uri your key derives (so it needs no reading back).",
    "/rholang register — create your identity record in the locker, anchored to your REV address. It is also the write that lets later lookups answer.",
    "/rholang bind <name> <uri> — name a capability so it outlives the room; resolve <name> reads it back; record shows your whole record; grant <name> mints a write-only capability for that one name.",
    "Each locker verb is its own deploy — rho:rchain:deployerId exists only inside a deploy, and that identity is what the locker keys on, so nobody can reach another identity's entry.",
    "/rholang macros — the approved capability macro library (grant · ballot · directory · mailbox · group · delegate · transfer · swap · philosophers · multisig); /rholang macro <name> <args…> runs one on its own.",
    "A program's macro call sites expand before it is linted or signed: %name(…) from that library, $name(…) from what this room defined with /macro. /rholang echo shows the result.",
    "Configure with /rholang rnode <url> · shard <id> · phlo <limit> [price] · key generate|<hex>|show|forget · config to show it all.",
    "eval runs read-only over finalized state; pure rholang and the qucalc powerbox both return values there. It cannot reach a deploy's own identity — rho:rchain:deployId and deployerId are unbound, since an exploratory deploy is not a deploy.",
  ],
  macro: [
    "Write a command. `/` is what the app ships; `+` is what somebody here wrote.",
    "/macro define name body   —  or   /macro define name(arg, …) body   — body is the rest of the line, or the lines below (Shift+Enter). An optional `// note` after the signature is its doc.",
    "A body of slash/`+` commands makes a +command:  /macro define standup(topic) ⏎ /poll new $topic | yes, no ⏎ /gov say standup on $topic",
    "Then anyone in the room runs it: +standup \"Q4 budget\"  (quotes group an argument; topic=… names one).",
    "A body of rholang makes a fragment — call it as $name(…) inside /rholang eval or deploy, where its arguments stay rholang terms. A body of plain text makes a text macro — $name just yields its body.",
    "A bare $name line for one of your macros SHOWS what it expands to (it never runs on its own); /rholang eval $name(…) or /rholang deploy $name(…) run it.",
    "/macro edit <name>[(args)] opens the rholang editor to write or rewrite the body.",
    "/macro list — what this room has · show <name> — the definition as typed · find [pattern] — search names, docs and bodies · echo <name> [args] — what it expands to, running nothing.",
    "Definitions are room state: signed, shared with everyone here, and replayed to whoever joins next. First writer wins a name, and only that author can redefine or retract it.",
    "/forget macro <name> (or the ✕ in Commands) retracts yours for everyone, and hides anyone else's from your view.",
  ],
};

export interface SlashCmd { name: string; template: string; desc: string }
export const SLASH_COMMANDS: SlashCmd[] = [
  { name: "help",    template: "/help",       desc: "show all commands" },
  { name: "rholang", template: "/rholang ",    desc: "run rholang on rnode: eval · deploy · status" },
  { name: "macro",   template: "/macro ",      desc: "write a +command: define · list · show · find · echo" },
  { name: "id",      template: "/id",         desc: "your peer ID and ZFA proof" },
  { name: "password", template: "/password",  desc: "password-protect your identity (+ publish to groups)" },
  { name: "login",   template: "/login ",     desc: "restore identity: /login <handle> (from group) or paste a string" },
  { name: "cap",     template: "/cap ",       desc: "generate a new ZFA capability" },
  { name: "grant",   template: "/grant ",     desc: "generate + share a capability token" },
  { name: "zfa",     template: "/zfa ",       desc: "validate a capability token" },
  { name: "braket",  template: "/braket ",    desc: "evaluate bra-ket (0 1 + - i -i)" },
  { name: "record",  template: "/record",     desc: "record your screen with audio" },
  { name: "file",    template: "/file ",      desc: "the room's library: add · list · drop · forget" },
  { name: "ice",     template: "/ice ",       desc: "how peers connect: list · auto · test · turn · stun · reset" },
  { name: "version", template: "/version",    desc: "which build this is, and what it is pointed at" },
  { name: "conn",    template: "/conn",       desc: "what each peer connection is actually doing" },
  { name: "reset",   template: "/reset",      desc: "fresh peer ID for this browser when peers show you contested / as a hex id" },
  { name: "qucalc",  template: "/qucalc ",    desc: "evaluate a RhoQuCalc twist sequence" },
  { name: "conj",    template: "/conj ",      desc: "Hermitian adjoint of a twist sequence" },
  { name: "freq",    template: "/freq ",      desc: "ZFA frequency spectrum / C(2n,n)" },
  { name: "coupling", template: "/coupling ", desc: "shared closure, or several side by side?" },
  { name: "dump",    template: "/dump",       desc: "summary of logic shared this session" },
  { name: "lemma",   template: "/lemma ",     desc: "register / list named lemmas" },
  { name: "request", template: "/request ",   desc: "request a lemma from its holder" },
  { name: "pass",    template: "/pass ",      desc: "transfer a lemma to a named peer" },
  { name: "note",    template: "/note ",      desc: "promissory notes (grant|pass|redeem…)" },
  { name: "rdv",     template: "/rdv ",       desc: "atomic n-party swap (swap|accept…)" },
  { name: "poll",    template: "/poll ",      desc: "group vote (approval / ranked-choice)" },
  { name: "forget",  template: "/forget ",    desc: "remove a poll / lemma / note / group" },
  { name: "gov",     template: "/gov ",       desc: "liquid-democracy groups + delegated voting" },
  { name: "dyncap",  template: "/dyncap ",    desc: "dynamic capabilities (status|peers)" },
  { name: "probe",   template: "/probe ",     desc: "consensus discrepancy probe" },
  { name: "room",    template: "/room ",      desc: "multi-room tabs (list|join|leave)" },
  { name: "share",   template: "/share ",     desc: "bridge a lemma/note into another room" },
  { name: "channel", template: "/channel ",   desc: "tagged messages (listen|send|list)" },
  { name: "render",  template: "/render",     desc: "animate this room (perspectives, closures, groups)" },
  { name: "facil",   template: "/facil ",     desc: "ask/control the room facilitator (help|off|on)" },
  { name: "script",  template: "/script ",    desc: "run a sequential command chain" },
  { name: "persist", template: "/persist ",   desc: "agreed replication of public state" },
  { name: "rhoqu",   template: "/rhoqu ",     desc: "RhoQu macro → commands" },
];

/**
 * The toolbar.
 *
 * It is not a shortcut list — a shortcut list wants to be complete, and a
 * complete one is what it used to be: nine buttons, most of them a primitive
 * you reach for once you already know what you are doing. `⌘ Commands` and
 * `/help` are the complete list, and they are better at it.
 *
 * What is left answers the two questions someone actually has in front of a
 * room: **what are we deciding**, and **how do I get set up**. Rholang leads
 * because it is the thing here that outlives the room; `Next step` closes
 * because setup is a sequence, and a sequence wants an order, not nine peers.
 */
interface ArgSpec {
  /** What to ask for, in the second person. */
  prompt: string;
  /** A real example, not a placeholder — it is what people copy. */
  example?: string;
  /** Empty is an answer: skip it and run without. */
  optional?: boolean;
  /** What goes between the command so far and this argument. */
  join?: string;
}

interface QuickAction {
  label: string;
  ico: string;
  /** `command` builds and runs a line; `fill` drops `cmd` into the input and
   *  leaves it there to finish typing (no guided prompt, no auto-run — for a
   *  free-text tail like a question); the rest hand off. */
  kind: "command" | "call" | "record" | "commands" | "next" | "fill";
  /** The command up to its first argument, e.g. "/poll new". */
  cmd?: string;
  /** Asked for one at a time. A command with none simply runs. */
  args?: ArgSpec[];
  hint?: string;
  /** Heading this entry sits under, in a menu that has sections. */
  section?: string;
}

/**
 * `Other` — what does not earn a button but should not need /help to find.
 *
 * Sectioned, because it holds unlike things: what a group does, which is
 * ongoing; getting set up, which is a sequence you do once; and reaching a
 * chain, which most rooms never do at all. A flat list makes each look like
 * more of the one before it — and putting an rnode and a signing key in a
 * "getting set up" list says a chain is required, when a room is whole without
 * one. Peers, decisions, notes and groups need no rnode, no key and no phlo.
 */
const OTHER_ACTIONS: QuickAction[] = [
  { label: "Groups", ico: "🏛", kind: "command", cmd: "/gov", section: "Group",
    hint: "the groups in this room, and the one you are focused on — members, issues, delegation, trust" },
  { label: "Start a group", ico: "⚖", kind: "command", cmd: "/gov new", section: "Group",
    args: [{ prompt: "What is the group called?", example: "Steering" }],
    hint: "members, issues, delegated voting" },
  { label: "Rate a member's trust", ico: "★", kind: "command", cmd: "/gov trust", section: "Group",
    args: [
      { prompt: "Which member?", example: "Ann" },
      { prompt: "How far do you trust them, 0–5? You can confer at most one level below your own",
        example: "3" },
    ],
    hint: "trust weights their vote — and is staked: a ⅔ censure quorum slashes whoever vouched" },
  { label: "Mint a note", ico: "$", kind: "command", cmd: "/note grant", section: "Value",
    args: [
      { prompt: "Which currency?", example: "USD" },
      { prompt: "How much?", example: "10" },
      { prompt: "Terms & conditions, or blank for none", example: "redeemable until Friday",
        optional: true, join: " | " },
    ],
    hint: "a bearer note in a currency you issue — terms make it its own series" },

  { label: "Say who you are", ico: "🙂", kind: "command", cmd: "/name", section: "Getting set up",
    args: [{ prompt: "What should the room call you?", example: "Jim" }],
    hint: "your display name, so peers see a person and not a hex id" },
  { label: "Protect your identity", ico: "🔐", kind: "command", cmd: "/password", section: "Getting set up",
    hint: "encrypt your identity under a password so you can come back as you" },
  { label: "Log in as someone you already are", ico: "🔑", kind: "command", cmd: "/login",
    section: "Getting set up",
    args: [{ prompt: "Which handle? (blank to paste a recovery string instead)", example: "jim", optional: true }],
    hint: "restore an identity from a group you have rejoined" },
  { label: "Show the invite link", ico: "✉", kind: "command", cmd: "/room ref", section: "Getting set up",
    hint: "prints the room URL into the transcript — it is a capability, so only do this on a screen you trust" },
  { label: "Reset this browser's peer ID", ico: "♻", kind: "command", cmd: "/reset", section: "Getting set up",
    hint: "a fresh peer ID (identity, name and groups kept) for when others show you as a hex id or ⚠ after an identity change — asks first, then reloads" },
  { label: "What can I type?", ico: "?", kind: "command", cmd: "/help", section: "Getting set up",
    hint: "every command, with per-command detail behind /help <command>" },

  // Last, and named so it reads as a branch rather than a next step. A room is
  // whole without a chain: peers, decisions, notes and groups all work with no
  // rnode, no key and no phlo. A chain is for the part you want to outlive the
  // room, and most rooms never need it.
  { label: "Point at an rnode", ico: "🔗", kind: "command", cmd: "/rholang rnode", section: "If you use a chain",
    args: [{ prompt: "Which rnode? (the playground is the default)", example: "https://rnodeapi.rhobot.net" }],
    hint: "where /rholang eval and deploy send programs — nothing else in the app needs an rnode" },
  { label: "Make a signing key", ico: "🗝", kind: "command", cmd: "/rholang key generate",
    section: "If you use a chain",
    hint: "a secp256k1 key held in this browser, wrapped by a passphrase — only a deploy needs one" },
  { label: "Claim your locker record", ico: "📇", kind: "command", cmd: "/rholang register",
    section: "If you use a chain",
    hint: "the on-chain record that makes later lookups answer" },
  { label: "Record where a group lives on chain", ico: "📇", kind: "command", cmd: "/gov uri",
    section: "If you use a chain",
    args: [{ prompt: "Which registry URI? (blank to see the one recorded)",
             example: "rho:id:…", optional: true }],
    hint: "a room is ephemeral and a registry entry is not — an admin records where the group was deployed" },
];

const QUICK_ACTIONS: QuickAction[] = [
  { label: "Ask", ico: "🙋", kind: "fill", cmd: "/facil ask ",
    hint: "drops /facil ask into the box — finish typing your question and send it. "
        + "The room's facilitator agent (if one is present) answers in chat" },
  { label: "Call", ico: "📞", kind: "call", hint: "start or leave a call" },
  { label: "Record", ico: "⏺", kind: "record", hint: "record your screen with audio" },
  { label: "Rholang", ico: "⛓", kind: "command", cmd: "/rholang eval",
    hint: "write rholang and run it on an rnode — the editor offers Echo, Evaluate and Sign-and-deploy, "
        + "so the choice is made once you can see the program. Needs an rnode: Other ▸ If you use a chain. "
        + "Nothing else in the room does" },
  { label: "Poll", ico: "🗳", kind: "command", cmd: "/poll new",
    args: [
      { prompt: "What are you deciding?", example: "Lunch — pizza, burgers or salad?" },
      { prompt: "Options, comma-separated — or blank, and let people add their own",
        example: "pizza, burgers, salad", optional: true, join: " | " },
    ],
    hint: "a group decision: approval or ranked-choice, tallied the same way on every peer" },
  { label: "Estimate", ico: "📊", kind: "command", cmd: "/estimate new",
    args: [{ prompt: "What are you estimating?", example: "How many hours to finish the deploy?" }],
    hint: "a group number — median and spread, so one confident outlier cannot swing it" },
  { label: "Commands", ico: "⌘", kind: "commands", hint: "every command there is" },
  { label: "Other", ico: "▾", kind: "next", hint: "notes, and getting set up" },
];

// ---------------------------------------------------------------------------
// The menu
// ---------------------------------------------------------------------------

export interface PaletteHost {
  /** The message box, which the palette fills in and focuses. */
  input: HTMLInputElement;
  /** Put a line in the transcript — a quick action's hint. */
  say(text: string): void;
  /** The Call action, which belongs to calls.ts rather than here. */
  toggleCall(): void;
  /** The Record action, which belongs to record.ts. */
  toggleRecord(): void;
  /** Run a finished command line, exactly as if it had been typed. */
  run(text: string): void;
}

export interface Palette {
  /** Build the quick-action toolbar into `row`. */
  mountActions(row: HTMLElement | null): void;
  isOpen(): boolean;
  /** The panel was touched a moment ago, so a blur is that touch, not a dismissal. */
  justTouched(): boolean;
  /**
   * The menu is showing something selectable. The usage strip is not: it is a
   * hint about the line you are typing, and Enter must still send that line.
   */
  isPicking(): boolean;
  hide(): void;
  /** The input changed: open on a bare command word, close otherwise. */
  onInput(value: string): void;
  /** Move the selection by `delta`, wrapping. */
  move(delta: number): void;
  /** Take the highlighted entry, or the first if none is highlighted. */
  accept(): void;
  /** A quick action is collecting its arguments. */
  guiding(): boolean;
  /** Take what is in the box as the current argument, and ask for the next. */
  submitArg(): void;
  /** Abandon the collection, leaving nothing behind. */
  cancel(): void;
}

export function createPalette(host: PaletteHost, menu: HTMLElement | null): Palette {
  let sel = -1;
  let matches: SlashCmd[] = [];
  /** The action currently asking for arguments, if any. */
  let guide: { action: QuickAction; parts: string[]; at: number } | null = null;
  /** The box's own placeholder, borrowed while collecting an argument. */
  const PLACEHOLDER = host.input.placeholder;
  /**
   * When the panel itself was last touched.
   *
   * The panel is dismissed on the input losing focus, and touching the panel is
   * how the input loses focus — so on a phone, where touching is the only way
   * to interact, reading what it says dismisses it. The menu's own items work
   * around this by cancelling mousedown, which the usage hint cannot do without
   * also making its text unselectable — and text you cannot select is text you
   * cannot paste to whoever is helping you.
   */
  let touchedAt = 0;
  menu?.addEventListener("pointerdown", () => { touchedAt = Date.now(); });

  const isOpen = () => !!menu && !menu.hidden;
  const hide = () => {
    // While an action is collecting arguments the panel IS the menu, and blur
    // fires on every click in the room — so hiding has to leave it alone.
    if (guide) return;
    if (menu) menu.hidden = true;
    sel = -1;
  };

  /**
   * A menu you browse (the command list, Other) has no visible way to close it
   * — clicking anywhere outside does dismiss it (blur), but nothing says so,
   * and the menu itself can cover most of the transcript on a short screen
   * ("clicking elsewhere works but it's not obvious" — reported live). One
   * sticky ✕, pinned to the top of the box regardless of scroll, fixes that
   * without restructuring the menu into a separate scroll container.
   */
  function addCloseBar(): void {
    if (!menu) return;
    const bar = document.createElement("div");
    bar.className = "cmd-menu-close";
    const x = document.createElement("button");
    x.type = "button"; x.textContent = "✕"; x.title = "close";
    // mousedown, not click: blur fires first on the input and would hide the
    // menu (and clear `guide`/`sel` state) before this handler ever ran.
    x.addEventListener("mousedown", (e) => { e.preventDefault(); hide(); });
    bar.appendChild(x);
    menu.appendChild(bar);
  }

  function apply(c: SlashCmd): void {
    host.input.value = c.template;
    hide();
    host.input.focus();
  }

  /** Ask for the argument we are on, showing what has been answered already. */
  function paintGuide(): void {
    if (!menu || !guide) return;
    const { action, parts, at } = guide;
    const spec = action.args![at];
    menu.innerHTML = "";
    const box = document.createElement("div");
    box.className = "cmd-guide";

    const head = document.createElement("div");
    head.className = "guide-head";
    head.textContent = `${action.ico}  ${action.label}`;
    box.appendChild(head);

    // What the command looks like so far — the point is that the person can
    // see the line being built rather than trusting a form.
    const so = document.createElement("div");
    so.className = "guide-line";
    so.textContent = [action.cmd, ...parts].join(" ") + " …";
    box.appendChild(so);

    const ask = document.createElement("div");
    ask.className = "guide-ask";
    ask.textContent = spec.prompt;
    box.appendChild(ask);

    if (spec.example) {
      const eg = document.createElement("div");
      eg.className = "guide-eg";
      eg.textContent = `e.g. ${spec.example}`;
      box.appendChild(eg);
    }

    const keys = document.createElement("div");
    keys.className = "guide-keys";
    keys.textContent = spec.optional
      ? "Enter to continue · Enter on an empty box to skip · Esc to cancel"
      : "Enter to continue · Esc to cancel";
    box.appendChild(keys);

    menu.appendChild(box);
    menu.hidden = false;
  }

  /** Start an action: collect what it needs, or just run it. */
  function begin(action: QuickAction): void {
    guide = null;
    hide();
    if (!action.args?.length) {
      if (action.hint) host.say(action.hint);
      host.run(action.cmd!);
      return;
    }
    guide = { action, parts: [], at: 0 };
    host.input.value = "";
    host.input.placeholder = action.args[0].prompt;
    if (action.hint) host.say(action.hint);
    paintGuide();
    host.input.focus();
  }

  function endGuide(): void {
    guide = null;
    host.input.value = "";
    host.input.placeholder = PLACEHOLDER;
    if (menu) { menu.hidden = true; menu.innerHTML = ""; }
  }

  /**
   * What comes next in the line being typed.
   *
   * The same question the toolbar answers by asking, answered here by showing:
   * once a command has a space after it, the person is on an argument and the
   * syntax is what they need — not a list of other commands. CMD_HELP already
   * holds it, per subcommand, so nothing here invents a second source of truth.
   */
  function showUsage(value: string): boolean {
    if (!menu) return false;
    const m = /^\/([A-Za-z][\w-]*)\s+(.*)$/.exec(value);
    if (!m) return false;
    const lines = CMD_HELP[m[1].toLowerCase()];
    if (!lines?.length) return false;
    // Prefer the line for the subcommand actually being typed; a command whose
    // help is one line falls back to it, which is the same answer.
    const sub = m[2].trim().split(/\s+/)[0]?.toLowerCase() ?? "";
    const want = `/${m[1].toLowerCase()} ${sub}`;
    const pick = (sub && lines.find((l) => l.toLowerCase().startsWith(want))) || lines[0];
    menu.innerHTML = "";
    const box = document.createElement("div");
    box.className = "cmd-guide";
    const line = document.createElement("div");
    line.className = "guide-line";
    line.textContent = pick;
    box.appendChild(line);
    // The detail behind it, without turning the strip into the whole help.
    const more = lines.filter((l) => l !== pick).slice(0, 1);
    for (const extra of more) {
      const d = document.createElement("div");
      d.className = "guide-eg";
      d.textContent = extra;
      box.appendChild(d);
    }
    menu.appendChild(box);
    menu.hidden = false;
    return true;
  }

  function show(filter: string, all = false): void {
    if (!menu) return;
    const f = filter.toLowerCase();
    matches = all ? SLASH_COMMANDS.slice() : SLASH_COMMANDS.filter((c) => c.name.startsWith(f));
    if (matches.length === 0) { hide(); return; }
    menu.innerHTML = "";
    addCloseBar();
    matches.forEach((c, i) => {
      const item = document.createElement("div");
      item.className = "cmd-item" + (i === sel ? " active" : "");
      const n = document.createElement("span"); n.className = "cmd-name"; n.textContent = "/" + c.name;
      const d = document.createElement("span"); d.className = "cmd-desc"; d.textContent = c.desc;
      item.appendChild(n); item.appendChild(d);
      // mousedown, not click: blur fires first and would close the menu under
      // the pointer before the click landed.
      item.addEventListener("mousedown", (e) => { e.preventDefault(); apply(c); });
      menu.appendChild(item);
    });
    menu.hidden = false;
  }

  /** The getting-started list, in order, each entry starting its own action. */
  function showNext(): void {
    if (!menu) return;
    menu.innerHTML = "";
    addCloseBar();
    let section = "";
    for (const step of OTHER_ACTIONS) {
      if (step.section && step.section !== section) {
        section = step.section;
        const head = document.createElement("div");
        head.className = "guide-head next-head";
        head.textContent = section;
        menu.appendChild(head);
      }
      const item = document.createElement("div");
      item.className = "cmd-item";
      const n = document.createElement("span");
      n.className = "cmd-name"; n.textContent = `${step.ico} ${step.label}`;
      const d = document.createElement("span");
      d.className = "cmd-desc"; d.textContent = step.hint ?? "";
      item.appendChild(n); item.appendChild(d);
      // mousedown, not click: blur closes the menu before a click would land.
      item.addEventListener("mousedown", (e) => { e.preventDefault(); begin(step); });
      menu.appendChild(item);
    }
    menu.hidden = false;
  }

  return {
    mountActions(row) {
      if (!row) return;
      for (const a of QUICK_ACTIONS) {
        const btn = document.createElement("button");
        btn.className = "action-btn";
        // Named so a module that owns an action can find its own button —
        // recording repaints its one with the elapsed time.
        btn.dataset.action = a.label.toLowerCase();
        btn.title = a.hint ?? "";
        const ico = document.createElement("span"); ico.className = "ico"; ico.textContent = a.ico;
        const lab = document.createElement("span"); lab.className = "act-label"; lab.textContent = a.label;
        btn.appendChild(ico);
        btn.appendChild(lab);
        btn.addEventListener("click", () => {
          // A second click on the button that opened something closes it.
          const wasOpen = isOpen();
          if (guide) endGuide();
          switch (a.kind) {
            case "call":   host.toggleCall(); return;
            case "record": host.toggleRecord(); return;
            case "commands":
              if (wasOpen) { hide(); return; }
              sel = -1; show("", true); host.input.focus(); return;
            case "next":
              if (wasOpen) { hide(); return; }
              showNext(); host.input.focus(); return;
            case "fill":
              hide();
              host.input.value = a.cmd ?? "";
              if (a.hint) host.say(a.hint);
              host.input.focus();
              return;
            default:
              begin(a);
          }
        });
        row.appendChild(btn);
      }
    },

    isOpen,
    justTouched: () => Date.now() - touchedAt < 400,
    isPicking: () => isOpen() && matches.length > 0,
    hide,

    guiding: () => !!guide,

    submitArg() {
      if (!guide) return;
      const spec = guide.action.args![guide.at];
      const value = host.input.value.trim();
      // A required argument is the whole point of asking: keep asking.
      if (!value && !spec.optional) { paintGuide(); return; }
      if (value) guide.parts.push((spec.join ?? " ").trimStart() === "" ? value : `${spec.join ?? ""}${value}`.trim());
      guide.at += 1;
      if (guide.at < guide.action.args!.length) {
        host.input.value = "";
        host.input.placeholder = guide.action.args![guide.at].prompt;
        paintGuide();
        return;
      }
      const line = [guide.action.cmd, ...guide.parts].join(" ");
      endGuide();
      host.run(line);
    },

    cancel() { if (guide) endGuide(); },

    onInput(value) {
      // While collecting arguments the box holds an answer, not a command.
      if (guide) return;
      if (!value.startsWith("/") || value.startsWith("//")) { hide(); return; }
      // A bare command word and nothing else: `/no` yes, `//text` no, `/note x` no.
      if (!value.includes(" ")) {
        sel = -1;
        show(value.slice(1), false);
        return;
      }
      // Past the command name the question changes from "which command" to
      // "what goes here", so the answer does too. Until now the help stopped
      // at the space, which is the moment it starts being needed.
      matches = [];
      sel = -1;
      if (!showUsage(value)) hide();
    },

    move(delta) {
      if (!menu || matches.length === 0) return;
      sel = (sel + delta + matches.length) % matches.length;
      Array.from(menu.children).forEach((el, i) => el.classList.toggle("active", i === sel));
      (menu.children[sel] as HTMLElement | undefined)?.scrollIntoView({ block: "nearest" });
    },

    accept() {
      const pick = sel >= 0 ? matches[sel] : matches[0];
      if (pick) apply(pick);
    },
  };
}
