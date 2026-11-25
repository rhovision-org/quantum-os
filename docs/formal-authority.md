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


## Phase VI — durable serial authority journal

The research-only SQLite adapter wraps the Phase V reference reducer in
BEGIN IMMEDIATE transactions with WAL and FULL synchronous mode. Each
accepted transition commits state and a unique request receipt together.
Receipt digests bind actor and canonical command; reusing an ID with different
content is a conflict, while identical retries are refused as replays.
Receipt replay checks the complete stored state against genesis and each
recorded transition. This is corruption detection under trusted storage,
not authentication against an administrator who can rewrite the entire log.

CI uses separate local processes and temporary databases to check request
contention, grant-ID contention, process termination immediately before and
after commit, serial ordering of execute versus revoke, and journal corruption.
The adapter does not invoke external actions. It assumes trusted actor input,
a single database, compatible SQLite/VFS and storage durability. Process
termination is not a physical power-loss test. No distributed consensus,
authenticated revocation propagation, browser persistence, or production
integration is supplied.


## Phase VII — partition-aware authority replica candidate

Immediate global revocation and autonomous offline execution cannot both be
guaranteed in this model. An isolated replica has the same observations in two
executions: one in which its parent grant remains live, and another in which
the writer has revoked it after the partition. No local predicate can
distinguish these executions without additional information. The candidate
therefore sacrifices offline execution availability, not revocation safety.

The research-only single-writer reference signs each accepted transition
with Ed25519, binding the stream, ordinal, predecessor, actor, command and
before/after state hashes. Replicas verify signatures and recompute transitions,
refuse gaps and conflicting histories, and remain read-only even when caught
up. A valid prefix is explicitly not evidence of freshness. Observed
equivocation quarantines the replica; this does not detect an equivocation
that remains hidden from it.

CI models partition and ordered repair, exhausts all 720 permutations of a
six-record fixture followed by complete ordered delivery (8,640 receive
calls), tests stale grant replay, invalid signatures/stream, and signed
prefix/state conflicts. It does not contact a network. Convergence is
conditional on receiving the same valid complete prefix; the test is not a
general consensus proof. Writer authentication here is distinct from actor
authentication, which remains assumed. The in-memory writer is not coupled
to Phase VI's durable journal, and its signing key is a synthetic fixture.
A production design requires authenticated principal input, atomic durable
writer/signature publication, trusted stream/key bootstrap, recovery and
rotation, a consensus or trusted-writer policy, and separately tested runtime
integration. No offline grant or execution is introduced.
