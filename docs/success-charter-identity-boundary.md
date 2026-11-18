# Success-charter/1 identity and authorization boundary

The `members[].anchor`, `proposer`, and `ratifiedAtSeq` fields are **dyncap-attributed** (hash-only TOFU and tamper/replay/fork detection), **not cryptographic signatures**. `members[].signature` is forbidden.

The schema's `signatures[]` field is reserved for actual `sc1:<anchor>:<compressed-secp256k1-pubkey>:<compact-signature>` wallet authorizations. `verifyCharterAuthorizations` in `charter-chain.js` verifies the wallet signature, domain-separated charter-hash digest and published member REV address. It does **not** cryptographically prove that the dyncap seed controls the wallet, or independently verify poll ratification.

`validateSuccessCharter({requireSignatures:true})` checks presence, structure and canonical hash, **not signature validity**. The handoff flow additionally checks wallet authorization, on-chain admin membership, local closed approval poll, explicit human confirmation and exact read-back. An immutable chain issue is a submitted proposal, **not a final governance verdict**.

Never export a `cap:room:…` bearer capability, dyncap seed or private personal state. No automatic submission or elevation of group authority is permitted.
