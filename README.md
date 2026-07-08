# ai-config-sync

`ai-config-sync` is a small template repository for keeping shared Claude and Codex configuration in one place, then copying it into your global Claude/Codex directories when you choose to sync.

The repository is the source of truth. Edit files under `sources/`, review the planned changes with a dry run, and only then sync them to your global AI configuration directories.

## What It Syncs

Current behavior:

- Instruction files are controlled by `instructionsMode` in `sync.config.json`.
- The default `sidecar` mode writes `sources/AGENTS.md` to `~/.codex/AGENTS-sync.md`.
- The default `sidecar` mode writes `sources/CLAUDE.md` to `~/.claude/CLAUDE-sync.md`.
- Each directory in `sources/skills/<name>/` is copied to both `~/.claude/skills/<name>/` and `~/.codex/skills/<name>/`.
- Each Markdown file in `sources/agents/<name>.md` is copied to Claude as `~/.claude/agents/<name>.md`.
- The same agent file is converted to Codex TOML and written to `~/.codex/agents/<name>.toml`.
- Global skills and agents with other names are left alone.

By default, `npm run sync` does not overwrite existing global `~/.codex/AGENTS.md` or `~/.claude/CLAUDE.md` files. It only creates or updates the sidecar files `AGENTS-sync.md` and `CLAUDE-sync.md`.

## Repository Layout

```text
sources/
  AGENTS.md
  CLAUDE.md
  agents/
    example-agent.md
  skills/
    example-skill/
      SKILL.md
scripts/
  sync-global-ai.mjs
sync.config.json
```

Use `sources/` for all content controlled by this repository. Do not edit generated files directly under `~/.claude` or `~/.codex` if you want this repository to remain the source of truth.

## Requirements

- Node.js and npm
- Claude and/or Codex configured to read from the standard global directories:
  - Claude: `~/.claude`
  - Codex: `~/.codex`

On Windows, `~` resolves from `USERPROFILE`. On macOS/Linux, it resolves from `HOME`.

## Quick Start

1. Edit the source files under `sources/`.
2. Keep the default `instructionsMode: "sidecar"` unless you intentionally want another mode.
3. Preview the planned global changes:

```sh
npm run sync:dry
```

4. If the dry run looks correct, apply the sync:

```sh
npm run sync
```

5. To make sidecar instructions visible to your tools, manually add a short reference sentence to your existing global instruction files.

For Codex, add something like this to `~/.codex/AGENTS.md`:

```md
Also review and follow the repository-managed instructions in ~/.codex/AGENTS-sync.md when they are relevant.
```

For Claude, add something like this to `~/.claude/CLAUDE.md`:

```md
Also review and follow the repository-managed instructions in ~/.claude/CLAUDE-sync.md when they are relevant.
```

This reference sentence is a lightweight reference pattern. It asks the agent to consider the sidecar file, but it is not a guaranteed file include mechanism.

If you need guaranteed replacement of the global instruction files, back up your existing `~/.codex/AGENTS.md` and `~/.claude/CLAUDE.md`, then switch `instructionsMode` to `managed`.

You can also run the script directly:

```sh
node scripts/sync-global-ai.mjs --dry-run
node scripts/sync-global-ai.mjs
```

## Agents

Claude agents are plain Markdown files under `sources/agents/`.

Use frontmatter for metadata:

```md
---
name: example-agent
description: Handles a specific workflow
model: sonnet
---

Agent instructions go here.
```

During sync:

- Claude receives the Markdown file as-is.
- Codex receives a generated TOML file.
- The `model` value is mapped through `sync.config.json`.

The default model map currently supports `opus`, `sonnet`, and `haiku`.

## Skills

Skills live under `sources/skills/<skill-name>/`.

Each skill directory is copied as a whole into both global skill directories. Keep reusable skill instructions in `SKILL.md` and include any supporting files inside the same skill directory.

## Configuration

`sync.config.json` controls instruction sync behavior and how Claude-style agent model names map to Codex model settings.

```json
{
  "instructionsMode": "sidecar",
  "codexAgentDefaults": {
    "model": "gpt-5.5",
    "reasoningEffort": "high"
  },
  "codexAgentModelMap": {
    "sonnet": {
      "model": "gpt-5.5",
      "reasoningEffort": "high"
    }
  }
}
```

### Instruction Modes

`instructionsMode` must be one of `off`, `sidecar`, or `managed`.

| Mode | Behavior | Risk |
| --- | --- | --- |
| `off` | Does not write instruction files. Skills and agents are still synced. | Lowest risk for existing global instructions, but repository-managed instruction changes are not synced. |
| `sidecar` | Writes `~/.codex/AGENTS-sync.md` and `~/.claude/CLAUDE-sync.md`. Existing `AGENTS.md` and `CLAUDE.md` are not overwritten. | Safer default, but sidecar instructions are only useful after you manually reference them from your existing global instruction files. |
| `managed` | Writes directly to `~/.codex/AGENTS.md` and `~/.claude/CLAUDE.md`. | Highest risk. This is an explicit opt-in mode that overwrites existing global instruction files. Back up those files first. |

If an agent's frontmatter model is missing or not mapped, the script uses `codexAgentDefaults`.

## Optional Git Hook

You can configure this repository to sync before each commit:

```sh
git config core.hooksPath scripts/hooks
```

This makes `scripts/hooks/pre-commit` run before commits. Only enable it if you want commits in this repository to update your global Claude/Codex configuration automatically.

## Safety Notes

- Always run `npm run sync:dry` before `npm run sync`.
- The script keeps writes inside the target global Claude/Codex roots.
- The default `sidecar` instruction mode does not overwrite existing global `AGENTS.md` or `CLAUDE.md` files.
- Sidecar reference sentences are not guaranteed includes. Use `managed` mode only when you want this repository to replace the global instruction files directly.
- Unrelated global skills and agents are preserved.
- Same-name source skills are replaced in the global skill directories.
- Same-name source agents may remove stale `.md`, `.toml`, or directory variants before writing the current format.
- In `managed` mode, global `AGENTS.md` and `CLAUDE.md` are overwritten by the current source files when you run a real sync.
