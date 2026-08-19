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
npm run build --workspace cli     # rebuild only cli — fine once shared/dist is already current
npm run build --workspace driver  # rebuild only driver, likewise
npm link --workspace cli          # put the `cocos` binary (cli/bin/cocos.js) on PATH
```

`shared` must build before `driver` and `cli` type-check: both import straight from
`@cocos-cli/shared/dist/...`, and the root `workspaces` array (`shared`, `driver`, `cli`) is what
gives `npm run build`/`npm test` that order. Each package's own tests live under its own `test/`
and run against its `tsc` output (`lib/` in `driver` and `cli`, `dist/` in `shared`, which has no
bundling step) — not against the `tsup` bundle.

## Architecture

Four execution contexts:

```
agent
  │ shell — the only interface
CLI                    cli/src/            all the logic: commands, orchestration, undo, rendering
  │ JSON-RPC over a local channel (named pipe on Windows, unix socket elsewhere)
driver                 driver/src/         87 native primitives, no logic of its own
  ├ editor.*           58 methods over Editor.Message
  └ scene.*            29 methods over the scene script
scene script           driver/src/scene/   the only place `cc.*` exists
```

`shared/` holds the types and pure logic both sides need: the scene contract (`SceneMethods`,
`WriteReport`, `SceneResult`), the list of all 87 methods and the check that gates them
(`protocol.ts`), the handshake shape (`Hello`), the channel address (`pipe-name.ts`), node-path
parsing, and serialized-value comparison (`serialized-diff.ts`, `reference-projection.ts`).

**Key constraint:** engine APIs (`cc.*`) exist only in the scene script context. Anything that needs
them goes through `scene.*`, never through `editor.*`.

Command groups implemented in `cli/src/commands/` today: `scene`, `node`, `component`, plus the
top-level `instances`. More groups (prefab, asset, build, project, log, ecs, a raw `evalInScene`
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
| `shared/src/protocol.ts` | `EDITOR_METHODS`/`SCENE_METHODS` — the 87-method list that is the driver's whole reachable surface; `isKnownMethod`; the handshake `Hello` shape |
| `shared/src/pipe-name.ts` | project path → channel address, computed identically by both sides |
| `shared/src/scene-contract.ts` | `SceneMethods`, `WriteReport`, `SceneResult` — the typed contract with the scene script |
| `driver/src/main.ts` | extension entry: `load`/`unload`, starts and stops the `PipeServer`; also answers the panel's IPC (`openPanel`, `getDriverStatus`, `updateSettings`) |
| `driver/src/pipe-server.ts` | the channel server: one request at a time (`p-queue`), the bracket gate that blocks other connections while one holds an open undo bracket, `hello`'s `surfaceChecksum` |
| `driver/src/method-table.ts` | resolves a dotted method name to a callable, refusing anything `isKnownMethod` does not know |
| `driver/src/editor-api.ts` | every `Editor.Message` call, typed over `EditorMessageMaps` |
| `driver/src/scene-script-client.ts` | `SceneScriptClient` — wraps `editor.scene.executeSceneScript`, typed by `SceneMethods`; what `method-table.ts` calls for every `scene.*` request |
| `driver/src/scene/` | the scene script; `index.ts` assembles `SceneMethods` from `dump`/`node-ops`/`component-ops`/`property-write`/`prefab-ops`/`query`, with `engine.ts` holding the helpers they share |
| `driver/src/panels/default/index.ts` | the Vue settings panel — status and `enableDebugLog`, over the IPC `main.ts` answers, not over the pipe |
| `cli/src/main.ts` | the command tree (`buildProgram`), the entry point `bin/cocos.js` runs |
| `cli/src/discovery.ts` | enumerates channels, probes each with `hello`, `selectInstance` narrows by `--project` |
| `cli/src/resolve.ts` | `resolveClient` — discovery, selection and connect, in the shape every command's `resolve` thunk needs |
| `cli/src/driver-client.ts` | `DriverClient` — the `editor.*`/`scene.*` facades over JSON-RPC; `editor` is generated from `EDITOR_METHODS`, `scene.call` is typed by `SceneMethods` |
| `cli/src/commands/shared.ts` | `withClient` (resolve → run → print → close — the one place command output touches `stdout`/`stderr`) and `unwrap` (`SceneResult<T>` → value or thrown error) |
| `cli/src/undo-bracket.ts` | `withUndoBracket` — one write wrapped in one undo step, `undoNote` when the editor refused or left it open |
| `cli/src/property/` | kind resolution (`kind.ts`), dump-value projection for read-back comparison (`readers.ts`, used by both neighbors below), the writer cascade (`writers.ts`), the disk/serializer verified-write wrapper (`verified-write.ts`) |
| `cli/src/render/` | `tree.ts`, `report.ts`, `instances.ts` — the text (or `--json`) the agent actually reads |

Everything a command decides that does not need a live editor lives in a pure module beside
`commands/`: `property/`, `render/`, `node-type.ts`, `settle.ts`, `discovery.ts`'s `selectInstance`.
These are what the test suite covers. `commands/*.ts`, `driver-client.ts`, `resolve.ts` and `main.ts`
talk to a live editor or to Commander's own wiring, and are verified live.

## Write Honesty and Undo Brackets

A property write answers a `WriteReport` (`shared/src/scene-contract.ts`):

- `written` — the write was issued; `verified` — the value was read back;
- `persisted: boolean | null` — **three-state**. `true` proven a save carries it, `false` proven it
  does not, `null` **nobody looked**. `null` is not a soft `false`.
- `channel: 'editor' | 'live'` — what `persisted: false` means depends on it. The editor channel
  serializes, so `false` there is a value a save would drop. The live channel records nothing by
  construction, so `false` there is the expected state, not a defect.

`cli/src/property/writers.ts` holds the writer cascade (`WRITERS`, one entry per property kind, the
first `claims()` wins) and `cli/src/property/verified-write.ts` follows a writer's result with a
disk- or serializer-verdict pass — both are pure, tested, and ready to drive a command, but no
command calls them yet: `component set` (`cli/src/commands/component.ts`) currently assembles its
own `WriteReport` by hand for the scalar/vec/color/enum case only, rather than going through the
cascade. `cli/src/render/report.ts`'s `renderWriteReport` is how a `WriteReport` reaches the agent's
terminal either way — `persisted: null` prints as `unknown`, never as `false`.

**Undo brackets.** `withUndoBracket(client, nodeUuid, write)` (`cli/src/undo-bracket.ts`) wraps a
write in the driver's begin/end-recording pair so Ctrl+Z takes it back, and returns an `undoNote`
when the editor refused to record or left the step open. `driver/src/pipe-server.ts` backs this with
a bracket gate: while one connection holds an open bracket, every other connection's calls wait for
it, and a socket that closes mid-bracket has its dangling recording cancelled instead of left open.

## Adding a Command

1. Add or extend `cli/src/commands/<group>.ts`, exporting `registerXxx(program: Command, resolve: ()
   => Promise<Resolved>)` that does `program.command('<group>').description(...)` and attaches
   subcommands with Commander's own `.command()`/`.option()`/`.requiredOption()`/`.action()` —
   `scene.ts`, `node.ts`, `component.ts` are the shape to copy.
2. Every action body runs through `withClient(resolve, async client => { ...; return { stdout,
   stderr }; })` from `commands/shared.ts` — it is the one place that resolves the connection, closes
   it in every branch (success or thrown), and turns a thrown `Error` into `process.exitCode =
   EXIT.FAILED` on `stderr`. An action returns a `CommandOutput`; it does not call
   `process.stdout.write` itself.
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
a primitive implemented but left off this list is unreachable from the CLI. `cli/src/driver-client.ts`'s
`editor` facade is generated by iterating `EDITOR_METHODS`, so `client.editor.<group>.<method>` exists
on the CLI side as soon as the name is listed, with no further CLI-side code required.

**`editor.*` (a call `Editor.Message` already answers).**

1. Add it to the matching group in `driver/src/editor-api.ts` (`scene`, `assetDb`, `builder`,
   `project`) as a call to the private `request(pkg, msg, ...args)`, generic over
   `EditorMessageMaps` — the message name, its parameters and its result are compiler-checked against
   Creator's own typings, and `EditorRequestError` names which message failed.
2. Two exceptions to that guarantee: `begin-recording`, `end-recording` and `cancel-recording`
   resolve through the map's index signature rather than a declared entry, so their types are
   asserted, not proven. `project.profile` is not a message at all — it reads `Editor.Profile`
   directly and can throw synchronously.
3. Add `'group.method'` to `EDITOR_METHODS` in `shared/src/protocol.ts`.

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

1. `npm test` (builds `shared` → `driver` → `cli`, then runs every package's tests), or, for a
   faster loop when `shared/` did not change, `npm run build --workspace cli` followed by
   `npm run test:only --workspace cli`.
2. Run the affected command(s) against a real open editor and read the answer — don't assume it.

A change in `driver/` (this includes a change to `shared/`, since `driver`'s `tsup` build inlines
`@cocos-cli/shared` into its bundle) needs one more step: **toggle the extension off and on by hand**
in the editor's Extension Manager. Nothing else busts Node's require cache — rebuilding does not, and
nothing on the channel itself does either, since the driver process is what would need to reload.

A write-path change is only checked once the scene has been saved and Ctrl+Z tried.

## Conventions

- **Tests only on pure functions.** No wiring, editor-state or UI tests. Load the `writing-unit-tests`
  skill before writing one. A case earns its place only if a mutation of production code fails it.
- **Comments are the exception, not the default.** Load `writing-code-comments` before writing one.
  What is visible from the code and the names does not get restated.
- One command group per `cli/src/commands/<group>.ts`; one concern per `driver/src/scene/<concern>.ts`.
- Each of `shared/`, `driver/`, `cli/` carries its own `tsconfig.json` — `strict: true`,
  `target: ES2017`, `module: CommonJS` in all three — rather than extending a shared base; there is
  no config file above the package level that any of them draws from. `driver` and `cli` also build a
  bundle with `tsup` — `driver` into `dist/` (the extension's actual `main`), `cli` into `bin/cocos.js`
  (the actual `cocos` binary) — alongside the modular `tsc` output the tests import (`lib/` in both,
  `dist/` in `shared`, which has no bundle step of its own).

## Settings

`{project}/settings/mcp-server.json`: `enableDebugLog` only. Every driver primitive and every CLI
command is always reachable — there is no per-primitive or per-command enable/disable.

## Leftover: `source/`

`source/` and the root-level `test/` predate this split. They still hold twelve pure modules
(`asset-json.ts`, `asset-query.ts`, `batch-plan.ts`, `build-task.ts`, `ecs-census.ts`,
`log-search.ts`, `missing-scripts.ts`, `prefab-json.ts`, `prefab-linkage.ts`, `prefab-value.ts`,
`project-log.ts`, `reference-scan.ts`) that nothing in `shared/`, `driver/` or `cli/` imports.
Neither `npm run build` nor `npm test` touches them: the root `tsconfig.json` that once compiled
`source/` now also matches `cli/`'s and `driver/`'s own `.ts` files by its default include pattern,
and errors outright if pointed at directly. They are not part of the architecture above; they are
raw material for a later migration into `cli/src/`, kept only so that migration has something to
move.
