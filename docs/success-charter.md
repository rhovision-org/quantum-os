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
