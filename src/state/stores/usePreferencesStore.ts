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
  EXPIRY_SOON_WINDOW_DAYS,
  LOW_STOCK_GAUGE_PERCENT,
  LOW_STOCK_QTY_THRESHOLD,
} from '@/db/repositories/constants';
import {
  clampExpiryWindowDays,
  clampLowStockGaugePercent,
  clampLowStockQty,
  DEFAULT_WINDOW_MONTHS,
  guessBaseCurrency,
  normaliseWindowMonths,
} from '@/features/settings/settings';
import {
  DEFAULT_SCANNER_SYMBOLOGY,
  normaliseSymbology,
  type ScannerSymbology,
} from '@/features/scanner/scanner-formats';

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
  /** Play a synthesised confirmation beep on a successful scan (§6.5). On by default. */
  readonly scannerBeep: boolean;
  /** Trigger a haptic bump (`navigator.vibrate`) on a successful scan (§6.5). On by default. */
  readonly scannerHaptics: boolean;
  /** Days before `expiry_date` an item is surfaced as "expiring soon" (§3, §4). */
  readonly expirySoonWindowDays: number;
  /** A DISCRETE item is flagged on the §3 "Low Stock" widget at/below this on-hand quantity. */
  readonly lowStockQtyThreshold: number;
  /** A CONSUMABLE_GAUGE item is flagged on the §3 "Low Stock" widget at/below this % remaining. */
  readonly lowStockGaugePercent: number;
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
  setScannerBeep: (enabled: boolean) => void;
  setScannerHaptics: (enabled: boolean) => void;
  setExpirySoonWindowDays: (days: number) => void;
  setLowStockQtyThreshold: (qty: number) => void;
  setLowStockGaugePercent: (percent: number) => void;
  setPruneWindowMonths: (months: number) => void;
  setDowngradeWindowMonths: (months: number) => void;
  setLastArchivedAt: (at: number) => void;
  setKioskMode: (kioskMode: boolean) => void;
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
      scannerBeep: true,
      scannerHaptics: true,
      expirySoonWindowDays: EXPIRY_SOON_WINDOW_DAYS,
      lowStockQtyThreshold: LOW_STOCK_QTY_THRESHOLD,
      lowStockGaugePercent: LOW_STOCK_GAUGE_PERCENT,
      pruneWindowMonths: DEFAULT_WINDOW_MONTHS,
      downgradeWindowMonths: DEFAULT_WINDOW_MONTHS,
      lastArchivedAt: null,
      kioskMode: false,
      bridgeUrl: '',
      bridgeToken: '',
      setBaseCurrency: (baseCurrency) => set({ baseCurrency }),
      setLocale: (locale) => set({ locale }),
      setTheme: (theme) => set({ theme }),
      toggleTheme: () => set((state) => ({ theme: state.theme === 'dark' ? 'light' : 'dark' })),
      setAttachmentMode: (attachmentMode) => set({ attachmentMode }),
      setScrapeNotifications: (scrapeNotifications) => set({ scrapeNotifications }),
      // Normalise so a stale/out-of-range persisted value can never reach the decoder.
      setScannerSymbology: (symbology) =>
        set({ scannerSymbology: normaliseSymbology(symbology) }),
      setScannerBeep: (scannerBeep) => set({ scannerBeep }),
      setScannerHaptics: (scannerHaptics) => set({ scannerHaptics }),
      // Defensive clamping/normalisation so a stale persisted or out-of-range value
      // can never reach the read layer (the controls offer only valid choices).
      setExpirySoonWindowDays: (days) =>
        set({ expirySoonWindowDays: clampExpiryWindowDays(days) }),
      setLowStockQtyThreshold: (qty) => set({ lowStockQtyThreshold: clampLowStockQty(qty) }),
      setLowStockGaugePercent: (percent) =>
        set({ lowStockGaugePercent: clampLowStockGaugePercent(percent) }),
      setPruneWindowMonths: (months) => set({ pruneWindowMonths: normaliseWindowMonths(months) }),
      setDowngradeWindowMonths: (months) =>
        set({ downgradeWindowMonths: normaliseWindowMonths(months) }),
      setLastArchivedAt: (lastArchivedAt) => set({ lastArchivedAt }),
      setKioskMode: (kioskMode) => set({ kioskMode }),
      setBridgeUrl: (bridgeUrl) => set({ bridgeUrl }),
      setBridgeToken: (bridgeToken) => set({ bridgeToken }),
    }),
    { name: 'gubbins:preferences' },
  ),
);
