# ai-config-sync

`ai-config-sync` is a small template repository for keeping shared Claude and Codex configuration in one place, then copying it into your global Claude/Codex directories when you choose to sync.

The repository is the source of truth. Edit files under `sources/`, review the planned changes with a dry run, and only then sync them to your global AI configuration directories.

## What It Syncs

Current behavior:

- `sources/AGENTS.md` is written to `~/.codex/AGENTS.md`.
- `sources/CLAUDE.md` is written to `~/.claude/CLAUDE.md`.
- Each directory in `sources/skills/<name>/` is copied to both `~/.claude/skills/<name>/` and `~/.codex/skills/<name>/`.
- Each Markdown file in `sources/agents/<name>.md` is copied to Claude as `~/.claude/agents/<name>.md`.
- The same agent file is converted to Codex TOML and written to `~/.codex/agents/<name>.toml`.
- Global skills and agents with other names are left alone.

Important: `npm run sync` directly writes `~/.codex/AGENTS.md` and `~/.claude/CLAUDE.md`. If you already have important global instruction files, back them up before running a real sync.

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

## Usage

1. Edit the source files under `sources/`.
2. Preview the planned global changes:

```sh
npm run sync:dry
```

3. If the dry run looks correct, apply the sync:

```sh
npm run sync
```

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

`sync.config.json` controls how Claude-style agent model names map to Codex model settings.

```json
{
  "codexAgentDefaults": {
    "model": "gpt-5",
    "reasoningEffort": "high"
  },
  "codexAgentModelMap": {
    "sonnet": {
      "model": "gpt-5",
      "reasoningEffort": "high"
    }
  }
}
```

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
- Unrelated global skills and agents are preserved.
- Same-name source skills are replaced in the global skill directories.
- Same-name source agents may remove stale `.md`, `.toml`, or directory variants before writing the current format.
- Global `AGENTS.md` and `CLAUDE.md` are overwritten by the current source files when you run a real sync.
