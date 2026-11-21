import type { RhoProcessNode, RhoSequenceNode, RhoRuntimeExpr } from "./rhoqu-process.js";

export type RhoProcessProvenance = {
  readonly authorAnchor: string;
  readonly exportedAt: string;
  readonly source?: string;
};
export type RhoProcessPackage = {
  readonly format: "rho-process-package";
  readonly version: 1;
  readonly provenance: RhoProcessProvenance;
  readonly process: RhoSequenceNode;
  readonly contentHash: string;
};
export type ImportedRhoProcessPackage = {
  readonly process: RhoSequenceNode;
  readonly provenance: RhoProcessProvenance;
  readonly contentHash: string;
};

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  const object = value as Record<string, unknown>;
  return "{" + Object.keys(object).sort().map(key => JSON.stringify(key) + ":" + canonicalJson(object[key])).join(",") + "}";
}
async function sha256(value: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error("WebCrypto SHA-256 is unavailable in this context");
  const bytes = await subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, "0")).join("");
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
const MAX_PACKAGE_BYTES = 1_048_576;
const MAX_NODE_DEPTH = 64;
const MAX_SEQUENCE_STEPS = 1024;
const MAX_EXPR_ARGS = 64;
function validExpr(expr: unknown, depth = 0): expr is RhoRuntimeExpr {
  if (depth > MAX_NODE_DEPTH || !isRecord(expr) || typeof expr.kind !== "string") return false;
  switch (expr.kind) {
    case "num": return typeof expr.value === "number" && Number.isFinite(expr.value);
    case "str": return typeof expr.value === "string" && expr.value.length <= 8192;
    case "var": return typeof expr.name === "string" && expr.name.length <= 128;
    case "lemma": return typeof expr.name === "string" && expr.name.length <= 128;
    case "call": return typeof expr.name === "string" && expr.name.length <= 128 && Array.isArray(expr.args) && expr.args.length <= MAX_EXPR_ARGS && expr.args.every(arg => validExpr(arg, depth + 1));
    case "binop": return ["and","or","eq","ne","lt","le","gt","ge"].includes(String(expr.op)) && validExpr(expr.left, depth + 1) && validExpr(expr.right, depth + 1);
    case "unop": return expr.op === "not" && validExpr(expr.expr, depth + 1);
    default: return false;
  }
}
function validSequence(value: unknown, depth = 0): value is RhoSequenceNode {
  return depth <= MAX_NODE_DEPTH && isRecord(value) && value.kind === "sequence" && Array.isArray(value.steps) && value.steps.length <= MAX_SEQUENCE_STEPS && value.steps.every(node => validNode(node, depth + 1));
}
function validNode(value: unknown, depth = 0): value is RhoProcessNode {
  if (depth > MAX_NODE_DEPTH || !isRecord(value) || typeof value.kind !== "string") return false;
  if (value.kind === "command") {
    return typeof value.command === "string" && value.command.trim().length > 0 && value.command.length <= 8192 && (value.bind === undefined || (typeof value.bind === "string" && /^[A-Za-z_][A-Za-z0-9_-]*$/.test(value.bind) && value.bind.toUpperCase() !== "LAST_ID"));
  }
  if (value.kind === "sequence") return validSequence(value, depth + 1);
  if (value.kind === "parallel") return Array.isArray(value.branches) && value.branches.length >= 2 && value.branches.length <= 64 && value.branches.every(branch => validNode(branch, depth + 1));
  if (value.kind === "when") {
    return validExpr(value.condition) && isRecord(value.env) && Object.keys(value.env).length <= 128 && Object.entries(value.env).every(([key, v]) => /^[A-Za-z_][A-Za-z0-9_-]{0,127}$/.test(key) && key.toUpperCase() !== "LAST_ID" && typeof v === "string" && v.length <= 8192) && validSequence(value.then, depth + 1) && (value.else === undefined || validSequence(value.else, depth + 1));
  }
  return false;
}
function validPackageBase(value: unknown): boolean {
  return isRecord(value) && value.format === "rho-process-package" && value.version === 1
    && isRecord(value.provenance) && typeof value.provenance.authorAnchor === "string" && /^[0-9a-f]{64}$/i.test(value.provenance.authorAnchor)
    && typeof value.provenance.exportedAt === "string" && Number.isFinite(Date.parse(value.provenance.exportedAt))
    && (value.provenance.source === undefined || typeof value.provenance.source === "string")
    && validSequence(value.process);
}
export async function createRhoProcessPackage(process: RhoSequenceNode, provenance: RhoProcessProvenance): Promise<RhoProcessPackage> {
  const base = { format: "rho-process-package" as const, version: 1 as const, provenance, process };
  if (!validPackageBase(base)) throw new Error("invalid process package: schema validation failed");
  return { ...base, contentHash: await sha256(canonicalJson(base)) };
}
export async function serializeRhoProcessPackage(process: RhoSequenceNode, provenance: RhoProcessProvenance): Promise<string> {
  return canonicalJson(await createRhoProcessPackage(process, provenance));
}
export async function importRhoProcessPackage(raw: string | unknown): Promise<ImportedRhoProcessPackage> {
  let value: unknown = raw;
  if (typeof raw === "string") {
    if (raw.length > MAX_PACKAGE_BYTES) throw new Error("invalid process package: size limit exceeded");
    try { value = JSON.parse(raw); } catch { throw new Error("invalid process package JSON"); }
  }
  if (!isRecord(value) || typeof value.contentHash !== "string" || !validPackageBase(value)) throw new Error("invalid process package: schema validation failed");
  const pkg = value as unknown as RhoProcessPackage;
  const { contentHash, ...base } = pkg;
  const expected = await sha256(canonicalJson(base));
  if (expected !== contentHash) throw new Error("process package hash mismatch");
  return { process: pkg.process, provenance: pkg.provenance, contentHash: pkg.contentHash };
}

