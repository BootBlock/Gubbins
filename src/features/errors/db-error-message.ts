/**
 * Humanising layer for database failures (issue #311).
 *
 * `DbError` carries the *unmodified* SQLite message (`DbError.fromUnknown` takes `error.message`
 * verbatim), so without a layer here the user reads `UNIQUE constraint failed: items.sku` in a
 * `role="alert"` — and, worse, genuinely actionable conditions like `SQLITE_FULL` and
 * `WRITE_SUSPENDED` surface as unexplained jargon. Everything needed to write a real sentence is
 * already on the error: the stable `code`, and for the constraint family the offending column.
 *
 * This module is **pure** and catalog-free — it resolves an error to a *message key* (plus vars),
 * never to text. `useErrorMessage` binds it to `t()`. That keeps the classification exhaustively
 * unit-testable and keeps the copy in the catalogs where the i18n rule requires it, rather than
 * outside them "by construction".
 *
 * The one subtlety is **precedence**. Repositories legitimately throw `DbError` with an *authored*
 * sentence under a constraint code (`AttachmentRepository.validateValue` → "Enter a valid URL
 * (http or https)."), so blindly humanising by code would clobber better copy. The rule:
 *
 *  - **Environmental** codes (storage full, read-only, busy, schema, OPFS…) are never authored by
 *    our own code, so they always humanise.
 *  - **Constraint** codes humanise only when the message actually *looks* like raw SQLite text
 *    ({@link isRawSqliteMessage}); an authored sentence is kept as-is.
 */
import { DbError, type DbErrorCode } from '@/db/errors';

/** A resolved humanisation: a catalog key, plus any interpolation vars it needs. */
export interface DbErrorDescription {
  /** Catalog key for the sentence shown to the user. */
  readonly key: string;
  /** Catalog key for the `{field}` noun, where the message names one. */
  readonly fieldKey?: string;
}

/**
 * Codes that can only come from the environment (storage, browser, schema), never from a
 * repository's own `throw new DbError(...)`. Their raw text is always jargon, so these humanise
 * unconditionally — this is the half of the issue where the *inverse* problem bites: `SQLITE_FULL`
 * and `WRITE_SUSPENDED` are highly actionable, and the user currently gets none of that.
 */
const ENVIRONMENTAL_MESSAGES: Partial<Record<DbErrorCode, string>> = {
  SQLITE_BUSY: 'db.error.busy',
  SQLITE_LOCKED: 'db.error.busy',
  SQLITE_FULL: 'db.error.full',
  SQLITE_READONLY: 'db.error.readOnly',
  WRITE_SUSPENDED: 'db.error.writeSuspended',
  MULTI_TAB_LOCKED: 'db.error.multiTab',
  OPFS_UNAVAILABLE: 'db.error.opfsUnavailable',
  NOT_CROSS_ORIGIN_ISOLATED: 'db.error.notIsolated',
  SCHEMA_TOO_NEW: 'db.error.schemaTooNew',
  SCHEMA_STALE: 'db.error.schemaStale',
  FTS5_UNAVAILABLE: 'db.error.ftsUnavailable',
  WORKER_UNAVAILABLE: 'db.error.workerUnavailable',
  WORKER_TIMEOUT: 'db.error.workerTimeout',
};

/**
 * Field nouns keyed by the `table.column` SQLite reports — the seven single-column UNIQUE indexes
 * in the schema, which are the violations a user can actually act on. Deliberately a **closed** map
 * resolving to catalog keys rather than a snake_case-to-words transform: `suppliers.name_key` would
 * read as "name key", which is the same jargon leak in a thinner disguise, and a raw column name
 * could never be translated. An unmapped column falls through to the generic sentence, which stays
 * true whatever the column was.
 */
const FIELD_KEYS: Record<string, string> = {
  'tags.name': 'db.field.tagName',
  'contacts.name': 'db.field.contactName',
  'suppliers.name_key': 'db.field.supplierName',
  'field_defs.name': 'db.field.fieldName',
  'roles.name': 'db.field.roleName',
  'users.username': 'db.field.username',
  'item_aliases.alias': 'db.field.alias',
};

/**
 * Fragments that only ever appear in SQLite's own diagnostics. Used to tell a raw message apart
 * from an authored sentence, so humanising a constraint failure never overwrites better copy.
 *
 * @internal Exported for unit tests only.
 */
export const RAW_SQLITE_MARKERS: readonly string[] = [
  'constraint failed',
  'no such table',
  'no such column',
  'database or disk is full',
  'attempt to write a readonly database',
  'database is locked',
  'disk i/o error',
  'database disk image is malformed',
  'datatype mismatch',
  'sqlite_',
];

/**
 * True when `message` reads as raw SQLite output rather than a sentence someone wrote for a user.
 * Substring matching on the fixed diagnostic phrasings above; an empty message counts as raw,
 * since there is nothing better to show than the caller's fallback.
 */
export function isRawSqliteMessage(message: string): boolean {
  const text = message.trim().toLowerCase();
  if (text.length === 0) return true;
  return RAW_SQLITE_MARKERS.some((marker) => text.includes(marker));
}

/** `UNIQUE constraint failed: items.sku, items.name` → `['items.sku', 'items.name']`. */
function parseConstraintColumns(message: string, kind: string): readonly string[] {
  const match = new RegExp(`${kind} constraint failed:\\s*(.+)`, 'i').exec(message);
  if (!match?.[1]) return [];
  return match[1]
    .split(',')
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part.length > 0);
}

/**
 * Resolve the constraint-family sentence from the raw SQLite text. A single-column UNIQUE
 * violation with a known field gets the specific "that {field} is already in use"; everything else
 * degrades to a generic-but-accurate sentence rather than guessing.
 */
function describeConstraint(message: string): DbErrorDescription {
  const unique = parseConstraintColumns(message, 'UNIQUE');
  if (unique.length > 0) {
    const fieldKey = unique.length === 1 && unique[0] ? FIELD_KEYS[unique[0]] : undefined;
    return fieldKey ? { key: 'db.error.uniqueField', fieldKey } : { key: 'db.error.unique' };
  }

  const notNull = parseConstraintColumns(message, 'NOT NULL');
  if (notNull.length > 0) {
    const fieldKey = notNull.length === 1 && notNull[0] ? FIELD_KEYS[notNull[0]] : undefined;
    return fieldKey ? { key: 'db.error.notNullField', fieldKey } : { key: 'db.error.notNull' };
  }

  if (/CHECK constraint failed/i.test(message)) return { key: 'db.error.check' };
  // A foreign-key failure does not always arrive as the extended code: `mapResultCode` only yields
  // SQLITE_CONSTRAINT_FOREIGNKEY for the extended 787, so a driver reporting the primary code 19
  // lands here instead. The text still identifies it, and it deserves the specific sentence.
  if (/FOREIGN KEY constraint failed/i.test(message)) return { key: 'db.error.foreignKey' };
  return { key: 'db.error.constraint' };
}

/**
 * Describe `error` as a message key, or `undefined` when nothing better than the call site's own
 * fallback can be said. Returning `undefined` (rather than a catch-all sentence) is what lets the
 * caller keep its written, context-specific copy — "Could not check the item back in." beats any
 * generic database wording.
 */
export function describeDbError(error: unknown): DbErrorDescription | undefined {
  if (!(error instanceof DbError)) return undefined;

  const environmental = ENVIRONMENTAL_MESSAGES[error.code];
  if (environmental) return { key: environmental };

  const isConstraint = error.code === 'SQLITE_CONSTRAINT' || error.code === 'SQLITE_CONSTRAINT_FOREIGNKEY';

  // An authored sentence under a constraint code is better copy than anything we could derive.
  if (isConstraint && !isRawSqliteMessage(error.message)) return undefined;

  if (error.code === 'SQLITE_CONSTRAINT_FOREIGNKEY') return { key: 'db.error.foreignKey' };
  if (isConstraint) return describeConstraint(error.message);

  // SQLITE_ERROR / INIT_FAILED / TRANSACTION_FAILED / UNKNOWN: the code says nothing useful, so
  // the call site's fallback is the best available copy.
  return undefined;
}

/**
 * True when `error`'s own message is fit to show a user: an `Error` whose text was written for a
 * human rather than emitted by SQLite. The call sites' old idiom *preferred* `error.message`
 * unconditionally; this is the same preference, correctly gated.
 */
export function hasAuthoredMessage(error: unknown): error is Error {
  return error instanceof Error && !isRawSqliteMessage(error.message);
}
