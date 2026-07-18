import { describe, expect, it } from 'vitest';
import {
  emptyWebhookFilterForm,
  formToWebhookFilter,
  isWebhookFormConditionComplete,
  newWebhookFormCondition,
  webhookFilterToForm,
  type WebhookFormCondition,
} from './filter-form';
import type { WebhookFilter } from './filter';

function condition(overrides: Partial<WebhookFormCondition> = {}): WebhookFormCondition {
  return { ...newWebhookFormCondition('c1'), ...overrides };
}

describe('webhookFilterToForm', () => {
  it('reads a null filter as an empty form', () => {
    expect(webhookFilterToForm(null)).toEqual(emptyWebhookFilterForm());
  });

  it('reads an item leaf, which the builder can now edit', () => {
    const form = webhookFilterToForm({ kind: 'item', itemIds: ['item-1'] });
    expect(form?.conditions[0]).toMatchObject({ kind: 'item', ids: ['item-1'] });
  });

  it('reads a bare leaf as a one-condition form', () => {
    const form = webhookFilterToForm({ kind: 'category', categoryIds: ['cat-1'] });
    expect(form?.combinator).toBe('all');
    expect(form?.conditions).toHaveLength(1);
    expect(form?.conditions[0]).toMatchObject({ kind: 'category', ids: ['cat-1'] });
  });

  it('reads a combinator over leaves, preserving which combinator it was', () => {
    const form = webhookFilterToForm({
      kind: 'any',
      of: [
        { kind: 'tag', tagIds: ['tag-1'] },
        { kind: 'quantity', op: 'lt', value: 5 },
      ],
    });
    expect(form?.combinator).toBe('any');
    expect(form?.conditions.map((c) => c.kind)).toEqual(['tag', 'quantity']);
    expect(form?.conditions[1]).toMatchObject({ op: 'lt', value: '5' });
  });

  it('defaults a location leaf to including its subtree', () => {
    const form = webhookFilterToForm({ kind: 'location', locationIds: ['loc-1'] });
    expect(form?.conditions[0]?.includeDescendants).toBe(true);
  });

  it('preserves an explicit includeDescendants: false', () => {
    const form = webhookFilterToForm({
      kind: 'location',
      locationIds: ['loc-1'],
      includeDescendants: false,
    });
    expect(form?.conditions[0]?.includeDescendants).toBe(false);
  });

  // The important half: anything the builder cannot faithfully edit must be refused rather than
  // approximated, so the caller shows it read-only instead of rewriting what it did not understand.
  it.each<[string, WebhookFilter]>([
    ['a negation', { kind: 'not', of: { kind: 'tag', tagIds: ['t'] } }],
    ['the inert node', { kind: 'none' }],
    ['a nested tree', { kind: 'all', of: [{ kind: 'any', of: [{ kind: 'tag', tagIds: ['t'] }] }] }],
  ])('refuses to represent %s', (_label, filter) => {
    expect(webhookFilterToForm(filter)).toBeNull();
  });
});

describe('formToWebhookFilter', () => {
  it('returns null for an empty form — "no filter", not "match nothing"', () => {
    expect(formToWebhookFilter(emptyWebhookFilterForm())).toBeNull();
  });

  it('unwraps a single condition rather than wrapping it in a combinator', () => {
    const filter = formToWebhookFilter({
      combinator: 'all',
      conditions: [condition({ kind: 'tag', ids: ['tag-1'] })],
    });
    expect(filter).toEqual({ kind: 'tag', tagIds: ['tag-1'] });
  });

  it('wraps several conditions in the chosen combinator', () => {
    const filter = formToWebhookFilter({
      combinator: 'any',
      conditions: [
        condition({ id: 'a', kind: 'tag', ids: ['tag-1'] }),
        condition({ id: 'b', kind: 'category', ids: ['cat-1'] }),
      ],
    });
    expect(filter).toEqual({
      kind: 'any',
      of: [
        { kind: 'tag', tagIds: ['tag-1'] },
        { kind: 'category', categoryIds: ['cat-1'] },
      ],
    });
  });

  // An empty id-list leaf matches nothing at all, so emitting one would silently turn a
  // half-finished row into a subscription that never fires.
  it('drops a condition with no ids selected', () => {
    expect(
      formToWebhookFilter({ combinator: 'all', conditions: [condition({ kind: 'tag', ids: [] })] }),
    ).toBeNull();
  });

  it('drops a quantity condition with no number entered', () => {
    expect(
      formToWebhookFilter({
        combinator: 'all',
        conditions: [condition({ kind: 'quantity', value: '   ' })],
      }),
    ).toBeNull();
  });

  it('drops a quantity condition whose value is not a number', () => {
    expect(
      formToWebhookFilter({
        combinator: 'all',
        conditions: [condition({ kind: 'quantity', value: 'abc' })],
      }),
    ).toBeNull();
  });

  it('emits an item leaf', () => {
    expect(
      formToWebhookFilter({
        combinator: 'all',
        conditions: [condition({ kind: 'item', ids: ['item-1', 'item-2'] })],
      }),
    ).toEqual({ kind: 'item', itemIds: ['item-1', 'item-2'] });
  });

  it('keeps a valid quantity of zero', () => {
    expect(
      formToWebhookFilter({
        combinator: 'all',
        conditions: [condition({ kind: 'quantity', op: 'lte', value: '0' })],
      }),
    ).toEqual({ kind: 'quantity', op: 'lte', value: 0 });
  });

  it('ignores blank ids inside a list', () => {
    expect(
      formToWebhookFilter({
        combinator: 'all',
        conditions: [condition({ kind: 'category', ids: ['  ', 'cat-1'] })],
      }),
    ).toEqual({ kind: 'category', categoryIds: ['cat-1'] });
  });
});

describe('round trip', () => {
  it.each<[string, WebhookFilter]>([
    ['a category leaf', { kind: 'category', categoryIds: ['cat-1', 'cat-2'] }],
    ['a quantity leaf', { kind: 'quantity', op: 'gte', value: 12 }],
    ['an item leaf', { kind: 'item', itemIds: ['item-1'] }],
    ['a location subtree', { kind: 'location', locationIds: ['loc-1'], includeDescendants: true }],
    [
      'an all-combinator',
      {
        kind: 'all',
        of: [
          { kind: 'tag', tagIds: ['tag-1'] },
          { kind: 'quantity', op: 'lt', value: 3 },
        ],
      },
    ],
  ])('preserves %s through form and back', (_label, filter) => {
    const form = webhookFilterToForm(filter);
    expect(form).not.toBeNull();
    expect(formToWebhookFilter(form!)).toEqual(filter);
  });
});

describe('isWebhookFormConditionComplete', () => {
  it('is false for a fresh row and true once it carries something', () => {
    expect(isWebhookFormConditionComplete(newWebhookFormCondition('c1'))).toBe(false);
    expect(isWebhookFormConditionComplete(condition({ kind: 'tag', ids: ['tag-1'] }))).toBe(true);
  });
});
