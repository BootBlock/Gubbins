import type { Migration } from './migration';

/**
 * v19 — Location description & colour (Phase 54).
 *
 * Two additive, **nullable** columns on `locations`, both primarily for the user's own
 * reference (spec §4 locations):
 *
 *  - `description` — free text describing the location ("Top shelf, behind the lathe").
 *  - `color` — a semantic *swatch key* (e.g. `'rose'`, `'teal'`), NOT a raw colour
 *    literal. The key maps to a themed design token (`text-loc-<key>`) so the rendered
 *    tint is dark-/light-mode correct in one place; an unknown/NULL key falls back to
 *    the standard text colour. Storing the key (not a hex) keeps the palette themable
 *    and re-skinnable without a data migration.
 *
 * Both are NULL by default, so every pre-v19 row reads correctly with no backfill. They
 * SHOULD sync (a location's description/colour is shared state, not device-local), so
 * they are deliberately left out of `SYNC_EXCLUDED_COLUMNS`; `locations` is already in
 * `SYNC_TABLES` and the LWW schema dictionary reads columns live via `PRAGMA
 * table_info`, so both round-trip with no further registration. A nullable `ADD COLUMN`
 * needs no §2.3.3 table recreation, and neither column is a foreign key — so there is no
 * `FK_REFS` entry and no location-delete/`applyPlan` null-out.
 */
export const v19LocationDescriptionColor: Migration = {
  version: 19,
  name: 'location-description-color',
  statements: [
    { sql: `ALTER TABLE locations ADD COLUMN description TEXT;` },
    { sql: `ALTER TABLE locations ADD COLUMN color TEXT;` },
  ],
};
