# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

A Cocos Creator 3.8.x editor extension that exposes the editor over MCP (Model Context Protocol),
so an AI client drives scenes, prefabs, assets and builds through `http://127.0.0.1:4000/mcp`. This
is a fork; the tool surface is 89 tools and is deliberately narrower and stricter than upstream's.

## Build Commands

```bash
npm install          # Install dependencies
npm run build        # Compile TypeScript → dist/
npm run watch        # Watch mode (auto-recompile on changes)
npm test             # tsc, then node --test over test/
```

## Architecture

Four execution contexts, and the layer each piece of code belongs to:

```
AI client
  │ POST /mcp — MCP Streamable HTTP
BridgeServer            source/server.ts        SDK Server + transport, built per request
  │ registry.invoke(name, args, ctx)
ToolRegistry            source/registry.ts      one entry per tool; nodePath → uuid; unknown-name suggestion
  │ tool.invoke(args, ctx)
tool definitions        source/tools-v2/*.ts    defineTool: zod schema + handler, composed by index.ts
  │ ctx.editor / ctx.sceneScript
gateways                source/editor-api.ts    every Editor.Message call, typed
                        source/scene-script-client.ts + scene-contract.ts
  │ Editor.Message('scene', 'execute-scene-script')
scene script            source/scene/*.ts       the only place `cc.*` exists; index.ts assembles SceneMethods
```

Everything a tool decides that does not need the editor lives in a **pure module** beside these:
`property/` (kind resolution, readers, writers, verified write), `prefab-json.ts`, `prefab-value.ts`,
`prefab-linkage.ts`, `reference-scan.ts`, `reference-projection.ts`, `batch-plan.ts`, `build-task.ts`,
`asset-query.ts`, `asset-json.ts`, `node-path.ts`, `node-type.ts`, `project-log.ts`, `log-search.ts`,
`serialized-diff.ts`, `scene-signature.ts`, `settle.ts`, `json-arg.ts`, `ecs-census.ts`,
`undo-bracket.ts`, `missing-scripts.ts`. These are what the test suite covers; the layers above them
are verified live.

`main.ts` is the composition root and the only place that constructs anything: settings → `EditorApi`
→ `SceneScriptClient` → `PreviewLogStore` → `ToolContext` → `composeTools(ctx)` → `BridgeServer`.

**Key constraint:** engine APIs (`cc.*`) exist only in the scene script context. Anything that needs
them goes through `SceneScriptClient`, never through `EditorApi` directly.

## Key Files

| File | Role |
|------|------|
| `source/main.ts` | Extension entry: composition root, `load`/`unload`, panel IPC |
| `source/server.ts` | `BridgeServer`: `/mcp`, `/preview-log`, `/preview-console.js` |
| `source/registry.ts` | `ToolRegistry`: advertises tools, resolves node paths, invokes |
| `source/tool.ts` | `defineTool`: alias handling, zod validation, `tool_throw` containment |
| `source/tools-v2/index.ts` | `composeTools`: the single list of every registered tool |
| `source/editor-api.ts` | Every `Editor.Message` call, typed over `EditorMessageMaps` |
| `source/scene-contract.ts` | `SceneMethods` — the typed contract between extension and scene script |
| `source/scene-script-client.ts` | `ctx.sceneScript.call(method, ...args)`, typed by that contract |
| `source/scene/` | Scene script: engine access; `index.ts` assembles `SceneMethods` |
| `source/result.ts` | `ok` / `fail` / `isOk` — the response envelope |
| `source/settings.ts` | JSON settings persistence to `{project}/settings/mcp-server.json` |
| `source/types/index.ts` | `MCPServerSettings`, `ServerStatus` — nothing else lives here |
| `source/panels/default/index.ts` | Vue 3 control panel UI |

## Response Envelope

Every tool answers `ToolResult`, and the server puts it on the wire as one JSON text block with
`isError` set from `success`:

```typescript
{ success: true,  data: T, message?: string }
{ success: false, error: { code, message, hint? }, data?: unknown }
```

`fail(code, ...)` codes are part of the surface — `invalid_args`, `unknown_tool`, `node_path`,
`tool_throw`, `scene_script`, `batch_failed` and the per-tool ones. A failure may still carry `data`:
that is how a refused write reports what it saw.

**Write honesty.** A property write answers a `WriteReport` (`source/scene-contract.ts`):

- `written` — the write was issued; `verified` — the value was read back;
- `persisted: boolean | null` — **three-state**. `true` proven a save carries it, `false` proven it
  does not, `null` **nobody looked**. `null` is not a soft `false`.
- `channel: 'editor' | 'live'` — what `persisted: false` means depends on it. The editor channel
  serializes, so `false` there is a value a save would drop. The live channel records nothing by
  construction, so `false` there is the expected state, not a defect.

**Undo brackets.** `withUndoBracket(ctx, nodeUuid, write)` wraps a write in the editor's
begin/end-recording pair so Ctrl+Z takes it back, and reports `undoNote` when the editor refused to
record or left the step open. Node creation followed by a transform write is **two undo entries**
(the structural one the editor records itself, plus the bracket) — say so in a tool description
rather than promising one Ctrl+Z.

## Adding a Tool

1. Write it with `defineTool` in the `source/tools-v2/*.ts` module that matches its category —
   the module's exported array is the category, and the array is what `composeTools` spreads.
2. Scalars in the schema must be `z.coerce.number()` and the `booleanArg` helper from `tool.ts`
   (`z.coerce.boolean()` is `Boolean(value)`, so a REST client's `'false'` would arrive as `true`).
   A genuinely any-typed parameter gets `ANY_VALUE_TYPE` through `anyValued(...)`.
3. Alternate spellings go in `aliases: { alias: 'canonical' }`. `defineTool` throws at definition
   time if an alias shadows a declared parameter or points at one the schema does not declare.
4. Add it to the module's exported array. A tool absent from that array is advertised nowhere.
5. `nodeUuid` / `uuid` parameters are augmented by the registry into an alternative `nodePath`
   automatically (`source/node-path.ts`); do not hand-roll path handling in a handler.

Tests for the tool go against its pure part. A handler that only talks to gateways is verified live.

## Adding an EditorApi Method

Add it to the matching group in `source/editor-api.ts` (`scene`, `assetDb`, `builder`, `project`) as
a call to the private `request(pkg, msg, ...args)`, which is generic over `EditorMessageMaps` — so
the message name, its parameters and its result are compiler-checked against Creator's own typings,
and `EditorRequestError` carries which message failed.

Two exceptions to that guarantee: `begin-recording`, `end-recording` and `cancel-recording` resolve
through the map's index signature rather than a declared entry, so their types are asserted, not
proven. Anything about them is settled by a live run, not by tsc. `project.profile` is not a message
at all — it reads `Editor.Profile` directly and can throw synchronously.

## Adding a Scene Method

The scene script is a separate bundle loaded by the scene worker, and three places must agree:

1. Declare the signature in `SceneMethods` (`source/scene-contract.ts`).
2. Implement it in the `source/scene/<concern>.ts` that owns that concern (`dump`, `node-ops`,
   `component-ops`, `property-write`, `prefab-ops`, `query`, `engine`).
3. Export it from the `methods` object in `source/scene/index.ts` — dispatch is by name on that
   object, and that export alone makes the method callable.

The list under `contributions.scene.methods` in `package.json` is **not** load-bearing: 20 methods
absent from it were called successfully. Keep it in step anyway, as the declared inventory of the
scene surface, but a missing entry is untidiness rather than a defect.

Call it as `ctx.sceneScript.call('methodName', ...args)`; the client is typed by the contract, so a
signature drift is a compile error. Scene-side results use `SceneResult<T>` (`success`/`data`/`error`)
and are turned into the tool envelope by `fromScene` in `source/tools-v2/shared.ts`.

## Checkpoint Procedure

The bridge cannot be judged by a green test suite: the test suite covers the pure modules only.

1. `npm run build` (or `npm test`, which builds first).
2. **Toggle the extension OFF and ON by hand** in the editor's Extension Manager. Nothing else busts
   Node's require cache — `disable`/`enable` over IPC does not, and neither does rebuilding.
3. Smoke the change over the live bridge: `tools/list` for the surface count, then the tools the
   change touched, on a real scene, and read the answer rather than assuming it.
4. A write-path change is only checked once the scene has been saved and Ctrl+Z tried.

## Conventions

- **Tests only on pure functions.** No wiring, editor-state or UI tests. Load the `writing-unit-tests`
  skill before writing one. A case earns its place only if a mutation of production code fails it.
- **Comments are the exception, not the default.** Load `writing-code-comments` before writing one.
  What is visible from the code and the names does not get restated.
- One tool per `defineTool`, one concern per module.
- `base.tsconfig.json` is `strict: true`, `target: ES2017`, `module: CommonJS`; output goes to `dist/`.

## Settings

`{project}/settings/mcp-server.json`: `port` (default 4000), `autoStart`, `enableDebugLog`,
`maxConnections`. Every tool is always on — there is no per-tool enable/disable.

## HTTP Endpoints

- `POST /mcp` — MCP Streamable HTTP, the only tool interface; other methods answer 405
- `POST /preview-log` — console batches forwarded from a running preview page
- `GET /preview-console.js` — the script preview pages inject to do that forwarding
