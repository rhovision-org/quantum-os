// room-names.ts — human names for room tabs, and the slug that carries one in
// the address bar.
//
// A room is identified by its capability (`cap:room:…`), which is a bearer
// secret and unreadable besides. A name is the opposite: something a person
// chose, safe to have on screen, and what the tab shows. The name is NOT the
// room — two browsers can call different rooms by the same name — so it never
// replaces the cap anywhere authority matters. It is a local label that an
// invite link carries along so the person joining sees the same one.
//
// Uniqueness is per browser: the store is this browser's own, so "already
// taken" means taken among the rooms this browser has joined. There is no
// registry to make it global, by design (no server, no trust).
//
// URL shape (the hash, so switching rooms never reloads the page):
//
//   #/my-room                               the active room, cap hidden
//   #/my-room?name=My+Room&room=cap:room:…  revealed, and the invite link
//   #room=cap:room:…                        legacy / unnamed — still accepted
//
// Pure: no DOM, no storage. `test/room-names.test.mjs` covers it.

/** Longest name accepted. The tab shows the whole name, so it has to end somewhere. */
export const ROOM_NAME_MAX = 60;

/** Trim and collapse internal whitespace; the name as it will be stored and shown. */
export function normalizeRoomName(raw: string): string {
  return raw.replace(/\s+/g, " ").trim();
}

/**
 * The URL form of a name: lowercase ASCII letters and digits joined by single
 * dashes. Accents are folded ("Café" → "cafe"); anything else separates words.
 * Two names with the same slug are the same name, for uniqueness.
 */
export function slugify(name: string): string {
  return normalizeRoomName(name)
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** The room (if any) whose name has this slug. `names` is roomId → name. */
export function findRoomBySlug(slug: string, names: ReadonlyMap<string, string>): string | null {
  const s = slugify(slug);
  if (!s) return null;
  for (const [roomId, name] of names) if (slugify(name) === s) return roomId;
  return null;
}

/** Is `name` used by a room other than `selfRoomId`? */
function takenBy(name: string, names: ReadonlyMap<string, string>, selfRoomId?: string): string | null {
  const owner = findRoomBySlug(name, names);
  return owner && owner !== selfRoomId ? owner : null;
}

/** The first of "Name 2", "Name 3", … that no other room uses. */
export function suggestRoomName(name: string, names: ReadonlyMap<string, string>, selfRoomId?: string): string {
  const base = normalizeRoomName(name).replace(/\s+\d+$/, "") || "Room";
  for (let n = 2; ; n++) {
    const suffix = ` ${n}`;
    const candidate = base.slice(0, ROOM_NAME_MAX - suffix.length).trimEnd() + suffix;
    if (!takenBy(candidate, names, selfRoomId)) return candidate;
  }
}

export type RoomNameCheck =
  | { ok: true; name: string; slug: string }
  | { ok: false; error: string; suggestion?: string };

/**
 * Check a proposed name against the names this browser already uses.
 * `selfRoomId` is the room being (re)named, so keeping its own name is fine.
 */
export function checkRoomName(
  raw: string,
  names: ReadonlyMap<string, string>,
  selfRoomId?: string,
): RoomNameCheck {
  const name = normalizeRoomName(raw);
  if (!name) return { ok: false, error: "Give the room a name." };
  if (name.length > ROOM_NAME_MAX) {
    return { ok: false, error: `That name is ${name.length} characters — keep it to ${ROOM_NAME_MAX}.` };
  }
  if (/^cap:/i.test(name)) return { ok: false, error: "A name can't start with “cap:” — that looks like a capability." };
  const slug = slugify(name);
  if (!slug) return { ok: false, error: "A name needs at least one letter or digit." };
  const owner = takenBy(name, names, selfRoomId);
  if (owner) {
    const existing = names.get(owner) ?? name;
    return {
      ok: false,
      error: `A room named “${existing}” already exists.`,
      suggestion: suggestRoomName(name, names, selfRoomId),
    };
  }
  return { ok: true, name, slug };
}

export interface RoomHash {
  /** The `#/slug` part, if the hash has one. */
  slug: string | null;
  /** Everything else: `room`, `name`, and whatever other parameters were there. */
  params: URLSearchParams;
}

/** Read a location hash (with or without the leading `#`) in either shape. */
export function parseRoomHash(hash: string): RoomHash {
  let h = hash.startsWith("#") ? hash.slice(1) : hash;
  let slug: string | null = null;
  if (h.startsWith("/")) {
    const q = h.indexOf("?");
    const path = q === -1 ? h.slice(1) : h.slice(1, q);
    h = q === -1 ? "" : h.slice(q + 1);
    try { slug = decodeURIComponent(path) || null; } catch { slug = path || null; }
  }
  return { slug, params: new URLSearchParams(h) };
}

/** Write a hash (including `#`), or "" when there is nothing to carry. */
export function buildRoomHash(slug: string | null, params: URLSearchParams): string {
  // `:` is legal in a fragment; keep `cap:room:…` readable and matchable by
  // the `room=(cap:room:…)` pattern older code and pasted links rely on.
  const q = params.toString().replace(/%3A/gi, ":");
  if (slug) return `#/${slug}${q ? `?${q}` : ""}`;
  return q ? `#${q}` : "";
}

/**
 * The name a pasted invite link carries, if any: its `name=` parameter, else
 * nothing (a bare slug is only a lowercase stand-in for the name, so it is not
 * used as one).
 */
export function nameFromInvite(input: string): string | null {
  const s = input.trim();
  const i = s.indexOf("#");
  if (i === -1) return null;
  const name = parseRoomHash(s.slice(i)).params.get("name");
  return name ? normalizeRoomName(name) || null : null;
}
