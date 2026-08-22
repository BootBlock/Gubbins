import type { LucideIcon } from '@/components/icons';
import type { FeatureId } from '@/features/modules/feature-registry';
import type { MessageKey } from '@/features/i18n';
import type { PermissionKey } from '@/features/users/permission-registry';
import {
  AlertIcon,
  BookingIcon,
  CatalogueIcon,
  CloudIcon,
  ContactsIcon,
  DueDateIcon,
  ExtensionIcon,
  HistoryIcon,
  HomeIcon,
  InfoIcon,
  InsuranceScheduleIcon,
  ModulesIcon,
  PackageIcon,
  ProjectIcon,
  ReportIcon,
  SettingsIcon,
  ShoppingCartIcon,
  SupplierIcon,
  TagIcon,
  UsersIcon,
  WebhookIcon,
} from '@/components/icons';

/**
 * Every navigable top-level route, in one place (spec §2.4.2). This is the single
 * source of truth for the global navigation: the {@link AppNav} menu renders it on
 * every screen, and the Dashboard maps it into its quick-nav grid. Adding a screen
 * means adding one entry here — no per-screen header ever hand-lists destinations
 * again (which is exactly how the old headers drifted and left pages unreachable).
 */

/**
 * The literal route paths registered in the route tree (keeps `<Link to>` type-safe).
 *
 * Most entries have a matching {@link NAV_DESTINATIONS} row and Modular UI feature. A few are
 * reachable screens that live *outside* the global nav, so they have no {@link NAV_DESTINATIONS}
 * row — but they are still valid `<Link to>` / navigate targets and (per issue #80) jumpable from
 * the command palette via {@link PALETTE_EXTRA_DESTINATIONS}:
 * - `/catalogue` and `/insurance-schedule` are Reports sub-screens, reached from the Reports page
 *   and gated by the same `reports` feature.
 * - `/modules` is the Modules manager, reached from Settings, the first-run chooser and the
 *   "module hidden" interstitial — never gated, since it is how hidden features are brought back.
 */
export type AppRoutePath =
  | '/'
  | '/inventory'
  | '/projects'
  | '/purchase-orders'
  | '/suppliers'
  | '/reports'
  | '/catalogue'
  | '/insurance-schedule'
  | '/contacts'
  | '/bookings'
  | '/upcoming'
  | '/activity'
  | '/alerts'
  | '/sync'
  | '/home-assistant'
  | '/webhooks'
  | '/settings'
  | '/about'
  | '/users'
  | '/modules'
  | '/tags';

/** Visual grouping in the navigation menu — a light hierarchy, not separate routers. */
export type NavGroup = 'primary' | 'manage' | 'system';

/**
 * A screen the command palette's screen-jump can offer. Every {@link NavDestination} is one,
 * plus the handful of {@link PALETTE_EXTRA_DESTINATIONS} that aren't in the global nav. The
 * palette hides a destination whose {@link feature} is not in the effective-enabled set; a
 * `feature` of `undefined` means "always reachable" (the Modules manager, which is itself how
 * hidden features are turned back on, so it must never be gated away).
 */
export interface PaletteDestination {
  readonly to: AppRoutePath;
  /**
   * The English label — the stable identifier used for command-palette search text and as the
   * i18n fallback (see {@link NavDestination.messageKey} for how the nav rows localise it).
   */
  readonly label: string;
  readonly Icon: LucideIcon;
  /** The Modular UI feature that gates this destination, or `undefined` when always reachable. */
  readonly feature?: FeatureId;
  /**
   * The read permission a signed-in account needs before this screen is offered or rendered
   * (issue #522). `undefined` means the screen carries no read gate — either because it shows
   * nothing a role can withhold (the Dashboard shell, About), because it is this device's own
   * preferences rather than the vault's data (Settings), or because it is the one way back from
   * a hidden module (Modules).
   *
   * This is deliberately *screen*-level, not row-level: the same key also guards the matching
   * route via `PermissionGuard`, so a denied account cannot reach the screen by typing its URL.
   * Reads inside a screen the account may open are not filtered further — the repository layer
   * gates writes, and the database file itself is readable by anyone holding the device.
   */
  readonly permission?: PermissionKey;
}

export interface NavDestination extends PaletteDestination {
  /** i18n key for the displayed nav label (G4); its English value in `en.json` equals {@link label}. */
  readonly messageKey: MessageKey;
  readonly group: NavGroup;
  /**
   * The Modular UI feature this destination belongs to (its `route` maps 1:1 to this
   * entry's {@link to}). The three navigation surfaces — {@link AppNav}, `DashboardNav`
   * and the command palette's screen-jump — hide the row when its feature is not in the
   * effective-enabled set. Core destinations (Dashboard/Inventory/Settings/About) carry it
   * too but are `alwaysOn`, so they never disappear. This annotation is asserted against
   * `FEATURE_REGISTRY` by a registry-integrity test, so the route↔feature pairing can't
   * drift — the registry stays the SSOT for the mapping. Required for nav rows (unlike the
   * optional {@link PaletteDestination.feature} it narrows).
   */
  readonly feature: FeatureId;
}

export const NAV_DESTINATIONS: readonly NavDestination[] = [
  // Primary — the everyday workspaces.
  {
    to: '/',
    label: 'Dashboard',
    messageKey: 'nav.dashboard',
    Icon: HomeIcon,
    group: 'primary',
    feature: 'dashboard',
  },
  {
    to: '/inventory',
    label: 'Inventory',
    messageKey: 'nav.inventory',
    Icon: PackageIcon,
    group: 'primary',
    feature: 'inventory',
    permission: 'items:read',
  },
  {
    to: '/projects',
    label: 'Projects',
    messageKey: 'nav.projects',
    Icon: ProjectIcon,
    group: 'primary',
    feature: 'projects',
    permission: 'projects:read',
  },
  {
    to: '/purchase-orders',
    label: 'Purchase orders',
    messageKey: 'nav.purchaseOrders',
    Icon: ShoppingCartIcon,
    group: 'primary',
    feature: 'purchase-orders',
    permission: 'purchase-orders:read',
  },
  {
    to: '/suppliers',
    label: 'Suppliers',
    messageKey: 'nav.suppliers',
    Icon: SupplierIcon,
    group: 'primary',
    feature: 'suppliers',
    permission: 'suppliers:read',
  },
  {
    to: '/reports',
    label: 'Reports',
    messageKey: 'nav.reports',
    Icon: ReportIcon,
    group: 'primary',
    feature: 'reports',
    permission: 'reports:read',
  },
  // Manage — people, time and what needs attention.
  {
    to: '/contacts',
    label: 'Contacts',
    messageKey: 'nav.contacts',
    Icon: ContactsIcon,
    group: 'manage',
    feature: 'contacts',
    permission: 'contacts:read',
  },
  {
    to: '/bookings',
    label: 'Bookings',
    messageKey: 'nav.bookings',
    Icon: BookingIcon,
    group: 'manage',
    feature: 'bookings',
    permission: 'bookings:read',
  },
  {
    to: '/upcoming',
    label: 'Upcoming',
    messageKey: 'nav.upcoming',
    Icon: DueDateIcon,
    group: 'manage',
    feature: 'upcoming',
  },
  {
    to: '/activity',
    label: 'Activity',
    messageKey: 'nav.activity',
    Icon: HistoryIcon,
    group: 'manage',
    feature: 'activity',
    permission: 'audit:view',
  },
  {
    to: '/alerts',
    label: 'Alerts',
    messageKey: 'nav.alerts',
    Icon: AlertIcon,
    group: 'manage',
    feature: 'alerts',
  },
  // System — sync, preferences and app info.
  {
    to: '/sync',
    label: 'Sync',
    messageKey: 'nav.sync',
    Icon: CloudIcon,
    group: 'system',
    feature: 'sync',
    permission: 'sync:read',
  },
  {
    to: '/webhooks',
    label: 'Webhooks',
    messageKey: 'nav.webhooks',
    Icon: WebhookIcon,
    group: 'system',
    feature: 'webhooks',
    permission: 'bridge:read',
  },
  {
    to: '/home-assistant',
    label: 'Home Assistant',
    messageKey: 'nav.homeAssistant',
    Icon: ExtensionIcon,
    group: 'system',
    feature: 'home-assistant',
    permission: 'bridge:read',
  },
  {
    to: '/users',
    label: 'Users',
    messageKey: 'nav.users',
    Icon: UsersIcon,
    group: 'system',
    feature: 'users',
    permission: 'users:read',
  },
  {
    to: '/settings',
    label: 'Settings',
    messageKey: 'nav.settings',
    Icon: SettingsIcon,
    group: 'system',
    feature: 'settings',
  },
  {
    to: '/about',
    label: 'About',
    messageKey: 'nav.about',
    Icon: InfoIcon,
    group: 'system',
    feature: 'about',
  },
];

/**
 * Screens the command palette can jump to that are **not** top-level nav destinations, so they
 * have no {@link NAV_DESTINATIONS} row (issue #80 — every screen reachable from the palette):
 *
 * - **Catalogue** and **Insurance schedule** are Reports sub-screens, reached from the Reports
 *   page and gated by the same `reports` feature — so they vanish from the palette exactly when
 *   Reports is switched off in the module manager.
 * - **Modules** is the module manager itself, reached from Settings / first-run. It carries no
 *   feature gate (`feature` omitted), so it is always jumpable — it is the one screen that must
 *   stay reachable even when everything else is turned off, since it is how they come back.
 *
 * These deliberately omit `messageKey`/`group`: they are not nav rows and the palette renders the
 * English {@link PaletteDestination.label} directly, matching how it already lists nav screens.
 */
export const PALETTE_EXTRA_DESTINATIONS: readonly PaletteDestination[] = [
  {
    to: '/catalogue',
    label: 'Catalogue',
    Icon: CatalogueIcon,
    feature: 'reports',
    permission: 'reports:read',
  },
  {
    to: '/insurance-schedule',
    label: 'Insurance schedule',
    Icon: InsuranceScheduleIcon,
    feature: 'reports',
    permission: 'reports:read',
  },
  { to: '/modules', label: 'Manage modules', Icon: ModulesIcon },
  // The tag dictionary manager (issue #84), reached from an item/location's tag editor and the
  // palette. No module gate — tags are a core inventory concept — but a role that cannot read
  // tags has no business in the dictionary that defines them.
  { to: '/tags', label: 'Manage tags', Icon: TagIcon, permission: 'tags:read' },
];

/**
 * Every screen the command palette's screen-jump can offer: the global nav destinations plus the
 * off-nav {@link PALETTE_EXTRA_DESTINATIONS}. The palette filters this by the effective-enabled
 * feature set (a destination with no `feature` is always kept).
 */
export const PALETTE_DESTINATIONS: readonly PaletteDestination[] = [
  ...NAV_DESTINATIONS,
  ...PALETTE_EXTRA_DESTINATIONS,
];

/** The groups in display order, for rendering separators between them. */
export const NAV_GROUP_ORDER: readonly NavGroup[] = ['primary', 'manage', 'system'];

/**
 * Routes that are **not** navigable destinations — no nav row, no palette entry — but still put a
 * gated subject's records on screen, so the route guard has to know about them anyway.
 *
 * `/deep-link` is the `web+gubbins:` protocol-handler landing: it loads an item by id and opens
 * its full detail dialog, which is the same record `/inventory` shows. `/share-target` is the Web
 * Share Target landing, which creates an item from the shared payload. Both are reached by URL
 * from outside the app, which is precisely the door a hidden nav row does not close.
 *
 * The other off-nav routes are deliberately absent: `/import` and `/lab` write or configure rather
 * than disclose, and the repository layer already refuses a write the role may not make.
 */
const OFF_NAV_ROUTE_PERMISSIONS: readonly (readonly [string, PermissionKey])[] = [
  ['/deep-link', 'items:read'],
  ['/share-target', 'items:write'],
];

/**
 * The read permission each route requires, keyed by path (issue #522).
 *
 * Derived from {@link PALETTE_DESTINATIONS} rather than written out a second time, so a screen
 * cannot be hidden from the navigation while still answering to its own URL — the nav surfaces
 * and the route guard read one list — plus the off-nav routes above. A path absent from this map
 * carries no read gate.
 *
 * Keys are lower-cased because the router matches static segments case-insensitively: `/Activity`
 * renders the Activity screen, so an exact-case lookup would let it past the gate. Every path
 * here is already lower-case; the normalisation is stated rather than assumed.
 */
export const ROUTE_PERMISSIONS: ReadonlyMap<string, PermissionKey> = new Map(
  [
    ...PALETTE_DESTINATIONS.flatMap((d) => (d.permission ? [[d.to as string, d.permission] as const] : [])),
    ...OFF_NAV_ROUTE_PERMISSIONS,
  ].map(([path, key]) => [path.toLowerCase(), key] as const),
);
