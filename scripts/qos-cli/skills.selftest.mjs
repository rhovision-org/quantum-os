// skills.selftest.mjs — agent skill plugins parse, load by name and by path,
// refuse what is malformed with a reason, and reach the advisor's prompt.
//
//   node scripts/qos-cli/skills.selftest.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseSkill, loadSkill, listSkills, skillsPrompt } from "./skills.mjs";
import { makeAdvisor } from "./facilitator-advisor.mjs";

let pass = 0, fail = 0;
const ok = (label, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}${detail ? `  (${detail})` : ""}`); }
};
const throws = (fn, re) => { try { fn(); return false; } catch (e) { return re.test(e.message); } };

const builtins = listSkills();
ok("there is at least one built-in skill", builtins.length > 0, builtins.join(","));
for (const n of builtins) {
  let k = null; try { k = loadSkill(n); } catch (e) { ok(`${n}: loads`, false, e.message); continue; }
  ok(`${n}: loads, named after its file`, k.name === n, k.name);
  ok(`${n}: has a description and rules`, k.description.length > 0 && k.body.length > 100);
}
ok("README is not a skill", !builtins.includes("README"));

ok("no description is refused", throws(() => parseSkill("---\nname: x\n---\nrules"), /description/));
ok("no rules is refused", throws(() => parseSkill("---\nname: x\ndescription: d\n---\n"), /no rules/));
ok("a bad name is refused", throws(() => parseSkill("---\nname: Bad Name\ndescription: d\n---\nr"), /lowercase/));
ok("too long is refused", throws(() => parseSkill(`---\nname: x\ndescription: d\n---\n${"a".repeat(13000)}`), /under/));
ok("an unknown name lists the built-ins", throws(() => loadSkill("nosuch"), /twenty-questions/));
ok("a name with a path trick is refused", throws(() => loadSkill("..evil"), /isn't a skill name/));

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qos-skill-"));
try {
  const f = path.join(dir, "my-game.md");
  fs.writeFileSync(f, "---\ndescription: A test game.\nplayers: 2\n---\nTake turns saying a number; 21 wins.");
  const k = loadSkill(f);
  ok("your own skill loads by path, named after the file", k.name === "my-game" && k.players === "2");
  const p = skillsPrompt([k]);
  ok("the prompt carries the rules", p.includes("21 wins") && p.includes("Skill: my-game"));

  // The advisor puts loaded skills in every system prompt, and `play` is a mode.
  let seen = null;
  const provider = { name: "spy", complete: async ({ system, prompt }) => { seen = { system, prompt }; return { text: "No. (1/20)" }; } };
  const adv = makeAdvisor({ ai: true, provider, skills: [k] });
  const out = await adv.advise("play", { player: "Ada", move: "is it alive?", transcript: [{ name: "Bob", text: "start" }] });
  ok("play mode answers", out === "No. (1/20)", String(out));
  ok("play mode sees the rules", /21 wins/.test(seen?.system ?? ""));
  ok("play mode sees who moved and the move", /Ada/.test(seen?.prompt ?? "") && /is it alive\?/.test(seen?.prompt ?? ""));
  ok("play mode sees the game so far", /Bob: start/.test(seen?.prompt ?? ""));
  await adv.advise("ask", { question: "what are the rules?", transcript: [] });
  ok("ask mode sees the rules too", /21 wins/.test(seen?.system ?? ""));
  const none = makeAdvisor({ ai: true, provider });
  await none.advise("ask", { question: "q", transcript: [] });
  ok("no skills, no skills section", !/ACTIVITY SKILLS/.test(seen?.system ?? ""));
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${fail === 0 ? "PASS" : "FAIL"}: skills.selftest.mjs — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
