// Agent skill plugins — the rules and context for an activity an agent takes
// part in (a game, a format, a practice), as a plain Markdown file.
//
// A skill is a file, not code: anyone who can write the rules down can give an
// agent a new activity. Built-ins live in ./skills/<name>.md; your own loads by
// path. Format and an example: skills/README.md.
//
//   node agent.mjs --room <cap> --ai --skill twenty-questions
//   node agent.mjs --room <cap> --ai --skill /home/me/my-game.md
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const SKILLS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "skills");
export const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;
const MAX_BODY = 12_000;   // rules ride in every prompt; keep them a page or two

/**
 * Parse a skill file: `---` frontmatter (`name`, `description`, optional
 * `players`) then the rules/context as the body. Throws with what is wrong.
 */
export function parseSkill(text, fallbackName = "") {
  const src = String(text ?? "").replace(/\r\n/g, "\n");
  const fm = /^---\n([\s\S]*?)\n---\n?/.exec(src);
  const meta = {};
  if (fm) {
    for (const line of fm[1].split("\n")) {
      const m = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(line.trim());
      if (m) meta[m[1].toLowerCase()] = m[2].replace(/^["']|["']$/g, "").trim();
    }
  }
  const body = (fm ? src.slice(fm[0].length) : src).trim();
  const name = (meta.name || fallbackName).toLowerCase();
  if (!SKILL_NAME_RE.test(name)) throw new Error(`skill name "${name}" must be lowercase letters, digits and '-'`);
  if (!meta.description) throw new Error(`skill ${name} has no description in its frontmatter`);
  if (!body) throw new Error(`skill ${name} has no rules (the body after the frontmatter is empty)`);
  if (body.length > MAX_BODY) throw new Error(`skill ${name} is ${body.length} chars; keep it under ${MAX_BODY} (it rides in every prompt)`);
  return { name, description: meta.description, players: meta.players || "", body };
}

/** The built-in skills, by name. */
export function listSkills(dir = SKILLS_DIR) {
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith(".md") && f !== "README.md"); } catch { /* none */ }
  return files.map((f) => f.slice(0, -3)).sort();
}

/**
 * The standard skills: every built-in in skills/, which every agent (a fork
 * included) has without a flag. Only their names and one-line descriptions
 * ride in the prompt until the room picks one, so shipping more costs little.
 */
export function standardSkills(dir = SKILLS_DIR) {
  const out = [];
  for (const n of listSkills(dir)) { try { out.push(loadSkill(n, { dir })); } catch { /* a broken file is skipped, not fatal */ } }
  return out;
}

/** A built-in by name, or your own skill file by path. Throws a reason a person can act on. */
export function loadSkill(spec, { dir = SKILLS_DIR, cwd = process.cwd() } = {}) {
  const s = String(spec ?? "").trim();
  if (!s) throw new Error("--skill needs a name or a path");
  const isPath = /[\\/]/.test(s) || s.endsWith(".md");
  const file = isPath ? path.resolve(cwd, s) : path.join(dir, `${s}.md`);
  if (!isPath && !SKILL_NAME_RE.test(s)) throw new Error(`"${s}" isn't a skill name — use lowercase letters, digits and '-', or a path to a .md file`);
  let text;
  try { text = fs.readFileSync(file, "utf8"); }
  catch { throw new Error(isPath ? `no skill file at ${file}` : `no built-in skill "${s}" — built-ins: ${listSkills(dir).join(", ") || "(none)"}, or give a path to your own .md`); }
  return parseSkill(text, path.basename(file, ".md"));
}

/** The system-prompt section an agent's AI gets for its loaded skills. */
export function skillsPrompt(skills, others = []) {
  const rest = (others ?? []).filter((o) => !skills?.some((k) => k.name === o.name));
  const index = rest.length
    ? `\n\nOTHER ACTIVITIES you can run once someone picks one with \`use <name>\`: ${rest.map((o) => `${o.name} (${o.description})`).join("; ")}.`
    : "";
  if (!skills?.length) return index ? index.trim() : "";
  const parts = skills.map((k) => `### Skill: ${k.name}\n${k.description}${k.players ? `\nPlayers: ${k.players}` : ""}\n\n${k.body}`);
  return `ACTIVITY SKILLS. You know how to run or take part in these activities in this room. When a participant `
    + `plays a move or asks about one, follow its rules exactly, keep track of the game state from the room's transcript, `
    + `say whose turn it is, and keep every message short enough for a chat line. Never invent rules a skill does not state; `
    + `if something is ambiguous, say so and propose a ruling the players can accept or reject. `
    + `To remember something the players must not see (a secret answer, a hidden hand, the full state), write it on its `
    + `own line starting "NOTE:" — it is kept for you, shown back to you next turn, and never posted. Keep notes current: `
    + `a later note replaces nothing, so restate what still matters.\n\n${parts.join("\n\n")}${index}`;
}
