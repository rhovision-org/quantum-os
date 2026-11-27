# #601 — Rholo × QuantumOS: measured functional acceptance matrix

**Scope:** QuantumOS is an outside application over the public Rholo API. No Rholo node plugins, new RPCs, validator configuration, CORS/TLS/admin relaxation, or production operations are part of this work.

**Rholo-side doc PR:** [#604, MERGED](https://github.com/rhovision-org/rholo/pull/604), squash commit 41335ad9347c416f94f2c5e4706caa75f3fce17f; [Patrick APPROVED](https://github.com/rhovision-org/rholo/pull/604#pullrequestreview-5945419252).
**QuantumOS application PR:** [#298, OPEN](https://github.com/rhovision-org/quantum-os/pull/298), current head 49541a0218d26fb7cc2a7d06b25b40e6ebe3acec (facilitator acceptance assertion added).
**Prior code-head CI evidence (f00d68f):** [integration run 44511582996](https://github.com/rhovision-org/quantum-os/actions/runs/44511582996) PASS and [general CI run 44511583003](https://github.com/rhovision-org/quantum-os/actions/runs/44511583003) PASS. That integration run executed browser acceptance against two Chromium contexts; direct WebRTC, chat, `/rholang status`, read-only `/rholang eval return!(42)`, goal completion/privacy/share, and QOS start/status/ps passed. **Current-head CI (49541a0):** [general run 44512222909](https://github.com/rhovision-org/quantum-os/actions/runs/44512222909) PASS; [integration run 44512222944](https://github.com/rhovision-org/quantum-os/actions/runs/44512222944) is still pending at Playwright Chromium installation, so the newly added in-room facilitator FAQ assertion is not yet promoted. Earlier artifact provenance remains preserved below and is not promoted beyond its stated scope.

## Provenance and non-promotions

- Evidence source is an **actual disposable Rholo process on an isolated GitHub runner**, not a local mock and **not** any of the four public testnet validators.
- Its reported Rholo source is **bc80abbba42661f0252c04f931e6a4ac58bb6737**, the **historical bundled QuantumOS binary**, **not current Rholo dev**. The synthetic GitHub Actions PR checkout SHA was a2f49b2df912bd42cd272db9a1d3463899a35ddb, distinct from QOS PR head 14e346e.
- Its node-reported shard is /root and network name is testnet **inside the disposable runner**; this name does NOT imply the public four-validator testnet was accessed.
- Evidence JSON and status from the actual CI artifact were downloaded and rechecked with the original SHA256SUMS. Originals are committed at [verification/issue-601/run-44153739394](../../verification/issue-601/run-44153739394).
- Expected binary source, finality and independent browser results MUST NOT be inferred from a successful health endpoint.

## Exact acceptance matrix

| Functional gate | Verdict | Observed evidence / next smallest check |
|---|---|---|
| Rholo docs are docs-only and approved | **PASS / MERGED** | #604: exactly one operator page and sidebar; all Rholo CI required checks passed; no node changes |
| QuantumOS dependencies / browser / Signaling build | **PASS — CI** | #298 normal CI and integration run 44153739394 |
| Disposable Rholo public HTTP status | **PASS — BUNDLED HISTORICAL BINARY** | Actual Node PID active; status returns source, network and shard; current dev NOT tested |
| Browser host HTTPS and /rnode proxy | **PASS — ROUTING ONLY** | Real CI curl of browser path and proxied /api/status; not a human browser session |
| Two independent Signaling WebSocket clients | **PASS — WEBSOCKET ONLY** | Peer discovery and opaque-message relay via real WebSocket; **NOT** two-browser WebRTC or encrypted chat proof |
| Two actual browser contexts, direct WebRTC + chat | **PASS — CI** | Run 44453360581: both browsers discover each other; both report open direct WebRTC data channels; chat reaches the second browser |
| /rholang status and read-only eval in browser | **PASS — CI** | Run 44511582996: status returned node version and `/rholang eval return!(42)` returned the expected value from the disposable bundled node |
| Signed throwaway deploy | **PASS — EXECUTED, NOT SETTLED** | Real runner signed deploy reached PROCESSED_WITH_SUCCESS; deployResult was an empty array; result correctness not demonstrated |
| Finalized signed-deploy result | **INCOMPLETE** | last_finalized was UNAVAILABLE (HTTPError); no finality or settlement established |
| /goal add/list | **PASS — CI** | Run 44453360581 proved add/list on the initiating browser |
| /goal done + two-identity privacy + explicit share | **PASS — CI** | Run 44453360581: completion on owner identity; second identity cannot see private goal; explicit share reaches second browser |
| /qos start/status/ps | **PASS — CI** | Run 44453360581: browser starts process and reports status/events and process table |
| /qos suspend/resume/terminate/kill + owner enforcement | **PASS — UNIT TESTS** | `qos-command.test.mjs`: 28/28 local; current general CI 44512222909 includes the QOS command test. Browser smoke still covers start/status/ps only |
| Facilitator | **FAQ SELFTEST PASS; BROWSER PENDING** | Deterministic FAQ selftest passes in general CI 44512222909; in-room `/facil ask` response assertion added, integration run 44512222944 pending |
| /gov chain handoff | **INCOMPLETE IN #601 UI** | Separate [QuantumOS #299](https://github.com/rhovision-org/quantum-os/pull/299) and [#291 real-chain test](https://github.com/rhovision-org/quantum-os/actions/runs/44160911903) prove disposable Issue/4 proposal, **not** human council ratification, #601 browser acceptance or finalized settlement |
| up/status/down | **PASS — BUNDLED ONLY** | Latest integration run starts and stops harness-owned services and asserts STOPPED; **existing-node** mode has not been witnessed against an external node |
| Source-to-binary provenance for current Rholo dev | **BLOCKED** | Build pinned CURRENT dev SHA from source on GitHub runner, record executable SHA-256 and reported source; run only on disposable data |
| Public four-validator #584 G1–G6 | **NOT EXECUTED / OUT OF SCOPE** | #584 remains its own preflight and authorization boundary |

## File verification

These four files were copied unchanged from the actual GitHub Actions artifact: qos601-status.txt, qos601-signaling.json, qos601-signed-deploy.json, and qos601-status.SHA256SUMS.

Run the following from verification/issue-601/run-44153739394: sha256sum -c qos601-status.SHA256SUMS

Verified artifact SHA-256:
- qos601-status.txt: 9ed1c2335e4c3bc7bd7e3bff77e916d8cbb8bfbccaba0ce353c97e5cd4e03827
- qos601-signaling.json: e613251da6b6712d33b65c9c207eb331a8d86248eaa3c70e627454d9dceb67b8
- qos601-signed-deploy.json: f4951e34f27203288f72057fe06c5578354d13786f4f404adeefb579df89afe4

## Merge and issue disposition

- **#604 merged** as Patrick approved: documentation and provenance boundary complete.
- **#298 remains open** pending the application-side review; nothing in #604 enables or schedules /goal, /qos, /gov chain, RhoQu v2 or other future QOS-specific Rholo node surfaces.
- **#601 remains OPEN** until all required functions have direct source-pinned evidence or an explicitly accepted BLOCKED outcome. An INCOMPLETE row must not be silently promoted to PASS.
- **Next gates:** /rholang browser status/eval transcript; source-to-binary provenance for a pinned current Rholo dev build; external-node no-effect evidence for `--existing-node`; signed deploy settlement/finality; and governance handoff. Rholo-dependent gates are deliberately deferred until the upstream data and replay inputs are available. Do not touch the four public validators.

### Follow-up: existing-node lifecycle guard and witness

Prior head e2cf26c completed general CI [44512933019](https://github.com/rhovision-org/quantum-os/actions/runs/44512933019) and integration [44512932982](https://github.com/rhovision-org/quantum-os/actions/runs/44512932982), including the deterministic in-room facilitator FAQ assertion. This supersedes the earlier pending facilitator status above.

The follow-up requires a recorded ownership marker and matching process birth identity; existing-node shutdown refuses unexpected lifecycle targets before signaling. Eleven operator-contract tests passed remotely, including one independently launched dummy process. The new runner-only witness independently starts a disposable bundled binary, attaches QOS in existing-node mode, and compares node PID, birth, executable hash, version, shard, and HTTP availability before/during/after QOS shutdown. Its real-node execution is pending CI. This is a bounded lifecycle and routing witness, not a proof of immutable chain state, finality, current upstream build provenance, or public-validator acceptance.

### Runner isolation correction

Run [44932818452](https://github.com/rhovision-org/quantum-os/actions/runs/44932818452) passed the bundled lifecycle and browser stages but failed at the independent witness's preflight bind (EADDRINUSE on 40403). That failure does not establish whether a listener remained or TCP state prevented reuse. The independent witness now runs in its own fresh runner job, retains strict free-port checks, verifies the process executable digest against the selected binary, and uploads separately checksummed evidence. No retry that adopts an unknown listener, port reuse workaround or forced kill is introduced. New execution pending.
