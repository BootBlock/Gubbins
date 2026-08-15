/**
 * The one way to ask "does a row already hold this name?" for a natural key the app enforces
 * uniqueness on (issue #679).
 *
 * Seven tables identify a row by a human-typed name and carry a `UNIQUE (… COLLATE NOCASE)`
 * index over it. **That collation folds ASCII A–Z and nothing else** — `Café` and `CAFÉ` are
 * distinct keys to the index, which happily accepts both — so the index alone cannot be the
 * answer; see `lib/name-fold` for why widening the collation is not available on any driver
 * this app runs on. The verdict has to come from `foldName`, in JS, on every write path that
 * could mint a second spelling.
 *
 * The sync merge's natural-key resolution (`features/sync/unique-keys.ts`) already reaches its
 * verdict that way. A write path that does not agree with it is not merely a papercut: the
 * resolver plans a merge around two rows it believes are one, and the plan then trips the very
 * `UNIQUE` index it exists to route around — which aborts the whole atomic merge and, because
 * the watermark never advances, leaves sync recomputing the identical failing plan forever.
 *
 * **The SQL narrows; JS decides.** Binding folded needles to `LOWER(col) = ?` reads like one
 * comparison but is two different ones, and the mismatch is exactly where the duplicates get in.
 * So {@link foldedNameFilter} builds a deliberate *superset* of the answer, in two parts:
 *
 * - A stored name SQLite *can* fold is pure printable ASCII, and `LOWER(TRIM(…))` is then exactly
 *   its folded key — no printable ASCII character folds differently under `foldName` — so the
 *   folded needles find it. The `TRIM` is not decoration: every write path trims, but that is an
 *   assumption about six repositories rather than a guarantee, and a stray `'Bob '` would
 *   otherwise be invisible to both arms (a space is *inside* the `GLOB`'s accepted range).
 * - A stored name SQLite *cannot* fold holds a character outside printable ASCII, which the
 *   `GLOB` picks out wholesale — including every whitespace character `String.trim` strips but
 *   SQLite's `TRIM` does not. That is the only place the two folds can disagree.
 *
 * The caller then filters the narrowed rows through {@link matchesFoldedName}. Reading the table
 * whole would also work and is what the (much smaller) field dictionary does; this keeps a
 * dictionary of plain-ASCII rows to the ones actually asked about.
 *
 * The cost is honest and worth naming: the `GLOB` arm is not indexable, so the read is a scan of
 * a table the old `= ? COLLATE NOCASE` could seek. Every table this is used on is a dictionary
 * bounded by what a person has typed, and the alternative — a stored fold column with its own
 * index, as `suppliers.name_key` has — is a schema change on five tables. If one of these ever
 * outgrows a scan, that is the lever, not a narrower fold.
 *
 * Callers order their query so the answer is **stable**. A database written before this fold
 * existed can already hold both `Größe` and `GRÖSSE`, and which of the two an unordered read
 * happened to return first must not decide which row a name joins.
 */
import { DbError } from '../errors';
import { foldName } from '@/lib/name-fold';

/** A narrowing predicate for a folded natural-key lookup, with the verdict it is narrowing for. */
export interface FoldedNameFilter {
  /** A `WHERE` fragment matching a superset of the rows whose column folds to a wanted key. */
  readonly sql: string;
  /** The parameters to bind for {@link sql}, in order. */
  readonly params: string[];
  /** The folded keys actually being asked about. */
  readonly wanted: ReadonlySet<string>;
}

/**
 * Narrow `column` to a superset of the rows whose value folds to one of `names`.
 *
 * `column` is always a literal written at the call site — never user input — because it is
 * spliced into the SQL rather than bound.
 */
export function foldedNameFilter(column: string, names: readonly string[]): FoldedNameFilter {
  const wanted = new Set(names.map(foldName));
  const needles = [...wanted];
  if (needles.length === 0) {
    // `IN ()` is not portable SQL, and no name can match nothing anyway — say so explicitly
    // rather than emitting a predicate whose meaning depends on the engine.
    return { sql: '0', params: [], wanted };
  }
  const placeholders = needles.map(() => '?').join(', ');
  return {
    sql: `(LOWER(TRIM(${column})) IN (${placeholders}) OR ${column} GLOB '*[^ -~]*')`,
    params: needles,
    wanted,
  };
}

/** Whether `value` is genuinely one of the names `filter` was built for. */
export function matchesFoldedName(filter: FoldedNameFilter, value: string): boolean {
  return filter.wanted.has(foldName(value));
}

/**
 * The rejection for a name a folded lookup found already taken, phrased exactly as SQLite
 * phrases it for the same index.
 *
 * A write path that folds catches duplicates the `COLLATE NOCASE` index misses, so it has to
 * raise the refusal itself — and reusing SQLite's own wording is what makes that refusal
 * legible: `features/errors/db-error-message` reads the `table.column` out of exactly this text
 * to say "That contact name is already in use" rather than a generic sentence. Authoring a
 * second wording would put copy outside the catalogs for no gain.
 *
 * This does **not** guarantee the two refusals read identically. The humanisation is gated on
 * `DbError.code`, and `code` comes from a numeric `resultCode` that only `sqlite-wasm` supplies
 * — a genuine constraint violation raised by `node:sqlite` (the bridge and the test driver)
 * arrives as `SQLITE_ERROR` and degrades to the call site's fallback copy. The error built here
 * carries the code the layer needs, so the *folded* refusal is the one that reliably reads well.
 * Closing that gap belongs in `db/errors`, not here.
 *
 * @param qualifiedColumn the `table.column` the index is on, as SQLite names it.
 */
export function duplicateNameError(qualifiedColumn: string): DbError {
  return new DbError('SQLITE_CONSTRAINT', `UNIQUE constraint failed: ${qualifiedColumn}`);
}
