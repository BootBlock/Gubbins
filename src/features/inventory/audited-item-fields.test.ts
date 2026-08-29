/**
 * The audited-field registry against the catalog copy that names the same fields (issue #486).
 *
 * Each entry carries two names for one field: `label`, the lower-case prose the ledger writes into
 * an entry's note ("Changed unit cost, barcode."), and `labelKey`, the sentence-case catalog key
 * the Activity Log shows beside the values. They must name the same thing, or the same edit reads
 * as one field in the note and another in the list beneath it.
 *
 * The key's *existence* is already a compile error when it is wrong, because `labelKey` is typed
 * to `MessageKey`. What no type can check is whether the two agree, so that is what is driven
 * here — case-insensitively, since "MPN" is sentence-case already and capitalising it would be
 * wrong.
 *
 * The field *set* is held against the edit path and the live `items` schema by
 * `src/features/sync/merge-audit-drift.test.ts`.
 */
import { describe, it, expect } from 'vitest';
import { EN_CATALOG } from '@/features/i18n/messages';
import { AUDITED_ITEM_COLUMNS, auditedItemField } from './audited-item-fields';

describe('the audited-item-field registry (issue #486)', () => {
  it('names each field the same way in its note prose and in the catalog', () => {
    const disagreeing = AUDITED_ITEM_COLUMNS.filter(
      ({ label, labelKey }) => EN_CATALOG[labelKey]?.toLowerCase() !== label.toLowerCase(),
    ).map(({ field, label, labelKey }) => `${field}: "${label}" vs "${EN_CATALOG[labelKey] ?? ''}"`);

    expect(disagreeing).toEqual([]);
  });

  it('derives each column name from its field name, so neither can be mistyped alone', () => {
    for (const { column, field } of AUDITED_ITEM_COLUMNS) {
      expect(column).toBe(field.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`));
    }
  });

  it('looks a field up by name, and reports an unknown one rather than guessing', () => {
    expect(auditedItemField('unitCost')?.kind).toBe('money');
    expect(auditedItemField('someFutureField')).toBeUndefined();
  });
});
