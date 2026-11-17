# #601 — Rholo × QuantumOS: measured functional acceptance matrix

**Scope:** QuantumOS is an outside application over the public Rholo API. No Rholo node plugins, new RPCs, validator configuration, CORS/TLS/admin relaxation, or production operations are part of this work.

**Rholo-side doc PR:** [#604, MERGED](https://github.com/rhovision-org/rholo/pull/604), squash commit 41335ad9347c416f94f2c5e4706caa75f3fce17f; [Patrick APPROVED](https://github.com/rhovision-org/rholo/pull/604#pullrequestreview-5945419252).
**QuantumOS application PR:** [#298, OPEN](https://github.com/rhovision-org/quantum-os/pull/298), head 14e346e73b96eaac6b250db76b616a61c781b58e.
**Independent CI evidence:** [integration run 44153739394](https://github.com/rhovision-org/quantum-os/actions/runs/44153739394) PASS; [QOS CI run 44153739410](https://github.com/rhovision-org/quantum-os/actions/runs/44153739410) PASS.

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
| Two actual browser contexts, WebRTC + encrypted chat | **INCOMPLETE** | Need independent UI traces/peer events with capability redacted |
| /rholang status and eval in browser | **INCOMPLETE** | Need actual UI transcript matching node source, shard and eval result; explicit unsupported response may be BLOCKED |
| Signed throwaway deploy | **PASS — EXECUTED, NOT SETTLED** | Real runner signed deploy reached PROCESSED_WITH_SUCCESS; deployResult was an empty array; result correctness not demonstrated |
| Finalized signed-deploy result | **INCOMPLETE** | last_finalized was UNAVAILABLE (HTTPError); no finality or settlement established |
| /goal identity-scoped add/list/done/share | **INCOMPLETE** | Two-browser identity isolation and sharing transcript required |
| /qos start, /ps, /kill, ownership | **INCOMPLETE** | Independent UI/process lifecycle transcript required |
| Facilitator | **PASS — PROCESS HEALTH ONLY** | Deterministic --no-ai facilitator alive; no independently verified /facil ask reply |
| /gov chain handoff | **INCOMPLETE IN #601 UI** | Separate [QuantumOS #299](https://github.com/rhovision-org/quantum-os/pull/299) and [#291 real-chain test](https://github.com/rhovision-org/quantum-os/actions/runs/44160911903) prove disposable Issue/4 proposal, **not** human council ratification, #601 browser acceptance or finalized settlement |
| up/status/down | **PASS — BUNDLED ONLY** | Owned services started; CI asserted STOPPED after down; **existing-node** mode still needs witnessed no-effect on external node |
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
- **Smallest next gate:** run a CI build of exact pinned current Rholo dev, test with disposable data; independently verify external-node unchanged after harness down; capture two-browser WebRTC /rholang and command traces. Do not touch the four public validators.
