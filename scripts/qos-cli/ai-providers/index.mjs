// The AI provider registry — built-in plugins by name, your own by path.
// See README.md in this directory for the plugin shape.
import path from "node:path";
import { pathToFileURL } from "node:url";
import anthropic from "./anthropic.mjs";
import claudeCode from "./claude-code.mjs";
import deepseek from "./deepseek.mjs";
import openai from "./openai.mjs";
import ollama from "./ollama.mjs";
import custom from "./custom.mjs";

export const BUILTIN = { anthropic, "claude-code": claudeCode, deepseek, openai, ollama, custom };
const ALIASES = { api: "anthropic", claude: "claude-code", cli: "claude-code", localhost: "ollama" };

/** Canonical built-in name for a spec, or null if it is not a built-in. */
export function builtinName(spec) {
  const s = String(spec ?? "").trim().toLowerCase() || "anthropic";
  const n = ALIASES[s] ?? s;
  return BUILTIN[n] ? n : null;
}

/** null when `p` has the plugin shape, otherwise what is missing. */
export function providerShapeError(p) {
  if (!p || typeof p !== "object") return "the module has no default export object";
  if (typeof p.name !== "string" || !p.name) return "it has no `name`";
  if (typeof p.complete !== "function") return "it has no `complete()` function";
  if (p.unavailable !== undefined && typeof p.unavailable !== "function") return "`unavailable` is not a function";
  return null;
}

/** A built-in by name, synchronously; null if `spec` is not one. */
export function resolveProvider(spec) {
  const n = builtinName(spec);
  return n ? BUILTIN[n] : null;
}

/**
 * A built-in by name, or a plugin module by path (anything with a `/` or ending
 * `.mjs`/`.js`). Throws with a reason a person can act on.
 */
export async function loadProvider(spec, cwd = process.cwd()) {
  const builtin = resolveProvider(spec);
  if (builtin) return builtin;
  const s = String(spec ?? "");
  if (!/[\\/]|\.m?js$/.test(s)) {
    throw new Error(`unknown AI provider "${s}" — built-ins: ${Object.keys(BUILTIN).join(", ")}, or a path to a plugin .mjs`);
  }
  const mod = await import(pathToFileURL(path.resolve(cwd, s)).href);
  const p = mod.default ?? mod.provider;
  const bad = providerShapeError(p);
  if (bad) throw new Error(`AI provider plugin ${s}: ${bad}`);
  return p;
}
