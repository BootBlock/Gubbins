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
**Status: DONE ✅ — all 4 findings fixed in Phase 2. The emerald/amber palette literals now
use the theme-aware `success` / `warning` tokens (`bg-success/15 text-success`,
`bg-warning/15 text-warning`, `text-warning`), so they track light/dark correctly; the `dark:`
override on B2 is dropped (the token is already theme-aware). `--warning` is a light amber
(L≈0.7–0.8) in both themes, so B4 stays legible over the fixed-dark camera overlay.**

| # | file:line | What's wrong | Proper fix | Conf | Status |
|---|-----------|--------------|-----------|------|--------|
| B1 | [SyncScreen.tsx](src/features/sync/SyncScreen.tsx) | "Connected/synced" chip `bg-emerald-500/15 text-emerald-400` | `bg-success/15 text-success` | High | **done** |
| B2 | [CapabilityEditor.tsx](src/features/inventory/components/CapabilityEditor.tsx) | Capability pill `bg-amber-500/15 text-amber-600 dark:text-amber-400` (colour only — **not** the field-gap, which is excluded) | `bg-warning/15 text-warning` | High | **done** |
| B3 | [CapabilityEditor.tsx](src/features/inventory/components/CapabilityEditor.tsx) | Pill remove-button `hover:bg-amber-500/25` | `hover:bg-warning/25` | High | **done** |
| B4 | [ScannerOverlay.tsx](src/features/scanner/components/ScannerOverlay.tsx) | Notice text `text-amber-300` | `text-warning` | Med | **done** |

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
**Status: DONE ✅ — C2–C10 fixed in Phase 3 (C1 was already closed via A11 in Phase 1).**
**Key finding that made this safe: `--ring` and `--primary` are the *identical* oklch value in
both themes, so switching `ring-primary → ring-ring` is a zero-colour-change normalisation —
only the width (`ring-2 → ring-[3px]`) and `focus:` → `focus-visible:` actually change. The
house widths were applied per element role: button-like controls + card links → `ring-ring/50`,
the inline-rename field → `ring-ring/40`, and the swatch/kind radios kept their existing
`ring-ring` + offset (their `checked` selection ring is a separate indicator, left untouched).**

| # | file:line | What's wrong | Proper fix | Conf | Status |
|---|-----------|--------------|-----------|------|--------|
| C1 | [ReorderTab.tsx](src/features/purchasing/ReorderTab.tsx) | `ring-ring focus:ring-2` — **non-`focus-visible`**, shows on mouse click (folds into A11) | house `focus-visible:ring-[3px] ring-ring/40` | High | **done** (via A11, Phase 1) |
| C2 | [InventoryScreen.tsx](src/features/inventory/InventoryScreen.tsx) | Clear-search button `focus-visible:ring-2 focus-visible:ring-primary` | `focus-visible:ring-[3px] ring-ring/50` | Med | **done** |
| C3 | [CommandPalette.tsx](src/features/command-palette/CommandPalette.tsx) | Close button `focus-visible:ring-2 focus-visible:ring-primary` | `focus-visible:ring-[3px] ring-ring/50` | Med | **done** |
| C4 | [DashboardVersion.tsx](src/features/dashboard/DashboardVersion.tsx) | `focus-visible:ring-2 focus-visible:ring-primary` | `focus-visible:ring-[3px] ring-ring/50` | Med | **done** |
| C5 | [DashboardScreen.tsx](src/features/dashboard/DashboardScreen.tsx) | Hero card link `focus-visible:ring-2 focus-visible:ring-primary` | `focus-visible:ring-[3px] ring-ring/50` | Med | **done** |
| C6 | [DashboardNav.tsx](src/features/dashboard/DashboardNav.tsx) | `focus-visible:ring-2 focus-visible:ring-primary` | `focus-visible:ring-[3px] ring-ring/50` | Med | **done** |
| C7 | [DashboardGrid.tsx](src/features/dashboard/DashboardGrid.tsx) | `focus:outline-none focus-visible:ring-2 focus-visible:ring-primary` | `focus-visible:ring-[3px] ring-ring/50` | Med | **done** |
| C8 | [ItemDetailDialog.tsx](src/features/inventory/components/ItemDetailDialog.tsx) | Tab `focus-visible:ring-2 focus-visible:ring-ring` (ring-2 vs [3px]) | `focus-visible:ring-[3px] ring-ring/50` | Low | **done** |
| C9 | [LocationInlineRename.tsx](src/features/inventory/components/LocationInlineRename.tsx) | `focus-visible:ring-2 focus-visible:ring-primary/60` on ad-hoc inline input | `focus-visible:ring-[3px] ring-ring/40` (field) | Low | **done** |
| C10 | [ColorSwatchPicker.tsx](src/features/inventory/components/ColorSwatchPicker.tsx) / [LocationKindPicker.tsx](src/features/inventory/components/LocationKindPicker.tsx) | Swatch/kind radios roll their own focus treatment | `ring-2 → ring-[3px]` (keep `ring-ring` + offset; leave the `checked` selection ring) | Low | **done** |

> Note honoured during the fix: because `ring` and `primary` resolve to the same colour, there
> was no real accent to preserve — the width/`focus-visible` normalisation was applied without
> any colour churn. The swatch/kind pickers' `checked` selection rings (a separate visual
> signal) were deliberately left as-is.

---

## Category D — Off-grid control sizing (`h-9`)

Foundry offers `h-8` (sm) / `h-10` (default) / `h-11` (lg); `Input` is fixed `h-10`. A
recurring `h-9` (via `className`) sits off that grid. Some are a deliberate "compact control
row" (Settings), so this is partly a **convention** question: either accept `h-9` as the
compact tier by adding a Foundry `size` for it, or normalise to `h-8`/`h-10`.

**Impact: LOW (cosmetic consistency). Confidence: LOW–MED (some are intentional).**
**Status: RESOLVED ✅ — Phase 4 outcome is a deliberate, documented NO-CHANGE (the sanctioned
resolution below). `h-9` (2.25rem) is accepted as the app's intentional *compact* control tier,
used consistently for dense rows (Settings, the search `ConditionEditor`/`TextQueryInput`, the
`CapabilityEditor`, `ImportDataDialog`). Decision rationale:**

- **Codifying it as a Foundry `size` was considered and rejected as disproportionate.** `Input`
  and `Select` have **no `size` system at all** (both are a fixed `h-10 fieldClasses` string),
  and `Button`'s sizes are `sm=h-8 / default=h-10 / lg=h-11` with no `h-9`. Introducing a size
  API to `Input` + `Select` and a new compact tier to `Button`, then migrating ~34 call sites,
  is a broad, regression-prone primitive change for a **LOW-impact cosmetic** nit.
- **Normalising `h-9 → h-8`/`h-10` was rejected as cosmetic churn against intent** — it would
  change the deliberate density of Settings and the dense editors.
- The `h-9` usage is already internally consistent, so it does not read as drift in practice.

**If a future phase adds a genuine `size` system to the field primitives for another reason, fold
this compact tier in then (revisit `size="compact"`); until then, `h-9` stays as-is by design.**

| # | file:line | Note | Status |
|---|-----------|------|--------|
| D1 | [SettingsScreen.tsx](src/features/settings/SettingsScreen.tsx) (`h-9` ~19×) | Deliberate compact settings tier — accepted as-is | **no-change (documented)** |
| D2 | [ImportDataDialog.tsx](src/features/inventory/components/ImportDataDialog.tsx) | `h-9` Buttons | **no-change (documented)** |
| D3 | [TextQueryInput.tsx](src/features/search/components/TextQueryInput.tsx) / [ConditionEditor.tsx](src/features/search/components/ConditionEditor.tsx) | `h-9` controls | **no-change (documented)** |
| D4 | [CapabilityEditor.tsx](src/features/inventory/components/CapabilityEditor.tsx) | `h-9` controls (sizing only — field-gap excluded) | **no-change (documented)** |

> Resolved: deliberate documented no-change (the explicitly-sanctioned outcome). Codifying a
> compact Foundry `size` is out of scope for this LOW-impact item — the field primitives have no
> size system to extend cleanly, so it is not worth the app-wide risk now.

---

## Category E — Internal design-system easing repetition (`index.css`)

The `--ease-emphasized` token exists expressly so the signature curve isn't repeated as a
raw string (its own comment: *"instead of repeating the raw cubic-bezier string"*). Yet four
`@utility` animation helpers still inline `cubic-bezier(0.16, 1, 0.3, 1)`.

**Impact: LOW (no visual change — pure consistency). Confidence: HIGH. One file.**
**Status: DONE ✅ — all 4 fixed in Phase 5. The `animate-zoom-in` / `animate-rise` /
`animate-swap-in` / `animate-toast-out` `@utility` rules now use `var(--ease-emphasized)` like
their `animate-slide-in-*` / `animate-highlight` siblings already did — which is itself the
proof the var resolves inside these `@utility` rules. Verified in the built CSS: the compiled
`gubbins-zoom-in` utility emits `var(--ease-emphasized)` (not the raw curve), and the only
remaining `cubic-bezier(.16,1,.3,1)` in the sheet is the single token definition.**

| # | file:line | What's wrong | Proper fix | Conf | Status |
|---|-----------|--------------|-----------|------|--------|
| E1 | [index.css](src/styles/index.css) | `animate-zoom-in` inlines the raw curve | `var(--ease-emphasized)` | High | **done** |
| E2 | [index.css](src/styles/index.css) | `animate-rise` inlines the raw curve | `var(--ease-emphasized)` | High | **done** |
| E3 | [index.css](src/styles/index.css) | `animate-swap-in` inlines the raw curve | `var(--ease-emphasized)` | High | **done** |
| E4 | [index.css](src/styles/index.css) | `animate-toast-out` inlines the raw curve | `var(--ease-emphasized)` | High | **done** |

> Resolved: the var resolves inside `@utility` rules (the sibling `animate-slide-in-*` helpers
> already relied on it), confirmed by grepping the built CSS after `npm run build`.

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
| 2 | **B** — raw palette colour → tokens | B1–B4 (4) | Dark-mode/theming correctness; small & unambiguous | **done ✅** |
| 3 | **C** — focus-ring consistency | C1–C10 (~11) | a11y focus-indicator consistency; some judgment per element | **done ✅** |
| 4 | **D** — off-grid `h-9` sizing | D1–D4 | Convention decision first; may end "documented no-change" | **done ✅ (documented no-change)** |
| 5 | **E** — CSS easing token | E1–E4 (4) | Trivial one-file cleanup; needs build-CSS verification | **done ✅** |

> C11 fix (A11/C1 overlap): ReorderTab's number input appears in both A and C — fix once in
> Phase 1 (the whole control moves to Foundry `Input`, which resolves the focus ring too);
> mark C1 `done` at that point.

**Effort status: COMPLETE ✅ — all five categories resolved.** Phase 1 (A) landed earlier;
Phases 2–5 (B, C, D, E) were done together in one follow-up pass: B (palette→tokens) and C
(focus-ring width/`focus-visible` normalisation, zero colour change since `ring`≡`primary`) and
E (easing token) are code fixes; D is a deliberate documented no-change (compact `h-9` tier
accepted). Checks: `tsc -b` clean, `eslint` clean (one pre-existing unrelated
`react-refresh` warning in ItemDetailDialog), the full **2445**-test suite passes, `npm run
build` succeeds, and the built CSS was grepped to confirm the token utilities
(`bg/text-success`, `bg/text-warning`, `ring-[3px]`) and the `var(--ease-emphasized)` easing all
emit. **Every finding is now `done` — per the doc header, move this file to
`docs/todo/done/ui-bodge-audit.md`.**
