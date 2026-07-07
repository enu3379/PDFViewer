# Progress Log

Last updated: 2026-07-07

## Current State

M0 and M1 are complete. The first M2 implementation pass is complete and pushed, but needs manual Chrome QA before treating M2 as accepted.

## Completed

- M0 scaffold: Vite MV3 extension, `viewer.html`, `hub.html`, `sw.ts`, `pdfjs-dist` exact pin.
- M1 viewer core: PDF.js viewer, URL/file loading, page controls, zoom controls, outline tab, panel shell, resizable right panel.
- M1 loading polish: default host permissions for PDF interception and drag-and-drop local PDF loading.
- M2 implementation pass:
  - `chrome.storage.local` document storage.
  - Text-layer index and anchor helpers.
  - Selection-to-highlight creation with PDF-space quads.
  - Overlay highlight rects and margin dots.
  - Memo compose/list/search/edit/delete UI.
  - `[[links]]` and `#tags` parsing/rendering.
  - Refresh restore path and zoom rerender path.
  - Anchor helper unit tests.

## Needs QA

- Load `dist/` as an unpacked Chrome extension on macOS.
- Open an arXiv PDF and confirm text selection creates a highlight.
- With panel open, confirm selection switches to memo compose mode.
- With panel closed, confirm selection saves quietly and leaves only a margin dot.
- Save a memo with `[[테스트]] #체크`, reload, and confirm highlight, dot, memo card, link, and tag restore.
- Change zoom and confirm highlight rects and dots stay aligned.
- Delete a memo and confirm the linked highlight is also removed.

## Next

- Finish M2 manual QA fixes.
- Keep figure/table extraction out of the immediate path until the separate figure feature direction is decided.
- After M2 acceptance, move to either Hub work or the separate figure workflow, depending on priority.
