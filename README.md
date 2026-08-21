# cocos-cli

Drive an open Cocos Creator 3.8.x editor from the shell. An agent runs `cocos <command>`; the
answer comes back on stdout.

```
$ cocos scene tree
Main Light  [DirectionalLight]
Main Camera  [Camera,FollowCamera,BuiltinPipelineSettings]
Environment
├─┬ cc_scene
│ └─┬ scene
│   ├── KB3D_FTW_PropBarrels_A_Main  [MeshRenderer]
│   └─┬ KB3D_FTW_PropGarageDoor_B_Door  [MeshRenderer]
│     └── KB3D_FTW_PropGarageDoor_B_Frame  [MeshRenderer]
```

Three npm workspaces in one repository: `driver/` is an editor extension holding native
primitives, `cli/` is the `cocos` binary holding every decision, and `shared/` holds the types and
pure logic both sides need. The driver and the binary talk over a channel private to one project's
editor — a named pipe on Windows, a unix socket elsewhere. Nothing listens on a network port.

The shell **is** the interface. There is no call-and-response protocol layered on top of it for an
agent to learn.

## Compatibility

| Cocos Creator | Status |
|---|---|
| 3.8.x | Supported (developed against 3.8.8) |
| 3.7.x | Untested |

## Install

Build all three workspaces and put `cocos` on PATH:

```bash
npm install && npm run build && npm link --workspace cli
```

Then install the extension into the **project's** own `extensions` directory: copy `driver/` there
under the name `cocos-cli-driver`, or make a junction to it under that name.

```
{your-project}/
└── extensions/
    └── cocos-cli-driver/     ← this repo's driver/, renamed
```

The name has to match: `driver/package.json` declares `cocos-cli-driver` and Cocos matches it
against the folder, so a folder under any other name drops out of the Extension Manager. The global
`~/.CocosCreator/extensions/` directory does **not** work — Cocos loads extensions from the project
only.

Enable it under **Extension → Extension Manager → Project**. After any rebuild of `driver/` or
`shared/`, **restart the editor** — toggling the extension off and on leaves the old bundle running.

Check that the two halves found each other:

```bash
cocos instances
```

With several editors open, `--project <substring>` picks one.

## Where to look next

| | |
|---|---|
| `skills/cocos/SKILL.md` | The command surface, as an agent reads it. |
| `CLAUDE.md` | Architecture, invariants and the checkpoint procedure. |
| `docs/specs/`, `docs/plans/` | The design records this was built from. |
| `docs/source-inventory.md` | What the pre-CLI `source/` tree held, and where each module went. |

## Development

```bash
npm test                          # build shared → driver → cli, then run every package's tests
npm run build --workspace cli     # rebuild only the binary
```

Exit codes: `0` ok, `1` the command failed, `2` bad usage, `3` no editor found, `4` the channel
broke.

Settings live in `{project}/settings/cocos-cli-driver.json` and hold one key, `enableDebugLog`. Every
command is always reachable; there is no per-command enable.
