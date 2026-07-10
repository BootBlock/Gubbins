import type { LucideIcon } from '@/components/icons';
import type { FeatureId } from '@/features/modules/feature-registry';
import type { MessageKey } from '@/features/i18n';
import {
  AlertIcon,
  BookingIcon,
  CloudIcon,
  ContactsIcon,
  DueDateIcon,
  ExtensionIcon,
  HistoryIcon,
  HomeIcon,
  InfoIcon,
  PackageIcon,
  ProjectIcon,
  ReportIcon,
  SettingsIcon,
  ShoppingCartIcon,
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
 * Most entries have a matching {@link NAV_DESTINATIONS} row and Modular UI feature. The
 * Modules manager (`/modules`) is the deliberate exception: it is reached from Settings,
 * the first-run chooser and the "module hidden" interstitial — never the global nav — so
 * it is a valid `<Link to>` target here without a nav row or a `feature` annotation.
 */
export type AppRoutePath =
  | '/'
  | '/inventory'
  | '/projects'
  | '/purchase-orders'
  | '/reports'
  | '/contacts'
  | '/bookings'
  | '/upcoming'
  | '/activity'
  | '/alerts'
  | '/sync'
  | '/home-assistant'
  | '/settings'
  | '/about'
  | '/modules';

/** Visual grouping in the navigation menu — a light hierarchy, not separate routers. */
export type NavGroup = 'primary' | 'manage' | 'system';

export interface NavDestination {
  readonly to: AppRoutePath;
  /**
   * The English label — the stable identifier used for command-palette search text and as the
   * i18n fallback. The *displayed* label is `t(messageKey)`, so a translated UI shows the
   * localized text while this English string keeps searching/testing deterministic.
   */
  readonly label: string;
  /** i18n key for the displayed nav label (G4); its English value in `en.json` equals {@link label}. */
  readonly messageKey: MessageKey;
  readonly Icon: LucideIcon;
  readonly group: NavGroup;
  /**
   * The Modular UI feature this destination belongs to (its `route` maps 1:1 to this
   * entry's {@link to}). The three navigation surfaces — {@link AppNav}, `DashboardNav`
   * and the command palette's screen-jump — hide the row when its feature is not in the
   * effective-enabled set. Core destinations (Dashboard/Inventory/Settings/About) carry it
   * too but are `alwaysOn`, so they never disappear. This annotation is asserted against
   * `FEATURE_REGISTRY` by a registry-integrity test, so the route↔feature pairing can't
   * drift — the registry stays the SSOT for the mapping.
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
  },
  {
    to: '/projects',
    label: 'Projects',
    messageKey: 'nav.projects',
    Icon: ProjectIcon,
    group: 'primary',
    feature: 'projects',
  },
  {
    to: '/purchase-orders',
    label: 'Purchase orders',
    messageKey: 'nav.purchaseOrders',
    Icon: ShoppingCartIcon,
    group: 'primary',
    feature: 'purchase-orders',
  },
  {
    to: '/reports',
    label: 'Reports',
    messageKey: 'nav.reports',
    Icon: ReportIcon,
    group: 'primary',
    feature: 'reports',
  },
  // Manage — people, time and what needs attention.
  {
    to: '/contacts',
    label: 'Contacts',
    messageKey: 'nav.contacts',
    Icon: ContactsIcon,
    group: 'manage',
    feature: 'contacts',
  },
  {
    to: '/bookings',
    label: 'Bookings',
    messageKey: 'nav.bookings',
    Icon: BookingIcon,
    group: 'manage',
    feature: 'bookings',
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
  { to: '/sync', label: 'Sync', messageKey: 'nav.sync', Icon: CloudIcon, group: 'system', feature: 'sync' },
  {
    to: '/home-assistant',
    label: 'Home Assistant',
    messageKey: 'nav.homeAssistant',
    Icon: ExtensionIcon,
    group: 'system',
    feature: 'home-assistant',
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

/** The groups in display order, for rendering separators between them. */
export const NAV_GROUP_ORDER: readonly NavGroup[] = ['primary', 'manage', 'system'];
