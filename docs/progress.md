# Progress Log

Last updated: 2026-07-07

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

## Next

- Finish M2 manual QA fixes.
- Keep figure/table extraction out of the immediate path until the separate figure feature direction is decided.
- After M2 acceptance, move to either Hub work or the separate figure workflow, depending on priority.
