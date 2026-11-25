// agent-invite.test.mjs — what `/agent add` hands someone to put an agent in a room.
//
//   node packages/browser/test/agent-invite.test.mjs
//
// The shell command is run for real (`bash -n` parses it, and its quoting is
// checked by echoing the arguments add-agent.sh would receive), because a
// command that is pasted but does not parse is the whole failure this exists
// to prevent.

import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import assert from "node:assert/strict";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const bundle = await build({
  stdin: {
    contents: `export * from "./src/agent-invite.ts";`,
    resolveDir: root, loader: "ts", sourcefile: "agent-invite-test-entry.ts",
  },
  bundle: true, format: "esm", platform: "node", write: false,
});
const m = await import("data:text/javascript;base64," + Buffer.from(bundle.outputFiles[0].text).toString("base64"));
const { parseAgentRequest, agentShellCommand, agentClaudePrompt, maskCap, AGENT_ROLES, AGENT_PROVIDERS, DEFAULT_SIGNAL } = m;

let pass = 0, fail = 0;
const ok = (label, fn) => {
  try { fn(); pass++; console.log(`  ok   ${label}`); }
  catch (e) { fail++; console.log(`  FAIL ${label}\n       ${e.message}`); }
};

const CAP = "cap:room:05214747236101414325074505234721";
const LINK = `https://rhovision-org.github.io/quantum-os/#room=${CAP}`;

ok("default role is facilitator", () => assert.deepEqual(parseAgentRequest(""), { role: "facilitator" }));
ok("a role is recognised, case-insensitively", () => assert.deepEqual(parseAgentRequest("Skeptic"), { role: "skeptic" }));
ok("role then name", () => assert.deepEqual(parseAgentRequest("greeter Ada Lovelace"), { role: "greeter", name: "Ada Lovelace" }));
ok("a first word that is not a role starts the name", () =>
  assert.deepEqual(parseAgentRequest("Socrates"), { role: "facilitator", name: "Socrates" }));
ok("a name with shell metacharacters is refused", () => {
  for (const bad of ["x'; rm -rf ~", "a$(id)", "a`b`", "1abc", "a".repeat(33)]) {
    assert.ok("error" in parseAgentRequest(`facilitator ${bad}`), bad);
  }
});
ok("every role add-agent.sh accepts is offered, and no other", () => {
  const sh = execFileSync("grep", ["-o", "facilitator|skeptic|scribe|greeter|observer) ;;",
    join(root, "../../scripts/qos-cli/add-agent.sh")]).toString().trim();
  assert.equal(sh, AGENT_ROLES.map((r) => r.role).join("|") + ") ;;");
});

ok("--ai picks a provider, anywhere in the line", () =>
  assert.deepEqual(parseAgentRequest("skeptic --ai deepseek Ada"), { role: "skeptic", ai: "deepseek", name: "Ada" }));
ok("--model rides along", () =>
  assert.deepEqual(parseAgentRequest("--ai deepseek --model deepseek-reasoner"), { role: "facilitator", ai: "deepseek", model: "deepseek-reasoner" }));
ok("an unknown provider is refused, listing the choices", () => {
  const r = parseAgentRequest("--ai gpt5");
  assert.ok("error" in r && /deepseek/.test(r.error));
});
ok("a model name cannot smuggle shell", () => assert.ok("error" in parseAgentRequest("--ai deepseek --model a;id")));
ok("--model with no AI is refused", () => assert.ok("error" in parseAgentRequest("--ai none --model x")));
ok("every provider maps to a plugin add-agent.sh knows", () => {
  const sh = execFileSync("cat", [join(root, "../../scripts/qos-cli/add-agent.sh")]).toString();
  for (const p of AGENT_PROVIDERS) assert.ok(p.script === "off" || sh.includes(p.script), p.script);
  for (const p of AGENT_PROVIDERS.filter((p) => p.script !== "off")) {
    assert.ok(execFileSync("ls", [join(root, `../../scripts/qos-cli/ai-providers/${p.script}.mjs`)]));
  }
});

// Run the command with git and add-agent.sh replaced by echoes, so we see
// exactly the arguments the script would get.
function argsOf(cmd) {
  const stub = `git() { :; }; bash() { shift; printf '%s\\n' "$@"; }; mkdir() { :; }; `;
  return execFileSync("/bin/bash", ["-c", stub + cmd], { env: { HOME: "/nonexistent", PATH: process.env.PATH } })
    .toString().trim().split("\n");
}
ok("shell command parses", () => execFileSync("/bin/bash", ["-n", "-c", agentShellCommand(CAP, { role: "facilitator" })]));
ok("shell command passes room and role", () =>
  assert.deepEqual(argsOf(agentShellCommand(CAP, { role: "skeptic" })), [CAP, "skeptic"]));
ok("shell command keeps a spaced name as one argument", () =>
  assert.deepEqual(argsOf(agentShellCommand(CAP, { role: "greeter", name: "Ada Lovelace" })), [CAP, "greeter", "Ada Lovelace"]));
ok("the provider reaches add-agent.sh as AI=, the model as AI_MODEL=", () => {
  const cmd = agentShellCommand(CAP, { role: "facilitator", ai: "deepseek", model: "deepseek-reasoner" });
  const env = execFileSync("/bin/bash", ["-c", `git() { :; }; bash() { echo "$AI|$AI_MODEL"; }; ${cmd}`],
    { env: { HOME: "/nonexistent", PATH: process.env.PATH } }).toString().trim();
  assert.equal(env, "deepseek|deepseek-reasoner");
});
ok("claude means the CLI plugin", () => assert.ok(agentShellCommand(CAP, { role: "facilitator", ai: "claude" }).includes("AI=claude-code ")));
ok("no key ever appears in the line", () => {
  const cmd = agentShellCommand(CAP, { role: "facilitator", ai: "deepseek" });
  assert.ok(!/DEEPSEEK_API_KEY|sk-/.test(cmd));
});
ok("default signaling adds no SIGNAL=", () =>
  assert.ok(!agentShellCommand(CAP, { role: "facilitator" }, DEFAULT_SIGNAL).includes("SIGNAL=")));
ok("a room on another signaling server says so", () =>
  assert.ok(agentShellCommand(CAP, { role: "facilitator" }, "ws://localhost:4444").includes("SIGNAL='ws://localhost:4444' ")));
ok("shell command uses its own checkout, never the cwd", () =>
  assert.ok(agentShellCommand(CAP, { role: "facilitator" }).includes(`"$HOME/.qos-agents/quantum-os"`)));

ok("Claude request names role, name, room and the script", () => {
  const p = agentClaudePrompt(LINK, { role: "scribe", name: "Ada" });
  for (const s of ["scribe", `named "Ada"`, LINK, "scripts/qos-cli/add-agent.sh", "blocked"]) assert.ok(p.includes(s), s);
});

ok("Claude request names the provider and where its key lives", () => {
  const p = agentClaudePrompt(LINK, { role: "facilitator", ai: "deepseek" });
  assert.ok(/DeepSeek/.test(p) && /DEEPSEEK_API_KEY/.test(p) && /never in the room/.test(p) && p.includes("AI=deepseek "));
});

ok("--skill parses, comma lists and repeats merge", () => {
  const r = parseAgentRequest("greeter --skill twenty-questions Quizmaster --skill a-b,twenty-questions");
  assert.deepEqual(r, { role: "greeter", name: "Quizmaster", skills: ["twenty-questions", "a-b"] });
});
ok("--skill lowercases a name, but not a path", () => {
  assert.deepEqual(parseAgentRequest("--skill Twenty-Questions").skills, ["twenty-questions"]);
  assert.deepEqual(parseAgentRequest("--skill /Home/Me/Game.md").skills, ["/Home/Me/Game.md"]);
});
ok("--skill takes an absolute .md path", () =>
  assert.deepEqual(parseAgentRequest("--skill /home/me/my-game.md").skills, ["/home/me/my-game.md"]));
ok("--skill refuses shell metacharacters and relative paths", () => {
  for (const bad of ["x;rm", "../x.md", "$(id)", "a".repeat(42), "/a b.md"]) assert.ok("error" in parseAgentRequest(`--skill ${bad}`), bad);
});
ok("--skill with --ai none is refused", () => assert.ok("error" in parseAgentRequest("--ai none --skill twenty-questions")));
ok("the skill reaches add-agent.sh as SKILL=", () => {
  const cmd = agentShellCommand(CAP, { role: "greeter", skills: ["twenty-questions", "chess-ish"] });
  const env = execFileSync("/bin/bash", ["-c", `git() { :; }; bash() { echo "$SKILL"; }; ${cmd}`],
    { env: { HOME: "/nonexistent", PATH: process.env.PATH } }).toString().trim();
  assert.equal(env, "twenty-questions,chess-ish");
});
ok("every shipped skill name passes the parser", () => {
  const dir = join(here, "../../../scripts/qos-cli/skills");
  const names = readdirSync(dir).filter((f) => f.endsWith(".md") && f !== "README.md").map((f) => f.slice(0, -3));
  assert.ok(names.length > 0);
  for (const n of names) assert.deepEqual(parseAgentRequest(`--skill ${n}`).skills, [n]);
});
ok("Claude request mentions the skill", () =>
  assert.ok(agentClaudePrompt(LINK, { role: "greeter", skills: ["twenty-questions"] }).includes("twenty-questions")));

ok("maskCap hides the cap, raw and URL-encoded", () => {
  const t = `a ${CAP} b ${encodeURIComponent(CAP)} c`;
  const out = maskCap(t, CAP);
  assert.ok(!out.includes("05214747236101414325074505234721"));
  assert.equal(out, "a cap:room:05214747… b cap:room:05214747… c");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
