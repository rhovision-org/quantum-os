// chat-view.ts — the room transcript as people read it: what a joiner is
// handed by the peers already present, where the clock is shown, and whose
// names in a line are people in the room.
//
// Pure: no DOM, no storage, no app imports, so `test/chat-view.test.mjs` can
// drive it in node.
//
// A room is p2p, so there is no server copy of what was said. "The full
// transcript" is the union of what the peers present hold: each one hands a
// newcomer the chat lines it saw (`sync-chat`, on the join handshake), and the
// newcomer merges them in by time. Two peers hold the same line with slightly
// different receive times, and an agent's line carries no id, so a line is
// the same line when it has the same author and text within DUP_WINDOW_MS —
// not by an id the sender would have had to mint.
//
// What the merge cannot do is vouch for authorship: a line in someone else's
// transcript is that peer's account of who said it. The app marks merged lines
// so they read as history relayed by a peer, not as the author's own signed
// word.

/** One chat line as it travels in `sync-chat`. */
export interface TranscriptLine {
  /** Author's peer id. */
  from: string;
  /** Author's display name as the relaying peer knew it. */
  label?: string;
  text: string;
  /** Epoch ms — when the relaying peer saw it. */
  at: number;
}

/** Two copies of a line from different peers are this close in time. */
export const DUP_WINDOW_MS = 120_000;
/** Lines per `sync-chat`. */
export const SYNC_CHAT_MAX_LINES = 300;
/** Bytes per `sync-chat` — well under the relay's 256 KB frame cap. */
export const SYNC_CHAT_MAX_BYTES = 120_000;
/** A single line longer than this is not relayed (the sender's own client caps chat far below it). */
export const SYNC_LINE_MAX_CHARS = 8_000;

/**
 * The newest lines that fit in one envelope, oldest first. Trimmed from the
 * front, so a joiner always gets the most recent stretch of the conversation.
 */
export function transcriptForSync(
  lines: TranscriptLine[],
  maxLines = SYNC_CHAT_MAX_LINES,
  maxBytes = SYNC_CHAT_MAX_BYTES,
): TranscriptLine[] {
  const out: TranscriptLine[] = [];
  let bytes = 2;
  for (let i = lines.length - 1; i >= 0 && out.length < maxLines; i--) {
    const l = lines[i];
    if (!l.text || l.text.length > SYNC_LINE_MAX_CHARS) continue;
    const size = JSON.stringify(l).length + 1;
    if (bytes + size > maxBytes) break;
    bytes += size;
    out.push(l);
  }
  return out.reverse();
}

/**
 * Validate a `sync-chat` payload from a peer. Anything malformed is dropped,
 * a time in the future is pulled back to `now` (a skewed clock must not park a
 * line below everything said later), and the result is sorted by time.
 */
export function sanitizeTranscript(raw: unknown, now: number): TranscriptLine[] {
  if (!Array.isArray(raw)) return [];
  const out: TranscriptLine[] = [];
  for (const r of raw.slice(0, SYNC_CHAT_MAX_LINES)) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    if (typeof o.from !== "string" || !o.from) continue;
    if (typeof o.text !== "string" || !o.text || o.text.length > SYNC_LINE_MAX_CHARS) continue;
    if (typeof o.at !== "number" || !Number.isFinite(o.at) || o.at <= 0) continue;
    const label = typeof o.label === "string" && o.label.trim() ? o.label.slice(0, 80) : undefined;
    out.push({ from: o.from, label, text: o.text, at: Math.min(o.at, now) });
  }
  return out.sort((a, b) => a.at - b.at);
}

/** The shape of a log line the merge needs to see. */
export interface MergeableLine {
  from: string;
  text: string;
  at?: number;
  chat?: boolean;
}

/**
 * Merge peer-held lines into a log, in time order, skipping any the log
 * already has. `selfId` is this browser's peer id: the log records our own
 * lines with an empty `from`, while a peer relays them under our id.
 *
 * Returns the indices (into the returned log) of the lines added, so the
 * caller can tell how many there were and repaint only if any.
 */
export function mergeTranscript<T extends MergeableLine>(
  log: T[],
  incoming: TranscriptLine[],
  make: (l: TranscriptLine) => T,
  selfId: string,
): { log: T[]; added: number } {
  const who = (from: string) => (from === "" ? selfId : from);
  const out = log.slice();
  let added = 0;
  for (const inc of incoming) {
    const dup = out.some((l) =>
      l.chat && l.at !== undefined && who(l.from) === inc.from && l.text === inc.text
      && Math.abs(l.at - inc.at) < DUP_WINDOW_MS);
    if (dup) continue;
    out.splice(insertionIndex(out, inc.at), 0, make(inc));
    added++;
  }
  return { log: out, added };
}

/**
 * Where a line said at `at` belongs: before the first line said later. A line
 * with no time of its own (a card, an old line from before lines were
 * timestamped) is taken to be as old as the line before it, so it stays where
 * it is relative to its neighbours.
 */
export function insertionIndex(log: MergeableLine[], at: number): number {
  let prev = 0;
  for (let i = 0; i < log.length; i++) {
    const t = log[i].at ?? prev;
    if (t > at) return i;
    prev = t;
  }
  return log.length;
}

/** The local minute a time falls in — two lines share a time mark when this matches. */
export function minuteKey(at: number): string {
  const d = new Date(at);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()} ${d.getHours()}:${d.getMinutes()}`;
}

function dayKey(at: number): string {
  const d = new Date(at);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

/**
 * Whether a time mark goes before a line at `at`, given the time of the last
 * mark shown (null when none is on screen yet).
 */
export function needsTimeMark(at: number, lastMarkAt: number | null): boolean {
  return lastMarkAt === null || minuteKey(at) !== minuteKey(lastMarkAt);
}

/**
 * The mark's text: the time, plus the date when the day changed since the
 * last mark — or always, for the first mark, when that day is not today.
 */
export function timeMarkText(at: number, lastMarkAt: number | null, now: number): string {
  const d = new Date(at);
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const newDay = lastMarkAt === null ? dayKey(at) !== dayKey(now) : dayKey(at) !== dayKey(lastMarkAt);
  if (!newDay) return time;
  const date = d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
  return `${date} · ${time}`;
}

export interface Mention {
  start: number;
  end: number;
  /** The known name it matched, as that name is spelled. */
  name: string;
}

const WORD = /[\p{L}\p{N}_]/u;

/**
 * Mentions of known people in a stretch of text: `@Name` for any known name,
 * and the bare name when it is at least three characters (so a two-letter
 * name does not light up every "Al" and "Jo" in passing). Case-insensitive,
 * whole words only, longest name first so "Jim Whitescarver" wins over "Jim".
 */
export function findMentions(text: string, names: Iterable<string>): Mention[] {
  const known = [...new Set([...names].map((n) => n.trim()).filter((n) => n.length >= 2))]
    .sort((a, b) => b.length - a.length);
  if (!known.length || !text) return [];
  const lower = text.toLowerCase();
  const taken = new Array<boolean>(text.length).fill(false);
  const out: Mention[] = [];
  for (const name of known) {
    const ln = name.toLowerCase();
    let from = 0;
    for (;;) {
      const i = lower.indexOf(ln, from);
      if (i < 0) break;
      from = i + 1;
      const end = i + ln.length;
      const at = i > 0 && text[i - 1] === "@";
      const start = at ? i - 1 : i;
      if (!at && name.length < 3) continue;
      if (start > 0 && WORD.test(text[start - 1])) continue;
      if (end < text.length && WORD.test(text[end])) continue;
      let clash = false;
      for (let k = start; k < end; k++) if (taken[k]) { clash = true; break; }
      if (clash) continue;
      for (let k = start; k < end; k++) taken[k] = true;
      out.push({ start, end, name });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}
