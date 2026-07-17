/**
 * Turning a stored {@link SyncConflict} into a readable field-by-field comparison (issue #72).
 *
 * Pure and render-free so the diff logic is unit-testable without the dialog. Produces the
 * short list of columns that actually differ between the user's discarded version and the
 * winning version, with each side rendered to a compact display string. Bookkeeping columns
 * (`id`, timestamps) and unwieldy values (long text, encoded BLOBs) are elided so the review
 * card stays legible rather than dumping raw row JSON.
 */
import type { SqlRow } from '@/db/rpc/driver';
import { nonLwwColumns } from './conflict-detect';
import type { SyncConflict } from './types';

/** One differing column, both sides pre-rendered for display. */
export interface FieldDiff {
  readonly column: string;
  /** The user's (discarded) value. */
  readonly mine: string;
  /** The winning value — or `null` for a `DELETE` collision (the row was removed). */
  readonly theirs: string | null;
}

/** Columns never worth showing in a diff — pure bookkeeping. */
const HIDDEN_COLUMNS = new Set(['id', 'updated_at', 'created_at']);

/** Longest value we render inline before collapsing to a placeholder. */
const MAX_VALUE_LENGTH = 80;

/** Render one cell value to a compact, safe display string. */
function displayValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  if (value instanceof Uint8Array || value instanceof ArrayBuffer) return '(binary data)';
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  const text = String(value);
  if (text.length > MAX_VALUE_LENGTH) return `${text.slice(0, MAX_VALUE_LENGTH)}…`;
  return text;
}

/**
 * The columns whose values differ between the user's version and the winning one. For a
 * `DELETE` collision there is no winning row, so every populated local column is listed with
 * `theirs = null` (the reviewer sees exactly what would be lost if they accept the deletion).
 */
export function diffConflict(conflict: SyncConflict): FieldDiff[] {
  const local = conflict.localVersion;
  const remote = conflict.remoteVersion;
  // Hide the table's non-LWW columns (CRDT / trigger-derived) too — they aren't part of the
  // lost edit, so showing them would misrepresent what changed.
  const skip = new Set([...HIDDEN_COLUMNS, ...nonLwwColumns(conflict.tableName)]);

  if (remote === null) {
    return columnsOf(skip, local)
      .filter((c) => local[c] !== null && local[c] !== undefined && local[c] !== '')
      .map((c) => ({ column: c, mine: displayValue(local[c]), theirs: null }));
  }

  const diffs: FieldDiff[] = [];
  for (const c of columnsOf(skip, local, remote)) {
    if (String(local[c] ?? '') === String(remote[c] ?? '')) continue;
    diffs.push({ column: c, mine: displayValue(local[c]), theirs: displayValue(remote[c]) });
  }
  return diffs;
}

/** The visible columns present across the given rows, minus `skip`, in a stable order. */
function columnsOf(skip: ReadonlySet<string>, ...rows: SqlRow[]): string[] {
  const seen = new Set<string>();
  const cols: string[] = [];
  for (const row of rows) {
    for (const c of Object.keys(row)) {
      if (skip.has(c) || seen.has(c)) continue;
      seen.add(c);
      cols.push(c);
    }
  }
  return cols;
}
