import type { LucideIcon } from '@/components/icons';
import {
  AlertIcon,
  BookingIcon,
  CloudIcon,
  ContactsIcon,
  DueDateIcon,
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

/** The literal route paths registered in the route tree (keeps `<Link to>` type-safe). */
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
  | '/settings'
  | '/about';

/** Visual grouping in the navigation menu — a light hierarchy, not separate routers. */
export type NavGroup = 'primary' | 'manage' | 'system';

export interface NavDestination {
  readonly to: AppRoutePath;
  readonly label: string;
  readonly Icon: LucideIcon;
  readonly group: NavGroup;
}

export const NAV_DESTINATIONS: readonly NavDestination[] = [
  // Primary — the everyday workspaces.
  { to: '/', label: 'Dashboard', Icon: HomeIcon, group: 'primary' },
  { to: '/inventory', label: 'Inventory', Icon: PackageIcon, group: 'primary' },
  { to: '/projects', label: 'Projects', Icon: ProjectIcon, group: 'primary' },
  { to: '/purchase-orders', label: 'Purchase orders', Icon: ShoppingCartIcon, group: 'primary' },
  { to: '/reports', label: 'Reports', Icon: ReportIcon, group: 'primary' },
  // Manage — people, time and what needs attention.
  { to: '/contacts', label: 'Contacts', Icon: ContactsIcon, group: 'manage' },
  { to: '/bookings', label: 'Bookings', Icon: BookingIcon, group: 'manage' },
  { to: '/upcoming', label: 'Upcoming', Icon: DueDateIcon, group: 'manage' },
  { to: '/activity', label: 'Activity', Icon: HistoryIcon, group: 'manage' },
  { to: '/alerts', label: 'Alerts', Icon: AlertIcon, group: 'manage' },
  // System — sync, preferences and app info.
  { to: '/sync', label: 'Sync', Icon: CloudIcon, group: 'system' },
  { to: '/settings', label: 'Settings', Icon: SettingsIcon, group: 'system' },
  { to: '/about', label: 'About', Icon: InfoIcon, group: 'system' },
];

/** The groups in display order, for rendering separators between them. */
export const NAV_GROUP_ORDER: readonly NavGroup[] = ['primary', 'manage', 'system'];
