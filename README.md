# PDFViewer / Margin

Chrome MV3 PDF reader extension for the Margin workflow.

For implementation work, [docs/implementation-plan.md](docs/implementation-plan.md) is the source of truth. The static UI reference is [docs/margin-demo.html](docs/margin-demo.html).

## Current Status

M0 and M1 are complete. M2 highlight and memo storage work is in progress.

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

On Windows, if npm scripts fail with `"node" is not recognized` even though
`node --version` works in PowerShell, use the Windows fallback scripts:

```sh
npm run typecheck:win
npm run build:win
npm run test:win
```

Load `dist/` as an unpacked extension in `chrome://extensions`.

## Windows Loading Notes

- After changing `public/manifest.json`, run `npm run build:win`, then reload the unpacked `dist/` extension in `chrome://extensions`.
- Default PDF interception needs the extension's `http://*/*` and `https://*/*` host permissions. Approve the updated permissions when Chrome asks.
- Local PDFs opened from disk may need "Allow access to file URLs" enabled on the extension details page.
- If automatic PDF interception is disabled from the extension action context menu, turn "PDF automatically opens in Margin" back on or reload the extension.
- Dragging a local `.pdf` file onto an empty viewer page loads it directly without using `file:` URL access.
