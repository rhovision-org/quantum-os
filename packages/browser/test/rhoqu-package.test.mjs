import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const bundle = await build({
  stdin: { contents: 'export { createRhoProcessPackage, serializeRhoProcessPackage, importRhoProcessPackage } from "./src/rhoqu-package.ts";', resolveDir: root, loader: "ts", sourcefile: "rhoqu-package-test-entry.ts" },
  bundle: true, format: "esm", platform: "node", write: false,
});
const { createRhoProcessPackage, serializeRhoProcessPackage, importRhoProcessPackage } = await import(
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
const provenance = { authorAnchor: "dyncap-anchor-test", exportedAt: "2026-11-21T00:00:00.000Z", source: "rhoqu-golden-test" };
const packageOne = await createRhoProcessPackage(process, provenance);
const serialized = await serializeRhoProcessPackage(process, provenance);
const imported = await importRhoProcessPackage(serialized);
ok("package export contains canonical format and SHA-256", packageOne.format === "rho-process-package" && packageOne.contentHash.length === 64 && serialized === JSON.stringify(JSON.parse(serialized)));
ok("import preserves typed process and provenance", JSON.stringify(imported.process) === JSON.stringify(process) && imported.provenance.authorAnchor === provenance.authorAnchor && imported.provenance.source === provenance.source);
const reordered = { provenance: { source: provenance.source, exportedAt: provenance.exportedAt, authorAnchor: provenance.authorAnchor }, process: process, version: 1, format: "rho-process-package" };
const packageTwo = await createRhoProcessPackage(reordered.process, reordered.provenance);
ok("canonical hash is stable across object key ordering", packageOne.contentHash === packageTwo.contentHash);
const tampered = JSON.parse(serialized);
tampered.process.steps[0].command = "/poll new tampered";
let tamperRejected = false;
try { await importRhoProcessPackage(tampered); } catch (error) { tamperRejected = String(error).includes("hash mismatch"); }
ok("import rejects content tampering", tamperRejected);
let schemaRejected = false;
try { await importRhoProcessPackage(JSON.stringify({ format: "rho-process-package", version: 99 })); } catch (error) { schemaRejected = String(error).includes("schema validation"); }
ok("import rejects unsupported schema", schemaRejected);
console.log("\n" + (fail === 0 ? "PASS" : "FAIL") + ": rhoqu-package.test.mjs — " + pass + " passed, " + fail + " failed");
process.exit(fail === 0 ? 0 : 1);

