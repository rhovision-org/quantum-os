// mentions.mjs — `@name` in plain room chat, read as conversational context.
//
// A mention names a referent; it is not a command, an RPC or an instruction
// (quantum-os#341). The wire is unchanged — ordinary `{kind:"chat", text}` —
// and recognition is local: each reader matches the text against the room it
// can see and decides for itself what, if anything, the mention means.
//
// Rules:
//   - Only plain chat. A line starting with `/` is a command, where `@name`
//     is a lemma (`/lemma All men are @mortal`, `/qucalc @mortal`) and must
//     never wake a participant called `mortal`.
//   - Only `@name`, at a word boundary: `bob@example.com` is an address, not
//     a mention. Inline code (`…`) and double-quoted text are literal.
//   - Names match case-insensitively, longest first ("@Jim Whitescarver"
//     wins over "@Jim"), and must end at a word boundary.
//   - A name held by more than one participant is ambiguous: reported as
//     such, resolved to nobody. A name nobody here holds stays literal text.
//   - A display name is a label, never authority: the result says who was
//     referred to, not who may do what.
//
//   node mentions.mjs --selftest

const WORD = /[\p{L}\p{N}_]/u;

/** Spans of `text` that are literal: inline code and double-quoted text. */
function literalSpans(text) {
  const spans = [];
  const re = /`[^`]*`|"[^"\n]*"|“[^”\n]*”/g;
  let m;
  while ((m = re.exec(text))) spans.push([m.index, m.index + m[0].length]);
  return spans;
}

/**
 * Mentions in one chat line.
 *
 * @param {string} text  the chat text as received
 * @param {Array<{id: string, names: string[]}>} participants  who is in the
 *   room now, each with every name they answer to (display name, and for an
 *   agent its role and command prefix)
 * @returns {Array<{start, end, text, name, ids: string[], ambiguous: boolean}>}
 *   one entry per `@name` that matched somebody. `ids` holds the single
 *   participant it resolved to, or every holder when `ambiguous`.
 */
export function parseMentions(text, participants) {
  const s = String(text ?? "");
  if (!s || s.trimStart().startsWith("/")) return [];
  // name (lowercased) → ids that answer to it
  const holders = new Map();
  for (const p of participants ?? []) {
    if (!p || !p.id) continue;
    for (const raw of p.names ?? []) {
      const n = String(raw ?? "").trim();
      if (n.length < 2 || /^\d/.test(n)) continue;
      const k = n.toLowerCase();
      const set = holders.get(k) ?? new Set();
      set.add(p.id);
      holders.set(k, set);
    }
  }
  if (!holders.size) return [];
  const names = [...holders.keys()].sort((a, b) => b.length - a.length);
  const literal = literalSpans(s);
  const inLiteral = (i) => literal.some(([a, b]) => i >= a && i < b);
  const lower = s.toLowerCase();
  const out = [];
  for (let i = s.indexOf("@"); i >= 0; i = s.indexOf("@", i + 1)) {
    if (i > 0 && WORD.test(s[i - 1])) continue;          // an email address
    if (inLiteral(i)) continue;
    const rest = lower.slice(i + 1);
    const name = names.find((n) => rest.startsWith(n) && !WORD.test(rest[n.length] ?? ""));
    if (!name) continue;                                  // nobody here: literal text
    const ids = [...holders.get(name)];
    const end = i + 1 + name.length;
    out.push({ start: i, end, text: s.slice(i, end), name: s.slice(i + 1, end), ids, ambiguous: ids.length > 1 });
    i = end - 1;
  }
  return out;
}

/**
 * What one chat line means for the participant reading it — the context a
 * role's policy decides on. Nothing here decides anything.
 *
 * @returns {{
 *   mentions: ReturnType<typeof parseMentions>,
 *   toMe: boolean,          // I was named, unambiguously
 *   others: string[],       // the other participants named, unambiguously
 *   ambiguous: string[],    // `@name`s that matched more than one participant
 *   rest: string,           // the text with the mentions of me taken out
 * }}
 */
export function mentionContext(text, { participants, selfId }) {
  const mentions = parseMentions(text, participants);
  const resolved = mentions.filter((m) => !m.ambiguous);
  const toMe = resolved.some((m) => m.ids[0] === selfId);
  const others = [...new Set(resolved.map((m) => m.ids[0]).filter((id) => id !== selfId))];
  const ambiguous = mentions.filter((m) => m.ambiguous).map((m) => m.text);
  let rest = String(text ?? "");
  for (const m of [...resolved].reverse()) if (m.ids[0] === selfId) rest = rest.slice(0, m.start) + rest.slice(m.end);
  rest = rest.replace(/^[\s,:;.!-]+/, "").replace(/\s+([,;:.!?])/g, "$1").replace(/\s{2,}/g, " ").trim();
  return { mentions, toMe, others, ambiguous, rest };
}

// ---------------------------------------------------------------- selftest
if (typeof process !== "undefined" && process.argv?.[1]?.endsWith("mentions.mjs") && process.argv.includes("--selftest")) {
  let fail = 0;
  const eq = (got, want, msg) => {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    console.log(`${ok ? "PASS" : "FAIL"}  ${msg}${ok ? "" : `\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`}`);
    if (!ok) fail++;
  };
  const room = [
    { id: "me", names: ["skeptic", "Skeptic"] },
    { id: "scr", names: ["scribe"] },
    { id: "fac", names: ["facilitator", "facil"] },
    { id: "a", names: ["Alice"] },
    { id: "j1", names: ["Jim"] },
    { id: "j2", names: ["Jim Whitescarver"] },
    { id: "b1", names: ["Bob"] },
    { id: "b2", names: ["bob"] },
  ];
  const ids = (t) => parseMentions(t, room).map((m) => (m.ambiguous ? `?${m.ids.join("|")}` : m.ids[0]));

  eq(ids("We may have a contradiction in the proof."), [], "no mention, no context");
  eq(ids("@skeptic, is this correct?"), ["me"], "@role at the start, followed by a comma");
  eq(ids("@Skeptic @scribe, review and document this."), ["me", "scr"], "two robots named in one line");
  eq(ids("@facilitator, ask @Alice for an alternative."), ["fac", "a"], "a robot and a person");
  eq(ids("@facil what now"), ["fac"], "command prefix answers too");
  eq(ids("ping @alice!"), ["a"], "case-insensitive, punctuation ends the name");
  eq(ids("@Jim Whitescarver, hi"), ["j2"], "longest name first");
  eq(ids("@Jim, hi"), ["j1"], "the shorter name alone");
  eq(ids("@Alicetown"), [], "must end at a word boundary");
  eq(ids("@bob are you there"), ["?b1|b2"], "a name two people hold is ambiguous");
  eq(ids("@carol hello"), [], "a name nobody here holds stays literal");
  eq(ids("write to alice@example.com"), [], "an email address is not a mention");
  eq(ids("/lemma All men are @skeptic"), [], "a slash command's @name is a lemma");
  eq(ids("  /qucalc @alice"), [], "even with leading space");
  eq(ids("type `@skeptic` to call it"), [], "inline code is literal");
  eq(ids('she said "@skeptic is wrong"'), [], "quoted text is literal");
  eq(ids("@skeptic `@scribe`"), ["me"], "outside the code span still counts");
  eq(ids("@@skeptic"), ["me"], "a doubled @ still names it");
  eq(parseMentions("@skeptic", [{ id: "x", names: ["7up"] }, { id: "me", names: ["skeptic"] }]).length, 1, "a name starting with a digit is not a name");

  const ctx = mentionContext("@skeptic, is this correct?", { participants: room, selfId: "me" });
  eq([ctx.toMe, ctx.others, ctx.rest], [true, [], "is this correct?"], "context: addressed to me, the question left over");
  const other = mentionContext("@Alice, what do you think?", { participants: room, selfId: "me" });
  eq([other.toMe, other.others, other.rest], [false, ["a"], "@Alice, what do you think?"], "context: someone else was named");
  const amb = mentionContext("@bob what do you think", { participants: room, selfId: "me" });
  eq([amb.toMe, amb.others, amb.ambiguous], [false, [], ["@bob"]], "context: ambiguous resolves to nobody");
  const both = mentionContext("@skeptic @scribe, review and document this.", { participants: room, selfId: "scr" });
  eq([both.toMe, both.others, both.rest], [true, ["me"], "@skeptic, review and document this."], "context: same line, the other robot's view");
  const bare = mentionContext("@skeptic?", { participants: room, selfId: "me" });
  eq(bare.rest, "?", "context: a bare mention leaves only punctuation");

  console.log(fail ? `\n${fail} failed` : "\nall passed");
  process.exit(fail ? 1 : 0);
}
