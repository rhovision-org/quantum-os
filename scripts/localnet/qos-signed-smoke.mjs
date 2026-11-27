#!/usr/bin/env node
// #601 CI-only real signed deploy against the *bundled throwaway* local Rholo
// node. Never against a public testnet; no secret material is logged.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_CONFIG, nodeStatus, deployTerm } from "../qos-cli/rholang-client.mjs";

const stop = (s) => { console.error("qos-signed-smoke: " + s); process.exit(1); };
if (process.env.GITHUB_ACTIONS !== "true" || !process.env.QOS_RUN_DIR) {
  stop("CI-only: requires disposable runner and QOS_RUN_DIR");
}
const state = JSON.parse(readFileSync(join(process.env.QOS_RUN_DIR, "state.json"), "utf8"));
if (state.mode !== "bundled" || state.node_url !== "http://127.0.0.1:40403" || !state.services?.node?.started_by_harness) {
  stop("refusing non-bundled / non-loopback node");
}
const NODE = "http://127.0.0.1:40403";
const status = await nodeStatus({ url: NODE });
if (!status.shardId || !status.networkId) stop("shard/network identity is missing");
const pk = readFileSync(new URL("./pk.txt", import.meta.url), "utf8");
const key = pk.split("\n").find((line) => line.startsWith("deployer="))?.split("=")[1]?.trim();
if (!/^[0-9a-f]{64}$/i.test(key ?? "")) stop("bundled disposable deployer key not available");
const cfg = { ...DEFAULT_CONFIG, url: NODE, shard: status.shardId, key, phloLimit: 500_000 };
const start = new Date().toISOString();
const response = await deployTerm(cfg, "return!(601)", { waitAttempts: 0 });
if (!response.ok || typeof response.sig !== "string") {
  stop("signed deploy not admitted: " + String(response.message).slice(0, 120));
}
let observed = "ACCEPTED_ONLY";
let detail = {};
for (let i = 0; i < 30; i++) {
  await new Promise((resolve) => setTimeout(resolve, 2000));
  try {
    const r = await fetch(NODE + "/api/v1/deploy-status/" + encodeURIComponent(response.sig));
    if (!r.ok) continue;
    const body = await r.json();
    if (body.ProcessedWithError) {
      stop("signed deploy was executed with an error");
    }
    if (body.ProcessedWithSuccess) {
      observed = "PROCESSED_WITH_SUCCESS";
      detail = {deployResultPresent: Array.isArray(body.ProcessedWithSuccess.deployResult),
                resultLength: body.ProcessedWithSuccess.deployResult?.length ?? null};
      break;
    }
  } catch {}
}
const evidence = {
  record_type: "qos601_ci_disposable_signed_deploy",
  start_utc: start,
  end_utc: new Date().toISOString(),
  node_origin: "loopback-bundled-rholo-on-isolated-gh-runner",
  shard_id: status.shardId,
  network_id: status.networkId,
  admitted: true,
  execution_stage: observed,
  result_summary: detail,
  finality_or_settlement_verified: false,
  scope: "CI-hosted disposable development chain; NOT public testnet or #584 G1–G6",
};
writeFileSync("qos601-signed-deploy.json", JSON.stringify(evidence, null, 2) + "\n", { mode: 0o600 });
console.log("Signed disposable deploy:", observed, "shard:", status.shardId);
if (observed !== "PROCESSED_WITH_SUCCESS") stop("no processed-success observation; not claiming result as pass");
// Deliberately never write a key, signature, deploy-id, raw room URL, or wallet.
// Inclusion/execution does not establish finality or settlement.
