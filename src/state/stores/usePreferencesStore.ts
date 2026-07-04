/**
 * usePreferencesStore — Tier-2 user preferences (spec §2.1, §1.2.1, §3).
 *
 * Base currency, locale and theme, persisted to localStorage. Locale/theme follow
 * the locked derived defaults (en-GB / dark, §1.2.1); the base currency is *guessed*
 * from the browser locale on first run ({@link guessBaseCurrency}), falling back to
 * GBP — once anything is persisted, the stored choice wins. The theme palette is
 * wired in CSS (dark default); this store is the home for the Dark/Light toggle.
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import {
  BUDGET_WARN_PERCENT,
  EXPIRY_SOON_WINDOW_DAYS,
  LOW_STOCK_GAUGE_PERCENT,
  LOW_STOCK_QTY_THRESHOLD,
} from '@/db/repositories/constants';
import {
  clampBudgetWarnPercent,
  clampExpiryWindowDays,
  clampLowStockGaugePercent,
  clampLowStockQty,
  DEFAULT_CARD_CLICK_ACTION,
  DEFAULT_VISUAL_CARD_METRIC,
  DEFAULT_WINDOW_MONTHS,
  guessBaseCurrency,
  normaliseCardClickAction,
  normaliseVisualCardMetric,
  normaliseWindowMonths,
  type CardClickAction,
  type VisualCardMetric,
} from '@/features/settings/settings';
import {
  DEFAULT_SCANNER_SYMBOLOGY,
  normaliseSymbology,
  type ScannerSymbology,
} from '@/features/scanner/scanner-formats';
import {
  DEFAULT_LABEL_TEMPLATE,
  normaliseLabelTemplate,
  type LabelTemplate,
} from '@/features/inventory/labels/label-template';

/**
 * Theme preference (spec §2.1). `'system'` follows the OS `prefers-color-scheme`
 * (resolved to dark/light at apply time); `'dark'`/`'light'` pin the palette.
 */
export type Theme = 'dark' | 'light' | 'system';

/**
 * Datasheet/attachment configuration (spec §4 "Attachments & Datasheets"):
 * - `URL_ONLY` (Option A) — only external URLs may be linked.
 * - `HYBRID` (Option B) — external URLs *and* local file-path pointers (the
 *   File System Access path string is stored; the blob is never synced, §4).
 */
export type AttachmentMode = 'URL_ONLY' | 'HYBRID';

/**
 * How the user is told about external-scrape updates (spec §4). The default is a
 * **passive toast** notification; `SILENT` suppresses the toast (the scrape still
 * applies and is logged to the Activity Ledger).
 */
export type ScrapeNotificationMode = 'TOAST' | 'SILENT';

interface PreferencesStore {
  readonly baseCurrency: string;
  readonly locale: string;
  readonly theme: Theme;
  readonly attachmentMode: AttachmentMode;
  readonly scrapeNotifications: ScrapeNotificationMode;
  /** Which barcode symbology the live scanner decodes (§6.6); `'all'` scans every supported code. */
  readonly scannerSymbology: ScannerSymbology;
  /**
   * Default printable-label template (Phase 73 "Label customisation") — the symbology,
   * text fields and columns a label sheet uses. Device-local (label layout is a
   * printer/paper concern, never synced); the Print-labels dialog seeds an editable
   * working copy from this and can save changes back as the new default.
   */
  readonly labelTemplate: LabelTemplate;
  /**
   * Optional base URL that printable QR codes / barcodes should link to (spec §6). Empty
   * means "derive from the address this app is opened from" (`origin` + Vite base path).
   * Set it to a stable name every device can reach — e.g. `http://gubbins.local` — so a
   * label printed from a `localhost` dev server still resolves from a phone. Device-local
   * (a printing/network concern, never synced); resolved by `resolveLabelBaseUrl`.
   */
  readonly labelBaseUrl: string;
  /** Play a synthesised confirmation beep on a successful scan (§6.5). On by default. */
  readonly scannerBeep: boolean;
  /** Trigger a haptic bump (`navigator.vibrate`) on a successful scan (§6.5). On by default. */
  readonly scannerHaptics: boolean;
  /** Days before `expiry_date` an item is surfaced as "expiring soon" (§3, §4). */
  readonly expirySoonWindowDays: number;
  /**
   * Which metric a Visual-mode item card shows in its hero slot for a plain DISCRETE item
   * (spec §3) — its reorder-derived stock health, or its total stock value. Only affects
   * the plain discrete card (gauge/serialised/untracked/unlimited heroes are unchanged);
   * defaults to the actionable stock-health status. See {@link VisualCardMetric}.
   */
  readonly visualCardMetric: VisualCardMetric;
  /**
   * What a plain click on an item card/row body (outside its buttons) does (spec §3) — open
   * details, move, show the label, or nothing. A pointer-only shortcut that mirrors one of the
   * card's own action buttons; defaults to `none` so the card stays inert until opted in. See
   * {@link CardClickAction}.
   */
  readonly cardClickAction: CardClickAction;
  /** A DISCRETE item is flagged on the §3 "Low Stock" widget at/below this on-hand quantity. */
  readonly lowStockQtyThreshold: number;
  /** A CONSUMABLE_GAUGE item is flagged on the §3 "Low Stock" widget at/below this % remaining. */
  readonly lowStockGaugePercent: number;
  /** A project's budget indicator turns to a warning tone at/above this % of budget spent (§4). */
  readonly budgetWarnPercent: number;
  /** Default "older than" window (months) for history pruning (§7.6.3 A). */
  readonly pruneWindowMonths: number;
  /** Default "older than" window (months) for image downgrading (§7.6.3 B). */
  readonly downgradeWindowMonths: number;
  /** When the §2.7 mobile Full Archive was last downloaded (UNIX-ms), or null if never. */
  readonly lastArchivedAt: number | null;
  /**
   * Kiosk mode (§3 "Kiosk & Tablet Ergonomics"): hold a screen wake lock so a
   * hardwired dashboard never sleeps, and apply touch/selection containment to the
   * dashboard. Off by default — opt-in so casual use is unaffected.
   */
  readonly kioskMode: boolean;
  /**
   * Landing-page (Dashboard) optional features (§3 dashboard improvements). Each is a
   * user-facing enhancement the user can switch off from the Settings "Dashboard" group;
   * all default **on** so they're discoverable. The two extra widgets (Recent activity,
   * Inventory totals) aren't here — they're enabled/disabled via the dashboard's own
   * "Customise" show/hide like every other widget.
   */
  /** Show the Cmd/Ctrl-K command palette (global quick item search) and its hero trigger. */
  readonly dashboardCommandPalette: boolean;
  /** Show the quick-action buttons (Add item / Scan) in the dashboard hero. */
  readonly dashboardQuickActions: boolean;
  /** Show the first-run "getting started" panel while the inventory is still empty. */
  readonly dashboardGettingStarted: boolean;
  /**
   * Whether the user has dismissed the dashboard "keep your data safe" backup/sync nudge.
   * The nudge shows once there's data to protect and no sync provider is connected; dismissing
   * it (or connecting a sync provider) hides it. Persisted so it stays dismissed across sessions.
   */
  readonly backupNudgeDismissed: boolean;
  /**
   * "Push to bridge" target (Home Assistant query bridge). The base URL (e.g.
   * `http://127.0.0.1:8787`) of an optional companion bridge the user can push the dataset
   * to over HTTP, for those who don't use FS-Access folder sync. Empty until configured. The
   * bridge code lives in `bridge/`; nothing here imports it (no bundle bloat).
   */
  readonly bridgeUrl: string;
  /**
   * Bearer token for {@link bridgeUrl}. **Device-local only** — persisted to localStorage like
   * the rest of these preferences, never synced and never committed; treated as a secret in the
   * UI (masked input). Empty until configured.
   */
  readonly bridgeToken: string;
  setBaseCurrency: (currency: string) => void;
  setLocale: (locale: string) => void;
  setTheme: (theme: Theme) => void;
  toggleTheme: () => void;
  setAttachmentMode: (mode: AttachmentMode) => void;
  setScrapeNotifications: (mode: ScrapeNotificationMode) => void;
  setScannerSymbology: (symbology: ScannerSymbology) => void;
  setLabelTemplate: (template: LabelTemplate) => void;
  setLabelBaseUrl: (url: string) => void;
  setScannerBeep: (enabled: boolean) => void;
  setScannerHaptics: (enabled: boolean) => void;
  setVisualCardMetric: (metric: VisualCardMetric) => void;
  setCardClickAction: (action: CardClickAction) => void;
  setExpirySoonWindowDays: (days: number) => void;
  setLowStockQtyThreshold: (qty: number) => void;
  setLowStockGaugePercent: (percent: number) => void;
  setBudgetWarnPercent: (percent: number) => void;
  setPruneWindowMonths: (months: number) => void;
  setDowngradeWindowMonths: (months: number) => void;
  setLastArchivedAt: (at: number) => void;
  setKioskMode: (kioskMode: boolean) => void;
  setDashboardCommandPalette: (enabled: boolean) => void;
  setDashboardQuickActions: (enabled: boolean) => void;
  setDashboardGettingStarted: (enabled: boolean) => void;
  /** Permanently dismiss the dashboard backup/sync nudge. */
  dismissBackupNudge: () => void;
  setBridgeUrl: (url: string) => void;
  setBridgeToken: (token: string) => void;
}

export const usePreferencesStore = create<PreferencesStore>()(
  persist(
    (set) => ({
      // First-run guess from the browser locale; the persisted value (if any) wins.
      baseCurrency: guessBaseCurrency(),
      locale: 'en-GB',
      theme: 'dark',
      attachmentMode: 'URL_ONLY',
      scrapeNotifications: 'TOAST',
      scannerSymbology: DEFAULT_SCANNER_SYMBOLOGY,
      labelTemplate: DEFAULT_LABEL_TEMPLATE,
      labelBaseUrl: '',
      scannerBeep: true,
      scannerHaptics: true,
      visualCardMetric: DEFAULT_VISUAL_CARD_METRIC,
      cardClickAction: DEFAULT_CARD_CLICK_ACTION,
      expirySoonWindowDays: EXPIRY_SOON_WINDOW_DAYS,
      lowStockQtyThreshold: LOW_STOCK_QTY_THRESHOLD,
      lowStockGaugePercent: LOW_STOCK_GAUGE_PERCENT,
      budgetWarnPercent: BUDGET_WARN_PERCENT,
      pruneWindowMonths: DEFAULT_WINDOW_MONTHS,
      downgradeWindowMonths: DEFAULT_WINDOW_MONTHS,
      lastArchivedAt: null,
      kioskMode: false,
      dashboardCommandPalette: true,
      dashboardQuickActions: true,
      dashboardGettingStarted: true,
      backupNudgeDismissed: false,
      bridgeUrl: '',
      bridgeToken: '',
      setBaseCurrency: (baseCurrency) => set({ baseCurrency }),
      setLocale: (locale) => set({ locale }),
      setTheme: (theme) => set({ theme }),
      toggleTheme: () => set((state) => ({ theme: state.theme === 'dark' ? 'light' : 'dark' })),
      setAttachmentMode: (attachmentMode) => set({ attachmentMode }),
      setScrapeNotifications: (scrapeNotifications) => set({ scrapeNotifications }),
      // Normalise so a stale/out-of-range persisted value can never reach the decoder.
      setScannerSymbology: (symbology) => set({ scannerSymbology: normaliseSymbology(symbology) }),
      // Normalise so a stale/partial persisted template can never reach the renderer.
      setLabelTemplate: (template) => set({ labelTemplate: normaliseLabelTemplate(template) }),
      // Stored verbatim (trimmed); the forgiving `resolveLabelBaseUrl` normalises at read time.
      setLabelBaseUrl: (labelBaseUrl) => set({ labelBaseUrl: labelBaseUrl.trim() }),
      setScannerBeep: (scannerBeep) => set({ scannerBeep }),
      setScannerHaptics: (scannerHaptics) => set({ scannerHaptics }),
      // Normalise so a stale/unknown persisted value can never reach the card renderer.
      setVisualCardMetric: (metric) => set({ visualCardMetric: normaliseVisualCardMetric(metric) }),
      // Normalise so a stale/unknown persisted value can never reach the card's click handler.
      setCardClickAction: (action) => set({ cardClickAction: normaliseCardClickAction(action) }),
      // Defensive clamping/normalisation so a stale persisted or out-of-range value
      // can never reach the read layer (the controls offer only valid choices).
      setExpirySoonWindowDays: (days) => set({ expirySoonWindowDays: clampExpiryWindowDays(days) }),
      setLowStockQtyThreshold: (qty) => set({ lowStockQtyThreshold: clampLowStockQty(qty) }),
      setLowStockGaugePercent: (percent) => set({ lowStockGaugePercent: clampLowStockGaugePercent(percent) }),
      setBudgetWarnPercent: (percent) => set({ budgetWarnPercent: clampBudgetWarnPercent(percent) }),
      setPruneWindowMonths: (months) => set({ pruneWindowMonths: normaliseWindowMonths(months) }),
      setDowngradeWindowMonths: (months) => set({ downgradeWindowMonths: normaliseWindowMonths(months) }),
      setLastArchivedAt: (lastArchivedAt) => set({ lastArchivedAt }),
      setKioskMode: (kioskMode) => set({ kioskMode }),
      setDashboardCommandPalette: (dashboardCommandPalette) => set({ dashboardCommandPalette }),
      setDashboardQuickActions: (dashboardQuickActions) => set({ dashboardQuickActions }),
      setDashboardGettingStarted: (dashboardGettingStarted) => set({ dashboardGettingStarted }),
      dismissBackupNudge: () => set({ backupNudgeDismissed: true }),
      setBridgeUrl: (bridgeUrl) => set({ bridgeUrl }),
      setBridgeToken: (bridgeToken) => set({ bridgeToken }),
    }),
    { name: 'gubbins:preferences' },
  ),
);
