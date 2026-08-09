# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

CocosMCPPlugin is a Cocos Creator 3.8.x editor extension that implements an MCP (Model Context Protocol) server, allowing AI assistants (Claude, Cursor, etc.) to control the Cocos Creator editor via JSON-RPC 2.0 over HTTP.

## Build Commands

```bash
npm install          # Install dependencies
npm run build        # Compile TypeScript → dist/
npm run watch        # Watch mode (auto-recompile on changes)
```

`npm test` compiles and runs `node --test` over `test/` — pure functions only. Everything that
touches the editor is verified by installing the extension in Cocos Creator and driving
`http://127.0.0.1:4000/mcp`.

## Architecture

The system has four distinct execution contexts that communicate via Cocos Creator's IPC:

```
AI Client (MCP Streamable HTTP)
    ↓ POST /mcp
BridgeServer (server.ts)           ← @modelcontextprotocol/sdk Server + transport
    ↓ ToolRegistry.invoke(name, args, ctx)
tool executors                     ← run in extension process
    ↓ Editor.Message IPC (EditorApi / SceneScriptClient)
scene/ (scene script context)      ← direct access to cc.* engine APIs
```

`main.ts` is the composition root and the only place that constructs anything: settings →
`EditorApi` → `SceneScriptClient` → `PreviewLogStore` → `ToolContext` → `ToolRegistry` →
`BridgeServer`.

**Key constraint:** Engine APIs (`cc.*`) can only be called from `scene.ts` (the scene script context). Everything else runs in the extension process. Tools that need engine access must route through `Editor.Message` → `execute-scene-script`.

## Key Files

| File | Role |
|------|------|
| `source/main.ts` | Extension entry: composition root, `load`/`unload` lifecycle, panel IPC |
| `source/server.ts` | `BridgeServer`: SDK transport on `/mcp`, plus `/preview-log` and `/preview-console.js` |
| `source/registry.ts` | `ToolRegistry`: advertises tools, resolves node paths, invokes |
| `source/legacy-adapter.ts` | Wraps a `ToolExecutor` category as registry tools |
| `source/tool-registry.ts` | Instantiates the legacy executor categories |
| `source/scene/` | Scene script: engine API calls, node/component manipulation; `index.ts` assembles `SceneMethods` |
| `source/settings.ts` | JSON settings persistence to `{project}/settings/` |
| `source/types/index.ts` | Shared TypeScript interfaces (`ToolDefinition`, `ToolResponse`, `ToolExecutor`) |
| `source/tools/tool-manager.ts` | Per-tool enable/disable configuration |
| `source/panels/default/index.ts` | Vue 3 control panel UI |

## Tool System

All tool categories implement the `ToolExecutor` interface:

```typescript
interface ToolExecutor {
    getTools(): ToolDefinition[];
    execute(toolName: string, args: any): Promise<ToolResponse>;
}
```

The categories in `source/tools/` are instantiated in `createToolInstances()` and wrapped by
`legacyTools(category, executor)` into `ToolRegistry` entries named `{category}_{tool}`. A
`tools/call` reaches `ToolRegistry.invoke`, which validates arguments, turns `nodePath` arguments
into uuids and dispatches to the category's `execute()`.

**Tool categories:** `scene`, `node`, `component`, `prefab`, `project`, `debug`, `sceneAdvanced`, `assetAdvanced`, `skeletalAnimation`, `ecs`, `batch`.

## HTTP Endpoints

- `POST /mcp` — MCP Streamable HTTP (primary interface); other methods answer 405
- `POST /preview-log` — console batches forwarded from a running preview page
- `GET /preview-console.js` — the script that preview pages inject to do the forwarding

## Settings

Stored as JSON in `{project}/settings/mcp-server.json` — port (default: 4000), autoStart,
enableDebugLog, maxConnections. Every tool is always on.

## TypeScript Configuration

`base.tsconfig.json` uses `strict: true`, `target: ES2017`, `module: CommonJS`. The compiled output goes to `dist/`. The extension runs on Node.js inside Cocos Creator's Electron environment.

## Adding a New Tool

1. Add the tool definition to an existing category file's `getTools()` return array, or create a new `ToolExecutor` class.
2. Add the `execute()` case for the tool name.
3. If the tool needs engine access, add the method to `source/scene/` and declare it in `package.json` under `contributions.scene.methods`.
4. Register a new category class in `createToolInstances()` (if creating a new category).
