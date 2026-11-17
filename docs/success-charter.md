# Success charter handoff

`success-charter/1` is the canonical artifact for the **required** handoff from a
ratified QuantumOS group charter to RhoGov/Rholo. The builder and validator live
in `packages/browser/src/success-charter.ts` and are pure: no DOM, storage,
network, or chain write.

The chain submission and status query are tracked in
[#291](https://github.com/rhovision-org/quantum-os/issues/291). This document
defines the artifact and the lifecycle; it does not claim the on-chain half is
implemented yet.

## Shape

```json
{
  "schema": "success-charter/1",
  "version": 1,
  "group": { "id": "grp-…", "name": "…", "uri": "…" },
  "objectives": [
    { "id": "obj-1", "title": "…", "keyResults": ["…"], "owner": "cap:peer/dyn:…" }
  ],
  "decisions": [
    { "issueId": "i-1", "pollId": "p-1", "lemmaHash": "…", "result": "adopted", "quorum": { "yes": 3, "no": 1 } }
  ],
  "members": [
    { "anchor": "cap:peer/dyn:…", "role": "admin", "signature": "…" },
    { "anchor": "cap:peer/dyn:…", "role": "member" }
  ],
  "ratifiedAtSeq": 42,
  "proposer": "cap:peer/dyn:…",
  "charterHash": "…",
  "signatures": ["…"]
}
```

## Canonical hash

- The hash is SHA-256 over canonical JSON of the **content**: schema, version,
  group, objectives, decisions, members, `ratifiedAtSeq`, and `proposer`.
- `charterHash` and `signatures` are excluded, so signing does not change the id.
- Canonical JSON sorts object keys; reordering fields does not change the hash.
- The hash is the idempotency key for the handoff.

## Validation

`validateSuccessCharter(value, { requireSignatures })` checks:

- schema and version;
- non-empty group id/name, at least one objective, decision, and member;
- valid roles (`admin` / `member`), key-result strings, and quorum shape;
- non-negative integer `ratifiedAtSeq` and a non-empty proposer;
- lowercase 64-hex `charterHash`, recomputed and compared;
- signatures are non-empty strings; a handoff requires at least one;
- **no raw room capability** anywhere in a value or field name.

A draft may be unsigned for preview. A handoff must be signed and authorized by
the group decision.

## Required lifecycle

1. The group ratifies the charter through `/gov` + `/poll`/`/vote`.
2. The decision is recorded with `/lemma`; ids/hashes are captured.
3. The group builds `success-charter/1` and previews the exact payload.
4. An authorized member triggers the handoff; signing uses the existing dyncap
   identity.
5. The handoff submits through the existing RhoGov/Rholo path with the charter
   hash as the idempotency key.
6. The group records the proposal id + charter hash.
7. A read-only status query returns `pending | approved | rejected | unknown`.

Failure leaves the off-chain record intact and reports the error. There is no
automatic re-handoff and no silent chain write.

## Security boundaries

- **Never export `cap:room:…`.** It is a bearer secret; use the group id/hash and
  a display label.
- Personal goals, habits, and private notes are not part of the artifact.
- The artifact is signed with the existing dyncap identity; group authorization
  is the existing group decision, not a new root.
- AI may draft or summarize a charter, but cannot sign or trigger the handoff.

## Status

| Piece | State |
|---|---|
| canonical builder/validator + tests | implemented |
| no-room-cap / no-personal-state checks | implemented |
| chain submission + status query | #291, cross-repo |
| compact group panel | later |

Tests: `packages/browser/test/success-charter.test.mjs`.


## Concrete RhoGov Issue/4 transport — #291

This is a **human-authorized**, never automatic chain action. A group must
already have a known `Group/4` and `Issue/4` registry URI, and the signer's
existing REV wallet must be a member and admin of that on-chain group. A signed
room announcement of a wallet address does **not** substitute for the on-chain
Group membership check.

### Interactive commands

After `/gov show <group>`, `/gov chain install` (if necessary), and
`/gov chain push`, hold a **closed** two-option approval poll linked to a
group issue. The choices must be `approve` and `reject` (or their accepted
synonyms) and approval must have a strict majority.

```text
/gov issue list
/gov chain charter prepare <closed-issue-id>
/gov chain charter handoff
/gov chain charter status [64-hex-charter-hash]
```

`prepare` is read-only, showing exact signed JSON, its content hash,
Proposal ID, poll counts, target node and RhoGov Issue URI. It uses the
signer's existing dyncap anchor and wallet, and validates the **secp256k1**
wallet signature and its already published group REV address. The
`ratifiedAtSeq` field is the signer's *observed* dyncap sequence at
preparation time; it is not by itself a cryptographic poll-close receipt.
The current release requires at least one authorized admin wallet signer;
full multi-party signing/independent council tally are separate promotion gates.

`handoff` requires a separate human confirmation of **exact charter hash,
Proposal ID, node endpoint and Issue contract**. It attempts at most one
signed deploy; uncertain outcomes are not automatically retried. If the
immutable Issue is already present, the exact canonical title and signers
must match or it fails closed. Group metadata records only a proposal
ID/hash/Issue URI after independent read-back of the exact artifact.

`status` is read-only and reports `pending | unknown` under the current
Issue/4 protocol. It can resolve the artifact from its stored hash even
after a browser reload. The status carries read-block provenance, including
whether the observation could come from an unfinalized tip. **Do not**
interpret an opener's `closed` or `proposed` result as independent
multi-stakeholder approval/rejection; native tally + council policy
verification is still required for those labels.

### On-chain encoding

`Issue.id = "success-charter-" + charterHash`, and the immutable title is
`qos/success-charter/1:` plus URI-encoded canonical JSON of the entire
**signed** `success-charter/1` artifact. That stores the exact record, not
merely its hash. The 12 kB transport bound is explicit; oversized charters
are refused, not silently truncated. A colliding id or changed on-chain
payload is a blocking mismatch.

Signatures use `sc1:<anchor>:<compressed-secp256k1-pubkey>:<compact-signature>`
over `SHA-256("qos:success-charter/1:handoff\\n" + charterHash + "\\n" + anchor)`.
They are verified against published group wallet addresses. This is
cryptographic **wallet** authorization, but the pre-existing dyncap
anchor-to-wallet binding is room/TOFU metadata, not a publicly verifiable
seed proof. No AI agent may sign or initiate the handoff.

The existing `Group/4`/`Issue/4` contracts remain unchanged. No Rholo
consensus change is required. On-chain status `approved`/`rejected`
requires an independently verified vote/tally; no implicit promotion is
implemented here. See
[RhoGov handoff protocol](https://github.com/rhovision-org/rhogov/blob/main/docs/success-charter-handoff.md)
for cross-repo source and exact evidence requirements.
