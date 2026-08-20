# Issue tracker: YouTrack

Issues and specs for this repo live in YouTrack, project **`PLY`** (PLAYABLES).

## One tool: the `yt` CLI

Every tracker operation goes through `yt` — [`youtrack-cli`](https://github.com/ryancheley/yt-cli),
installed with `uv tool install youtrack-cli`. Don't hand-roll REST calls beside it, and don't mix
tools inside one workflow.

A `youtrack` MCP server is also connected to this session. `yt` is the choice: its surface is a
superset (`yt issues tag add` creates a missing tag, `manage_issue_tags` can only apply an existing
one), and one vocabulary in these docs beats two.

## Setup

`yt auth login` once, interactively — it stores the credentials itself. `yt auth status` reports
whether this machine is authenticated; if it is not, ask the user to run `yt auth login` rather than
handling a token yourself.

## Conventions

- **Create**: `yt issues create PLY "Summary" -d "body"` — also `-t` type, `-p` priority,
  `-a` assignee, `-cf "Field=value"`.
- **Read**: `yt issues show PLY-123`, then `yt issues comments list PLY-123` — comments are a
  separate command, not part of the issue.
- **Query**: `yt issues search "project: PLY tag: needs-triage #Unresolved" --format json`.
  YouTrack query syntax; `--all` pages through everything.
- **Comment**: `yt issues comments add PLY-123 "..."`.
- **Triage label**: `yt issues tag add PLY-123 needs-triage`, `yt issues tag remove PLY-123 ...`.
  All seven tags in `docs/agents/triage-labels.md` already exist. `add` refuses an unknown tag
  unless given `--create-if-missing`; leave that flag off, so a typo fails instead of quietly
  creating an eighth tag.
- **Assign**: `yt issues assign PLY-123 <login>`.
- **Close**: YouTrack has no close operation — `yt issues move PLY-123 --state <State>` sets the
  state field. `yt admin fields list` shows which states the project actually offers; read it before
  writing one.
- **Link**: `yt issues links create <source> <target> <link-type>`; `yt issues links types` lists the
  types this instance defines, `yt issues links list PLY-123` shows an issue's edges.

An issue id is `PLY-123`; that id is what a branch name, a commit message and a spec carry.

## Pull requests as a request surface

**No.** Requests are tracked in YouTrack; GitHub PRs and GitHub issues are outside the triage queue.
_(Flip to `yes` here if that changes — `/triage` reads this flag.)_

## When a skill says "publish to the issue tracker"

`yt issues create PLY "..." -d "..."`.

## When a skill says "fetch the relevant ticket"

`yt issues show <id>` plus `yt issues comments list <id>`.

## Wayfinding operations

Used by `/wayfinder`. The **map** is one issue; tickets are its children.

- **Map**: an issue tagged `wayfinder:map`, holding the Notes / Decisions-so-far / Fog body.
- **Child ticket**: linked to the map with `yt issues links create <child> <map> subtask of`, tagged
  `wayfinder:<type>` (`research`/`prototype`/`grilling`/`task`). A claimed ticket is assigned with
  `yt issues assign`.
- **Blocking**: a "depends on" link from the blocked ticket to its blocker — confirm the exact type
  name with `yt issues links types`. A ticket is unblocked once every blocker is resolved.
- **Frontier query**: `yt issues search` for the map's unresolved children; drop any with an
  unresolved blocker or an assignee; first in map order wins.
- **Resolve**: `yt issues comments add` with the answer, `yt issues move --state <resolved>`, then
  append a context pointer to the map's Decisions-so-far.
