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
function validExpr(expr: unknown): expr is RhoRuntimeExpr {
  if (!isRecord(expr) || typeof expr.kind !== "string") return false;
  switch (expr.kind) {
    case "num": return typeof expr.value === "number" && Number.isFinite(expr.value);
    case "str": return typeof expr.value === "string";
    case "var": return typeof expr.name === "string";
    case "lemma": return typeof expr.name === "string";
    case "call": return typeof expr.name === "string" && Array.isArray(expr.args) && expr.args.every(validExpr);
    case "binop": return ["and","or","eq","ne","lt","le","gt","ge"].includes(String(expr.op)) && validExpr(expr.left) && validExpr(expr.right);
    case "unop": return expr.op === "not" && validExpr(expr.expr);
    default: return false;
  }
}
function validSequence(value: unknown): value is RhoSequenceNode {
  return isRecord(value) && value.kind === "sequence" && Array.isArray(value.steps) && value.steps.every(validNode);
}
function validNode(value: unknown): value is RhoProcessNode {
  if (!isRecord(value) || typeof value.kind !== "string") return false;
  if (value.kind === "command") {
    return typeof value.command === "string" && (value.bind === undefined || (typeof value.bind === "string" && /^[A-Za-z_][A-Za-z0-9_-]*$/.test(value.bind) && value.bind !== "LAST_ID"));
  }
  if (value.kind === "sequence") return validSequence(value);
  if (value.kind === "parallel") return Array.isArray(value.branches) && value.branches.every(validNode);
  if (value.kind === "when") {
    return validExpr(value.condition) && isRecord(value.env) && Object.values(value.env).every(v => typeof v === "string") && validSequence(value.then) && (value.else === undefined || validSequence(value.else));
  }
  return false;
}
function validPackageBase(value: unknown): boolean {
  return isRecord(value) && value.format === "rho-process-package" && value.version === 1
    && isRecord(value.provenance) && typeof value.provenance.authorAnchor === "string" && /^[0-9a-f]{64}$/i.test(value.provenance.authorAnchor)
    && typeof value.provenance.exportedAt === "string"
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
    try { value = JSON.parse(raw); } catch { throw new Error("invalid process package JSON"); }
  }
  if (!isRecord(value) || typeof value.contentHash !== "string" || !validPackageBase(value)) throw new Error("invalid process package: schema validation failed");
  const pkg = value as unknown as RhoProcessPackage;
  const { contentHash, ...base } = pkg;
  const expected = await sha256(canonicalJson(base));
  if (expected !== contentHash) throw new Error("process package hash mismatch");
  return { process: pkg.process, provenance: pkg.provenance, contentHash: pkg.contentHash };
}

