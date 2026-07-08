# Windows Local Loading Notes

This note captures the Windows-specific loading and QA path verified on
2026-07-07.

## What Changed Today

- Added Windows fallback npm scripts that call Node through `scripts/run-node.cmd`.
- Added a resizable right-side viewer panel.
- Enabled default PDF interception for `http://*/*` and `https://*/*` PDF URLs.
- Extended automatic interception to local `file://` PDF URLs, including Windows
  UNC-style URLs such as `file://server/share/x.pdf`.
- Added a `webNavigation` fallback that opens the Margin viewer with a file-access
  guide when Chrome's "Allow access to file URLs" toggle is off.
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
- Local file URL with file access allowed: should redirect into
  `viewer.html?file=...` through `declarativeNetRequest` before Chrome's built-in
  PDF viewer flashes.
- Local file URL with file access disabled: should be observed by
  `webNavigation` and replaced with the Margin viewer's file-access guide.
- Double-clicking a PDF in File Explorer when Chrome is the default PDF handler
  enters the same `file://` navigation path. Opening a PDF from Chrome downloads
  also enters this path unless the user chooses a system-viewer action outside
  the browser.
- UNC path coverage: `\\server\share\x.pdf` maps to a `file://server/share/x.pdf`
  URL, so interception must match `^file://` rather than only `^file:///`.
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
- With "Allow access to file URLs" enabled, local `.pdf` and `.PDF` files open
  in Margin automatically from the address bar, File Explorer double-click, and
  Chrome downloads.
- With "Allow access to file URLs" disabled and automatic open enabled, local PDF
  navigation lands on the Margin file-access guide instead of a raw "Missing PDF"
  error.
- With automatic open disabled, local PDFs remain in Chrome's built-in viewer.
- A UNC PDF path such as `\\server\share\x.pdf` redirects and displays the
  original `file://server/share/x.pdf` path without dropping the host.
- Dragging a local `.pdf` onto the empty viewer loads the document.
- The right panel can be resized and keeps its width after refresh.

## Known Windows Notes

- This machine reports Git dubious ownership for the checkout, so local git
  commands use `git -c safe.directory=C:/Users/jakec/Downloads/PDFViewer ...`.
- Node is installed under `D:\Program Files`; the fallback scripts avoid npm
  shims losing `node.exe` when PATH quoting is fragile.
- Chrome's "Allow access to file URLs" is a per-extension toggle. Removing and
  re-adding the unpacked extension can reset it.
- Chrome reloads the extension when the file-access toggle changes, so any open
  extension viewer tab may close or become invalid.
