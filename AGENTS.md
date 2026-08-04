# Agent Guide — PDFViewer / Margin

Chrome MV3 PDF reader extension ("Margin"): a pdf.js-based viewer with highlights, memos, figure/table detection, and a note hub. Vite + TypeScript, tested with Vitest.

The spec is [docs/implementation-plan.md](docs/implementation-plan.md) (Korean) — it is the source of truth for behavior and UI rules. Full collaboration rules: [CONTRIBUTING.md](CONTRIBUTING.md) (Korean).

## Commands

```sh
npm ci                 # install from lockfile
npm run typecheck      # tsc --noEmit
npm test               # vitest run
npm run build          # vite build → dist/
```

On Windows, if npm scripts fail with `"node" is not recognized`, use the `:win` variants (`npm run typecheck:win`, `test:win`, `build:win`).

For manual checks, load `dist/` as an unpacked extension at `chrome://extensions`.

## Layout

- `src/viewer/` — PDF viewer UI (pdf.js), entry `viewer.html`
- `src/hub/` — note hub, entry `hub.html`
- `src/core/` — shared logic (anchors, formatting)
- `src/sw.ts` — MV3 service worker
- `test/` — Vitest unit tests
- `docs/` — spec, progress log, QA guides

## Workflow rules (operational minimum)

1. Never commit directly to `main` or `dev` — rulesets reject direct pushes.
2. Branch from `dev`: `feature/<issue#>-<slug>`, `fix/<issue#>-<slug>`, `chore/<slug>`. Only `hotfix/<slug>` branches from `main` (and must merge into both `main` and `dev`).
3. Open PRs against `dev`. It is squash-merged: **the PR title becomes the commit message**, so PR titles must follow Conventional Commits (`feat: …`, `fix: …`, `chore: …`).
4. Reference the issue in the PR body (`Closes #N`).
5. Run `npm run typecheck` and `npm test` before opening a PR. CI (macOS + Windows) must pass to merge.
6. Check the **AI-assisted** box in the PR template.
7. Never commit secrets or `.env` files.
