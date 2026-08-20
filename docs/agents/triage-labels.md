# Triage Labels

The skills speak in terms of seven canonical triage roles — two category roles and five state roles.
Every triaged issue carries exactly one of each. In this repo they are **YouTrack tags**, applied
with `yt issues tag add` / `yt issues tag remove` (see `docs/agents/issue-tracker.md`).

Category roles:

| Label in mattpocock/skills | Tag in YouTrack | Meaning                    |
| -------------------------- | --------------- | -------------------------- |
| `bug`                      | `bug`           | Something is broken        |
| `enhancement`              | `enhancement`   | New feature or improvement |

State roles:

| Label in mattpocock/skills | Tag in YouTrack   | Meaning                                  |
| -------------------------- | ----------------- | ---------------------------------------- |
| `needs-triage`             | `needs-triage`    | Maintainer needs to evaluate this issue  |
| `needs-info`               | `needs-info`      | Waiting on reporter for more information |
| `ready-for-agent`          | `ready-for-agent` | Fully specified, ready for an AFK agent  |
| `ready-for-human`          | `ready-for-human` | Requires human implementation            |
| `wontfix`                  | `wontfix`         | Will not be actioned                     |

The project's `State` field is left alone — triage runs on tags so it does not disturb the board.

All seven already exist in YouTrack, created 2026-08-20. `yt issues tag add` refuses a tag it cannot
find unless given `--create-if-missing` — leave that flag off while triaging, so a misspelled role
fails loudly instead of quietly becoming an eighth tag.

They were created under the `hakastein` account, which owns them; a YouTrack tag is private to its
owner by default. If someone else starts working `PLY`, open their visibility up in the YouTrack UI.

Edit the right-hand column to match whatever vocabulary you actually use.
