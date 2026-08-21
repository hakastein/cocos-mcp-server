---
name: cocos
description: Cocos Creator, open project — what nodes and components a scene holds, how something is wired, creating a node, adding and configuring a component. Required before reading, grepping or hand-parsing a `.scene`, `.prefab` or `.meta` — searching those files answers false-negative.
---

# Cocos through the `cocos` CLI

The open editor is the source of truth about the scene. The `cocos` binary asks it directly: one command in the shell, the answer on stdout.

The bridge lives in the `hakastein/cocos-cli-driver` repository: `driver/` is the editor extension, `cli/` is the binary itself.

## Searching `.scene` answers false-negative

Script components serialize under a compressed cid. Checked against the open `cc_action_1a.scene` (337 KB):

| query | answer |
|---|---|
| `grep -c FollowCamera cc_action_1a.scene` | `0` |
| `cocos scene tree \| grep FollowCamera` | `Main Camera  [cc.Camera,FollowCamera,BuiltinPipelineSettings]` |
| `grep -c GameBootstrap cc_action_1a.scene` | `0` |
| `cocos scene tree \| grep GameBootstrap` | `Game  [GameRoot,GameBootstrap]` |

In the file the component sits as `"__type__": "04e75MuPw1E2Y0YvYSnSKa5"`. Node references are indices, `{"__id__": 47}`. The `_active` field holds a local flag, and `activeInHierarchy` does not follow from it.

Ask `cocos` about what a scene or a prefab contains.

## Reading

```bash
cocos instances                     # which editors are open
cocos scene info                    # scene name, uuid, node count
cocos scene tree                    # the tree: addresses, [components], (off) on inactive nodes
cocos scene owners <Class>          # which nodes carry this component class
cocos scene missing                 # components whose script no longer resolves
cocos scene dirty                   # does the open scene differ from the file on disk
cocos node get <path>               # one node: its components and uuid
cocos component get <path> <type>   # what the inspector holds: every property with its value
cocos prefab dump <db://path>       # what a .prefab asset holds — see Prefabs below
cocos asset get <db://path>         # uuid, type, importer — see Assets below
```

`scene owners` is the check before deleting a script: it walks the open scene and names every node carrying the class, marking `(off)` for a node switched off itself and `(under an off parent)` for one killed by a parent. Checked live 2026-08-20 — `cc.MeshRenderer` answered 169 owners out of 425 nodes scanned.

`scene missing` exits 1 when it finds anything; a component whose script no longer resolves is the slot that crashes preview on scene load. `scene dirty` compares what the serializer would emit against the file, so it answers about the file rather than about the undo stack the editor's own dirty flag counts — it names the differing paths with both values.

`scene tree` is one call for the whole scene, and ordinary text grep works on it from there. Once the node is known, `node get` is cheaper.

Flags live in each group's `--help` (`cocos node --help`). The useful ones: `--uuid` adds uuids to the tree, `--json` on `instances`.

### Reading a component's properties

```bash
$ cocos component get "Main Light" cc.DirectionalLight
color                          cc.Color                   #ffcb5eff
useColorTemperature            Boolean                    false
colorTemperature               Number                     7100
_illuminanceHDR                Number                  *  120000
…
cc.DirectionalLight on Main Light  enabled=true  properties: 26  hidden: 30 …  * — differs from the default
```

**A star marks a value that diverges from the class default** — the authored one, the one a class-to-class move loses if nobody reads it first. No star and no verdict are different answers: a dump carrying no comparable default states none, the way `persisted=unknown` does.

`--prop <name>` prints that value alone on stdout (`cocos component get "Main Camera" cc.Camera --prop fov` → `45`), which is what pipes into a shell variable. It reaches any name, including ones the listing collapses: editor chrome (`node`, `uuid`, `__scriptAsset`) and a `_x` storage field whose accessor `x` carries the same value. An accessor with no property of its own answers from its storage field — `--prop color` reports `cc.Camera._color`.

References print as name plus uuid: a node by its scene path, a component by class and node, an asset by its `db://` url. `--json` gives the same reading structurally, with a `references` map and the `hidden` names.

The component answers to either spelling and is reported under the **registered** class (`cc.Camera`, `GameBootstrap`).

## Addressing: the full path from a scene root

```bash
cocos node get "Environment/cc_scene/scene/KB3D_FTW_PropBarrels_A_Main"
```

A path runs from a scene root all the way down. A slice out of the middle of the tree (`cc_scene/scene`) fails with code 1 and names what sits nearby:

```
path 'Nope/Nothing' does not resolve — not even its first segment 'Nope'. The scene roots are: Main Light, Main Camera, Environment, …
```

**Same-named siblings carry a `#1`, `#2` suffix in child order, and `scene tree` prints them that way.** A path lifted off the tree is a path the resolver takes as it stands:

```
$ cocos scene tree | grep IconController
  ├─┬ IconController#3
$ cocos node get "Editor Scene Foreground/gizmoRoot/IconController#3"
ok  IconController  a0mQxjmDNBXoW0V8wc2eKc
```

Every member of the group carries the suffix, the first one included; a name that stands alone stays bare. A bare name out of a group fails with code 1 and lists the exact spellings.

Commands take a uuid too, and a uuid lives exactly one editor session. A scene reload, an asset-database refresh and a script recompile hand prefab-instance roots fresh uuids while ordinary nodes keep theirs: a uuid list from an earlier dump goes stale in patches, silently.

## Writing

```bash
cocos node create --parent <path> --name <name> [--component <type>] [--pos x,y,z]
cocos node set <path> [--name N] [--active true|false] [--layer N] [--pos|--rot|--scale x,y,z]
cocos node mv <path> --parent <path> [--keep-world]
cocos node dup <path>
cocos node rm <path>
cocos component add <path> <type>
cocos component rm <path> <type>
cocos component set <path> <type> --prop <name> --value <value>
cocos scene open <db://path>
cocos scene save
```

`--value` is parsed as JSON first, and whatever fails to parse goes through as a string. The value is then coerced to the property's declared type: `Boolean`, `Number`, `String`.

### Writing the node itself

`node set` reaches the node's OWN properties — the ones no component holds. Everything named in one call goes into one undo bracket and is read back one at a time; the first write that does not land stops the rest rather than piling onto a node that refused the last one.

**An axis left empty keeps its value.** `--scale "5,,5"` sets x and z and leaves y alone; `--scale "5,0,5"` sets y to zero. Checked live 2026-08-20: a node at scale `(2,2,2)` given `5,,5` came back `{"x":5,"y":2,"z":5}`.

On a 2D node, writing position forces `z` to 0 and writing rotation forces `x,y` to 0 whether or not you named them — a 2D node has no other transform. Every zero that destroyed a value is printed on stderr; silence means nothing was clamped.

`node mv` polls the new parent until it takes: the editor applies a reparent asynchronously and silently ignores some of them, so a move that never landed reports the parent the node actually has. `node dup` copies the whole subtree as a sibling and answers with the copy's name and uuid.

### References

**A reference is written by the address you read it at.** A node or a component takes a scene path or a uuid, an asset takes its `db://` url or its uuid, and `null` clears the slot:

```bash
cocos component set "Characters/guard_1" TargetPolicy --prop target --value "Characters/cc_hero"
cocos component set "Characters/guard_1" TargetPolicy --prop target --value "21DErFAnlKUo5rhR1tiIP6"
cocos component set "Characters/guard_1" TargetPolicy --prop target --value null
```

An array field takes a JSON array of the same spellings. A field declared without a type takes `--target-component <type>` to say which component of the target node is meant.

**An address that resolves to nothing is refused before anything is written** — code 1, the slot untouched. Checked live 2026-08-19: a path miss lists the siblings, a uuid the scene no longer holds answers `FAILED`, and in both cases the previous value is still there afterwards.

Done editing — save the scene yourself with `cocos scene save`. Asking a human to press Ctrl+S is a wasted round trip.

Engine components are registered under a prefix (`cc.MeshRenderer`), user ones under their own class name. Every subcommand — `get`, `add`, `rm`, `set`, and `node create --component` — takes either spelling and prints the **registered** one; where the two differ, trust the report. Checked live: `component add "Game" UIOpacity` answers `ok  cc.UIOpacity added to Game`. A component that never appeared gives a code-1 failure listing what the node does carry, registered names and all.

## The verdict vocabulary

Every command that does something prints a line whose first word comes from one closed set, and the exit code follows from that word alone. Whatever the outcome was called before — a move that did not land, a link the serializer drops, a database still importing — is now the tail of the same line.

| First word | Meaning | Exit |
|---|---|---|
| `ok` | done, read back, and a save either carries it or the question does not apply | 0 |
| `UNVERIFIED` | done, and the read-back did not confirm it; the reason ends the line | 0 |
| `UNPERSISTED` | done and verified, and a save is proven to drop it | 1 |
| `FAILED` | not done | 1 |
| `TIMEOUT` | did not settle inside `--timeout` | 1 |

`UNVERIFIED` exiting 0 is deliberate: the write landed, only the check did not, and that is not where a `&&` chain should stop. `UNPERSISTED` and `FAILED` are, so `&&` catches a lost write.

Reads — `scene tree`, `asset ls`, `component get`, `prefab dump` and their kind — carry no verdict word; their stdout is the listing itself and the summary goes to stderr.

Further along the line, `persisted=`:

| Value | Meaning |
|---|---|
| `true` | proven that a save carries the value |
| `false` | proven that a save drops it |
| `unknown` | nobody ran the check |

`channel=editor` is the channel that serializes, so `false` there names a value a save would lose. `channel=live` writes the live object, and `false` there is expected by construction.

The common cause of `unknown` is a node inside a prefab instance: the scene file carries only an override for it.

## Prefabs

A prefab's contents are not in the scene, and the `.prefab` file names a script component by a compressed cid rather than by its class. Ask the editor:

```bash
cocos prefab dump <db://path | uuid>     # the asset's node tree and the components on each node
cocos prefab instantiate <db://path>     # place a prefab in the scene as a LINKED instance
cocos prefab create <node> <db://path>   # write a .prefab asset out of a node
cocos prefab info <node>                 # is this node a prefab instance, and of which asset
cocos prefab overrides <node>            # what the instance holds on top of the asset
cocos prefab rm-override <node> <prop>   # drop one override, leaving the rest
cocos prefab apply <node>                # write the instance's state into the asset
cocos prefab revert <node>               # throw the instance's overrides away
```

`prefab dump` prints one line per node — its path from the prefab root, then the components under their **registered** class names. A component whose script no longer resolves prints `!DEAD <cid>`, and the summary counts them; that slot is what crashes preview on scene load. Checked live 2026-08-20 on `db://assets/weapon/prefab/rifle.prefab`:

```
rifle  [AimRig,Emitter,Engagement,Magazine]
rifle/Yaw
rifle/Yaw/Barrel  [cc.MeshRenderer]
rifle/Yaw/Muzzle
rifle  nodes: 4  components: 5
```

### Placing and making prefabs

`prefab instantiate` produces a **linked** instance — the node keeps a PrefabInfo, the saved scene carries its `_prefab` block, and later edits to the asset propagate to it. This is not automatic: `scene:create-node` needs to be told the asset's type or it hands back a flat copy that tracks nothing, and nothing about the node tree or the component list gives that away. The command reports the linkage instead of assuming it, from both the live node and the editor's serializer, which can disagree:

```
ok  CliProbeInstance from db://assets/projectile/bullet.prefab  1cS+28OANCo5zCwJgToHFC
linked to 7c815697-e160-47da-9f87-27fc7d9ff250  fileId=d1Wq/c/N1He6HkIUsWJcmU  instance root  persisted=true
```

The linkage takes the same five words: `ok` when both sides agree; `UNVERIFIED` when the serializer could not be reached, so the link is unproven rather than absent; `FAILED` when the node came back with no PrefabInfo; `UNPERSISTED` when the live node holds one and the serializer drops it, so the save turns the instance into a flat copy. `--unlink` asks for the flat copy on purpose and is judged accordingly. An FBX/glTF has no instantiable main asset — the command resolves its `gltf-scene` sub-asset and says it did.

`prefab create` writes the asset through the editor's own serializer, which is what keeps mesh and material references; the source node does **not** become an instance (unlike dragging into the Assets panel), and the command says so. `<db://path>` takes a full `.prefab` address or a folder plus `--name`.

**Renaming an `@ccclass` does not touch a prefab.** The file stores the script's uuid, not the class name, so the engine keeps resolving the component and reports it under the new name. What breaks a prefab is the script's *uuid* going away — a deleted and re-added file. `prefab dump` is what tells the two apart.

`component add` and `component rm` reach a prefab instance like any other node — checked live 2026-08-19 on `Characters/cc_hero`, which came back to its exact component list afterwards. A component the prefab itself provides is not deleted from the instance but recorded as removed, which `prefab overrides` counts on its summary line (`removed components: N`); `prefab apply` is what carries that into the asset.

## Assets

The editor's asset database is what turns a file on disk into a uuid, a class and an importer result. It does **not** notice everything: a file written behind a mounted symlink — `assets/framework` in these projects — a file moved on disk, or a folder deleted outside the editor all reach it only when asked.

```bash
cocos asset get <db://path | uuid>          # uuid, type, url, importer, disk path
cocos asset ls [db://folder]                # what is under a folder
cocos asset refresh <db://folder>           # rescan a folder and wait for the import to finish
cocos asset reimport <db://path>            # re-run the importer on one asset, and wait
cocos asset mv <source> <target>            # move or rename; the uuid survives, references hold
cocos asset cp <source> <target>            # copy — a NEW uuid, nothing references it
cocos asset rm <db://path>                  # delete an asset or a whole folder
cocos asset mkdir <db://folder>             # create a folder
cocos asset ready                           # has the database finished starting up
```

**`asset refresh` is the cure for "the editor is serving the old class."** Checked live 2026-08-20: a new `@ccclass` written into `framework/targeting/` behind the symlink was invisible to `asset get` and to `component add`; one `cocos asset refresh db://assets/framework/targeting` registered it, and `component add "Main Light" CliProbeMarker` then answered `ok`. Deleting the file on disk was equally invisible until the same refresh, which reported it gone. Rewriting a `.ts` with identical content to bait the watcher is no longer needed.

The command does not return until the database has gone quiet, so an `&&` chain after it is safe:

```bash
cocos asset refresh db://assets/framework && cocos component add "Characters/guard_1" TargetPolicy
```

It reports what the editor actually did — the file delta and, on its own line, the registered component classes that came and went, which is the half that answers "did the editor notice my class":

```
ok  db://assets/framework/targeting  refreshed in 1.7s
assets: +1  -0  ~0
  + db://assets/framework/targeting/CliProbeMarker.ts
component classes: +CliProbeMarker
```

`ok` means the database went quiet; `TIMEOUT` means it was still working when `--timeout` (60 s) ran out, and exits 1. `no changes` on the head line is a real answer — the editor already knew everything under that folder. A refresh over the whole 254-script `framework` tree cost 1.7 s.

`--quiet-for <ms>` (1.5 s) is how long the database's fingerprint must hold still before the command believes it. Raise both flags for a large reimport.

### Moving assets

`asset mv` keeps the uuid, so every scene and prefab reference survives the move. Two things it does not carry:

- **Absolute `db://` paths inside `.meta` importer settings.** An FBX with dumped materials keeps a `materialDumpDir` naming the *old* folder; a model whose dump dir no longer exists is re-dumped without textures and renders flat, silently. Rewrite those in the same change.
- **A taken target is renamed, not refused** — the default is rename-on-conflict. The report names where the asset actually landed, which is not always where it was sent:

```
ok  db://assets/framework/targeting/CliProbeCopy.md → db://assets/framework/targeting/README-001.md  moved in 1.7s
```

Read the arrow's right side, not the argument you typed. `--overwrite` replaces the target instead.

**Asset commands are outside the scene's undo stack.** Ctrl+Z does not take back an `asset rm`, `mv` or `cp`.

## The editor's own log

`temp/logs/project.log` is where the editor writes imports, compile errors and scene errors. Reading it needs no connection to the editor — only which project is open — so both commands work while the editor is busy.

```bash
cocos log tail                          # the most recent entries
cocos log tail -n 20 --level warn       # only warnings and errors
cocos log tail --since 15m --detail     # the last 15 minutes, stack frames printed
cocos log search "_sealed"              # matching lines with the lines around each
cocos log search "at .*\.ts:" --regex   # regex is opt-in; without it the pattern is literal text
```

An entry is a header line plus the stack frames under it, and the severity comes off the header — so a frame is never counted as an error of its own, and `--level error` keeps the frames belonging to a real error. Without `--detail` an entry says `+57 lines` instead of printing them.

`log search` takes its pattern as a required argument: there is no call that searches for nothing and returns the head of the file. `--level` and `--since` narrow the search to the entries that survive them, and the summary line reports the true total when `-n` capped the page.

## Building

```bash
cocos build status                      # is the build worker up, and what rows the Build panel holds
cocos build run --platform web-mobile   # rebuild that platform's existing task, and wait
cocos build panel                       # open the Build panel for whoever is at the editor
```

`build run` rebuilds the platform's **existing** Build-panel row with the settings that row holds, because building writes its options back onto the task. An override (`--debug`, `--options`) that disagrees with the saved task would edit that row permanently, so the call refuses and changes nothing; `--allow-task-edit` is the way to really make the change, and `--new-task` builds a separate row instead. A platform with more than one task refuses to be picked for — pass `--task <id>` from `build status`. Checked live 2026-08-21 on `CyberCore`: `--debug true` against a task saved with `debug=false` refused and built nothing, and a `--task` id belonging to another platform said so.

The verdict comes from the builder's exit code first: 36 is the code for a build that succeeded, and anything else is `FAILED`. `UNVERIFIED` is only for a build whose task could not be read back at all; a task state that contradicts a successful exit code is `FAILED`. Checked live: rebuilding an existing web-mobile task answered `ok  BUILD_SUCCESS(36)  state=success  12.8s`.

`--timeout` bounds the *wait*, not the build — the editor keeps building past it, and the command then answers `TIMEOUT` with `state=unknown` because the driver serves one request at a time and any read-back would queue behind the build. Watch it with `build status` afterwards.

**Builds are outside the undo stack** and write to disk. A `--new-task` whose output path matches an existing row replaces that row's artefacts; the report names the task it landed on.

## Undo

Every scene-writing command is wrapped in one undo bracket. Checked live: `node create` with a component and a position comes back with a single Ctrl+Z, whole, and the report prints `undo=1`. `node set` behaves the same with several properties named at once. Silence about undo means the bracket closed cleanly; a separate sentence appears when the editor refused to record the step or left it open.

Writing to the scene is safe. **The `asset` group is not in the undo stack** — `asset rm`, `mv` and `cp` touch the project on disk and Ctrl+Z does not take them back.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | success |
| 1 | the operation failed |
| 2 | usage error: unknown command or flag |
| 3 | no editor found, or several match |
| 4 | protocol break |

The payload goes to stdout and the explanations and errors to stderr, so stdout drops into a pipeline as it is.

Several open editors are told apart by `-p <substring>` against the project name or path. With one editor the flag is redundant; with several and no flag the command fails with code 3 and a list.

## The editor outranks the code

A value set in the inspector is a value the code **reads**. A follow camera sets position and takes its tilt from the node rotation authored in the editor; it never calls `lookAt()` and never writes rotation. The symptom "I set X in the editor and something overrides it" is cured by deleting the code that writes X.

## A human checks visual work

A screenshot and a projection calculation deliver a confident wrong verdict about your own work. After an edit, name which knobs moved and hand it to a human to check.

The preview is live at `http://localhost:7456/` for as long as the editor is open, and reloads itself on a rebuild (checked: it answers 200). Asking for a Play press is a wasted round trip.

## Gotchas

- **A new `@property` field appears after a rebuild.** Edit the `.ts`, wait for recompilation, then write the property. For a file behind the `assets/framework` symlink there is nothing to wait for until `cocos asset refresh` is run — see Assets.
- **`node.forward` is unreliable** — rigs are often turned 180°. Take direction from a source known to be right.

## When a command is missing

The bridge is our own repository. A command goes into `cli/src/commands/`, an engine primitive into `driver/src/scene/`. Its layout and the procedure for adding either are in that repository's `CLAUDE.md`.

A workaround written in silence outlives the task and reaches the next person as a surprise.
