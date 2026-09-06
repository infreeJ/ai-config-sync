# ai-config-sync

`ai-config-sync`는 Claude, Codex, Antigravity CLI에서 쓸 수 있는 전역 설정을 한 저장소에서 관리하고, 선택한 제공자에만 동기화하는 도구입니다. 전역 디렉터리(`~/.claude`, `~/.codex`, `~/.agents`, `~/.gemini`)를 직접 수정하지 않고 `sources/`를 원본으로 사용합니다.

<br>

## 빠른 시작

1. 개인 원본을 만듭니다.

   ```sh
   npm run init
   ```

   이 명령은 기본 구성을 `sources/`에 만듭니다. 이후 개인 원본은 일반 Git 흐름으로 관리하세요.

2. `sources/` 아래의 파일을 수정합니다.
3. 동기화합니다.

   ```sh
   npm run sync
   ```

`npm run sync`는 동기화 계획을 먼저 보여 주고 `Y/N` 승인을 받은 뒤 적용합니다.

실제 변경을 적용하기 전에는 현재 전역 설정을 `backup/<실행별 폴더>/`에 자동 백업합니다. 기본값은 켜짐이며, 백업 경로는 동기화 결과에 표시됩니다.

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
  GEMINI.md       # Antigravity CLI 지시문 원본
  agents/         # Claude 기준 Markdown agent 원본
  skills/         # 활성화한 제공자에 공유할 skill 디렉터리
scripts/             # 스크립트 및 시스템 파일
sync.config.json      # 동기화 설정 파일
```

`sources/`는 사용자의 개인 원본입니다. 설정은 항상 이 디렉터리에서 수정하세요.

### 동기화 제공자 선택

`sync.config.json`의 `providers`에서 제공자별 동기화 여부를 설정합니다. 기본값은 Claude와 Codex를 동기화하고 Antigravity CLI는 제외하는 다음 설정입니다.

```json
{
  "providers": {
    "claude": true,
    "codex": true,
    "antigravity": false
  }
}
```

허용하는 키는 `claude`, `codex`, `antigravity`뿐이며 값은 boolean이어야 합니다. 일부 키만 지정하면 지정하지 않은 키에는 기본값을 적용합니다. 예를 들어 Antigravity CLI도 동기화하려면 `"antigravity": true`를 지정합니다.

비활성화한 제공자의 전역 지시문, skills, agents는 생성·수정·삭제하지 않습니다. 해당 제공자에서 과거에 동기화한 파일도 그대로 유지합니다. `sources/GEMINI.md`와 Antigravity CLI 대상 skill·agent 원본은 Antigravity CLI를 활성화할 때 사용할 수 있습니다.

| 원본 | Claude | Codex | Antigravity CLI |
| --- | --- | --- | --- |
| `sources/CLAUDE.md` | 지시문 파일 | — | — |
| `sources/AGENTS.md` | — | 지시문 파일 | — |
| `sources/GEMINI.md` | — | — | 지시문 파일 |
| `sources/skills/<name>/SKILL.md` | `~/.claude/skills/<name>/SKILL.md` | `~/.agents/skills/<name>/SKILL.md` | `~/.gemini/antigravity-cli/skills/<name>/SKILL.md` |
| `sources/agents/<name>.md` | `~/.claude/agents/<name>.md` | `~/.codex/agents/<name>.toml` | `~/.gemini/config/agents/<name>/agent.md` |

`CLAUDE.md`, `AGENTS.md`, `GEMINI.md`는 각각 Claude, Codex, Antigravity CLI에만 동기화합니다. 표의 대상 중 `providers`에서 활성화한 제공자에만 실제로 적용합니다.

동일한 이름의 skill 또는 agent는 활성화한 제공자에서만 갱신하지만, 이름이 다른 전역 항목은 보존합니다. Codex에 포함된 `.system` skill도 관리 대상이 아닙니다.

## 동기화 전 백업

`sync.config.json`의 `backup`은 기본값이 `"on"`입니다. 실제 전역 파일 변경이 예정되어 승인된 경우에만, 적용 직전에 현재 전역 설정을 `backup/<실행별 폴더>/`에 복사합니다. 백업 폴더는 `2026-08-20T12-34-56-789Z` 형식의 UTC 생성 시각을 이름에 사용하며, 같은 시각에 여러 번 실행하면 `-1`, `-2`처럼 suffix를 붙여 기존 백업을 덮어쓰지 않습니다.

백업에는 활성화한 제공자의 다음 항목이 존재하는 경우에만, 원래 디렉터리 구조를 유지해 저장합니다. 비활성화한 제공자의 전역 파일은 백업하지 않습니다.

- `~/.codex/AGENTS.md`, `~/.claude/CLAUDE.md`, `~/.gemini/GEMINI.md`
- `~/.claude/skills/`, `~/.agents/skills/`, `~/.gemini/antigravity-cli/skills/`
- `~/.claude/agents/`, `~/.codex/agents/`, `~/.gemini/config/agents/`

`backupRetentionCount`는 보존할 최신 백업 개수이며 기본값은 `10`입니다. 새 백업을 성공적으로 만든 뒤 설정값을 초과한 도구 생성 백업은 폴더 이름의 생성 시각순으로 가장 오래된 것부터 삭제합니다. 폴더의 수정 시각 같은 파일 시스템 메타데이터는 사용하지 않습니다.

`npm run sync:dry`는 계획만 출력하며 백업을 만들거나 기존 백업을 정리하지 않습니다. 백업이 필요하지 않다면 `sync.config.json`에서 `"backup": "off"`로 설정할 수 있으며, 이 경우에도 기존 백업은 정리하지 않습니다. `backup/`에는 개인 전역 설정 사본이 저장될 수 있으므로 Git에서 제외됩니다.

<br>

## 공개 도구 업데이트

개인 설정은 별도의 개인 원격 저장소로 관리하고, 공개 `ai-config-sync`는 `upstream`으로 연결합니다. 한 번만 설정하세요.

```sh
git remote add upstream https://github.com/infreeJ/ai-config-sync.git
```

이후 공개 도구가 업데이트되면 다음을 실행합니다.

```sh
git fetch upstream
git merge upstream/main
```

개인 `sources/`는 개인 원격 저장소에만 관리되므로, 이후 병합에서는 도구 업데이트와 개인 원본을 분리할 수 있습니다.

기존 방식으로 개인 저장소를 사용 중이었다면, 처음 병합할 때 `sources/` 충돌이 발생할 수 있습니다. 이 경우 개인 `sources/`를 보존하세요.

<br>

## 지시문 동기화 모드

`sync.config.json`의 `instructionsMode`로 동작을 고릅니다.

| 모드 | 동작 |
| --- | --- |
| `append` (기본값) | 기존 전역 지시문의 관리 마커 블록에만 원본 지시문을 추가하거나 갱신합니다. |
| `managed` | 활성화한 제공자의 기존 전역 지시문을 원본으로 교체합니다. |
| `off` | 활성화한 제공자의 지시문은 건너뛰고 skills와 agents만 동기화합니다. |
| `sidecar` | 활성화한 제공자의 `AGENTS-sync.md`, `CLAUDE-sync.md`, `GEMINI-sync.md`만 씁니다. (실험적 옵션)|

### 1. `append`: 공유 설정과 로컬 설정 함께 관리

기본값인 `append` 모드는 기존 전역 지시문에 아래 관리 블록이 없으면 끝에 추가하고, 있으면 블록 안의 내용만 저장소 원본으로 갱신합니다. 시작 마커 바로 다음의 경로 마커는 단일 원본 저장소인 `sources/`의 절대 경로를 나타냅니다. 마커 블록 밖의 컴퓨터별 지시문은 그대로 보존합니다.

```md
<!-- ai-config-sync:begin instruction -->
<!-- AUTO-GENERATED from C:\path\to\ai-config-sync\sources -->
저장소의 지시문 내용
<!-- ai-config-sync:end instruction -->
```

시작 또는 종료 마커가 하나만 있거나, 마커가 여러 개이거나, 종료 마커가 시작 마커보다 앞에 있으면 동기화를 중단합니다. 이 경우에는 파일을 수정하지 않습니다.

### 2. `managed`: 전역 지시문을 단일 원본으로 관리

`managed` 모드는 저장소의 지시문을 기존 전역 지시문 파일에 직접 씁니다. 전역 지시문도 이 저장소에서만 관리하고 싶을 때 사용하며, 기존 컴퓨터별 설정을 덮어쓰므로 동기화 전 자동 백업을 확인하세요.

### 3. `off`: 지시문 동기화 생략

`off` 모드는 전역 지시문을 건드리지 않고 skills와 agents만 동기화합니다.

### 4. `sidecar`: 공유 설정과 로컬 설정 분리

`sidecar` 모드는 기존 전역 지시문을 덮어쓰지 않고, 저장소의 지시문을 `AGENTS-sync.md`, `CLAUDE-sync.md`, `GEMINI-sync.md`로 별도 동기화합니다.

`-sync` 파일은 자동으로 포함되지 않으므로, 기존 전역 지시문에서 해당 파일을 참고하도록 한 번 연결해야 합니다.

```md
Also review and follow the repository-managed instructions in ~/.codex/AGENTS-sync.md when they are relevant.
```

Claude에서는 경로를 `~/.claude/CLAUDE-sync.md`로, Antigravity CLI에서는 `~/.gemini/GEMINI-sync.md`로 바꾸면 됩니다.

> `sidecar` 모드는 실험적 옵션이며, 사용은 권장하지 않습니다.

<br>

## 원본 작성법

스킬은 `sources/skills/<skill-name>/`에 두고, 중심 지시문을 `SKILL.md`에 작성합니다. 스킬 프론트매터에는 `name`, `description`만 쓸 수 있습니다. 필요한 보조 파일도 같은 디렉터리에 둘 수 있으며 활성화한 제공자에 함께 복사됩니다.

에이전트는 `sources/agents/<agent-name>.md`에 Claude 기준으로 작성합니다. 에이전트 프론트매터에는 `name`, `description`, `model`, `effort`만 쓸 수 있습니다.

```md
---
name: example-agent
description: Handles a specific workflow
model: balanced
effort: high
---

Agent instructions go here.
```

`model`과 `effort`는 선택 사항입니다. 생략하면 활성화한 제공자 모두 해당 필드를 출력하지 않아 부모 또는 기본 설정을 상속합니다.

- 원본의 `model`에는 `flagship`, `balanced`, `fast` 중 하나를 씁니다. 이 값은 제공자에 독립적인 프리셋이며, Claude 모델 이름을 직접 쓰지 않습니다.
- 원본의 `effort`에는 `low`, `medium`, `high` 중 하나를 씁니다. 이 값도 제공자에 독립적인 프리셋입니다.
- Claude는 `model`과 `effort`를 각각 `modelPresets`, `effortPresets`의 `claude` 대상값으로 변환합니다.
- Codex는 두 프리셋의 `codex` 대상값을 각각 모델과 `model_reasoning_effort`로 변환합니다.
- Antigravity CLI는 `modelPresets`의 `antigravity` 대상 모델만 받고 `effort`는 출력하지 않습니다.

`sync.config.json`의 `modelPresets`는 원본 모델 프리셋을 제공자별 실제 모델로, `effortPresets`는 원본 추론 수준을 제공자별 추론 수준으로 변환합니다. 예를 들어 `balanced` 프리셋은 Claude의 `sonnet`, Codex의 `gpt-5.6-terra`, Antigravity CLI의 `pro`로 변환됩니다. Claude의 `opus`, `sonnet`, `haiku`는 원본 `model` 키가 아니라 `modelPresets` 안의 Claude 대상값이며, `flagship`, `balanced`, `fast` 각각이 이를 가리킵니다.

에이전트에 `model` 또는 `effort`를 썼다면 해당 프리셋의 매핑은 활성화한 제공자에 대해서만 필요합니다. 비활성화한 제공자의 매핑은 남겨 두거나 생략할 수 있으며 동기화에 사용하지 않습니다. Claude 모델 대상값은 `opus`, `sonnet`, `haiku` 중 하나여야 하고, Codex 모델 대상값은 비어 있지 않은 문자열이어야 합니다. Antigravity CLI 모델 대상값은 `flash` 또는 `pro`만 사용할 수 있습니다. `effort` 원본 키는 `low`, `medium`, `high` 중 하나여야 합니다. 반면 제공자 대상값은 더 세분화할 수 있어 Claude 대상값은 `low`, `medium`, `high`, `xhigh`, `max`, Codex 대상값은 `none`, `low`, `medium`, `high`, `xhigh`, `max` 중 하나여야 합니다. Antigravity CLI는 추론 수준을 받지 않으므로 `effortPresets`의 `antigravity` 값은 동기화에 사용하지 않습니다. 기본 설정 예시에서는 빈 문자열(`""`)로 두었으며, 생략해도 됩니다.

```json
{
  "modelPresets": {
    "flagship": {
      "claude": "opus",
      "codex": "gpt-5.6-sol",
      "antigravity": "pro"
    },
    "balanced": {
      "claude": "sonnet",
      "codex": "gpt-5.6-terra",
      "antigravity": "pro"
    },
    "fast": {
      "claude": "haiku",
      "codex": "gpt-5.6-luna",
      "antigravity": "flash"
    }
  },
  "effortPresets": {
    "low": {
      "claude": "low",
      "codex": "low",
      "antigravity": ""
    },
    "medium": {
      "claude": "medium",
      "codex": "medium",
      "antigravity": ""
    },
    "high": {
      "claude": "high",
      "codex": "high",
      "antigravity": ""
    }
  }
}
```

이 변경은 기존 에이전트 원본과 설정의 호환성을 깨뜨립니다. 기존 원본의 `model: opus|sonnet|haiku`는 각각 의도에 맞는 `flagship|balanced|fast`로, `effort: xhigh|max`는 `high`로 바꾸세요. 설정의 `agentModelMap`은 `modelPresets`로, `agentEffortMap`은 `effortPresets`로 옮기고, 기본 `effortPresets`의 `xhigh`·`max` 항목은 제거하세요. 세분화한 대상값이 필요하면 `high` 항목의 Claude 또는 Codex 대상값으로 설정할 수 있습니다. 이전 키를 설정 파일에 남겨도 오류가 나지 않고 무시될 수 있으므로, 마이그레이션 후에는 반드시 제거하고 `npm run sync:dry`로 결과를 확인하세요. 이전 설정의 `codexAgentDefaults`, `codexAgentModelMap`도 더 이상 사용하지 않습니다.

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
- 기본 `append` 모드는 관리 마커 블록 밖의 기존 전역 지시문을 보존합니다.
- 스크립트는 활성화한 제공자의 지정 전역 루트 밖으로 쓰지 않도록 경로를 검증합니다.
