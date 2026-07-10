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
  DEFAULT_NAV_COUNT_METRICS,
  DEFAULT_VISUAL_CARD_METRIC,
  DEFAULT_WINDOW_MONTHS,
  guessBaseCurrency,
  normaliseCardClickAction,
  normaliseNavCountMetric,
  normaliseVisualCardMetric,
  normaliseWindowMonths,
  type CardClickAction,
  type NavCountRoute,
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
import { DEFAULT_CARD_FIELDS, type CardFieldsConfig } from '@/features/inventory/card-fields';
import {
  DEFAULT_REMINDER_KINDS,
  normaliseReminderKinds,
  type ReminderKinds,
} from '@/features/alerts/reminders';
import type { AlertKind } from '@/features/alerts/alerts';

/**
 * Appearance preferences (spec §2.1). Two orthogonal axes plus two composable switches, derived
 * from the appearance registry (`theme-registry.ts`, the SSOT) and re-exported here:
 * - `mode` — `light` / `dark` / `system` (`system` follows the OS `prefers-color-scheme`).
 * - `accent` — the brand colour, applied in either mode.
 * - `oledDark` — pure-black surfaces (effective in dark mode).
 * - `highContrast` — accessibility high-contrast mode.
 */
import { normaliseAccent, normaliseMode, type Accent, type Mode } from '@/features/settings/theme-registry';
export type { Accent, Mode };

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
  /** Light / dark / system — the base neutral palette (spec §2.1). */
  readonly mode: Mode;
  /** Brand accent colour, applied in either mode (accent-only recolour). */
  readonly accent: Accent;
  /** Pure-black surfaces for OLED displays; takes visual effect in dark mode. */
  readonly oledDark: boolean;
  /** Accessibility high-contrast mode; boosts contrast + borders over the active mode/accent. */
  readonly highContrast: boolean;
  /**
   * "Reduce effects" (visual-flair F9): dial the app's decorative motion/flair down
   * independently of the OS `prefers-reduced-motion` setting. **Off by default.** Purely
   * additive to the OS preference — the effects stay off if the OS prefers reduced motion
   * regardless of this. Projected onto `<html>` as `data-reduce-effects` by the apply seam,
   * and OR'd into the shared decoration-motion gate that the JS-driven effects read.
   */
  readonly reduceEffects: boolean;
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
   * card's own action buttons; defaults to opening the item's details (or `none` to keep the
   * body inert). See {@link CardClickAction}.
   */
  readonly cardClickAction: CardClickAction;
  /**
   * Which attributes each inventory item card/row shows, and in what order (backlog E1).
   * A device-local ordered list of `{ id, visible }` — built-in fields (`location`,
   * `category`, `condition`, `value`, `quantity`, `updated`) and any category custom field
   * (`custom:<fieldId>`). Persisted as the user's *intent*; the read side reconciles it
   * against the live custom-field catalog via `normaliseCardFields` (resolve-on-read), so a
   * renamed/removed field or a newly-added built-in never corrupts the card. Shared across
   * the Visual card and Data row (per-view density is E2). See {@link CardFieldsConfig}.
   */
  readonly cardFields: CardFieldsConfig;
  /**
   * Which metric each configurable Dashboard nav tile counts (backlog A1/A2). A device-local
   * map of tile route → chosen metric id (e.g. `'/projects' → 'active'`); tiles absent from
   * the map, or holding a stale id, fall back to their shipped default at read time. The
   * available metrics, nouns and tones are the `NAV_COUNT_METRIC_CONFIG` SSOT; the selectors
   * and gated problem-metric reads live in `useNavCounts`. The single-metric Contacts tile is
   * not keyed here. See {@link NavCountRoute}.
   */
  readonly navCountMetrics: Record<NavCountRoute, string>;
  /**
   * Blanket reorder point: a DISCRETE item is flagged on the §3 "Low Stock" widget at/below
   * this on-hand quantity. **0 = off** — low-stock alerts are opt-in, so at 0 nothing is
   * flagged until an item is given its own reorder point (the friction-free default).
   */
  readonly lowStockQtyThreshold: number;
  /**
   * Blanket gauge floor: a CONSUMABLE_GAUGE item is flagged on the §3 "Low Stock" widget
   * at/below this % remaining. **0 = off** (opt-in, as with {@link lowStockQtyThreshold}).
   */
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
   * Local reminder notifications (G3, §3). When on — and the browser grants notification
   * permission — the alert lanes (low stock, expiry, maintenance-due, warranty-due) are
   * surfaced as OS notifications from an installed PWA, not only in-app. **Off by default**
   * (opt-in; the permission prompt is only shown when the user turns this on). Local only —
   * never Web Push. Degrades silently where notifications are unsupported/denied.
   */
  readonly remindersEnabled: boolean;
  /**
   * Which alert lanes may fire a reminder notification (G3). A per-lane opt-in map; a lane set
   * to `false` is suppressed even while {@link remindersEnabled} is on. Defaults to all on.
   * Persisted as intent and reconciled through `normaliseReminderKinds` so a stale/partial
   * value can never leave a lane `undefined` at the decision site.
   */
  readonly reminderKinds: ReminderKinds;
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
   * Whether the user has dismissed the pre-1.0 "work in progress" data-loss warning banner.
   * Dismissing it hides the banner for good (persisted across sessions), but only after the
   * user confirms they understand data loss is possible until Gubbins reaches its 1.0 release.
   * The {@link SHOW_WIP_BANNER} master switch still removes the banner entirely at 1.0.
   */
  readonly wipBannerDismissed: boolean;
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
  setMode: (mode: Mode) => void;
  setAccent: (accent: Accent) => void;
  setOledDark: (enabled: boolean) => void;
  setHighContrast: (enabled: boolean) => void;
  /** Turn the "Reduce effects" decorative-motion switch on/off (visual-flair F9). */
  setReduceEffects: (enabled: boolean) => void;
  setAttachmentMode: (mode: AttachmentMode) => void;
  setScrapeNotifications: (mode: ScrapeNotificationMode) => void;
  setScannerSymbology: (symbology: ScannerSymbology) => void;
  setLabelTemplate: (template: LabelTemplate) => void;
  setLabelBaseUrl: (url: string) => void;
  setScannerBeep: (enabled: boolean) => void;
  setScannerHaptics: (enabled: boolean) => void;
  setVisualCardMetric: (metric: VisualCardMetric) => void;
  setCardClickAction: (action: CardClickAction) => void;
  /** Replace the item-card field configuration (order + visibility). */
  setCardFields: (fields: CardFieldsConfig) => void;
  /** Restore the shipped default card-field configuration. */
  resetCardFields: () => void;
  /** Point a configurable Dashboard nav tile at a different count metric. */
  setNavCountMetric: (route: NavCountRoute, metric: string) => void;
  setExpirySoonWindowDays: (days: number) => void;
  setLowStockQtyThreshold: (qty: number) => void;
  setLowStockGaugePercent: (percent: number) => void;
  setBudgetWarnPercent: (percent: number) => void;
  setPruneWindowMonths: (months: number) => void;
  setDowngradeWindowMonths: (months: number) => void;
  setLastArchivedAt: (at: number) => void;
  setKioskMode: (kioskMode: boolean) => void;
  /** Turn local reminder notifications on/off (the permission prompt is a UI concern). */
  setRemindersEnabled: (enabled: boolean) => void;
  /** Toggle whether a single alert lane may fire a reminder. */
  setReminderKind: (kind: AlertKind, enabled: boolean) => void;
  setDashboardCommandPalette: (enabled: boolean) => void;
  setDashboardQuickActions: (enabled: boolean) => void;
  setDashboardGettingStarted: (enabled: boolean) => void;
  /** Permanently dismiss the dashboard backup/sync nudge. */
  dismissBackupNudge: () => void;
  /** Permanently dismiss the pre-1.0 work-in-progress warning banner (after confirmation). */
  dismissWipBanner: () => void;
  setBridgeUrl: (url: string) => void;
  setBridgeToken: (token: string) => void;
}

export const usePreferencesStore = create<PreferencesStore>()(
  persist(
    (set) => ({
      // First-run guess from the browser locale; the persisted value (if any) wins.
      baseCurrency: guessBaseCurrency(),
      locale: 'en-GB',
      mode: 'dark',
      accent: 'violet',
      oledDark: false,
      highContrast: false,
      reduceEffects: false,
      attachmentMode: 'URL_ONLY',
      scrapeNotifications: 'TOAST',
      scannerSymbology: DEFAULT_SCANNER_SYMBOLOGY,
      labelTemplate: DEFAULT_LABEL_TEMPLATE,
      labelBaseUrl: '',
      scannerBeep: true,
      scannerHaptics: true,
      visualCardMetric: DEFAULT_VISUAL_CARD_METRIC,
      cardClickAction: DEFAULT_CARD_CLICK_ACTION,
      cardFields: DEFAULT_CARD_FIELDS,
      navCountMetrics: DEFAULT_NAV_COUNT_METRICS,
      expirySoonWindowDays: EXPIRY_SOON_WINDOW_DAYS,
      lowStockQtyThreshold: LOW_STOCK_QTY_THRESHOLD,
      lowStockGaugePercent: LOW_STOCK_GAUGE_PERCENT,
      budgetWarnPercent: BUDGET_WARN_PERCENT,
      pruneWindowMonths: DEFAULT_WINDOW_MONTHS,
      downgradeWindowMonths: DEFAULT_WINDOW_MONTHS,
      lastArchivedAt: null,
      kioskMode: false,
      remindersEnabled: false,
      reminderKinds: DEFAULT_REMINDER_KINDS,
      dashboardCommandPalette: true,
      dashboardQuickActions: true,
      dashboardGettingStarted: true,
      backupNudgeDismissed: false,
      wipBannerDismissed: false,
      bridgeUrl: '',
      bridgeToken: '',
      setBaseCurrency: (baseCurrency) => set({ baseCurrency }),
      setLocale: (locale) => set({ locale }),
      // Normalise so a stale/unknown persisted value can never reach the apply seam.
      setMode: (mode) => set({ mode: normaliseMode(mode) }),
      setAccent: (accent) => set({ accent: normaliseAccent(accent) }),
      setOledDark: (oledDark) => set({ oledDark }),
      setHighContrast: (highContrast) => set({ highContrast }),
      setReduceEffects: (reduceEffects) => set({ reduceEffects }),
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
      // Persisted verbatim as the user's *intent*; the read layer reconciles it against the
      // live custom-field catalog (`normaliseCardFields`), so no store-side normalisation.
      setCardFields: (cardFields) => set({ cardFields }),
      resetCardFields: () => set({ cardFields: DEFAULT_CARD_FIELDS }),
      // Merge one tile's choice (normalised) over the map, leaving the other tiles untouched.
      setNavCountMetric: (route, metric) =>
        set((state) => ({
          navCountMetrics: { ...state.navCountMetrics, [route]: normaliseNavCountMetric(route, metric) },
        })),
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
      setRemindersEnabled: (remindersEnabled) => set({ remindersEnabled }),
      // Merge one lane's choice (normalised) over the map, leaving the others untouched.
      setReminderKind: (kind, enabled) =>
        set((state) => ({
          reminderKinds: normaliseReminderKinds({ ...state.reminderKinds, [kind]: enabled }),
        })),
      setDashboardCommandPalette: (dashboardCommandPalette) => set({ dashboardCommandPalette }),
      setDashboardQuickActions: (dashboardQuickActions) => set({ dashboardQuickActions }),
      setDashboardGettingStarted: (dashboardGettingStarted) => set({ dashboardGettingStarted }),
      dismissBackupNudge: () => set({ backupNudgeDismissed: true }),
      dismissWipBanner: () => set({ wipBannerDismissed: true }),
      setBridgeUrl: (bridgeUrl) => set({ bridgeUrl }),
      setBridgeToken: (bridgeToken) => set({ bridgeToken }),
    }),
    {
      name: 'gubbins:preferences',
      // v1: low-stock alerts became opt-in (a threshold of 0 = off). An install that
      // still holds the *old* auto-nag defaults (5 units / 15%) — i.e. never deliberately
      // tuned — is reset to off so freshly-added items stop nagging on the dashboard. A
      // value the user actually chose (anything other than the old hard-coded default) is
      // preserved untouched.
      version: 1,
      migrate: (persistedState, fromVersion) => {
        // Copy into a mutable record — the store fields are declared `readonly`.
        const state = { ...(persistedState as Partial<PreferencesStore>) } as Record<string, unknown>;
        if (fromVersion < 1) {
          if (state.lowStockQtyThreshold === 5) state.lowStockQtyThreshold = LOW_STOCK_QTY_THRESHOLD;
          if (state.lowStockGaugePercent === 15) state.lowStockGaugePercent = LOW_STOCK_GAUGE_PERCENT;
        }
        return state as unknown as PreferencesStore;
      },
    },
  ),
);
