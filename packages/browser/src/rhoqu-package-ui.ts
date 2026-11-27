import { importRhoProcessPackage, serializeRhoProcessPackage, type RhoProcessProvenance } from "./rhoqu-package.js";
import type { RhoProcessNode, RhoSequenceNode } from "./rhoqu-process.js";
import { transpilePackageProcess } from "./rhoqu.js";

export function formatRhoQuProcess(node: RhoProcessNode, depth = 0): string {
  const pad = "  ".repeat(depth);
  if (node.kind === "command") return `${pad}${node.bind ? `bind ${node.bind} ` : ""}${node.command}`;
  if (node.kind === "sequence") return node.steps.map((n) => formatRhoQuProcess(n, depth)).join("\n");
  if (node.kind === "parallel") return `${pad}parallel {\n${node.branches.map((b) => formatRhoQuProcess(b, depth + 1)).join("\n\n")}\n${pad}}`;
  return `${pad}when ${JSON.stringify(node.condition)} {\n${formatRhoQuProcess(node.then, depth + 1)}\n${pad}}${node.else ? ` else {\n${formatRhoQuProcess(node.else, depth + 1)}\n${pad}}` : ""}`;
}
function download(text: string, name: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const a = document.createElement("a"); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
export function openRhoQuPackageUI(authorAnchor?: string): void {
  const overlay = document.createElement("div");
  overlay.style.cssText = "position:fixed;inset:0;z-index:10050;background:rgba(0,0,0,.65);display:flex;align-items:center;justify-content:center;padding:12px";
  const card = document.createElement("section");
  card.style.cssText = "width:min(860px,100%);max-height:95vh;overflow:auto;background:#1b1d23;color:#e8e8ea;border:1px solid #41444d;border-radius:10px;padding:16px;font:13px/1.5 system-ui";
  const heading = document.createElement("h2"); heading.textContent = "RhoQu Process Packages";
  heading.style.cssText = "margin:0 0 4px;font-size:16px";
  const help = document.createElement("p"); help.textContent = "Create a package from source or import a package file. Import validates schema and hash; imported content is preview-only and never executes.";
  help.style.cssText = "opacity:.75;margin:0 0 10px";
  const anchor = document.createElement("input"); anchor.value = authorAnchor ?? ""; anchor.placeholder = "64-hex dyncap author anchor"; anchor.setAttribute("aria-label","Author anchor");
  anchor.style.cssText = "width:100%;box-sizing:border-box;background:#111318;color:#eee;border:1px solid #444;border-radius:6px;padding:8px;margin:0 0 8px;font:12px monospace";
  const source = document.createElement("textarea"); source.placeholder = "process Example() { /poll new Decision; }\nExample();"; source.style.cssText = "width:100%;min-height:130px;box-sizing:border-box;background:#111318;color:#eee;border:1px solid #444;border-radius:6px;padding:8px;font:12px/1.5 monospace;resize:vertical";
  const file = document.createElement("input"); file.type = "file"; file.accept = ".json,application/json"; file.style.display = "none";
  const previewBox = document.createElement("pre"); previewBox.style.cssText = "white-space:pre-wrap;max-height:220px;overflow:auto;background:#111318;border:1px solid #444;border-radius:6px;padding:8px;font:12px/1.5 monospace"; previewBox.textContent = "Process preview will appear here.";
  const status = document.createElement("div"); status.style.cssText = "min-height:18px;margin:6px 0;font:12px monospace;white-space:pre-wrap";
  const buttons = document.createElement("div"); buttons.style.cssText = "display:flex;gap:7px;flex-wrap:wrap;justify-content:flex-end;margin-top:8px";
  const mk = (label: string): HTMLButtonElement => { const b=document.createElement("button"); b.textContent=label; b.style.cssText="background:#292c34;color:#eee;border:1px solid #444;border-radius:6px;padding:7px 10px;cursor:pointer"; return b; };
  const importBtn=mk("Import package…"), previewBtn=mk("Preview source"), exportBtn=mk("Export package"), closeBtn=mk("Close");
  buttons.append(importBtn,previewBtn,exportBtn,closeBtn);
  card.append(heading,help,anchor,source,previewBox,status,buttons,file); overlay.append(card); document.body.appendChild(overlay);
  let imported: { process: RhoSequenceNode; provenance: RhoProcessProvenance } | null = null;
  let revision = 0;
  const setStatus = (message: string, ok: boolean): void => {
    status.textContent = message;
    status.style.color = ok ? "#8bd49a" : "#f87171";
  };
  const close = (): void => { revision++; overlay.remove(); };
  closeBtn.onclick = close;
  overlay.addEventListener("click", (event) => { if (event.target === overlay) close(); });
  source.addEventListener("input", () => {
    revision++;
    imported = null;
    previewBox.textContent = "Preview the edited source.";
    status.textContent = "";
  });
  importBtn.onclick = () => file.click();
  previewBtn.onclick = () => {
    try {
      const process = imported?.process ?? transpilePackageProcess(source.value);
      if (!imported) previewBox.textContent = formatRhoQuProcess(process);
      setStatus("Preview ready: " + process.steps.length + " top-level steps.", true);
    } catch (error) {
      previewBox.textContent = "";
      setStatus(String(error), false);
    }
  };
  exportBtn.onclick = async () => {
    const current = revision;
    try {
      const process = imported?.process ?? transpilePackageProcess(source.value);
      const provenance = imported?.provenance ?? {
        authorAnchor: anchor.value.trim(), exportedAt: new Date().toISOString(), source: "RhoQu source editor",
      };
      const serialized = await serializeRhoProcessPackage(process, provenance);
      if (current !== revision) return;
      download(serialized, "rhoqu-process-package.json");
      setStatus("Exported package · SHA-256 " + JSON.parse(serialized).contentHash, true);
    } catch (error) {
      if (current === revision) setStatus(String(error), false);
    }
  };
  file.onchange = async () => {
    const selected = file.files?.[0];
    file.value = "";
    if (!selected) return;
    const current = ++revision;
    imported = null;
    previewBox.textContent = "";
    setStatus("Validating package…", true);
    try {
      if (selected.size > 1_048_576) throw new Error("Package exceeds size limit.");
      const pkg = await importRhoProcessPackage(await selected.text());
      if (current !== revision) return;
      imported = pkg;
      source.value = "";
      previewBox.textContent = formatRhoQuProcess(pkg.process);
      const lines = [
        "Import validated · SHA-256 " + pkg.contentHash,
        "Claimed author anchor (unverified): " + pkg.provenance.authorAnchor,
        "Exported: " + pkg.provenance.exportedAt,
      ];
      if (pkg.provenance.source) lines.push("Source: " + pkg.provenance.source);
      setStatus(lines.join("\n"), true);
    } catch (error) {
      if (current === revision) setStatus(String(error), false);
    }
  };
}
