// chain-channel.ts — the client half of channels on chain (quantum-os#78).
//
// The contract is rgov-core.js §4 (Channel). What lives here is what the
// browser has to do with its answers: read them back out of the text rnode's
// JSON is rendered to, name a channel, and keep a cursor so a second read
// shows only what is new. Pure (no DOM, no storage, no network) so it bundles
// into test/chain-channel.test.mjs:
//
//   node packages/browser/test/chain-channel.test.mjs

/** One post, as the contract stores it. `text` is decoded. */
export interface ChannelPost { seq: number; text: string }

export interface PostsPage {
  id: string;
  posts: ChannelPost[];
  /** Pass this as the cursor to get the posts after this page. */
  next: number;
  closed: boolean;
  /** The newest post's seq on the channel, so "is there more?" is next < newest. */
  newest: number;
}

export interface ChannelInfo {
  id: string; owner: string; name: string;
  policy: "open" | "invite"; closed: boolean;
  seq: number; kept: number; subscribers: number;
}

/**
 * Turn `renderExpr`'s text back into a value. It writes strings as JSON, maps
 * as `{"k": v}`, lists as `[…]`, tuples as `(…)` and absence as `Nil` — so
 * outside string literals, a tuple's parens become brackets and Nil becomes
 * null, and what is left is JSON. Anything else (an unforgeable, a par) makes
 * it unparseable, and that answers null rather than guessing.
 */
export function parseRendered(text: string): unknown {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
      continue;
    }
    if (c === "(") out += "[";
    else if (c === ")") out += "]";
    else if (text.startsWith("Nil", i) && !/[A-Za-z0-9_]/.test(text[i + 3] ?? "")) { out += "null"; i += 2; }
    else out += c;
  }
  try { return JSON.parse(out); } catch { return null; }
}

/** The same decoding `channelText.decode` does in rgov-core.js, kept local so this file has no imports. */
export const decodeText = (t: string): string =>
  String(t).replace(/%(25|22|5C|0A)/g, (_, h: string) => ({ "25": "%", "22": '"', "5C": "\\", "0A": "\n" } as Record<string, string>)[h]);

/** A `("gov-error", reason, …)` answer, as one readable line; null for anything else. */
export function errorOf(v: unknown): string | null {
  if (!Array.isArray(v) || v[0] !== "gov-error") return null;
  return v.slice(1).map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" — ");
}

/** The first rendered value of an answer, parsed. Deploy answers come as a list of rendered values. */
export function firstValue(values: string[] | null | undefined): unknown {
  for (const s of values ?? []) {
    const v = parseRendered(s);
    if (v !== null) return v;
  }
  return null;
}

/** `("posts", id, [post, …], next, closed, newest)` → a page, or an error line. */
export function postsOf(v: unknown): PostsPage | { error: string } {
  const err = errorOf(v);
  if (err) return { error: err };
  if (!Array.isArray(v) || v[0] !== "posts" || v.length < 6) return { error: `unexpected answer: ${JSON.stringify(v)?.slice(0, 160)}` };
  const raw = Array.isArray(v[2]) ? v[2] : [];
  const posts = raw
    .filter((p): p is { seq: number; text: string } => !!p && typeof p === "object" && typeof (p as { seq?: unknown }).seq === "number")
    .map((p) => ({ seq: p.seq, text: decodeText(String(p.text ?? "")) }));
  return { id: String(v[1]), posts, next: Number(v[3]) || 0, closed: v[4] === true, newest: Number(v[5]) || 0 };
}

/** `("info", {…})` → the channel, or an error line. */
export function infoOf(v: unknown): ChannelInfo | { error: string } {
  const err = errorOf(v);
  if (err) return { error: err };
  if (!Array.isArray(v) || v[0] !== "info" || !v[1] || typeof v[1] !== "object") return { error: `unexpected answer: ${JSON.stringify(v)?.slice(0, 160)}` };
  const o = v[1] as Record<string, unknown>;
  return {
    id: String(o.id), owner: String(o.owner), name: String(o.name),
    policy: o.policy === "invite" ? "invite" : "open", closed: o.closed === true,
    seq: Number(o.seq) || 0, kept: Number(o.kept) || 0, subscribers: Number(o.subscribers) || 0,
  };
}

/** A REV address, as the contract derives them. */
const REV = /^1111[1-9A-HJ-NP-Za-km-z]{20,60}$/;

/**
 * Which channel an argument names. `<address>/<name>` is anybody's; a bare
 * name is your own, since the only channels you can name without an address
 * are the ones under it. Null when it is neither.
 */
export function channelIdFrom(arg: string, myAddr?: string): string | null {
  const a = arg.trim();
  if (!a) return null;
  const slash = a.indexOf("/");
  if (slash > 0) return REV.test(a.slice(0, slash)) && a.length > slash + 1 ? a : null;
  return myAddr && validName(a) ? `${myAddr}/${a}` : null;
}

/** A channel name: one word, no slash, short enough to read in a line. */
export const validName = (n: string): boolean => /^[A-Za-z0-9][A-Za-z0-9._-]{0,47}$/.test(n);

/** `<address>/<name>` shortened for a chat line: the name, and whose. */
export function channelLabel(id: string, myAddr?: string): string {
  const slash = id.indexOf("/");
  if (slash < 0) return id;
  const owner = id.slice(0, slash), name = id.slice(slash + 1);
  return owner === myAddr ? `${name} (yours)` : `${name} (${owner.slice(0, 8)}…${owner.slice(-4)})`;
}
