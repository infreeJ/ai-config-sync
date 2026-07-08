# ai-config-sync Agent Instructions

This repository is the source of truth for shared Claude and Codex configuration. Do not edit generated files directly under global `~/.claude` or `~/.codex` paths. Make changes under `sources/`, then sync when explicitly requested.

## Repository Role

- `sources/AGENTS.md`: source file for Codex global instructions.
- `sources/CLAUDE.md`: source file for Claude global instructions.
- `sources/skills/`: source directories for skills copied to both Claude and Codex.
- `sources/agents/`: source Markdown agents copied to Claude and converted to Codex TOML.
- `scripts/sync-global-ai.mjs`: sync script that deploys repository sources to global Claude/Codex paths.
- `sync.config.json`: sync configuration, including instruction sync mode and Codex agent model mapping.
- `scripts/hooks/pre-commit`: optional Git hook entrypoint for pre-commit syncing.

## Sync Behavior

Instruction syncing is controlled by `instructionsMode` in `sync.config.json`.

- `off`: do not sync instruction files. Skills and agents are still synced.
- `sidecar`: write `sources/AGENTS.md` to `~/.codex/AGENTS-sync.md` and `sources/CLAUDE.md` to `~/.claude/CLAUDE-sync.md`. This is the default mode.
- `managed`: write `sources/AGENTS.md` to `~/.codex/AGENTS.md` and `sources/CLAUDE.md` to `~/.claude/CLAUDE.md`, overwriting existing global instruction files.

Skill syncing:

- `sources/skills/<name>/` is copied to `~/.claude/skills/<name>/`.
- `sources/skills/<name>/` is copied to `~/.codex/skills/<name>/`.
- Same-name global skill directories are replaced.
- Unrelated global skill entries are preserved.

Agent syncing:

- `sources/agents/<name>.md` is copied to `~/.claude/agents/<name>.md`.
- The same source agent is converted to TOML and written to `~/.codex/agents/<name>.toml`.
- Same-name stale agent variants may be removed before writing the current format.
- Unrelated global agent entries are preserved.

Codex built-in items such as `~/.codex/skills/.system` are not managed by this repository.

## Authoring Rules

- Edit global instruction sources only in `sources/AGENTS.md` and `sources/CLAUDE.md`.
- Write skills under `sources/skills/<skill-name>/`, centered on `SKILL.md`.
- Write agents as top-level Markdown files under `sources/agents/<agent-name>.md`.
- Keep agent frontmatter fields `name`, `description`, and `model`.
- Keep agent `model` values aligned with `sync.config.json` and its `codexAgentModelMap`.
- Do not manually create or edit generated Codex `.toml` agent files.
- Do not edit files directly under global `~/.claude` or `~/.codex` paths as part of repository changes.

## Operational Commands

These commands affect global Claude/Codex configuration. Run them only when the user explicitly asks.

Preview sync impact:

```sh
npm run sync:dry
```

Apply sync to global Claude/Codex paths:

```sh
npm run sync
```

Configure the optional Git hook:

```sh
git config core.hooksPath scripts/hooks
```

## Safety Notes

- Keep `sidecar` as the default instruction mode for public-template safety.
- In `sidecar` mode, existing global `AGENTS.md` and `CLAUDE.md` files are not overwritten.
- Sidecar files are not guaranteed includes. Users must manually reference them from their existing global instruction files if they want tools to consider them.
- Use `managed` mode only when the user explicitly wants this repository to replace global instruction files directly.
- Preserve the sync script's path safety checks so it cannot write outside the intended global Claude/Codex roots.
- Do not add root-level `agents/`, `skills/`, or `instructions/` source directories. Managed source content belongs under `sources/`.
