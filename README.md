# ai-config-sync

Claude와 Codex에서 공통으로 사용할 전역 AI 설정 원본을 한 곳에서 관리하기 위한 템플릿 저장소입니다.

이 저장소의 `sources/`를 원본으로 두고, 필요할 때 전역 Claude/Codex 경로에 동기화합니다.

## 저장소 구조

```text
sources/
  AGENTS.md
  CLAUDE.md
  agents/
  skills/
```

- `sources/AGENTS.md`: Codex 전역 지침 원본입니다.
- `sources/CLAUDE.md`: Claude 전역 지침 원본입니다.
- `sources/agents/`: Claude/Codex에 배포할 agent 원본입니다.
- `sources/skills/`: Claude/Codex에 배포할 skill 원본입니다.

## 동작 방식

- `sources/AGENTS.md`는 `C:\Users\<username>\.codex\AGENTS.md`로 복사합니다.
- `sources/CLAUDE.md`는 `C:\Users\<username>\.claude\CLAUDE.md`로 복사합니다.
- `sources/skills/<이름>`은 `C:\Users\<username>\.claude\skills\<이름>`, `C:\Users\<username>\.codex\skills\<이름>`으로 복사합니다.
- `sources/agents/<이름>.md`는 Claude에는 `C:\Users\<username>\.claude\agents\<이름>.md`로 복사하고, Codex에는 `C:\Users\<username>\.codex\agents\<이름>.toml`로 변환해 복사합니다.
- 현재 저장소에 정의한 전역 지침 파일과 같은 이름의 `skill` 또는 `agent`만 최신화하고, 이름이 일치하지 않는 전역 항목은 보존합니다. (Codex 기본 스킬인 `~/.codex/skills/.system`도 보존합니다.)

> 현재 버전은 전역 `AGENTS.md`, `CLAUDE.md`를 직접 대상으로 삼습니다. 실제 동기화 전에는 반드시 dry-run으로 영향을 확인하세요.

## 사용법

처음 저장소를 받은 뒤에는 루트 디렉터리에서 아래 명령을 실행합니다.

변경 내용을 미리 확인:

```sh
npm run sync:dry
```

즉시 동기화:

```sh
npm run sync
```

커밋 시 자동 동기화 설정:

```sh
git config core.hooksPath scripts/hooks
```

설정 후에는 커밋할 때마다 `scripts/hooks/pre-commit`이 실행되어 전역 Claude/Codex 경로로 자동 동기화됩니다.

필요하면 npm script를 거치지 않고 직접 실행할 수도 있습니다.

```sh
node scripts/sync-global-ai.mjs --dry-run
node scripts/sync-global-ai.mjs
```
