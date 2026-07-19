# ai-config-sync 작업 규칙

이 저장소는 Claude와 Codex의 공유 설정을 관리하는 원본 저장소다. 사용법과 동기화 동작은 [README.md](README.md)를 참고한다.

## 수정 위치

- 전역 지시문은 `sources/AGENTS.md`, `sources/CLAUDE.md`에서만 수정한다.
- Skill은 `sources/skills/<skill-name>/` 아래에서 관리하며, 중심 파일은 `SKILL.md`다.
- Agent 원본은 `sources/agents/<agent-name>.md`에 Markdown으로 작성한다.
- 루트에 `agents/`, `skills/`, `instructions/` 같은 별도 원본 디렉터리를 만들지 않는다.

## 생성물 및 동기화

- 전역 `~/.claude`, `~/.codex` 아래의 파일은 생성물이므로 직접 수정하지 않는다.
- 저장소 원본을 전역 설정 경로에 반영하는 sync 명령은 사용자가 명시적으로 요청한 경우에만 실행한다.
- `sync.config.json`의 기본 안전 설정을 바꾸거나 전역 지시문을 덮어쓰는 동작을 추가할 때는 사용자의 명시적 의도를 확인한다.

## 호환성

- Agent frontmatter에는 `name`, `description`, `model`을 유지한다.
- Agent의 `model` 값은 `sync.config.json`의 모델 매핑과 일치시킨다.
