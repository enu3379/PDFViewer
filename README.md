# PDFViewer / Margin

Chrome MV3 PDF reader extension for the Margin workflow.

For implementation work, [docs/implementation-plan.md](docs/implementation-plan.md) is the source of truth. The static UI reference is [docs/margin-demo.html](docs/margin-demo.html).

## Current Status

M0, M1, and the first M2 implementation pass are complete. M2 still needs manual Chrome QA for drag highlight, memo restore, and zoom positioning.

## Spec

- [Implementation Plan](docs/implementation-plan.md)
- [UI Demo](docs/margin-demo.html)
- [Progress Log](docs/progress.md)

## Milestones

- M0: Vite extension scaffold, `viewer.html`, `hub.html`, `sw.js`
- M1: PDF.js viewer core and panel shell
- M2: highlights, memos, anchors, storage
- M3: figure/table detection, reference links, caption label clicks
- M4: manual crop mode
- M5: note hub
- M6: PDF interception, permissions, final QA

## Commands

```sh
npm install
npm run build
npm test
```

On Windows, if npm scripts fail with `"node" is not recognized` even though
`node --version` works in PowerShell, use the Windows fallback scripts:

```sh
npm run typecheck:win
npm run build:win
npm run test:win
```

Load `dist/` as an unpacked extension in `chrome://extensions`.

## Windows Loading Notes

See [Windows Local Loading Notes](docs/windows-local-loading.md) for the verified
Windows build, Chrome extension reload, PDF interception, and local drag-and-drop
QA checklist.
