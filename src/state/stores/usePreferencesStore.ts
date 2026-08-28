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
  DEAD_STOCK_SINCE_DAYS,
  EXPIRY_SOON_WINDOW_DAYS,
  LOW_STOCK_GAUGE_PERCENT,
  LOW_STOCK_QTY_THRESHOLD,
} from '@/db/repositories/constants';
import {
  clampBudgetWarnPercent,
  clampDeadStockDays,
  clampExpiryWindowDays,
  clampLowStockGaugePercent,
  clampLowStockQty,
  clampPackingFactor,
  clampPageSize,
  DEFAULT_CARD_CLICK_ACTION,
  DEFAULT_PACKING_FACTOR,
  DEFAULT_ITEMS_PER_PAGE,
  DEFAULT_NAV_COUNT_METRICS,
  DEFAULT_VISUAL_CARD_METRIC,
  DEFAULT_VISUAL_CARD_METRIC_FALLBACK,
  DEFAULT_WINDOW_MONTHS,
  guessBaseCurrency,
  normaliseCardClickAction,
  normaliseNavCountMetric,
  normaliseNavCountMetrics,
  normaliseVisualCardMetric,
  normaliseVisualCardMetricFallback,
  normaliseWindowMonths,
  type CardClickAction,
  type NavCountRoute,
  type VisualCardMetric,
  type VisualCardMetricFallback,
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
import {
  DEFAULT_CARD_FIELDS,
  type CardFieldSetting,
  type CardFieldsConfig,
} from '@/features/inventory/card-fields';
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
import {
  DEFAULT_HOTKEY_BINDINGS,
  normaliseHotkeyBindings,
  type HotkeyActionId,
  type HotkeyBinding,
} from '@/features/hotkeys/hotkeys';
import {
  DEFAULT_LIVE_SETTINGS_SELECTION,
  normaliseLiveSettingsSelection,
} from '@/features/settings/settings-sync';
import type { SettingsGroupSelection } from '@/features/backup/settings-groups';
import { normaliseCatalogueLogo } from '@/features/reports/catalogue-branding';
import { DEFAULT_ANALYTICS_WINDOW, normaliseAnalyticsWindow } from '@/features/reports/analytics-windows';
import { DEFAULT_WEIGHT_UNIT, normaliseWeightUnit, type WeightUnit } from '@/lib/weight';
export type { WeightUnit };
import { DEFAULT_DIMENSION_UNIT, normaliseDimensionUnit, type DimensionUnit } from '@/lib/dimensions';
export type { DimensionUnit };
import { DEFAULT_VOLUME_UNIT, normaliseVolumeUnit, type VolumeUnitPreference } from '@/lib/volume';
export type { VolumeUnitPreference };
import { DEFAULT_LOCALE, normaliseCurrency, normaliseLocale } from '@/lib/format';
import {
  isPlainObject,
  normaliseArray,
  normaliseBoolean,
  normaliseNullableInteger,
  normaliseOneOf,
  normaliseString,
} from '@/lib/persisted-state';

/**
 * Appearance preferences (spec §2.1). Two orthogonal axes plus two composable switches, derived
 * from the appearance registry (`theme-registry.ts`, the SSOT) and re-exported here:
 * - `mode` — `light` / `dark` / `system` (`system` follows the OS `prefers-color-scheme`).
 * - `accent` — the brand colour, applied in either mode.
 * - `oledDark` — pure-black surfaces (effective in dark mode).
 * - `highContrast` — accessibility high-contrast mode.
 */
import {
  DEFAULT_ACCENT,
  DEFAULT_MODE,
  normaliseAccent,
  normaliseMode,
  normaliseAnimationLevel,
  normaliseBackgroundEffect,
  normaliseSurfaceStyle,
  clampAccentHue,
  DEFAULT_ANIMATION_LEVEL,
  DEFAULT_BACKGROUND_EFFECT,
  DEFAULT_SURFACE_STYLE,
  DEFAULT_CUSTOM_ACCENT_HUE,
  type Accent,
  type Mode,
  type AnimationLevel,
  type BackgroundEffect,
  type SurfaceStyle,
} from '@/features/settings/theme-registry';
export type { Accent, Mode, AnimationLevel, BackgroundEffect, SurfaceStyle };

/**
 * Datasheet/attachment configuration (spec §4 "Attachments & Datasheets"):
 * - `URL_ONLY` (Option A) — only external URLs may be linked.
 * - `HYBRID` (Option B) — external URLs *and* local file-path pointers (the
 *   File System Access path string is stored; the blob is never synced, §4).
 */
export const ATTACHMENT_MODES = ['URL_ONLY', 'HYBRID'] as const;

export type AttachmentMode = (typeof ATTACHMENT_MODES)[number];

/** The attachment mode a fresh install starts on — external URLs only (spec §4 Option A). */
export const DEFAULT_ATTACHMENT_MODE: AttachmentMode = 'URL_ONLY';

/** Reconcile a persisted/unknown attachment mode against the live union — see {@link normaliseMode}. */
export function normaliseAttachmentMode(value: unknown): AttachmentMode {
  return normaliseOneOf(value, ATTACHMENT_MODES, DEFAULT_ATTACHMENT_MODE);
}

/**
 * How the user is told about external-scrape updates (spec §4). The default is a
 * **passive toast** notification; `SILENT` suppresses the toast (the scrape still
 * applies and is logged to the Activity Ledger).
 */
export const SCRAPE_NOTIFICATION_MODES = ['TOAST', 'SILENT'] as const;

export type ScrapeNotificationMode = (typeof SCRAPE_NOTIFICATION_MODES)[number];

/** The scrape-notification mode a fresh install starts on — the passive toast. */
export const DEFAULT_SCRAPE_NOTIFICATIONS: ScrapeNotificationMode = 'TOAST';

/** Reconcile a persisted/unknown scrape-notification mode against the live union. */
export function normaliseScrapeNotifications(value: unknown): ScrapeNotificationMode {
  return normaliseOneOf(value, SCRAPE_NOTIFICATION_MODES, DEFAULT_SCRAPE_NOTIFICATIONS);
}

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
  /**
   * The unit a location's derived internal **volume** is read in (issue #457). Volume is stored
   * canonically in **cubic millimetres**; this is presentation only, exactly like
   * {@link dimensionUnit}. Defaults to `'auto'`, which derives a readable unit per value from
   * {@link dimensionUnit} (metric → cm³/litres/m³, imperial → in³/ft³) — so nothing renders as
   * `0.0000027 m³`. A user who prefers a fixed unit can pin one.
   */
  readonly volumeUnit: VolumeUnitPreference;
  /**
   * The global default **packing efficiency** — the fraction (0 < f ≤ 1) of a location's raw
   * usable volume that is realistically fillable — applied to a location that leaves its own
   * `packingFactor` unset when computing cube utilisation (issue #457). Defaults to `1.0` (no
   * haircut). Clamped on write so a stale value can never break the utilisation maths.
   */
  readonly defaultPackingFactor: number;
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
   * single-hue specular glare. **On by default** as part of the maximal "Total Gubbage"
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
   * the maximal "Total Gubbage" animation level, and — like the holographic foil — only shown at
   * that top tier. Purely cosmetic. Projected onto `<html>` as `data-gamify-cards`; the CSS gates
   * the card frame (the dialog gem is gated in JS at its call site).
   */
  readonly gamifyCards: boolean;
  /**
   * Branding — **custom accent** toggle (issue #110, Settings → Branding). When on, {@link
   * customAccentHue} overrides the preset {@link accent}: the apply seam projects the brand tokens
   * inline on `<html>` for the resolved mode. **Off by default**, so the preset accent is unchanged
   * until the user opts in. Composes with mode/OLED/high-contrast exactly as a preset accent does.
   */
  readonly customAccentEnabled: boolean;
  /**
   * Branding — the **custom accent hue** (0–359°) used when {@link customAccentEnabled} is on. The
   * lightness/chroma and per-hue foreground are derived (`theme-registry.customAccentVars`) so any
   * hue stays legible; only the hue is stored. Defaults to the signature violet (277°).
   */
  readonly customAccentHue: number;
  /**
   * Branding — a short **custom tagline** shown beside the fixed "Gubbins" wordmark in the app chrome
   * (nav header + dashboard hero), e.g. an organisation name, so a user can brand their copy. The
   * "Gubbins" name itself is never editable — this is an *addition*, never a replacement. Blank by
   * default (nothing extra shown). Stored verbatim; trimmed and length-guarded at the point of use.
   */
  readonly brandTagline: string;
  /**
   * Branding — the **surface style** ({@link SurfaceStyle}): how opaque the app's content surfaces
   * (cards, panels) are. **Defaults to `solid`** (baseline unchanged); `soft`/`sheer` let the
   * background mode/accent show through. Projected onto `<html>` as `data-surface`; the CSS re-mixes
   * the card tokens. Overlays stay opaque and high contrast forces solid, so legibility is preserved.
   */
  readonly surfaceStyle: SurfaceStyle;
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
  /**
   * The hosts this device has agreed a **category data lookup** may contact directly (issue
   * #616) — e.g. `www.wikidata.org`.
   *
   * Deliberately a *set of hosts* rather than a second boolean: agreeing to query an open film
   * database is not agreement to query everything, so {@link allowOnlineProductLookup} does not
   * generalise here. Empty by default; a host is added only through the one-time consent prompt
   * the lookup panel shows before its first direct fetch. The privileged extension path, when
   * installed, does not consult this — the extension's own manifest allow-list is the gate there.
   */
  readonly lookupConsentHosts: readonly string[];
  /** Which barcode symbology the live scanner decodes (§6.6); `'all'` scans every supported code. */
  readonly scannerSymbology: ScannerSymbology;
  /**
   * Default printable-label template (Phase 73 "Label customisation") — the symbology,
   * text fields and columns a label sheet uses. Held here rather than in the database because
   * label layout is a printer/paper concern; it travels only if the user opts the *Scanning &
   * labels* group into a backup (issue #175) or into live settings sync (issue #382), which is
   * exactly the escape hatch for a second device on a different printer. The Print-labels
   * dialog seeds an editable working copy from this and can save changes back as the new default.
   */
  readonly labelTemplate: LabelTemplate;
  /**
   * Optional base URL that printable QR codes / barcodes should link to (spec §6). Empty
   * means "derive from the address this app is opened from" (`origin` + Vite base path).
   * Set it to a stable name every device can reach — e.g. `https://gubbins.local` — so a
   * label printed from a `localhost` dev server still resolves from a phone. A printing/network
   * concern, so it lives here rather than in the database and travels only with the *Scanning &
   * labels* group; resolved by `resolveLabelBaseUrl`, which assumes `https://` for a
   * scheme-less value because the app cannot boot from a plain-`http://` origin.
   */
  readonly labelBaseUrl: string;
  /**
   * Which camera the live scanner opens, as a `deviceId` picked from the viewfinder's camera menu
   * (issue #135). Empty — the default — asks for "a rear camera" and lets the browser choose; a
   * phone with several rear lenses often picks the ultra-wide, which cannot focus at
   * barcode-reading distance, so the choice is worth remembering once made.
   *
   * **Device-local and deliberately non-portable** (see `NON_PORTABLE_PREF_FIELDS`): a `deviceId`
   * is an opaque per-origin handle to *this* machine's hardware and means nothing anywhere else.
   * An id that no longer opens is fallen back from at acquisition time, so a stale value is
   * self-healing rather than a dead scanner.
   */
  readonly scannerCameraId: string;
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
   * The fallback for {@link visualCardMetric} when the chosen metric has nothing to show for a
   * given item (issue #107) — e.g. "Manufacturer" primary with a "Stock health" fallback shows
   * the maker where one is set and the reorder status everywhere else. The read side resolves it
   * against the item via `resolveVisualCardMetric`. Defaults to `none` (the primary shows its own
   * muted placeholder), so an upgrade changes nothing until the user opts in. See
   * {@link VisualCardMetricFallback}.
   */
  readonly visualCardMetricFallback: VisualCardMetricFallback;
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
   * Whether a category's optional glyph is painted as a faint greyscale watermark on the
   * Visual cards of its items (issue #83). **On by default** — the watermark is a discoverable
   * cue that groups the grid at a glance. Turning it off hides every category watermark without
   * clearing any category's glyph. Only affects the Visual card (rows/table never show it).
   */
  readonly categoryWatermarks: boolean;
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
  /**
   * How many days stock must sit unmoved before the §3 "Dead stock" report flags it
   * (issue #92). Only items opted in — directly, or via the location they sit in — are
   * reported at all, and a location may override this threshold for its own contents;
   * this is the global default they fall back to. Clamped to
   * {@link import('@/features/settings/settings').DEAD_STOCK_DAYS_BOUNDS}.
   */
  readonly deadStockDays: number;
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
   * When the §2.7 weekly-backup banner should reappear after the user dismissed it (UNIX-ms),
   * or null if it was never dismissed. Dismissing snoozes the nudge rather than hiding it for
   * good — it returns after {@link import('@/features/archive/auto-archive').ARCHIVE_NUDGE_SNOOZE_MS}
   * if a fresh archive still hasn't been taken.
   */
  readonly archiveNudgeSnoozedUntil: number | null;
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
  /**
   * Master switch for the global keyboard shortcuts (issue #32). When off, no hotkey is bound
   * at all — the app claims no key presses, which is the escape hatch for anyone whose
   * assistive technology or browser extension wants those keys instead. **On by default**, so
   * the shipped shortcuts are discoverable. The individual bindings live in
   * {@link hotkeyBindings}; this only decides whether any of them are listened for.
   */
  readonly hotkeysEnabled: boolean;
  /**
   * The rebindable shortcut for each action — a map of `HotkeyActionId` → binding string
   * (`'F1'`, `'Ctrl+/'`, or `''` for deliberately unbound). Only the high-traffic actions ship
   * with a default; the rest are listed in Settings ready to be given a key. Persisted as
   * *intent* and reconciled through `normaliseHotkeyBindings` on read, so a map written by an
   * older version (missing today's actions) or holding a since-reserved chord can never reach
   * the dispatcher. See `features/hotkeys/hotkeys.ts` for the registry and binding grammar.
   */
  readonly hotkeyBindings: Record<HotkeyActionId, HotkeyBinding>;
  /** Show the quick-action buttons (Add item / Scan) in the dashboard hero. */
  readonly dashboardQuickActions: boolean;
  /** Show the first-run "getting started" panel while the inventory is still empty. */
  readonly dashboardGettingStarted: boolean;
  /**
   * Hide dashboard cards that currently have nothing to report (issue #111) — a Low-stock card
   * with everything in stock, Overdue with no late loans, In transit with nothing on its way, and
   * so on. The exception/attention cards (low stock, soon to expire, overdue, maintenance due,
   * budget alerts) and the two feed cards (in transit, project statuses) are affected; the cards
   * that always describe something (totals, recent activity, system status) are always shown.
   * **Off by default** so the full board stays discoverable. The board only probes the widgets'
   * empty state while this is on. Ignored while the board is being customised, so every card can
   * be arranged.
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
   * Whether this device shares its eligible preferences live with the others over cloud sync
   * (issue #382). **Off by default**, and deliberately so: a desktop and a phone may legitimately
   * want different layouts and densities, and silently overwriting one from the other is worse
   * than not syncing at all — so this is something the user asks for, never something they get.
   *
   * Device-local (it sits in the `device` settings group): syncing the opt-in itself would let one
   * machine switch sharing on for another, which is precisely the choice it exists to leave local.
   */
  readonly settingsSyncEnabled: boolean;
  /**
   * Which settings **groups** this device shares while {@link settingsSyncEnabled} is on, keyed by
   * the group ids issue #175's backup picker already uses — so "share my appearance but not my
   * dashboard layout" is expressible, at the same granularity the user already understands.
   *
   * Only groups marked live-syncable can be ticked; the `device` group (bridge address, kiosk mode,
   * snooze timestamps) and the bridge access token are never eligible however this reads, and an
   * unknown id from another build is dropped rather than trusted.
   */
  readonly settingsSyncGroups: SettingsGroupSelection;
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
   * Which Home Assistant entity is "the scale" for counting by weight (issue #122), e.g.
   * `sensor.workshop_scale`. Device-local: the scale is a property of *where you are standing*,
   * not of the shared inventory, so a second device in another room keeps its own choice rather
   * than inheriting one that would weigh the wrong bench. Empty until the user picks one, which
   * is also the "never used this" state — the reading is strictly opt-in and manual entry
   * remains the default path.
   */
  readonly scaleEntityId: string;
  /**
   * Printed **parts-catalogue letterhead** (issue #22 follow-up). The branding fields the
   * Catalogue screen stamps onto the printed document, so a company can print an on-brand
   * catalogue. Persisted (localStorage) so the letterhead is set once and reused on every print;
   * held outside the database as a printing/branding concern, and travelling only with the
   * *Catalogue letterhead* group (issues #175, #382) — which is usually wanted, since the
   * letterhead describes the organisation rather than the machine. All optional — empty fields
   * simply don't render.
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
   * section — Advanced analytics, Stock movement, Spend analytics, Sales & disposals — remembers
   * its own choice independently, so switching one doesn't move the others, and the pick survives
   * a reload.
   * Persisted as *intent* and reconciled through `normaliseAnalyticsWindow` on read, so a window
   * no longer offered can never reach a query key or the segmented control. Default is the shared
   * {@link DEFAULT_ANALYTICS_WINDOW} (a quarter).
   */
  readonly reportsAnalyticsWindow: number;
  readonly reportsMovementWindow: number;
  readonly reportsSpendWindow: number;
  readonly reportsSalesWindow: number;
  setBaseCurrency: (currency: string) => void;
  setLocale: (locale: string) => void;
  /** Choose the unit weights are shown/entered in (stored weights stay in grams). */
  setWeightUnit: (unit: WeightUnit) => void;
  /** Choose the unit dimensions are shown/entered in (stored dimensions stay in millimetres). */
  setDimensionUnit: (unit: DimensionUnit) => void;
  /** Choose the unit volumes are shown in, or `'auto'` to derive one (stored volumes stay mm³). */
  setVolumeUnit: (unit: VolumeUnitPreference) => void;
  /** Set the global default packing efficiency used for locations that don't override it. */
  setDefaultPackingFactor: (factor: number) => void;
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
  /** Turn the custom brand accent on/off (when on, {@link customAccentHue} overrides the preset accent). */
  setCustomAccentEnabled: (enabled: boolean) => void;
  /** Set the custom brand accent hue (clamped/wrapped to 0–359°). */
  setCustomAccentHue: (hue: number) => void;
  /** Set the custom brand tagline shown beside the "Gubbins" wordmark (stored verbatim). */
  setBrandTagline: (tagline: string) => void;
  /** Choose the surface style (opacity of cards/panels). */
  setSurfaceStyle: (style: SurfaceStyle) => void;
  setAttachmentMode: (mode: AttachmentMode) => void;
  setScrapeNotifications: (mode: ScrapeNotificationMode) => void;
  /** Record the user's consent (or withdrawal) for direct online barcode lookups (issue #59). */
  setAllowOnlineProductLookup: (allowed: boolean) => void;
  /** Grant or withdraw this device's consent for a category lookup to contact one host (#616). */
  setLookupHostConsent: (host: string, allowed: boolean) => void;
  setScannerSymbology: (symbology: ScannerSymbology) => void;
  setLabelTemplate: (template: LabelTemplate) => void;
  setLabelBaseUrl: (url: string) => void;
  /** Remember which camera the live scanner should open (issue #135); `''` restores the default. */
  setScannerCameraId: (deviceId: string) => void;
  setScannerBeep: (enabled: boolean) => void;
  setScannerHaptics: (enabled: boolean) => void;
  setVisualCardMetric: (metric: VisualCardMetric) => void;
  /** Choose the Visual-card hero's fallback for items the chosen metric can't apply to (issue #107). */
  setVisualCardMetricFallback: (metric: VisualCardMetricFallback) => void;
  setCardClickAction: (action: CardClickAction) => void;
  /** Choose what the item card/row badge slot shows (issue #117). */
  setCardBadgeContent: (content: CardBadgeContent) => void;
  /** Choose the badge slot's fallback for items the chosen content can't apply to. */
  setCardBadgeFallback: (content: CardBadgeContent) => void;
  /** Replace the item-card field configuration (order + visibility). */
  setCardFields: (fields: CardFieldsConfig) => void;
  /** Turn category glyph card watermarks on/off across the Visual card grid (issue #83). */
  setCategoryWatermarks: (enabled: boolean) => void;
  /** Restore the shipped default card-field configuration. */
  resetCardFields: () => void;
  /** Point a configurable Dashboard nav tile at a different count metric. */
  setNavCountMetric: (route: NavCountRoute, metric: string) => void;
  setExpirySoonWindowDays: (days: number) => void;
  setLowStockQtyThreshold: (qty: number) => void;
  setLowStockGaugePercent: (percent: number) => void;
  /** Set the global dead-stock idle threshold in days (clamped to the safe range). */
  setDeadStockDays: (days: number) => void;
  setBudgetWarnPercent: (percent: number) => void;
  /** Turn list pagination on/off across the browse lists (issue #20). */
  setPaginateLists: (enabled: boolean) => void;
  /** Set the default items-per-page (clamped to the safe range). */
  setDefaultPageSize: (size: number) => void;
  setPruneWindowMonths: (months: number) => void;
  setDowngradeWindowMonths: (months: number) => void;
  setLastArchivedAt: (at: number) => void;
  /** Snooze (or, with `null`, clear the snooze on) the weekly-backup banner until a UNIX-ms instant. */
  setArchiveNudgeSnoozedUntil: (until: number | null) => void;
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
  /** Turn the global keyboard shortcuts on/off wholesale (issue #32). */
  setHotkeysEnabled: (enabled: boolean) => void;
  /** Rebind one action; `''` unbinds it. Invalid/reserved chords fall back to its default. */
  setHotkeyBinding: (id: HotkeyActionId, binding: HotkeyBinding) => void;
  /** Replace the whole map at once — how a preset scheme is applied (issue #127). */
  setHotkeyBindings: (bindings: Record<HotkeyActionId, HotkeyBinding>) => void;
  /** Restore every shortcut to its shipped default. */
  resetHotkeyBindings: () => void;
  setDashboardQuickActions: (enabled: boolean) => void;
  setDashboardGettingStarted: (enabled: boolean) => void;
  /** Turn "hide healthy cards" (issue #111) on/off for the dashboard board. */
  setHideHealthyDashboardCards: (enabled: boolean) => void;
  /** Permanently dismiss the dashboard backup/sync nudge. */
  dismissBackupNudge: () => void;
  /** Permanently dismiss the pre-1.0 work-in-progress warning banner (after confirmation). */
  dismissWipBanner: () => void;
  /** Turn live settings sync (issue #382) on/off for this device. */
  setSettingsSyncEnabled: (enabled: boolean) => void;
  /**
   * Replace which settings groups this device shares. Ineligible and unknown group ids are
   * dropped on the way in, so a hand-edited store cannot widen what travels.
   */
  setSettingsSyncGroups: (groups: SettingsGroupSelection) => void;
  setBridgeUrl: (url: string) => void;
  setBridgeToken: (token: string) => void;
  /** Choose which Home Assistant entity is the scale (empty clears the choice). */
  setScaleEntityId: (entityId: string) => void;
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
  setReportsMovementWindow: (days: number) => void;
  setReportsSpendWindow: (days: number) => void;
  setReportsSalesWindow: (days: number) => void;
}

export const usePreferencesStore = create<PreferencesStore>()(
  persist(
    (set) => ({
      // First-run guess from the browser locale; the persisted value (if any) wins.
      baseCurrency: guessBaseCurrency(),
      locale: DEFAULT_LOCALE,
      weightUnit: DEFAULT_WEIGHT_UNIT,
      dimensionUnit: DEFAULT_DIMENSION_UNIT,
      volumeUnit: DEFAULT_VOLUME_UNIT,
      defaultPackingFactor: DEFAULT_PACKING_FACTOR,
      mode: DEFAULT_MODE,
      accent: DEFAULT_ACCENT,
      oledDark: false,
      highContrast: false,
      fullWidth: false,
      animationLevel: DEFAULT_ANIMATION_LEVEL,
      backgroundEffect: DEFAULT_BACKGROUND_EFFECT,
      // On by default — part of the maximal "Total Gubbage" tier, and only rendered there.
      holographicCards: true,
      gamifyCards: true,
      // Branding (issue #110) — off/neutral by default so the shipped look is unchanged until opted into.
      customAccentEnabled: false,
      customAccentHue: DEFAULT_CUSTOM_ACCENT_HUE,
      brandTagline: '',
      surfaceStyle: DEFAULT_SURFACE_STYLE,
      attachmentMode: DEFAULT_ATTACHMENT_MODE,
      scrapeNotifications: DEFAULT_SCRAPE_NOTIFICATIONS,
      allowOnlineProductLookup: false,
      lookupConsentHosts: [],
      scannerSymbology: DEFAULT_SCANNER_SYMBOLOGY,
      labelTemplate: DEFAULT_LABEL_TEMPLATE,
      labelBaseUrl: '',
      scannerCameraId: '',
      scannerBeep: true,
      scannerHaptics: true,
      visualCardMetric: DEFAULT_VISUAL_CARD_METRIC,
      visualCardMetricFallback: DEFAULT_VISUAL_CARD_METRIC_FALLBACK,
      cardClickAction: DEFAULT_CARD_CLICK_ACTION,
      cardBadgeContent: DEFAULT_CARD_BADGE_CONTENT,
      cardBadgeFallback: DEFAULT_CARD_BADGE_FALLBACK,
      cardFields: DEFAULT_CARD_FIELDS,
      categoryWatermarks: true,
      navCountMetrics: DEFAULT_NAV_COUNT_METRICS,
      expirySoonWindowDays: EXPIRY_SOON_WINDOW_DAYS,
      lowStockQtyThreshold: LOW_STOCK_QTY_THRESHOLD,
      lowStockGaugePercent: LOW_STOCK_GAUGE_PERCENT,
      deadStockDays: DEAD_STOCK_SINCE_DAYS,
      budgetWarnPercent: BUDGET_WARN_PERCENT,
      paginateLists: false,
      defaultPageSize: DEFAULT_ITEMS_PER_PAGE,
      pruneWindowMonths: DEFAULT_WINDOW_MONTHS,
      downgradeWindowMonths: DEFAULT_WINDOW_MONTHS,
      lastArchivedAt: null,
      archiveNudgeSnoozedUntil: null,
      kioskMode: false,
      remindersEnabled: false,
      reminderKinds: DEFAULT_REMINDER_KINDS,
      ocrEnabled: false,
      ocrModel: DEFAULT_OCR_MODEL,
      dashboardCommandPalette: true,
      hotkeysEnabled: true,
      hotkeyBindings: DEFAULT_HOTKEY_BINDINGS,
      dashboardQuickActions: true,
      dashboardGettingStarted: true,
      hideHealthyDashboardCards: false,
      backupNudgeDismissed: false,
      wipBannerDismissed: false,
      settingsSyncEnabled: false,
      settingsSyncGroups: DEFAULT_LIVE_SETTINGS_SELECTION,
      bridgeUrl: '',
      bridgeToken: '',
      scaleEntityId: '',
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
      reportsMovementWindow: DEFAULT_ANALYTICS_WINDOW,
      reportsSpendWindow: DEFAULT_ANALYTICS_WINDOW,
      reportsSalesWindow: DEFAULT_ANALYTICS_WINDOW,
      // Normalise so a code/tag `Intl` would reject can never reach the formatter bundle, which
      // builds its `Intl.*Format` objects eagerly and would throw on the next render.
      setBaseCurrency: (currency) => set({ baseCurrency: normaliseCurrency(currency) }),
      setLocale: (locale) => set({ locale: normaliseLocale(locale) }),
      // Normalise so a stale/unknown persisted value can never reach the formatter/conversions.
      setWeightUnit: (unit) => set({ weightUnit: normaliseWeightUnit(unit) }),
      // Normalise so a stale/unknown persisted value can never reach the formatter/conversions.
      setDimensionUnit: (unit) => set({ dimensionUnit: normaliseDimensionUnit(unit) }),
      // Normalise so a stale/unknown persisted value can never reach the formatter (preserves 'auto').
      setVolumeUnit: (unit) => set({ volumeUnit: normaliseVolumeUnit(unit) }),
      // Clamp to (0,1] so a stale/typed value can never collapse a location's effective capacity.
      setDefaultPackingFactor: (factor) => set({ defaultPackingFactor: clampPackingFactor(factor) }),
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
          // The maximal "Total Gubbage" preset is "everything on", so it brings the ambient
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
      setCustomAccentEnabled: (customAccentEnabled) => set({ customAccentEnabled }),
      // Clamp/wrap so a stale/out-of-range persisted or typed hue can never reach the apply seam.
      setCustomAccentHue: (hue) => set({ customAccentHue: clampAccentHue(hue) }),
      // Stored verbatim (like the catalogue letterhead text): trimming on every keystroke would eat a
      // space the moment it lands at the end, so any incidental whitespace is trimmed at point of use.
      setBrandTagline: (brandTagline) => set({ brandTagline }),
      // Normalise so a stale/unknown persisted value can never reach the apply seam / CSS gate.
      setSurfaceStyle: (style) => set({ surfaceStyle: normaliseSurfaceStyle(style) }),
      // Normalise so a stale/unknown persisted value can never reach the attachment picker.
      setAttachmentMode: (mode) => set({ attachmentMode: normaliseAttachmentMode(mode) }),
      setScrapeNotifications: (mode) => set({ scrapeNotifications: normaliseScrapeNotifications(mode) }),
      setAllowOnlineProductLookup: (allowOnlineProductLookup) => set({ allowOnlineProductLookup }),
      // Hosts are lower-cased and order-stabilised so granting the same consent twice — or in a
      // different order on another device — produces the identical stored array rather than a
      // write that looks like a change.
      setLookupHostConsent: (host, allowed) =>
        set((state) => {
          const key = host.trim().toLowerCase();
          if (key.length === 0) return {};
          const next = new Set(state.lookupConsentHosts);
          if (allowed) next.add(key);
          else next.delete(key);
          return { lookupConsentHosts: [...next].sort() };
        }),
      // Normalise so a stale/out-of-range persisted value can never reach the decoder.
      setScannerSymbology: (symbology) => set({ scannerSymbology: normaliseSymbology(symbology) }),
      // Normalise so a stale/partial persisted template can never reach the renderer.
      setLabelTemplate: (template) => set({ labelTemplate: normaliseLabelTemplate(template) }),
      // Stored verbatim (trimmed); the forgiving `resolveLabelBaseUrl` normalises at read time.
      setLabelBaseUrl: (labelBaseUrl) => set({ labelBaseUrl: labelBaseUrl.trim() }),
      // A `deviceId` is an opaque browser string, so there is nothing to validate here — an id that
      // no longer opens is recovered from at acquisition time (see `useScanner`), not on write.
      setScannerCameraId: (scannerCameraId) => set({ scannerCameraId }),
      setScannerBeep: (scannerBeep) => set({ scannerBeep }),
      setScannerHaptics: (scannerHaptics) => set({ scannerHaptics }),
      // Normalise so a stale/unknown persisted value can never reach the card renderer.
      setVisualCardMetric: (metric) => set({ visualCardMetric: normaliseVisualCardMetric(metric) }),
      setVisualCardMetricFallback: (metric) =>
        set({ visualCardMetricFallback: normaliseVisualCardMetricFallback(metric) }),
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
      setCategoryWatermarks: (categoryWatermarks) => set({ categoryWatermarks }),
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
      setDeadStockDays: (days) => set({ deadStockDays: clampDeadStockDays(days) }),
      setBudgetWarnPercent: (percent) => set({ budgetWarnPercent: clampBudgetWarnPercent(percent) }),
      setPaginateLists: (paginateLists) => set({ paginateLists }),
      // Clamp so a stale/out-of-range persisted or typed value can never reach the page maths.
      setDefaultPageSize: (size) => set({ defaultPageSize: clampPageSize(size) }),
      setPruneWindowMonths: (months) => set({ pruneWindowMonths: normaliseWindowMonths(months) }),
      setDowngradeWindowMonths: (months) => set({ downgradeWindowMonths: normaliseWindowMonths(months) }),
      setLastArchivedAt: (lastArchivedAt) => set({ lastArchivedAt }),
      setArchiveNudgeSnoozedUntil: (archiveNudgeSnoozedUntil) => set({ archiveNudgeSnoozedUntil }),
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
      setHotkeysEnabled: (hotkeysEnabled) => set({ hotkeysEnabled }),
      // Merge one action's chord (re-normalised whole, so a rejected value falls back to that
      // action's default) over the map, leaving every other binding untouched.
      setHotkeyBinding: (id, binding) =>
        set((state) => ({
          hotkeyBindings: normaliseHotkeyBindings({ ...state.hotkeyBindings, [id]: binding }),
        })),
      // Normalised on the way in for the same reason a single rebind is: a preset is data, and
      // data that has been edited or has aged past a registry change must not reach the matcher.
      setHotkeyBindings: (bindings) => set({ hotkeyBindings: normaliseHotkeyBindings(bindings) }),
      resetHotkeyBindings: () => set({ hotkeyBindings: DEFAULT_HOTKEY_BINDINGS }),
      setDashboardQuickActions: (dashboardQuickActions) => set({ dashboardQuickActions }),
      setDashboardGettingStarted: (dashboardGettingStarted) => set({ dashboardGettingStarted }),
      setHideHealthyDashboardCards: (hideHealthyDashboardCards) => set({ hideHealthyDashboardCards }),
      dismissBackupNudge: () => set({ backupNudgeDismissed: true }),
      dismissWipBanner: () => set({ wipBannerDismissed: true }),
      setSettingsSyncEnabled: (settingsSyncEnabled) => set({ settingsSyncEnabled }),
      setSettingsSyncGroups: (groups) => set({ settingsSyncGroups: normaliseLiveSettingsSelection(groups) }),
      setBridgeUrl: (bridgeUrl) => set({ bridgeUrl }),
      setBridgeToken: (bridgeToken) => set({ bridgeToken }),
      setScaleEntityId: (scaleEntityId) => set({ scaleEntityId: scaleEntityId.trim() }),
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
      setReportsMovementWindow: (days) => set({ reportsMovementWindow: normaliseAnalyticsWindow(days) }),
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
      // Migration only reshapes the *fields a version bump moved*; it deliberately makes no claim
      // about the rest, which is why it hands back an untyped record rather than asserting the
      // store's shape. `merge` below is the boundary that actually establishes that shape — it
      // runs on this return value and reconciles every field — so nothing here needs to pretend.
      migrate: (persistedState, fromVersion): Record<string, unknown> => {
        // A copy, so the version blocks below can rewrite fields (the store's are `readonly`);
        // anything that isn't an object at all starts from empty and lands on the defaults.
        const state: Record<string, unknown> = isPlainObject(persistedState) ? { ...persistedState } : {};
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
        return state;
      },
      // Rehydrated JSON is untyped: zustand's default merge is a shallow spread of the persisted
      // blob over the defaults, so a `weightUnit` of `"stones"` or a `defaultPageSize` of `-5`
      // would land in the store typed as its narrow union and flow to consumers that switch on it
      // exhaustively or use it as a query key. The setters normalise on write; that only covers
      // freshly-set values, so every persisted field is reconciled here too — the read boundary
      // this store's "a stale value can never reach the engine" comments actually depend on.
      //
      // Every field of the store must appear below, and a new one has to be added here as well as
      // to the defaults: what this returns *replaces* the state wholesale, so an omitted field is
      // not passed through — it silently keeps its default and the user's stored value is dropped
      // on every reload. A unit test seeds each field with its own value over a sentinel store and
      // names anything that survives unreconciled, so the omission fails the build.
      //
      // `cardFields` is only array-checked: its *members* are reconciled against the live
      // custom-field catalog on render (`normaliseCardFields`), which is where a renamed or
      // removed field has to be resolved anyway.
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<Record<keyof PreferencesStore, unknown>>;
        return {
          ...current,
          baseCurrency: normaliseCurrency(p.baseCurrency, current.baseCurrency),
          locale: normaliseLocale(p.locale, current.locale),
          weightUnit: normaliseWeightUnit(p.weightUnit),
          dimensionUnit: normaliseDimensionUnit(p.dimensionUnit),
          volumeUnit: normaliseVolumeUnit(p.volumeUnit),
          defaultPackingFactor: clampPackingFactor(p.defaultPackingFactor),
          mode: normaliseMode(p.mode),
          accent: normaliseAccent(p.accent),
          oledDark: normaliseBoolean(p.oledDark, current.oledDark),
          highContrast: normaliseBoolean(p.highContrast, current.highContrast),
          fullWidth: normaliseBoolean(p.fullWidth, current.fullWidth),
          animationLevel: normaliseAnimationLevel(p.animationLevel),
          backgroundEffect: normaliseBackgroundEffect(p.backgroundEffect),
          holographicCards: normaliseBoolean(p.holographicCards, current.holographicCards),
          gamifyCards: normaliseBoolean(p.gamifyCards, current.gamifyCards),
          customAccentEnabled: normaliseBoolean(p.customAccentEnabled, current.customAccentEnabled),
          customAccentHue: clampAccentHue(p.customAccentHue),
          brandTagline: normaliseString(p.brandTagline, current.brandTagline),
          surfaceStyle: normaliseSurfaceStyle(p.surfaceStyle),
          attachmentMode: normaliseAttachmentMode(p.attachmentMode),
          scrapeNotifications: normaliseScrapeNotifications(p.scrapeNotifications),
          allowOnlineProductLookup: normaliseBoolean(
            p.allowOnlineProductLookup,
            current.allowOnlineProductLookup,
          ),
          // Members are checked, not just the array: a stored `null` or number would otherwise
          // reach the consent test as a host that can never match, and a blank string would
          // match nothing while looking like a grant.
          lookupConsentHosts: normaliseArray<string>(
            p.lookupConsentHosts,
            current.lookupConsentHosts,
            (candidate): candidate is string => typeof candidate === 'string' && candidate.trim().length > 0,
          ),
          scannerSymbology: normaliseSymbology(p.scannerSymbology),
          labelTemplate: normaliseLabelTemplate(p.labelTemplate),
          labelBaseUrl: normaliseString(p.labelBaseUrl, current.labelBaseUrl),
          scannerCameraId: normaliseString(p.scannerCameraId, current.scannerCameraId),
          scannerBeep: normaliseBoolean(p.scannerBeep, current.scannerBeep),
          scannerHaptics: normaliseBoolean(p.scannerHaptics, current.scannerHaptics),
          expirySoonWindowDays: clampExpiryWindowDays(p.expirySoonWindowDays),
          visualCardMetric: normaliseVisualCardMetric(p.visualCardMetric),
          visualCardMetricFallback: normaliseVisualCardMetricFallback(p.visualCardMetricFallback),
          cardClickAction: normaliseCardClickAction(p.cardClickAction),
          cardBadgeContent: normaliseCardBadgeContent(p.cardBadgeContent),
          cardBadgeFallback: normaliseCardBadgeContent(p.cardBadgeFallback, DEFAULT_CARD_BADGE_FALLBACK),
          cardFields: normaliseArray<CardFieldSetting>(p.cardFields, current.cardFields),
          categoryWatermarks: normaliseBoolean(p.categoryWatermarks, current.categoryWatermarks),
          navCountMetrics: normaliseNavCountMetrics(p.navCountMetrics),
          lowStockQtyThreshold: clampLowStockQty(p.lowStockQtyThreshold),
          lowStockGaugePercent: clampLowStockGaugePercent(p.lowStockGaugePercent),
          deadStockDays: clampDeadStockDays(p.deadStockDays),
          budgetWarnPercent: clampBudgetWarnPercent(p.budgetWarnPercent),
          paginateLists: normaliseBoolean(p.paginateLists, current.paginateLists),
          defaultPageSize: clampPageSize(p.defaultPageSize),
          pruneWindowMonths: normaliseWindowMonths(p.pruneWindowMonths),
          downgradeWindowMonths: normaliseWindowMonths(p.downgradeWindowMonths),
          lastArchivedAt: normaliseNullableInteger(p.lastArchivedAt),
          archiveNudgeSnoozedUntil: normaliseNullableInteger(p.archiveNudgeSnoozedUntil),
          kioskMode: normaliseBoolean(p.kioskMode, current.kioskMode),
          remindersEnabled: normaliseBoolean(p.remindersEnabled, current.remindersEnabled),
          reminderKinds: normaliseReminderKinds(p.reminderKinds),
          ocrEnabled: normaliseBoolean(p.ocrEnabled, current.ocrEnabled),
          ocrModel: normaliseOcrModel(p.ocrModel),
          dashboardCommandPalette: normaliseBoolean(
            p.dashboardCommandPalette,
            current.dashboardCommandPalette,
          ),
          hotkeysEnabled: normaliseBoolean(p.hotkeysEnabled, current.hotkeysEnabled),
          hotkeyBindings: normaliseHotkeyBindings(p.hotkeyBindings),
          dashboardQuickActions: normaliseBoolean(p.dashboardQuickActions, current.dashboardQuickActions),
          dashboardGettingStarted: normaliseBoolean(
            p.dashboardGettingStarted,
            current.dashboardGettingStarted,
          ),
          hideHealthyDashboardCards: normaliseBoolean(
            p.hideHealthyDashboardCards,
            current.hideHealthyDashboardCards,
          ),
          backupNudgeDismissed: normaliseBoolean(p.backupNudgeDismissed, current.backupNudgeDismissed),
          wipBannerDismissed: normaliseBoolean(p.wipBannerDismissed, current.wipBannerDismissed),
          settingsSyncEnabled: normaliseBoolean(p.settingsSyncEnabled, current.settingsSyncEnabled),
          settingsSyncGroups: normaliseLiveSettingsSelection(p.settingsSyncGroups),
          bridgeUrl: normaliseString(p.bridgeUrl, current.bridgeUrl),
          bridgeToken: normaliseString(p.bridgeToken, current.bridgeToken),
          scaleEntityId: normaliseString(p.scaleEntityId, current.scaleEntityId),
          catalogueTitle: normaliseString(p.catalogueTitle, current.catalogueTitle),
          catalogueOrgName: normaliseString(p.catalogueOrgName, current.catalogueOrgName),
          catalogueOrgDetails: normaliseString(p.catalogueOrgDetails, current.catalogueOrgDetails),
          catalogueFooter: normaliseString(p.catalogueFooter, current.catalogueFooter),
          catalogueLogo: normaliseCatalogueLogo(p.catalogueLogo),
          catalogueShowGeneratedDate: normaliseBoolean(
            p.catalogueShowGeneratedDate,
            current.catalogueShowGeneratedDate,
          ),
          cataloguePageNumbers: normaliseBoolean(p.cataloguePageNumbers, current.cataloguePageNumbers),
          catalogueRunningHeader: normaliseBoolean(p.catalogueRunningHeader, current.catalogueRunningHeader),
          cataloguePaperPreview: normaliseBoolean(p.cataloguePaperPreview, current.cataloguePaperPreview),
          reportsAnalyticsWindow: normaliseAnalyticsWindow(p.reportsAnalyticsWindow),
          reportsMovementWindow: normaliseAnalyticsWindow(p.reportsMovementWindow),
          reportsSpendWindow: normaliseAnalyticsWindow(p.reportsSpendWindow),
          reportsSalesWindow: normaliseAnalyticsWindow(p.reportsSalesWindow),
        };
      },
    },
  ),
);

/**
 * Return the named preference fields to the values a fresh install starts on, leaving every other
 * preference exactly as the user set it (issue #521).
 *
 * The live-store counterpart to stripping those fields from the persisted blob. Removing a value
 * from `localStorage` on its own is never enough: the running store still holds it, and its next
 * write puts the whole blob — the removed field included — straight back. That is the same trap
 * `features/danger-zone/local-store-resets.ts` exists to close for a whole-key erase (issue #381),
 * and it applies field-by-field for a credential that shares its key with everything else.
 *
 * Unknown field names are ignored rather than written as `undefined`, so a stale name from an
 * older build can never blank a preference the store still has.
 */
export function resetPreferenceFields(fields: readonly string[]): void {
  const defaults = usePreferencesStore.getInitialState() as unknown as Record<string, unknown>;
  const patch: Record<string, unknown> = {};
  for (const field of fields) {
    if (!(field in defaults) || typeof defaults[field] === 'function') continue;
    patch[field] = defaults[field];
  }
  if (Object.keys(patch).length === 0) return;
  usePreferencesStore.setState(patch as Partial<PreferencesStore>);
}
