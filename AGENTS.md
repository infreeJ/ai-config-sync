# ai-workbench 작업 지침

이 저장소는 전역 Claude와 Codex에서 공통으로 사용할 개인 `instructions`, `skills`, `agents`를 관리하는 단일 진실 공급원이다. 전역 디렉터리의 산출물을 직접 수정하지 말고, 항상 이 저장소의 원본을 수정한 뒤 동기화한다.

## 저장소 역할

- `instructions/`: 전역 `AGENTS.md`와 `CLAUDE.md` 원본 파일.
- `skills/`: Claude/Codex 양쪽에 복사될 skill 원본 디렉터리.
- `agents/`: Claude용 Markdown agent 원본 파일. Codex용 agent는 동기화 시 TOML로 변환된다.
- `scripts/sync-global-ai.mjs`: 이 저장소의 원본을 전역 Claude/Codex 경로로 배포하는 동기화 스크립트.
- `sync.config.json`: Codex agent 변환 시 사용할 기본 모델과 Claude식 `model` 별 매핑을 정의한다.
- `scripts/hooks/pre-commit`: 커밋 전 전역 동기화를 실행하기 위한 Git hook.

## 동기화 규칙

- `instructions/AGENTS.md`는 Codex 전역 지침 파일로 복사된다.
  - `~/.codex/AGENTS.md`
- `instructions/CLAUDE.md`는 Claude 전역 지침 파일로 복사된다.
  - `~/.claude/CLAUDE.md`
- `skills/<name>/`은 다음 위치로 복사된다.
  - `~/.claude/skills/<name>/`
  - `~/.codex/skills/<name>/`
- `agents/<name>.md`는 Claude에는 Markdown 그대로 복사된다.
  - `~/.claude/agents/<name>.md`
- 같은 agent는 Codex에는 TOML로 변환되어 기록된다.
  - `~/.codex/agents/<name>.toml`
- 이 저장소에 존재하는 같은 이름의 skill/agent만 갱신한다. 이름이 일치하지 않는 다른 전역 항목은 보존된다.
- Codex 기본 시스템 skill인 `~/.codex/skills/.system` 같은 전역 기본 항목은 이 저장소의 관리 대상이 아니다.

## 작성 규칙

- skill은 반드시 `skills/<skill-name>/SKILL.md`를 중심으로 작성한다.
- 전역 지침은 반드시 `instructions/AGENTS.md`와 `instructions/CLAUDE.md`를 수정한다.
- agent는 반드시 `agents/<agent-name>.md` 형식의 최상위 Markdown 파일로 작성한다.
- agent Markdown의 frontmatter에는 최소한 `name`, `description`, `model`을 유지한다.
- `model` 값은 `sync.config.json`의 `codexAgentModelMap`에 맞춘다. 현재 기본 매핑은 `opus`, `sonnet`, `haiku`다.
- Codex용 `.toml` agent 파일을 직접 만들지 않는다. 필요하면 `agents/*.md`와 `sync.config.json`을 수정한다.
- 전역 `~/.claude`, `~/.codex` 아래 파일을 직접 고치지 않는다.

## 운영 명령

아래 명령은 사용자가 직접 실행하는 운영 명령이다. 사용자가 명시적으로 요청한 경우에만 실행한다.

동기화 영향 범위 확인:

```sh
npm run sync:dry
```

전역 Claude/Codex 경로에 실제 동기화:

```sh
npm run sync
```

Git hook 설정:

```sh
git config core.hooksPath scripts/hooks
```

## 작업 시 주의

- 이 저장소의 핵심 가치는 Claude와 Codex 설정의 중복 편집을 없애는 것이다. 새 기능을 추가할 때도 이 원칙을 깨지 않는다.
- `instructions/CLAUDE.md`는 `instructions/AGENTS.md`를 참조만 하는 파일로 강제하지 않는다. Claude 전역 지침으로 배포할 내용을 독립적으로 보관한다.
- 동기화 스크립트는 전역 디렉터리에 쓴다. 사용자의 명시적 요청 없이 `npm run sync`, `npm run sync:dry`, Git hook 설정을 실행하지 않는다.
- 동기화 스크립트를 바꿀 때는 경로가 전역 root 밖으로 벗어나지 않도록 하는 안전장치를 유지한다.
