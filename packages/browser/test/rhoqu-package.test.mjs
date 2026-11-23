import { build } from "esbuild";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const bundle = await build({
  stdin: { contents: 'export { createRhoProcessPackage, serializeRhoProcessPackage, importRhoProcessPackage } from "./src/rhoqu-package.ts"; export { transpileProcess } from "./src/rhoqu.ts"; export { executeRhoProcessAsync } from "./src/rhoqu-process.ts";', resolveDir: root, loader: "ts", sourcefile: "rhoqu-package-test-entry.ts" },
  bundle: true, format: "esm", platform: "node", write: false,
});
const { createRhoProcessPackage, serializeRhoProcessPackage, importRhoProcessPackage, transpileProcess, executeRhoProcessAsync } = await import(
  "data:text/javascript;base64," + Buffer.from(bundle.outputFiles[0].text).toString("base64")
);
let pass = 0, fail = 0;
const ok = (name, condition, detail = "") => {
  if (condition) { pass++; console.log("  ok   " + name); }
  else { fail++; console.log("  FAIL " + name + (detail ? " (" + detail + ")" : "")); }
};
const process = { kind: "sequence", steps: [
  { kind: "command", command: "/poll new shared", bind: "pollId" },
  { kind: "parallel", branches: [
    { kind: "sequence", steps: [{ kind: "command", command: "/poll add $pollId A" }] },
    { kind: "sequence", steps: [{ kind: "when", condition: { kind: "call", name: "connected", args: [] }, env: {}, then: { kind: "sequence", steps: [{ kind: "command", command: "/send ready" }] } }] },
  ] },
]};
const provenance = { authorAnchor: "a".repeat(64), exportedAt: "2026-11-21T00:00:00.000Z", source: "rhoqu-golden-test" };
const packageOne = await createRhoProcessPackage(process, provenance);
const serialized = await serializeRhoProcessPackage(process, provenance);
const imported = await importRhoProcessPackage(serialized);
ok("package export contains canonical format and SHA-256", packageOne.format === "rho-process-package" && packageOne.contentHash.length === 64 && serialized === JSON.stringify(JSON.parse(serialized)));
ok("import preserves typed process and provenance", isDeepStrictEqual(imported.process, process) && imported.provenance.authorAnchor === provenance.authorAnchor && imported.provenance.source === provenance.source);
const goldenSource = "bind pollId /poll new Decision; /poll add $pollId Option A; /poll status $LAST_ID;";
const goldenIR = transpileProcess(goldenSource);
const goldenPackage = await serializeRhoProcessPackage(goldenIR, provenance);
const goldenImport = await importRhoProcessPackage(goldenPackage);
const goldenCommands = [];
const goldenResults = await executeRhoProcessAsync(goldenImport.process, command => {
  goldenCommands.push(command);
  return command === "/poll new Decision" ? { lines: ["created"], id: "poll-real-golden" } : [command];
});
ok("source → IR → package → import → execution preserves ID bindings", goldenCommands.join("|") === "/poll new Decision|/poll add poll-real-golden Option A|/poll status poll-real-golden" && goldenResults.length === 3 && goldenResults.every(result => result.ok));
const reordered = { provenance: { source: provenance.source, exportedAt: provenance.exportedAt, authorAnchor: provenance.authorAnchor }, process: process, version: 1, format: "rho-process-package" };
const packageTwo = await createRhoProcessPackage(reordered.process, reordered.provenance);
ok("canonical hash is stable across object key ordering", packageOne.contentHash === packageTwo.contentHash);
const optionalSourcePackage = await serializeRhoProcessPackage(process, { authorAnchor: provenance.authorAnchor, exportedAt: provenance.exportedAt, source: undefined });
const optionalSourceImported = await importRhoProcessPackage(optionalSourcePackage);
ok("canonical JSON omits undefined optional provenance fields and round-trips", !Object.hasOwn(JSON.parse(optionalSourcePackage).provenance, "source") && optionalSourceImported.provenance.source === undefined);
const tampered = JSON.parse(serialized);
tampered.process.steps[0].command = "/poll new tampered";
let tamperRejected = false;
try { await importRhoProcessPackage(tampered); } catch (error) { tamperRejected = String(error).includes("hash mismatch"); }
ok("import rejects content tampering", tamperRejected);
let schemaRejected = false;
try { await importRhoProcessPackage(JSON.stringify({ format: "rho-process-package", version: 99 })); } catch (error) { schemaRejected = String(error).includes("schema validation"); }
ok("import rejects unsupported schema", schemaRejected);
const unknownField = JSON.parse(serialized);
unknownField.process.steps[0].extra = { label: "unsupported" };
let rejectedUnknownField = false;
try { await importRhoProcessPackage(unknownField); }
catch (error) { rejectedUnknownField = String(error).includes("schema validation"); }
ok("package rejects undeclared IR extension fields before hashing", rejectedUnknownField);
let anchorRejected = false;
try { await createRhoProcessPackage(process, { authorAnchor: "not-a-dyncap-anchor", exportedAt: provenance.exportedAt }); } catch (error) { anchorRejected = String(error).includes("schema validation"); }
ok("package rejects malformed dyncap anchor", anchorRejected);
let emptyCommandRejected = false;
try { await createRhoProcessPackage({ kind: "sequence", steps: [{ kind: "command", command: "  " }] }, provenance); } catch (error) { emptyCommandRejected = String(error).includes("schema validation"); }
ok("package rejects empty command nodes", emptyCommandRejected);
let invalidParallelRejected = false;
try { await createRhoProcessPackage({ kind: "sequence", steps: [{ kind: "parallel", branches: [{ kind: "command", command: "/only-one" }] }] }, provenance); } catch (error) { invalidParallelRejected = String(error).includes("schema validation"); }
ok("package rejects parallel with fewer than two branches", invalidParallelRejected);
let invalidTimestampRejected = false;
try { await createRhoProcessPackage(process, { ...provenance, exportedAt: "not-a-date" }); } catch (error) { invalidTimestampRejected = String(error).includes("schema validation"); }
ok("package rejects invalid export timestamp", invalidTimestampRejected);
let deepTree = { kind: "command", command: "/deep" };
for (let i = 0; i < 70; i++) deepTree = { kind: "sequence", steps: [deepTree] };
let depthRejected = false;
try { await importRhoProcessPackage({ format: "rho-process-package", version: 1, provenance, process: deepTree, contentHash: "0".repeat(64) }); } catch (error) { depthRejected = String(error).includes("schema validation"); }
ok("import rejects deeply nested process trees", depthRejected);
let oversizedRejected = false;
try { await importRhoProcessPackage(" ".repeat(1_048_577)); } catch (error) { oversizedRejected = String(error).includes("size limit"); }
ok("import rejects oversized package input", oversizedRejected);
const oversizedObjectProcess = { kind: "sequence", steps: Array.from({ length: 180 }, () => ({ kind: "command", command: "/" + "x".repeat(6000) })) };
let oversizedObjectRejected = false;
try { await importRhoProcessPackage({ format: "rho-process-package", version: 1, provenance, process: oversizedObjectProcess, contentHash: "0".repeat(64) }); } catch (error) { oversizedObjectRejected = String(error).includes("size limit"); }
ok("object import rejects oversized canonical package before hash verification", oversizedObjectRejected);
let oversizedCreationRejected = false;
try { await createRhoProcessPackage(oversizedObjectProcess, provenance); } catch (error) { oversizedCreationRejected = String(error).includes("size limit"); }
ok("package creation rejects oversized canonical payload", oversizedCreationRejected);
const mutable = JSON.parse(serialized);
const inFlightImport = importRhoProcessPackage(mutable);
mutable.process.steps[0].command = "/mutated while digest pending";
mutable.provenance.authorAnchor = "b".repeat(64);
const snapshotImport = await inFlightImport;
ok("import returns original hashed bytes despite caller mutation", snapshotImport.process.steps[0].command === process.steps[0].command && snapshotImport.provenance.authorAnchor === provenance.authorAnchor && Object.isFrozen(snapshotImport.process.steps[0]));
const mutableProcess = JSON.parse(JSON.stringify(process));
const inFlightCreate = createRhoProcessPackage(mutableProcess, provenance);
mutableProcess.steps[0].command = "/mutated while export digest pending";
const snapshotExport = await inFlightCreate;
ok("export returns original hashed bytes and immutable process", snapshotExport.process.steps[0].command === process.steps[0].command && Object.isFrozen(snapshotExport.process.steps[0]));
ok("snapshot export can be independently imported", (await importRhoProcessPackage(snapshotExport)).contentHash === snapshotExport.contentHash);
console.log("\n" + (fail === 0 ? "PASS" : "FAIL") + ": rhoqu-package.test.mjs — " + pass + " passed, " + fail + " failed");
globalThis.process.exit(fail === 0 ? 0 : 1);
