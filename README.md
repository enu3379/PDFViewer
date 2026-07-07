# PDFViewer / Margin

Chrome MV3 PDF reader extension for the Margin workflow.

For implementation work, [docs/implementation-plan.md](docs/implementation-plan.md) is the source of truth. The static UI reference is [docs/margin-demo.html](docs/margin-demo.html).

## Current Status

M0 is complete. M1 is in progress.

## Spec

- [Implementation Plan](docs/implementation-plan.md)
- [UI Demo](docs/margin-demo.html)

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

Load `dist/` as an unpacked extension in `chrome://extensions`.
