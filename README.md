# ai-config-sync

`ai-config-sync`는 Claude와 Codex에서 함께 쓰는 전역 지시문, 스킬, 에이전트를 한 저장소에서 관리하고 필요할 때 동기화하는 도구입니다. 전역 디렉터리(`~/.claude`, `~/.codex`)를 직접 수정하지 않고 `sources/`를 원본으로 사용합니다.

<br>

## 빠른 시작

1. `sources/` 아래의 파일을 수정합니다.
2. 동기화합니다.

   ```sh
   npm run sync
   ```

`npm run sync`는 동기화 계획을 먼저 보여 주고 `Y/N` 승인을 받은 뒤 적용합니다.

변경 계획만 확인하고 싶다면 다음을 사용하세요. 실제 파일은 수정하지 않습니다.

```sh
npm run sync:dry
```

<br>

## 관리 범위와 구조

```text
sources/
  AGENTS.md       # Codex 지시문 원본
  CLAUDE.md       # Claude 지시문 원본
  agents/         # Claude용 Markdown agent 원본
  skills/         # 두 도구에 공유할 skill 디렉터리
scripts/
  sync-global-ai.mjs
sync.config.json
```

| 원본 | Claude | Codex |
| --- | --- | --- |
| `sources/CLAUDE.md` | 지시문 파일 | — |
| `sources/AGENTS.md` | — | 지시문 파일 |
| `sources/skills/<name>/` | skill 디렉터리 | skill 디렉터리 |
| `sources/agents/<name>.md` | Markdown agent | 변환된 TOML agent |

동일한 이름의 skill 또는 agent는 갱신하지만, 이름이 다른 전역 항목은 보존합니다. Codex에 포함된 `.system` skill도 관리 대상이 아닙니다.

<br>

## 지시문 동기화 모드

`sync.config.json`의 `instructionsMode`로 동작을 고릅니다.

| 모드 | 동작 |
| --- | --- |
| `sidecar` (기본값) | `AGENTS-sync.md`, `CLAUDE-sync.md`만 쓰며 기존 전역 지시문을 보존합니다. |
| `managed` | 기존 전역 지시문인 `~/.codex/AGENTS.md`, `~/.claude/CLAUDE.md`를 원본으로 교체합니다. |
| `off` | 지시문은 건너뛰고 skills와 agents만 동기화합니다. |

### 1. `sidecar`: 공유 설정과 로컬 설정 분리

기본값인 `sidecar` 모드는 기존 전역 지시문을 덮어쓰지 않고, 저장소의 지시문을 `AGENTS-sync.md`와 `CLAUDE-sync.md`로 별도 동기화합니다.

처음 도입할 때 기존 설정을 안전하게 보존할 수 있습니다. 필요하다면 컴퓨터마다 다른 경로·도구·환경 설정은 기존 전역 지시문에 유지하고, 여러 컴퓨터에 공통으로 적용할 지시는 이 저장소에서 관리할 수도 있습니다.

`-sync` 파일은 자동으로 포함되지 않으므로, 기존 전역 지시문에서 해당 파일을 참고하도록 한 번 연결해야 합니다.

```md
Also review and follow the repository-managed instructions in ~/.codex/AGENTS-sync.md when they are relevant.
```

Claude에서는 경로만 `~/.claude/CLAUDE-sync.md`로 바꾸면 됩니다.

### 2. `managed`: 전역 지시문을 단일 원본으로 관리

`managed` 모드는 저장소의 지시문을 기존 전역 지시문 파일에 직접 씁니다. 전역 지시문도 이 저장소에서만 관리하고 싶을 때 사용하며, 기존 컴퓨터별 설정을 덮어쓰므로 먼저 백업해야 합니다.

<br>

## 원본 작성법

스킬은 `sources/skills/<skill-name>/`에 두고, 중심 지시문을 `SKILL.md`에 작성합니다. 필요한 보조 파일도 같은 디렉터리에 둡니다.

에이전트는 `sources/agents/<agent-name>.md`에 작성합니다.

```md
---
name: example-agent
description: Handles a specific workflow
model: sonnet
---

Agent instructions go here.
```

Claude에는 Markdown이 그대로 복사되고, Codex에는 TOML로 변환됩니다. `model` 값은 `sync.config.json`의 `codexAgentModelMap`으로 매핑하며, 없는 값은 `codexAgentDefaults`를 사용합니다.

<br>

## 선택 사항: 자동화 및 커밋 전 동기화

CI나 Git hook처럼 입력을 받을 수 없는 환경에서는 `--yes`로 승인 프롬프트 없이 적용할 수 있습니다.

```sh
npm run sync:yes
```

`sync.config.json`에서 `preCommitSync`를 `"on"`으로 바꾸고 한 번만 hook 경로를 설정하세요.

```sh
git config core.hooksPath scripts/hooks
```

이후 커밋 전 동기화가 자동 적용됩니다. 기본값인 `off`에서는 hook이 아무 변경도 하지 않습니다.

<br>

## 안전 규칙

- 수정은 항상 `sources/`에서만 합니다.
- 적용 전에는 `npm run sync:dry`로 계획을 확인합니다.
- 기본 `sidecar` 모드는 기존 전역 지시문을 덮어쓰지 않습니다.
- 스크립트는 Claude/Codex의 지정 전역 루트 밖으로 쓰지 않도록 경로를 검증합니다.
