// success-charter.test.mjs — canonical artifact for the required handoff.
//
//   node packages/browser/test/success-charter.test.mjs

import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const bundle = await build({
  stdin: {
    contents: `
      export {
        SUCCESS_CHARTER_SCHEMA, SUCCESS_CHARTER_VERSION,
        buildSuccessCharter, successCharterHash, validateSuccessCharter,
      } from "./src/success-charter.ts";
    `,
    resolveDir: root,
    loader: "ts",
    sourcefile: "success-charter-test-entry.ts",
  },
  bundle: true,
  format: "esm",
  platform: "node",
  write: false,
});
const {
  SUCCESS_CHARTER_SCHEMA, SUCCESS_CHARTER_VERSION,
  buildSuccessCharter, successCharterHash, validateSuccessCharter,
} = await import(
  "data:text/javascript;base64," + Buffer.from(bundle.outputFiles[0].text).toString("base64")
);

let pass = 0, fail = 0;
const ok = (label, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}${detail ? `  (${detail})` : ""}`); }
};
const rejects = async (label, fn) => {
  try { await fn(); ok(label, false, "did not throw"); }
  catch (e) { ok(label, true); }
};
const base = () => ({
  group: { id: "grp-1", name: "Alpha", uri: "rho:id:alpha" },
  objectives: [
    { id: "obj-1", title: "Ship the success framework", keyResults: ["docs", "tests"], owner: "cap:peer/dyn:alice" },
  ],
  decisions: [
    { issueId: "i-1", pollId: "p-1", lemmaHash: "abc", result: "adopted", quorum: { yes: 3, no: 1 } },
  ],
  members: [
    { anchor: "cap:peer/dyn:alice", role: "admin" },
    { anchor: "cap:peer/dyn:bob", role: "member" },
  ],
  ratifiedAtSeq: 42,
  proposer: "cap:peer/dyn:alice",
});

// --- deterministic build --------------------------------------------------
const draft = await buildSuccessCharter(base());
ok("schema and version are fixed", draft.schema === SUCCESS_CHARTER_SCHEMA && draft.version === SUCCESS_CHARTER_VERSION);
ok("hash is lowercase sha-256", /^[0-9a-f]{64}$/.test(draft.charterHash), draft.charterHash);
ok("draft can be unsigned", draft.signatures.length === 0);
const signed = await buildSuccessCharter(base(), ["sig-a", "sig-b"]);
ok("signatures do not change the content hash", signed.charterHash === draft.charterHash);
ok("signatures are copied", signed.signatures.join(",") === "sig-a,sig-b");

const reordered = base();
reordered.group = { uri: "rho:id:alpha", name: "Alpha", id: "grp-1" };
const reorderedDraft = await buildSuccessCharter(reordered);
ok("canonical hashing ignores property order", reorderedDraft.charterHash === draft.charterHash);

const changed = base();
changed.objectives[0].title = "A different objective";
const changedDraft = await buildSuccessCharter(changed);
ok("content changes the hash", changedDraft.charterHash !== draft.charterHash);

const expected = await successCharterHash({
  schema: SUCCESS_CHARTER_SCHEMA,
  version: SUCCESS_CHARTER_VERSION,
  ...base(),
});
ok("standalone hash helper matches build", expected === draft.charterHash);

// --- validation ------------------------------------------------------------
const validDraft = await validateSuccessCharter(draft);
ok("a valid draft validates", validDraft.ok, validDraft.errors.join("; "));
const validSigned = await validateSuccessCharter(signed, { requireSignatures: true });
ok("a signed charter validates with signatures required", validSigned.ok, validSigned.errors.join("; "));
const unsignedRequired = await validateSuccessCharter(draft, { requireSignatures: true });
ok("signatures are required for a handoff", !unsignedRequired.ok && unsignedRequired.errors.some((e) => e.includes("signature")));

const tampered = { ...draft, objectives: [{ ...draft.objectives[0], title: "tampered" }] };
const tamperedResult = await validateSuccessCharter(tampered);
ok("a changed artifact fails the hash check", !tamperedResult.ok && tamperedResult.errors.some((e) => e.includes("charterHash")));

const missing = { ...draft };
delete missing.charterHash;
const missingResult = await validateSuccessCharter(missing);
ok("missing hash is rejected", !missingResult.ok);

// --- forbidden bearer capabilities ---------------------------------------
await rejects("build rejects a raw room cap in a value", async () => {
  const bad = base();
  bad.group.name = "room cap:room:secret";
  await buildSuccessCharter(bad);
});
await rejects("build rejects a raw room cap in a nested objective", async () => {
  const bad = base();
  bad.objectives[0].keyResults = ["remember cap:room:secret"];
  await buildSuccessCharter(bad);
});
await rejects("build rejects a roomCap field name", async () => {
  const bad = { ...base(), roomCap: "anything" };
  await buildSuccessCharter(bad);
});
const capResult = await validateSuccessCharter({ ...draft, group: { ...draft.group, name: "cap:room:secret" } });
ok("validate rejects a tampered artifact carrying a room cap", !capResult.ok && capResult.errors.some((e) => e.includes("room capability")), capResult.errors.join("; "));

await rejects("dyncap attribution cannot masquerade as member signature", async () => {
  const bad = base(); bad.members[0].signature = "fake"; await buildSuccessCharter(bad);
});
const fakeMemberSig = await validateSuccessCharter({ ...draft, members: [{...draft.members[0], signature:"fake"}] });
ok("reject member signature claim", !fakeMemberSig.ok && fakeMemberSig.errors.some(e=>e.includes("hash-only TOFU")));

// --- shape validation ------------------------------------------------------
await rejects("empty objectives are rejected", async () => {
  const bad = base(); bad.objectives = []; await buildSuccessCharter(bad);
});
await rejects("empty decisions are rejected", async () => {
  const bad = base(); bad.decisions = []; await buildSuccessCharter(bad);
});
await rejects("empty members are rejected", async () => {
  const bad = base(); bad.members = []; await buildSuccessCharter(bad);
});
await rejects("invalid roles are rejected", async () => {
  const bad = base(); bad.members[0].role = "owner"; await buildSuccessCharter(bad);
});
await rejects("negative ratified seq is rejected", async () => {
  const bad = base(); bad.ratifiedAtSeq = -1; await buildSuccessCharter(bad);
});
await rejects("non-string optional fields are rejected", async () => {
  const bad = base(); bad.group.uri = 42; await buildSuccessCharter(bad);
});
await rejects("non-object quorum is rejected", async () => {
  const bad = base(); bad.decisions[0].quorum = "yes"; await buildSuccessCharter(bad);
});

// --- no personal goal fields ----------------------------------------------
const sharedGoalShape = { id: "g-1", text: "private", priority: "important", status: "open" };
ok("goal share shape has no createdAt", !("createdAt" in sharedGoalShape));
const json = JSON.stringify(draft);
ok("artifact has no personal goal store", !json.includes("qos-goals:") && !json.includes("completedAt"));

console.log(`\n${fail === 0 ? "PASS" : "FAIL"}: success-charter.test.mjs — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
