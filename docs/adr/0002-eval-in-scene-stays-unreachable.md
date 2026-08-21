# `evalInScene` stays unreachable

`scene.evalInScene` — arbitrary JavaScript run in the scene script's context, with `cc`, `director`
and `scene` in scope — is implemented (`driver/src/scene/query.ts`) and listed in `SCENE_METHODS`,
and no CLI command reaches it. That is deliberate, not an oversight: an escape hatch devalues the
rest of the surface if it arrives before it. An agent holding arbitrary JS in the scene context will
not learn thirty honest commands, and nothing the honest commands are built on survives the trip —
a raw `eval` answers with whatever the expression returned, carries no `WriteReport`, no undo
bracket and no verdict, so a write through it is neither read back nor known to survive a save.

`docs/specs/2026-08-18-cocos-cli-design.md` gives it a role that still stands: the route a new engine
operation is prototyped through before it becomes a typed `SceneMethods` method. What this decision
fixes is the ordering — the command surface comes first, and the hatch is opened by a separate
decision when it is opened at all.

The primitive is left implemented rather than deleted: it costs one line in `SCENE_METHODS` and one
function in the scene script, and wiring a command to it later is a smaller change than writing it
again.
