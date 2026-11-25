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


## Phase IV — bounded refinement witness

The six effective rights are encoded independently in Lean. The executable
enumerator emits all 64 × 64 pairs, for matching and nonmatching process
identities (8,192 decisions), and 384 right decisions. The comparator evaluates
the actual TypeScript exports on canonical scopes and maps all 11 event types
to the six rights (704 checks). It also checks 576 cases where irrelevant raw
privileged event fields are added to a child: the runtime deliberately rejects
these despite unchanged effective rights. Thus equivalence is only on the
canonical subset; the wider representation is stricter, not equivalent.

The Lean soundness theorem connects the finite Boolean subset check to the
abstract Narrows proposition. Separate offline event-log fixtures exercise a
delegated nomination, duplicate-envelope acknowledgment without append, and
reducer denial of an out-of-scope operation after envelope acceptance. These
are executable observations, not a trace refinement proof. They do not
establish cryptographic authentication, global request uniqueness, concurrency,
or runtime revocation. CI records the exact tested merge and PR head, vector
digest and results. No default runtime behavior changes.


## Phase V — serial authority lifecycle candidate

The research-only reference reducer in the formal directory registers unique
grant IDs, binds grants to holders and processes, checks full ancestry for
revocation, enforces narrowing and delegation rights, and consumes request IDs
on successful grant, revoke and execute operations. A rejected request does
not mutate state. Root-owner management revocation is a separate authority,
even after the root's execution authority has been revoked. IDs are never
reused; revocation has no undo operation. A sibling branch remains live unless
its own ancestry is revoked.

The Lean extension checks four selected lineage and revocation obligations
against the abstract model. An independently implemented Python oracle uses
parent pointers and sets of rights; the JavaScript reducer uses materialized
lineages and bit masks. CI compares complete decisions and normalized next
states over a fixed 22-command alphabet and all reachable states up to four
accepted transitions, plus an explicit longer trace and malformed controls.
This is bounded differential evidence, not a proof of equivalence between the
Lean specification and both implementations.

The candidate is not called by any production code. It assumes a trusted
authenticated actor, a trusted initial state and serial state transitions.
No durable journal, atomic external side effects, crash recovery, cross-replica
ordering or authenticated revocation distribution is supplied. A successful
execute marks a request as used but does not invoke any external action.
Production revocation semantics and backwards-compatible migration require
maintainer agreement and a separately reviewed integration.
