# 단일 원본 저장소 규칙

## 에이전트 파일 단일 관리

- 전역 AI 설정의 동기화 관리 대상(`skills`, `agents`, `AGENTS.md`, `CLAUDE.md`)은 단일 원본 저장소인 `sources/`에서만 생성·수정한다.
단일 원본 저장소의 절대 경로는 `<!-- AUTO-GENERATED from {경로} -->` 마커의 `{경로}`다.


## 에이전트 파일 생성·수정

- 전역 `AGENTS.md`와 `CLAUDE.md`에서 `<!-- ai-config-sync:begin instruction -->`과 `<!-- ai-config-sync:end instruction -->` 사이 영역은 단일 원본 저장소가 관리한다. 이 영역과 경로 마커는 전역 파일에서 직접 수정하지 않는다.
- 위 마커 밖 영역은 컴퓨터별 전역 설정이며, 전역 파일에서 직접 관리한다.
- 프로젝트 저장소의 지시문·스킬·서브에이전트는 전역 동기화 대상이 아니다. 해당 프로젝트 저장소에서 직접 생성·수정한다.
- 서브에이전트 원본은 Claude Code 호환 Markdown `.md` 파일로만 관리한다. Codex TOML은 동기화 결과물이므로 원본 저장소에서 직접 작성하지 않는다.