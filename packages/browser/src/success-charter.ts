// success-charter.ts — canonical group charter artifact for the required
// RhoGov/Rholo handoff (#291). Pure: no DOM, storage, network, or chain write.
//
// The artifact deliberately carries no room capability and no personal goals.
// A raw `cap:room:…` is a bearer secret; including it would hand the room to
// anyone who reads the chain.

import { canonicalJson, sha256Hex } from "./qos-process.js";

export const SUCCESS_CHARTER_SCHEMA = "success-charter/1";
export const SUCCESS_CHARTER_VERSION = 1;

export type CharterRole = "admin" | "member";

export interface CharterGroup {
  id: string;
  name: string;
  /** Durable group URI, if one exists. Never a room capability. */
  uri?: string;
}

export interface CharterObjective {
  id: string;
  title: string;
  keyResults: string[];
  /** Optional dyncap anchor for the accountable owner. */
  owner?: string;
}

export interface CharterDecision {
  issueId: string;
  pollId?: string;
  lemmaHash?: string;
  result: string;
  quorum?: Record<string, unknown>;
}

export interface CharterMember {
  anchor: string;
  role: CharterRole;
  signature?: string;
}

export interface SuccessCharterInput {
  group: CharterGroup;
  objectives: CharterObjective[];
  decisions: CharterDecision[];
  members: CharterMember[];
  /** Dyncap seq at which the group ratified the charter. */
  ratifiedAtSeq: number;
  /** Dyncap anchor of the member requesting the handoff. */
  proposer: string;
}

export interface SuccessCharter extends SuccessCharterInput {
  schema: typeof SUCCESS_CHARTER_SCHEMA;
  version: typeof SUCCESS_CHARTER_VERSION;
  charterHash: string;
  signatures: string[];
}

export interface CharterValidation {
  ok: boolean;
  errors: string[];
}

export interface CharterValidationOptions {
  /** A handoff requires at least one member signature; a draft may be unsigned. */
  requireSignatures?: boolean;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;

/** Deep scan for a bearer room capability in values or field names. */
function scanRoomCap(value: unknown, path: string, errors: string[]): void {
  if (typeof value === "string") {
    if (/cap:room:/i.test(value)) errors.push(`${path} contains a raw room capability`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => scanRoomCap(v, `${path}[${i}]`, errors));
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (/room[_-]?cap/i.test(key)) errors.push(`${path}.${key} is a forbidden room-capability field`);
    scanRoomCap(child, `${path}.${key}`, errors);
  }
}

function normalize(input: SuccessCharterInput): Omit<SuccessCharter, "charterHash" | "signatures"> {
  return {
    schema: SUCCESS_CHARTER_SCHEMA,
    version: SUCCESS_CHARTER_VERSION,
    group: {
      id: input.group.id.trim(),
      name: input.group.name.trim(),
      ...(input.group.uri !== undefined ? { uri: input.group.uri.trim() } : {}),
    },
    objectives: input.objectives.map((o) => ({
      id: o.id.trim(),
      title: o.title.trim(),
      keyResults: o.keyResults.map((k) => k.trim()),
      ...(o.owner !== undefined ? { owner: o.owner.trim() } : {}),
    })),
    decisions: input.decisions.map((d) => ({
      issueId: d.issueId.trim(),
      ...(d.pollId !== undefined ? { pollId: d.pollId.trim() } : {}),
      ...(d.lemmaHash !== undefined ? { lemmaHash: d.lemmaHash.trim() } : {}),
      result: d.result.trim(),
      ...(d.quorum !== undefined ? { quorum: d.quorum } : {}),
    })),
    members: input.members.map((m) => ({
      anchor: m.anchor.trim(),
      role: m.role,
      ...(m.signature !== undefined ? { signature: m.signature.trim() } : {}),
    })),
    ratifiedAtSeq: input.ratifiedAtSeq,
    proposer: input.proposer.trim(),
  };
}

function validateInput(input: SuccessCharterInput): string[] {
  const errors: string[] = [];
  if (!isRecord(input)) return ["charter input must be an object"];
  if (!isRecord(input.group) || !nonEmpty(input.group.id) || !nonEmpty(input.group.name)) {
    errors.push("group.id and group.name are required");
  } else if (input.group.uri !== undefined && typeof input.group.uri !== "string") {
    errors.push("group.uri must be a string when present");
  }
  if (!Array.isArray(input.objectives) || input.objectives.length === 0) {
    errors.push("at least one objective is required");
  } else {
    input.objectives.forEach((o, i) => {
      if (!nonEmpty(o?.id) || !nonEmpty(o?.title)) errors.push(`objective[${i}] needs id and title`);
      if (!Array.isArray(o?.keyResults) || o.keyResults.some((k) => typeof k !== "string")) {
        errors.push(`objective[${i}].keyResults must be a string array`);
      }
      if (o?.owner !== undefined && typeof o.owner !== "string") {
        errors.push(`objective[${i}].owner must be a string when present`);
      }
    });
  }
  if (!Array.isArray(input.decisions) || input.decisions.length === 0) {
    errors.push("at least one decision is required");
  } else {
    input.decisions.forEach((d, i) => {
      if (!nonEmpty(d?.issueId) || !nonEmpty(d?.result)) errors.push(`decision[${i}] needs issueId and result`);
      if (d?.pollId !== undefined && typeof d.pollId !== "string") errors.push(`decision[${i}].pollId must be a string`);
      if (d?.lemmaHash !== undefined && typeof d.lemmaHash !== "string") errors.push(`decision[${i}].lemmaHash must be a string`);
      if (d?.quorum !== undefined && !isRecord(d.quorum)) errors.push(`decision[${i}].quorum must be an object`);
    });
  }
  if (!Array.isArray(input.members) || input.members.length === 0) {
    errors.push("at least one member is required");
  } else {
    input.members.forEach((m, i) => {
      if (!nonEmpty(m?.anchor)) errors.push(`member[${i}] needs an anchor`);
      if (m?.role !== "admin" && m?.role !== "member") errors.push(`member[${i}] has an invalid role`);
      if (m?.signature !== undefined && typeof m.signature !== "string") errors.push(`member[${i}].signature must be a string`);
    });
  }
  if (!Number.isInteger(input.ratifiedAtSeq) || input.ratifiedAtSeq < 0) {
    errors.push("ratifiedAtSeq must be a non-negative integer");
  }
  if (!nonEmpty(input.proposer)) errors.push("proposer is required");
  scanRoomCap(input, "charter", errors);
  return errors;
}

/** Hash the canonical content, excluding the hash itself and signatures. */
export async function successCharterHash(input: Omit<SuccessCharter, "charterHash" | "signatures">): Promise<string> {
  return sha256Hex(canonicalJson(input));
}

export async function buildSuccessCharter(
  input: SuccessCharterInput,
  signatures: string[] = [],
): Promise<SuccessCharter> {
  const errors = validateInput(input);
  if (errors.length) throw new Error(`invalid success charter: ${errors.join("; ")}`);
  const content = normalize(input);
  const charterHash = await successCharterHash(content);
  return { ...content, charterHash, signatures: signatures.map((s) => String(s).trim()).filter(Boolean) };
}

export async function validateSuccessCharter(
  value: unknown,
  opts: CharterValidationOptions = {},
): Promise<CharterValidation> {
  const errors: string[] = [];
  if (!isRecord(value)) return { ok: false, errors: ["charter must be an object"] };
  if (value.schema !== SUCCESS_CHARTER_SCHEMA) errors.push(`schema must be ${SUCCESS_CHARTER_SCHEMA}`);
  if (value.version !== SUCCESS_CHARTER_VERSION) errors.push(`version must be ${SUCCESS_CHARTER_VERSION}`);

  const inputErrors = validateInput(value as unknown as SuccessCharterInput);
  errors.push(...inputErrors);

  if (!Array.isArray(value.signatures)) errors.push("signatures must be an array");
  else {
    value.signatures.forEach((s, i) => {
      if (!nonEmpty(s)) errors.push(`signature[${i}] must be a non-empty string`);
    });
    if (opts.requireSignatures && value.signatures.length === 0) errors.push("at least one signature is required");
  }

  if (typeof value.charterHash !== "string" || !/^[0-9a-f]{64}$/.test(value.charterHash)) {
    errors.push("charterHash must be a lowercase SHA-256 hex string");
  } else if (inputErrors.length === 0) {
    const expected = await successCharterHash(normalize(value as unknown as SuccessCharterInput));
    if (value.charterHash !== expected) errors.push("charterHash does not match the canonical content");
  }

  if (errors.length === 0) scanRoomCap(value, "charter", errors);
  return { ok: errors.length === 0, errors };
}
