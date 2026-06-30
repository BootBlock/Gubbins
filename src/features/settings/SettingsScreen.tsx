import { type ReactNode, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { Button, Select, Tooltip, buttonVariants, MAIN_CONTENT_ID, useInstallPrompt } from '@/components/foundry';
import {
  AppearanceIcon,
  DarkThemeIcon,
  DatasheetIcon,
  ExpiryIcon,
  InfoIcon,
  InstallIcon,
  KioskIcon,
  LightThemeIcon,
  NotificationIcon,
  PackageIcon,
  ScanIcon,
  SettingsIcon,
  StorageIcon,
  SystemThemeIcon,
} from '@/components/icons';
import { BrandMark } from '@/components/BrandMark';
import { SCANNER_SYMBOLOGY_OPTIONS } from '@/features/scanner/scanner-formats';
import { cn } from '@/lib/utils';
import { usePreferencesStore, type Theme } from '@/state/stores/usePreferencesStore';
import { SettingsSection, SettingRow } from './SettingsSection';
import { DangerZone } from '@/features/danger-zone/DangerZone';
import { StorageTriageDialog } from '@/features/storage/StorageTriageDialog';
import { monthsLabel } from '@/features/storage/triage';
import {
  BUDGET_WARN_BOUNDS,
  CURRENCY_OPTIONS,
  EXPIRY_WINDOW_BOUNDS,
  LOW_STOCK_GAUGE_BOUNDS,
  LOW_STOCK_QTY_BOUNDS,
  THEME_OPTIONS,
  WINDOW_MONTH_OPTIONS,
  clampBudgetWarnPercent,
  clampExpiryWindowDays,
  clampLowStockGaugePercent,
  clampLowStockQty,
} from './settings';

/** Locales offered for formatting (Intl, §2.4.3); en-GB is the default (§1.2.1). */
const LOCALE_OPTIONS = [
  { value: 'en-GB', label: 'English (United Kingdom)' },
  { value: 'en-US', label: 'English (United States)' },
  { value: 'de-DE', label: 'German (Germany)' },
  { value: 'fr-FR', label: 'French (France)' },
] as const;

/**
 * Settings & preferences screen (spec §3, §2.1 Tier-2 `usePreferencesStore`).
 *
 * Surfaces the previously-headless preferences in one place: theme (now applied to
 * the document), base currency & locale, scrape notifications, attachment mode, the
 * "expiring soon" window, and the prune/downgrade windows — plus a permanent
 * entry-point into the Storage Triage dashboard (previously reachable only from the
 * critical/locked storage banner). Each control writes straight to the store, which
 * persists to localStorage and feeds the read layer.
 */
export function SettingsScreen() {
  const prefs = usePreferencesStore();
  const [triageOpen, setTriageOpen] = useState(false);
  const install = useInstallPrompt();

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-3xl flex-col gap-6 px-4 py-6">
      <header className="flex flex-wrap items-center gap-3">
        <Link to="/" className="flex items-center gap-2 text-foreground">
          <BrandMark className="size-9 rounded-xl" />
          <span className="text-lg font-semibold tracking-tight">Gubbins</span>
        </Link>
        <h1 className="flex items-center gap-2 text-lg font-semibold tracking-tight [&_svg]:size-5">
          <SettingsIcon /> Settings
        </h1>
        <Link
          to="/inventory"
          className="ml-auto inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-secondary/60 hover:text-foreground [&_svg]:size-4"
        >
          <PackageIcon />
          Inventory
        </Link>
      </header>

      <main id={MAIN_CONTENT_ID} tabIndex={-1} className="flex flex-1 animate-rise flex-col gap-6 outline-none">
      <SettingsSection icon={<AppearanceIcon />} title="Appearance">
        <SettingRow
          label="Theme"
          description="Switch between the deep dark palette and a light one."
        >
          <ThemeToggle theme={prefs.theme} onChange={prefs.setTheme} />
        </SettingRow>
        <SettingRow label="Base currency" description="Used for all financial tracking and BOM costs.">
          <Select
            aria-label="Base currency"
            data-testid="setting-currency"
            className="h-9 w-56"
            value={prefs.baseCurrency}
            onChange={(e) => prefs.setBaseCurrency(e.target.value)}
          >
            {CURRENCY_OPTIONS.map((c) => (
              <option key={c.value} value={c.value}>
                {c.value} — {c.label}
              </option>
            ))}
          </Select>
        </SettingRow>
        <SettingRow label="Locale" description="Controls date and number formatting.">
          <Select
            aria-label="Locale"
            data-testid="setting-locale"
            className="h-9 w-56"
            value={prefs.locale}
            onChange={(e) => prefs.setLocale(e.target.value)}
          >
            {LOCALE_OPTIONS.map((l) => (
              <option key={l.value} value={l.value}>
                {l.label}
              </option>
            ))}
          </Select>
        </SettingRow>
      </SettingsSection>

      <SettingsSection icon={<InstallIcon />} title="App">
        <SettingRow
          label="Install Gubbins"
          description="Install as an app for offline launch and to protect your inventory from automatic browser eviction."
        >
          {install.installed ? (
            <span className="text-sm text-muted-foreground" data-testid="install-state">
              Installed
            </span>
          ) : install.canInstall ? (
            <Button
              variant="outline"
              data-testid="install-app-settings"
              onClick={() => void install.promptInstall()}
            >
              <InstallIcon />
              Install Gubbins
            </Button>
          ) : (
            <span className="text-sm text-muted-foreground" data-testid="install-state">
              Use your browser&apos;s menu
            </span>
          )}
        </SettingRow>
      </SettingsSection>

      <SettingsSection icon={<KioskIcon />} title="Kiosk &amp; display">
        <SettingRow
          label="Kiosk mode"
          description="For hardwired tablets/dashboards: keep the screen awake and lock dashboard pinch-zoom and text selection."
        >
          <Select
            aria-label="Kiosk mode"
            data-testid="setting-kiosk-mode"
            className="h-9 w-40"
            value={prefs.kioskMode ? 'on' : 'off'}
            onChange={(e) => prefs.setKioskMode(e.target.value === 'on')}
          >
            <option value="off">Off</option>
            <option value="on">On</option>
          </Select>
        </SettingRow>
      </SettingsSection>

      <SettingsSection icon={<NotificationIcon />} title="Notifications">
        <SettingRow
          label="Scrape notifications"
          description="How supplier-scrape updates are announced. Either way the change still applies and is logged."
        >
          <Select
            aria-label="Scrape notifications"
            data-testid="setting-scrape-notifications"
            className="h-9 w-56"
            value={prefs.scrapeNotifications}
            onChange={(e) =>
              prefs.setScrapeNotifications(e.target.value as typeof prefs.scrapeNotifications)
            }
          >
            <option value="TOAST">Show a toast</option>
            <option value="SILENT">Silent</option>
          </Select>
        </SettingRow>
      </SettingsSection>

      <SettingsSection icon={<DatasheetIcon />} title="Attachments &amp; datasheets">
        <SettingRow
          label="Attachment mode"
          description="URLs only, or also link to local files on this device (paths are never synced)."
        >
          <Select
            aria-label="Attachment mode"
            data-testid="setting-attachment-mode"
            className="h-9 w-56"
            value={prefs.attachmentMode}
            onChange={(e) => prefs.setAttachmentMode(e.target.value as typeof prefs.attachmentMode)}
          >
            <option value="URL_ONLY">External URLs only</option>
            <option value="HYBRID">URLs and local file pointers</option>
          </Select>
        </SettingRow>
      </SettingsSection>

      <SettingsSection icon={<ScanIcon />} title="Scanner">
        <SettingRow
          label="Barcode symbology"
          description="Restrict the live scanner to one code type for faster decoding, or scan all supported codes."
        >
          <Select
            aria-label="Barcode symbology"
            data-testid="setting-scanner-symbology"
            className="h-9 w-56"
            value={prefs.scannerSymbology}
            onChange={(e) =>
              prefs.setScannerSymbology(e.target.value as typeof prefs.scannerSymbology)
            }
          >
            {SCANNER_SYMBOLOGY_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
        </SettingRow>
        <SettingRow
          label="Beep on scan"
          description="Play a short confirmation tone after each successful scan (§6.5)."
        >
          <Select
            aria-label="Beep on scan"
            data-testid="setting-scanner-beep"
            className="h-9 w-40"
            value={prefs.scannerBeep ? 'on' : 'off'}
            onChange={(e) => prefs.setScannerBeep(e.target.value === 'on')}
          >
            <option value="on">On</option>
            <option value="off">Off</option>
          </Select>
        </SettingRow>
        <SettingRow
          label="Vibrate on scan"
          description="Give a haptic bump after each successful scan, where the device supports it."
        >
          <Select
            aria-label="Vibrate on scan"
            data-testid="setting-scanner-haptics"
            className="h-9 w-40"
            value={prefs.scannerHaptics ? 'on' : 'off'}
            onChange={(e) => prefs.setScannerHaptics(e.target.value === 'on')}
          >
            <option value="on">On</option>
            <option value="off">Off</option>
          </Select>
        </SettingRow>
      </SettingsSection>

      <SettingsSection icon={<ExpiryIcon />} title="Inventory &amp; lifecycle">
        <SettingRow
          label="“Expiring soon” window"
          description={`How many days before an expiry date a perishable is flagged on the dashboard (${EXPIRY_WINDOW_BOUNDS.min}–${EXPIRY_WINDOW_BOUNDS.max}).`}
        >
          <div className="flex items-center gap-2">
            <input
              aria-label="Expiring soon window (days)"
              data-testid="setting-expiry-days"
              type="number"
              min={EXPIRY_WINDOW_BOUNDS.min}
              max={EXPIRY_WINDOW_BOUNDS.max}
              className="h-9 w-24 rounded-lg border border-border bg-input/40 px-3 text-sm text-foreground shadow-sm outline-none transition-colors focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/40"
              value={prefs.expirySoonWindowDays}
              onChange={(e) => prefs.setExpirySoonWindowDays(clampExpiryWindowDays(Number(e.target.value)))}
            />
            <span className="text-sm text-muted-foreground">days</span>
          </div>
        </SettingRow>
        <SettingRow
          label="Default low-stock quantity threshold"
          description={`The default reorder point for discrete items — those at or below this on-hand quantity are flagged on the dashboard (${LOW_STOCK_QTY_BOUNDS.min}–${LOW_STOCK_QTY_BOUNDS.max}). Any item can override this with its own reorder point on its detail page.`}
        >
          <div className="flex items-center gap-2">
            <input
              aria-label="Low-stock quantity threshold"
              data-testid="setting-low-stock-qty"
              type="number"
              min={LOW_STOCK_QTY_BOUNDS.min}
              max={LOW_STOCK_QTY_BOUNDS.max}
              className="h-9 w-24 rounded-lg border border-border bg-input/40 px-3 text-sm text-foreground shadow-sm outline-none transition-colors focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/40"
              value={prefs.lowStockQtyThreshold}
              onChange={(e) => prefs.setLowStockQtyThreshold(clampLowStockQty(Number(e.target.value)))}
            />
            <span className="text-sm text-muted-foreground">units</span>
          </div>
        </SettingRow>
        <SettingRow
          label="Default low-stock gauge threshold"
          description={`The default reorder level for consumable-gauge items — those at or below this percentage remaining are flagged on the dashboard (${LOW_STOCK_GAUGE_BOUNDS.min}–${LOW_STOCK_GAUGE_BOUNDS.max}). Any item can override this with its own reorder point on its detail page.`}
        >
          <div className="flex items-center gap-2">
            <input
              aria-label="Low-stock gauge threshold"
              data-testid="setting-low-stock-gauge"
              type="number"
              min={LOW_STOCK_GAUGE_BOUNDS.min}
              max={LOW_STOCK_GAUGE_BOUNDS.max}
              className="h-9 w-24 rounded-lg border border-border bg-input/40 px-3 text-sm text-foreground shadow-sm outline-none transition-colors focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/40"
              value={prefs.lowStockGaugePercent}
              onChange={(e) =>
                prefs.setLowStockGaugePercent(clampLowStockGaugePercent(Number(e.target.value)))
              }
            />
            <span className="text-sm text-muted-foreground">%</span>
          </div>
        </SettingRow>
        <SettingRow
          label="Budget warning threshold"
          description={`Projects are flagged on the dashboard once spending reaches this percentage of their budget (${BUDGET_WARN_BOUNDS.min}–${BUDGET_WARN_BOUNDS.max}).`}
        >
          <div className="flex items-center gap-2">
            <input
              aria-label="Budget warning threshold"
              data-testid="setting-budget-warn"
              type="number"
              min={BUDGET_WARN_BOUNDS.min}
              max={BUDGET_WARN_BOUNDS.max}
              className="h-9 w-24 rounded-lg border border-border bg-input/40 px-3 text-sm text-foreground shadow-sm outline-none transition-colors focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/40"
              value={prefs.budgetWarnPercent}
              onChange={(e) => prefs.setBudgetWarnPercent(clampBudgetWarnPercent(Number(e.target.value)))}
            />
            <span className="text-sm text-muted-foreground">%</span>
          </div>
        </SettingRow>
      </SettingsSection>

      <SettingsSection icon={<StorageIcon />} title="Storage">
        <SettingRow
          label="Default purge window"
          description="The history age the Storage Triage tools default to."
        >
          <Select
            aria-label="Default purge window"
            data-testid="setting-prune-window"
            className="h-9 w-40"
            value={prefs.pruneWindowMonths}
            onChange={(e) => prefs.setPruneWindowMonths(Number(e.target.value))}
          >
            {WINDOW_MONTH_OPTIONS.map((m) => (
              <option key={m} value={m}>
                {monthsLabel(m)}
              </option>
            ))}
          </Select>
        </SettingRow>
        <SettingRow
          label="Default downgrade window"
          description="The image age the Storage Triage tools default to."
        >
          <Select
            aria-label="Default downgrade window"
            data-testid="setting-downgrade-window"
            className="h-9 w-40"
            value={prefs.downgradeWindowMonths}
            onChange={(e) => prefs.setDowngradeWindowMonths(Number(e.target.value))}
          >
            {WINDOW_MONTH_OPTIONS.map((m) => (
              <option key={m} value={m}>
                {monthsLabel(m)}
              </option>
            ))}
          </Select>
        </SettingRow>
        <SettingRow
          label="Storage triage"
          description="Reclaim local space at any time — not just when storage is full."
        >
          <Button
            variant="outline"
            data-testid="open-storage-triage-settings"
            onClick={() => setTriageOpen(true)}
          >
            <StorageIcon />
            Manage storage
          </Button>
        </SettingRow>
      </SettingsSection>

      <SettingsSection icon={<InfoIcon />} title="About">
        <SettingRow
          label="About Gubbins"
          description="Version, project &amp; support links, author, licence and disclaimer."
        >
          <Link to="/about" className={cn(buttonVariants({ variant: 'outline' }))}>
            <InfoIcon />
            About
          </Link>
        </SettingRow>
      </SettingsSection>

      <DangerZone />

      {/* Mounted on demand so its reads run when opened and its reference "now" is
          captured at open time (mirrors the banner entry-point). */}
      {triageOpen ? <StorageTriageDialog open onClose={() => setTriageOpen(false)} /> : null}
      </main>
    </div>
  );
}

const THEME_ICONS: Record<Theme, ReactNode> = {
  dark: <DarkThemeIcon />,
  light: <LightThemeIcon />,
  system: <SystemThemeIcon />,
};

/** What each theme choice actually does — surfaced on hover (the labels alone don't say). */
const THEME_TOOLTIPS: Record<Theme, string> = {
  dark: 'Always use the deep dark palette.',
  light: 'Always use the light palette.',
  system: 'Follow your device setting and switch automatically when it does.',
};

function ThemeToggle({
  theme,
  onChange,
}: {
  readonly theme: Theme;
  readonly onChange: (theme: Theme) => void;
}) {
  return (
    <div
      role="radiogroup"
      aria-label="Theme"
      className="inline-flex rounded-lg border border-border bg-input/40 p-1"
    >
      {THEME_OPTIONS.map((option) => {
        const active = theme === option.value;
        return (
          <Tooltip key={option.value} content={THEME_TOOLTIPS[option.value]} triggerTabIndex={-1}>
            <button
              type="button"
              role="radio"
              aria-checked={active}
              data-testid={`theme-${option.value}`}
              onClick={() => onChange(option.value)}
              className={cn(
                'inline-flex items-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium transition-colors [&_svg]:size-4',
                active
                  ? 'bg-primary text-primary-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {THEME_ICONS[option.value]}
              {option.label}
            </button>
          </Tooltip>
        );
      })}
    </div>
  );
}

