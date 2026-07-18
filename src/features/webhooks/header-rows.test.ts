import { describe, expect, it } from 'vitest';
import {
  webhookHeaderRows,
  webhookHeaderRowsValid,
  webhookHeadersFromRows,
  type WebhookHeaderRow,
} from './header-rows';

const row = (name: string, value = 'v', id = name): WebhookHeaderRow => ({ id, name, value });

describe('webhookHeaderRows', () => {
  it('reads stored headers into editable rows', () => {
    const rows = webhookHeaderRows({ 'X-Source': 'gubbins', Accept: 'application/json' });
    expect(rows.map((r) => [r.name, r.value])).toEqual([
      ['X-Source', 'gubbins'],
      ['Accept', 'application/json'],
    ]);
    expect(new Set(rows.map((r) => r.id)).size).toBe(2); // ids are unique, so React keys are stable
  });

  it('reads no headers as no rows', () => {
    expect(webhookHeaderRows(null)).toEqual([]);
    expect(webhookHeaderRows(undefined)).toEqual([]);
  });
});

describe('webhookHeadersFromRows', () => {
  it('collapses rows back into the stored shape', () => {
    expect(webhookHeadersFromRows([row('X-Source', 'gubbins'), row('Accept', 'application/json')])).toEqual({
      'X-Source': 'gubbins',
      Accept: 'application/json',
    });
  });

  it('drops a blank row rather than storing an empty name', () => {
    expect(webhookHeadersFromRows([row(''), row('  ', 'x', 'b')])).toBeNull();
  });

  it('trims the name but leaves the value alone', () => {
    expect(webhookHeadersFromRows([row('  X-Source  ', '  spaced  ')])).toEqual({
      'X-Source': '  spaced  ',
    });
  });

  /**
   * A refused row is kept, not filtered: the form refuses to submit while one exists, so dropping
   * it here would turn a visible mistake into a setting that silently vanished on save.
   */
  it('keeps a refused row so the form can object to it', () => {
    expect(webhookHeadersFromRows([row('Authorization', 'Bearer x')])).toEqual({
      Authorization: 'Bearer x',
    });
  });
});

describe('webhookHeaderRowsValid', () => {
  it('accepts allowed names and ignores blank rows', () => {
    expect(webhookHeaderRowsValid([row('X-Source'), row('', '', 'blank')])).toBe(true);
  });

  it('rejects a credential header and the reserved prefix', () => {
    expect(webhookHeaderRowsValid([row('Authorization')])).toBe(false);
    expect(webhookHeaderRowsValid([row('X-Gubbins-Signature')])).toBe(false);
  });

  it('rejects the whole set when a single row is bad', () => {
    expect(webhookHeaderRowsValid([row('X-Source'), row('cookie', 'a=b', 'c')])).toBe(false);
  });
});
