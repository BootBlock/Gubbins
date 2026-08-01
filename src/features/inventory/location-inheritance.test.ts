import { describe, expect, it } from 'vitest';
import {
  buildAncestorChain,
  findInheritedValue,
  resolveFieldValue,
  type AncestorLocation,
  type InheritableOffer,
} from './location-inheritance';

/** Workshop → Cabinet A → Drawer 3, as a nearest-first chain from the drawer. */
const CHAIN: AncestorLocation[] = [
  { id: 'drawer', name: 'Drawer 3' },
  { id: 'cabinet', name: 'Cabinet A' },
  { id: 'workshop', name: 'Workshop' },
];

const MANUFACTURER = 'def-manufacturer';

describe('findInheritedValue', () => {
  it('returns null when nothing offers the definition', () => {
    expect(findInheritedValue(CHAIN, [], MANUFACTURER)).toBeNull();
  });

  it('takes the value from an ancestor that offers it', () => {
    const offers: InheritableOffer[] = [
      { locationId: 'workshop', defId: MANUFACTURER, value: 'Ryobi', originDeviceId: null },
    ];
    expect(findInheritedValue(CHAIN, offers, MANUFACTURER)).toEqual({
      value: 'Ryobi',
      locationId: 'workshop',
      locationName: 'Workshop',
      originDeviceId: null,
    });
  });

  it('prefers the nearest ancestor when several offer the same definition', () => {
    const offers: InheritableOffer[] = [
      { locationId: 'workshop', defId: MANUFACTURER, value: 'Ryobi', originDeviceId: null },
      { locationId: 'cabinet', defId: MANUFACTURER, value: 'Makita', originDeviceId: null },
    ];
    // Cabinet A sits below Workshop, so its value wins.
    expect(findInheritedValue(CHAIN, offers, MANUFACTURER)?.value).toBe('Makita');
  });

  it('ignores offers for a different definition', () => {
    const offers: InheritableOffer[] = [
      { locationId: 'workshop', defId: 'def-voltage', value: '18V', originDeviceId: null },
    ];
    expect(findInheritedValue(CHAIN, offers, MANUFACTURER)).toBeNull();
  });

  it('ignores offers from locations outside the chain', () => {
    const offers: InheritableOffer[] = [
      { locationId: 'garage', defId: MANUFACTURER, value: 'Bosch', originDeviceId: null },
    ];
    expect(findInheritedValue(CHAIN, offers, MANUFACTURER)).toBeNull();
  });

  it('carries a null offered value through rather than treating it as absent', () => {
    const offers: InheritableOffer[] = [
      { locationId: 'cabinet', defId: MANUFACTURER, value: null, originDeviceId: null },
    ];
    expect(findInheritedValue(CHAIN, offers, MANUFACTURER)).toEqual({
      value: null,
      locationId: 'cabinet',
      locationName: 'Cabinet A',
      originDeviceId: null,
    });
  });
});

describe('resolveFieldValue', () => {
  const offer = { value: 'Ryobi', locationId: 'workshop', locationName: 'Workshop', originDeviceId: null };

  it('falls back to the category default when nothing is stored', () => {
    expect(resolveFieldValue(undefined, null, 'Unknown')).toEqual({
      value: 'Unknown',
      source: 'default',
      mode: 'literal',
      inheritable: null,
      originDeviceId: null,
    });
  });

  it('prefers a stored literal over an available inheritable value', () => {
    const result = resolveFieldValue(
      { mode: 'literal', value: 'Makita', originDeviceId: null },
      offer,
      'Unknown',
    );
    expect(result.value).toBe('Makita');
    expect(result.source).toBe('stored');
    // The offer is still reported so the editor can present <Inherit> as a choice.
    expect(result.inheritable).toEqual(offer);
  });

  it('takes the inherited value when the item is set to inherit', () => {
    const result = resolveFieldValue(
      { mode: 'inherit', value: null, originDeviceId: null },
      offer,
      'Unknown',
    );
    expect(result.value).toBe('Ryobi');
    expect(result.source).toBe('inherited');
    expect(result.mode).toBe('inherit');
  });

  it('falls back to the default when inheriting but the offer has gone', () => {
    // The location's value was cleared or made non-inheritable, or the item moved.
    const result = resolveFieldValue({ mode: 'inherit', value: null, originDeviceId: null }, null, 'Unknown');
    expect(result.value).toBe('Unknown');
    expect(result.source).toBe('default');
    // The intent is *kept*, so restoring the offer restores the inheritance.
    expect(result.mode).toBe('inherit');
  });

  it('treats a stored null literal as a deliberate clear, not as unset', () => {
    const result = resolveFieldValue({ mode: 'literal', value: null, originDeviceId: null }, null, 'Unknown');
    expect(result.value).toBeNull();
    expect(result.source).toBe('stored');
  });

  it('reports no inheritable when none is offered', () => {
    expect(resolveFieldValue(undefined, null, null).inheritable).toBeNull();
  });

  /**
   * W1g — the origin device follows `value` through the same precedence, which is what stops the
   * pair ever describing different rows. Each case below is a row the origin could have been
   * taken from wrongly.
   */
  describe('origin device (W1g)', () => {
    const foreignOffer = { ...offer, originDeviceId: 'device-desktop' };

    it('takes the offering location’s origin when the value is inherited', () => {
      // The item's own row holds no value under `mode = 'inherit'`, so its origin — whatever a
      // previous literal left there — must not be the one reported.
      const result = resolveFieldValue(
        { mode: 'inherit', value: null, originDeviceId: 'device-stale' },
        foreignOffer,
        'Unknown',
      );
      expect(result.source).toBe('inherited');
      expect(result.originDeviceId).toBe('device-desktop');
    });

    it('takes the item’s own origin for a stored literal, ignoring an unused offer', () => {
      const result = resolveFieldValue(
        { mode: 'literal', value: 'Makita', originDeviceId: 'device-laptop' },
        foreignOffer,
        'Unknown',
      );
      expect(result.source).toBe('stored');
      expect(result.originDeviceId).toBe('device-laptop');
    });

    it('reports no origin for a category default — schema, not something a device authored', () => {
      expect(resolveFieldValue(undefined, null, 'Unknown').originDeviceId).toBeNull();
      // Including the case where an inherit intent survives but its offer has gone: the value on
      // screen is now the default, so the vanished offer's origin must not be reported for it.
      expect(
        resolveFieldValue({ mode: 'inherit', value: null, originDeviceId: 'device-stale' }, null, 'Unknown')
          .originDeviceId,
      ).toBeNull();
    });
  });
});

describe('buildAncestorChain', () => {
  const parents = new Map([
    ['drawer', { name: 'Drawer 3', parentId: 'cabinet' }],
    ['cabinet', { name: 'Cabinet A', parentId: 'workshop' }],
    ['workshop', { name: 'Workshop', parentId: null }],
  ]);

  it('walks from the start location up to the root, nearest first', () => {
    expect(buildAncestorChain('drawer', parents)).toEqual(CHAIN);
  });

  it('starts partway up the tree', () => {
    expect(buildAncestorChain('cabinet', parents)).toEqual([
      { id: 'cabinet', name: 'Cabinet A' },
      { id: 'workshop', name: 'Workshop' },
    ]);
  });

  it('yields a single link for a root location', () => {
    expect(buildAncestorChain('workshop', parents)).toEqual([{ id: 'workshop', name: 'Workshop' }]);
  });

  it('returns an empty chain for an unknown location', () => {
    expect(buildAncestorChain('nowhere', parents)).toEqual([]);
  });

  it('terminates on a cyclic parent chain rather than hanging', () => {
    const cyclic = new Map([
      ['a', { name: 'A', parentId: 'b' }],
      ['b', { name: 'B', parentId: 'a' }],
    ]);
    expect(buildAncestorChain('a', cyclic)).toEqual([
      { id: 'a', name: 'A' },
      { id: 'b', name: 'B' },
    ]);
  });

  it('stops at a dangling parent reference', () => {
    const dangling = new Map([['a', { name: 'A', parentId: 'missing' }]]);
    expect(buildAncestorChain('a', dangling)).toEqual([{ id: 'a', name: 'A' }]);
  });
});
