# Label customisation — Phase 73 (living plan + outcome)

The second feature-gap audit (`feature-gap-audit-2026-06-30b`, candidate #7) flagged **label
customisation** as a prosumer gap: Gubbins printed only fixed QR-plus-name label sheets
(Phase 49 `qr-label-sheet.ts`). Three sub-gaps: **multi-symbology** (add a 1-D Code 128
barcode), **custom label templates** (configurable fields/layout), and **location labels**
(printable, scannable labels for bins/shelves). Advanced analytics (audit #6) remains the only
other parked candidate after this.

## Decisions (confirmed with the developer, 2026-06-30)

- **Template depth:** a *configurable* template — symbology + which text fields show + columns
  — not a freeform drag/drop designer. Persisted as a **device-local Tier-2 preference**
  (label layout is a printer/paper concern, never synced), seeded into an editable working
  copy per print job, with "Save as default".
- **Barcode value:** the item's **MPN/SKU**, sanitised to encodable ASCII, falling back to a
  short id (first UUID group, upper-cased). The QR keeps the full deep-link.
- **Location labels:** **printable + scannable** — the QR/barcode deep-links
  `…/#/inventory?location=<id>`, and the in-app scanner recognises a location code and selects
  that location.
- **No migration** — `user_version` stays **1**. Nothing here touches the schema.

## What shipped

New pure core under `src/features/inventory/labels/`:

- **`code128.ts`** — hand-rolled, dependency-free **Code 128 encoder** (§2.4.3 native/no-bloat,
  mirrors `qr-code.ts`): full 107-symbol table, Code-B + Code-C auto-switching, mod-103
  checksum, quiet zones → `code128Svg`. The app already *decodes* Code 128 (zxing), so printed
  barcodes round-trip through Gubbins' own scanner. (16 unit tests; "CODE128" checksum = 26.)
- **`label-template.ts`** — `LabelTemplate` model (`symbology` qr/barcode/both/none, field
  flags, `columns` 1–4, `showText`), `DEFAULT_LABEL_TEMPLATE`, defensive `normaliseLabelTemplate`,
  and `labelBarcodeValue` (MPN→shortId, ASCII-sanitised).
- **`label-sheet.ts`** — generalises the Phase-49 sheet: `toLabelCells`/`buildLabelSheetHtml`
  honouring the template, plus a shared `resolveCell`/`LabelSpec` seam so items and locations
  render identically. (Old `qr-label-sheet.ts` removed; the 2 callers migrated.)
- **`location-label.ts`** — `toLocationLabelCell`/`buildLocationLabelHtml` (+ a cycle-safe
  `locationPath` ancestor helper and a copies count) reusing `resolveCell`.

Preferences & deep-links:

- `usePreferencesStore.labelTemplate` (+ `setLabelTemplate`, normalised, persisted).
- `LOCATION_QR_PARAM`, `buildLocationQrUrl`, and a tagged `parseScannedCode(raw)` union
  (`item` | `location`); `parseScannedItemId` kept as a thin wrapper. Bare UUID → item
  (back-compat); the two params are disjoint so the kinds never collide.

UI:

- **`PrintLabelsDialog`** rebuilt — symbology / field / columns controls over a working copy,
  live preview (shared `LabelCellPreview`), "Save as default". Raw amber/slate colours replaced
  with design tokens (`Banner tone="warning"`, `bg-card`, `text-foreground`, …).
- **`QrCodeDialog`** — per-item symbology toggle (QR / barcode / both); barcode of the MPN.
- **`PrintLocationLabelDialog`** + a per-row "Print label" action in the `LocationSidebar`
  (co-located like Edit/Delete); symbology, copies, columns, optional full path.
- **`ScannerOverlay`** gains `onLocationScanned`; a scanned location label validates against the
  loaded list, then `InventoryScreen` selects the location and closes the scanner.

`LabelItem` enriched with `mpn`/`locationName`/`quantity`, captured into the inventory
multi-select at toggle time (survives the bounded virtualised-list window).

## Verification

- `tsc -p tsconfig.app.json --noEmit` clean.
- **1637 unit tests / 142 files** green (+70 over the 1567 baseline; new: code128 16,
  label-template, label-sheet, location-label, scan-payload location, PrintLabelsDialog).
- `npm run build` clean (precache 3303 KiB, informational — no budget since Phase 44).
- Browser-smoke updated: "Item label" dialog/button rename, a barcode-symbology assertion in
  the print step, and a new location-label print step.

## Deferred (tracked, not dropped)

- **Custom label *sizes* (Avery presets / mm dimensions).** Columns are configurable; exact
  paper presets are a Backlog item (trigger: a request for a specific label stock).
- **Web push / background alerts** stay parked (no backend) — unrelated, noted for completeness.

No continuation. **Advanced analytics (ABC/turnover/aging)** is now the sole remaining candidate
from the second feature-gap audit.
