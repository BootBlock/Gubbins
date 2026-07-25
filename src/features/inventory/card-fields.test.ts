import { describe, it, expect } from 'vitest';
import type { Item } from '@/db/repositories';
import {
  BUILTIN_CARD_FIELDS,
  CardCustomField,
  CardFieldContext,
  customCardFieldId,
  DEFAULT_CARD_FIELDS,
  moveCardField,
  normaliseCardFields,
  parseCustomCardFieldId,
  resolveCardFields,
  setCardFieldVisible,
  visibleCardFieldIds,
} from './card-fields';

const BASE: Item = {
  id: 'item-1',
  name: 'NE555 timer',
  description: null,
  notes: null,
  locationId: 'loc-1',
  categoryId: null,
  trackingMode: 'DISCRETE',
  quantity: 12,
  serialNo: null,
  mpn: null,
  manufacturer: null,
  barcode: null,
  unitCost: null,
  expiryDate: null,
  batchNumber: null,
  lotNumber: null,
  condition: null,
  parentId: null,
  isUnlimited: false,
  reorderPoint: null,
  reorderGaugePercent: null,
  reorderQty: null,
  acquiredAt: null,
  warrantyExpiresAt: null,
  purchasePrice: null,
  depreciationMonths: null,
  isActive: true,
  createdAt: 0,
  updatedAt: 1_000,
  gauge: null,
  operationalMetadata: null,
};
const makeItem = (overrides: Partial<Item> = {}): Item => ({ ...BASE, ...overrides });

const fmt = { quantity: (n: number) => String(n), relativeTime: (ms: number) => `t-${ms}` };

function ctx(overrides: Partial<CardFieldContext> = {}): CardFieldContext {
  return {
    locationName: 'Workshop',
    categoryName: null,
    customFields: new Map(),
    customValues: undefined,
    fmt,
    ...overrides,
  };
}

describe('normaliseCardFields', () => {
  it('falls back to the shipped default for a corrupt/absent saved value', () => {
    expect(normaliseCardFields(undefined, [])).toEqual(DEFAULT_CARD_FIELDS);
    expect(normaliseCardFields(null, [])).toEqual(DEFAULT_CARD_FIELDS);
    expect(normaliseCardFields('nonsense', [])).toEqual(DEFAULT_CARD_FIELDS);
  });

  it('preserves a saved order and visibility', () => {
    const saved = [
      { id: 'category', visible: true },
      { id: 'location', visible: false },
    ];
    const result = normaliseCardFields(saved, []);
    // The two saved entries keep their order/visibility; the remaining built-ins append hidden.
    expect(result.slice(0, 2)).toEqual([
      { id: 'category', visible: true },
      { id: 'location', visible: false },
    ]);
    expect(result.map((f) => f.id).sort()).toEqual(BUILTIN_CARD_FIELDS.map((f) => f.id).sort());
  });

  it('drops a stale/unknown id (a removed custom field or garbage)', () => {
    const saved = [
      { id: 'location', visible: true },
      { id: 'custom:gone', visible: true },
      { id: 'bogus', visible: true },
      { id: 'no-visible-key' },
    ];
    const result = normaliseCardFields(saved, []);
    expect(result.some((f) => f.id === 'custom:gone')).toBe(false);
    expect(result.some((f) => f.id === 'bogus')).toBe(false);
    // Every built-in still present exactly once.
    expect(result.map((f) => f.id).filter((id) => id === 'location')).toHaveLength(1);
  });

  it('keeps a known custom field and appends newly-available ones as hidden', () => {
    const saved = [
      { id: 'location', visible: true },
      { id: customCardFieldId('f1'), visible: true },
    ];
    const result = normaliseCardFields(saved, ['f1', 'f2']);
    expect(result.find((f) => f.id === customCardFieldId('f1'))).toEqual({
      id: customCardFieldId('f1'),
      visible: true,
    });
    // f2 is available but not yet in the saved config → appended hidden.
    expect(result.find((f) => f.id === customCardFieldId('f2'))).toEqual({
      id: customCardFieldId('f2'),
      visible: false,
    });
  });

  it('appends a built-in added in a later build as hidden without disturbing saved order', () => {
    // A saved config that predates the `updated` built-in.
    const saved = [
      { id: 'condition', visible: true },
      { id: 'location', visible: true },
    ];
    const result = normaliseCardFields(saved, []);
    expect(result[0]).toEqual({ id: 'condition', visible: true });
    expect(result[1]).toEqual({ id: 'location', visible: true });
    expect(result.find((f) => f.id === 'updated')).toEqual({ id: 'updated', visible: false });
  });

  it('de-duplicates a repeated id, keeping the first occurrence', () => {
    const saved = [
      { id: 'location', visible: true },
      { id: 'location', visible: false },
    ];
    const result = normaliseCardFields(saved, []);
    expect(result.filter((f) => f.id === 'location')).toEqual([{ id: 'location', visible: true }]);
  });
});

describe('reorder + visibility ops', () => {
  it('moves a field up and down, returning the same reference on a no-op', () => {
    const config = normaliseCardFields(undefined, []); // location, category, ...
    const moved = moveCardField(config, 'category', 'up');
    expect(moved.map((f) => f.id).slice(0, 2)).toEqual(['category', 'location']);
    // Already at the top — no-op returns the same reference.
    expect(moveCardField(moved, 'category', 'up')).toBe(moved);
    // Unknown id — no-op.
    expect(moveCardField(config, 'nope', 'down')).toBe(config);
  });

  it('toggles visibility, returning the same reference when unchanged', () => {
    const config = normaliseCardFields(undefined, []);
    const hidden = setCardFieldVisible(config, 'location', false);
    expect(hidden.find((f) => f.id === 'location')?.visible).toBe(false);
    expect(setCardFieldVisible(hidden, 'location', false)).toBe(hidden);
    expect(setCardFieldVisible(config, 'nope', true)).toBe(config);
  });

  it('visibleCardFieldIds returns only the shown ids, in order', () => {
    expect(visibleCardFieldIds(DEFAULT_CARD_FIELDS)).toEqual(['location', 'category']);
  });
});

describe('parseCustomCardFieldId', () => {
  it('round-trips a custom field id and rejects a built-in id', () => {
    expect(parseCustomCardFieldId(customCardFieldId('abc'))).toBe('abc');
    expect(parseCustomCardFieldId('location')).toBeNull();
  });
});

describe('resolveCardFields — built-ins', () => {
  it('resolves location, updated and quantity as text', () => {
    const [loc, upd, qty] = resolveCardFields(
      ['location', 'updated', 'quantity'],
      makeItem({ quantity: 7, updatedAt: 42 }),
      ctx({ locationName: 'Shelf A' }),
    );
    expect(loc).toEqual({ id: 'location', label: 'Location', value: { kind: 'text', text: 'Shelf A' } });
    expect(upd.value).toEqual({ kind: 'text', text: 't-42' });
    expect(qty.value).toEqual({ kind: 'text', text: '7' });
  });

  it('resolves category to text or empty', () => {
    expect(resolveCardFields(['category'], makeItem(), ctx({ categoryName: 'Resistors' }))[0].value).toEqual({
      kind: 'text',
      text: 'Resistors',
    });
    expect(resolveCardFields(['category'], makeItem(), ctx({ categoryName: null }))[0].value).toEqual({
      kind: 'empty',
    });
  });

  it('resolves condition to a condition descriptor or empty', () => {
    expect(resolveCardFields(['condition'], makeItem({ condition: 'GOOD' }), ctx())[0].value).toEqual({
      kind: 'condition',
      condition: 'GOOD',
    });
    expect(resolveCardFields(['condition'], makeItem({ condition: null }), ctx())[0].value).toEqual({
      kind: 'empty',
    });
  });

  it('resolves total value to money (unitCost × quantity) or empty when unpriced', () => {
    expect(resolveCardFields(['value'], makeItem({ unitCost: 2.5, quantity: 4 }), ctx())[0].value).toEqual({
      kind: 'money',
      amount: 10,
    });
    expect(resolveCardFields(['value'], makeItem({ unitCost: null }), ctx())[0].value).toEqual({
      kind: 'empty',
    });
  });

  it('shows em-dash for total value when the count is meaningless (unlimited or gauge)', () => {
    // An unlimited item's quantity is ∞-ignored, a gauge tracks a measure — unitCost × quantity
    // would read as a misleading £0.00, so both decline to a value like the quantity field does.
    expect(
      resolveCardFields(['value'], makeItem({ isUnlimited: true, unitCost: 5, quantity: 0 }), ctx())[0].value,
    ).toEqual({ kind: 'empty' });
    expect(
      resolveCardFields(
        ['value'],
        makeItem({ trackingMode: 'CONSUMABLE_GAUGE', unitCost: 5, quantity: 0 }),
        ctx(),
      )[0].value,
    ).toEqual({ kind: 'empty' });
  });

  it('shows the unlimited glyph for an unlimited item and em-dash for a gauge quantity', () => {
    expect(resolveCardFields(['quantity'], makeItem({ isUnlimited: true }), ctx())[0].value).toEqual({
      kind: 'text',
      text: '∞',
    });
    expect(
      resolveCardFields(['quantity'], makeItem({ trackingMode: 'CONSUMABLE_GAUGE' }), ctx())[0].value,
    ).toEqual({ kind: 'empty' });
  });

  it('always yields one entry per id, in order (so height is config-driven)', () => {
    const resolved = resolveCardFields(['updated', 'location', 'category'], makeItem(), ctx());
    expect(resolved.map((f) => f.id)).toEqual(['updated', 'location', 'category']);
  });
});

describe('resolveCardFields — custom fields', () => {
  const field: CardCustomField = {
    id: 'f1',
    categoryId: 'cat-1',
    name: 'Voltage',
    fieldType: 'TEXT',
    defaultValue: null,
  };
  const customFields = new Map<string, CardCustomField>([['f1', field]]);

  it('shows a stored value for an item in the field’s category', () => {
    const resolved = resolveCardFields(
      [customCardFieldId('f1')],
      makeItem({ categoryId: 'cat-1' }),
      ctx({ customFields, customValues: new Map([['f1', '5V']]) }),
    );
    expect(resolved[0]).toEqual({
      id: customCardFieldId('f1'),
      label: 'Voltage',
      value: { kind: 'text', text: '5V' },
    });
  });

  it('falls back to the field default when the item has no stored value', () => {
    const resolved = resolveCardFields(
      [customCardFieldId('f1')],
      makeItem({ categoryId: 'cat-1' }),
      ctx({ customFields: new Map([['f1', { ...field, defaultValue: '3V3' }]]), customValues: undefined }),
    );
    expect(resolved[0].value).toEqual({ kind: 'text', text: '3V3' });
  });

  it('renders empty (not the value) for an item in a different category', () => {
    const resolved = resolveCardFields(
      [customCardFieldId('f1')],
      makeItem({ categoryId: 'other' }),
      ctx({ customFields, customValues: new Map([['f1', '5V']]) }),
    );
    expect(resolved[0]).toEqual({ id: customCardFieldId('f1'), label: 'Voltage', value: { kind: 'empty' } });
  });

  it('formats a BOOLEAN custom field as Yes/No', () => {
    const boolField: CardCustomField = { ...field, fieldType: 'BOOLEAN' };
    const resolved = resolveCardFields(
      [customCardFieldId('f1')],
      makeItem({ categoryId: 'cat-1' }),
      ctx({ customFields: new Map([['f1', boolField]]), customValues: new Map([['f1', 'true']]) }),
    );
    expect(resolved[0].value).toEqual({ kind: 'text', text: 'Yes' });
  });

  it('formats an ON_OFF custom field as On/Off', () => {
    const onOffField: CardCustomField = { ...field, fieldType: 'ON_OFF' };
    const resolved = resolveCardFields(
      [customCardFieldId('f1')],
      makeItem({ categoryId: 'cat-1' }),
      ctx({ customFields: new Map([['f1', onOffField]]), customValues: new Map([['f1', 'false']]) }),
    );
    expect(resolved[0].value).toEqual({ kind: 'text', text: 'Off' });
  });

  it('renders an IMAGE custom field as a thumbnail of its data URL', () => {
    const imageField: CardCustomField = { ...field, fieldType: 'IMAGE' };
    const tinyImage = 'data:image/webp;base64,UklGRhoAAABXRUJQ';
    const resolved = resolveCardFields(
      [customCardFieldId('f1')],
      makeItem({ categoryId: 'cat-1' }),
      ctx({ customFields: new Map([['f1', imageField]]), customValues: new Map([['f1', tinyImage]]) }),
    );
    expect(resolved[0].value).toEqual({ kind: 'image', src: tinyImage });
  });

  it('trims an IMAGE value before showing it, matching what saving accepts', () => {
    const imageField: CardCustomField = { ...field, fieldType: 'IMAGE' };
    const tinyImage = 'data:image/webp;base64,UklGRhoAAABXRUJQ';
    const resolved = resolveCardFields(
      [customCardFieldId('f1')],
      makeItem({ categoryId: 'cat-1' }),
      ctx({
        customFields: new Map([['f1', imageField]]),
        customValues: new Map([['f1', `  ${tinyImage}  `]]),
      }),
    );
    expect(resolved[0].value).toEqual({ kind: 'image', src: tinyImage });
  });

  /**
   * The card puts an `image` value straight into an `<img src>`, so only a real image data URL
   * may become one — a value stored before the field was retyped to IMAGE, or one merged from a
   * sync peer, must read as empty rather than as a URL the card fetches.
   */
  it.each([
    ['a remote URL', 'https://images.example.com/tracker.png'],
    ['a javascript: URL', 'javascript:alert(1)'],
    ['a non-image data URL', 'data:text/html;base64,PHNjcmlwdD4='],
    ['free text left by a retyped field', 'just some text'],
  ])('renders empty for an IMAGE custom field holding %s', (_label, hostile) => {
    const imageField: CardCustomField = { ...field, fieldType: 'IMAGE' };
    const resolved = resolveCardFields(
      [customCardFieldId('f1')],
      makeItem({ categoryId: 'cat-1' }),
      ctx({ customFields: new Map([['f1', imageField]]), customValues: new Map([['f1', hostile]]) }),
    );
    expect(resolved[0].value).toEqual({ kind: 'empty' });
  });

  it('skips a custom field id absent from the catalog (defensive)', () => {
    const resolved = resolveCardFields([customCardFieldId('gone')], makeItem(), ctx({ customFields }));
    expect(resolved).toEqual([]);
  });
});
