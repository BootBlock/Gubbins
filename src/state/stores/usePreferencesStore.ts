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
  clampPageSize,
  DEFAULT_CARD_CLICK_ACTION,
  DEFAULT_ITEMS_PER_PAGE,
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
  DEFAULT_CARD_BADGE_CONTENT,
  DEFAULT_CARD_BADGE_FALLBACK,
  normaliseCardBadgeContent,
  type CardBadgeContent,
} from '@/features/inventory/card-badge';
import {
  DEFAULT_REMINDER_KINDS,
  normaliseReminderKinds,
  type ReminderKinds,
} from '@/features/alerts/reminders';
import type { AlertKind } from '@/features/alerts/alerts';
import { DEFAULT_OCR_MODEL, normaliseOcrModel, type OcrModel } from '@/features/inventory/ocr/ocr-engine';
export type { OcrModel };
import { normaliseCatalogueLogo } from '@/features/reports/catalogue-branding';
import { DEFAULT_ANALYTICS_WINDOW, normaliseAnalyticsWindow } from '@/features/reports/analytics-windows';
import { DEFAULT_WEIGHT_UNIT, normaliseWeightUnit, type WeightUnit } from '@/lib/weight';
export type { WeightUnit };
import { DEFAULT_DIMENSION_UNIT, normaliseDimensionUnit, type DimensionUnit } from '@/lib/dimensions';
export type { DimensionUnit };

/**
 * Appearance preferences (spec §2.1). Two orthogonal axes plus two composable switches, derived
 * from the appearance registry (`theme-registry.ts`, the SSOT) and re-exported here:
 * - `mode` — `light` / `dark` / `system` (`system` follows the OS `prefers-color-scheme`).
 * - `accent` — the brand colour, applied in either mode.
 * - `oledDark` — pure-black surfaces (effective in dark mode).
 * - `highContrast` — accessibility high-contrast mode.
 */
import {
  normaliseAccent,
  normaliseMode,
  normaliseAnimationLevel,
  normaliseBackgroundEffect,
  DEFAULT_ANIMATION_LEVEL,
  DEFAULT_BACKGROUND_EFFECT,
  type Accent,
  type Mode,
  type AnimationLevel,
  type BackgroundEffect,
} from '@/features/settings/theme-registry';
export type { Accent, Mode, AnimationLevel, BackgroundEffect };

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
  /**
   * The unit weights are read and entered in (issue #25). An item's `weight` is stored
   * canonically in **grams**; this is presentation only — changing it never rewrites the
   * stored number, exactly like {@link baseCurrency} / {@link locale}. Defaults to grams.
   */
  readonly weightUnit: WeightUnit;
  /**
   * The unit item dimensions (width / height / depth) are read and entered in (issue #30). Each
   * dimension is stored canonically in **millimetres**; this is presentation only — changing it
   * never rewrites the stored number, exactly like {@link weightUnit}. Defaults to millimetres.
   */
  readonly dimensionUnit: DimensionUnit;
  /** Light / dark / system — the base neutral palette (spec §2.1). */
  readonly mode: Mode;
  /** Brand accent colour, applied in either mode (accent-only recolour). */
  readonly accent: Accent;
  /** Pure-black surfaces for OLED displays; takes visual effect in dark mode. */
  readonly oledDark: boolean;
  /** Accessibility high-contrast mode; boosts contrast + borders over the active mode/accent. */
  readonly highContrast: boolean;
  /**
   * Full-width page layout (issue #14). When on, the shared page frame drops its centred
   * `max-w` cap so every screen fills the available viewport width instead of sitting in a
   * fixed-width column. **Off by default** — the centred column is the shipped look. Read
   * directly from this store by the {@link import('@/components/foundry').PageContainer} frame
   * (a pure layout concern, so — unlike the mode/accent axes — it is not projected onto `<html>`).
   */
  readonly fullWidth: boolean;
  /**
   * Animation level: how visually animated the interface is, on a single graded scale
   * (`full` → `balanced` → `calm` → `off` → `headache`). **Defaults to `full`** (the shipped
   * experience). Supersedes the earlier binary "Reduce effects" switch; it is projected onto
   * `<html>` as `data-anim-level` (+ `data-reduce-effects` for the motion-off tiers) by the apply
   * seam, and drives the shared decoration-motion gate the JS effects read. Additive to the OS
   * `prefers-reduced-motion` setting — the effects stay off if the OS prefers reduced motion
   * regardless. Offered up-front on the first-run wizard and in Settings → Appearance.
   */
  readonly animationLevel: AnimationLevel;
  /**
   * App-wide animated background effect (weather layer). **Defaults to `none`** so nothing is
   * painted or animated on the shipped baseline. Purely decorative — a single GPU-composited
   * `<canvas>` behind all UI on every screen (`components/background/BackgroundEffects`), gated by
   * the shared decoration-motion gate. Read directly from this store by the canvas component (it is
   * JS-driven, so — unlike the mode/accent/OLED axes — it is not projected onto `<html>`).
   */
  readonly backgroundEffect: BackgroundEffect;
  /**
   * Holographic foil item cards (Appearance flair): dresses the item-card hover sheen as a
   * shifting rainbow **trading-card foil** that tracks the pointer, going beyond the plain
   * single-hue specular glare. **On by default** as part of the maximal "I have a headache"
   * animation level — like the pointer tilt it rides on, it only takes visual effect at that top
   * tier (and on a fine pointer, honouring reduced motion), so a calmer level sees nothing change.
   * Projected onto `<html>` as `data-holo-cards`; the CSS in `styles/index.css` gates it.
   */
  readonly holographicCards: boolean;
  /**
   * Collector-card gamification (Appearance flair): turns a *lucky ~5%* of inventory cards into
   * collectible trading cards with a decorative **rarity** (Common → Legendary) — a rarity-tinted
   * frame on the card, and a rarity gem in the item's detail dialog. Which items are collectors
   * (and their tier) is a stable hash of the item name, not its value, so it never churns — see the
   * pure {@link import('@/features/inventory/rarity').itemRarity} seam. **On by default** as part of
   * the maximal "I have a headache" animation level, and — like the holographic foil — only shown at
   * that top tier. Purely cosmetic. Projected onto `<html>` as `data-gamify-cards`; the CSS gates
   * the card frame (the dialog gem is gated in JS at its call site).
   */
  readonly gamifyCards: boolean;
  readonly attachmentMode: AttachmentMode;
  readonly scrapeNotifications: ScrapeNotificationMode;
  /**
   * Whether the user has agreed that a **barcode product lookup may contact an external service**
   * (Open Food Facts) directly from the app when the companion extension isn't present (issue #59).
   * Off by default — the app never reaches the network for a lookup until the user opts in via the
   * one-time consent prompt; once granted it isn't asked again. The privileged extension path
   * (when installed) is unaffected by this flag.
   */
  readonly allowOnlineProductLookup: boolean;
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
   * What the item card/row's top-right badge slot shows (issue #117) — its tracking mode, unit
   * price, total stock value, condition, or nothing. Shared across the Visual card and Data row.
   * Persisted as the user's *intent*; the read side resolves it (with {@link cardBadgeFallback})
   * against the item via `resolveCardBadge`, so a stale value can never reach the badge. Defaults
   * to the tracking pill, i.e. the historic behaviour. See {@link CardBadgeContent}.
   */
  readonly cardBadgeContent: CardBadgeContent;
  /**
   * The fallback for {@link cardBadgeContent} when the chosen content has nothing to show for a
   * given item (e.g. an unpriced item under "Unit price") — the same option set, resolved after
   * the primary. Defaults to `none` (no fallback), so the shipped default is exactly "always
   * show tracking". See {@link CardBadgeContent}.
   */
  readonly cardBadgeFallback: CardBadgeContent;
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
  /**
   * Paginate long browse lists (issue #20). When on, the inventory list, the activity feed and
   * the contacts dictionary split into fixed-size pages with a page control at the foot, instead
   * of the default continuously-scrolling (virtualised) list. Off by default so nothing changes
   * for users happy with infinite scroll; an app-wide view preference toggled from Settings or
   * the inventory "More" menu.
   */
  readonly paginateLists: boolean;
  /**
   * The default number of items shown per page when {@link paginateLists} is on. Clamped to
   * {@link import('@/features/settings/settings').PAGE_SIZE_BOUNDS}. The page control's own
   * editable size picker writes back here, so this is the single shared page size across lists.
   */
  readonly defaultPageSize: number;
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
   * On-device receipt / label OCR prefill (feature-gap G2). When on, an opt-in "Scan a
   * receipt or label" affordance appears in the add-item flow: an offline, keyless Tesseract
   * WASM engine reads a photographed receipt/label and pre-fills a **reviewable** draft (price,
   * acquired date, model/MPN, serial). **Off by default** — the engine + language model are
   * several MB, lazily fetched on first use, so nothing downloads until the user opts in. It
   * never auto-writes; the user always confirms. Degrades to hidden where OCR is unsupported.
   */
  readonly ocrEnabled: boolean;
  /**
   * Which OCR language-model tier to use (G2): `'fast'` (small integer model — the default,
   * quick and ample for receipts) or `'best'` (larger, higher-accuracy LSTM). Persisted as
   * intent and reconciled through `normaliseOcrModel` so a stale value can never reach the engine.
   */
  readonly ocrModel: OcrModel;
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
   * Hide dashboard alert cards that currently have nothing to report (issue #111) — a
   * Low-stock card with everything in stock, Overdue with no late loans, and so on. Only the
   * exception/attention cards (low stock, soon to expire, overdue, maintenance due, budget
   * alerts) are affected; the informational cards (totals, recent activity, system status) are
   * always shown. **Off by default** so the full board stays discoverable. The board only probes
   * the alert widgets' "all clear" state while this is on. Ignored while the board is being
   * customised, so every card can be arranged.
   */
  readonly hideHealthyDashboardCards: boolean;
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
  /**
   * Printed **parts-catalogue letterhead** (issue #22 follow-up). A device-local set of branding
   * fields the Catalogue screen stamps onto the printed document, so a company can print an
   * on-brand catalogue. Persisted (localStorage) so the letterhead is set once and reused on
   * every print; never synced (a printing/branding concern). All optional — empty fields simply
   * don't render.
   */
  /** Document title override; empty falls back to "Catalogue". */
  readonly catalogueTitle: string;
  /** Organisation / company name printed in the header. */
  readonly catalogueOrgName: string;
  /** Multi-line address / contact block printed under the name (line breaks preserved). */
  readonly catalogueOrgDetails: string;
  /** Footer line printed at the foot of the document (e.g. a confidentiality / © notice). */
  readonly catalogueFooter: string;
  /**
   * Graphic header/logo as a compact resized `data:image/…` URL (or empty). Kept small by
   * {@link import('@/features/reports/catalogue-branding').logoToDataUrl} so it stays well within
   * the localStorage quota; guarded by {@link normaliseCatalogueLogo} so a corrupt persisted
   * value can never reach the `<img>`.
   */
  readonly catalogueLogo: string;
  /** Whether the "Generated <date>" prefix prints on the metadata line (counts always show). */
  readonly catalogueShowGeneratedDate: boolean;
  /** Print "Page X of Y" in the bottom margin of every catalogue page (modern browsers). */
  readonly cataloguePageNumbers: boolean;
  /** Repeat the organisation name / title in the top margin of every printed catalogue page. */
  readonly catalogueRunningHeader: boolean;
  /**
   * Preview the catalogue on screen as a white, black-ink printed page (regardless of the app
   * theme) — so a dark-mode user can see what the printout will look like. On-screen only.
   */
  readonly cataloguePaperPreview: boolean;
  /**
   * Last-selected trailing window (days) for each Reports analytics section (issue #116). Each
   * section — Advanced analytics, Spend analytics, Sales & disposals — remembers its own choice
   * independently, so switching one doesn't move the others, and the pick survives a reload.
   * Persisted as *intent* and reconciled through `normaliseAnalyticsWindow` on read, so a window
   * no longer offered can never reach a query key or the segmented control. Default is the shared
   * {@link DEFAULT_ANALYTICS_WINDOW} (a quarter).
   */
  readonly reportsAnalyticsWindow: number;
  readonly reportsSpendWindow: number;
  readonly reportsSalesWindow: number;
  setBaseCurrency: (currency: string) => void;
  setLocale: (locale: string) => void;
  /** Choose the unit weights are shown/entered in (stored weights stay in grams). */
  setWeightUnit: (unit: WeightUnit) => void;
  /** Choose the unit dimensions are shown/entered in (stored dimensions stay in millimetres). */
  setDimensionUnit: (unit: DimensionUnit) => void;
  setMode: (mode: Mode) => void;
  setAccent: (accent: Accent) => void;
  setOledDark: (enabled: boolean) => void;
  setHighContrast: (enabled: boolean) => void;
  /** Turn the full-width page layout on/off (issue #14). */
  setFullWidth: (enabled: boolean) => void;
  /**
   * Set how visually animated the interface is. Choosing the maximal `headache` preset also brings
   * the ambient Snow background effect on by default (when no effect is chosen yet), as part of its
   * "everything on" bundle.
   */
  setAnimationLevel: (level: AnimationLevel) => void;
  /** Choose the app-wide animated background effect (none / rain / snow). */
  setBackgroundEffect: (effect: BackgroundEffect) => void;
  /** Turn the holographic-foil item-card style on/off. */
  setHolographicCards: (enabled: boolean) => void;
  /** Turn the collector-card rarity gamification on/off. */
  setGamifyCards: (enabled: boolean) => void;
  setAttachmentMode: (mode: AttachmentMode) => void;
  setScrapeNotifications: (mode: ScrapeNotificationMode) => void;
  /** Record the user's consent (or withdrawal) for direct online barcode lookups (issue #59). */
  setAllowOnlineProductLookup: (allowed: boolean) => void;
  setScannerSymbology: (symbology: ScannerSymbology) => void;
  setLabelTemplate: (template: LabelTemplate) => void;
  setLabelBaseUrl: (url: string) => void;
  setScannerBeep: (enabled: boolean) => void;
  setScannerHaptics: (enabled: boolean) => void;
  setVisualCardMetric: (metric: VisualCardMetric) => void;
  setCardClickAction: (action: CardClickAction) => void;
  /** Choose what the item card/row badge slot shows (issue #117). */
  setCardBadgeContent: (content: CardBadgeContent) => void;
  /** Choose the badge slot's fallback for items the chosen content can't apply to. */
  setCardBadgeFallback: (content: CardBadgeContent) => void;
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
  /** Turn list pagination on/off across the browse lists (issue #20). */
  setPaginateLists: (enabled: boolean) => void;
  /** Set the default items-per-page (clamped to the safe range). */
  setDefaultPageSize: (size: number) => void;
  setPruneWindowMonths: (months: number) => void;
  setDowngradeWindowMonths: (months: number) => void;
  setLastArchivedAt: (at: number) => void;
  setKioskMode: (kioskMode: boolean) => void;
  /** Turn local reminder notifications on/off (the permission prompt is a UI concern). */
  setRemindersEnabled: (enabled: boolean) => void;
  /** Toggle whether a single alert lane may fire a reminder. */
  setReminderKind: (kind: AlertKind, enabled: boolean) => void;
  /** Turn opt-in on-device receipt/label OCR prefill on/off (G2). */
  setOcrEnabled: (enabled: boolean) => void;
  /** Choose the OCR language-model accuracy tier (G2). */
  setOcrModel: (model: OcrModel) => void;
  setDashboardCommandPalette: (enabled: boolean) => void;
  setDashboardQuickActions: (enabled: boolean) => void;
  setDashboardGettingStarted: (enabled: boolean) => void;
  /** Turn "hide healthy cards" (issue #111) on/off for the dashboard board. */
  setHideHealthyDashboardCards: (enabled: boolean) => void;
  /** Permanently dismiss the dashboard backup/sync nudge. */
  dismissBackupNudge: () => void;
  /** Permanently dismiss the pre-1.0 work-in-progress warning banner (after confirmation). */
  dismissWipBanner: () => void;
  setBridgeUrl: (url: string) => void;
  setBridgeToken: (token: string) => void;
  /** Set the catalogue document title override (empty → "Catalogue"). */
  setCatalogueTitle: (title: string) => void;
  /** Set the catalogue letterhead organisation name. */
  setCatalogueOrgName: (name: string) => void;
  /** Set the catalogue letterhead address / contact block. */
  setCatalogueOrgDetails: (details: string) => void;
  /** Set the catalogue footer line. */
  setCatalogueFooter: (footer: string) => void;
  /** Set (or clear, with `''`) the catalogue logo data URL; guarded to a `data:image/…` value. */
  setCatalogueLogo: (logo: string) => void;
  /** Toggle whether the printed catalogue shows the "Generated <date>" prefix. */
  setCatalogueShowGeneratedDate: (show: boolean) => void;
  /** Toggle printed "Page X of Y" page numbers on the catalogue. */
  setCataloguePageNumbers: (show: boolean) => void;
  /** Toggle the repeated running header (org name / title) on every catalogue page. */
  setCatalogueRunningHeader: (show: boolean) => void;
  /** Toggle the on-screen white-paper preview of the catalogue. */
  setCataloguePaperPreview: (on: boolean) => void;
  /** Remember the trailing window (days) chosen for a Reports analytics section (issue #116). */
  setReportsAnalyticsWindow: (days: number) => void;
  setReportsSpendWindow: (days: number) => void;
  setReportsSalesWindow: (days: number) => void;
}

export const usePreferencesStore = create<PreferencesStore>()(
  persist(
    (set) => ({
      // First-run guess from the browser locale; the persisted value (if any) wins.
      baseCurrency: guessBaseCurrency(),
      locale: 'en-GB',
      weightUnit: DEFAULT_WEIGHT_UNIT,
      dimensionUnit: DEFAULT_DIMENSION_UNIT,
      mode: 'dark',
      accent: 'violet',
      oledDark: false,
      highContrast: false,
      fullWidth: false,
      animationLevel: DEFAULT_ANIMATION_LEVEL,
      backgroundEffect: DEFAULT_BACKGROUND_EFFECT,
      // On by default — part of the maximal "I have a headache" tier, and only rendered there.
      holographicCards: true,
      gamifyCards: true,
      attachmentMode: 'URL_ONLY',
      scrapeNotifications: 'TOAST',
      allowOnlineProductLookup: false,
      scannerSymbology: DEFAULT_SCANNER_SYMBOLOGY,
      labelTemplate: DEFAULT_LABEL_TEMPLATE,
      labelBaseUrl: '',
      scannerBeep: true,
      scannerHaptics: true,
      visualCardMetric: DEFAULT_VISUAL_CARD_METRIC,
      cardClickAction: DEFAULT_CARD_CLICK_ACTION,
      cardBadgeContent: DEFAULT_CARD_BADGE_CONTENT,
      cardBadgeFallback: DEFAULT_CARD_BADGE_FALLBACK,
      cardFields: DEFAULT_CARD_FIELDS,
      navCountMetrics: DEFAULT_NAV_COUNT_METRICS,
      expirySoonWindowDays: EXPIRY_SOON_WINDOW_DAYS,
      lowStockQtyThreshold: LOW_STOCK_QTY_THRESHOLD,
      lowStockGaugePercent: LOW_STOCK_GAUGE_PERCENT,
      budgetWarnPercent: BUDGET_WARN_PERCENT,
      paginateLists: false,
      defaultPageSize: DEFAULT_ITEMS_PER_PAGE,
      pruneWindowMonths: DEFAULT_WINDOW_MONTHS,
      downgradeWindowMonths: DEFAULT_WINDOW_MONTHS,
      lastArchivedAt: null,
      kioskMode: false,
      remindersEnabled: false,
      reminderKinds: DEFAULT_REMINDER_KINDS,
      ocrEnabled: false,
      ocrModel: DEFAULT_OCR_MODEL,
      dashboardCommandPalette: true,
      dashboardQuickActions: true,
      dashboardGettingStarted: true,
      hideHealthyDashboardCards: false,
      backupNudgeDismissed: false,
      wipBannerDismissed: false,
      bridgeUrl: '',
      bridgeToken: '',
      catalogueTitle: '',
      catalogueOrgName: '',
      catalogueOrgDetails: '',
      catalogueFooter: '',
      catalogueLogo: '',
      catalogueShowGeneratedDate: true,
      cataloguePageNumbers: true,
      catalogueRunningHeader: true,
      cataloguePaperPreview: false,
      reportsAnalyticsWindow: DEFAULT_ANALYTICS_WINDOW,
      reportsSpendWindow: DEFAULT_ANALYTICS_WINDOW,
      reportsSalesWindow: DEFAULT_ANALYTICS_WINDOW,
      setBaseCurrency: (baseCurrency) => set({ baseCurrency }),
      setLocale: (locale) => set({ locale }),
      // Normalise so a stale/unknown persisted value can never reach the formatter/conversions.
      setWeightUnit: (unit) => set({ weightUnit: normaliseWeightUnit(unit) }),
      // Normalise so a stale/unknown persisted value can never reach the formatter/conversions.
      setDimensionUnit: (unit) => set({ dimensionUnit: normaliseDimensionUnit(unit) }),
      // Normalise so a stale/unknown persisted value can never reach the apply seam.
      setMode: (mode) => set({ mode: normaliseMode(mode) }),
      setAccent: (accent) => set({ accent: normaliseAccent(accent) }),
      setOledDark: (oledDark) => set({ oledDark }),
      setHighContrast: (highContrast) => set({ highContrast }),
      setFullWidth: (fullWidth) => set({ fullWidth }),
      // Normalise so a stale/unknown persisted value can never reach the apply seam / gate.
      setAnimationLevel: (level) =>
        set((state) => {
          const animationLevel = normaliseAnimationLevel(level);
          // The maximal "I have a headache" preset is "everything on", so it brings the ambient
          // Snow weather layer on by default — but only when no effect is chosen yet (`none`), so
          // an explicit Rain/Snow/None choice the user made is preserved.
          const backgroundEffect =
            animationLevel === 'headache' && state.backgroundEffect === 'none'
              ? 'snow'
              : state.backgroundEffect;
          return { animationLevel, backgroundEffect };
        }),
      // Normalise so a stale/unknown persisted value can never reach the canvas engine.
      setBackgroundEffect: (effect) => set({ backgroundEffect: normaliseBackgroundEffect(effect) }),
      setHolographicCards: (holographicCards) => set({ holographicCards }),
      setGamifyCards: (gamifyCards) => set({ gamifyCards }),
      setAttachmentMode: (attachmentMode) => set({ attachmentMode }),
      setScrapeNotifications: (scrapeNotifications) => set({ scrapeNotifications }),
      setAllowOnlineProductLookup: (allowOnlineProductLookup) => set({ allowOnlineProductLookup }),
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
      // Normalise so a stale/unknown persisted value can never reach the badge renderer. The
      // fallback preference defaults to `none` (not `tracking`) when a bad value is coerced.
      setCardBadgeContent: (content) => set({ cardBadgeContent: normaliseCardBadgeContent(content) }),
      setCardBadgeFallback: (content) =>
        set({ cardBadgeFallback: normaliseCardBadgeContent(content, DEFAULT_CARD_BADGE_FALLBACK) }),
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
      setPaginateLists: (paginateLists) => set({ paginateLists }),
      // Clamp so a stale/out-of-range persisted or typed value can never reach the page maths.
      setDefaultPageSize: (size) => set({ defaultPageSize: clampPageSize(size) }),
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
      setOcrEnabled: (ocrEnabled) => set({ ocrEnabled }),
      // Normalise so a stale/unknown persisted value can never reach the engine.
      setOcrModel: (model) => set({ ocrModel: normaliseOcrModel(model) }),
      setDashboardCommandPalette: (dashboardCommandPalette) => set({ dashboardCommandPalette }),
      setDashboardQuickActions: (dashboardQuickActions) => set({ dashboardQuickActions }),
      setDashboardGettingStarted: (dashboardGettingStarted) => set({ dashboardGettingStarted }),
      setHideHealthyDashboardCards: (hideHealthyDashboardCards) => set({ hideHealthyDashboardCards }),
      dismissBackupNudge: () => set({ backupNudgeDismissed: true }),
      dismissWipBanner: () => set({ wipBannerDismissed: true }),
      setBridgeUrl: (bridgeUrl) => set({ bridgeUrl }),
      setBridgeToken: (bridgeToken) => set({ bridgeToken }),
      // Letterhead text is stored verbatim — trimming here runs on every keystroke, which would
      // eat a space or newline the moment it lands at the end of the field (so the user could
      // never type a trailing space or a new address line). Any incidental leading/trailing
      // whitespace is trimmed at the point of use instead. The logo is guarded to a
      // `data:image/…` value so a corrupt persisted string can never reach the printed `<img>`.
      setCatalogueTitle: (catalogueTitle) => set({ catalogueTitle }),
      setCatalogueOrgName: (catalogueOrgName) => set({ catalogueOrgName }),
      setCatalogueOrgDetails: (catalogueOrgDetails) => set({ catalogueOrgDetails }),
      setCatalogueFooter: (catalogueFooter) => set({ catalogueFooter }),
      setCatalogueLogo: (logo) => set({ catalogueLogo: normaliseCatalogueLogo(logo) }),
      setCatalogueShowGeneratedDate: (show) => set({ catalogueShowGeneratedDate: show }),
      setCataloguePageNumbers: (show) => set({ cataloguePageNumbers: show }),
      setCatalogueRunningHeader: (show) => set({ catalogueRunningHeader: show }),
      setCataloguePaperPreview: (on) => set({ cataloguePaperPreview: on }),
      // Normalise so a stale/out-of-range persisted or passed value can never reach a query key
      // or the segmented control (the control only ever offers valid windows).
      setReportsAnalyticsWindow: (days) => set({ reportsAnalyticsWindow: normaliseAnalyticsWindow(days) }),
      setReportsSpendWindow: (days) => set({ reportsSpendWindow: normaliseAnalyticsWindow(days) }),
      setReportsSalesWindow: (days) => set({ reportsSalesWindow: normaliseAnalyticsWindow(days) }),
    }),
    {
      name: 'gubbins:preferences',
      // v1: low-stock alerts became opt-in (a threshold of 0 = off). An install that
      // still holds the *old* auto-nag defaults (5 units / 15%) — i.e. never deliberately
      // tuned — is reset to off so freshly-added items stop nagging on the dashboard. A
      // value the user actually chose (anything other than the old hard-coded default) is
      // preserved untouched.
      // v2: the binary "Reduce effects" switch became the graded `animationLevel` scale. An
      // install that had turned Reduce-effects ON keeps that intent as the equivalent `calm`
      // level (all decorative motion still); everyone else lands on the "everything on" default.
      // v3: the scale was re-labelled/re-ordered so `headache` is the "everything on" top tier and
      // `off` is the barest floor, with a new `minimal` rung inserted. Installs carrying the interim
      // v2 ids are remapped; installs deriving fresh from `reduceEffects` already produce final ids.
      version: 3,
      migrate: (persistedState, fromVersion) => {
        // Copy into a mutable record — the store fields are declared `readonly`.
        const state = { ...(persistedState as Partial<PreferencesStore>) } as Record<string, unknown>;
        if (fromVersion < 1) {
          if (state.lowStockQtyThreshold === 5) state.lowStockQtyThreshold = LOW_STOCK_QTY_THRESHOLD;
          if (state.lowStockGaugePercent === 15) state.lowStockGaugePercent = LOW_STOCK_GAUGE_PERCENT;
        }
        if (fromVersion < 2) {
          // Pre-animationLevel install: derive from the old binary reduceEffects (a *final* id).
          // Reduce-effects ON → `calm`; OFF → `headache` (the "everything on" tier — its prior
          // experience), NOT the new `balanced` default, so upgrading never silently dims effects
          // an existing install was already showing. Only fresh installs pick up the new default.
          if (state.animationLevel === undefined) {
            state.animationLevel = state.reduceEffects === true ? 'calm' : 'headache';
          }
          delete state.reduceEffects;
        }
        if (fromVersion === 2) {
          // Only a v2 install carries the interim ids; remap them to the final scale. (A pre-v2
          // install produced a final id in the block above, so it must NOT be remapped.)
          const REMAP: Record<string, string> = { full: 'headache', off: 'minimal', headache: 'off' };
          const current = state.animationLevel;
          if (typeof current === 'string' && current in REMAP) state.animationLevel = REMAP[current];
        }
        return state as unknown as PreferencesStore;
      },
    },
  ),
);
