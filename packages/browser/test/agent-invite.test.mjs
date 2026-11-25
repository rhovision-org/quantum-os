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
const { parseAgentRequest, agentShellCommand, agentClaudePrompt, maskCap, AGENT_ROLES, DEFAULT_SIGNAL } = m;

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

ok("maskCap hides the cap, raw and URL-encoded", () => {
  const t = `a ${CAP} b ${encodeURIComponent(CAP)} c`;
  const out = maskCap(t, CAP);
  assert.ok(!out.includes("05214747236101414325074505234721"));
  assert.equal(out, "a cap:room:05214747… b cap:room:05214747… c");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
