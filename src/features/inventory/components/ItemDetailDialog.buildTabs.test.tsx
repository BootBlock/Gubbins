import { describe, it, expect } from 'vitest';
import type { Item } from '@/db/repositories';
import { NO_SECTION_PRESENCE } from '@/db/repositories';
import { ALL_FEATURE_IDS, type FeatureId } from '@/features/modules/feature-registry';
import { buildTabs } from './ItemDetailDialog';

/** The category hides nothing — the shape `buildTabs` defaults to, spelled out where it matters. */
const NOTHING_HIDDEN: ReadonlySet<FeatureId> = new Set<FeatureId>();

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

  it('omits "Fill from a database" unless the category offers a lookup (issue #616)', () => {
    // Every other section owns an editor that reads sensibly empty, so it can render its card and
    // let the editor say "nothing yet". This one renders nothing at all when no provider is
    // attached, and `Section` draws its card — border, icon, title, help badge — before it reaches
    // its children. Emitting it unconditionally would put a permanently-empty card promising a
    // feature the category hasn't got on the Classification tab of *every* item.
    expect(sectionTitles(buildTabs(item, ALL), 'classification')).not.toContain('Fill from a database');
    expect(
      sectionTitles(buildTabs(item, ALL, NOTHING_HIDDEN, NO_SECTION_PRESENCE, false), 'classification'),
    ).not.toContain('Fill from a database');
  });

  it('shows "Fill from a database" when the category does offer one, gated by scraping', () => {
    const offered = buildTabs(item, ALL, NOTHING_HIDDEN, NO_SECTION_PRESENCE, true);
    expect(sectionTitles(offered, 'classification')).toEqual([
      'Tags',
      'Capabilities',
      'Custom fields',
      'Fill from a database',
    ]);
    // Still a capability-gated section: switching the device's module off drops it again.
    const scrapingOff = buildTabs(item, without('scraping'), NOTHING_HIDDEN, NO_SECTION_PRESENCE, true);
    expect(sectionTitles(scrapingOff, 'classification')).toEqual(['Tags', 'Capabilities', 'Custom fields']);
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
