# Review rules: Gubbins

The global `auto-review` skill reads this file at its step 2. It holds only what is Gubbins's own:
the documents to collect, the compliance checklist, lane 8's brief, the known instances of checks A
to H, where definitions hide, and this project's false positives. The lanes, levels, steps and the
general checks are the skill's.

## Rules to collect

Always the root `CLAUDE.md`. Memory notes live in `P:/Source/!Memories/Gubbins/<title>.md`; collect
the ones whose kind of change is in the diff.

| The diff touches | Collect |
| --- | --- |
| UI markup, classes, styles (`src/components`, `src/features/**/*.tsx`, `src/styles/index.css`) | *Pick a Gubbins design token by semantic role*, *No UI bodges*, *Handset variant zoom safe hiding*, *Modal stack seam*, *Foundry money control* |
| A user-facing string, or `src/features/i18n/catalogs/*.json` | *I18n typed catalog seam* |
| A user-facing or configurable surface | *Wiki staged in repo*, *Wiki screenshot regeneration* |
| The item model, a `FieldType`, a status or tracking mode | *Item model parallel lists*, *Field type add touchpoints*, *Field dictionary and location inheritance* |
| `src/db`, sync, backup, restore, a synced table or flag | *LWW resolves in JS not SQL*, *One of n flag sync invariant*, *Save before destroying seam* |
| Dates, intervals, money, errors, imports, exports, switches over a string union | *DST calendar days seam*, *Date input midnight seam*, *Money rounding seam*, *Error copy seam*, *Import file read seam*, *Import row problems seam*, *Tabular export seam*, *Exhaustive switch guard seam* |
| Persisted stores, editors with drafts, the agenda, pagination | *Persisted state reconcile on read*, *Unsaved changes guard seam*, *Agenda invalidation seam*, *Pagination app wide seam* |
| A comment claiming one definition mirrors another | *A mirrors-X comment in Gubbins needs a drift test* |
| `docs/todo/` | *Docs todo status convention*, `docs/todo/README.md` |
| `package.json` dependencies or the lockfile | *The Gubbins lockfile must be resolved on Linux* |
| Tests | *Component test gotchas* |

## Compliance checklist (lane 1)

Quote the `CLAUDE.md` rule broken. The rules most worth checking:

- Design tokens: no hex, `rgb()`, `oklch()`, palette class, inline `cubic-bezier(...)` or
  `@keyframes`; a new semantic token in both the light and dark blocks.
- Foundry primitives over a bare styled `<button>`, `<input>`, `<select>` or modal.
- `mb-field-gap` (`mb-field-gap-compact`) for label spacing, never `mb-1`, `gap-1`, `space-y-1`.
- Accessibility wiring: roles, keyboard handlers, `aria-label` on icon-only buttons,
  `role="alert"` on errors, `LiveRegion`, `<main id="main-content">`.
- Every user-facing string through `t()`, with a real translation in every other catalog
  (`de.json`) in the same change; plurals and values through `t()` vars, never concatenation.
- The wiki page under `docs/wiki` updated when a user-facing surface changed.
- No secret, personal data or data artefact; no internal reference, person-blaming `TODO` or agent
  process in code, comments or docs (public-repository hygiene).
- A "mirrors X" or "keep in sync" comment backed by a drift test it names.
- A `docs/todo/` plan opens with a `> **Status:**` banner; a finished one is in `done/`.
- A lockfile change came from `npm run lock`, not a hand edit or a Windows `npm install`.

## Lane 8: the project's failure mode

Not required below `ultra`. Gubbins is a **public** repository holding a user's **only** copy of
their inventory, so it can least afford a leak and lost data. Build a concrete scenario against
the diff and check it against the code:

- **Leak:** a credential, token, real e-mail address, host or personal record reaching a commit,
  fixture, screenshot, log line, error message or exported file.
- **Lost data:** a delete or overwrite reached before the save proves it landed (*Save before
  destroying seam*); a sync, restore or import path that drops, duplicates or silently rewrites
  rows (last-write-wins is decided in JavaScript, and restore has no gate); a migration that cannot
  run on an existing vault; an editor that discards an uncommitted draft; a rehydrated persisted
  store trusted as typed.

Report with category `data-leak` or `data-loss`.

## Known instances of checks A to H

- **A. Phantom surface:** an unknown Tailwind utility emits no CSS and no error; a `t('key')`
  absent from `en.json`; a `gubbins:` storage key not in `src/lib/storage-keys.ts`; a Lucide glyph
  name that is not exported; an npm script, route or bridge endpoint (`bridge/openapi.yaml`) that
  does not exist.
- **B. Half-applied parallel edit:** a key in `en.json` but not `de.json`; an accent added to
  `ACCENTS` (`src/features/settings/theme-registry.ts`) without both the light and dark CSS block;
  a new `FieldType` wired into some of its touch-point lists; a new `CREATE TABLE` not classified in
  `src/db/repositories/tombstone.ts`; an enum arm with no label, icon or order map entry; a new
  item-model concept missing from a parallel list (*Item model parallel lists*).
- **C. Re-implemented seam:** day arithmetic outside `src/lib/calendar-days.ts`; money rounding or
  summing outside `src/lib/money.ts`; date-picker conversion outside `src/lib/date-input.ts`;
  `e instanceof Error ? e.message : …` instead of `src/features/errors/useErrorMessage.ts`;
  `file.text()` instead of `readImportFile` (`src/features/import/file-source.ts`); a bespoke list
  exporter instead of `src/features/export/tabular-export.ts`; a download before a destructive step
  instead of `src/lib/save-file.ts`; a hand-rolled `default` instead of `assertExhaustive`
  (`src/lib/exhaustive.ts`); persisted-store reconciliation outside `src/lib/persisted-state.ts`.
- **D. Dead on arrival:** a superseded `fooV2` beside `foo`; an import used nowhere.
- **E. Test theatre:** asserting on a mock of `../mutations` rather than the subject; an `await`
  with no assertion after it; a fresh snapshot accepted as the assertion; an expectation loosened to
  `expect.any(…)`; `it.skip`, `.only` or a commented-out case left behind. Tests are excluded from
  `tsc`, so a fixture missing a field silently defaults to `undefined`.
- **F. Suppression:** `@ts-ignore`, `@ts-expect-error`, `as unknown as`, a widened `any`, a new
  `eslint-disable`, `catch { return null }`, a bare `console.error` catch, a `?? fallback` over a
  value that should never be missing.
- **G. Scope creep:** a backwards-compatibility shim for a version that never shipped.
- **H. Unbacked claim:** a wiki page or a plan's `COMPLETE` banner claiming what the diff does not
  deliver; `console.log` or `debugger` left behind.

## Where definitions hide (check A)

Re-export barrels (`index.ts`), generated files (`src/routeTree.gen.ts`, `*.gen.ts`), `*.d.ts`,
string-keyed lookups (i18n keys, storage keys, registries), dynamic `import()`, the bridge
(`bridge/`), the browser extension (`extension/`), the Home Assistant integration
(`custom_components/`, `homeassistant/`), and the tokens in `src/styles/index.css` that Tailwind
turns into utilities.

## False positives specific to Gubbins

- Type suppressions and loose types in test files, mocks and fixtures, where they are idiomatic.
- Google Drive sync on the OAuth implicit flow: deliberate (*Google drive OAuth implicit flow*).
- The easter eggs and hidden `/lab` flags missing from the wiki: a sanctioned exception (*Hidden
  lab flags and easter eggs*).
