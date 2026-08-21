# cocos-cli-driver

An agent drives an open Cocos Creator editor from a shell: it runs `cocos <command>`, and the answer
comes back on stdout. This file is the vocabulary that whole surface is described in — the terms the
tickets, the reports and the code all use for the same things. `CLAUDE.md` holds the architecture
and the invariants; `docs/adr/` holds the decisions.

## Language

### The seam

**Driver**:
The editor extension that answers primitives and decides nothing. The typed seam naming those
primitives carries the same word, so a command written against it does not know whether an open
editor is on the other side.
_Avoid_: server, bridge, backend, MCP server.

**Primitive**:
One named call the driver answers — a question about the editor or a mutation of the scene, with no
decision of its own. Everything an agent-facing decision needs sits above the primitive, in the CLI.
_Avoid_: tool, endpoint, API method, RPC method.

**Scene script**:
The context inside the editor where the engine exists. A primitive that needs the engine is answered
there and nowhere else.
_Avoid_: scene worker, engine context, runtime.

**Channel**:
The local connection between one CLI process and one project's open editor, private to that project.
There is no server an outside process listens on. A write report's *write channel* is a different
sense of the word.
_Avoid_: port, socket, transport, server.

**Editor instance**:
One open editor with the driver loaded, addressed by the project it has open. Several can be open at
once, which is why a command may have to be told which project it means.
_Avoid_: session, server, host.

**Adapter**:
An implementation of the driver seam. The *live adapter* speaks to an open editor over the channel;
the *in-memory adapter* answers from a scene held as data, and is what a test drives a command body
with.
_Avoid_: mock, fake, stub, test double.

### Outcomes

**Verdict**:
The first word of an outcome line, from a closed set of five: `ok`, `UNVERIFIED`, `UNPERSISTED`,
`FAILED`, `TIMEOUT`. It is computed from the report rather than chosen by the command, and it is the
only thing that becomes an exit code.
_Avoid_: status, result, severity, level.

**Write report**:
The answer to one write into the scene: whether it was issued, whether it was read back, and whether
a save carries it. Every write into the scene answers one, in this one vocabulary, wherever it
happened.
_Avoid_: write result, set result, mutation result.

**Asset report**:
The answer to one operation on the asset database. It is a different thing from a write report and
has no `persisted`: an asset file is written at once and outside the undo stack.
_Avoid_: asset result, file report.

**Verified**:
The value was read back after the write. A write that was issued and not read back is `UNVERIFIED` —
an honest gap, not a failure, and it exits zero.
_Avoid_: confirmed, validated, checked.

**Persisted**:
Whether a save carries the value — three-state. `true` is proven it does, `false` is proven it does
not, and `null` is that nobody looked. `null` is not a soft `false`.
_Avoid_: saved, committed, dirty, written to disk.

**Write channel**:
Which route carried a write: the *editor* channel, which serializes, or the *live* channel, which
records nothing by construction. It decides what `persisted: false` means — a value a save would
drop on the first, the expected state on the second.
_Avoid_: mode, route, path.

**Settled**:
What an asset operation waits for: the database reports itself ready and nothing in it has changed
for a quiet period. The editor answers a refresh or an import before that import finishes, so its
own answer alone is not this.
_Avoid_: ready, done, imported, finished.

### The scene

**Dump**:
The editor's own description of a node or a component — each property with its value, its declared
type and its default, in the shape the inspector shows. It is what a value written into the scene is
read back against.
_Avoid_: serialization, snapshot, state, JSON.

**Undo bracket**:
One write wrapped so Ctrl+Z in the editor takes it back as a single step. A bracket the editor
refused to record, or left open, is reported as such rather than claimed.
_Avoid_: transaction, batch, group, changeset.

**Prefab instance**:
A node that tracks a prefab asset, so edits to the asset reach it.
_Avoid_: clone, linked node, prefab node.

**Flat copy**:
A node made from a prefab asset that tracks nothing — the same nodes and the same components, and
edits to the asset never reach it. Nothing in the tree or the component list tells it from an
instance.
_Avoid_: unlinked instance, detached prefab, broken prefab.

**Override**:
A value a prefab instance holds in place of the asset's, recorded on the instance. Whether a write
inside an instance became one is what decides that write's `persisted`.
_Avoid_: patch, modification, local change.

**Linkage verdict**:
The answer to whether a node made from a prefab asset is an instance, asked both of the live node
and of what a save would emit. The two can disagree, and a link the serializer drops is one that
dies on save.
_Avoid_: linked flag, prefab status.

### The project's own files

**Kit**:
The tree of a project's own TypeScript that a census sweeps, named either by its asset address or by
a path on disk.
_Avoid_: package, library, framework, module.

**Census**:
The whole-kit sweep that answers, per component key, who reads it and who writes it. It is a reading
rather than a write, so it answers `ok` or `UNVERIFIED` only, and a sweep that did not cover the
whole kit is `UNVERIFIED`.
_Avoid_: audit, scan, analysis, report.

**Component key**:
The name an ECS component is carried under on an entity, and the unit a census reports on.
_Avoid_: component name, field, tag.

**Read without a writer**:
A component key that some system reads and nothing anywhere writes or adds — a feature that silently
never runs, which neither a unit test nor the type checker sees.
_Avoid_: unused key, dead key, orphan.
