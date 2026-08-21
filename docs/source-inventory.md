# What was in `source/`

`source/` and the root-level `test/` were the pure modules of the MCP-era bridge. Nothing in
`shared/`, `driver/` or `cli/` imported them, and neither `npm run build` nor `npm test` compiled
them, so they sat in the tree as raw material for a migration that has now been decided module by
module. They were deleted on 2026-08-20 (PLY-4).

This file is the manifest of that deletion: twelve modules, one destination each, every one marked
either **returns** or **buried**. Without it the next architecture review finds twelve clean,
well-commented modules in the git history and proposes bringing them all back.

Recover any of them with `git show 0e43954:source/<name>.ts`.

## Returns — the question is still live, the module is the starting point

| Module | Lines | What it decided | Where it goes |
|---|---|---|---|
| `ecs-census.ts` | 644 | Per-component-key census of an ECS kit over the TypeScript parser: who reads a key, who writes its fields, who adds and removes it, and which keys have readers and no writer at all. | **Returned** in PLY-14 as `cli/src/ecs/census.ts`, unchanged, under `ecs census`. |
| `build-task.ts` | 66 | `BuildExitCode` (36 is BUILD_SUCCESS, not a failure), the build-task description, and saved-vs-requested setting conflicts. | PLY-15 — the `build` group. |
| `log-search.ts` | 126 | Literal-by-default line search over `project.log`: a blank pattern is an error rather than a match-all, an invalid regex is reported rather than silently re-read as literal text, and `totalMatches` counts the file rather than the capped page. | PLY-15 — the `log` group. |
| `project-log.ts` | 164 | Entry-level parsing of `temp/logs/project.log`: the level is read from the line's own `- <level>:` field and continuation lines fold into the entry that owns them, instead of every stack frame being classified on its own words. | PLY-15 — the `log` group. |
| `reference-scan.ts` | 142 | Walks serialized assets and `.meta` for uuid references and `db://` paths. | Not ticketed yet; named in PLY-2's *Not yet specified*. The one offline-parsing module the burial below does not cover, because the live editor cannot answer its question — it does not know about files nobody touched. |

## Buried, with a live counterpart — already rewritten, do not migrate a second time

| Module | Lines | Live counterpart |
|---|---|---|
| `asset-query.ts` | 73 | `cli/src/asset/query.ts` — the editor typings dropped for a local shape. |
| `prefab-linkage.ts` | 207 | `cli/src/prefab-linkage.ts` — the `Editor.Message` calls dropped, the verdict reshaped from MCP result fields into a head word. |

## Buried — the decision was that the question should not be answered this way

Offline parsing of `.prefab` / `.meta` is buried on one reason: the live editor answers more
precisely, and grepping serialized files answers false-negative. That reasoning is also in
`skills/cocos/SKILL.md`. PLY-17 turns it into an ADR under `docs/adr/`; until that lands, this
section is where the reason is written down.

| Module | Lines | What it decided | Why buried |
|---|---|---|---|
| `prefab-json.ts` | 419 | `compressUuid` / `decompressUuid` (a script component's `__type__` is its asset uuid packed to 23 chars) and node/component lookup inside a serialized `.prefab`. | Offline parsing. |
| `prefab-value.ts` | 298 | Reading an any-typed `value` against the property's declared type before writing it into prefab JSON, so `"true"` does not land as the string `"true"`. | Offline parsing. The live path is `component set`, where the writer cascade in `cli/src/property/writers.ts` resolves the kind against the editor's own dump. |
| `asset-json.ts` | 38 | Resolving an asset's on-disk path through `asset-db` and reading or writing its JSON, preserving the file's existing line endings. | Offline parsing. |
| `missing-scripts.ts` | 47 | The verdict for a `cc.MissingScript` cid — a deleted script, a script that failed to load, or unverifiable — since a compile error produces `cc.MissingScript` for every script at once. | `scene.dumpMissingScripts` answers it live; the command is `cocos scene missing`. |
| `batch-plan.ts` | 168 | `{{0.field}}` token substitution threading one tool's result into the next call's arguments. | In a shell this is `&&`. |
