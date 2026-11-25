# RhoQu v2 runtime semantics

The browser lowers RhoQu source to a typed process IR. Enter a program directly
with /rhoqu to review the expanded commands and approve execution. Room,
connection, or identity changes stop subsequent dispatch. Review opens with
Cancel focused. Approval requires activating the Run program button (mouse,
touch, or keyboard); a document-level Enter is not approval. A covered
confirmation dialog does not receive keyboard or button approval. A macro or
script cannot enter RhoQu execution or clear registered channel handlers;
`/rhoqu clear` requires direct input. This is a local UI authority boundary,
not authentication of the operator or a proof of all agent entry points.

## Sequence and concurrent branches

Statements execute in source order. Legacy parallel blocks and pipe groups keep
their sequential behavior. They continue to work with the flat transpiler.

The explicit concurrent form runs semicolon-separated branches using local
browser promises. Branch results retain source order. Each branch starts with
a copy of the parent's bindings. New bindings stay within the branch. Commands
within a branch are awaited in order. A command failure yields a structured
error while the other commands continue. Cross-branch mutation order is
unspecified. Distributed execution and cancellation are future work.

## Runtime conditions

The legacy if form uses a compile-time snapshot. The when form evaluates a
fresh room snapshot when the interpreter reaches it. The snapshot includes
lemma names, note balances, declared currencies, peer count, connection state,
and the current dyncap sequence. It is an observation of live state. Replay
against an immutable room event log remains future work.

## Binding

Use bind name /command to capture a receipt. The browser supports exact IDs
from poll creation, lemma registration, note grant and merge, rendezvous
proposal, and QOS process start. IDs come from the command that made the
change. A command with no corresponding receipt cannot be used as the target
of bind. A failed explicit bind clears its name and the current LAST_ID.
Use two dollar signs to pass a literal dollar through the interpreter.
A RhoQu dispatch result records that the slash-command handler was invoked.
The handler still reports its own validation and operation outcomes.

## Channel handlers

Channel handlers register only after successful compilation and user approval.
They support declarations and calculations exposed by the channel command
policy. Handler bodies use flat commands, including those expanded from
process calls. Runtime conditions, concurrent branches, bindings, and nested
registrations are rejected in handler bodies.

## Process packages

Use /rhoqu package to preview and export source or import a validated JSON file.
An import checks schema, limits, and the canonical content hash. The author
anchor is a claim supplied with the package. Import and export are preview
operations. Channel handler registrations require an interactive RhoQu
program because package v1 has no representation for them.
