/**
 * Curated module presets (modular-ui-plan §2.5).
 *
 * A preset is a named starting point offered on the Modules manager and the first-run
 * chooser. Applying one sets intent to `true` for its `featureIds` and `false` for every
 * other optional feature (see `useModulesStore.applyPreset`); the dependency closure is
 * then handled by `resolveEnabled`, so a preset need only list the features it wants —
 * their dependencies come along automatically at read time.
 */
import type { FeatureId } from './feature-registry';
import { PRESETABLE_FEATURE_IDS } from './feature-registry';
import type { LucideIcon } from '@/components/icons';
import {
  CategoryIcon,
  CustomiseIcon,
  ExpiryIcon,
  PackageIcon,
  ProjectIcon,
  ShoppingCartIcon,
  WarrantyIcon,
} from '@/components/icons';

/** Stable preset keys. Referenced by the manager/first-run UI; treat like a public enum. */
export type PresetId =
  | 'everything'
  | 'minimal'
  | 'home-hobby'
  | 'maker-workshop'
  | 'asset-equipment'
  | 'food-pantry'
  | 'collection'
  | 'retail';

export interface Preset {
  readonly id: PresetId;
  readonly label: string;
  readonly description: string;
  readonly Icon: LucideIcon;
  /**
   * The optional features this preset turns on. Every optional feature *not* listed is
   * turned off. Dependencies need not be listed — `resolveEnabled` pulls them in — but
   * listing them keeps the intent explicit and self-documenting.
   */
  readonly featureIds: readonly FeatureId[];
}

export const PRESETS: readonly Preset[] = [
  {
    id: 'everything',
    label: 'Everything',
    description: 'Every page and capability switched on — the full app (the default).',
    Icon: CustomiseIcon,
    // Deliberately not every *optional* feature: an opt-in module (Users) changes how the whole
    // app behaves, so "Everything" must not sweep it on behind the operator's back.
    featureIds: PRESETABLE_FEATURE_IDS,
  },
  {
    id: 'minimal',
    label: 'Minimal',
    description: 'Just the essentials — Dashboard, Inventory, Settings and About.',
    Icon: PackageIcon,
    featureIds: [],
  },
  {
    id: 'home-hobby',
    label: 'Home & hobby',
    description: 'A lean set for personal supplies and household stock.',
    Icon: PackageIcon,
    featureIds: [
      'reports',
      'scanner',
      'nfc',
      'perishables',
      'tags-attachments',
      'alerts',
      'upcoming',
      'labels',
    ],
  },
  {
    id: 'maker-workshop',
    label: 'Maker workshop',
    description: 'Projects, procurement and servicing for a busy workshop.',
    Icon: ProjectIcon,
    featureIds: [
      'projects',
      'purchase-orders',
      'suppliers',
      'contacts',
      'reports',
      'scanner',
      'nfc',
      'maintenance',
      'custom-fields',
      'alerts',
      'upcoming',
      'variants',
      'kits',
      'labels',
      'scraping',
    ],
  },
  {
    id: 'asset-equipment',
    label: 'Asset & equipment',
    description: 'Lending, servicing and lifecycle for tools and equipment.',
    Icon: WarrantyIcon,
    featureIds: [
      'contacts',
      'bookings',
      'maintenance',
      'warranty',
      'reports',
      'alerts',
      'upcoming',
      'labels',
    ],
  },
  {
    id: 'food-pantry',
    label: 'Food & pantry',
    description: 'Best-before dates, batches and low-stock alerts for kitchen and household food.',
    Icon: ExpiryIcon,
    featureIds: ['perishables', 'batches', 'alerts', 'upcoming', 'cycle-counts', 'scanner', 'nfc', 'labels'],
  },
  {
    id: 'collection',
    label: 'Collection',
    description: 'Cataloguing for books, media or memorabilia — rich metadata over procurement.',
    Icon: CategoryIcon,
    featureIds: ['custom-fields', 'tags-attachments', 'reports', 'scanner', 'nfc', 'labels', 'variants'],
  },
  {
    id: 'retail',
    label: 'Retail & stockroom',
    description: 'Purchasing, suppliers and stock accuracy for a small shop or stockroom.',
    Icon: ShoppingCartIcon,
    featureIds: [
      'purchase-orders',
      'suppliers',
      'contacts',
      'reports',
      'alerts',
      'cycle-counts',
      'batches',
      'activity',
      'upcoming',
      'scanner',
      'nfc',
      'kits',
      'labels',
      'sales',
      'scraping',
    ],
  },
];

/** Lookup by id, built once from {@link PRESETS}. */
const PRESET_BY_ID: ReadonlyMap<PresetId, Preset> = new Map(PRESETS.map((p) => [p.id, p]));

/** Look up a preset by id, or `undefined` if unknown. */
export function getPreset(id: PresetId): Preset | undefined {
  return PRESET_BY_ID.get(id);
}
