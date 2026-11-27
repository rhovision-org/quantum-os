// Claude Code CLI — the user's own Claude login (Pro/Max plan), no API credits.
// Shells out to `claude -p`; CLAUDE_BIN (or the advisor's claudeBin) picks the binary.
import { spawn } from "node:child_process";

// claude-code backend: shell out to the local `claude` CLI in non-interactive print
// mode. Uses the user's Claude login (Pro/Max subscription) — NO Anthropic API credits.
// The system text is appended via --append-system-prompt; the user prompt is fed on stdin.
export function callClaudeCLI({ claudeBin, model, system, prompt, log, timeoutMs = 45_000 }) {
  return new Promise((resolve) => {
    const args = ["-p", "--output-format", "text", "--append-system-prompt", system];
    if (model) args.push("--model", model);
    let child;
    try {
      child = spawn(claudeBin, args, { stdio: ["pipe", "pipe", "pipe"] });
    } catch (e) {
      const error = `claude CLI spawn failed: ${e?.message ?? e}`;
      log(`[facil] ${error}`);
      return resolve({ text: null, error });
    }
    let out = "", err = "", done = false;
    const finish = (result) => { if (done) return; done = true; clearTimeout(timer); resolve(result); };
    const fail = (error) => { log(`[facil] ${error}`); finish({ text: null, error }); };
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
      fail(`claude CLI timed out after ${Math.round(timeoutMs / 1000)}s`);
    }, timeoutMs);
    child.on("error", (e) => fail(`claude CLI error: ${e?.message ?? e} (is the \`claude\` CLI installed + logged in?)`));
    child.stdout?.on("data", (d) => { out += d; });
    child.stderr?.on("data", (d) => { err += d; });
    // A CLI that exits before reading the prompt (a session limit does exactly
    // that) makes the stdin socket emit EPIPE. That is not the failure to
    // report — the close handler has the CLI's own message. Ignore EPIPE and
    // let close/timeout decide; anything else is a real stdin failure.
    child.stdin?.on("error", (e) => {
      if (e?.code !== "EPIPE") fail(`claude CLI stdin error: ${e?.message ?? e}`);
    });
    child.on("close", (code) => {
      const text = out.trim();
      const stderr = err.trim();
      if (code !== 0) {
        // Claude Code puts its subscription/session-limit message on stdout,
        // not stderr (e.g. "You've hit your session limit · resets 3:10pm").
        // Keep both so the room hears the real cause instead of a generic
        // "I don't have a good answer."
        const why = stderr || text || "no output";
        return fail(`claude CLI exit ${code}: ${why.slice(0, 300)}`);
      }
      if (!text) return fail(`claude CLI returned no text${stderr ? `: ${stderr.slice(0, 300)}` : ""}`);
      finish({ text, error: null });
    });
    try {
      if (child.stdin?.writable) { child.stdin.write(prompt); child.stdin.end(); }
    } catch (e) { fail(`claude CLI stdin error: ${e?.message ?? e}`); }
  });
}


export default {
  name: "claude-code",
  describe: "Claude through the local `claude` CLI — your Claude plan, no API key",
  keyEnv: null,
  defaultModel: null,   // the CLI's own configured model
  unavailable() { return null; },   // a missing CLI is reported per call, with its real error
  async complete({ system, prompt, model, timeoutMs = 45_000, env, claudeBin }) {
    // The advisor logs the returned error itself, so the CLI wrapper stays quiet.
    return callClaudeCLI({ claudeBin: claudeBin || env.CLAUDE_BIN || "claude", model, system, prompt, log: () => {}, timeoutMs });
  },
};
