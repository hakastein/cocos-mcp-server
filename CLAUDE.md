# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

A Cocos Creator 3.8.x editor extension (`driver/`) paired with a command-line client (`cli/`): an
agent runs `cocos <command>` in a shell to drive an open editor's scenes, nodes and components. The
CLI and the extension talk to each other over a local channel private to one project's editor; there
is no server an outside process listens on, and the shell *is* the interface — there is no separate
call-and-response protocol layered on top of it for an agent to learn.

This replaced an editor extension that exposed the same capabilities over MCP directly from inside
the editor process. That transport, and everything that served it, is gone from this repository; the
reasoning that led to the replacement is recorded in `docs/specs/2026-08-18-cocos-cli-design.md`.
The MCP-era `source/` tree went with it — `docs/source-inventory.md` says where each of its twelve
modules landed, so a module buried on purpose does not get proposed back from git history.

Three npm workspaces, one repo:

- `shared/` — types and pure logic both sides need.
- `driver/` — the editor extension. Its `package.json` name is still `cocos-mcp-server` (existing
  installs key off it); nothing else in this repo calls it that. It holds native primitives and
  decides nothing, plus a small Vue settings panel that is unrelated to the primitive surface.
- `cli/` — the `cocos` binary. Command parsing, node-path resolution, undo brackets, verified writes,
  rendering — everything an agent-facing decision needs lives here.

## Build Commands

```bash
npm install                       # dependencies for all three workspaces
npm run build                     # tsc (+ tsup where a package has one) for shared, driver, cli, in that order
npm test                          # the same build, then `node --test` inside each workspace
npm run test:only --workspace cli # cli's own tests, no cli build — they import `src/`; needs shared/dist
npm run build --workspace cli     # rebuild only cli — fine once shared/dist is already current
npm run build --workspace driver  # rebuild only driver, likewise
npm link --workspace cli          # put the `cocos` binary (cli/bin/cocos.js) on PATH
```

`shared` must build before `driver` and `cli` type-check: both import straight from
`@cocos-cli/shared/dist/...`, and the root `workspaces` array (`shared`, `driver`, `cli`) is what
gives `npm run build`/`npm test` that order.

`driver` and `cli` tests import `../src/*.ts` directly — Node strips the types, so a red-green loop
costs no build. That is what `allowImportingTsExtensions` and the `.ts` suffix on every relative
import inside `driver/src` and `cli/src` are for, and `erasableSyntaxOnly` keeps the sources
strippable (an `enum`, a `namespace` or a constructor parameter property would stop compiling).
`shared`'s own tests stay on `../dist/*.js`: `shared/dist` is what the other two import anyway, so it
is built before anything else runs.

## Architecture

Four execution contexts:

```
agent
  │ shell — the only interface
CLI                    cli/src/            all the logic: commands, orchestration, undo, rendering
  │ JSON-RPC over a local channel (named pipe on Windows, unix socket elsewhere)
driver                 driver/src/         89 native primitives, no logic of its own
  ├ editor.*           58 methods over Editor.Message
  └ scene.*            31 methods over the scene script
scene script           driver/src/scene/   the only place `cc.*` exists
```

`shared/` holds the types and pure logic both sides need: the whole driver seam (`Driver` =
`EditorMethods` + `SceneFacade`, in `driver.ts` over `editor-contract.ts` and `scene-contract.ts`),
`WriteReport` and `SceneResult`, the list of all 89 methods and the check that gates them
(`protocol.ts`), the handshake shape (`Hello`), the channel address (`pipe-name.ts`), node-path
parsing, and serialized-value comparison (`serialized-diff.ts`, `reference-projection.ts`).
Three adapters satisfy `Driver`: `driver/src/editor-api.ts` over `Editor.Message`,
`cli/src/driver/client.ts` over JSON-RPC, and `cli/src/driver/memory.ts` over a scene held as data.
Everything in `cli/src` that takes a driver takes `Driver`, never the concrete `DriverClient` —
that is what lets the memory adapter drive a command body.

**Key constraint:** engine APIs (`cc.*`) exist only in the scene script context. Anything that needs
them goes through `scene.*`, never through `editor.*`.

Command groups implemented in `cli/src/commands/` today: `scene`, `node`, `component`, `prefab`,
`asset`, plus the top-level `instances`. More groups (build, project, log, ecs, a raw `evalInScene`
escape hatch) are future work, not yet wired to any command.

`driver/` also carries a small subsystem outside this diagram entirely: a Vue settings panel
(`driver/src/panels/default/index.ts`, its own `tsup` entry) that shows `PipeServer` status and
edits `enableDebugLog`, wired to `driver/src/main.ts` through three `Editor.Message` IPC methods
(`openPanel`, `getDriverStatus`, `updateSettings`) declared in `driver/package.json`'s
`contributions.messages`. It does not go through the pipe or `EDITOR_METHODS`/`SCENE_METHODS` at
all — it is the editor UI talking to its own extension, not the CLI talking to the driver.

## Key Files

| File | Role |
|------|------|
| `shared/src/protocol.ts` | `EDITOR_METHODS`/`SCENE_METHODS` — the 89-method list that is the driver's whole reachable surface; `isKnownMethod`; the handshake `Hello` shape; the two `Exhaustive` aliases that stop the list and `EditorMethods` from drifting apart |
| `shared/src/editor-contract.ts` | `EditorMethods` — the 58 `editor.*` signatures, parameters and results taken from Creator's `EditorMessageMaps` so they cannot drift from it; the handful that deviate are `Answering<>` or written out, each saying why |
| `shared/src/driver.ts` | `Driver` — `EditorMethods` and `SceneFacade` as one seam |
| `shared/src/pipe-name.ts` | project path → channel address, computed identically by both sides |
| `shared/src/scene-contract.ts` | `SceneMethods`, `WriteReport`, `SceneResult` — the typed contract with the scene script |
| `driver/src/main.ts` | extension entry: `load`/`unload`, starts and stops the `PipeServer`; also answers the panel's IPC (`openPanel`, `getDriverStatus`, `updateSettings`) |
| `driver/src/pipe-server.ts` | the channel server: one request at a time (`p-queue`), the bracket gate that blocks other connections while one holds an open undo bracket, `hello`'s `surfaceChecksum` |
| `driver/src/method-table.ts` | resolves a dotted method name to a callable, refusing anything `isKnownMethod` does not know |
| `driver/src/editor-api.ts` | every `Editor.Message` call, typed over `EditorMessageMaps`; `implements EditorMethods`, so a drift from the shared contract is a compile error |
| `driver/src/scene-script-client.ts` | `SceneScriptClient` — wraps `editor.scene.executeSceneScript`, typed by `SceneMethods`; what `method-table.ts` calls for every `scene.*` request |
| `driver/src/scene/` | the scene script; `index.ts` assembles `SceneMethods` from `dump`/`node-ops`/`component-ops`/`property-write`/`prefab-ops`/`query`, with `engine.ts` holding the helpers they share |
| `driver/src/panels/default/index.ts` | the Vue settings panel — status and `enableDebugLog`, over the IPC `main.ts` answers, not over the pipe |
| `cli/src/main.ts` | the command tree (`buildProgram`), the entry point `bin/cocos.js` runs |
| `cli/src/discovery.ts` | enumerates channels, probes each with `hello`, `selectInstance` narrows by `--project` |
| `cli/src/resolve.ts` | `resolveClient` — discovery, selection and connect, in the shape every command's `resolve` thunk needs |
| `cli/src/driver/client.ts` | `DriverClient implements Driver` — the `editor.*`/`scene.*` facades over JSON-RPC; `editor` is generated from `EDITOR_METHODS` and typed by `EditorMethods`, `scene.call` by `SceneMethods` |
| `cli/src/driver/memory.ts` | `MemoryDriver implements Driver` — the same seam over a scene held as data, so a command's writes read back. The scene is the test's own input: nodes with components, descriptors in the editor's dump shape, `classes` for what the engine registers, `refuses` for a message that says no, and a node's `prefab` block for what the next load rebuilds — a write inside an instance records the override the editor would record. A primitive it does not model refuses by name |
| `cli/src/driver/memory-assets.ts` | `MemoryAssetDb` — the asset half of that seam, a database held as data: the `db://` glob, and the move/copy/create/delete that rename on conflict the way the editor does |
| `cli/src/commands/shared.ts` | `withClient` (resolve → run → present → close) and `emit`, the one place command output touches `stdout`/`stderr`; plus `unwrap` (`SceneResult<T>` → value or thrown error) |
| `cli/src/commands/flags.ts` | the coercions an `.action()` body applies to the text Commander hands through — `booleanFlag`, `numberFlag`, `vec3Flag` (all three axes, for a node being created), `vec3PartsFlag` (an empty axis keeps its value), `jsonFlag` |
| `cli/src/undo-bracket.ts` | `withUndoBracket` — one write wrapped in one undo step, `undoNote` when the editor refused or left it open |
| `cli/src/node-snapshot.ts` | the editor's descriptor-wrapped node dump projected to what a write reads back |
| `cli/src/node-transform.ts` | `parseVec3` (an empty axis keeps its value), and the 2D-node clamp that zeroes `position.z` / `rotation.x,y` and says which value it destroyed |
| `cli/src/node-write.ts` | `NODE_STORAGE` (a node property → the name the serializer emits it under) and `withNodePersistence` — whether a save carries a write to a node's own property, including the prefab-override route |
| `cli/src/prefab-linkage.ts` | the `type: 'cc.Prefab'` that separates a linked instance from a flat copy, and the two-sided linkage verdict (live node vs serializer) |
| `cli/src/asset/` | the asset-database decisions: the `db://` glob and the name/limit cut a listing takes (`query.ts`), and the quiescence verdict every asset command waits on — snapshot fingerprint, `settled`, the asset and component-class deltas, `AssetReport` and `copiedAddress` (`settle.ts`) |
| `cli/src/property/` | kind resolution (`kind.ts`), dump-value projection for read-back comparison (`readers.ts`, used by both neighbors below), the writer cascade (`writers.ts`), the disk/serializer verified-write wrapper (`verified-write.ts`), the read side of a component dump — class selection, property rows, default comparison (`component-dump.ts`), uuid → scene name (`reference-index.ts`) and the spelling a reference value is written in — path, `db://` url or uuid (`reference-target.ts`) |
| `cli/src/render/` | `verdict.ts` (the five head words, their exit codes and `worstVerdict`) and `present.ts` (the `Report` union and `present`) over seven formatters — `tree.ts`, `report.ts`, `property.ts`, `prefab.ts`, `asset.ts`, `scene.ts`, `instances.ts`. Only `present.ts` is imported from outside `render/` |

Everything a command decides that does not need a live editor lives in a pure module beside
`commands/`: `property/`, `render/`, `asset/`, `node-type.ts`, `node-snapshot.ts`, `node-transform.ts`,
`prefab-linkage.ts`, `settle.ts`, `discovery.ts`'s `selectInstance`.
Those and the command bodies are what the test suite covers — a command runs against
`cli/src/driver/memory.ts`, which answers as the seam does. `driver/client.ts`, `resolve.ts` and
`main.ts` talk to a socket or to Commander's own wiring, and are verified live.

## Write Honesty and Undo Brackets

Every write into the scene answers a `WriteReport` (`shared/src/scene-contract.ts`) — a component
property, a node's own property, a reparent, a duplicate. One vocabulary, so the same situation gets
the same word wherever it happens:

- `written` — the write was issued; `verified` — the value was read back;
- `persisted: boolean | null` — **three-state**. `true` proven a save carries it, `false` proven it
  does not, `null` **nobody looked**. `null` is not a soft `false`.
- `channel: 'editor' | 'live'` — what `persisted: false` means depends on it. The editor channel
  serializes, so `false` there is a value a save would drop. The live channel records nothing by
  construction, so `false` there is the expected state, not a defect.

`cli/src/property/writers.ts` holds the writer cascade (`WRITERS`, one entry per property kind, the
first `claims()` wins) and `cli/src/property/verified-write.ts` follows a writer's result with a
disk- or serializer-verdict pass. `component set` (`cli/src/commands/component.ts`) drives both:
it resolves the target, picks the descriptor, and hands the write to `verifiedWrite`, so every
kind the cascade covers is reachable from the command. A reference value arrives as a node path,
a `db://` url or a uuid; `commands/component.ts` turns it into a uuid **before** the first write,
because an address that resolves to nothing must be refused rather than set as a value the editor
silently turns into `null`.

`node set`, `node mv` and `node dup` (`cli/src/commands/node.ts`) get their `persisted` from
`cli/src/node-write.ts`'s `withNodePersistence`, which asks `serializedNodeValue` under the name the
serializer emits the property by (`NODE_STORAGE`: `position` → `_lpos`, `rotation` → `_euler`, and
so on — the file carries `_lrot` as well, and comparing a write against the quaternion would report
every rotation as dropped). A node inside a prefab instance carries nothing of its own in the scene
file, so there the verdict comes from the instance's property overrides instead: `nodePrefabLinkage`
up the parent chain for the instance root and the node's `fileId`, then `listPrefabOverrides` for a
record naming that `fileId` and that stored property.

`cli/src/render/report.ts`'s `writeVerdict` turns a `WriteReport` into one of the five words below
and `renderWriteReport` prints it — `persisted: null` prints as `unknown`, never as `false`, and
`persisted: false` on the editor channel is `UNPERSISTED` rather than `ok` with a caveat in the tail.
One bracket can carry several writes (`node set --name X --pos 1,2,3`); `renderWrites` then leads
with a head line carrying `worstVerdict` of them, because a reader takes the head word off the first
line and an `ok` there over an `UNPERSISTED` further down is exactly the lie this report exists to
stop.

## Verdicts and the Presenter

The first word of an outcome line comes from a closed set, declared once in
`cli/src/render/verdict.ts`:

| head | meaning | exit |
|---|---|---|
| `ok` | done, read back, and a save either carries it or the question does not apply | 0 |
| `UNVERIFIED` | done, and the read-back did not confirm it | 0 |
| `UNPERSISTED` | done and verified, and a save is proven to drop it | 1 |
| `FAILED` | not done | 1 |
| `TIMEOUT` | did not settle inside `--timeout` | 1 |

Caps everywhere but `ok`. Everything that used to be its own word — a move that did not land, a
link the serializer drops, a database still importing — is now the tail of the line.
`verdictFailed` is the only place a verdict becomes an exit code; `UNVERIFIED` exits 0 on purpose,
so `&&` does not break on a write that landed but could not be read back.

A command body assembles neither `stdout`, `stderr` nor `failed`. It answers a `Report` — a
discriminated union in `cli/src/render/present.ts`, `kind` the tag — and `present(report, { json })`
turns it into a `CommandOutput`. The union is what makes the set closed: a new kind of report does
not compile until its `render` arm names a verdict. `--json` stays a per-command option (it was
dropped as a global in `bfb4d01`, because it promised structure where there is none), and the
`json ? JSON.stringify(x) : renderX(x)` branch lives in the presenter rather than in ten action
bodies. A report with no structural form — `kind: 'action'`, a verdict plus a free-text tail —
prints its text under `--json` too.

The seven `render/*` formatters are internal to the presenter: nothing outside `render/` imports
them.

**Undo brackets.** `withUndoBracket(client, nodeUuid, write)` (`cli/src/undo-bracket.ts`) wraps a
write in the driver's begin/end-recording pair so Ctrl+Z takes it back, and returns an `undoNote`
when the editor refused to record or left the step open. A command carries that `undoNote` to the
presenter untouched: `render/report.ts`'s `undoDetail` is the one place it becomes words (`undo=1`
when the bracket held, the note when it did not), and before that it was spelled out in three.
`driver/src/pipe-server.ts` backs this with a bracket gate: while one connection holds an open
bracket, every other connection's calls wait for it, and a socket that closes mid-bracket has its
dangling recording cancelled instead of left open.

## Asset-Database Honesty

An asset operation answers an `AssetReport` (`cli/src/asset/settle.ts`), which is a different type
from `WriteReport` and carries no `persisted`: an asset file is written at once and outside the undo
stack, so a three-state field that is always inapplicable would be a lie in the type. Its verdicts
are `ok` / `FAILED` / `TIMEOUT` only. Three facts about `asset-db` shape it, all established live
rather than read out of the typings:

- **`refresh-asset` and `reimport-asset` return before the import finishes.** So does the editor's
  own answer to `query-ready`, which flips back to `true` between two phases of one import. Waiting
  is therefore part of the command rather than the caller's problem: `settleAssetDb` polls a
  fingerprint of the asset tree (uuid, url, mtime, `imported`) plus the registered component-class
  list, and `cli/src/asset/settle.ts`'s `settled()` calls it done only once the database reports
  ready **and** that fingerprint has held unchanged for `--quiet-for` (1.5 s by default). A run that
  never goes quiet inside `--timeout` prints `TIMEOUT` and exits non-zero. **Every** asset command
  that changes the database waits — `mv`, `cp`, `mkdir`, `rm` as well as `refresh` and `reimport` —
  so `settled` is a real answer for all of them rather than a constant for some.
- **`move-asset`, `copy-asset`, `create-asset` and `delete-asset` answer `null` on success.**
  Checked live 2026-08-20: a move that landed the file in its new folder with its uuid intact still
  answered `null`. Their return value is therefore never read. What happened is asked of the database
  afterwards and lands in `landedAt` — `queryUrl(uuid)` for a move or a delete, the settle diff's
  `added` for a copy, `queryAssetInfo(url)` for a mkdir. `target` stays the address that was asked
  for, and the line says `landed at …` only when the two differ.
- **A taken address is renamed around, not refused.** Checked live 2026-08-20: `move-asset` of
  `a.txt` onto an existing `b.txt` with `rename: true` (the default when `--overwrite` is absent)
  landed it at `b-001.txt` with its uuid intact — it did not stay where it was. So a copy's address
  is read off what the database GAINED (`copiedAddress`) rather than asked of the target url, which
  would answer with whatever asset already sat there.

The component-class delta is in the report for one reason: a refresh is run because the editor is
serving a stale `@ccclass`, so `component classes: +TargetPolicy -Npc` is the answer to the
question actually being asked, and a file-only report answers a different one. When the scene does
not answer, the delta is `null` and the note says so — silence is not the same answer as "nothing
changed".

Asset operations are outside the scene's undo stack; Ctrl+Z does not take them back.

## Prefab Linkage

A node made from a prefab asset is either an INSTANCE that tracks the asset or a flat copy that
does not, and nothing in the node tree or the component list tells them apart — only `node._prefab`
and the `_prefab` block in the saved scene do.

`scene:create-node` forwards `type` verbatim and never derives it from the uuid, while the editor's
`createNodeFromAsset` strips the PrefabInfo on the branch `('cc.Prefab' !== type || unlinkPrefab)`.
A call that sends `assetUuid` alone therefore lands in the `type === undefined` arm and gets the
flat copy, silently. `cli/src/prefab-linkage.ts`'s `applyLinkageOptions` is what puts `type` on the
payload, and it puts it there for `cc.Prefab` only — `createNodeFromAsset` returns no node at all
for a type outside its creatable list, so forwarding an arbitrary asset type would turn assets that
instantiate today into no-ops.

Linkage is then reported rather than assumed, from two places: the live node, and what the editor's
serializer emits for it. They can disagree — a PrefabInfo the runtime holds and the serializer drops
is a link that dies on save — so `linkageVerdict` has four outcomes, not two, and the one where the
serializer could not be reached is `UNVERIFIED` rather than a `false`. The other three map onto the
same five words as a property write: no PrefabInfo is `FAILED`, a link the serializer drops is
`UNPERSISTED`, a link confirmed on both sides is `ok`.

`prefab create` writes the asset from `createPrefabFromNode2`, which is the editor's own serializer.
A hand-rolled one was tried and dropped mesh and material references, producing prefabs that
rendered empty.

## Adding a Command

1. Add or extend `cli/src/commands/<group>.ts`, exporting `registerXxx(program: Command, resolve: ()
   => Promise<Resolved>)` that does `program.command('<group>').description(...)` and attaches
   subcommands with Commander's own `.command()`/`.option()`/`.requiredOption()`/`.action()` —
   `scene.ts`, `node.ts`, `component.ts` are the shape to copy.
2. **The subcommand itself is an exported `(client: Driver, spec) => Promise<Report>`**, one per
   subcommand, and `spec` is one object carrying everything the command takes. That function is what
   a test calls; nothing a command decides lives in a Commander callback, because nothing reaches
   that callback except through `parseAsync(argv)`. The three subcommands that take nothing
   (`scene info`, `scene save`, `asset ready`) are `(client) => Promise<Report>`.
   The `.action()` body is then wiring and nothing else: turn the typed text into values through
   `commands/flags.ts` (`booleanFlag`, `numberFlag`, `vec3Flag`, `vec3PartsFlag`, `jsonFlag` —
   `asset.ts`'s `waitOptions` is the same thing for `--timeout`/`--quiet-for`), and hand the spec to
   `withClient(resolve, client => xxx(client, spec))` from `commands/shared.ts`. `withClient` is the
   one place that resolves the connection, closes it in every branch (success or thrown), and turns
   a thrown `Error` into `process.exitCode = EXIT.FAILED` on `stderr`. A command answers a `Report`
   (`cli/src/render/present.ts`); it assembles neither stream nor the exit code, and never calls
   `process.stdout.write` itself. A `--json` option is handed to `withClient` as its third argument.
3. Call a primitive as `client.editor.<group>.<method>(...)` or `client.scene.call('<method>', ...)`
   — the latter is typed against `SceneMethods`, so a signature drift is a compile error. Use
   `unwrap()` from `commands/shared.ts` when the command needs the scene script's `data` rather than
   the raw `SceneResult`.
4. A node argument that can be a path or a uuid goes through `resolveNode()` (`commands/node.ts`)
   rather than a new ad hoc check.
5. A write that should undo as one step wraps its mutating calls in `withUndoBracket` and folds
   `undoNote` into the printed result, the way `nodeCreate` and `componentSet` do.
6. Register the group in `cli/src/main.ts`'s `buildProgram()`, passing `() =>
   resolveClient(program.opts().project)` — a thunk, not a called value, so a `--project` option is
   read at resolve time, not at registration time.

Pure decision logic (shaping a value, judging a property's kind, comparing a read-back) belongs in
its own module next to `property/`/`render/`, not inlined in the action body — that is what the test
suite reaches.

## Adding a Driver Primitive

Both kinds are gated by the same list: `shared/src/protocol.ts`'s `EDITOR_METHODS`/`SCENE_METHODS`.
`driver/src/pipe-server.ts` registers a JSON-RPC method for every entry in `ALL_METHODS`, and
`driver/src/method-table.ts`'s `resolveMethod` refuses anything `isKnownMethod` does not recognize —
a primitive implemented but left off this list is unreachable from the CLI. `cli/src/driver/client.ts`'s
`editor` facade is generated by iterating `EDITOR_METHODS`, so `client.editor.<group>.<method>` exists
on the CLI side as soon as the name is listed and declared, with no further CLI-side code required.

**`editor.*` (a call `Editor.Message` already answers).**

1. Add it to the matching group in `driver/src/editor-api.ts` (`scene`, `assetDb`, `builder`,
   `project`) as a call to the private `request(pkg, msg, ...args)`, generic over
   `EditorMessageMaps` — the message name, its parameters and its result are compiler-checked against
   Creator's own typings, and `EditorRequestError` names which message failed.
2. Two exceptions to that guarantee: `begin-recording`, `end-recording` and `cancel-recording`
   resolve through the map's index signature rather than a declared entry, so their types are
   asserted, not proven. `project.profile` is not a message at all — it reads `Editor.Profile`
   directly and can throw synchronously.
3. Declare it in the matching group of `EditorMethods` (`shared/src/editor-contract.ts`) as
   `Message<'pkg', 'message-name'>`, which takes its parameters and its result from Creator's own
   map. `Answering<'pkg', 'message-name', R>` keeps the parameters and replaces the result, for a
   message whose declared result is wrong; a full signature written out is for one that does not
   forward verbatim, and it says why.
4. Add `'group.method'` to `EDITOR_METHODS` in `shared/src/protocol.ts`. Steps 3 and 4 are checked
   against each other — a name in one and not the other stops `protocol.ts` compiling.

**`scene.*` (needs `cc.*`).** The scene script is a separate bundle (`driver/src/scene/index.ts`, its
own `tsup` entry, loaded by the scene worker), and these places must agree:

1. Declare the signature in `SceneMethods` (`shared/src/scene-contract.ts`).
2. Implement it in the `driver/src/scene/<concern>.ts` that owns that concern (`dump`, `node-ops`,
   `component-ops`, `property-write`, `prefab-ops`, `query`) — `engine.ts` holds helpers the others
   share, not methods of its own.
3. Export it from the `methods` object in `driver/src/scene/index.ts` — dispatch there is by name on
   that object, and that export alone makes the method callable.
4. Add its bare name to `SCENE_METHODS` in `shared/src/protocol.ts`.

Call it from the CLI as `client.scene.call('methodName', ...)`; `DriverClient` is typed by
`SceneMethods`, so a signature drift is a compile error there too.

`contributions.scene.methods` in `driver/package.json` is Cocos Creator's own declared inventory of
the scene script, read by the editor host rather than by any code in this repo — nothing here
dispatches off it. Keep it in step anyway, as documentation of the scene surface; a missing entry
there is untidiness, not a defect.

## Checkpoint Procedure

A change in `cli/`:

1. `npm run test:only --workspace cli` for the red-green loop — it needs no build. `npx tsc -p
   cli/tsconfig.json` type-checks, and `npm test` runs the whole thing before a commit.
2. Run the affected command(s) against a real open editor and read the answer — don't assume it.

A change in `driver/` (this includes a change to `shared/`, since `driver`'s `tsup` build inlines
`@cocos-cli/shared` into its bundle) needs one more step: **restart the editor by hand**. Toggling
the extension off and on in the Extension Manager leaves the old bundle running — checked live
2026-08-20 (PLY-9): after `npm run build` and a toggle, `hello`'s `surfaceChecksum` still answered
the old value and a freshly added method answered `Method not found`. The scene worker caches
`driver/src/scene/` the same way, and neither the rebuild nor the toggle busts that one either. The
driver process is what has to reload, and only a restart of the editor reloads it.

Then check that the restart carried the new bundle. `cocos instances` prints the editor's pid, which
is a different number after a restart; when the change adds or removes a method,
`cocos instances --json` also carries `surfaceChecksum`, which moves with the method list. When the
change touches neither list, the changed behaviour itself is the check.

A write-path change is only checked once the scene has been saved and Ctrl+Z tried.

## Conventions

- **Tests on pure functions and on command bodies through one in-memory adapter**
  (`cli/src/driver/memory.ts`). No Commander-wiring and no UI tests. A command's own double does not
  get written: a fifth hand-rolled fake is what this rule replaced. Load the `writing-unit-tests`
  skill before writing one. A case earns its place only if a mutation of production code fails it.
- **Comments are the exception, not the default.** Load `writing-code-comments` before writing one.
  What is visible from the code and the names does not get restated.
- One command group per `cli/src/commands/<group>.ts`; one concern per `driver/src/scene/<concern>.ts`.
- Each of `shared/`, `driver/`, `cli/` carries its own `tsconfig.json` and `strict: true`; there is
  no config file above the package level, so `npm run build` over the three workspaces is the whole
  type-check. `shared` emits `dist/`, which the other two import. `driver` and `cli` emit nothing
  from `tsc` (`noEmit`) — it is their type-check — and ship a `tsup` bundle instead: `driver` into
  `dist/` (the extension's actual `main`), `cli` into `bin/cocos.js` (the actual `cocos` binary),
  both built from `src/` directly.

## Settings

`{project}/settings/mcp-server.json`: `enableDebugLog` only. Every driver primitive and every CLI
command is always reachable — there is no per-primitive or per-command enable/disable.

## Agent skills

### Issue tracker

Issues live in YouTrack project `PLY`, driven with the `yt` CLI (`youtrack-cli`).
See `docs/agents/issue-tracker.md`.

**A ticket you implemented gets closed in the same run** — comment, `--state Done`, and a pointer in
the parent map. `/implement` stops at the commit and says nothing about the tracker, so this step
belongs to whoever ran it. The procedure is `docs/agents/issue-tracker.md`, *Closing a ticket you
implemented*; it is not optional and does not need asking.

### Triage labels

The seven canonical triage roles are YouTrack tags under their default names.
See `docs/agents/triage-labels.md`.

### Domain docs

Single-context — `CONTEXT.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.
