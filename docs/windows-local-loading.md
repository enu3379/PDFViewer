# Windows Local Loading Notes

This note captures the Windows-specific loading and QA path verified on
2026-07-07.

## What Changed Today

- Added Windows fallback npm scripts that call Node through `scripts/run-node.cmd`.
- Added a resizable right-side viewer panel.
- Enabled default PDF interception for `http://*/*` and `https://*/*` PDF URLs.
- Added local PDF drag-and-drop loading in `viewer.html`.
- Documented the Chrome extension reload and permission steps below.

## Build And Load

Use the Windows fallback scripts if normal npm scripts fail with
`"node" is not recognized`:

```sh
npm.cmd ci
npm.cmd run typecheck:win
npm.cmd run test:win
npm.cmd run build:win
```

Then load the extension:

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Load or reload the unpacked extension from `dist/`.
4. Approve the updated host permissions when Chrome asks.

After any `public/manifest.json` change, run `npm.cmd run build:win` and reload
the unpacked `dist/` extension. Manifest changes are not picked up by the
already-loaded extension.

## PDF Loading Paths

- Remote PDF URL: should redirect into `viewer.html?file=...` through
  `declarativeNetRequest`.
- Toolbar fallback: click the extension action on a PDF tab to open the current
  URL in Margin.
- Local PDF drag and drop: drag a `.pdf` file onto the empty viewer page.
- Local `file:` URL: may need "Allow access to file URLs" on the extension
  details page.

## QA Checklist

- `npm.cmd run typecheck:win` passes.
- `npm.cmd run test:win` passes.
- `npm.cmd run build:win` creates `dist/manifest.json`, `dist/sw.js`, and
  `dist/viewer.html`.
- After reloading `dist/`, a normal HTTPS PDF link opens in Margin by default.
- Dragging a local `.pdf` onto the empty viewer loads the document.
- The right panel can be resized and keeps its width after refresh.

## Known Windows Notes

- This machine reports Git dubious ownership for the checkout, so local git
  commands use `git -c safe.directory=C:/Users/jakec/Downloads/PDFViewer ...`.
- Node is installed under `D:\Program Files`; the fallback scripts avoid npm
  shims losing `node.exe` when PATH quoting is fragile.
