# Security assurance boundary

Baseline QuantumOS `86a569f99470b265784ab7d4d1189a03f375d50a`; QLF `2b93f23fd8f8cbcbac330710f305a62a38e4905d`. This is a claim/evidence inventory, not a certification.

| Property | Evidence / implementation | Boundary |
| --- | --- | --- |
| Process representation balance | [RhoQuCalc.lean](https://github.com/rhovision-org/quantum-logical-framework/blob/2b93f23fd8f8cbcbac330710f305a62a38e4905d/lean/RhoQuCalc.lean), `rho_process_always_zfa` | Representation theorem, not software security |
| Parallel representation | [BraKetRhoQuCalc.lean](https://github.com/rhovision-org/quantum-logical-framework/blob/2b93f23fd8f8cbcbac330710f305a62a38e4905d/lean/BraKetRhoQuCalc.lean), `decoherence_impossibility` | Specialization of model theorem; no physical or network adversary claim |
| Token algebra | `crates/zfa-core/src/history.rs`, census conformance | Aggregate versus pairwise predicates differ; finite counts are not a refinement theorem |
| Wire validation | `wasm_capability_valid`, TypeScript `validateCapability` | Strict grammar and bounded fixture parity; algebraic validity alone grants no authority |
| Token secrecy | `Capability::from_entropy`, `generateCapability` | CSPRNG input length differs from output entropy; independent assessment and versioned migration required |
| Relay content protection | `room-crypto.js`, existing selftest | Shared-secret AEAD, conditional confidentiality; not individual sender authentication or routing membership proof |
| Identity attribution | dyncap TOFU chain | Not a cryptographic signature; independent original-author authentication and replay policy remain open |
| Authority confinement | runtime-specific capability checks | Requires explicit transition system, adversary and non-amplification invariant |

## Smallest next gates

1. Validate the existing capability wire grammar in Rust/WASM and fallback using the same synthetic fixtures. Preserve valid existing token encodings; no public room migration in this change.
2. Specify the exact token distribution and design a versioned generator with a stated output-entropy target and migration/rotation plan before changing live token issuance.
3. Specify an abstract authority transition system (grant, revoke, delegate, receive, replay) and its concrete abstraction map. Prove preservation under explicit adversary assumptions; independently test the abstraction against executable traces. Existing Lean ZFA invariants are not a substitute for this work.
4. Qualify deployment separately: reproducible source-to-binary identity, protocol compatibility, independent review. No public signaling probe, room access experiment, or deployment is part of this PR.
