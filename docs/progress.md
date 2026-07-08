# Progress Log

Last updated: 2026-07-08

## Current State

M0 and M1 are complete. The first M2 implementation pass is complete and pushed, but needs manual Chrome QA before treating M2 as accepted.

## Completed

- M0 scaffold: Vite MV3 extension, `viewer.html`, `hub.html`, `sw.ts`, `pdfjs-dist` exact pin.
- M1 viewer core: PDF.js viewer, URL/file loading, page controls, zoom controls, outline tab, panel shell, resizable right panel.
- M1 loading polish: default host permissions for PDF interception and drag-and-drop local PDF loading.
- Action click polish: non-PDF tabs stay in place and show a short unsupported-document notice instead of navigating to the viewer error state.
- M2 implementation pass:
  - `chrome.storage.local` document storage.
  - Text-layer index and anchor helpers.
  - Selection-to-highlight creation with PDF-space quads.
  - Overlay highlight rects and margin dots.
  - Memo compose/list/search/edit/delete UI.
  - `[[links]]` and `#tags` parsing/rendering.
  - Refresh restore path and zoom rerender path.
  - Anchor helper unit tests.

- Visual refresh (2026-07-07): '여백' 시안 A 디자인 언어 적용.
  - viewer/hub 전면 리스타일: 고스트 툴바, 상자 없는 상태 화면(명조 제목·앰버 점), 탭 점 인디케이터, 앰버 목차 위치 표시, 알약 칩, 커스텀 스크롤바.
  - 확장 아이콘 추가: `scripts/make-icons.mjs`(의존성 없는 PNG 생성기) → `public/icons/icon-{16,32,48,128}.png`, manifest `icons`/`action.default_icon` 연결.
  - 제품명은 미확정 — manifest/문서의 'Margin' 문자열은 유지, 드롭 오버레이 문구만 이름 중립("여기서 열립니다")으로 변경.
- 형광펜 팔레트 테마 추가 (2026-07-07): 「클래식」(기존 4색) + 「소다」(라임·아쿠아·핫핑크·라일락).
  - PenColor 슬롯 id는 저장 규약이라 유지 — 테마는 `:root[data-pen-theme]` CSS 토큰만 교체하므로 기존 하이라이트가 마이그레이션 없이 재도색된다.
  - `core/pen-theme.ts`(테마 목록·라벨·슬롯 이름·순환) + 유닛 테스트, 메모 탭 펜 줄의 팔레트 토글 버튼, `margin:settings.penTheme` 저장.
  - `MarginStore.loadSettings/updateSettings` 추가(병합 저장), sw.ts 자동 열기 토글이 settings를 통째로 덮어쓰던 문제 수정.
- 메모 작성 카드 Enter 저장 (2026-07-08): Enter = 저장(Esc 취소와 대칭), Shift+Enter = 줄바꿈, 한글 IME 조합 확정 Enter는 `isComposing` 가드로 무시. 저장 로직은 버튼과 공용(`#saveCompose`). 작성 카드 힌트 문구에 키 안내 추가.
- 이슈 #1 open UX 구현 (2026-07-08): C1-C8 코드/문서 반영.
  - 액션 클릭 라우팅 개편: 빈 새탭은 빈 뷰어로 전환, 비PDF http(s)는 제자리 토스트, 주입 불가 페이지는 OS 알림, PDF형 URL은 현재 탭에서 뷰어 전환, 확장 페이지는 no-op.
  - 뱃지 폴백 제거, content-type 판별을 GET+헤더 수신 후 abort 방식으로 변경.
  - DNR 규칙 3 추가: `^file://.*\.pdf$` 로컬 PDF 자동 리다이렉트, 규칙 2 case-insensitive 처리.
  - 파일 접근 OFF용 `webNavigation.onBeforeNavigate` 폴백 추가, 자동 열기 토글 OFF 시 무개입.
  - 컨텍스트 메뉴 `auto-open` 체크 상태를 저장값과 동기화하고, 설정 병합 저장으로 펜 테마 보존.
  - 뷰어에 로컬 파일 권한 안내 상태와 파일 없음 상태 추가. 권한 설정 버튼은 현재 탭을 `chrome://extensions/?id=<id>`로 전환하고, 실패 시 URL 텍스트를 노출.
  - manifest 권한 갱신: `declarativeNetRequestWithHostAccess`, `webNavigation`, `notifications`, `file:///*`.
  - URL 판별 헬퍼/테스트와 implementation-plan/windows-local-loading 문서 갱신.

- 뷰어 PDF 저장 기능 (2026-07-09): 툴바 "저장" 버튼 + Ctrl/⌘+S — 내장 뷰어를 대체하며 사라졌던 저장 경로 복원.
  - PDF.js `getData()` 바이트를 blob 앵커로 저장: 재다운로드 없음(오프라인·드래그&드롭 문서도 동작), 권한 추가 없음.
  - 파일명은 원본 basename 유지(`.pdf` 보정, 금지 문자 치환), 문서 로드 전에는 버튼 비활성. Ctrl/⌘+S는 브라우저 "페이지 저장" 대화상자를 preventDefault로 대체.
  - 좁은 창에서 툴바 텍스트가 글자 단위로 꺾이던 문제 수정(nowrap + 툴바 overflow-x 스크롤).

## Needs QA

- Load `dist/` as an unpacked Chrome extension on macOS.
- Open an arXiv PDF and confirm text selection creates a highlight.
- With panel open, confirm selection switches to memo compose mode.
- With panel closed, confirm selection saves quietly and leaves only a margin dot.
- Save a memo with `[[테스트]] #체크`, reload, and confirm highlight, dot, memo card, link, and tag restore.
- Change zoom and confirm highlight rects and dots stay aligned.
- Delete a memo and confirm the linked highlight is also removed.
- Click the extension action on a non-PDF webpage and confirm the current tab stays put with an unsupported-document notice.
- Reload the unpacked extension and confirm the new icon shows in the toolbar and `chrome://extensions`, and the restyled viewer (ghost toolbar, amber tab dot, boxless empty state) renders on a real arXiv PDF.
- Switch the pen palette to 소다, confirm existing highlights/dots/selection recolor, reload the tab and confirm the theme persists, then toggle 자동 열기 in the action context menu and confirm the theme setting survives (merge-write fix).
- Issue #1 manual QA — 실행 가이드는 [issue-1-qa.md](issue-1-qa.md) (Windows/macOS 분리 체크리스트):
  - 빈 새탭 아이콘 클릭, 일반 https 비PDF 토스트, chrome://settings OS 알림, 뷰어 탭 no-op.
  - autoIntercept ON/OFF에서 arXiv, `.pdf`, `.PDF`, 로컬 file PDF, Windows UNC 경로 동작.
  - 파일 접근 OFF에서 로컬 PDF가 권한 안내 상태로 도착하고 "권한 설정 열기"가 현재 탭을 확장 세부정보로 전환하는지 확인.
  - 파일 접근 ON에서 로컬 PDF가 DNR로 무플래시 전환되는지, OFF 폴백의 내장 뷰어 플래시가 수용 가능한지 확인.
  - Chrome 종료 상태에서 PDF 더블클릭 콜드 스타트 DNR 영속성 확인.
  - 파일 접근 토글 변경 시 열린 뷰어 탭 최종 상태 확인.
  - 존재하지 않는 로컬 경로(이동/개명된 파일)가 파일 없음 상태로 도착하는지 확인.
  - (macOS) 시스템 설정에서 Chrome 알림 OFF 시 OS 알림이 조용히 누락되는 알려진 한계 확인.
  - 다운로드 항목 "시스템 뷰어로 열기"는 Margin 미개입이 정상임을 확인.

## Next

- 이슈 #1 대응: C1–C8 + 리뷰 후속 R1–R3 반영 완료 (`feature/1-open-ux` 브랜치) — macOS + Windows 수동 Chrome QA 필요.
- 피규어 UX 개정: [figure-ux.md](figure-ux.md) 설계 확정(DC-F1=패널 경유, 참조↔피규어 양방향 링크, 점프 1/8 정렬+플래시, 카드 크롭 아이콘, 캡션 라벨) — `feature/figure-ux` 브랜치에서 G1–G8 구현 착수 가능.
- Finish M2 manual QA fixes.
- Keep figure/table extraction out of the immediate path until the separate figure feature direction is decided.
- After M2 acceptance, move to either Hub work or the separate figure workflow, depending on priority.
