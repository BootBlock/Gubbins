import { type ReactNode, useEffect, useState } from 'react';
import { Link } from '@tanstack/react-router';
import {
  Button,
  Input,
  RailModal,
  Select,
  Tooltip,
  buttonVariants,
  useInstallPrompt,
  useRovingRadioGroup,
  type RailTab,
} from '@/components/foundry';
import {
  AppearanceIcon,
  CriticalIcon,
  CustomiseIcon,
  DarkThemeIcon,
  DatasheetIcon,
  HomeIcon,
  InfoIcon,
  InstallIcon,
  KioskIcon,
  LightThemeIcon,
  LowStockIcon,
  ModulesIcon,
  NotificationIcon,
  PackageIcon,
  QrCodeIcon,
  ScanIcon,
  StorageIcon,
  SystemThemeIcon,
} from '@/components/icons';
import { SCANNER_SYMBOLOGY_OPTIONS } from '@/features/scanner/scanner-formats';
import { buildItemQrUrl, resolveLabelBaseUrl } from '@/features/scanner/scan-payload';
import { hasOcr } from '@/lib/env/feature-detection';
import { cn } from '@/lib/utils';
import { useFeature } from '@/features/modules/useFeature';
import { useT } from '@/features/i18n';
import { usePreferencesStore, type Accent, type Mode } from '@/state/stores/usePreferencesStore';
import { SettingsSection, SettingRow } from './SettingsSection';
import { ReminderSettings } from '@/features/alerts/ReminderSettings';
import { CardFieldsSetting } from '@/features/inventory/components/CardFieldsSetting';
import { DangerZone } from '@/features/danger-zone/DangerZone';
import { DatabaseMaintenance } from '@/features/maintenance';
import { StorageTriageDialog } from '@/features/storage/StorageTriageDialog';
import { monthsLabel } from '@/features/storage/triage';
import {
  BUDGET_WARN_BOUNDS,
  CARD_CLICK_ACTION_OPTIONS,
  CURRENCY_OPTIONS,
  EXPIRY_WINDOW_BOUNDS,
  LOW_STOCK_GAUGE_BOUNDS,
  LOW_STOCK_QTY_BOUNDS,
  NAV_COUNT_METRIC_CONFIG,
  NAV_COUNT_ROUTES,
  VISUAL_CARD_METRIC_OPTIONS,
  WINDOW_MONTH_OPTIONS,
  clampBudgetWarnPercent,
  clampExpiryWindowDays,
  clampLowStockGaugePercent,
  clampLowStockQty,
  guessBaseCurrency,
  normaliseNavCountMetric,
  type NavCountRoute,
} from './settings';
import {
  ACCENTS,
  ANIMATION_LEVELS,
  BACKGROUND_EFFECTS,
  MODE_OPTIONS,
  STARFIELD_VARIANTS,
} from './theme-registry';
import { WEIGHT_UNIT_OPTIONS } from '@/lib/weight';
import { DIMENSION_UNIT_OPTIONS } from '@/lib/dimensions';

/** Starfield-variant choices for the Appearance `Select` (visual-flair F11), in registry order. */
const STARFIELD_VARIANT_OPTIONS = STARFIELD_VARIANTS.map((v) => ({ value: v.id, label: v.label }));

/** Animation-level choices for the Appearance `Select`, liveliest → calmest (registry order). */
const ANIMATION_LEVEL_OPTIONS = ANIMATION_LEVELS.map((l) => ({ value: l.id, label: l.label }));

/** Rich-Markdown help for the animation-level control — spells out what each tier calms. */
const ANIMATION_LEVEL_HINT =
  'Sets **how visually animated Gubbins is** — from every flourish down to a perfectly still, ' +
  'quiet interface. You’re first asked this when the app starts up; change it any time here.\n\n' +
  ANIMATION_LEVELS.map((l) => `- **${l.label}** — ${l.description}`).join('\n') +
  '\n\nIt never touches anything functional — loading spinners still spin, and the meaning, focus ' +
  'rings and screen-reader announcements are unchanged. It **adds** to your device’s “reduce ' +
  'motion” accessibility setting: if that already prefers reduced motion, the extras stay off ' +
  'whatever you pick here.';

/** Background-effect choices for the Appearance `Select` (none / rain / snow), in registry order. */
const BACKGROUND_EFFECT_OPTIONS = BACKGROUND_EFFECTS.map((e) => ({ value: e.id, label: e.label }));

/** On/off pair for the many boolean-preference {@link Select}s (On listed first). */
const ON_OFF_OPTIONS = [
  { value: 'on', label: 'On' },
  { value: 'off', label: 'Off' },
] as const;

/** Off/on pair for a boolean preference that reads more naturally Off-first (Kiosk mode). */
const OFF_ON_OPTIONS = [
  { value: 'off', label: 'Off' },
  { value: 'on', label: 'On' },
] as const;

/** Locales offered for formatting (Intl, §2.4.3); en-GB is the default (§1.2.1). */
const LOCALE_OPTIONS = [
  { value: 'en-GB', label: 'English (United Kingdom)' },
  { value: 'en-US', label: 'English (United States)' },
  { value: 'de-DE', label: 'German (Germany)' },
  { value: 'fr-FR', label: 'French (France)' },
] as const;

/**
 * Rich-Markdown help for each configurable nav-tile count picker (backlog A1). Keyed by the
 * same route as {@link NAV_COUNT_METRIC_CONFIG}; explains what each metric counts so the
 * self-descriptive option labels gain the "why".
 */
const NAV_COUNT_HINTS: Record<NavCountRoute, string> = {
  '/inventory':
    'What the Dashboard **Inventory** tile counts:\n\n' +
    '- **All items** — every item in your catalogue (the default).\n' +
    '- **Low-stock items** — items at or below their reorder point; the count turns a warning colour.\n' +
    '- **Out-of-stock items** — items with nothing on hand; the count turns a danger colour.',
  '/projects':
    'What the Dashboard **Projects** tile counts:\n\n' +
    '- **Active projects** — everything not yet completed or archived (the default).\n' +
    '- **All projects** — every project, whatever its status.\n' +
    '- **Over-budget projects** — budgeted projects whose spend or projected cost has passed the budget; the count turns a danger colour.',
  '/purchase-orders':
    'What the Dashboard **Purchase orders** tile counts:\n\n' +
    '- **Open orders** — draft, ordered or partially-received orders still in flight (the default).\n' +
    '- **All orders** — every order, including received and cancelled ones.',
  '/bookings':
    'What the Dashboard **Bookings** tile counts:\n\n' +
    '- **Upcoming bookings** — not cancelled or converted, and their last day hasn’t passed (the default).\n' +
    '- **Starting this week** — upcoming bookings that begin within the next seven days.\n' +
    '- **All bookings** — every booking on record.',
};

/**
 * Settings dialog (spec §3, §2.1 Tier-2 `usePreferencesStore`).
 *
 * The former dedicated Settings *screen* is now a {@link RailModal} that opens over
 * whatever screen you are on, so preferences are reachable everywhere without a full
 * navigation. It is lazy-loaded (see `SettingsDialogHost`), so its chunk and this whole
 * control tree cost nothing until the dialog is first opened — fitting for a surface used
 * mostly during onboarding and the occasional tweak.
 *
 * The many preference sections are grouped into a handful of rail tabs; each control still
 * writes straight to the store, which persists to localStorage and feeds the read layer, so
 * every change takes effect in real time on the screen underneath. Every control also
 * carries a rich-Markdown {@link SettingRow.hint} explaining what it does and when you'd
 * want it. The Danger zone sits apart at the foot of the rail, tinted, where irreversible
 * actions conventionally live.
 *
 * Default-exported so it can be `React.lazy`-imported by its host.
 */
export default function SettingsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT();
  const prefs = usePreferencesStore();
  const [triageOpen, setTriageOpen] = useState(false);
  const install = useInstallPrompt();

  // Modular UI (Phase 7): controls whose feature is off are hidden here too, so a hidden
  // capability leaves no orphaned setting behind. The Scanner section drops whole; the
  // "expiring soon" window and budget-warn rows drop individually (their section stays for
  // the always-present low-stock thresholds — no empty section shell).
  const scannerOn = useFeature('scanner');
  const perishablesOn = useFeature('perishables');
  const inventoryOn = useFeature('inventory');
  const projectsOn = useFeature('projects');
  const purchaseOrdersOn = useFeature('purchase-orders');
  const bookingsOn = useFeature('bookings');

  // A configurable nav-tile count picker is shown only when its tile's feature is enabled —
  // a hidden tile has no count to re-point. Keyed by the same route as NAV_COUNT_METRIC_CONFIG.
  const navCountFeatureOn: Record<NavCountRoute, boolean> = {
    '/inventory': inventoryOn,
    '/projects': projectsOn,
    '/purchase-orders': purchaseOrdersOn,
    '/bookings': bookingsOn,
  };
  const anyNavCountPicker = NAV_COUNT_ROUTES.some((route) => navCountFeatureOn[route]);

  const tabs: readonly RailTab[] = [
    {
      id: 'appearance',
      label: 'Appearance',
      icon: <AppearanceIcon />,
      content: (
        <SettingsSection icon={<AppearanceIcon />} title="Appearance">
          <SettingRow
            stack
            fill
            label="Mode"
            description="Light, dark, or follow your device."
            hint={
              'The base light/dark palette for the whole app.\n\n' +
              '- **Light** — a bright palette for well-lit rooms.\n' +
              '- **Dark** — the deep, low-glare default.\n' +
              '- **System** — follow your device and switch automatically when it does (e.g. at sunset).\n\n' +
              'Pick your **Colour** separately below — it applies in either mode.'
            }
          >
            <ModeToggle mode={prefs.mode} onChange={prefs.setMode} />
          </SettingRow>
          <SettingRow
            stack
            fill
            label="Colour"
            description="The accent colour for buttons, links and highlights."
            hint={
              'The brand **accent** colour — used for primary buttons, links, focus rings and the ' +
              '“look here” highlight. It is independent of light/dark, so the colour you pick reads ' +
              'the same in either mode (tuned for each). Surfaces stay neutral; only the accent changes.'
            }
          >
            <AccentPicker accent={prefs.accent} onChange={prefs.setAccent} />
          </SettingRow>
          <SettingRow
            label="Pure black (OLED)"
            description="Use a true-black background in dark mode, ideal for OLED screens."
            hint={
              'Drops the **dark-mode** surfaces to true black (`#000`), where an OLED display turns ' +
              'those pixels fully off — deeper contrast and a little less battery use.\n\n' +
              'Only affects **dark mode**; it composes with any colour. No effect in light mode.'
            }
          >
            <Select
              aria-label="Pure black (OLED)"
              data-testid="setting-oled"
              className="h-9 w-40"
              value={prefs.oledDark ? 'on' : 'off'}
              onChange={(value) => prefs.setOledDark(value === 'on')}
              options={OFF_ON_OPTIONS}
            />
          </SettingRow>
          <SettingRow
            label="High contrast"
            description="Boost contrast and borders for maximum legibility."
            hint={
              'An **accessibility** mode that raises contrast across the app: near pure black/white ' +
              'surfaces, bolder visible borders, and secondary text that stays strong rather than ' +
              'dimming.\n\n' +
              'Works in both light and dark mode and overrides the neutral palette, while keeping ' +
              'your chosen colour.'
            }
          >
            <Select
              aria-label="High contrast"
              data-testid="setting-high-contrast"
              className="h-9 w-40"
              value={prefs.highContrast ? 'on' : 'off'}
              onChange={(value) => prefs.setHighContrast(value === 'on')}
              options={OFF_ON_OPTIONS}
            />
          </SettingRow>
          <SettingRow
            label="Animation"
            description="How visually animated the interface is."
            hint={ANIMATION_LEVEL_HINT}
          >
            <Select
              aria-label="Animation"
              data-testid="setting-animation-level"
              className="h-9 w-44"
              value={prefs.animationLevel}
              onChange={(value) => prefs.setAnimationLevel(value as typeof prefs.animationLevel)}
              options={ANIMATION_LEVEL_OPTIONS}
            />
          </SettingRow>
          <SettingRow
            label="Starfield"
            description="The look of the decorative sky on the About screen."
            hint={
              'Picks the colour of the gentle starfield that drifts behind the **About** screen. ' +
              'Purely decorative — it never carries any information.\n\n' +
              '- **Cosmic** — the signature violet-and-cyan sky (the default).\n' +
              '- **Accent** — tinted with your chosen accent colour, so it follows the Colour above.\n' +
              '- **Aurora** — cool greens and teals.\n' +
              '- **Ember** — warm ambers and rose.\n' +
              '- **Mono** — a quiet, colourless sky.\n\n' +
              'Every variant stays calm and reduced-motion-friendly, and honours the “Reduce ' +
              'effects” switch above.'
            }
          >
            <Select
              aria-label="Starfield"
              data-testid="setting-starfield"
              className="h-9 w-40"
              value={prefs.starfieldVariant}
              onChange={(value) => prefs.setStarfieldVariant(value as typeof prefs.starfieldVariant)}
              options={STARFIELD_VARIANT_OPTIONS}
            />
          </SettingRow>
          <SettingRow
            label="Background effect"
            description="A gentle animated weather layer behind every screen."
            hint={
              'Adds a calm, animated layer that drifts behind all your content on every screen. ' +
              'Purely decorative — it never carries any information and never gets in the way of the app.\n\n' +
              '- **None** — no background effect (the default).\n' +
              '- **Rain** — softly falling rain.\n' +
              '- **Snow** — gently drifting snow.\n\n' +
              'The effect is drawn efficiently on the GPU and pauses when the tab is in the ' +
              'background. It follows the **Animation level** above: it holds still at *Calm*, and ' +
              'switches off entirely at *Minimal* or *Off* (and whenever your system prefers ' +
              'reduced motion). Choosing **I have a headache** — the maximal “everything on” ' +
              'level — turns **Snow** on for you by default; change it here any time.'
            }
          >
            <Select
              aria-label="Background effect"
              data-testid="setting-background-effect"
              className="h-9 w-40"
              value={prefs.backgroundEffect}
              onChange={(value) => prefs.setBackgroundEffect(value as typeof prefs.backgroundEffect)}
              options={BACKGROUND_EFFECT_OPTIONS}
            />
          </SettingRow>
          <SettingRow
            label="Holographic foil cards"
            description="Give item cards a rainbow trading-card foil shimmer on hover."
            hint={
              'Turns the sheen that plays across an item card as you hover it into a shifting ' +
              '**rainbow foil**, like light catching a holographic trading card — the glow and the ' +
              'edge sheen go prismatic and slide as you move the pointer.\n\n' +
              'It’s part of the **I have a headache** animation level (the maximal one), so — like ' +
              'the card tilt it rides on — it only appears at that level, on a mouse/trackpad, and ' +
              'never when your system prefers reduced motion. Purely decorative. Turn it off to keep ' +
              'the plain single-colour sheen.'
            }
          >
            <Select
              aria-label="Holographic foil cards"
              data-testid="setting-holographic-cards"
              className="h-9 w-40"
              value={prefs.holographicCards ? 'on' : 'off'}
              onChange={(value) => prefs.setHolographicCards(value === 'on')}
              options={ON_OFF_OPTIONS}
            />
          </SettingRow>
          <SettingRow
            label="Collector cards"
            description="Turn a lucky few of your items into collectible rarity cards."
            hint={
              'Makes the inventory feel like a collection: a **lucky ~5%** of your items turn out to ' +
              'be **collector cards**, each with a decorative **rarity** — Common, Uncommon, Rare, ' +
              'Epic or Legendary. The card gets a subtly **rarity-tinted frame**, and opening the ' +
              'item shows its **rarity gem** in the top-right of the dialog (Legendary gems even get ' +
              'a gentle glow). Which items are collectors is decided by their **name**, so it’s ' +
              'stable — the same item is always the same card, and the showier tiers are the rarer ' +
              'finds.\n\n' +
              'It’s purely for fun and never changes any real data or figure. Like the foil above, ' +
              'it’s part of the **I have a headache** animation level and only appears at that ' +
              'level. Turn it off any time.'
            }
          >
            <Select
              aria-label="Collector cards"
              data-testid="setting-gamify-cards"
              className="h-9 w-40"
              value={prefs.gamifyCards ? 'on' : 'off'}
              onChange={(value) => prefs.setGamifyCards(value === 'on')}
              options={ON_OFF_OPTIONS}
            />
          </SettingRow>
          <SettingRow
            label="Base currency"
            description="Used for all financial tracking and BOM costs."
            hint={
              'The currency every price, stock value and project budget is shown and totalled in.\n\n' +
              'Amounts are **not** converted when you change this — the stored numbers stay the same, only the symbol and formatting change. Pick the currency you actually buy and sell in.'
            }
          >
            <div className="flex items-center gap-2">
              <Tooltip content="Detect the currency from your browser’s region.">
                <Button
                  variant="link"
                  size="sm"
                  className="px-0"
                  data-testid="detect-currency"
                  onClick={() => prefs.setBaseCurrency(guessBaseCurrency())}
                >
                  Detect
                </Button>
              </Tooltip>
              <Select
                aria-label="Base currency"
                data-testid="setting-currency"
                className="h-9 w-56"
                value={prefs.baseCurrency}
                onChange={(value) => prefs.setBaseCurrency(value)}
                options={CURRENCY_OPTIONS.map((c) => ({ value: c.value, label: `${c.value} — ${c.label}` }))}
              />
            </div>
          </SettingRow>
          <SettingRow
            label="Weight unit"
            description="The unit item weights are shown and entered in."
            hint={
              'The unit every item **weight** is displayed and entered in. Weights are stored ' +
              'independently of this, so changing it **re-displays** the same weights in the new ' +
              'unit — nothing is converted or lost. Pick grams, kilograms, ounces or pounds.'
            }
          >
            <Select
              aria-label="Weight unit"
              data-testid="setting-weight-unit"
              className="h-9 w-56"
              value={prefs.weightUnit}
              onChange={(value) =>
                prefs.setWeightUnit(value as (typeof WEIGHT_UNIT_OPTIONS)[number]['value'])
              }
              options={WEIGHT_UNIT_OPTIONS.map((u) => ({ value: u.value, label: u.label }))}
            />
          </SettingRow>
          <SettingRow
            label="Dimension unit"
            description="The unit item width, height and depth are shown and entered in."
            hint={
              'The unit every item **dimension** (width, height and depth) is displayed and ' +
              'entered in. Dimensions are stored independently of this, so changing it ' +
              '**re-displays** the same sizes in the new unit — nothing is converted or lost. ' +
              'Pick millimetres, centimetres, metres, inches or feet.'
            }
          >
            <Select
              aria-label="Dimension unit"
              data-testid="setting-dimension-unit"
              className="h-9 w-56"
              value={prefs.dimensionUnit}
              onChange={(value) =>
                prefs.setDimensionUnit(value as (typeof DIMENSION_UNIT_OPTIONS)[number]['value'])
              }
              options={DIMENSION_UNIT_OPTIONS.map((u) => ({ value: u.value, label: u.label }))}
            />
          </SettingRow>
          <SettingRow
            label={t('settings.language.label')}
            description={t('settings.language.description')}
            hint={t('settings.language.hint')}
          >
            <Select
              aria-label={t('settings.language.label')}
              data-testid="setting-locale"
              className="h-9 w-56"
              value={prefs.locale}
              onChange={(value) => prefs.setLocale(value)}
              options={LOCALE_OPTIONS.map((l) => ({ value: l.value, label: l.label }))}
            />
          </SettingRow>
        </SettingsSection>
      ),
    },
    {
      id: 'dashboard',
      label: 'Dashboard',
      icon: <HomeIcon />,
      content: (
        <>
          <SettingsSection icon={<HomeIcon />} title="Dashboard">
            <SettingRow
              label="Quick search (Ctrl/⌘ /)"
              description="Show a command palette for jumping straight to any item by name — opened from the dashboard or with Ctrl/⌘ / anywhere."
              hint={
                'A fast command palette for finding an item by name and jumping straight to it, without opening the full Inventory screen.\n\n' +
                'Open it from the dashboard search box, or with **Ctrl / ⌘ + /** from anywhere. Type `>` to switch it into *jump to a screen* mode. Turning this off just hides the dashboard entry point — the keyboard shortcut still works.'
              }
            >
              <Select
                aria-label="Quick search command palette"
                data-testid="setting-dashboard-command-palette"
                className="h-9 w-40"
                value={prefs.dashboardCommandPalette ? 'on' : 'off'}
                onChange={(value) => prefs.setDashboardCommandPalette(value === 'on')}
                options={ON_OFF_OPTIONS}
              />
            </SettingRow>
            <SettingRow
              label="Quick actions"
              description="Show Add item and Scan buttons in the dashboard header for the most common tasks."
              hint={
                'Adds **Add item** and **Scan** buttons to the dashboard header, so the two most common tasks are one tap away from the landing screen.\n\n' +
                'Both remain reachable from the Inventory screen regardless of this setting.'
              }
            >
              <Select
                aria-label="Dashboard quick actions"
                data-testid="setting-dashboard-quick-actions"
                className="h-9 w-40"
                value={prefs.dashboardQuickActions ? 'on' : 'off'}
                onChange={(value) => prefs.setDashboardQuickActions(value === 'on')}
                options={ON_OFF_OPTIONS}
              />
            </SettingRow>
            <SettingRow
              label="Getting-started panel"
              description="While your inventory is empty, show a short panel with first steps (add, import or scan) instead of the empty widgets."
              hint={
                'While you have **no items yet**, replaces the empty dashboard widgets with a short panel of first steps — add an item, import a spreadsheet, or scan a barcode.\n\n' +
                'It disappears automatically once your inventory has anything in it, so this only matters on a fresh install.'
              }
            >
              <Select
                aria-label="Getting-started panel"
                data-testid="setting-dashboard-getting-started"
                className="h-9 w-40"
                value={prefs.dashboardGettingStarted ? 'on' : 'off'}
                onChange={(value) => prefs.setDashboardGettingStarted(value === 'on')}
                options={ON_OFF_OPTIONS}
              />
            </SettingRow>
          </SettingsSection>

          {anyNavCountPicker ? (
            <SettingsSection icon={<CustomiseIcon />} title="Nav tile counts">
              {NAV_COUNT_ROUTES.filter((route) => navCountFeatureOn[route]).map((route) => {
                const cfg = NAV_COUNT_METRIC_CONFIG[route];
                // Defensive normalisation so a partial/stale persisted map (e.g. missing this
                // route) shows the tile's default rather than an empty control.
                const metric = normaliseNavCountMetric(route, prefs.navCountMetrics[route] ?? '');
                return (
                  <SettingRow
                    key={route}
                    label={cfg.settingLabel}
                    description="Choose which metric this tile’s count shows on the dashboard."
                    hintSize="md"
                    hint={NAV_COUNT_HINTS[route]}
                  >
                    <Select
                      aria-label={cfg.settingLabel}
                      data-testid={`setting-nav-count-${route}`}
                      className="h-9 w-56"
                      value={metric}
                      onChange={(value) => prefs.setNavCountMetric(route, value)}
                      options={cfg.options.map((o) => ({ value: o.value, label: o.label }))}
                    />
                  </SettingRow>
                );
              })}
            </SettingsSection>
          ) : null}

          <SettingsSection icon={<KioskIcon />} title="Kiosk &amp; display">
            <SettingRow
              label="Kiosk mode"
              description="For hardwired tablets/dashboards: keep the screen awake and lock dashboard pinch-zoom and text selection."
              hint={
                'For a **wall-mounted or always-on tablet**. When on, Gubbins:\n\n' +
                '- keeps the screen **awake** (requests a wake lock), and\n' +
                '- locks **pinch-zoom** and text selection on the dashboard, so a passer-by cannot knock the layout about.\n\n' +
                'Leave it **off** for normal phone/desktop use.'
              }
            >
              <Select
                aria-label="Kiosk mode"
                data-testid="setting-kiosk-mode"
                className="h-9 w-40"
                value={prefs.kioskMode ? 'on' : 'off'}
                onChange={(value) => prefs.setKioskMode(value === 'on')}
                options={OFF_ON_OPTIONS}
              />
            </SettingRow>
          </SettingsSection>
        </>
      ),
    },
    {
      id: 'inventory',
      label: 'Inventory',
      icon: <PackageIcon />,
      content: (
        <>
          <SettingsSection icon={<PackageIcon />} title="Item cards">
            <SettingRow
              label="Visual card details"
              description="What each item card highlights in Visual mode. The ± stepper still shows the quantity either way."
              hintSize="md"
              hint={
                'In **Visual** (grid) mode, each item card has one hero slot. Its ± stepper already shows the on-hand quantity, so this picks a genuinely useful second signal to show instead of repeating the number:\n\n' +
                '- **Stock health** — a colour-coded reorder status (In stock / Low / Out), from the item’s reorder point.\n' +
                '- **Total value** — unit cost × quantity.\n' +
                '- **Last updated** — how long ago it changed.\n' +
                '- **Condition** — its tracked state (Mint / Good / …).\n\n' +
                'Gauge, serialised and untracked cards are unaffected — their hero already shows something meaningful.'
              }
            >
              <Select
                aria-label="Visual card details"
                data-testid="setting-visual-card-metric"
                className="h-9 w-40"
                value={prefs.visualCardMetric}
                onChange={(value) => prefs.setVisualCardMetric(value as typeof prefs.visualCardMetric)}
                options={VISUAL_CARD_METRIC_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
              />
            </SettingRow>
            <SettingRow
              label="Item card click"
              description="What a click on the body of an item card or row does (outside its buttons)."
              hintSize="md"
              hint={
                'What clicking the **empty body** of an item card or row does — outside its own buttons. Each option mirrors one of the card’s existing buttons as a shortcut:\n\n' +
                '- **Open details** — the full item record (the default; the least surprising).\n' +
                '- **Move to location** — the relocate dialog.\n' +
                '- **Show label** — the printable QR + barcode.\n' +
                '- **Do nothing** — leaves the buttons as the only way in.\n\n' +
                'It only ever mirrors a labelled button, so keyboard and assistive-tech users are unaffected, and it is suppressed while the batch-selection checkbox is active.'
              }
            >
              <Select
                aria-label="Item card click"
                data-testid="setting-card-click-action"
                className="h-9 w-40"
                value={prefs.cardClickAction}
                onChange={(value) => prefs.setCardClickAction(value as typeof prefs.cardClickAction)}
                options={CARD_CLICK_ACTION_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
              />
            </SettingRow>
          </SettingsSection>

          <SettingsSection icon={<CustomiseIcon />} title="Card fields">
            <div className="space-y-3 py-1">
              <p className="text-xs text-muted-foreground">
                Choose which attributes each item card and row shows, and in what order. Use the arrows to
                reorder and the eye to show or hide a field. Applies to both the Visual cards and the dense
                list, and is saved on this device.
              </p>
              <CardFieldsSetting />
            </div>
          </SettingsSection>

          <SettingsSection icon={<LowStockIcon />} title="Stock alerts &amp; lifecycle">
            <SettingRow
              label="Default low-stock quantity threshold"
              description={`A blanket reorder point for discrete items — flagged at or below this on-hand quantity (${LOW_STOCK_QTY_BOUNDS.min}–${LOW_STOCK_QTY_BOUNDS.max}).`}
              hintSize="md"
              hint={
                'A **blanket reorder point** for discrete (counted) items: any at or below this on-hand quantity are flagged low on the dashboard and Alerts.\n\n' +
                '**Low-stock alerts are opt-in.** Leave it at **0 (off)** and nothing nags until you give an individual item its own reorder point on its detail page. Raise it here to watch *every* discrete item at once.\n\n' +
                `Range ${LOW_STOCK_QTY_BOUNDS.min}–${LOW_STOCK_QTY_BOUNDS.max}. A per-item reorder point always overrides this blanket value.`
              }
            >
              <div className="flex items-center gap-2">
                <Input
                  aria-label="Low-stock quantity threshold"
                  data-testid="setting-low-stock-qty"
                  type="number"
                  min={LOW_STOCK_QTY_BOUNDS.min}
                  max={LOW_STOCK_QTY_BOUNDS.max}
                  className="h-9 w-24"
                  value={prefs.lowStockQtyThreshold}
                  onChange={(e) => prefs.setLowStockQtyThreshold(clampLowStockQty(Number(e.target.value)))}
                />
                <span className="text-sm text-muted-foreground">
                  {prefs.lowStockQtyThreshold === 0 ? 'units · off' : 'units'}
                </span>
              </div>
            </SettingRow>
            <SettingRow
              label="Default low-stock gauge threshold"
              description={`A blanket reorder level for consumable-gauge items — flagged at or below this percentage remaining (${LOW_STOCK_GAUGE_BOUNDS.min}–${LOW_STOCK_GAUGE_BOUNDS.max}).`}
              hintSize="md"
              hint={
                'The gauge equivalent of the quantity threshold, for **consumable-gauge** items (tracked as a % full — e.g. a solder reel or filament spool). Any at or below this percentage remaining are flagged low.\n\n' +
                `Like the quantity threshold, **0 is off**: an item only alerts once it has its own reorder point, or when you raise this above 0. Range ${LOW_STOCK_GAUGE_BOUNDS.min}–${LOW_STOCK_GAUGE_BOUNDS.max}%.`
              }
            >
              <div className="flex items-center gap-2">
                <Input
                  aria-label="Low-stock gauge threshold"
                  data-testid="setting-low-stock-gauge"
                  type="number"
                  min={LOW_STOCK_GAUGE_BOUNDS.min}
                  max={LOW_STOCK_GAUGE_BOUNDS.max}
                  className="h-9 w-24"
                  value={prefs.lowStockGaugePercent}
                  onChange={(e) =>
                    prefs.setLowStockGaugePercent(clampLowStockGaugePercent(Number(e.target.value)))
                  }
                />
                <span className="text-sm text-muted-foreground">
                  {prefs.lowStockGaugePercent === 0 ? '% · off' : '%'}
                </span>
              </div>
            </SettingRow>
            {perishablesOn ? (
              <SettingRow
                stack
                label="“Expiring soon” window"
                description={`How many days before an expiry date a perishable is flagged (${EXPIRY_WINDOW_BOUNDS.min}–${EXPIRY_WINDOW_BOUNDS.max}).`}
                hint={
                  'How far ahead to look when flagging **perishables** as *expiring soon* on the dashboard and Alerts.\n\n' +
                  `A window of 30, for example, flags anything due to expire within the next 30 days. Range ${EXPIRY_WINDOW_BOUNDS.min}–${EXPIRY_WINDOW_BOUNDS.max} days.`
                }
              >
                <div className="flex items-center gap-2">
                  <Input
                    aria-label="Expiring soon window (days)"
                    data-testid="setting-expiry-days"
                    type="number"
                    min={EXPIRY_WINDOW_BOUNDS.min}
                    max={EXPIRY_WINDOW_BOUNDS.max}
                    className="h-9 w-24"
                    value={prefs.expirySoonWindowDays}
                    onChange={(e) =>
                      prefs.setExpirySoonWindowDays(clampExpiryWindowDays(Number(e.target.value)))
                    }
                  />
                  <span className="text-sm text-muted-foreground">days</span>
                </div>
              </SettingRow>
            ) : null}
            {projectsOn ? (
              <SettingRow
                label="Budget warning threshold"
                description={`Projects are flagged once spending reaches this percentage of their budget (${BUDGET_WARN_BOUNDS.min}–${BUDGET_WARN_BOUNDS.max}).`}
                hint={
                  'When a project’s spend reaches this share of its **budget**, its budget indicator turns to a warning tone and it appears in Alerts.\n\n' +
                  `Set it below 100 to get an early nudge before you overspend, or at 100 to warn only once the budget is actually exceeded. Range ${BUDGET_WARN_BOUNDS.min}–${BUDGET_WARN_BOUNDS.max}%.`
                }
              >
                <div className="flex items-center gap-2">
                  <Input
                    aria-label="Budget warning threshold"
                    data-testid="setting-budget-warn"
                    type="number"
                    min={BUDGET_WARN_BOUNDS.min}
                    max={BUDGET_WARN_BOUNDS.max}
                    className="h-9 w-24"
                    value={prefs.budgetWarnPercent}
                    onChange={(e) =>
                      prefs.setBudgetWarnPercent(clampBudgetWarnPercent(Number(e.target.value)))
                    }
                  />
                  <span className="text-sm text-muted-foreground">%</span>
                </div>
              </SettingRow>
            ) : null}
          </SettingsSection>
        </>
      ),
    },
    {
      id: 'scanning',
      label: 'Scanning & labels',
      icon: <ScanIcon />,
      content: (
        <>
          {scannerOn ? (
            <SettingsSection icon={<ScanIcon />} title="Scanner">
              <SettingRow
                label="Barcode symbology"
                description="Restrict the live scanner to one code type for faster decoding, or scan all supported codes."
                hint={
                  'Which barcode types the **live camera scanner** tries to decode.\n\n' +
                  'Restricting it to the single symbology you actually use (e.g. **EAN-13** for retail products, or **Code 128**) makes decoding faster and more reliable. Leave it on *all supported codes* if you scan a mix.'
                }
                stack
              >
                <Select
                  aria-label="Barcode symbology"
                  data-testid="setting-scanner-symbology"
                  className="h-9 w-56"
                  value={prefs.scannerSymbology}
                  onChange={(value) => prefs.setScannerSymbology(value as typeof prefs.scannerSymbology)}
                  options={SCANNER_SYMBOLOGY_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
                />
              </SettingRow>
              <SettingRow
                label="Beep on scan"
                description="Play a short confirmation tone after each successful scan."
                hint={
                  'Plays a short confirmation **tone** after each successful scan, so you know it registered without looking at the screen — handy for rapid stock-taking.'
                }
                stack
              >
                <Select
                  aria-label="Beep on scan"
                  data-testid="setting-scanner-beep"
                  className="h-9 w-40"
                  value={prefs.scannerBeep ? 'on' : 'off'}
                  onChange={(value) => prefs.setScannerBeep(value === 'on')}
                  options={ON_OFF_OPTIONS}
                />
              </SettingRow>
              <SettingRow
                label="Vibrate on scan"
                description="Give a haptic bump after each successful scan, where the device supports it."
                hint={
                  'Gives a haptic **buzz** on each successful scan, on devices that support vibration (most phones; few desktops). A silent alternative to the beep.'
                }
                stack
              >
                <Select
                  aria-label="Vibrate on scan"
                  data-testid="setting-scanner-haptics"
                  className="h-9 w-40"
                  value={prefs.scannerHaptics ? 'on' : 'off'}
                  onChange={(value) => prefs.setScannerHaptics(value === 'on')}
                  options={ON_OFF_OPTIONS}
                />
              </SettingRow>
            </SettingsSection>
          ) : null}

          {/* G2: on-device receipt / label OCR prefill — opt-in, offline, keyless. Gated on
              the platform capability (Worker + WASM); the model downloads only once enabled. */}
          {hasOcr() ? (
            <SettingsSection icon={<DatasheetIcon />} title="Receipt &amp; label scanning (OCR)">
              <SettingRow
                label="Scan receipts &amp; labels"
                description="Add a button to the add-item form that reads a photographed receipt or product label and pre-fills a reviewable draft — fully on-device, no cloud."
                hint={
                  'Reads a **photo of a receipt or product label** entirely **on your device** ' +
                  '(offline, no cloud, no account) and pre-fills a new item’s **price, acquired ' +
                  'date, model/MPN and serial** for you to review — it never saves anything on ' +
                  'its own.\n\n' +
                  'Turning this on downloads a few MB of recognition engine + language model **the ' +
                  'first time you use it**; that’s why it’s off by default. A "Scan a receipt or ' +
                  'label" button then appears when you add an item.'
                }
                stack
              >
                <Select
                  aria-label="Scan receipts and labels"
                  data-testid="setting-ocr-enabled"
                  className="h-9 w-40"
                  value={prefs.ocrEnabled ? 'on' : 'off'}
                  onChange={(value) => prefs.setOcrEnabled(value === 'on')}
                  options={ON_OFF_OPTIONS}
                />
              </SettingRow>
              {prefs.ocrEnabled ? (
                <SettingRow
                  label="Recognition accuracy"
                  description="The language model the scanner uses. Fast is smaller and quicker; High accuracy is larger and slower but reads tricky scans better."
                  hint={
                    'Which **language model** the on-device scanner uses:\n\n' +
                    '- **Fast** — a small, quick model (a few MB). Ample for most receipts and ' +
                    'labels, and gentler on older devices. The default.\n' +
                    '- **High accuracy** — a larger model that reads faint or unusual print better, ' +
                    'at the cost of a bigger one-off download and slower scans.'
                  }
                  stack
                >
                  <Select
                    aria-label="Recognition accuracy"
                    data-testid="setting-ocr-model"
                    className="h-9 w-56"
                    value={prefs.ocrModel}
                    onChange={(value) => prefs.setOcrModel(value as typeof prefs.ocrModel)}
                    options={[
                      { value: 'fast', label: 'Fast (smaller)' },
                      { value: 'best', label: 'High accuracy (larger)' },
                    ]}
                  />
                </SettingRow>
              ) : null}
            </SettingsSection>
          ) : null}

          <SettingsSection icon={<QrCodeIcon />} title="Labels &amp; QR codes">
            <SettingRow
              label="Link host"
              description="The web address printed QR codes and barcodes point to. Leave blank to use whatever address you open this app from."
              hintSize="md"
              hint={
                'The base web address that **printed QR codes and barcodes** point to. Scanning a label opens that item in Gubbins at this host.\n\n' +
                'Leave it **blank** to use whatever address you currently open the app from. Set a stable name every device on your network can reach — e.g. `http://gubbins.local` — so labels printed from a dev server or one device keep working when scanned from a phone. The preview below shows the exact link a code will carry.'
              }
            >
              <LabelBaseUrlControl />
            </SettingRow>
          </SettingsSection>
        </>
      ),
    },
    {
      id: 'notifications',
      label: 'Notifications & files',
      icon: <NotificationIcon />,
      content: (
        <>
          <SettingsSection icon={<NotificationIcon />} title="Notifications">
            {/* G3: local reminder notifications — opt-in, permission-gated, per-lane. */}
            <ReminderSettings />
            <SettingRow
              label="Scrape notifications"
              description="How supplier-scrape updates are announced. Either way the change still applies and is logged."
              hint={
                'How Gubbins tells you when a **supplier-price scrape** finds an update.\n\n' +
                '- **Show a toast** — a brief passive notification.\n' +
                '- **Silent** — no notification.\n\n' +
                'Either way the scraped change is still applied and recorded in the item’s activity log; this only controls whether you are actively told.'
              }
            >
              <Select
                aria-label="Scrape notifications"
                data-testid="setting-scrape-notifications"
                className="h-9 w-56"
                value={prefs.scrapeNotifications}
                onChange={(value) => prefs.setScrapeNotifications(value as typeof prefs.scrapeNotifications)}
                options={[
                  { value: 'TOAST', label: 'Show a toast' },
                  { value: 'SILENT', label: 'Silent' },
                ]}
              />
            </SettingRow>
          </SettingsSection>

          <SettingsSection icon={<DatasheetIcon />} title="Attachments &amp; datasheets">
            <SettingRow
              label="Attachment mode"
              description="URLs only, or also link to local files on this device (paths are never synced)."
              hintSize="md"
              hint={
                'What kinds of datasheet / document attachment an item may have:\n\n' +
                '- **External URLs only** — link to documents on the web.\n' +
                '- **URLs and local file pointers** — additionally point to a file **on this device** via the browser’s file-access API.\n\n' +
                'A local pointer stores only the **path**, never the file’s contents, and paths are **never synced** between devices (they would be meaningless elsewhere).'
              }
            >
              <Select
                aria-label="Attachment mode"
                data-testid="setting-attachment-mode"
                className="h-9 w-56"
                value={prefs.attachmentMode}
                onChange={(value) => prefs.setAttachmentMode(value as typeof prefs.attachmentMode)}
                options={[
                  { value: 'URL_ONLY', label: 'External URLs only' },
                  { value: 'HYBRID', label: 'URLs and local file pointers' },
                ]}
              />
            </SettingRow>
          </SettingsSection>
        </>
      ),
    },
    {
      id: 'storage',
      label: 'Data & storage',
      icon: <StorageIcon />,
      content: (
        <>
          <SettingsSection icon={<StorageIcon />} title="Storage">
            <SettingRow
              label="Default purge window"
              description="The history age the Storage Triage tools default to."
              hint={
                'The default **age of history** the Storage Triage tools offer to purge — e.g. “older than 6 months”.\n\n' +
                'This only sets the *default* the tool opens with; you always confirm before anything is removed. Purging old history reclaims space without touching your current inventory.'
              }
            >
              <Select
                aria-label="Default purge window"
                data-testid="setting-prune-window"
                className="h-9 w-40"
                value={String(prefs.pruneWindowMonths)}
                onChange={(value) => prefs.setPruneWindowMonths(Number(value))}
                options={WINDOW_MONTH_OPTIONS.map((m) => ({ value: String(m), label: monthsLabel(m) }))}
              />
            </SettingRow>
            <SettingRow
              label="Default downgrade window"
              description="The image age the Storage Triage tools default to."
              hint={
                'The default **age of images** the Storage Triage tools offer to *downgrade* — recompress photos older than this to a smaller size, freeing space while keeping a usable picture.\n\n' +
                'As with the purge window, this is just the default the tool opens with; you confirm before anything changes.'
              }
            >
              <Select
                aria-label="Default downgrade window"
                data-testid="setting-downgrade-window"
                className="h-9 w-40"
                value={String(prefs.downgradeWindowMonths)}
                onChange={(value) => prefs.setDowngradeWindowMonths(Number(value))}
                options={WINDOW_MONTH_OPTIONS.map((m) => ({ value: String(m), label: monthsLabel(m) }))}
              />
            </SettingRow>
            <SettingRow
              label="Storage triage"
              description="Reclaim local space at any time — not just when storage is full."
              hint={
                'Opens the **Storage Triage** dashboard: see what is using local space and reclaim it — purge old history, downgrade old photos, remove orphaned files.\n\n' +
                'You can run it any time, not only when a storage-full banner appears.'
              }
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

          <DatabaseMaintenance />
        </>
      ),
    },
    {
      id: 'app',
      label: 'App',
      icon: <InstallIcon />,
      content: (
        <SettingsSection icon={<InstallIcon />} title="Application">
          <SettingRow
            label="Install Gubbins"
            description="Install as an app for offline launch and to protect your inventory from automatic browser eviction."
            hint={
              'Installs Gubbins as a **standalone app** (its own window, launchable offline).\n\n' +
              'Beyond convenience, an installed app’s local data is far less likely to be **automatically evicted** by the browser when disk space runs low — worth doing to protect your inventory. If the button is unavailable, use your browser’s own *Install / Add to Home screen* menu.'
            }
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
          <SettingRow
            noWrap
            label="Manage modules"
            description="Choose which pages and capabilities appear, from a preset or a granular list. Hidden features stay fully functional underneath."
            hint={
              'Opens the **Modules** manager: turn whole pages and capabilities on or off — from a quick preset (e.g. *Simple* vs *Everything*) or a granular list.\n\n' +
              'Hidden features keep working underneath; only their entry points disappear, so nothing you have already created is lost. Opening this leaves Settings.'
            }
          >
            <Link
              to="/modules"
              data-testid="open-modules-settings"
              onClick={onClose}
              className={cn(buttonVariants({ variant: 'outline' }))}
            >
              <ModulesIcon />
              Manage modules
            </Link>
          </SettingRow>
          <SettingRow
            label="About Gubbins"
            description="Version, project &amp; support links, author, licence and disclaimer."
            hint={
              'Opens the **About** screen: version, storage usage, platform capabilities, project and support links, author, licence and disclaimer. Opening this leaves Settings.'
            }
          >
            <Link to="/about" onClick={onClose} className={cn(buttonVariants({ variant: 'outline' }))}>
              <InfoIcon />
              About
            </Link>
          </SettingRow>
        </SettingsSection>
      ),
    },
    {
      id: 'danger',
      label: 'Danger zone',
      icon: <CriticalIcon />,
      tone: 'danger',
      content: <DangerZone />,
    },
  ];

  return (
    <>
      <RailModal
        open={open}
        onClose={onClose}
        title="Settings"
        description="Preferences take effect straight away — close when you’re done."
        className="max-w-4xl"
        railAriaLabel="Settings sections"
        idPrefix="settings"
        tabs={tabs}
        footer={
          <Button variant="secondary" data-testid="settings-close" onClick={onClose}>
            Close
          </Button>
        }
      />

      {/* Nested on demand so its reads run when opened and its reference "now" is captured at
          open time. It opens on a click (never simultaneously with the parent), so the modal
          stack orders it above the Settings dialog correctly. */}
      {triageOpen ? <StorageTriageDialog open onClose={() => setTriageOpen(false)} /> : null}
    </>
  );
}

/** A representative item id used only to preview the resolved deep-link in Settings. */
const SAMPLE_ITEM_ID = '1f0a2b3c-4d5e-6f70-8192-a3b4c5d6e7f8';

/**
 * The "Link host" control (spec §6). A free-text base-URL override for printable codes,
 * held as a local draft and committed to the store on blur (so mid-typing never fights a
 * normaliser). A live preview shows the exact deep-link a code will carry — resolved
 * through the same {@link resolveLabelBaseUrl} the print dialogs use — so the effect of a
 * blank vs. custom host is visible before anything is printed.
 */
function LabelBaseUrlControl() {
  const stored = usePreferencesStore((s) => s.labelBaseUrl);
  const setLabelBaseUrl = usePreferencesStore((s) => s.setLabelBaseUrl);
  const [draft, setDraft] = useState(stored);
  // Re-seed if the stored value changes elsewhere (e.g. a reset from the Danger Zone).
  useEffect(() => setDraft(stored), [stored]);

  const origin = typeof window === 'undefined' ? null : window.location.origin;
  const resolved = resolveLabelBaseUrl(draft, origin, import.meta.env.BASE_URL);
  const example = buildItemQrUrl(SAMPLE_ITEM_ID, resolved);
  const usingDefault = draft.trim().length === 0;

  return (
    <div className="flex w-72 max-w-full flex-col gap-1.5">
      <input
        aria-label="Label link host"
        data-testid="setting-label-base-url"
        type="url"
        inputMode="url"
        autoComplete="off"
        spellCheck={false}
        placeholder="http://gubbins.local"
        className="h-9 w-full rounded-lg border border-border bg-input/40 px-3 text-sm text-foreground shadow-sm outline-none transition-colors focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/40"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => setLabelBaseUrl(draft)}
      />
      <p className="break-all text-xs text-muted-foreground" data-testid="label-base-url-preview">
        {usingDefault ? 'Using this device’s address — codes link to ' : 'Codes link to '}
        <span className="font-medium text-foreground">{example}</span>
      </p>
    </div>
  );
}

/** Icon per mode choice (spec §2.1). */
const MODE_ICONS: Record<Mode, ReactNode> = {
  light: <LightThemeIcon />,
  dark: <DarkThemeIcon />,
  system: <SystemThemeIcon />,
};

/** What each mode does — surfaced on hover (the labels alone don't say). */
const MODE_TOOLTIPS: Record<Mode, string> = {
  light: 'Always use the light palette.',
  dark: 'Always use the deep dark palette.',
  system: 'Follow your device setting and switch automatically when it does.',
};

/**
 * The Mode picker — a WAI-ARIA **radiogroup** of icon+label pills for Light / Dark / System. One
 * tab stop (roving `tabindex` via {@link useRovingRadioGroup}): arrow keys move *and* select,
 * Home/End jump to the ends, Space/Enter re-affirm. Each option carries `aria-checked` and a
 * `data-testid={mode-<id>}` hook. `flex-wrap` keeps it tidy on a narrow dialog.
 */
function ModeToggle({ mode, onChange }: { readonly mode: Mode; readonly onChange: (mode: Mode) => void }) {
  const selectedIndex = Math.max(
    0,
    MODE_OPTIONS.findIndex((o) => o.value === mode),
  );
  const { refs, selectAt, onKeyDown } = useRovingRadioGroup<HTMLButtonElement>({
    count: MODE_OPTIONS.length,
    onSelect: (index) => onChange(MODE_OPTIONS[index]!.value),
  });

  return (
    <div
      role="radiogroup"
      aria-label="Mode"
      className="flex flex-wrap gap-1 rounded-lg border border-border bg-input/40 p-1"
    >
      {MODE_OPTIONS.map((option, index) => {
        const active = index === selectedIndex;
        return (
          <Tooltip key={option.value} content={MODE_TOOLTIPS[option.value]} triggerTabIndex={-1}>
            <button
              ref={(el) => {
                refs.current[index] = el;
              }}
              type="button"
              role="radio"
              aria-checked={active}
              tabIndex={active ? 0 : -1}
              data-testid={`mode-${option.value}`}
              onClick={() => selectAt(index)}
              onKeyDown={(e) => onKeyDown(e, index)}
              className={cn(
                'inline-flex items-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium outline-none transition-colors [&_svg]:size-4',
                'focus-visible:ring-[3px] focus-visible:ring-ring/40',
                active
                  ? 'bg-primary text-primary-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {MODE_ICONS[option.value]}
              {option.label}
            </button>
          </Tooltip>
        );
      })}
    </div>
  );
}

/**
 * The Colour (accent) picker — a WAI-ARIA **radiogroup** of colour swatches (mirrors the location
 * `ColorSwatchPicker`). One tab stop (roving `tabindex`): arrow keys move *and* select, Home/End
 * jump to the ends, Space/Enter re-affirm. Each swatch previews its own colour by carrying its
 * `data-accent`, so the scoped CSS paints `bg-primary` in that accent (in the current mode). The
 * accessible name is the colour label; each swatch keeps a `data-testid={accent-<id>}` hook.
 */
function AccentPicker({
  accent,
  onChange,
}: {
  readonly accent: Accent;
  readonly onChange: (accent: Accent) => void;
}) {
  const selectedIndex = Math.max(
    0,
    ACCENTS.findIndex((a) => a.id === accent),
  );
  const { refs, selectAt, onKeyDown } = useRovingRadioGroup<HTMLButtonElement>({
    count: ACCENTS.length,
    onSelect: (index) => onChange(ACCENTS[index]!.id),
  });

  return (
    <div role="radiogroup" aria-label="Colour" className="flex flex-wrap gap-2">
      {ACCENTS.map((option, index) => {
        const checked = index === selectedIndex;
        return (
          <Tooltip key={option.id} content={option.label} triggerTabIndex={-1}>
            <button
              ref={(el) => {
                refs.current[index] = el;
              }}
              type="button"
              role="radio"
              aria-checked={checked}
              aria-label={option.label}
              tabIndex={checked ? 0 : -1}
              // Scope the accent tokens to this swatch so `bg-primary` previews its colour.
              data-accent={option.id}
              data-testid={`accent-${option.id}`}
              onClick={() => selectAt(index)}
              onKeyDown={(e) => onKeyDown(e, index)}
              className={cn(
                'size-7 rounded-full bg-primary outline-none transition-transform',
                'focus-visible:ring-[3px] focus-visible:ring-foreground/70 focus-visible:ring-offset-2 focus-visible:ring-offset-background',
                checked && 'ring-2 ring-foreground/70 ring-offset-2 ring-offset-background scale-110',
              )}
            />
          </Tooltip>
        );
      })}
    </div>
  );
}
