import { describe, it, expect } from 'vitest';
import type { Item } from '@/db/repositories';
import { NO_SECTION_PRESENCE } from '@/db/repositories';
import { ALL_FEATURE_IDS, type FeatureId } from '@/features/modules/feature-registry';
import { buildTabs, type FieldProminence } from './ItemDetailDialog';

/**
 * Phase 6 — the item-detail tabs gate their capability sections by the enabled feature set.
 * `buildTabs` is a pure seam (it takes the resolved set, never a hook), so its gating is
 * unit-tested directly: dropping a feature drops its section, and a tab left with no
 * surviving sections is dropped entirely. Only the active tab's panel is ever mounted, so
 * exercising the builder here (without rendering the editors) is the honest test of the
 * gating rules.
 */
const item: Item = {
  id: 'item-1',
  name: 'NE555 timer',
  description: 'Single bipolar timer IC',
  notes: null,
  locationId: 'loc-1',
  categoryId: 'cat-1',
  trackingMode: 'DISCRETE',
  quantity: 10,
  serialNo: null,
  mpn: 'NE555P',
  manufacturer: 'Texas Instruments',
  unitCost: 0.4,
  expiryDate: null,
  batchNumber: null,
  lotNumber: null,
  condition: null,
  parentId: null,
  reorderPoint: null,
  reorderGaugePercent: null,
  reorderQty: null,
  acquiredAt: null,
  warrantyExpiresAt: null,
  purchasePrice: null,
  depreciationMonths: null,
  currentValue: null,
  hasVariants: false,
  isActive: true,
  createdAt: 0,
  updatedAt: 0,
  gauge: null,
  operationalMetadata: null,
};

const ALL = new Set<FeatureId>(ALL_FEATURE_IDS);
/** The everything-on set minus the given features. */
const without = (...off: FeatureId[]): Set<FeatureId> => {
  const set = new Set(ALL);
  for (const id of off) set.delete(id);
  return set;
};
const tabIds = (tabs: ReturnType<typeof buildTabs>) => tabs.map((t) => t.id);
const sectionTitles = (tabs: ReturnType<typeof buildTabs>, tabId?: string) =>
  tabId === undefined
    ? tabs.flatMap((t) => t.sections.map((s) => s.title))
    : (tabs.find((t) => t.id === tabId)?.sections ?? []).map((s) => s.title);

describe('buildTabs — feature gating (Phase 6)', () => {
  it('shows every facet with the full feature set enabled', () => {
    const tabs = buildTabs(item, ALL);
    expect(tabIds(tabs)).toEqual([
      'details',
      'supplier',
      'lifecycle',
      'kit',
      'related',
      'substitutions',
      'media',
      'classification',
      'activity',
    ]);
    expect(sectionTitles(tabs, 'lifecycle')).toEqual([
      'Lifecycle & variants',
      'Asset details',
      'Maintenance',
    ]);
    expect(sectionTitles(tabs, 'kit')).toEqual(['Kit components']);
    expect(sectionTitles(tabs, 'classification')).toEqual(['Tags', 'Capabilities', 'Custom fields']);
    expect(sectionTitles(tabs, 'media')).toEqual(['Images', 'Datasheets']);
  });

  it('drops the Kit tab entirely when the kits capability is off', () => {
    const tabs = buildTabs(item, without('kits'));
    expect(tabIds(tabs)).not.toContain('kit');
    // The surrounding tabs are unaffected.
    expect(tabIds(tabs)).toContain('lifecycle');
    expect(tabIds(tabs)).toContain('media');
  });

  it('drops the Asset details section when warranty is off, keeping the Lifecycle tab', () => {
    const tabs = buildTabs(item, without('warranty'));
    expect(tabIds(tabs)).toContain('lifecycle');
    expect(sectionTitles(tabs, 'lifecycle')).toEqual(['Lifecycle & variants', 'Maintenance']);
  });

  it('drops the Maintenance section when maintenance is off', () => {
    const tabs = buildTabs(item, without('maintenance'));
    expect(sectionTitles(tabs, 'lifecycle')).toEqual(['Lifecycle & variants', 'Asset details']);
  });

  it('retitles the Lifecycle section to drop "& variants" when variants is off', () => {
    // The section survives (it owns expiry/batch/condition), but the heading no longer
    // promises variants, whose sub-block LifecycleEditor gates away.
    const tabs = buildTabs(item, without('variants'));
    expect(sectionTitles(tabs, 'lifecycle')).toEqual(['Lifecycle', 'Asset details', 'Maintenance']);
  });

  it('drops Capabilities + Custom fields when custom-fields is off, keeping Tags', () => {
    const tabs = buildTabs(item, without('custom-fields'));
    expect(sectionTitles(tabs, 'classification')).toEqual(['Tags']);
  });

  it('drops Tags + Datasheets when tags-attachments is off, keeping their tabs via core sections', () => {
    const tabs = buildTabs(item, without('tags-attachments'));
    expect(sectionTitles(tabs, 'classification')).toEqual(['Capabilities', 'Custom fields']);
    expect(sectionTitles(tabs, 'media')).toEqual(['Images']);
  });

  it('drops the Classification tab entirely once both its capabilities are off', () => {
    const tabs = buildTabs(item, without('custom-fields', 'tags-attachments'));
    expect(tabIds(tabs)).not.toContain('classification');
    // The dialog falls back to the first surviving tab — Details always leads and stays.
    expect(tabs[0]!.id).toBe('details');
  });

  it('never mutates the item it is given (gating hides UI, never touches stored data)', () => {
    const snapshot = structuredClone(item);
    buildTabs(item, without('warranty', 'maintenance', 'custom-fields', 'tags-attachments'));
    expect(item).toEqual(snapshot);
  });
});

/**
 * Issue #618 — the second visibility axis: the item's *category* can declare capabilities its
 * items simply don't have. It narrows the device's set and may never widen it, and it must
 * never make existing data invisible — a hidden section that holds something is shown anyway.
 */
describe('buildTabs — category-scoped hiding (issue #618)', () => {
  const hiding = (...ids: FeatureId[]): ReadonlySet<FeatureId> => new Set(ids);

  it('hides a section the category hides when it holds no data', () => {
    const tabs = buildTabs(item, ALL, hiding('maintenance'), NO_SECTION_PRESENCE);
    expect(sectionTitles(tabs, 'lifecycle')).not.toContain('Maintenance');
  });

  it('keeps a hidden section that holds data, and flags why it survived', () => {
    const tabs = buildTabs(item, ALL, hiding('maintenance'), {
      ...NO_SECTION_PRESENCE,
      maintenance: true,
    });
    const section = tabs.find((t) => t.id === 'lifecycle')?.sections.find((s) => s.title === 'Maintenance');
    expect(section).toBeDefined();
    expect(section!.shownDespiteHidden).toBe(true);
  });

  it('does not flag a section that was never hidden', () => {
    const tabs = buildTabs(item, ALL, hiding(), { ...NO_SECTION_PRESENCE, maintenance: true });
    const section = tabs.find((t) => t.id === 'lifecycle')?.sections.find((s) => s.title === 'Maintenance');
    expect(section!.shownDespiteHidden).toBeUndefined();
  });

  it('resolves per section, not per capability, where one capability gates two', () => {
    // `tags-attachments` gates Tags and Datasheets. Attachments exist, tags do not — so only
    // Datasheets is rescued. Keying presence off the capability would wrongly show both.
    const tabs = buildTabs(item, ALL, hiding('tags-attachments'), {
      ...NO_SECTION_PRESENCE,
      attachments: true,
    });
    expect(sectionTitles(tabs, 'classification')).not.toContain('Tags');
    expect(sectionTitles(tabs, 'media')).toContain('Datasheets');
  });

  it('lets the device module win over a category that hides nothing, even with data present', () => {
    const tabs = buildTabs(item, without('maintenance'), hiding(), {
      ...NO_SECTION_PRESENCE,
      maintenance: true,
    });
    expect(sectionTitles(tabs, 'lifecycle')).not.toContain('Maintenance');
  });

  it('never lets a category re-enable a capability the device has switched off', () => {
    // The narrowing invariant, end to end: no category state resurrects a disabled module.
    for (const hidden of [hiding(), hiding('kits')]) {
      const tabs = buildTabs(item, without('kits'), hidden, { ...NO_SECTION_PRESENCE, kit: true });
      expect(tabIds(tabs)).not.toContain('kit');
    }
  });

  it('drops a tab whose only section the category hides', () => {
    const tabs = buildTabs(item, ALL, hiding('kits'), NO_SECTION_PRESENCE);
    expect(tabIds(tabs)).not.toContain('kit');
  });

  it('hides nothing for an item whose category hides nothing', () => {
    // The overwhelmingly common case, and the one the two-argument call site relies on.
    expect(sectionTitles(buildTabs(item, ALL, hiding(), NO_SECTION_PRESENCE))).toEqual(
      sectionTitles(buildTabs(item, ALL)),
    );
    expect(sectionTitles(buildTabs(item, ALL, hiding(), NO_SECTION_PRESENCE))).toContain('Maintenance');
  });

  it('titles the Lifecycle section without "& variants" when the category hides variants', () => {
    // The variants block lives inside the editor, so a heading promising it while the editor
    // drops it would be a half-applied edit against the same capability.
    const tabs = buildTabs(item, ALL, hiding('variants'), NO_SECTION_PRESENCE);
    expect(sectionTitles(tabs, 'lifecycle')).toContain('Lifecycle');
    expect(sectionTitles(tabs, 'lifecycle')).not.toContain('Lifecycle & variants');
  });

  it('keeps "& variants" when the item is itself a child variant', () => {
    // `hasVariants` only means "has children"; a child's own parent link is data too.
    const child: Item = { ...item, parentId: 'parent-1' };
    const tabs = buildTabs(child, ALL, hiding('variants'), NO_SECTION_PRESENCE);
    expect(sectionTitles(tabs, 'lifecycle')).toContain('Lifecycle & variants');
  });

  it('never mutates the item it is given', () => {
    const snapshot = structuredClone(item);
    buildTabs(item, ALL, hiding('maintenance', 'kits', 'custom-fields'), {
      ...NO_SECTION_PRESENCE,
      maintenance: true,
    });
    expect(item).toEqual(snapshot);
  });
});

/**
 * Issue #619 — the third axis, and the only one about *position* rather than presence. Every tab
 * remains reachable in every mode; what changes is how far a reader has to travel to reach the
 * fields their category is largely defined by. It is applied last and may never outrank the two
 * visibility axes above.
 */
describe('buildTabs — custom-field prominence (issue #619)', () => {
  const NONE: ReadonlySet<FeatureId> = new Set<FeatureId>();
  const prominence = (mode: FieldProminence['mode'], tabLabel = 'Custom fields'): FieldProminence => ({
    mode,
    tabLabel,
  });

  it('changes nothing in the default mode', () => {
    const tabs = buildTabs(item, ALL, NONE, NO_SECTION_PRESENCE, prominence('default'));
    expect(tabIds(tabs)).toEqual(tabIds(buildTabs(item, ALL)));
    expect(sectionTitles(tabs, 'classification')).toEqual(['Tags', 'Capabilities', 'Custom fields']);
  });

  it('moves the whole Classification tab up to sit directly after Details when promoted', () => {
    const tabs = buildTabs(item, ALL, NONE, NO_SECTION_PRESENCE, prominence('promoted'));
    expect(tabIds(tabs)).toEqual([
      'details',
      'classification',
      'supplier',
      'lifecycle',
      'kit',
      'related',
      'substitutions',
      'media',
      'activity',
    ]);
    // Promotion moves the tab; it does not restructure it.
    expect(sectionTitles(tabs, 'classification')).toEqual(['Tags', 'Capabilities', 'Custom fields']);
  });

  it('breaks the custom fields out into their own tab after Details when asked', () => {
    const tabs = buildTabs(item, ALL, NONE, NO_SECTION_PRESENCE, prominence('own-tab', 'Film details'));
    expect(tabIds(tabs)).toEqual([
      'details',
      'custom-fields',
      'supplier',
      'lifecycle',
      'kit',
      'related',
      'substitutions',
      'media',
      'classification',
      'activity',
    ]);
    expect(tabs.find((t) => t.id === 'custom-fields')!.label).toBe('Film details');
    expect(sectionTitles(tabs, 'custom-fields')).toEqual(['Custom fields']);
  });

  it('leaves tags and capabilities in Classification when the fields break out', () => {
    // The break-out is about the *fields*; the rest of Classification is unrelated and stays put.
    const tabs = buildTabs(item, ALL, NONE, NO_SECTION_PRESENCE, prominence('own-tab'));
    expect(sectionTitles(tabs, 'classification')).toEqual(['Tags', 'Capabilities']);
  });

  it('shows the fields exactly once, never in both places', () => {
    for (const mode of ['default', 'promoted', 'own-tab'] as const) {
      const tabs = buildTabs(item, ALL, NONE, NO_SECTION_PRESENCE, prominence(mode));
      expect(
        sectionTitles(tabs).filter((t) => t === 'Custom fields'),
        mode,
      ).toHaveLength(1);
    }
  });

  it('reverts to the default position when the device has custom fields switched off', () => {
    // Nothing to bring forward: promoting would raise a tab holding only tags, and breaking out
    // would produce an empty one.
    for (const mode of ['promoted', 'own-tab'] as const) {
      const tabs = buildTabs(item, without('custom-fields'), NONE, NO_SECTION_PRESENCE, prominence(mode));
      expect(tabIds(tabs), mode).not.toContain('custom-fields');
      expect(tabIds(tabs).indexOf('classification'), mode).toBeGreaterThan(tabIds(tabs).indexOf('media'));
      expect(sectionTitles(tabs), mode).not.toContain('Custom fields');
    }
  });

  it('reverts to the default position when the category hides custom fields and the item has none', () => {
    for (const mode of ['promoted', 'own-tab'] as const) {
      const tabs = buildTabs(
        item,
        ALL,
        new Set(['custom-fields'] as FeatureId[]),
        NO_SECTION_PRESENCE,
        prominence(mode),
      );
      expect(tabIds(tabs), mode).not.toContain('custom-fields');
      expect(sectionTitles(tabs, 'classification'), mode).toEqual(['Tags']);
    }
  });

  it('still breaks out — flagged — when the category hides the fields but the item has some', () => {
    // Hiding must never make existing data invisible (issue #618), and the break-out tab is
    // bound by that rule exactly as the Classification section is.
    const tabs = buildTabs(
      item,
      ALL,
      new Set(['custom-fields'] as FeatureId[]),
      { ...NO_SECTION_PRESENCE, customFields: true },
      prominence('own-tab', 'Film details'),
    );
    const section = tabs.find((t) => t.id === 'custom-fields')?.sections[0];
    expect(section?.title).toBe('Custom fields');
    expect(section?.shownDespiteHidden).toBe(true);
  });

  it('keeps Classification alive on its remaining sections when the fields break out', () => {
    // `custom-fields` gates Capabilities too, so losing Tags and the fields still leaves it
    // something to show.
    const tabs = buildTabs(
      item,
      without('tags-attachments'),
      NONE,
      NO_SECTION_PRESENCE,
      prominence('own-tab'),
    );
    expect(sectionTitles(tabs, 'classification')).toEqual(['Capabilities']);
    expect(tabIds(tabs)).toContain('custom-fields');
  });

  it('drops the Classification tab entirely when the fields leave and nothing else survives', () => {
    // The invariant most at risk from removing the section at construction time rather than
    // letting the filter drop it: Classification must not linger as an empty tab once the fields
    // have gone. Here the category hides both its capabilities and only the fields hold data, so
    // they alone are rescued — into the break-out tab.
    const tabs = buildTabs(
      item,
      ALL,
      new Set(['custom-fields', 'tags-attachments'] as FeatureId[]),
      { ...NO_SECTION_PRESENCE, customFields: true },
      prominence('own-tab', 'Film details'),
    );
    expect(tabIds(tabs)).not.toContain('classification');
    expect(tabIds(tabs)).toContain('custom-fields');
    expect(sectionTitles(tabs, 'custom-fields')).toEqual(['Custom fields']);
  });

  it('keeps Details first in every mode, so the rail never opens somewhere unexpected', () => {
    for (const mode of ['default', 'promoted', 'own-tab'] as const) {
      expect(tabIds(buildTabs(item, ALL, NONE, NO_SECTION_PRESENCE, prominence(mode)))[0], mode).toBe(
        'details',
      );
    }
  });

  it('never mutates the item it is given', () => {
    const snapshot = structuredClone(item);
    buildTabs(item, ALL, NONE, NO_SECTION_PRESENCE, prominence('own-tab', 'Film details'));
    expect(item).toEqual(snapshot);
  });
});
