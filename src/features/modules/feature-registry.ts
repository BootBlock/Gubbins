/**
 * Feature registry — the single source of truth for the Modular UI feature set
 * (modular-ui-plan §2.1).
 *
 * Every optional page and cross-cutting capability the user can hide is declared here,
 * once. The pure dependency engine (`modules-graph.ts`), the device-local intent store
 * (`useModulesStore.ts`), the read hooks (`useFeature.ts`) and the presets (`presets.ts`)
 * all hang off this list — mirroring the codebase's established "one SSOT array + pure
 * maths over it" seam (`nav-destinations.ts`, `dashboard-layout.ts`). A feature is added
 * by adding a `FeatureDef` here and nowhere else; the registry-integrity unit tests then
 * assert the graph stays acyclic and every route/nav mapping lines up.
 */
import type { LucideIcon } from '@/components/icons';
import {
  AlertIcon,
  AssemblyIcon,
  BatchIcon,
  BookingIcon,
  CapabilityIcon,
  CloudIcon,
  ContactsIcon,
  CycleCountIcon,
  DueDateIcon,
  ExpiryIcon,
  ExtensionIcon,
  HistoryIcon,
  HomeIcon,
  ImageIcon,
  InfoIcon,
  MaintenanceIcon,
  NfcIcon,
  PackageIcon,
  PrintIcon,
  ProjectIcon,
  ReportIcon,
  SaleIcon,
  ScanIcon,
  ScrapeIcon,
  SettingsIcon,
  ShoppingCartIcon,
  SupplierIcon,
  TagsIcon,
  UsersIcon,
  VariantIcon,
  WarrantyIcon,
  WebhookIcon,
} from '@/components/icons';
import type { AppRoutePath } from '@/components/nav/nav-destinations';

/**
 * A feature is either a **top-level page** (a whole screen behind a route) or a
 * cross-cutting **capability** (a sub-feature woven through several screens — e.g.
 * maintenance tracking, batches/lots). Both are toggled the same way; the kind only
 * informs how the manager UI presents them and whether a `route` is expected.
 */
export type FeatureKind = 'page' | 'capability';

/**
 * Visual grouping in the Modules manager screen (a light hierarchy, not separate
 * routers). `core` is the always-on essentials; `pages` and `integrations` are optional
 * screens; `capabilities` are the cross-cutting sub-features.
 */
export type FeatureGroup = 'core' | 'pages' | 'capabilities' | 'integrations';

/** The groups in display order, for rendering the manager UI's sections. */
export const FEATURE_GROUP_ORDER: readonly FeatureGroup[] = ['core', 'pages', 'capabilities', 'integrations'];

/**
 * Stable feature keys. These strings are persisted (as `useModulesStore` intent) and
 * referenced by nav/widget/tab gating, so they must never change once shipped — treat
 * them like a public enum. Renaming one is a breaking change to persisted device state.
 */
export type FeatureId =
  // Core — can never be hidden (`alwaysOn`).
  | 'dashboard'
  | 'inventory'
  | 'settings'
  | 'about'
  | 'users'
  // Optional page modules.
  | 'projects'
  | 'purchase-orders'
  | 'suppliers'
  | 'contacts'
  | 'bookings'
  | 'upcoming'
  | 'activity'
  | 'reports'
  | 'alerts'
  | 'sync'
  | 'home-assistant'
  | 'webhooks'
  // Optional capabilities (cross-cutting sub-features).
  | 'maintenance'
  | 'warranty'
  | 'batches'
  | 'scanner'
  | 'nfc'
  | 'custom-fields'
  | 'perishables'
  | 'cycle-counts'
  | 'location-photos'
  | 'tags-attachments'
  | 'variants'
  | 'kits'
  | 'labels'
  | 'sales'
  | 'scraping';

export interface FeatureDef {
  /** Stable key, e.g. `'projects'`. Persisted — see {@link FeatureId}. */
  readonly id: FeatureId;
  readonly kind: FeatureKind;
  /** Short human label, e.g. "Purchase orders". */
  readonly label: string;
  /** One-line description, shown in the manager list and the "module hidden" interstitial. */
  readonly description: string;
  readonly Icon: LucideIcon;
  /** Grouping in the manager UI. */
  readonly group: FeatureGroup;
  /** The route this page lives behind. Page features only; capabilities have no route. */
  readonly route?: AppRoutePath;
  /**
   * Features that must be effectively-on for this one to be usable. The dependency graph
   * is acyclic (asserted by a unit test). Turning a dependency off cascades this feature
   * off too; turning this on offers to enable its missing dependencies (§2.3).
   */
  readonly dependsOn?: readonly FeatureId[];
  /** Core essentials that can never be hidden (dashboard/inventory/settings/about). */
  readonly alwaysOn?: boolean;
  /**
   * **Opt-in**: a feature with no stored intent reads as *off* rather than on.
   *
   * The registry's default is everything-on, so that a new module appears for existing
   * installs rather than hiding silently. That default is wrong for a feature which changes
   * how the whole app behaves the moment it switches on — `users` gates the app behind a
   * sign-in — where inheriting "on" would enable it for every existing install on upgrade.
   * Such a feature must be chosen, so it declares itself opt-in here and the `everything`
   * preset leaves it alone (see `presets.ts`).
   */
  readonly defaultOff?: boolean;
}

/**
 * The registry, keyed by id. Typing it as `Record<FeatureId, FeatureDef>` makes coverage a
 * **compile-time** guarantee: adding a member to {@link FeatureId} without a definition here
 * (or a typo'd key) is a type error, so a feature can never be declared-but-unregistered —
 * which would otherwise leave it silently un-toggleable (never in the resolved enabled set).
 * The public {@link FEATURE_REGISTRY} array is derived from this; insertion order (core →
 * pages → capabilities → integrations) is preserved, and the manager UI groups by `group`
 * rather than relying on order.
 */
const FEATURE_DEFS: Record<FeatureId, FeatureDef> = {
  // ── Core (always on) ────────────────────────────────────────────────────────
  dashboard: {
    id: 'dashboard',
    kind: 'page',
    label: 'Dashboard',
    description: 'The landing overview with your customisable widget board.',
    Icon: HomeIcon,
    group: 'core',
    route: '/',
    alwaysOn: true,
  },
  inventory: {
    id: 'inventory',
    kind: 'page',
    label: 'Inventory',
    description: 'Your items, locations and stock — the heart of the app.',
    Icon: PackageIcon,
    group: 'core',
    route: '/inventory',
    alwaysOn: true,
  },
  settings: {
    id: 'settings',
    kind: 'page',
    label: 'Settings',
    description: 'Preferences, appearance and app configuration.',
    Icon: SettingsIcon,
    group: 'core',
    route: '/settings',
    alwaysOn: true,
  },
  about: {
    id: 'about',
    kind: 'page',
    label: 'About',
    description: 'App version, credits and project information.',
    Icon: InfoIcon,
    group: 'core',
    route: '/about',
    alwaysOn: true,
  },
  users: {
    id: 'users',
    kind: 'page',
    label: 'Users',
    description: 'Sign in as a named person, attribute every change to them, and limit what each one may do.',
    Icon: UsersIcon,
    group: 'core',
    route: '/users',
    // Opt-in, unlike every other module: switching this on puts a sign-in in front of the app
    // and starts enforcing permissions, so it must be a decision rather than an inherited
    // default (plan §3 — Gubbins behaves exactly as it always has until this is chosen).
    defaultOff: true,
  },

  // ── Optional page modules ───────────────────────────────────────────────────
  projects: {
    id: 'projects',
    kind: 'page',
    label: 'Projects',
    description: 'Group items into projects with bills of materials and budgets.',
    Icon: ProjectIcon,
    group: 'pages',
    route: '/projects',
  },
  'purchase-orders': {
    id: 'purchase-orders',
    kind: 'page',
    label: 'Purchase orders',
    description: 'Track orders and incoming stock from your suppliers.',
    Icon: ShoppingCartIcon,
    group: 'pages',
    route: '/purchase-orders',
    dependsOn: ['contacts'],
  },
  suppliers: {
    id: 'suppliers',
    kind: 'page',
    label: 'Suppliers',
    description: 'Keep one canonical list of who you buy from, and fold duplicates together.',
    Icon: SupplierIcon,
    group: 'pages',
    route: '/suppliers',
    // Suppliers are referenced by supplier parts (inventory) as well as by orders, so the
    // dictionary stands on its own rather than depending on the Purchase orders module — an
    // inventory-only setup still records who a part is bought from.
  },
  contacts: {
    id: 'contacts',
    kind: 'page',
    label: 'Contacts',
    description: 'People and suppliers you borrow from, lend to or buy from.',
    Icon: ContactsIcon,
    group: 'pages',
    route: '/contacts',
  },
  bookings: {
    id: 'bookings',
    kind: 'page',
    label: 'Bookings',
    description: 'Reserve items for a contact over a date range.',
    Icon: BookingIcon,
    group: 'pages',
    route: '/bookings',
    dependsOn: ['contacts'],
  },
  upcoming: {
    id: 'upcoming',
    kind: 'page',
    label: 'Upcoming',
    description: 'A unified agenda of everything due — bookings, returns, servicing and more.',
    Icon: DueDateIcon,
    group: 'pages',
    route: '/upcoming',
  },
  activity: {
    id: 'activity',
    kind: 'page',
    label: 'Activity',
    description: 'The chronological ledger of every change made to your inventory.',
    Icon: HistoryIcon,
    group: 'pages',
    route: '/activity',
  },
  reports: {
    id: 'reports',
    kind: 'page',
    label: 'Reports',
    description: 'Valuation, spend and stock insights across your inventory.',
    Icon: ReportIcon,
    group: 'pages',
    route: '/reports',
  },
  alerts: {
    id: 'alerts',
    kind: 'page',
    label: 'Alerts',
    description: 'Everything that needs attention — low stock, expiries and overdue items.',
    Icon: AlertIcon,
    group: 'pages',
    route: '/alerts',
  },

  // ── Optional capabilities (cross-cutting sub-features) ──────────────────────
  maintenance: {
    id: 'maintenance',
    kind: 'capability',
    label: 'Maintenance & servicing',
    description: 'Schedule and log servicing for tools and equipment.',
    Icon: MaintenanceIcon,
    group: 'capabilities',
  },
  warranty: {
    id: 'warranty',
    kind: 'capability',
    label: 'Warranty & depreciation',
    description: 'Track warranties, asset lifecycle and depreciation.',
    Icon: WarrantyIcon,
    group: 'capabilities',
  },
  batches: {
    id: 'batches',
    kind: 'capability',
    label: 'Batches & lots',
    description: 'Track stock by batch/lot with first-expiry-first-out consumption.',
    Icon: BatchIcon,
    group: 'capabilities',
  },
  scanner: {
    id: 'scanner',
    kind: 'capability',
    label: 'Live camera scanning',
    description: 'Scan barcodes and QR codes with your device camera. Printed labels stay regardless.',
    Icon: ScanIcon,
    group: 'capabilities',
  },
  nfc: {
    id: 'nfc',
    kind: 'capability',
    label: 'NFC tags',
    description:
      'Tap an NFC tag to scan an item, and write item links to blank tags. Supported devices only (Android).',
    Icon: NfcIcon,
    group: 'capabilities',
  },
  'custom-fields': {
    id: 'custom-fields',
    kind: 'capability',
    label: 'Custom fields & capabilities',
    description: 'Add your own fields and weighted capabilities to items.',
    Icon: CapabilityIcon,
    group: 'capabilities',
  },
  perishables: {
    id: 'perishables',
    kind: 'capability',
    label: 'Expiry tracking',
    description: 'Track expiry dates and surface items before they lapse.',
    Icon: ExpiryIcon,
    group: 'capabilities',
  },
  'cycle-counts': {
    id: 'cycle-counts',
    kind: 'capability',
    label: 'Cycle counts',
    description: 'Periodic stock-taking to keep on-hand quantities honest.',
    Icon: CycleCountIcon,
    group: 'capabilities',
  },
  'location-photos': {
    id: 'location-photos',
    kind: 'capability',
    label: 'Location photos',
    description:
      'Add photos to a location and mark out regions on them, so an item can point at exactly where it sits.',
    Icon: ImageIcon,
    group: 'capabilities',
  },
  'tags-attachments': {
    id: 'tags-attachments',
    kind: 'capability',
    label: 'Tags & attachments',
    description: 'Tag items and link datasheets or other attachments.',
    Icon: TagsIcon,
    group: 'capabilities',
  },
  variants: {
    id: 'variants',
    kind: 'capability',
    label: 'Variants & SKUs',
    description: 'Link parent items to child variants — sizes, colours or values of one part.',
    Icon: VariantIcon,
    group: 'capabilities',
  },
  kits: {
    id: 'kits',
    kind: 'capability',
    label: 'Kits & bundles',
    description: 'Define an item as a kit of other items and see how many you can build.',
    Icon: AssemblyIcon,
    group: 'capabilities',
  },
  labels: {
    id: 'labels',
    kind: 'capability',
    label: 'Label printing',
    description: 'Print QR/barcode labels for items and locations. Live camera scanning is separate.',
    Icon: PrintIcon,
    group: 'capabilities',
  },
  sales: {
    id: 'sales',
    kind: 'capability',
    label: 'Sales & disposals',
    description: 'Record items sold or written off, with a sales & margin report.',
    Icon: SaleIcon,
    group: 'capabilities',
  },
  scraping: {
    id: 'scraping',
    kind: 'capability',
    label: 'Product & supplier lookup',
    description:
      'Fill item details from a barcode (online, or via the companion extension) and supplier prices from a supplier page.',
    Icon: ScrapeIcon,
    group: 'capabilities',
  },

  // ── Integrations (optional pages, grouped apart) ────────────────────────────
  sync: {
    id: 'sync',
    kind: 'page',
    label: 'Sync',
    description: 'Back up and sync your data across devices.',
    Icon: CloudIcon,
    group: 'integrations',
    route: '/sync',
  },
  webhooks: {
    id: 'webhooks',
    kind: 'page',
    label: 'Webhooks',
    description: 'Call a URL of your choosing when something changes. Delivered by the bridge.',
    Icon: WebhookIcon,
    group: 'integrations',
    route: '/webhooks',
  },
  'home-assistant': {
    id: 'home-assistant',
    kind: 'page',
    label: 'Home Assistant',
    description: 'Connect Gubbins to Home Assistant for voice and automation.',
    Icon: ExtensionIcon,
    group: 'integrations',
    route: '/home-assistant',
  },
};

/**
 * The public registry array, in declaration order. Derived from {@link FEATURE_DEFS} so the
 * SSOT is defined exactly once; consumers that only need to iterate use this.
 */
export const FEATURE_REGISTRY: readonly FeatureDef[] = Object.values(FEATURE_DEFS);

/**
 * The full set of registered feature ids (every {@link FeatureId} appears exactly once).
 *
 * @internal Exported for unit tests only.
 */
export const ALL_FEATURE_IDS: readonly FeatureId[] = FEATURE_REGISTRY.map((f) => f.id);

/** The optional (non-core) feature ids — the ones a preset or toggle can turn off. */
export const OPTIONAL_FEATURE_IDS: readonly FeatureId[] = FEATURE_REGISTRY.filter((f) => !f.alwaysOn).map(
  (f) => f.id,
);

/**
 * The optional features a preset may switch **on**: every {@link OPTIONAL_FEATURE_IDS} bar the
 * opt-in ones. "Everything" means every feature the app offers by default — an opt-in module
 * changes how the whole app behaves, so sweeping it on as part of a preset would be exactly the
 * surprise {@link FeatureDef.defaultOff} exists to prevent. Presets still turn opt-in features
 * *off* (see `intentFromEnabled`), which is the safe direction.
 */
export const PRESETABLE_FEATURE_IDS: readonly FeatureId[] = FEATURE_REGISTRY.filter(
  (f) => !f.alwaysOn && !f.defaultOff,
).map((f) => f.id);

/** Look up a feature definition by id, or `undefined` if the id is not registered. */
export function getFeature(id: FeatureId): FeatureDef | undefined {
  return FEATURE_DEFS[id];
}

/**
 * Route → owning feature, derived once from the page features' `route`. Lets a caller
 * that only holds a link target (e.g. a dashboard widget's `to`) discover which feature
 * gates that destination, without re-listing the mapping — the registry stays the SSOT.
 */
const FEATURE_BY_ROUTE: ReadonlyMap<AppRoutePath, FeatureId> = new Map(
  FEATURE_REGISTRY.filter((f): f is FeatureDef & { route: AppRoutePath } => f.route !== undefined).map(
    (f) => [f.route, f.id],
  ),
);

/**
 * The feature that gates a given route, or `undefined` if the path is not a registered
 * page route (e.g. a non-nav utility path, which is never gated). A widget or link whose
 * target resolves to `undefined` here is always reachable.
 */
export function featureForRoute(route: string): FeatureId | undefined {
  return FEATURE_BY_ROUTE.get(route as AppRoutePath);
}
