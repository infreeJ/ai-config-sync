# ai-config-sync

`ai-config-sync`는 Claude와 Codex에서 함께 쓰는 전역 설정을 한 저장소에서 관리하기 위한 저장소입니다. 실제 전역 디렉터리(`~/.claude`, `~/.codex`)를 직접 고치지 않고, 이 저장소의 `sources/`를 원본으로 두고 필요할 때만 동기화합니다.

기본 원칙은 단순합니다.

- 설정의 원본은 이 저장소입니다.
- 수정은 `sources/` 아래에서만 합니다.
- 전역 설정에 반영하기 전에는 먼저 dry run으로 변경 내용을 확인합니다.
- 기존 전역 지시문 파일을 덮어쓰지 않는 `sidecar` 방식을 기본값으로 사용합니다.

## 무엇을 동기화하나

현재 동기화 대상은 지시문, 스킬, 에이전트입니다.

- 지시문 동기화 방식은 `sync.config.json`의 `instructionsMode`가 결정합니다.
- 기본값인 `sidecar` 모드에서는 `sources/AGENTS.md`가 `~/.codex/AGENTS-sync.md`로 복사됩니다.
- 같은 모드에서 `sources/CLAUDE.md`는 `~/.claude/CLAUDE-sync.md`로 복사됩니다.
- `sources/skills/<name>/` 디렉터리는 Claude와 Codex의 전역 skills 디렉터리로 각각 복사됩니다.
- `sources/agents/<name>.md` 파일은 Claude에는 Markdown 그대로 복사됩니다.
- 같은 agent 파일은 Codex용 TOML로 변환되어 `~/.codex/agents/<name>.toml`에 기록됩니다.
- 이름이 다른 기존 전역 skill과 agent는 건드리지 않습니다.

기본 설정에서 `npm run sync`는 기존 `~/.codex/AGENTS.md` 또는 `~/.claude/CLAUDE.md`를 덮어쓰지 않습니다. 대신 `AGENTS-sync.md`, `CLAUDE-sync.md`라는 보조 파일만 만들거나 갱신합니다.

## 저장소 구조

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

이 저장소가 관리하는 내용은 모두 `sources/` 아래에 둡니다. 이 원칙을 지켜야 전역 설정과 저장소 내용이 어긋나지 않습니다.

## 준비 사항

- Node.js와 npm
- Claude 또는 Codex가 표준 전역 디렉터리를 사용하는 환경
  - Claude: `~/.claude`
  - Codex: `~/.codex`

전역 디렉터리(`~/.claude`, `~/.codex`)가 아직 없어도 괜찮습니다. `npm run sync`는 먼저 변경 계획을 출력한 뒤 Y/N 승인을 받아 실제 적용하며, 승인 후 필요한 루트 디렉터리를 자동으로 만듭니다. `npm run sync:dry`는 실제 변경 없이 변경 대상을 `create`/`overwrite`로 출력하고 변경 없는 항목은 요약으로 집계합니다.

Windows에서는 `~`가 `USERPROFILE` 기준으로 해석되고, macOS/Linux에서는 `HOME` 기준으로 해석됩니다.

## 기본 사용 흐름

1. `sources/` 아래의 원본 파일을 수정합니다.
2. 특별한 이유가 없다면 `instructionsMode: "sidecar"`를 유지합니다.
3. 전역 디렉터리에 어떤 변경이 생길지 먼저 확인합니다.

```sh
npm run sync:dry
```

Dry-run은 필요 시 `Target roots`를 포함해 `Instructions`, `Skills`, `Agents`, `Summary`로 묶인 계획을 출력합니다. 변경 없는 항목은 개별 줄로 출력하지 않고 `Summary`의 `unchanged` 수로만 집계합니다.

4. 출력이 의도와 맞으면 실제 동기화를 실행합니다.

```sh
npm run sync
```

`npm run sync`는 같은 변경 계획을 먼저 보여준 뒤 `Apply these changes? [y/N]` 확인을 받습니다. 자동화나 Git hook처럼 입력을 받을 수 없는 경로에서는 다음처럼 `--yes`를 사용하면 계획 출력 후 프롬프트 없이 적용합니다.

```sh
node scripts/sync-global-ai.mjs --yes
```

`--dry-run`은 항상 실제 쓰기보다 우선합니다. `--dry-run --yes`를 함께 전달해도 계획만 출력하고 종료합니다.

5. `sidecar` 지시문을 실제로 참고하게 만들려면 기존 전역 지시문 파일에 짧은 안내 문장을 직접 추가합니다.

Codex의 경우 `~/.codex/AGENTS.md`에 다음과 같은 문장을 추가할 수 있습니다.

```md
Also review and follow the repository-managed instructions in ~/.codex/AGENTS-sync.md when they are relevant.
```

Claude의 경우 `~/.claude/CLAUDE.md`에 다음과 같은 문장을 추가할 수 있습니다.

```md
Also review and follow the repository-managed instructions in ~/.claude/CLAUDE-sync.md when they are relevant.
```

이 문장은 보조 지시문 파일을 참고하라는 요청입니다. 파일 포함을 보장하는 메커니즘은 아니므로, 전역 지시문 자체를 확실히 이 저장소가 관리하게 만들고 싶다면 기존 파일을 백업한 뒤 `instructionsMode`를 `managed`로 바꾸어야 합니다.

스크립트를 직접 실행할 수도 있습니다.

```sh
node scripts/sync-global-ai.mjs --dry-run
node scripts/sync-global-ai.mjs
node scripts/sync-global-ai.mjs --yes
```

## 에이전트 작성

Claude 에이전트 원본은 `sources/agents/` 아래의 Markdown 파일입니다.

각 파일에는 다음 frontmatter를 둡니다.

```md
---
name: example-agent
description: Handles a specific workflow
model: sonnet
---

Agent instructions go here.
```

동기화할 때 Claude는 Markdown 파일을 그대로 받고, Codex는 변환된 TOML 파일을 받습니다. `model` 값은 `sync.config.json`의 `codexAgentModelMap`을 통해 Codex 설정으로 매핑됩니다.

기본 매핑은 `opus`, `sonnet`, `haiku`를 지원합니다. frontmatter의 `model`이 비어 있거나 매핑되지 않은 값이면 `codexAgentDefaults`가 사용됩니다.

## 스킬 작성

스킬은 `sources/skills/<skill-name>/` 아래에 둡니다.

동기화 시 skill 디렉터리 전체가 Claude와 Codex의 전역 skill 디렉터리로 복사됩니다. 재사용할 지시문은 `SKILL.md`에 작성하고, 보조 파일이 필요하면 같은 skill 디렉터리 안에 함께 둡니다.

## 설정 파일

`sync.config.json`은 지시문 동기화 방식과 Claude식 agent model 이름을 Codex 설정으로 바꾸는 규칙을 관리합니다.

```json
{
  "instructionsMode": "sidecar",
  "preCommitSync": "off",
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

### instructionsMode

`instructionsMode`는 `off`, `sidecar`, `managed` 중 하나여야 합니다.

| 모드 | 동작 | 주의할 점 |
| --- | --- | --- |
| `off` | 지시문 파일은 쓰지 않고 skills와 agents만 동기화합니다. | 기존 전역 지시문에는 가장 안전하지만, 이 저장소의 지시문 변경도 반영되지 않습니다. |
| `sidecar` | `~/.codex/AGENTS-sync.md`, `~/.claude/CLAUDE-sync.md`를 씁니다. 기존 `AGENTS.md`, `CLAUDE.md`는 덮어쓰지 않습니다. | 안전한 기본값입니다. 다만 기존 전역 지시문에서 sidecar 파일을 참고하도록 직접 연결해야 의미가 있습니다. |
| `managed` | `~/.codex/AGENTS.md`, `~/.claude/CLAUDE.md`에 직접 씁니다. | 기존 전역 지시문을 덮어씁니다. 반드시 명시적으로 선택하고, 기존 파일을 먼저 백업하세요. |

### preCommitSync

`preCommitSync`는 `on`, `off` 중 하나여야 합니다.

- 기본값은 `off`입니다.
- `on`: `scripts/hooks/pre-commit`이 실행될 때 설정을 동기화합니다. 커밋 중 프롬프트가 뜨지 않도록 `--pre-commit` 모드로 바로 적용합니다.
- `off`: `scripts/hooks/pre-commit`이 실행되어도 동기화하지 않고 안내 메시지만 출력한 뒤 정상 종료합니다.

## 선택 사항: Git hook

커밋 전에 자동으로 동기화하고 싶다면 `preCommitSync: "on"`으로 바꾸고 Git hook 경로를 별도로 설정합니다.

```sh
git config core.hooksPath scripts/hooks
```

이 설정을 켜면 커밋 전에 `scripts/hooks/pre-commit`이 실행됩니다. 훅은 `node scripts/sync-global-ai.mjs --pre-commit`을 실행하며, `sync.config.json`의 `preCommitSync` 값을 따릅니다.

`preCommitSync: "on"`인데 `core.hooksPath`가 `scripts/hooks`로 설정되어 있지 않으면 dry-run과 sync 리포트에 설정 안내가 출력됩니다.

## 안전하게 쓰기 위한 규칙

- 실제 동기화 전에는 항상 `npm run sync:dry`를 먼저 실행합니다.
- `npm run sync`는 변경 계획을 출력한 뒤 Y/N 승인을 받고, 필요한 경우 `~/.claude`, `~/.codex` 루트 디렉터리를 자동으로 만듭니다.
- 자동화에서는 `node scripts/sync-global-ai.mjs --yes`를 사용하면 프롬프트 없이 적용합니다.
- 스크립트는 지정된 Claude/Codex 전역 루트 밖으로 쓰지 않도록 경로를 검사합니다.
- 기본 `sidecar` 모드는 기존 전역 `AGENTS.md`, `CLAUDE.md`를 덮어쓰지 않습니다.
- sidecar 파일은 자동 include가 아닙니다. 필요하면 기존 전역 지시문에서 직접 언급해야 합니다.
- `managed` 모드는 이 저장소가 전역 지시문 파일을 직접 대체하길 원할 때만 사용합니다.
- 이름이 다른 기존 전역 skills와 agents는 보존됩니다.
- 같은 이름의 source skill은 전역 skill 디렉터리에서 교체됩니다.
- 같은 이름의 source agent는 현재 형식으로 쓰기 전에 남아 있는 `.md`, `.toml`, 디렉터리 형태의 오래된 변형을 정리할 수 있습니다.
