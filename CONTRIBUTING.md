# Contributing — PDFViewer / Margin

협업 규칙의 단일 출처(single source of truth). 사람과 AI 에이전트 모두 이 문서를 따른다.
(코딩 에이전트용 운영 요약은 [AGENTS.md](AGENTS.md), 구현 스펙은 [docs/implementation-plan.md](docs/implementation-plan.md))

## 브랜치 전략

| 브랜치 | 역할 | 규칙 |
|---|---|---|
| `main` | 무결점 릴리스 | `dev`와 `hotfix/*`의 PR만 받음 (merge commit). 머지 시 버전 태그 |
| `dev` | 통합 (기본 브랜치) | 모든 작업 브랜치의 PR 대상. squash 머지만 |
| `feature/<이슈#>-<슬러그>` | 기능 | `dev`에서 분기 |
| `fix/<이슈#>-<슬러그>` | 버그 수정 | `dev`에서 분기 |
| `chore/<슬러그>` | 문서·리팩토링·설정 | `dev`에서 분기, 이슈 없어도 됨 |
| `hotfix/<슬러그>` | 긴급 수정 | **`main`에서 분기**, main과 dev **양쪽에** 머지 |

- 작업 브랜치는 머지되면 자동 삭제된다. 짧게 유지할 것.
- `main`·`dev`는 룰셋이 보호한다: 직접 push·force-push·삭제 불가, CI 통과 필수, 머지 방식도 강제됨(dev는 squash만, main은 merge commit만 버튼이 뜬다).

## 작업 흐름

1. **이슈에서 시작** — 배경과 수용 기준을 이슈에 적는다. 이슈가 곧 작업 지시서다: 사람이든 에이전트든 이슈 본문만 보고 착수할 수 있어야 한다.
2. `dev`에서 브랜치를 딴다.
3. PR을 `dev`로 연다. 제목은 Conventional Commits 형식, 본문에 `Closes #이슈번호`.
4. CI(macOS·Windows: typecheck → test → build) 통과 후 squash 머지한다. 리뷰 승인은 머지 조건이 아니지만, CODEOWNERS가 상대에게 리뷰 요청을 자동으로 보낸다.

## PR 제목 = 커밋 컨벤션

squash 머지 시 **PR 제목이 dev의 커밋 메시지가 된다.** 개별 커밋은 자유롭게 하되 PR 제목만 지키면 된다:

| 타입 | 용도 |
|---|---|
| `feat:` | 기능 추가·변경 |
| `fix:` | 버그 수정 |
| `refactor:` | 동작 변화 없는 구조 개선 |
| `docs:` | 문서 |
| `test:` | 테스트 |
| `chore:` | 빌드·설정·기타 |

예: `feat: add manual crop mode to figure panel`

PR은 작게 — 하나의 PR은 하나의 이슈/주제만 다룬다.

## 릴리스

1. `dev` → `main` PR을 연다 (merge commit — 릴리스 경계가 히스토리에 남는다). 미루지 말고 릴리스 단위로 자주 승격할 것.
2. 머지 후 태그: `git tag vX.Y.Z && git push origin vX.Y.Z`
3. `release.yml`이 확장 zip을 빌드해 GitHub Release에 첨부한다.

## 복구 원칙

- 잘못 머지됐으면 **revert**: `git revert -m 1 <머지커밋>`. 히스토리는 지우지 않고 앞으로만 쌓는다.
- 특정 시점을 남기고 싶으면 브랜치가 아니라 **태그** (`v0.4.0-rc.1` 같은 프리릴리스 태그 포함).
- force-push 차단이 곧 복구 가능성의 보장이다. 한번 머지된 상태는 언제든 되돌아갈 수 있다.

## AI 협업

- 에이전트(Claude Code, Codex 등)도 이 문서의 규칙을 그대로 따른다.
- AI가 작성·보조한 PR은 템플릿의 **AI-assisted** 체크박스를 켠다 — 리뷰어가 리뷰 강도를 판단하는 신호.
- 시크릿·`.env`는 절대 커밋하지 않는다. CI에 필요한 값은 GitHub Secrets에 넣는다.
