# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the
codebase. This repo is **single-context**: one `CONTEXT.md` and one `docs/adr/`, both at the root,
covering all three workspaces (`shared/`, `driver/`, `cli/`).

## Before exploring, read these

- **`CONTEXT.md`** at the repo root — the glossary and the domain model.
- **`docs/adr/`** — the ADRs that touch the area you are about to work in.

If either does not exist, **proceed silently**. Don't flag their absence; don't suggest creating them
upfront. `/domain-modeling` (reached via `/grill-with-docs` and `/improve-codebase-architecture`)
creates them lazily, once terms or decisions actually get resolved.

`docs/specs/` and `docs/plans/` already hold the design records this repo was built from. They are
prose history, not the glossary — read them for the reasoning behind a subsystem, and `CONTEXT.md`
for the vocabulary.

## File structure

```
/
├── CONTEXT.md
├── docs/adr/
│   ├── 0001-....md
│   └── 0002-....md
├── shared/
├── driver/
└── cli/
```

## Use the glossary's vocabulary

When your output names a domain concept (an issue title, a refactor proposal, a hypothesis, a test
name), use the term as defined in `CONTEXT.md`. Don't drift to synonyms the glossary explicitly
avoids.

If the concept you need isn't in the glossary yet, that's a signal — either you're inventing language
the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0007 (event-sourced orders) — but worth reopening because…_
