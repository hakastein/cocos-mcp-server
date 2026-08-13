# Cocos MCP Server

An MCP (Model Context Protocol) server that runs as a Cocos Creator 3.8.x editor extension, so an AI
client (Claude Code, Claude Desktop, Cursor) drives the editor: scenes, nodes, components, prefabs,
assets, builds and the preview.

This is a fork. The surface is **89 tools**, rewritten to answer honestly rather than broadly: a
write is read back, a refusal says what it refused, and a value the editor would drop on save is
reported as such instead of being called a success.

## Compatibility

| Cocos Creator | Status |
|---|---|
| 3.8.x | Supported (developed against 3.8.8) |
| 3.7.x | Untested |

## Installation

Copy — or junction — the extension folder into the **project's** `extensions` directory:

```
{your-project}/
└── extensions/
    └── cocos-mcp-server/
```

The global directory `~/.CocosCreator/extensions/` does **not** work: Cocos only loads extensions
from the project. Then **Extension → Extension Manager → Project**, find `cocos-mcp-server`, enable it.

### Build from source

```bash
npm install
npm run build        # tsc → dist/
npm run watch        # recompile on change
npm test             # tsc, then node --test over test/
```

After a rebuild the extension must be toggled **OFF and ON by hand** in the Extension Manager —
nothing else busts Node's require cache.

## Usage

Open the control panel via **Extension → Cocos MCP Server** and click **Start Server**.
Default address: `http://127.0.0.1:4000/mcp`.

**Claude Code:**
```bash
claude mcp add --transport http cocos http://127.0.0.1:4000/mcp
```

**Claude Desktop** (`claude_desktop_config.json`):
```json
{
  "mcpServers": {
    "cocos": { "url": "http://127.0.0.1:4000/mcp", "transport": "http" }
  }
}
```

**Cursor / VS Code:** add an HTTP-type MCP server pointing at `http://127.0.0.1:4000/mcp`.

## Response Envelope

Every tool answers the same shape, delivered as one JSON text block with the protocol's `isError`
set from `success`:

```jsonc
{ "success": true,  "data": { }, "message": "…" }
{ "success": false, "error": { "code": "…", "message": "…", "hint": "…" }, "data": { } }
```

`code` is stable and worth branching on: `invalid_args`, `unknown_tool`, `node_path`, `tool_throw`,
`scene_script`, `batch_failed`, plus per-tool codes such as `node_not_found` or `write_not_persisted`.
A failure may still carry `data` — that is how a refused write reports what it observed.

### Write reports

A property write answers a `WriteReport`:

| field | meaning |
|---|---|
| `written` | the write was issued |
| `verified` | the value was read back |
| `persisted` | `true` a save carries it, `false` a save does not, **`null` nobody looked** |
| `channel` | `editor` (serializes) or `live` (the running scene only) |

`persisted: null` is not a soft `false`: it means the check was not asked for or could not run, and
claiming either answer would invent it. On `channel: "live"` a `persisted: false` is the expected
state, not a defect — the live channel records nothing by construction.

### Undo

Scene writes are wrapped in the editor's undo recording, so **Ctrl+Z takes a bridge write back**.
When the editor refuses to record, or leaves the step open, the result says so in `undoNote`.
Note that creating a node and then setting its transform is **two undo entries**, not one.

Not every writer takes that bracket: `component_remove_component` and
`component_remove_missing_scripts` remove a component directly, and Ctrl+Z does not bring it back —
measured, not assumed. For `component_remove_missing_scripts` this matters more than usual: `apply`
also writes the affected prefabs to disk, so the cost of that irreversibility is a file, not just the
current editor session.

### Node addressing

Any tool taking a node uuid also accepts `nodePath` — the slash path `scene_dump` prints, with
same-named siblings suffixed `#1`/`#2`. The registry resolves it to a uuid before the tool runs, and
a path matching nothing or several nodes fails loudly with code `node_path`.

## Tool Reference (89)

### Scene (15)
| Tool | Description |
|---|---|
| `scene_get_current_scene` | The open scene: name, uuid, db:// url, whether it exists on disk, load state, root count |
| `scene_get_scene_list` | Every `.scene` asset in the project as name + path + uuid |
| `scene_open_scene` | Open a scene by db:// path, replacing whatever is open |
| `scene_save_scene` | Write the open scene to its file |
| `scene_close_scene` | Close the open scene |
| `scene_create_scene` | Create a `.scene` holding an empty scene — root and global settings, no Canvas or camera |
| `scene_dump` | Every node as a flat list: uuid, name, full path, parent, active, child count, components |
| `scene_checksum` | Scene-state signature (per-path active + component classes, plus a sha1) for regression checks |
| `scene_find_component_owners` | Every node carrying a component of a given class |
| `scene_query_dirty` | Whether the open scene holds changes its file does not |
| `scene_query_ready` | Whether the editor finished loading the open scene |
| `scene_soft_reload` | Reload the scene in place, which is how recompiled scripts reach it |
| `scene_begin_undo_recording` | Open an undo step over a node and return its id |
| `scene_end_undo_recording` | Commit that step, making everything since one Ctrl+Z away |
| `scene_cancel_undo_recording` | Discard that step without pushing it onto the undo stack |

### Node (12)
| Tool | Description |
|---|---|
| `node_create_node` | Create a node: empty, with components, from an asset, or as a builtin primitive |
| `node_get_node_info` | One node in full, plus the 2D/3D verdict, the reasons for it and the transform constraints it implies |
| `node_find_nodes` | Nodes whose name matches, with the scene path that addresses each |
| `node_set_node_property` | Write name / active / layer / mobility, read back, with the channel named |
| `node_set_node_transform` | Set local position, rotation (euler) and/or scale, honouring 2D constraints |
| `node_delete_node` | Remove a node and its whole subtree |
| `node_move_node` | Reparent a node |
| `node_duplicate_node` | Duplicate a node with its subtree, as a sibling |
| `node_list_builtin_meshes` | The builtin primitive meshes with their sub-asset uuids |
| `node_copy_node` | Put nodes on the editor clipboard for a later paste |
| `node_cut_node` | Put nodes on the clipboard marked for a move |
| `node_paste_node` | Paste clipboard nodes under a parent and return the uuids they got |

### Component (7)
| Tool | Description |
|---|---|
| `component_add_component` | Add a component idempotently — a type already present is reported, not duplicated |
| `component_remove_component` | Remove a component from a node |
| `component_get_components` | Every component on a node with class id, class name, enabled flag and property values |
| `component_get_component_info` | One component in detail: per property its declared type, the write `kind`, and its value |
| `component_set_component_property` | The one property writer for a scene: verified, undo-bracketed, reports channel and persistence |
| `component_execute_component_method` | Call a method on a live component in the open scene |
| `component_remove_missing_scripts` | Remove components whose script was deleted from the project — the asset database decides, not what the component looks like; reports only unless `apply`, which re-serializes a changed prefab whole, so its on-disk diff is wider than the one removal |

### Prefab (14)
| Tool | Description |
|---|---|
| `prefab_get_prefab_list` | Every `.prefab` under a folder as name + path + uuid |
| `prefab_dump` | The node tree of a prefab **asset**, with each component's resolved class name |
| `prefab_add_component` | Add a component to a node inside a prefab asset on disk |
| `prefab_remove_component` | Remove a component from a node inside a prefab asset |
| `prefab_get_component_property` | Read one serialized property off a prefab asset, as the file holds it |
| `prefab_set_component_property` | Write one serialized property on a prefab asset |
| `prefab_validate_prefab` | Structural check that a `.prefab` parses and holds a `cc.Prefab` entry and a node |
| `prefab_instantiate_prefab` | Instantiate a prefab into the open scene as a **linked** instance |
| `prefab_create_prefab` | Write a prefab asset from a scene node using the editor's own serializer |
| `prefab_update_prefab` | Apply an instance's current state back onto the asset it tracks |
| `prefab_revert_prefab` | Throw away an instance's local changes |
| `prefab_restore_prefab_node` | Rebuild an instance node from its asset — the one prefab op that records an undo step |
| `prefab_list_overrides` | Every property override on an instance, with its target and whether an asset uuid still resolves |
| `prefab_remove_override` | Remove one override by property path, leaving the rest in place |

### Scene operations (8)
| Tool | Description |
|---|---|
| `sceneAdvanced_reset_node_property` | Reset one node property to its declared default — or, on an instance, to the prefab's value |
| `sceneAdvanced_reset_node_transform` | Reset position, rotation and scale in one call |
| `sceneAdvanced_reset_component` | Reset every property of a component to its defaults |
| `sceneAdvanced_move_array_element` | Move an array element by original index plus a signed offset |
| `sceneAdvanced_remove_array_element` | Remove the element at an index of an array property |
| `sceneAdvanced_query_scene_classes` | Every class registered with the engine, optionally only those extending a base |
| `sceneAdvanced_query_scene_components` | Every component type the editor offers, with cid, menu path and script uuid |
| `sceneAdvanced_query_nodes_by_asset_uuid` | Every node referencing an asset uuid — who uses this material/mesh/prefab |

### Assets (14)
| Tool | Description |
|---|---|
| `project_get_assets` | List assets under a folder, narrowed by type and name |
| `project_get_asset_info` | Everything the database knows about one asset, including disk path, size and sub-assets |
| `project_create_asset` | Create a file or folder, with `onConflict` = fail / overwrite / rename |
| `project_delete_asset` | Delete an asset or a whole folder |
| `project_copy_asset` | Copy an asset to another db:// location |
| `project_move_asset` | Move or rename an asset |
| `project_import_asset` | Copy a file from disk into the project and import it |
| `project_reimport_asset` | Re-run the importer on one asset |
| `project_refresh_assets` | Rescan a folder, importing what changed on disk |
| `project_save_asset` | Overwrite an existing asset's content and reimport it |
| `assetAdvanced_save_asset_meta` | Write a `.meta` file wholesale |
| `assetAdvanced_generate_available_url` | The url a new asset would get here: the url itself, or a numbered variant |
| `assetAdvanced_query_asset_db_ready` | Whether the asset database has finished starting up |
| `assetAdvanced_validate_asset_references` | Read every uuid reference out of serialized assets and name the ones nothing answers |

### Project and build (7)
| Tool | Description |
|---|---|
| `project_build_project` | Run a real build and wait for it to finish |
| `project_check_builder_status` | Builder readiness plus the build tasks that exist, queued, running or finished |
| `project_get_build_settings` | How building through this bridge behaves, plus whether the worker is up |
| `project_open_build_panel` | Open the editor's Build panel |
| `project_run_project` | Start the in-editor preview — the editor's own Play button |
| `project_get_project_info` | Which project is open: name, path, uuid, Creator version |
| `project_get_project_settings` | One settings category: general, physics, render or assets |

### Debug (7)
| Tool | Description |
|---|---|
| `debug_execute_script` | Execute JavaScript in scene context, with `cc`, `director` and `scene` in scope |
| `debug_project_logs` | Read the editor's own `temp/logs/project.log` — tail without a query, search with one |
| `debug_get_preview_logs` | Console output of the **running preview**, forwarded from the preview page |
| `debug_clear_preview_logs` | Drop everything buffered from the preview page |
| `debug_validate_scene` | Node-count health check over the open scene |
| `debug_get_editor_info` | Which editor and project this bridge is attached to, plus process memory and uptime |
| `debug_get_performance_stats` | Renderer counters — draw calls, triangles, memory (preview only) |

### Batch, ECS, skeletal animation (5)
| Tool | Description |
|---|---|
| `batch_run` | Execute a list of tool calls in one request, in order, with later calls able to read earlier results |
| `ecs_component_census` | Per-component read/write/add/remove census over the project's TypeScript, from real syntax trees |
| `skeletalAnimation_add_socket` | Attach a `SkeletalAnimation` socket to a bone, keeping baked animation working |
| `skeletalAnimation_list_sockets` | The sockets on a node's `cc.SkeletalAnimation`, each with its bone path and target |
| `skeletalAnimation_remove_socket` | Remove a socket by bone path, destroying its target node |

## Settings

Stored in `{project}/settings/mcp-server.json`.

| Setting | Default | Description |
|---|---|---|
| Port | `4000` | HTTP listening port |
| Auto Start | `false` | Start the server when the extension loads |
| Debug Log | `false` | Verbose bridge logging into the editor console |
| Max Connections | `10` | Maximum simultaneous clients |

Every tool is always on: there is no per-tool enable/disable, and no tool-manager configuration file.

## HTTP Endpoints

- `POST /mcp` — MCP Streamable HTTP, the only tool interface; other methods answer 405
- `POST /preview-log` — console batches forwarded from a running preview page
- `GET /preview-console.js` — the script preview pages inject to do that forwarding

## Troubleshooting

**The server will not start, port in use.** Change the port in the control panel and restart it.

**A tool answers `scene_script`.** The scene script bundle did not answer: no scene is open, or the
extension was rebuilt without being toggled OFF and ON.

**A tool answers `node_path`.** The path matched nothing or matched several nodes. Take the path
from `scene_dump` or `node_find_nodes` verbatim, including any `#1`/`#2` suffix.

**Source changes do not take effect.** `npm run build`, then toggle the extension OFF and ON in the
Extension Manager. Disabling and re-enabling over IPC is not enough.

**The extension is missing from the Extension Manager.** The folder name must match the `name` in
`package.json` (`cocos-mcp-server`), and it must be under the project's `extensions/`, not the
global directory.

## License

MIT
