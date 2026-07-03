# UI design-system bodge audit

> **Effort:** multi-phase, multi-session, review-gated. Phase 0 = audit only (this doc).
> Each later phase fixes **exactly one category**, runs the checks, updates this register,
> and stops for review. When every finding below is `done`, move this file to
> `docs/todo/done/ui-bodge-audit.md`.

Scope swept: all of `src/**` (features, screens, nav/`AppNav`/`PageHeader`, boot/error
screens, the Foundry primitives, app-shell, `src/styles/index.css`). House rules per
`CLAUDE.md` + `src/styles/index.css`: design tokens mandatory, reach for a Foundry primitive
first, motion via `ease-emphasized` + `gubbins-*` keyframes, field spacing via
`field-gap`/`field-gap-compact`.

**Prior work — do NOT re-flag:** the label→control field-gap fix (`space-y-1` /
`flex flex-col gap-1` → `mb-field-gap` token) already landed for `ReorderPointEditor`,
`CapabilityEditor`, `PrintLabelsDialog`, `PrintLocationLabelDialog`, `ImportDataDialog`,
`BackupDialog`. This worktree's branch is fast-forwarded onto `worktree-edit-item-dialog-fixes`
(tip `5e8cd94`), so those fixes — and the `CLAUDE.md` "Controls & spacing: no hand-rolled
bodges" rule (commit `5e8cd94`) — are present in this base. That base also carries an unmerged
feature commit (`2a741de`, editable core item fields); this fix effort is stacked on top of it.

---

## Category A — Hand-rolled form controls that duplicate a Foundry primitive

A bare `<select>` / `<input>` / `<textarea>` re-implements (usually imperfectly) the
`Foundry Input`/`Select`/`Textarea` classes at the call site. Real cost: the copies drop the
standard focus ring, use the wrong surface (`bg-background` instead of `bg-input/40`), and
drift in height/padding — so they read and behave differently from every other field, and a
future token change won't reach them. **Fix: replace with the Foundry primitive**, passing
only genuinely-local overrides (e.g. `className="h-9 w-24"`) via `className`.

**Impact: HIGH (user-visible + a11y focus indicator + theming). Confidence: HIGH.**
**Status: DONE ✅ — all 11 findings fixed in Phase 1 (also resolves C1). 4 bare `<select>` +
5 `<input type=number>` + 2 `<textarea>` now use the Foundry `Select`/`Input`/`Textarea`
primitives, restoring the shared focus ring, `bg-input/40` surface and consistent sizing.**

| # | file:line | What's wrong | Proper fix | Conf | Status |
|---|-----------|--------------|-----------|------|--------|
| A1 | [ExportWizard.tsx:163](src/features/export/ExportWizard.tsx#L163) | Bare `<select>` "Report" — `w-full rounded-lg border border-border bg-background p-2 text-sm`; no focus ring, `bg-background` not `bg-input/40`, `p-2` not `h-10 px-3`, no chevron room | Foundry `Select` | High | **done** |
| A2 | [ExportWizard.tsx:188](src/features/export/ExportWizard.tsx#L188) | Bare `<select>` "Scope" — same ad-hoc class | Foundry `Select` | High | **done** |
| A3 | [ExportWizard.tsx:203](src/features/export/ExportWizard.tsx#L203) | Bare `<select>` item-target — same ad-hoc class | Foundry `Select` | High | **done** |
| A4 | [ExportWizard.tsx:219](src/features/export/ExportWizard.tsx#L219) | Bare `<select>` project-target — same ad-hoc class | Foundry `Select` | High | **done** |
| A5 | [SettingsScreen.tsx:305](src/features/settings/SettingsScreen.tsx#L305) | Bare `<input type=number>` copies `fieldClasses` verbatim except `h-9 w-24` | Foundry `Input className="h-9 w-24"` | High | **done** |
| A6 | [SettingsScreen.tsx:323](src/features/settings/SettingsScreen.tsx#L323) | Same duplicated `fieldClasses` number input | Foundry `Input className="h-9 w-24"` | High | **done** |
| A7 | [SettingsScreen.tsx:341](src/features/settings/SettingsScreen.tsx#L341) | Same duplicated `fieldClasses` number input | Foundry `Input className="h-9 w-24"` | High | **done** |
| A8 | [SettingsScreen.tsx:361](src/features/settings/SettingsScreen.tsx#L361) | Same duplicated `fieldClasses` number input | Foundry `Input className="h-9 w-24"` | High | **done** |
| A9 | [SupplierPartFormDialog.tsx:213](src/features/inventory/components/SupplierPartFormDialog.tsx#L213) | Bare `<textarea>` re-implements Foundry `Textarea` classes verbatim | Foundry `Textarea` | High | **done** |
| A10 | [ImportBomDialog.tsx:99](src/features/projects/components/ImportBomDialog.tsx#L99) | Bare `<textarea>` re-implements field classes (adds `h-40 font-mono`) | Foundry `Textarea className="h-40 font-mono"` | Med | **done** |
| A11 | [ReorderTab.tsx:246](src/features/purchasing/ReorderTab.tsx#L246) | Bare `<input type=number>` with a **different** ad-hoc style: `rounded-md` (not `-lg`), `bg-background`, `px-2 py-1`, and `focus:ring-2` (not `focus-visible:` — ring shows on mouse click too) | Foundry `Input` + size override | Med | **done** |

Sub-note (fix alongside A1–A4): ExportWizard's field labels use a one-off
`text-xs uppercase tracking-wide text-muted-foreground` style with a `space-y-2` gap, unlike
the app's standard `text-sm font-medium` + `mb-field-gap`. Bring into line when converting.

---

## Category B — Raw palette colour literals instead of semantic tokens

Hard-coded Tailwind palette classes bypass theming and dark-mode. **Fix: use the semantic
token** (`success`, `warning`, `text-glyph-*`).

**Impact: MEDIUM (dark-mode / theming correctness). Confidence: HIGH.**

| # | file:line | What's wrong | Proper fix | Conf | Status |
|---|-----------|--------------|-----------|------|--------|
| B1 | [SyncScreen.tsx:263](src/features/sync/SyncScreen.tsx#L263) | "Connected/synced" chip `bg-emerald-500/15 text-emerald-400` | `bg-success/15 text-success` (or `text-glyph-success`) | High | pending |
| B2 | [CapabilityEditor.tsx:46](src/features/inventory/components/CapabilityEditor.tsx#L46) | Capability pill `bg-amber-500/15 text-amber-600 dark:text-amber-400` (colour only — **not** the field-gap, which is excluded) | `bg-warning/15 text-warning` | High | pending |
| B3 | [CapabilityEditor.tsx:55](src/features/inventory/components/CapabilityEditor.tsx#L55) | Pill remove-button `hover:bg-amber-500/25` | `hover:bg-warning/25` | High | pending |
| B4 | [ScannerOverlay.tsx:377](src/features/scanner/components/ScannerOverlay.tsx#L377) | Notice text `text-amber-300` | `text-warning` | Med | pending |

**Deliberately NOT flagged in B** (documented exceptions — see "Considered but not flagged"):
the rest of `ScannerOverlay`'s `white`/`black` chrome (camera viewfinder surface over live
video), `modal.tsx` `bg-black/60` scrim, `QrCodeDialog` `bg-white` QR/barcode plate, and all
`#hex` inside the print/label HTML generators (`qr-code.ts`, `code128.ts`, `label-sheet.ts`,
`QrCodeDialog` print `<style>`), which target un-themed printed paper.

---

## Category C — Ad-hoc / inconsistent focus rings

The house focus ring is `focus-visible:ring-[3px] focus-visible:ring-ring/40` (fields) /
`ring-ring/50` (buttons). Several interactive elements instead use `focus-visible:ring-2
focus-visible:ring-primary` (thinner, different colour token) or, worse, `focus:ring-2`
(fires on mouse, not just keyboard). **Fix: adopt the shared `focus-visible:ring-[3px]
ring-ring` pattern** (or move the ring into the primitive where one applies).

**Impact: MEDIUM (a11y focus-indicator consistency). Confidence: MEDIUM.**

| # | file:line | What's wrong | Proper fix | Conf | Status |
|---|-----------|--------------|-----------|------|--------|
| C1 | [ReorderTab.tsx:255](src/features/purchasing/ReorderTab.tsx#L255) | `ring-ring focus:ring-2` — **non-`focus-visible`**, shows on mouse click (folds into A11) | house `focus-visible:ring-[3px] ring-ring/40` | High | **done** (via A11, Phase 1) |
| C2 | [InventoryScreen.tsx:258](src/features/inventory/InventoryScreen.tsx#L258) | Clear-search button `focus-visible:ring-2 focus-visible:ring-primary` | house ring pattern | Med | pending |
| C3 | [CommandPalette.tsx:138](src/features/command-palette/CommandPalette.tsx#L138) | Close button `focus-visible:ring-2 focus-visible:ring-primary` | house ring pattern | Med | pending |
| C4 | [DashboardVersion.tsx:49](src/features/dashboard/DashboardVersion.tsx#L49) | `focus-visible:ring-2 focus-visible:ring-primary` | house ring pattern | Med | pending |
| C5 | [DashboardScreen.tsx:49](src/features/dashboard/DashboardScreen.tsx#L49) | Hero card link `focus-visible:ring-2 focus-visible:ring-primary` | house ring pattern | Med | pending |
| C6 | [DashboardNav.tsx:128](src/features/dashboard/DashboardNav.tsx#L128) | `focus-visible:ring-2 focus-visible:ring-primary` | house ring pattern | Med | pending |
| C7 | [DashboardGrid.tsx:311](src/features/dashboard/DashboardGrid.tsx#L311) | `focus:outline-none focus-visible:ring-2 focus-visible:ring-primary` | house ring pattern | Med | pending |
| C8 | [ItemDetailDialog.tsx:118](src/features/inventory/components/ItemDetailDialog.tsx#L118) | Tab `focus-visible:ring-2 focus-visible:ring-ring` (ring-2 vs [3px]) | house ring pattern | Low | pending |
| C9 | [LocationInlineRename.tsx:54](src/features/inventory/components/LocationInlineRename.tsx#L54) | `focus-visible:ring-2 focus-visible:ring-primary/60` on ad-hoc inline input | house ring pattern | Low | pending |
| C10 | [ColorSwatchPicker.tsx:93](src/features/inventory/components/ColorSwatchPicker.tsx#L93) / [LocationKindPicker.tsx:90](src/features/inventory/components/LocationKindPicker.tsx#L90) | Swatch/kind radios roll their own focus treatment | reconcile with house ring | Low | pending |

> Verify during the fix: some of these sit on non-field elements (cards, tabs, swatches)
> where `ring-primary` may be an intentional accent. Keep the **width/`focus-visible`**
> consistent even if the colour token legitimately differs; don't force cosmetic churn.

---

## Category D — Off-grid control sizing (`h-9`)

Foundry offers `h-8` (sm) / `h-10` (default) / `h-11` (lg); `Input` is fixed `h-10`. A
recurring `h-9` (via `className`) sits off that grid. Some are a deliberate "compact control
row" (Settings), so this is partly a **convention** question: either accept `h-9` as the
compact tier by adding a Foundry `size` for it, or normalise to `h-8`/`h-10`.

**Impact: LOW (cosmetic consistency). Confidence: LOW–MED (some are intentional).**

| # | file:line | Note | Status |
|---|-----------|------|--------|
| D1 | [SettingsScreen.tsx](src/features/settings/SettingsScreen.tsx) (`h-9` ~14×) | Deliberate compact settings tier — candidate for a Foundry compact `size` | pending |
| D2 | [ImportDataDialog.tsx:383](src/features/inventory/components/ImportDataDialog.tsx#L383), [:409](src/features/inventory/components/ImportDataDialog.tsx#L409) | `h-9` Buttons | pending |
| D3 | [TextQueryInput.tsx:71](src/features/search/components/TextQueryInput.tsx#L71) / [ConditionEditor.tsx:74](src/features/search/components/ConditionEditor.tsx#L74) | `h-9` controls | pending |
| D4 | [CapabilityEditor.tsx:86](src/features/inventory/components/CapabilityEditor.tsx#L86) (and 102/122/125) | `h-9` controls (sizing only — field-gap excluded) | pending |

> Resolve the convention first (add a compact `size` vs normalise). This phase may end as a
> deliberate "no-change, documented" outcome — that is an acceptable resolution.

---

## Category E — Internal design-system easing repetition (`index.css`)

The `--ease-emphasized` token exists expressly so the signature curve isn't repeated as a
raw string (its own comment: *"instead of repeating the raw cubic-bezier string"*). Yet four
`@utility` animation helpers still inline `cubic-bezier(0.16, 1, 0.3, 1)`.

**Impact: LOW (no visual change — pure consistency). Confidence: HIGH. One file.**

| # | file:line | What's wrong | Proper fix | Conf | Status |
|---|-----------|--------------|-----------|------|--------|
| E1 | [index.css:570](src/styles/index.css#L570) | `animate-zoom-in` inlines the raw curve | `var(--ease-emphasized)` | High | pending |
| E2 | [index.css:574](src/styles/index.css#L574) | `animate-rise` inlines the raw curve | `var(--ease-emphasized)` | High | pending |
| E3 | [index.css:578](src/styles/index.css#L578) | `animate-swap-in` inlines the raw curve | `var(--ease-emphasized)` | High | pending |
| E4 | [index.css:590](src/styles/index.css#L590) | `animate-toast-out` inlines the raw curve | `var(--ease-emphasized)` | High | pending |

> The `--ease-emphasized` var is defined inside `@theme inline` (a Tailwind-compiled block);
> confirm it resolves inside these `@utility` rules at build time before committing, or hoist
> the raw curve to a plain `:root` custom property both can share. **Verify via
> `npm run build` + grep the built CSS.**

---

## Considered but NOT flagged (legitimate / idiomatic — recorded for discipline)

- **Manual `<label className="block"><span className="mb-field-gap block">…</span><control/>`**
  (CheckoutDialog, BookingsScreen, AddBomLineDialog, etc.) — the *correct* field-gap pattern,
  used where a `datalist`/helper span/custom control makes `FormField`'s single-child clone a
  poor fit. Correct.
- **Print / label HTML generators** (`qr-code.ts`, `code128.ts`, `label-sheet.ts`,
  `QrCodeDialog` print `<style>`) using `#000`/`#fff`/`#555`/`#ddd` — output is un-themed
  printed paper, always black-on-white. Not themable; correct.
- **QR/barcode plate `bg-white`** (`QrCodeDialog`) — a code must sit on white to scan in either
  theme. Correct.
- **`modal.tsx` `bg-black/60` scrim** — a dimming overlay, not a themed surface; idiomatic.
- **`ScannerOverlay` white/black chrome** — full-screen camera viewfinder over live video; a
  deliberate dark-on-camera surface (only the `text-amber-300` notice, B4, uses a token).
- **APG interactive rows** (`role="tree"/"option"/"tab"/"radio"` on `div`/`span` with roving
  tabindex + `onKeyDown`, each with a justified `eslint-disable`) — LocationTreeItem,
  LocationSelect, ItemDetailDialog tabs, segmented toggles. Correct, accessible.
- **Dynamic `style={{ width/height/transform }}`** — bar fills, gauges, virtualiser offsets,
  Starfield vars: runtime values that can't be utilities. Correct.
- **`<header>` in `DashboardScreen`** (sanctioned Dashboard-hero exception) and
  **`ProjectDetail`** (a sub-detail pane, not a top-level screen needing `PageHeader`/nav).
- All 15 screens carry `MAIN_CONTENT_ID` + skip-link; 14 use `PageHeader`. No missing-`main`
  or hand-rolled-cross-nav findings.

---

## Phase plan

Ordered by impact × confidence. One category per session; review gate after each.

| Phase | Category | Findings | Rationale for order | Status |
|-------|----------|----------|--------------------|--------|
| 1 | **A** — hand-rolled controls → Foundry | A1–A11 (11) | Highest: user-visible + restores focus ring/theming; clear correct fix | **done ✅** (also closes C1) |
| 2 | **B** — raw palette colour → tokens | B1–B4 (4) | Dark-mode/theming correctness; small & unambiguous | pending |
| 3 | **C** — focus-ring consistency | C1–C10 (~11) | a11y focus-indicator consistency; some judgment per element | pending |
| 4 | **D** — off-grid `h-9` sizing | D1–D4 | Convention decision first; may end "documented no-change" | pending |
| 5 | **E** — CSS easing token | E1–E4 (4) | Trivial one-file cleanup; needs build-CSS verification | pending |

> C11 fix (A11/C1 overlap): ReorderTab's number input appears in both A and C — fix once in
> Phase 1 (the whole control moves to Foundry `Input`, which resolves the focus ring too);
> mark C1 `done` at that point.

**Effort status:** Phase 1 (Category A) complete — all 11 findings fixed (A11 also closes
C1); `tsc`, `eslint`, `prettier` and the full 1981-test suite pass. Awaiting review/approval
before Phase 2 (Category B).
