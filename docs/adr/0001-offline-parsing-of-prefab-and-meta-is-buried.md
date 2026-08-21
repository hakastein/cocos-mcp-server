# Offline parsing of `.prefab` and `.meta` is buried

The MCP-era bridge carried five modules that read serialized assets off disk. They are deleted, and
the questions they answered are put to the open editor instead: it answers more precisely, and a
grep or a hand-rolled parse over a serialized file answers false-negative. Checked against the open
`cc_action_1a.scene` (337 KB): `grep -c FollowCamera` answers `0` while the node carries the
component, because a script component serializes under a compressed cid (`"__type__":
"04e75MuPw1E2Y0YvYSnSKa5"`). Node references are positional (`{"__id__": 47}`), and `_active` is a
local flag from which `activeInHierarchy` does not follow.

Buried with this decision: `prefab-json.ts` (419 lines), `prefab-value.ts` (298),
`asset-json.ts` (38), `missing-scripts.ts` (47). `docs/source-inventory.md` is the manifest and says
where the live counterpart of each one is; recover a module's text with
`git show 0e43954:source/<name>.ts`.

## The exception

`reference-scan.ts` is not covered by this. It walks assets and `.meta` for uuid references across
the whole project, and the live editor cannot answer that — it does not know about files nobody
touched. It stays offline parsing by necessity, and it is unticketed rather than buried.

## Consequences

The `cocos` skill (`skills/cocos/SKILL.md`) states the same rule for readers of a project rather
than of this repo: ask `cocos` about what a scene or a prefab contains, before reading, grepping or
hand-parsing those files. Anything that would need offline parsing back is a new primitive on the
live surface, not a revival of these modules.
