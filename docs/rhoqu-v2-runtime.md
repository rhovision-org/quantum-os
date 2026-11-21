# RhoQu v2 runtime semantics

RhoQu v2 lowers source to a typed RhoProcess IR. The browser interpreter dispatches
commands through the existing command handler; it does not turn the Lean model into
a runtime dependency.

## Sequence

`sequence` executes statements in source order and awaits each command before
starting the next. A failed command is reported as a structured error and does not
implicitly abort the remaining sequence.

## Parallel

`parallel` starts its branches concurrently in the local browser runtime and
joins them. It is local Promise concurrency, **not** a remote peer/process spawn
or distributed parallel execution.

- Branch result groups are returned in source branch order; commands within each
  branch retain their execution order.
- Each branch receives a copy of the binding state and `$LAST_ID` at entry.
  Branch-local bindings do not flow back to sibling branches or the parent.
- A command failure is represented as a structured failed result. It does not
  cancel sibling branches, and a containing sequence continues after the join.
- Cancellation is not implemented in this runtime slice.

## Runtime `when`

A `when` condition is evaluated when the interpreter reaches the node. The app
constructs a fresh state snapshot at that point from the room's lemma store,
note balances, declared currencies, peer count, connection state, and sequence.
Both branches are retained in the IR; only the selected branch executes.
A missing evaluator fails closed with a structured error.

A parallel branch can read mutable room state when its runtime condition is
evaluated; this is execution-time state, not a deterministic replay of an
immutable room event log. Cross-branch mutation ordering is not guaranteed.

## Binding

A command binds only when execution returns a structured ID or the app adapter
observes exactly one new ID in the authoritative store. Unstructured output is
never parsed to invent an ID. Binding state is sequential and isolated across parallel branches. A shared-store
delta cannot identify the originating command in parallel execution: only an explicit
structured command ID binds inside such a branch. The legacy library store-delta adapters remain observational and are not used by the browser RhoQu dispatcher. Production RhoQu consumes only command-correlated receipts. `/qos start` returns its exact published process ID after the queued operation completes, including in parallel branches. Explicit bind failures invalidate that name, and unresolved declared bindings (including LAST_ID) fail before dispatch. Other commands without a correlated receipt cannot bind; operations requiring interactive approval remain blocked. Room/identity switches stop subsequent dispatch.


## Process packages

`/rhoqu package` opens the process-package UI. Source can be previewed and
exported as a canonical JSON package; an existing package can be imported after
schema and content-hash validation. Imported package content and provenance are
shown for review. A content hash checks payload consistency, not the claimed author
identity. Validated packages are detached immutable JSON snapshots. This UI is preview/import/export only: importing a package
never executes commands or grants capabilities. Execution remains a separate,
explicit action in the normal RhoQu command path.
