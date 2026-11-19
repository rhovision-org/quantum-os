# RhoQu v2: typed, human-approved execution

Tracking issue: quantum-os#290. This is an opt-in runtime and signed
process-package format. It does not change QOS/1, the existing signer, or
the original /rhoqu command pipeline. Lean RhoQuCalc remains a design/proof
layer; this runtime has **no independent Lean verification claim**.

## Browser commands

| Command | Effect |
| --- | --- |
| /rhoqu v2 help | Describe the opt-in runtime. |
| /rhoqu v2 preview SOURCE | Compile typed IR and display all potential commands from both sides of runtime branches; do not execute. |
| /rhoqu v2 approve TOKEN | Consume a one-use, 10-minute room/identity-scoped token and ask a second human confirmation before dispatch. |
| /rhoqu v2 cancel TOKEN | Invalidate a pending preview. |
| /rhoqu v2 export SOURCE | Explicitly sign a content-addressed process package; do not automatically send it to peers. |
| /rhoqu v2 import BASE64URL | Verify the package, pin the signer only after explicit TOFU confirmation, then preview, without execution. |

Directly typed legacy /rhoqu SOURCE remains compatible. Imported,
agent-authored, and otherwise untrusted source must use the v2 preview
or signed import path, never the direct legacy path.

## Example

    let poll = /poll new Charter decision;
    /poll add $poll approve;
    /poll add $LAST_ID reject;
    when peers() >= 2 {
      /poll status $poll;
    } else {
      /goal review;
    }
    require connected();

- let NAME = /command captures the actual ID newly observed in the
  existing application state after the original command returns.
  Zero/multiple IDs reject the binding. It never guesses an ID from a
  timestamp, success-looking chat text, or a hash prediction.
- $NAME substitutes the bound ID and $LAST_ID refers to the last actual
  result ID. Unknown variables fail closed; $$ yields a literal dollar sign.
- when samples the current room state at the point of execution, and
  require stops execution on a failed runtime closure condition.
  Existing if remains compile-time for backwards compatibility.
- Existing parallel stays ordered/sequential. The new concurrent construct
  runs only independent read-only branches concurrently with Promise-style
  join; branch results are reported in authored order. It is not a
  distributed/multi-peer scheduler or consensus operation.
- Legacy process calls and new/grant preserve their substitution behavior.
  v2 intentionally rejects on handlers until an explicit incoming-event
  approval model is implemented; legacy /rhoqu still supports those.

## IR and authorization

The surface parser is a versioned rhoqu.surface.ir/1 object. The opt-in
runtime uses rhoqu.process.ir/1 containing typed command, when, require
and concurrent nodes. Its execution mode is explicit-approval and its
verification value must be unverified. Neither field grants a capability.

Imported JSON is structurally validated with instruction/depth limits.
Forged read/write effects and falsified proof claims are rejected.

Conservative effects: read, room-write, value-write, chain-write. The
browser execution adapter refuses generic chain writes and value-moving
operations with ambiguous remote outcomes; the ordinary command/editor
workflow remains available. It uses the original permission checks for
the allowed command set. A local dispatch receipt is NOT a chain-admission,
committee-ratification, finality or Lean-verification result.

The app observes real before/after room-store IDs for poll, lemma, note,
currency, rendezvous, QOS process, goal, group, and issue creation. The
runtime only binds an ID if exactly one new matching entry appeared. For
other command classes, the original dispatcher has no universal
asynchronous structured completion contract, so the only justified
claim is dispatch, not remote success. A partial failure does not roll
back earlier effects or trigger an automatic retry.

## Shareable package security

A rhoqu.process.package/1 object binds canonical JSON source, execution
IR, an effect/capability manifest, and an asserted dyncap anchor and
signer key under SHA-256 and a genuine Ed25519 signature. The package
is content-addressed. No dyncap seed is exported. The signing key is
derived locally with domain separation from the author's seed.

The Ed25519 signature proves package integrity relative to the
presented public key. It DOES NOT independently prove that a remote
claimed dyncap anchor corresponds to that key. First use is explicitly
TOFU. An operator confirms the anchor-key pin, stored in local
identity-scoped settings, and later different keys are rejected.

Imported packages undergo signature, digest, capability and source/IR
congruence checks for the current room snapshot. Receiving a signed
package does not automatically execute any command, contact a node,
broadcast, or accept an agent output. Raw room bearer capabilities are
refused. Private goals and habits are not implicitly exported.

## Focused CI

    node packages/browser/test/rhoqu-surface-ir.test.mjs
    node packages/browser/test/rhoqu-success-recipes.test.mjs
    node packages/browser/test/rhoqu-process.test.mjs
    node packages/browser/test/rhoqu-result.test.mjs
    node packages/browser/test/rhoqu-package.test.mjs

The normal GitHub workflow builds WASM before running the full browser
TypeScript gate. A mobile checkout without generated WASM bindings can
run pure tests but cannot certify the full browser integration locally.

## Not claimed

No independently machine-checked Lean-to-runtime equivalence, universal
distributed deterministic replay, Byzantine concurrency, unambiguous
structured results for all asynchronous commands, verified on-chain
finality, autonomous signing, or cross-room package dissemination.

This feature is implementation/test evidence; maintainer review and
merge are separate decisions.
