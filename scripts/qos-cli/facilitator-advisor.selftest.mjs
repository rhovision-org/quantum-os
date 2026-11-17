// facilitator-advisor.selftest.mjs — the AI backend must fail loudly, not
// generically. A Claude Code session limit exits non-zero with the reason on
// stdout; the old path swallowed it and the agent said "Hmm, I don't have a
// good answer." This pins both the error propagation and the EPIPE case where
// the CLI exits before reading the prompt.
//
// No `claude` login needed: a temporary fake CLI stands in.
//
//   node scripts/qos-cli/facilitator-advisor.selftest.mjs

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeAdvisor } from "./facilitator-advisor.mjs";

let pass = 0, fail = 0;
const ok = (label, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}${detail ? `  (${detail})` : ""}`); }
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qos-advisor-"));
const fake = (name, body) => {
  const p = path.join(dir, name);
  fs.writeFileSync(p, `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
  return p;
};

try {
  // Disabled configurations stay disabled, and do not call anything.
  ok("--ai off is disabled", makeAdvisor({ ai: false }).enabled === false);
  ok("api backend without a key is disabled",
    makeAdvisor({ ai: true, backend: "api", apiKey: "" }).enabled === false);

  // A session-limit CLI: non-zero, reason on stdout, exits before reading the
  // prompt. The advisor must return null AND expose the real reason.
  const limited = makeAdvisor({
    ai: true,
    backend: "claude-code",
    claudeBin: fake("fake-claude-limit.sh", 'echo "You\'ve hit your session limit · resets 3:10pm"; exit 1'),
    log: () => {},
  });
  const text = await limited.advise("ask", { question: "what is /poll?", transcript: [] });
  ok("a limited CLI returns no answer", text === null);
  ok("the limit reason is preserved", /session limit/i.test(limited.lastError ?? ""), limited.lastError);
  ok("the exit status is preserved", /exit 1/.test(limited.lastError ?? ""), limited.lastError);

  // The success path still returns text.
  const working = makeAdvisor({
    ai: true,
    backend: "claude-code",
    claudeBin: fake("fake-claude-ok.sh", 'cat >/dev/null; echo "OK"'),
    log: () => {},
  });
  const answer = await working.advise("ask", { question: "what is /poll?", transcript: [] });
  ok("a working CLI returns its text", answer === "OK", String(answer));
  ok("a working CLI leaves no error", working.lastError === null, working.lastError);

  // A CLI that exits cleanly but prints nothing is a failure, not silence.
  const empty = makeAdvisor({
    ai: true,
    backend: "claude-code",
    claudeBin: fake("fake-claude-empty.sh", 'cat >/dev/null; exit 0'),
    log: () => {},
  });
  const emptyText = await empty.advise("ask", { question: "what is /poll?", transcript: [] });
  ok("empty output returns no answer", emptyText === null);
  ok("empty output is reported", /no text/.test(empty.lastError ?? ""), empty.lastError);
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${fail === 0 ? "PASS" : "FAIL"}: facilitator-advisor.selftest.mjs — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
