# Issue #291 — Pinned real-chain witness

**Result: PASS_REAL_DISPOSABLE_ISSUE_4_SUBMISSION.**
This is not a claim of finalized settlement or independent multi-stakeholder ratification.

## Exact provenance

- GitHub CI: https://github.com/rhovision-org/quantum-os/actions/runs/44160911903
- Head tested: 5b165d9195642de71928d5ad1a4cf19fba2af4c0
- GitHub PR merge SHA tested: ca60f1b525d4f27dd163e35fa25d53c51ec1d8d8
- Normal CI: https://github.com/rhovision-org/quantum-os/actions/runs/44160911886
- RhoGov CI: https://github.com/rhovision-org/rhogov/actions/runs/44158764722
- Rholo executable: rnode 0.1.0, source bc80abbba42661f0252c04f931e6a4ac58bb6737; **historical bundled build, not latest dev**.
- Executable SHA-256: a22e0ead719fd81397afd534491caf1f32426c0f7565e504f9277c897b98ab76
- Cross-repo fixture SHA-256 (byte-identical): c4412739985985792725b1a6a783777365741c306ca0e98c3114399e92f97985
- Charter SHA-256: 007425c05ecd576a47648a5400bacfa98cdebab5d610ed544f72e68936cd6f05
- Proposal ID: success-charter-007425c05ecd576a47648a5400bacfa98cdebab5d610ed544f72e68936cd6f05
- Read-back block height: 10; block hash: 265afd9f39ca02c3cc29a10b53fa3ee58a4448e75ce04bf4f620a56acb9496b2
- **Read source: latest-block-unfinalized-possible** (not an independently finalized block).
- Canonical signed Issue-title SHA-256: be95acb07ec3032fe5d1d22a8813b0e0f59004d42d60d89b82d083f687e5eeae
- Witness JSON SHA-256: a365d280abcf3856a51d95316ab2b050c1c9f98de94dcec3c75d22e3be9cdd96

Verify the exact bytes with: sha256sum -c qos291-real-chain.SHA256SUMS.

## Actual execution gates

1. Launch real isolated disposable Rholo (not the public four-validator testnet).
2. Deploy Group/4 + Issue/4; both PROCESSED_WITH_SUCCESS.
3. Create the group; independently read back caller identity as Group/4 admin.
4. Verify a domain-separated secp256k1 wallet authorization against its self-published dyncap-anchor claim.
5. Read before write and independently verify that Issue/4 is present.
6. Submit one signed Issue/4 open, observe PROCESSED_WITH_SUCCESS.
7. Independently read the exact immutable signed charter, recompute its SHA-256, status pending.
8. Re-invoke same handoff and prove no second deploy (idempotency).
9. Query by charter SHA-256 with no in-memory preview.
10. Reject a mismatched/tampered artifact without a chain write.

The recorded node source and hashes are **specific to this GitHub runner**; repeat runs will have different block hashes and contract registry URIs.

First negative run: https://github.com/rhovision-org/quantum-os/actions/runs/44159769761.
It exposed missing Issue/4 returning Nil as zero explore expressions. The subsequent fix checks the independent Issue/4 issues-list facet before interpreting absence.

## Pending acceptance / explicit non-promotion gates

1. **Approval/rejection:** independently verify native ballots, group/council voter rolls, quorum and ratification policy. Issue/4 close or opener-proposed result does not prove approval. The API properly retains unknown, not approved.
2. **Identity:** the REV wallet signature is cryptographically authenticated; pre-existing dyncap anchor-to-wallet mapping is self-asserted/TOFU, not a cryptographic proof of the dyncap seed.
3. **Browser human gate:** the actual two-person/browser flow (prepare, payload preview, explicit confirm/decline, changed ballots, status) has not been independently replayed.
4. **Current Rholo dev:** rerun with source-pinned fresh Rholo dev binary on a wholly disposable state; historical bundled executable above is the only binary independently exercised.
5. **Finality:** latest-block height 10 cannot be promoted to settlement, and no public validator operation has been performed.
6. **Transport:** canonical URI-encoded Issue.title is capped at 12k bytes; larger artifacts currently fail closed.

Reviewer request: assess QuantumOS PR #299 and paired RhoGov PR #120; retain #291 OPEN until the missing gates are resolved. Do not interpret this CI witness as approval to operate the public #584 validators.
