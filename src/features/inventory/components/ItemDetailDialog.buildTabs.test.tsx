import { describe, it, expect } from 'vitest';
import type { Item } from '@/db/repositories';
import { ALL_FEATURE_IDS, type FeatureId } from '@/features/modules/feature-registry';
import { buildTabs } from './ItemDetailDialog';

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
const sectionTitles = (tabs: ReturnType<typeof buildTabs>, tabId: string) =>
  (tabs.find((t) => t.id === tabId)?.sections ?? []).map((s) => s.title);

describe('buildTabs — feature gating (Phase 6)', () => {
  it('shows every facet with the full feature set enabled', () => {
    const tabs = buildTabs(item, ALL);
    expect(tabIds(tabs)).toEqual(['details', 'supplier', 'lifecycle', 'media', 'classification', 'activity']);
    expect(sectionTitles(tabs, 'lifecycle')).toEqual([
      'Lifecycle & variants',
      'Asset details',
      'Maintenance',
    ]);
    expect(sectionTitles(tabs, 'classification')).toEqual(['Tags', 'Capabilities', 'Custom fields']);
    expect(sectionTitles(tabs, 'media')).toEqual(['Images', 'Datasheets']);
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
