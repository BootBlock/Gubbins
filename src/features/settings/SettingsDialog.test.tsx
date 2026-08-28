/**
 * Component tests for the Settings dialog's feature gating (Modular UI Phase 7).
 *
 * When a capability is off, its settings must disappear too so no orphaned control is left
 * behind: the whole Scanner section drops (`scanner`), and the "expiring soon" window
 * (`perishables`) and budget-warn threshold (`projects`) rows drop individually — while their
 * Inventory tab keeps the always-present low-stock thresholds (no empty section shell).
 *
 * The dialog is a {@link RailModal}: only the active tab's panel is mounted, so each test
 * clicks into the relevant rail tab before asserting. The dialog's heavy children (router
 * Link, Danger zone, Database maintenance, Storage triage) are stubbed so the test stays in
 * happy-dom with no providers; the preferences and modules stores are the real Zustand stores.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to, ...props }: { children: React.ReactNode; to: string; [k: string]: unknown }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}));
vi.mock('@/features/danger-zone/DangerZone', () => ({ DangerZone: () => null }));
vi.mock('@/features/maintenance', () => ({ DatabaseMaintenance: () => null }));
vi.mock('@/features/storage/StorageTriageDialog', () => ({ StorageTriageDialog: () => null }));
// The card-field picker (E1) fetches the custom-field catalog, so it needs a QueryClient;
// stub it out like the other data-heavy children so this test stays provider-free.
vi.mock('@/features/inventory/components/CardFieldsSetting', () => ({ CardFieldsSetting: () => null }));

import SettingsDialog from './SettingsDialog';
import { useModulesStore } from '@/state/stores/useModulesStore';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';
import { useApplyTheme } from './useApplyTheme';
import { useSessionStore } from '@/state/stores/useSessionStore';
import { UNRESTRICTED_AUTHORITY } from '@/features/users/permissions';

/** Mounts the reactive appearance-sync hook (as the app's composition root does) with no UI. */
function ThemeHost() {
  useApplyTheme();
  return null;
}

/** Open the dialog fresh and click into the named rail tab. */
function renderTab(tabName: string) {
  render(<SettingsDialog open onClose={() => {}} />);
  fireEvent.click(screen.getByRole('tab', { name: tabName }));
}

beforeEach(() => {
  useModulesStore.setState({ intent: {} });
  useSessionStore.setState({ authority: UNRESTRICTED_AUTHORITY });
});
afterEach(() => {
  cleanup();
  useModulesStore.setState({ intent: {} });
  useSessionStore.setState({ authority: UNRESTRICTED_AUTHORITY });
});

describe('SettingsDialog — all features on (default)', () => {
  it('shows the Scanner section, the expiring-soon window and the budget-warn threshold', () => {
    renderTab('Scanning & labels');
    expect(screen.queryByTestId('setting-scanner-symbology')).not.toBeNull();

    cleanup();
    renderTab('Inventory');
    expect(screen.queryByTestId('setting-expiry-days')).not.toBeNull();
    expect(screen.queryByTestId('setting-budget-warn')).not.toBeNull();
  });
});

describe('SettingsDialog — Online product lookup placement (issue #59)', () => {
  it('shows the Online product lookup setting under Scanning & labels', () => {
    renderTab('Scanning & labels');
    expect(screen.queryByTestId('setting-online-product-lookup')).not.toBeNull();
  });

  it('is no longer under Notifications & files', () => {
    renderTab('Notifications & files');
    expect(screen.queryByTestId('setting-online-product-lookup')).toBeNull();
  });

  it('drops the Product lookup section when supplier scraping is off', () => {
    useModulesStore.getState().setFeatureIntent('scraping', false);
    renderTab('Scanning & labels');
    expect(screen.queryByTestId('setting-online-product-lookup')).toBeNull();
  });
});

/**
 * Withdrawing a category lookup's per-host consent (issue #616, phase L2).
 *
 * Consent is granted at the point of use, one host at a time, and this is the only way back out —
 * so the cases that matter are that a granted host is *listed*, that removing it actually clears
 * the stored permission, and that the section cannot become unreachable while a permission is
 * still stored.
 */
describe('SettingsDialog — withdrawing a database-lookup consent (issue #616)', () => {
  beforeEach(() => {
    usePreferencesStore.setState({ lookupConsentHosts: [] });
  });
  afterEach(() => {
    usePreferencesStore.setState({ lookupConsentHosts: [] });
  });

  it('says so plainly when no host has been agreed to', () => {
    renderTab('Scanning & labels');
    expect(screen.getByTestId('setting-lookup-consent-empty')).toBeInTheDocument();
  });

  it('lists each agreed host and withdraws the one asked for', () => {
    usePreferencesStore.setState({ lookupConsentHosts: ['query.wikidata.org', 'www.wikidata.org'] });
    renderTab('Scanning & labels');

    expect(screen.getByTestId('setting-lookup-consent-withdraw-www.wikidata.org')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('setting-lookup-consent-withdraw-www.wikidata.org'));

    expect(usePreferencesStore.getState().lookupConsentHosts).toEqual(['query.wikidata.org']);
    expect(screen.queryByTestId('setting-lookup-consent-withdraw-www.wikidata.org')).toBeNull();
  });

  it('stays reachable while a permission is stored, even with supplier scraping off', () => {
    // A permission the user granted must never become unrevokable because the section offering it
    // was hidden with the capability it belongs to.
    useModulesStore.getState().setFeatureIntent('scraping', false);
    usePreferencesStore.setState({ lookupConsentHosts: ['www.wikidata.org'] });
    renderTab('Scanning & labels');
    expect(screen.getByTestId('setting-lookup-consent-withdraw-www.wikidata.org')).toBeInTheDocument();

    cleanup();
    usePreferencesStore.setState({ lookupConsentHosts: [] });
    renderTab('Scanning & labels');
    expect(screen.queryByTestId('setting-lookup-consent-empty')).toBeNull();
  });
});

describe('SettingsDialog — Live camera scanning off', () => {
  it('drops the whole Scanner section, leaving Labels & QR codes intact', () => {
    useModulesStore.getState().setFeatureIntent('scanner', false);
    renderTab('Scanning & labels');
    expect(screen.queryByTestId('setting-scanner-symbology')).toBeNull();
    expect(screen.queryByTestId('setting-scanner-beep')).toBeNull();
    expect(screen.queryByTestId('setting-scanner-haptics')).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Scanner' })).toBeNull();
    // The Labels & QR codes section stays — printed labels work regardless of the scanner.
    expect(screen.queryByTestId('setting-label-base-url')).not.toBeNull();
  });
});

describe('SettingsDialog — Link host security warning (issue #509)', () => {
  /** Type a host into the Link host field and return the rendered warnings. */
  function typeHost(value: string) {
    renderTab('Scanning & labels');
    fireEvent.change(screen.getByTestId('setting-label-base-url'), { target: { value } });
  }

  it('warns that a plain-http host cannot open the app', () => {
    typeHost('http://gubbins.local');
    expect(screen.queryByTestId('label-base-url-insecure')).not.toBeNull();
    expect(screen.getByTestId('setting-label-base-url')).toHaveAttribute('aria-invalid', 'true');
  });

  it('stays quiet for an https host, and for the localhost a dev server serves', () => {
    typeHost('https://gubbins.local');
    expect(screen.queryByTestId('label-base-url-insecure')).toBeNull();
    cleanup();
    typeHost('http://localhost:5173');
    expect(screen.queryByTestId('label-base-url-insecure')).toBeNull();
  });

  it('promotes a scheme-less host to https, so the preview shows a link that can open', () => {
    typeHost('gubbins.local');
    expect(screen.getByTestId('label-base-url-preview').textContent).toContain('https://gubbins.local/');
    expect(screen.queryByTestId('label-base-url-insecure')).toBeNull();
  });
});

describe('SettingsDialog — Expiry tracking off', () => {
  it('drops the expiring-soon window row but keeps the low-stock thresholds', () => {
    useModulesStore.getState().setFeatureIntent('perishables', false);
    renderTab('Inventory');
    expect(screen.queryByTestId('setting-expiry-days')).toBeNull();
    // The section stays for the always-present low-stock thresholds — no empty section shell.
    expect(screen.queryByTestId('setting-low-stock-qty')).not.toBeNull();
    expect(screen.queryByTestId('setting-low-stock-gauge')).not.toBeNull();
  });
});

describe('SettingsDialog — Projects off', () => {
  it('drops the budget-warn threshold row but keeps the low-stock thresholds', () => {
    useModulesStore.getState().setFeatureIntent('projects', false);
    renderTab('Inventory');
    expect(screen.queryByTestId('setting-budget-warn')).toBeNull();
    expect(screen.queryByTestId('setting-low-stock-qty')).not.toBeNull();
  });
});

describe('SettingsDialog — appearance controls apply to the document', () => {
  afterEach(() => {
    usePreferencesStore.setState({
      mode: 'dark',
      accent: 'violet',
      oledDark: false,
      highContrast: false,
      fullWidth: false,
      animationLevel: 'balanced',
      backgroundEffect: 'none',
      holographicCards: true,
      gamifyCards: true,
    });
    const root = document.documentElement;
    root.classList.remove('dark');
    delete root.dataset.accent;
    delete root.dataset.oled;
    delete root.dataset.contrast;
    delete root.dataset.reduceEffects;
    delete root.dataset.animLevel;
    delete root.dataset.holoCards;
    delete root.dataset.gamifyCards;
  });

  it('mode, colour, OLED and high-contrast controls land on <html>', () => {
    // The composition root's appearance-sync hook is mounted alongside the dialog, so a control
    // flows store → hook → document exactly as it does in the running app.
    render(
      <>
        <ThemeHost />
        <SettingsDialog open onClose={() => {}} />
      </>,
    );
    // Appearance is the default rail tab, so its panel (and the controls) is mounted.
    fireEvent.click(screen.getByRole('tab', { name: 'Appearance' }));
    const root = document.documentElement;

    // Mode: Light drops the .dark class; the two axes are independent.
    fireEvent.click(screen.getByTestId('mode-light'));
    expect(root.classList.contains('dark')).toBe(false);
    fireEvent.click(screen.getByTestId('mode-dark'));
    expect(root.classList.contains('dark')).toBe(true);

    // Colour: sets data-accent, independent of the mode.
    fireEvent.click(screen.getByTestId('accent-blue'));
    expect(root.dataset.accent).toBe('blue');

    // Pure-black (OLED) and High-contrast switches set their data attributes.
    fireEvent.click(screen.getByTestId('setting-oled'));
    fireEvent.click(screen.getByRole('option', { name: 'On' }));
    expect(root.dataset.oled).toBe('');

    fireEvent.click(screen.getByTestId('setting-high-contrast'));
    fireEvent.click(screen.getByRole('option', { name: 'On' }));
    expect(root.dataset.contrast).toBe('high');

    // Animation level: a motion-off tier sets both data-anim-level and the derived
    // data-reduce-effects (the motion clamp the CSS catch-all keys off).
    fireEvent.click(screen.getByTestId('setting-animation-level'));
    fireEvent.click(screen.getByRole('option', { name: 'Calm' }));
    expect(root.dataset.animLevel).toBe('calm');
    expect(root.dataset.reduceEffects).toBe('');
  });

  it('holographic-foil and collector-card switches toggle their <html> flags', () => {
    render(
      <>
        <ThemeHost />
        <SettingsDialog open onClose={() => {}} />
      </>,
    );
    fireEvent.click(screen.getByRole('tab', { name: 'Appearance' }));
    const root = document.documentElement;

    // Both default on, so the flags are present after the sync hook applies the store.
    expect(root.dataset.holoCards).toBe('');
    expect(root.dataset.gamifyCards).toBe('');

    // Switching each Off clears its presence-only flag (the CSS then shows the plain card).
    fireEvent.click(screen.getByTestId('setting-holographic-cards'));
    fireEvent.click(screen.getByRole('option', { name: 'Off' }));
    expect(root.dataset.holoCards).toBeUndefined();

    fireEvent.click(screen.getByTestId('setting-gamify-cards'));
    fireEvent.click(screen.getByRole('option', { name: 'Off' }));
    expect(root.dataset.gamifyCards).toBeUndefined();
  });

  it('background-effect control persists the chosen weather layer to the store', () => {
    // The effect is canvas/JS-driven (not projected onto <html>), so the control's job is simply
    // to persist the choice; the composition-root <BackgroundEffects> reads it from the store.
    render(<SettingsDialog open onClose={() => {}} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Appearance' }));

    expect(usePreferencesStore.getState().backgroundEffect).toBe('none');
    fireEvent.click(screen.getByTestId('setting-background-effect'));
    fireEvent.click(screen.getByRole('option', { name: 'Snow' }));
    expect(usePreferencesStore.getState().backgroundEffect).toBe('snow');
  });

  it('full-width control persists the layout choice to the store (issue #14)', () => {
    // A pure layout concern read by the shared PageContainer frame (not projected onto <html>),
    // so — like the background effect — the control's job is simply to persist the choice.
    render(<SettingsDialog open onClose={() => {}} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Appearance' }));

    expect(usePreferencesStore.getState().fullWidth).toBe(false);
    fireEvent.click(screen.getByTestId('setting-full-width'));
    fireEvent.click(screen.getByRole('option', { name: 'On' }));
    expect(usePreferencesStore.getState().fullWidth).toBe(true);
  });
});

describe('SettingsDialog — reduced-motion notice on Background effect (issue #420)', () => {
  let realMatchMedia: typeof window.matchMedia;

  afterEach(() => {
    window.matchMedia = realMatchMedia;
    usePreferencesStore.setState({ backgroundEffect: 'none' });
  });

  function mockOsReducedMotion(reduced: boolean) {
    realMatchMedia = window.matchMedia;
    window.matchMedia = ((query: string) =>
      ({
        matches: reduced && query.includes('reduced-motion'),
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
      }) as unknown as MediaQueryList) as typeof window.matchMedia;
  }

  it('shows the notice when an effect is chosen and the OS prefers reduced motion', () => {
    mockOsReducedMotion(true);
    usePreferencesStore.setState({ backgroundEffect: 'snow' });
    render(<SettingsDialog open onClose={() => {}} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Appearance' }));

    expect(screen.getByTestId('setting-background-effect-reduced-motion-notice')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /wiki/i })).toHaveAttribute(
      'href',
      expect.stringContaining('Appearance-and-Theming'),
    );
  });

  it('stays hidden when the effect is none, even under OS reduced motion', () => {
    mockOsReducedMotion(true);
    usePreferencesStore.setState({ backgroundEffect: 'none' });
    render(<SettingsDialog open onClose={() => {}} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Appearance' }));

    expect(screen.queryByTestId('setting-background-effect-reduced-motion-notice')).toBeNull();
  });

  it('stays hidden when an effect is chosen but the OS does not prefer reduced motion', () => {
    mockOsReducedMotion(false);
    usePreferencesStore.setState({ backgroundEffect: 'rain' });
    render(<SettingsDialog open onClose={() => {}} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Appearance' }));

    expect(screen.queryByTestId('setting-background-effect-reduced-motion-notice')).toBeNull();
  });
});

describe('SettingsDialog — cross-tab search (issue #133)', () => {
  /** Open the dialog and type into the filter box. */
  function search(query: string) {
    render(<SettingsDialog open onClose={() => {}} />);
    fireEvent.change(screen.getByTestId('settings-search'), { target: { value: query } });
  }

  it('leaves the rail alone until something is typed', () => {
    render(<SettingsDialog open onClose={() => {}} />);
    expect(screen.getByRole('tablist', { name: 'Settings sections' })).toBeInTheDocument();
    expect(screen.queryByTestId('settings-search-results')).toBeNull();
  });

  it('finds a control on a tab other than the one showing, without opening it', () => {
    // Appearance is the tab in view; the purge window lives behind Data & storage.
    search('purge');
    expect(screen.getByTestId('setting-prune-window')).toBeInTheDocument();
    // The rail steps aside while the results span every tab, so no section claims to be selected.
    expect(screen.queryByRole('tablist', { name: 'Settings sections' })).toBeNull();
    // …and the tab the match came from is named above it.
    expect(screen.getByRole('region', { name: 'Data & storage' })).toBeInTheDocument();
  });

  it('drops the rows that do not match, including on the tab that was showing', () => {
    search('purge');
    expect(screen.queryByTestId('setting-oled')).toBeNull();
    expect(screen.queryByTestId('setting-page-size')).toBeNull();
    // A neighbour in the very same section goes too — matching is per row, not per section.
    expect(screen.queryByTestId('setting-label-base-url')).toBeNull();
  });

  it('matches a setting on wording that only appears in its hint', () => {
    // "OLED" is in the label, but "battery" only in the rich hint behind the info badge.
    search('battery');
    expect(screen.getByTestId('setting-oled')).toBeInTheDocument();
  });

  it('honours a term supplied by the section a row sits in', () => {
    search('scanner beep');
    expect(screen.getByTestId('setting-scanner-beep')).toBeInTheDocument();
    expect(screen.queryByTestId('setting-scanner-symbology')).toBeNull();
  });

  it('says so when nothing matches, and restores the rail when the box is cleared', () => {
    search('flux capacitor');
    expect(screen.getByTestId('settings-search-empty')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Clear the settings search' }));
    expect(screen.getByRole('tablist', { name: 'Settings sections' })).toBeInTheDocument();
    expect(screen.getByTestId('setting-oled')).toBeInTheDocument();
  });

  it('never turns up a setting whose feature is switched off', () => {
    useModulesStore.getState().setFeatureIntent('scanner', false);
    search('beep');
    expect(screen.queryByTestId('setting-scanner-beep')).toBeNull();
    expect(screen.getByTestId('settings-search-empty')).toBeInTheDocument();
  });
});

describe('SettingsDialog — nav-tile count pickers (A1/A2)', () => {
  it('shows a metric picker for each configurable tile on the Dashboard tab', () => {
    renderTab('Dashboard');
    // Inventory gained a picker in A2 (total / low-stock / out-of-stock).
    expect(screen.queryByTestId('setting-nav-count-/inventory')).not.toBeNull();
    expect(screen.queryByTestId('setting-nav-count-/projects')).not.toBeNull();
    expect(screen.queryByTestId('setting-nav-count-/purchase-orders')).not.toBeNull();
    expect(screen.queryByTestId('setting-nav-count-/bookings')).not.toBeNull();
  });

  it('drops a tile’s picker when that tile’s feature is switched off', () => {
    useModulesStore.getState().setFeatureIntent('projects', false);
    renderTab('Dashboard');
    expect(screen.queryByTestId('setting-nav-count-/projects')).toBeNull();
    // The other tiles' pickers remain.
    expect(screen.queryByTestId('setting-nav-count-/bookings')).not.toBeNull();
  });

  it('keeps the always-on Inventory picker (and the section) even when the optional tiles are off', () => {
    // Bookings & purchase-orders depend on contacts, so turning contacts + projects off removes
    // those three configurable tiles — but Inventory is `alwaysOn`, so its picker (and the
    // section heading) always remain.
    useModulesStore.getState().setFeatureIntent('projects', false);
    useModulesStore.getState().setFeatureIntent('contacts', false);
    renderTab('Dashboard');
    expect(screen.queryByTestId('setting-nav-count-/projects')).toBeNull();
    expect(screen.queryByTestId('setting-nav-count-/purchase-orders')).toBeNull();
    expect(screen.queryByTestId('setting-nav-count-/bookings')).toBeNull();
    expect(screen.queryByTestId('setting-nav-count-/inventory')).not.toBeNull();
    expect(screen.queryByRole('heading', { name: 'Nav tile counts' })).not.toBeNull();
  });
});

describe('SettingsDialog — permission gating (issue #429)', () => {
  /** Grants only the keys named, so everything else is refused. */
  function granted(...keys: readonly string[]) {
    useSessionStore.setState({ authority: { mode: 'granted', grants: new Set(keys) } });
  }

  it('offers the Data & storage tab to an unrestricted session', () => {
    render(<SettingsDialog open onClose={() => {}} />);
    expect(screen.queryByRole('tab', { name: 'Data & storage' })).not.toBeNull();
  });

  it('drops the Data & storage tab from the rail without storage:read', () => {
    granted('settings:read');
    render(<SettingsDialog open onClose={() => {}} />);
    expect(screen.queryByRole('tab', { name: 'Data & storage' })).toBeNull();
    // The tabs it does not gate are untouched — Appearance is every role's.
    expect(screen.queryByRole('tab', { name: 'Appearance' })).not.toBeNull();
  });

  it('leaves the refused tab out of the cross-tab search too', () => {
    granted('settings:read');
    render(<SettingsDialog open onClose={() => {}} />);
    fireEvent.change(screen.getByTestId('settings-search'), { target: { value: 'purge' } });
    expect(screen.queryByTestId('setting-prune-window')).toBeNull();
  });

  it('lands on the first tab when a stored last-tab points at the refused one', () => {
    granted('settings:read');
    render(<SettingsDialog open onClose={() => {}} initialTab="storage" />);
    expect(screen.getByRole('tab', { name: 'Appearance' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.queryByTestId('setting-prune-window')).toBeNull();
  });

  it('still honours a stored last-tab of Data & storage when it is permitted', () => {
    render(<SettingsDialog open onClose={() => {}} initialTab="storage" />);
    expect(screen.getByRole('tab', { name: 'Data & storage' }).getAttribute('aria-selected')).toBe('true');
  });

  it('hides the Manage modules row for a role that cannot open the manager', () => {
    granted('settings:read');
    renderTab('App');
    expect(screen.queryByTestId('open-modules-settings')).toBeNull();
  });

  it('keeps the Manage modules row for a role that can open the manager', () => {
    granted('settings:read', 'modules:read');
    renderTab('App');
    expect(screen.queryByTestId('open-modules-settings')).not.toBeNull();
  });
});
