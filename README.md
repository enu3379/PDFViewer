# PDFViewer / Margin

Chrome MV3 PDF reader extension for the Margin workflow.

The product behavior is defined by the Margin implementation plan and the static demo stored in `docs/margin-demo.html`.

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

