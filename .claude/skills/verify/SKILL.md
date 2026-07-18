---
name: verify
description: Drive the Gubbins PWA in a real browser to confirm a change works end-to-end.
---

# Verifying a change in Gubbins

Gubbins is a browser PWA backed by sqlite-wasm + OPFS. Verification means driving the real
app in Edge via Playwright — the DB only exists in a cross-origin-isolated browser context, so
there is no CLI or server surface to poke instead.

## Handle

```bash
npm run dev                     # http://localhost:5173/Gubbins/
```

Then drive it with Playwright (already a dependency — **the script must live in the repo root**
so `import { chromium } from 'playwright'` resolves):

```js
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 950 } });
page.setDefaultTimeout(8000);
page.setDefaultNavigationTimeout(30000);
await page.goto('http://localhost:5173/Gubbins/inventory', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('text=/Add item/i', { timeout: 30000 });
```

`scripts/browser-smoke.mjs` is the full end-to-end suite — read it for selectors and flows
rather than re-deriving them.

## Gotchas that cost time

- **Dismiss the first-run module chooser.** A fresh profile opens "Set up your modules", which
  traps focus and intercepts every click: `await page.getByTestId('first-run-skip').click()`.
- **Every Playwright launch is a fresh profile → empty OPFS → no items.** Create whatever data
  the flow needs *in the same script run*; a probe script that assumes an item exists from an
  earlier run will time out looking for it.
- **Wait on an element, not a timeout, after opening a modal.** Screenshotting a modal straight
  after the click can capture a fully black frame mid-animation. Do
  `await page.getByTestId('<something-in-the-dialog>').waitFor({ state: 'visible' })` first.
- **The edit-details dialog stays open after "Save details"** (the button just flips to
  "Saved"). Press Escape before driving anything behind it.
- **Item weight lives in edit details, not the create form.** Create the item, then open
  **More → Edit details…** and fill "Weight (g)".
- **Run the script in the background** and poll its output file — a cold start plus a few flows
  comfortably exceeds a 2-minute foreground timeout.

## Worktrees

The dev server **does** run from inside a `.claude/worktrees/*` worktree, but not with a plain
`npm run dev`: the worktree has no `node_modules`, so sqlite-wasm resolves up to the primary
checkout and Vite serves its loader via `@fs/…` while the sibling `.wasm` 404s — the DB never
initialises and the app never reaches "Add item".

Two things fix it together — a junction **and** `resolve.preserveSymlinks` (the junction alone
doesn't work; Vite dereferences the link and goes back to `@fs`). `vite.worktree.config.ts`
carries the flag, so no config edit is needed:

```bash
# 1. junction the primary checkout's node_modules into the worktree
powershell -c "New-Item -ItemType Junction -Path '<worktree>/node_modules' -Target '<repo>/node_modules'"

# 2. serve on a port of your own (other agents may be on 5173)
npx vite --config vite.worktree.config.ts --port 5199

# 3. drive it, e.g. regenerate the wiki images
WIKI_BASE=http://localhost:5199/Gubbins/ node scripts/wiki-screenshots.mjs
```

**Clean up in this order, or the next step breaks:**

1. Stop the dev server (it holds handles under `node_modules`).
2. **Remove the junction** — `[IO.Directory]::Delete('<worktree>/node_modules', $false)`, then
   confirm the `LINK` is gone. Deleting it recursively would walk into the *real* `node_modules`.
3. Only then run Vitest or `git worktree remove`. With the junction still in place the Vitest
   CLI and Vite resolve the same package by two different realpaths, load two Vitest instances,
   and every file fails with "failed to find the current suite".

For the unit suite from a worktree, use `vitest.worktree.config.ts` (it drops the
`**/.claude/worktrees/**` exclude that would otherwise collect zero tests) and do **not**
junction `node_modules` — Node's upward resolution already finds the real one:

```bash
npx vitest run --config vitest.worktree.config.ts [files…]
```
