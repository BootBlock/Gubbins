/**
 * The editable-row model behind the extra-headers editor (webhooks plan §4.1, §6.4).
 *
 * Pure and separate from the component so the conversion — the part with decisions in it — is
 * unit-testable, and so the editor file exports only components (Fast Refresh's rule, and the same
 * split `project-form.ts` uses).
 */
import { webhookHeaderIssue } from './headers';

/** One editable row. Kept as a list rather than an object so a half-typed name cannot collide. */
export interface WebhookHeaderRow {
  readonly id: string;
  readonly name: string;
  readonly value: string;
}

/** Turn stored headers into editable rows. */
export function webhookHeaderRows(
  headers: Readonly<Record<string, string>> | null | undefined,
): readonly WebhookHeaderRow[] {
  if (!headers) return [];
  return Object.entries(headers).map(([name, value], index) => ({
    id: `stored-${String(index)}`,
    name,
    value,
  }));
}

/**
 * Collapse editable rows back into the stored shape, dropping blank rows.
 *
 * Rows that break the header rule are **kept** rather than filtered out here: the form refuses to
 * submit while any row is invalid, so silently dropping one would turn a mistake the user can see
 * into a setting that vanished on save.
 */
export function webhookHeadersFromRows(
  rows: readonly WebhookHeaderRow[],
): Readonly<Record<string, string>> | null {
  const headers: Record<string, string> = {};
  for (const row of rows) {
    const name = row.name.trim();
    if (name === '') continue;
    headers[name] = row.value;
  }
  return Object.keys(headers).length > 0 ? headers : null;
}

/** Whether any row would be refused — the form's gate before saving. */
export function webhookHeaderRowsValid(rows: readonly WebhookHeaderRow[]): boolean {
  return rows.every((row) => row.name.trim() === '' || webhookHeaderIssue(row.name) === null);
}
