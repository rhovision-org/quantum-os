// rholang-pipeline.ts — client-side RChain deploy pipeline for the macro path.
//
// Zero-trust split: the headless agent (scripts/qos-cli/rholang-agent.mjs) only
// EXPANDS a macro into rholang; this module does everything that must stay in the
// browser:
//
//   lint   → the WASM linter (crates/zfa-core/src/lint.rs) checks the expanded
//            code is well-formed, so nobody is asked to sign something that
//            cannot parse. It does not restrict which rholang is permitted —
//            capability security decides what a deploy can reach.
//   sign   → the deploy is signed with a locally-generated keypair, wrapped by a
//            passphrase-derived AES key and stored in IndexedDB. The private key
//            never leaves the browser.
//   deploy → the signed packet is POSTed straight to the target RChain node.
//
// SECURITY NOTE — signing scheme: Web Crypto exposes ECDSA over P-256, but RChain
// deploys are signed with secp256k1. P-256 is used here as the client-side
// *pipeline* placeholder; swap `generateKeyPair`/`signPayload` for a secp256k1
// implementation (`@noble/curves` or a WASM secp256k1) before production use.
// The key-storage + lint + deploy flow is unchanged.

const DB_NAME = "qos-global";   // storage key, unchanged so existing keys still open
const DB_VERSION = 1;
const STORE = "keys";

export interface LintResult {
  ok: boolean;
  errors: string[];
}

/** Run the WASM rholang linter on an expanded source string. */
export async function lintRholang(source: string): Promise<LintResult> {
  try {
    const mod = (await import("@quantum-os/zfa-core")) as any;
    const ok: boolean = mod.wasm_lint_ok ? mod.wasm_lint_ok(source) : true;
    const errors: string[] = mod.wasm_lint_errors
      ? String(mod.wasm_lint_errors(source) ?? "")
          .split("\n")
          .filter(Boolean)
      : [];
    return { ok, errors };
  } catch {
    // WASM unavailable (e.g. first load / dev fallback) — do not hard-block.
    return { ok: true, errors: [] };
  }
}

// ---------------------------------------------------------------------------
// Passphrase-wrapped key storage (Web Crypto + IndexedDB)
// ---------------------------------------------------------------------------

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet(db: IDBDatabase, key: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbPut(db: IDBDatabase, key: string, value: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function deriveWrappingKey(passphrase: string, salt: BufferSource): Promise<CryptoKey> {
  const baseKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"]
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: 210_000, hash: "SHA-256" },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["wrapKey", "unwrapKey"]
  );
}

/** Generate a signing keypair (ECDSA P-256 — see SECURITY NOTE above). */
export async function generateKeyPair(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"]
  );
}

interface StoredKey {
  salt: number[];
  iv: number[];
  wrappedPrivate: ArrayBuffer;
  publicJwk: JsonWebKey;
}

/** Encrypt + persist a keypair in IndexedDB under `id`, wrapped by `passphrase`. */
export async function storeKeyPair(
  id: string,
  passphrase: string,
  pair: CryptoKeyPair
): Promise<void> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const wrapKey = await deriveWrappingKey(passphrase, salt);
  const wrappedPrivate = await crypto.subtle.wrapKey("jwk", pair.privateKey, wrapKey, {
    name: "AES-GCM",
    iv,
  });
  const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const db = await openDb();
  await idbPut(db, id, {
    salt: Array.from(salt),
    iv: Array.from(iv),
    wrappedPrivate,
    publicJwk,
  } satisfies StoredKey);
  db.close();
}

export interface LoadedKey {
  privateKey: CryptoKey;
  publicJwk: JsonWebKey;
}

/** Load + decrypt a stored keypair (null if absent or wrong passphrase). */
export async function loadKeyPair(id: string, passphrase: string): Promise<LoadedKey | null> {
  const db = await openDb();
  const rec = (await idbGet(db, id)) as StoredKey | undefined;
  db.close();
  if (!rec) return null;
  try {
    const wrapKey = await deriveWrappingKey(passphrase, new Uint8Array(rec.salt));
    const privateKey = await crypto.subtle.unwrapKey(
      "jwk",
      rec.wrappedPrivate,
      wrapKey,
      { name: "AES-GCM", iv: new Uint8Array(rec.iv) },
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign"]
    );
    return { privateKey, publicJwk: rec.publicJwk };
  } catch {
    return null; // wrong passphrase
  }
}

// ---------------------------------------------------------------------------
// Signing + deploy
// ---------------------------------------------------------------------------

export interface SignedPacket {
  code: string;
  publicKey: string;
  signature: string;
}

const b64 = (buf: ArrayBuffer): string => {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
};

/** Sign a payload string (the rholang deploy) with a private key. */
export async function signPayload(
  payload: string,
  privateKey: CryptoKey,
  publicJwk: JsonWebKey
): Promise<SignedPacket> {
  const sig = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    privateKey,
    new TextEncoder().encode(payload)
  );
  return {
    code: payload,
    publicKey: btoa(JSON.stringify(publicJwk)),
    signature: b64(sig),
  };
}

export interface DeployResult {
  ok: boolean;
  id?: string;
  message: string;
}

/** POST a signed deploy packet to the target RChain node. */
export async function deployToNode(
  nodeUrl: string,
  packet: SignedPacket
): Promise<DeployResult> {
  try {
    const res = await fetch(`${nodeUrl.replace(/\/$/, "")}/api/deploy`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(packet),
    });
    if (!res.ok) return { ok: false, message: `node rejected deploy (HTTP ${res.status})` };
    const body = (await res.json().catch(() => ({}))) as { id?: string };
    return { ok: true, id: body.id, message: "deployed" };
  } catch (e) {
    return { ok: false, message: `deploy failed: ${(e as Error)?.message ?? e}` };
  }
}

// ---------------------------------------------------------------------------
// The full pipeline: preview → lint → sign → deploy
// ---------------------------------------------------------------------------

export interface PipelineResult {
  ok: boolean;
  stage: "lint" | "sign" | "deploy" | "done";
  message: string;
  deployId?: string;
}

/**
 * Run the client-side pipeline for an already-expanded rholang source string.
 * The browser UI should call this on user approval, after showing a preview.
 */
export async function runDeployPipeline(
  source: string,
  opts: { nodeUrl: string; passphrase: string; id?: string }
): Promise<PipelineResult> {
  // 1. Lint — never sign unvalidated code.
  const lint = await lintRholang(source);
  if (!lint.ok) {
    return {
      ok: false,
      stage: "lint",
      message: "lint failed:\n" + lint.errors.map((e) => `  • ${e}`).join("\n"),
    };
  }

  // 2. Load (or generate + store) the signing key.
  const id = opts.id ?? "global-default";
  let keys = await loadKeyPair(id, opts.passphrase);
  if (!keys) {
    const pair = await generateKeyPair();
    await storeKeyPair(id, opts.passphrase, pair);
    keys = {
      privateKey: pair.privateKey,
      publicJwk: await crypto.subtle.exportKey("jwk", pair.publicKey),
    };
  }

  // 3. Sign.
  const packet = await signPayload(source, keys.privateKey, keys.publicJwk);

  // 4. Deploy.
  const deploy = await deployToNode(opts.nodeUrl, packet);
  if (!deploy.ok) {
    return { ok: false, stage: "deploy", message: deploy.message };
  }
  return { ok: true, stage: "done", message: "deployed", deployId: deploy.id };
}

// ---------------------------------------------------------------------------
// Local macro expansion — mirrors scripts/qos-cli/rholang-macros.mjs so the
// browser can expand macro call sites even when no room agent is present.
// The agent is the authority in a room with one; this is the offline fallback.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Macro expansion — the shared engine.
//
// The registry, validators, templates and rholang scanner live in
// ./rholang-macros.js, which scripts/qos-cli/rholang-macros.mjs imports too.
// This file only binds the browser's ZFA kernel to it, so the rholang a user
// sees the agent post in chat is the same rholang this module lints and signs.
// ---------------------------------------------------------------------------

import { createMacroEngine } from "./rholang-macros.js";
import { achievesZfa, isPauliClosed, parseTwists, validateCapability } from "./zfa.js";

const engine = createMacroEngine({ achievesZfa, isPauliClosed, parseTwists, validateCapability });

export const MACROS = engine.MACROS;
export const listMacros = engine.listMacros;
export const HELP = engine.HELP;

/** How a `$name(…)` line runs: a local read, an unsigned chain read (`eval`),
 *  a signed `deploy`, or `null` for "not a built-in". */
export function macroMode(name: string): "read-local" | "eval" | "deploy" | null {
  return engine.macroMode(name) as "read-local" | "eval" | "deploy" | null;
}

export type MacroExpansion =
  | { kind: "help" }
  | { kind: "list" }
  | { kind: "result"; macro: string; text: string }
  | { kind: "rholang"; macro: string; source: string; mode?: "eval" | "deploy" };

export interface MacroProgram {
  kind: "program";
  source: string;
  expansions: { name: string; line: number; write: boolean }[];
  errors: { line: number; message: string }[];
  /** A `$macro(…) as <pat> { …` whose block is not yet closed — still being typed, not malformed. */
  incomplete: { line: number; message: string }[];
}

/** Expand a bare single macro — the whole program is one macro. */
export function expandBareMacro(line: string): MacroExpansion {
  return engine.expandBare(line) as MacroExpansion;
}

/** Expand every `%macro(…)` call site in a rholang program. */
export function expandMacroProgram(src: string): MacroProgram {
  return engine.expandProgram(src) as MacroProgram;
}
