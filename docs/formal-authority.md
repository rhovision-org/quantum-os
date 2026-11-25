# Formal authority model — research boundary

Phase III follows the Quantum OS security assurance work. Baseline runtime:
[`qos-process.ts` at 86a569f](https://github.com/rhovision-org/quantum-os/blob/86a569f99470b265784ab7d4d1189a03f375d50a/packages/browser/src/qos-process.ts).
The Lean toolchain matches QLF at
[2b93f23](https://github.com/rhovision-org/quantum-logical-framework/blob/2b93f23fd8f8cbcbac330710f305a62a38e4905d/lean-toolchain).
The model does not import ZFA, nor assert that balance implies authority.

| Model element | Runtime correspondence | Boundary |
| --- | --- | --- |
| Scope process and rights | `attenuateScope`, `scopeAllows` | Event categories abstracted into six rights |
| Certified Path | `resolveCapability` grant recursion | Authenticity, grant hash resolution, global freshness and depth policy external |
| Actor | grant target/source | authenticated principal is an assumption; dyncap TOFU is not a signature |
| Live lineage | proposed revocation policy | not implemented by this research |
| Serial Step and Trace | proposed acceptance/replay reference model | not a distributed or concurrent protocol |

The Lean module proves scope transitivity, root-bound authorization,
lineage/root revocation denial, preservation of revoked and seen IDs
under serial steps, and replay refusal after any modeled trace. Positive
and negative fixture theorems exercise a delegated ballot, denied anchor,
cross-process request and revoked lineage.

The model permits root-only permanent revocation of an ID; it does not model
grant persistence or creation as a state update, non-root revocation,
causality between grant and execution, concurrent replicas, authentication,
or actual receiver code. Grant IDs are fresh only within a certified path;
global uniqueness and provenance must be supplied by the refinement.
Revocation may not be inferred from current software behavior.

## Next gate

Define an executable adapter from runtime event and grant traces to this
model, test real scope/identity/ordering behavior against it, and design
revocation and replay state before claiming refinement. Counterexamples
to the abstraction are evidence, not a reason to weaken the specification.

CI only. No room probes, deployment, or live infrastructure changes.
