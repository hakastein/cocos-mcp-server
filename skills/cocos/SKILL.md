---
name: cocos
description: Cocos Creator, open project — what nodes and components a scene holds, how something is wired, creating a node, adding and configuring a component. Required before reading, grepping or hand-parsing a `.scene`, `.prefab` or `.meta` — searching those files answers false-negative.
---

# Cocos through the `cocos` CLI

The open editor is the source of truth about the scene. The `cocos` binary asks it directly: one command in the shell, the answer on stdout.

The bridge lives in the `hakastein/cocos-mcp-server` repository: `driver/` is the editor extension, `cli/` is the binary itself.

The CLI prints its own text in Russian. Literal output is quoted verbatim below.

## Searching `.scene` answers false-negative

Script components serialize under a compressed cid. Checked against the open `cc_action_1a.scene` (337 KB):

| query | answer |
|---|---|
| `grep -c FollowCamera cc_action_1a.scene` | `0` |
| `cocos scene tree \| grep FollowCamera` | `Main Camera  [Camera,FollowCamera,BuiltinPipelineSettings]` |
| `grep -c GameBootstrap cc_action_1a.scene` | `0` |
| `cocos scene tree \| grep GameBootstrap` | `Game  [GameRoot,GameBootstrap]` |

In the file the component sits as `"__type__": "04e75MuPw1E2Y0YvYSnSKa5"`. Node references are indices, `{"__id__": 47}`. The `_active` field holds a local flag, and `activeInHierarchy` does not follow from it.

Ask `cocos` about what a scene or a prefab contains.

## Reading

```bash
cocos instances                # which editors are open
cocos scene info               # scene name, uuid, node count
cocos scene tree               # the tree: addresses, [components], (off) on inactive nodes
cocos node get <path>          # one node: its components and uuid
```

`scene tree` is one call for the whole scene, and ordinary text grep works on it from there. Once the node is known, `node get` is cheaper.

Flags live in each group's `--help` (`cocos node --help`). The useful ones: `--uuid` adds uuids to the tree, `--json` on `instances`.

## Addressing: the full path from a scene root

```bash
cocos node get "Environment/cc_scene/scene/KB3D_FTW_PropBarrels_A_Main"
```

A path runs from a scene root all the way down. A slice out of the middle of the tree (`cc_scene/scene`) fails with code 1 and names what sits nearby:

```
path 'Nope/Nothing' does not resolve — not even its first segment 'Nope'.
The scene roots are: Main Light, Main Camera, Environment, …
```

**Same-named siblings carry a `#1`, `#2` suffix in child order, and `scene tree` prints them that way.** A path lifted off the tree is a path the resolver takes as it stands:

```
$ cocos scene tree | grep IconController
  ├─┬ IconController#3
$ cocos node get "Editor Scene Foreground/gizmoRoot/IconController#3"
IconController  27kzz0ZGVPjp3Wf8wIw/Us
```

Every member of the group carries the suffix, the first one included; a name that stands alone stays bare. A bare name out of a group fails with code 1 and lists the exact spellings.

Commands take a uuid too, and a uuid lives exactly one editor session. A scene reload, an asset-database refresh and a script recompile hand prefab-instance roots fresh uuids while ordinary nodes keep theirs: a uuid list from an earlier dump goes stale in patches, silently.

## Writing

```bash
cocos node create --parent <path> --name <name> [--component <type>] [--pos x,y,z]
cocos node rm <path>
cocos component add <path> <type>
cocos component rm <path> <type>
cocos component set <path> <type> --prop <name> --value <value>
cocos scene open <db://path>
cocos scene save
```

**`component set` covers scalars, vectors, colors and enums.** Node, component and asset references, `@ccclass` arrays, gradients and curves are not wired to the command yet: the code for them sits in `cli/src/property/writers.ts` waiting for a caller.

`--value` is parsed as JSON first, and whatever fails to parse goes through as a string. The value is then coerced to the property's declared type: `Boolean`, `Number`, `String`.

Done editing — save the scene yourself with `cocos scene save`. Asking a human to press Ctrl+S is a wasted round trip.

Engine components are registered under a prefix (`cc.MeshRenderer`), user ones under their own class name. The command tries both spellings and prints the **registered** one; where the two differ, trust the report. A component that never appeared gives a code-1 failure listing what the node does carry.

## The write report

`component set` prints a line whose first word is the verdict:

| First word | Meaning |
|---|---|
| `ok` | written and read back |
| `ЗАПИСАНО, НЕ ПРОВЕРЕНО` | the editor accepted it, the check did not pass; the reason ends the line |
| `НЕ ЗАПИСАНО` | the write never landed |

Further along the line, `persisted=`:

| Value | Meaning |
|---|---|
| `true` | proven that a save carries the value |
| `false` | proven that a save drops it |
| `unknown` | nobody ran the check |

`channel=editor` is the channel that serializes, so `false` there names a value a save would lose. `channel=live` writes the live object, and `false` there is expected by construction.

The common cause of `unknown` is a node inside a prefab instance: the scene file carries only an override for it.

## Undo

Every writing command is wrapped in one undo bracket. Checked live: `node create` with a component and a position comes back with a single Ctrl+Z, whole, and the report prints `undo=1`. Silence about undo means the bracket closed cleanly; a separate sentence appears when the editor refused to record the step or left it open.

Writing is safe.

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

- **A new `@property` field appears after a rebuild.** Edit the `.ts`, wait for recompilation, then write the property.
- **`node.forward` is unreliable** — rigs are often turned 180°. Take direction from a source known to be right.

## When a command is missing

The bridge is our own repository. A command goes into `cli/src/commands/`, an engine primitive into `driver/src/scene/`. Its layout and the procedure for adding either are in that repository's `CLAUDE.md`.

A workaround written in silence outlives the task and reaches the next person as a surprise.
