import { afterEach, describe, expect, it } from 'vitest';
import {
  BUDGET_WARN_PERCENT,
  EXPIRY_SOON_WINDOW_DAYS,
  LOW_STOCK_GAUGE_PERCENT,
  LOW_STOCK_QTY_THRESHOLD,
} from '@/db/repositories/constants';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';
import {
  BUDGET_WARN_BOUNDS,
  CARD_CLICK_ACTION_OPTIONS,
  clampBudgetWarnPercent,
  clampExpiryWindowDays,
  clampLowStockGaugePercent,
  clampLowStockQty,
  clampPackingFactor,
  clampPageSize,
  CURRENCY_OPTIONS,
  DEFAULT_PACKING_FACTOR,
  PACKING_FACTOR_BOUNDS,
  DEFAULT_CARD_CLICK_ACTION,
  DEFAULT_ITEMS_PER_PAGE,
  DEFAULT_WINDOW_MONTHS,
  PAGE_SIZE_BOUNDS,
  EXPIRY_WINDOW_BOUNDS,
  guessBaseCurrency,
  LOW_STOCK_GAUGE_BOUNDS,
  LOCATION_SEARCH_AUTO_THRESHOLD,
  LOCATION_SEARCH_VISIBILITY_OPTIONS,
  DEFAULT_LOCATION_SEARCH_VISIBILITY,
  normaliseLocationSearchVisibility,
  showLocationSearch,
  LOW_STOCK_QTY_BOUNDS,
  normaliseCardClickAction,
  normaliseVisualCardMetric,
  normaliseVisualCardMetricFallback,
  normaliseWindowMonths,
  DEFAULT_VISUAL_CARD_METRIC,
  DEFAULT_VISUAL_CARD_METRIC_FALLBACK,
  DEFAULT_NAV_COUNT_METRICS,
  NAV_COUNT_METRIC_CONFIG,
  NAV_COUNT_ROUTES,
  navCountOption,
  navCountTone,
  normaliseNavCountMetric,
  normaliseNavCountMetrics,
  VISUAL_CARD_METRIC_OPTIONS,
  VISUAL_CARD_METRIC_FALLBACK_OPTIONS,
  WINDOW_MONTH_OPTIONS,
} from './settings';
import { DEFAULT_CARD_BADGE_CONTENT, DEFAULT_CARD_BADGE_FALLBACK } from '@/features/inventory/card-badge';
import { applyAppearance, DARK_CLASS, resolveMode } from './theme';
import type { Appearance } from './theme';

/** A base appearance for applyAppearance tests — override just the field under test. */
const APPEARANCE: Appearance = {
  mode: 'dark',
  accent: 'violet',
  oledDark: false,
  highContrast: false,
  animationLevel: 'headache',
  holographicCards: true,
  gamifyCards: true,
  customAccent: { enabled: false, hue: 277 },
  surfaceStyle: 'solid',
};

describe('clampExpiryWindowDays', () => {
  it('passes valid in-range values through, rounding to a whole day', () => {
    expect(clampExpiryWindowDays(30)).toBe(30);
    expect(clampExpiryWindowDays(14.4)).toBe(14);
  });

  it('clamps to the configured bounds', () => {
    expect(clampExpiryWindowDays(0)).toBe(EXPIRY_WINDOW_BOUNDS.min);
    expect(clampExpiryWindowDays(-5)).toBe(EXPIRY_WINDOW_BOUNDS.min);
    expect(clampExpiryWindowDays(9999)).toBe(EXPIRY_WINDOW_BOUNDS.max);
  });

  it('falls back to the default window for non-finite input', () => {
    expect(clampExpiryWindowDays(Number.NaN)).toBe(EXPIRY_SOON_WINDOW_DAYS);
    expect(clampExpiryWindowDays(Number.POSITIVE_INFINITY)).toBe(EXPIRY_SOON_WINDOW_DAYS);
  });
});

describe('normaliseWindowMonths', () => {
  it('accepts the offered windows', () => {
    for (const m of WINDOW_MONTH_OPTIONS) expect(normaliseWindowMonths(m)).toBe(m);
  });

  it('coerces anything else to the default', () => {
    expect(normaliseWindowMonths(7)).toBe(DEFAULT_WINDOW_MONTHS);
    expect(normaliseWindowMonths(0)).toBe(DEFAULT_WINDOW_MONTHS);
    expect(normaliseWindowMonths(Number.NaN)).toBe(DEFAULT_WINDOW_MONTHS);
  });
});

describe('clampLowStockQty', () => {
  it('passes valid in-range values through, rounding to a whole unit', () => {
    expect(clampLowStockQty(5)).toBe(5);
    expect(clampLowStockQty(7.6)).toBe(8);
  });

  it('clamps to the configured bounds', () => {
    expect(clampLowStockQty(0)).toBe(LOW_STOCK_QTY_BOUNDS.min);
    expect(clampLowStockQty(-3)).toBe(LOW_STOCK_QTY_BOUNDS.min);
    expect(clampLowStockQty(99999)).toBe(LOW_STOCK_QTY_BOUNDS.max);
  });

  it('falls back to the default threshold for non-finite input', () => {
    expect(clampLowStockQty(Number.NaN)).toBe(LOW_STOCK_QTY_THRESHOLD);
    expect(clampLowStockQty(Number.POSITIVE_INFINITY)).toBe(LOW_STOCK_QTY_THRESHOLD);
  });
});

describe('clampPackingFactor', () => {
  it('passes an in-range fraction through unrounded (decimals are meaningful)', () => {
    expect(clampPackingFactor(0.7)).toBe(0.7);
    expect(clampPackingFactor(1)).toBe(1);
    expect(clampPackingFactor(0.333)).toBe(0.333);
  });

  it('clamps to (0,1]-with-floor bounds so utilisation maths can never divide by ~zero', () => {
    expect(clampPackingFactor(0)).toBe(PACKING_FACTOR_BOUNDS.min);
    expect(clampPackingFactor(-1)).toBe(PACKING_FACTOR_BOUNDS.min);
    expect(clampPackingFactor(2)).toBe(PACKING_FACTOR_BOUNDS.max);
  });

  it('falls back to the default (no haircut) for non-finite input', () => {
    expect(clampPackingFactor(Number.NaN)).toBe(DEFAULT_PACKING_FACTOR);
    expect(clampPackingFactor(Number.POSITIVE_INFINITY)).toBe(DEFAULT_PACKING_FACTOR);
  });
});

describe('clampPageSize', () => {
  it('passes valid in-range values through, rounding to a whole number', () => {
    expect(clampPageSize(25)).toBe(25);
    expect(clampPageSize(49.6)).toBe(50);
  });

  it('clamps to the configured bounds (never above the repository page ceiling)', () => {
    expect(clampPageSize(1)).toBe(PAGE_SIZE_BOUNDS.min);
    expect(clampPageSize(-10)).toBe(PAGE_SIZE_BOUNDS.min);
    expect(clampPageSize(9999)).toBe(PAGE_SIZE_BOUNDS.max);
  });

  it('falls back to the default page size for non-finite input', () => {
    expect(clampPageSize(Number.NaN)).toBe(DEFAULT_ITEMS_PER_PAGE);
    expect(clampPageSize(Number.POSITIVE_INFINITY)).toBe(DEFAULT_ITEMS_PER_PAGE);
  });
});

describe('clampLowStockGaugePercent', () => {
  it('passes valid in-range values through, rounding to a whole percent', () => {
    expect(clampLowStockGaugePercent(15)).toBe(15);
    expect(clampLowStockGaugePercent(50.4)).toBe(50);
  });

  it('clamps to the configured bounds', () => {
    expect(clampLowStockGaugePercent(0)).toBe(LOW_STOCK_GAUGE_BOUNDS.min);
    expect(clampLowStockGaugePercent(150)).toBe(LOW_STOCK_GAUGE_BOUNDS.max);
  });

  it('falls back to the default percentage for non-finite input', () => {
    expect(clampLowStockGaugePercent(Number.NaN)).toBe(LOW_STOCK_GAUGE_PERCENT);
  });
});

describe('CURRENCY_OPTIONS', () => {
  it('keeps GBP first as the locked default (§1.2.1)', () => {
    expect(CURRENCY_OPTIONS[0].value).toBe('GBP');
  });

  it('offers only valid, unique ISO-4217 codes Intl can format', () => {
    const seen = new Set<string>();
    for (const { value } of CURRENCY_OPTIONS) {
      expect(seen.has(value)).toBe(false);
      seen.add(value);
      // Throws on an unknown currency code — proves every option is formattable.
      expect(() =>
        new Intl.NumberFormat('en-GB', { style: 'currency', currency: value }).format(1),
      ).not.toThrow();
    }
  });
});

describe('guessBaseCurrency', () => {
  it('maps a region to the matching offered currency', () => {
    expect(guessBaseCurrency(['en-US'])).toBe('USD');
    expect(guessBaseCurrency(['fr-FR'])).toBe('EUR');
    expect(guessBaseCurrency(['de-DE'])).toBe('EUR');
    expect(guessBaseCurrency(['ja-JP'])).toBe('JPY');
    expect(guessBaseCurrency(['en-AU'])).toBe('AUD');
  });

  it('takes the first locale that resolves to an offered currency', () => {
    // The leading tag has no region currency we offer; the next one does.
    expect(guessBaseCurrency(['eo', 'pt-BR'])).toBe('BRL');
  });

  it('only ever returns a currency we actually offer in the picker', () => {
    const offered = new Set(CURRENCY_OPTIONS.map((o) => o.value));
    for (const locale of ['en-US', 'fr-FR', 'ja-JP', 'en-ZA', 'ko-KR', 'pl-PL']) {
      expect(offered.has(guessBaseCurrency([locale]))).toBe(true);
    }
  });

  it('falls back to GBP for an unknown/empty locale set', () => {
    expect(guessBaseCurrency([])).toBe('GBP');
    expect(guessBaseCurrency(['xx-zz-not-a-locale'])).toBe('GBP');
  });
});

describe('normaliseVisualCardMetric', () => {
  it('passes every offered metric through unchanged', () => {
    for (const { value } of VISUAL_CARD_METRIC_OPTIONS) {
      expect(normaliseVisualCardMetric(value)).toBe(value);
    }
  });

  it('accepts the metrics added in this phase', () => {
    expect(normaliseVisualCardMetric('lastUpdated')).toBe('lastUpdated');
    expect(normaliseVisualCardMetric('condition')).toBe('condition');
    expect(normaliseVisualCardMetric('manufacturer')).toBe('manufacturer');
  });

  it('coerces an unknown/stale persisted value to the default', () => {
    expect(normaliseVisualCardMetric('turnover')).toBe(DEFAULT_VISUAL_CARD_METRIC);
    expect(normaliseVisualCardMetric('')).toBe(DEFAULT_VISUAL_CARD_METRIC);
  });
});

describe('normaliseVisualCardMetricFallback', () => {
  it('passes every offered fallback (the metrics plus "none") through unchanged', () => {
    for (const { value } of VISUAL_CARD_METRIC_FALLBACK_OPTIONS) {
      expect(normaliseVisualCardMetricFallback(value)).toBe(value);
    }
  });

  it('accepts "none" — the shipped default (no fallback)', () => {
    expect(normaliseVisualCardMetricFallback('none')).toBe('none');
    expect(DEFAULT_VISUAL_CARD_METRIC_FALLBACK).toBe('none');
  });

  it('coerces an unknown/stale persisted value to the default', () => {
    expect(normaliseVisualCardMetricFallback('turnover')).toBe(DEFAULT_VISUAL_CARD_METRIC_FALLBACK);
    expect(normaliseVisualCardMetricFallback('')).toBe(DEFAULT_VISUAL_CARD_METRIC_FALLBACK);
  });
});

describe('the Locations search box (issue #446)', () => {
  it('passes every offered choice through unchanged', () => {
    for (const value of LOCATION_SEARCH_VISIBILITY_OPTIONS) {
      expect(normaliseLocationSearchVisibility(value)).toBe(value);
    }
  });

  it('coerces an unknown/stale persisted value to the default', () => {
    expect(DEFAULT_LOCATION_SEARCH_VISIBILITY).toBe('auto');
    expect(normaliseLocationSearchVisibility('sometimes')).toBe('auto');
    expect(normaliseLocationSearchVisibility(undefined)).toBe('auto');
  });

  it('pins the box on or off regardless of how many locations there are', () => {
    expect(showLocationSearch('on', 0)).toBe(true);
    expect(showLocationSearch('on', 500)).toBe(true);
    expect(showLocationSearch('off', 0)).toBe(false);
    expect(showLocationSearch('off', 500)).toBe(false);
  });

  it('shows the box under `auto` only past the threshold', () => {
    expect(showLocationSearch('auto', LOCATION_SEARCH_AUTO_THRESHOLD - 1)).toBe(false);
    // "More than 10", so exactly ten locations still reads faster than it searches.
    expect(showLocationSearch('auto', LOCATION_SEARCH_AUTO_THRESHOLD)).toBe(false);
    expect(showLocationSearch('auto', LOCATION_SEARCH_AUTO_THRESHOLD + 1)).toBe(true);
  });
});

describe('normaliseCardClickAction', () => {
  it('passes every offered action through unchanged', () => {
    for (const { value } of CARD_CLICK_ACTION_OPTIONS) {
      expect(normaliseCardClickAction(value)).toBe(value);
    }
  });

  it('defaults to opening the item details (the expected click-to-open)', () => {
    expect(DEFAULT_CARD_CLICK_ACTION).toBe('details');
  });

  it('coerces an unknown/stale persisted value to the default', () => {
    expect(normaliseCardClickAction('checkout')).toBe(DEFAULT_CARD_CLICK_ACTION);
    expect(normaliseCardClickAction('')).toBe(DEFAULT_CARD_CLICK_ACTION);
  });
});

describe('usePreferencesStore — item-card badge slot (issue #117)', () => {
  afterEach(() => {
    usePreferencesStore.setState({
      cardBadgeContent: DEFAULT_CARD_BADGE_CONTENT,
      cardBadgeFallback: DEFAULT_CARD_BADGE_FALLBACK,
    });
  });

  it('defaults to the tracking pill with no fallback (the historic behaviour)', () => {
    const s = usePreferencesStore.getState();
    expect(s.cardBadgeContent).toBe('tracking');
    expect(s.cardBadgeFallback).toBe('none');
  });

  it('sets each choice through its setter, normalising a stale value', () => {
    usePreferencesStore.getState().setCardBadgeContent('unitPrice');
    usePreferencesStore.getState().setCardBadgeFallback('tracking');
    expect(usePreferencesStore.getState().cardBadgeContent).toBe('unitPrice');
    expect(usePreferencesStore.getState().cardBadgeFallback).toBe('tracking');

    // A stale/unknown value coerces to each preference's own default.
    usePreferencesStore.getState().setCardBadgeContent('bogus' as never);
    usePreferencesStore.getState().setCardBadgeFallback('bogus' as never);
    expect(usePreferencesStore.getState().cardBadgeContent).toBe('tracking');
    expect(usePreferencesStore.getState().cardBadgeFallback).toBe('none');
  });
});

describe('resolveMode', () => {
  it('passes an explicit mode through, ignoring the OS preference', () => {
    expect(resolveMode('dark', false)).toBe('dark');
    expect(resolveMode('dark', true)).toBe('dark');
    expect(resolveMode('light', true)).toBe('light');
    expect(resolveMode('light', false)).toBe('light');
  });

  it('follows the OS preference for the system mode', () => {
    expect(resolveMode('system', true)).toBe('dark');
    expect(resolveMode('system', false)).toBe('light');
  });
});

describe('applyAppearance', () => {
  afterEach(() => {
    const root = document.documentElement;
    root.classList.remove(DARK_CLASS);
    delete root.dataset.accent;
    delete root.dataset.oled;
    delete root.dataset.contrast;
    delete root.dataset.reduceEffects;
    delete root.dataset.animLevel;
    delete root.dataset.starfield;
    delete root.dataset.holoCards;
    delete root.dataset.gamifyCards;
    delete root.dataset.surface;
    for (const prop of ['--primary', '--primary-foreground', '--ring', '--highlight']) {
      root.style.removeProperty(prop);
    }
  });

  it('toggles .dark for the resolved mode and sets data-accent', () => {
    const root = document.createElement('div');
    applyAppearance({ ...APPEARANCE, mode: 'dark', accent: 'blue' }, root);
    expect(root.classList.contains(DARK_CLASS)).toBe(true);
    expect(root.dataset.accent).toBe('blue');
    applyAppearance({ ...APPEARANCE, mode: 'light', accent: 'green' }, root);
    expect(root.classList.contains(DARK_CLASS)).toBe(false);
    expect(root.dataset.accent).toBe('green');
  });

  it('sets and clears data-oled for the pure-black switch', () => {
    const root = document.createElement('div');
    applyAppearance({ ...APPEARANCE, oledDark: true }, root);
    expect(root.dataset.oled).toBe('');
    applyAppearance({ ...APPEARANCE, oledDark: false }, root);
    expect(root.dataset.oled).toBeUndefined();
  });

  it('sets and clears data-contrast for the high-contrast switch', () => {
    const root = document.createElement('div');
    applyAppearance({ ...APPEARANCE, highContrast: true }, root);
    expect(root.dataset.contrast).toBe('high');
    applyAppearance({ ...APPEARANCE, highContrast: false }, root);
    expect(root.dataset.contrast).toBeUndefined();
  });

  it('projects the animation level onto data-anim-level + data-reduce-effects by tier', () => {
    const root = document.createElement('div');

    // `headache` = "everything on", the default: no attribute, and motion is not suppressed.
    applyAppearance({ ...APPEARANCE, animationLevel: 'headache' }, root);
    expect(root.dataset.animLevel).toBeUndefined();
    expect(root.dataset.reduceEffects).toBeUndefined();

    // Balanced sets the attribute (for the flourish opt-outs) but does NOT reduce all motion.
    applyAppearance({ ...APPEARANCE, animationLevel: 'balanced' }, root);
    expect(root.dataset.animLevel).toBe('balanced');
    expect(root.dataset.reduceEffects).toBeUndefined();

    // Calm and calmer additionally set data-reduce-effects (the motion clamp).
    applyAppearance({ ...APPEARANCE, animationLevel: 'calm' }, root);
    expect(root.dataset.animLevel).toBe('calm');
    expect(root.dataset.reduceEffects).toBe('');
    applyAppearance({ ...APPEARANCE, animationLevel: 'off' }, root);
    expect(root.dataset.animLevel).toBe('off');
    expect(root.dataset.reduceEffects).toBe('');

    // Back to the everything default clears both.
    applyAppearance({ ...APPEARANCE, animationLevel: 'headache' }, root);
    expect(root.dataset.animLevel).toBeUndefined();
    expect(root.dataset.reduceEffects).toBeUndefined();
  });

  it('sets/clears data-holo-cards + data-gamify-cards for the two card-flair switches', () => {
    const root = document.createElement('div');
    // On (the default) — both presence-only flags are set.
    applyAppearance({ ...APPEARANCE, holographicCards: true, gamifyCards: true }, root);
    expect(root.dataset.holoCards).toBe('');
    expect(root.dataset.gamifyCards).toBe('');
    // Off — both are cleared (the CSS then shows the plain sheen / no rarity frame).
    applyAppearance({ ...APPEARANCE, holographicCards: false, gamifyCards: false }, root);
    expect(root.dataset.holoCards).toBeUndefined();
    expect(root.dataset.gamifyCards).toBeUndefined();
  });

  it('sets data-surface for a translucent surface style and clears it for solid (Branding)', () => {
    const root = document.createElement('div');
    // Solid is the default — no attribute (baseline unchanged).
    applyAppearance({ ...APPEARANCE, surfaceStyle: 'solid' }, root);
    expect(root.dataset.surface).toBeUndefined();
    // A translucent style projects the id for the CSS to re-mix the card tokens.
    applyAppearance({ ...APPEARANCE, surfaceStyle: 'soft' }, root);
    expect(root.dataset.surface).toBe('soft');
    applyAppearance({ ...APPEARANCE, surfaceStyle: 'sheer' }, root);
    expect(root.dataset.surface).toBe('sheer');
    // Back to solid clears it.
    applyAppearance({ ...APPEARANCE, surfaceStyle: 'solid' }, root);
    expect(root.dataset.surface).toBeUndefined();
  });

  it('projects the custom accent inline for the resolved mode and clears it when off (Branding)', () => {
    const root = document.createElement('div');
    // Off — no inline brand tokens; the preset [data-accent] block owns the accent.
    applyAppearance({ ...APPEARANCE, customAccent: { enabled: false, hue: 30 } }, root);
    expect(root.style.getPropertyValue('--primary')).toBe('');

    // On, dark mode — the four brand tokens are set inline, tuned for the resolved (dark) mode.
    applyAppearance({ ...APPEARANCE, mode: 'dark', customAccent: { enabled: true, hue: 30 } }, root);
    expect(root.style.getPropertyValue('--primary')).toBe('oklch(0.68 0.18 30)');
    expect(root.style.getPropertyValue('--ring')).toBe('oklch(0.68 0.18 30)');
    expect(root.style.getPropertyValue('--highlight')).toBe('oklch(0.74 0.18 30)');
    // Hue 30 is outside the light band (33–245), so near-white foreground.
    expect(root.style.getPropertyValue('--primary-foreground')).toBe('oklch(0.99 0 0)');

    // On, light mode — the lightness/chroma drop to the light-tuned values.
    applyAppearance({ ...APPEARANCE, mode: 'light', customAccent: { enabled: true, hue: 120 } }, root);
    expect(root.style.getPropertyValue('--primary')).toBe('oklch(0.58 0.17 120)');
    // Hue 120 is in the light band, so dark foreground text.
    expect(root.style.getPropertyValue('--primary-foreground')).toBe('oklch(0.2 0.03 120)');

    // Turning it back off clears every inline brand token so the preset accent resumes.
    applyAppearance({ ...APPEARANCE, customAccent: { enabled: false, hue: 120 } }, root);
    expect(root.style.getPropertyValue('--primary')).toBe('');
    expect(root.style.getPropertyValue('--primary-foreground')).toBe('');
    expect(root.style.getPropertyValue('--ring')).toBe('');
    expect(root.style.getPropertyValue('--highlight')).toBe('');
  });

  it('is idempotent on the .dark class', () => {
    const root = document.createElement('div');
    applyAppearance({ ...APPEARANCE, mode: 'dark' }, root);
    applyAppearance({ ...APPEARANCE, mode: 'dark' }, root);
    expect(root.className.split(/\s+/).filter((c) => c === DARK_CLASS)).toHaveLength(1);
  });

  it('defaults to the document root', () => {
    applyAppearance({ ...APPEARANCE, mode: 'dark' });
    expect(document.documentElement.classList.contains(DARK_CLASS)).toBe(true);
  });
});

describe('usePreferencesStore — animation level ↔ background effect', () => {
  afterEach(() => {
    usePreferencesStore.setState({ animationLevel: 'balanced', backgroundEffect: 'none' });
  });

  it('turns Snow on by default when the "Total Gubbage" preset is chosen', () => {
    usePreferencesStore.setState({ animationLevel: 'balanced', backgroundEffect: 'none' });
    usePreferencesStore.getState().setAnimationLevel('headache');
    expect(usePreferencesStore.getState().animationLevel).toBe('headache');
    expect(usePreferencesStore.getState().backgroundEffect).toBe('snow');
  });

  it('preserves an explicitly-chosen background effect when switching to headache', () => {
    usePreferencesStore.setState({ animationLevel: 'balanced', backgroundEffect: 'rain' });
    usePreferencesStore.getState().setAnimationLevel('headache');
    expect(usePreferencesStore.getState().backgroundEffect).toBe('rain');
  });

  it('leaves the background effect untouched for the calmer levels', () => {
    usePreferencesStore.setState({ animationLevel: 'headache', backgroundEffect: 'none' });
    usePreferencesStore.getState().setAnimationLevel('calm');
    expect(usePreferencesStore.getState().backgroundEffect).toBe('none');
  });
});

describe('usePreferencesStore — Branding preferences (issue #110)', () => {
  afterEach(() => {
    usePreferencesStore.setState({
      customAccentEnabled: false,
      customAccentHue: 277,
      brandTagline: '',
      surfaceStyle: 'solid',
    });
  });

  it('toggles the custom accent on and off', () => {
    usePreferencesStore.getState().setCustomAccentEnabled(true);
    expect(usePreferencesStore.getState().customAccentEnabled).toBe(true);
    usePreferencesStore.getState().setCustomAccentEnabled(false);
    expect(usePreferencesStore.getState().customAccentEnabled).toBe(false);
  });

  it('clamps and wraps the custom accent hue into 0–359°', () => {
    usePreferencesStore.getState().setCustomAccentHue(120.6);
    expect(usePreferencesStore.getState().customAccentHue).toBe(121);
    // Wraps a value past the end back into range rather than clamping flat.
    usePreferencesStore.getState().setCustomAccentHue(400);
    expect(usePreferencesStore.getState().customAccentHue).toBe(40);
    usePreferencesStore.getState().setCustomAccentHue(-10);
    expect(usePreferencesStore.getState().customAccentHue).toBe(350);
  });

  it('stores the brand tagline verbatim (trailing spaces preserved for typing)', () => {
    usePreferencesStore.getState().setBrandTagline('Acme Widgets ');
    expect(usePreferencesStore.getState().brandTagline).toBe('Acme Widgets ');
  });

  it('normalises the surface style, ignoring an unknown value', () => {
    usePreferencesStore.getState().setSurfaceStyle('sheer');
    expect(usePreferencesStore.getState().surfaceStyle).toBe('sheer');
    usePreferencesStore.getState().setSurfaceStyle('bogus' as never);
    expect(usePreferencesStore.getState().surfaceStyle).toBe('solid');
  });
});

describe('usePreferencesStore — Phase 12 window preferences', () => {
  afterEach(() => {
    usePreferencesStore.setState({
      mode: 'dark',
      expirySoonWindowDays: EXPIRY_SOON_WINDOW_DAYS,
      pruneWindowMonths: DEFAULT_WINDOW_MONTHS,
      downgradeWindowMonths: DEFAULT_WINDOW_MONTHS,
    });
  });

  it('defaults the new windows to the shared constants', () => {
    const s = usePreferencesStore.getState();
    expect(s.expirySoonWindowDays).toBe(EXPIRY_SOON_WINDOW_DAYS);
    expect(s.pruneWindowMonths).toBe(DEFAULT_WINDOW_MONTHS);
    expect(s.downgradeWindowMonths).toBe(DEFAULT_WINDOW_MONTHS);
  });

  it('clamps the expiry window through its setter', () => {
    usePreferencesStore.getState().setExpirySoonWindowDays(9999);
    expect(usePreferencesStore.getState().expirySoonWindowDays).toBe(EXPIRY_WINDOW_BOUNDS.max);
    usePreferencesStore.getState().setExpirySoonWindowDays(0);
    expect(usePreferencesStore.getState().expirySoonWindowDays).toBe(EXPIRY_WINDOW_BOUNDS.min);
  });

  it('normalises the prune/downgrade windows through their setters', () => {
    usePreferencesStore.getState().setPruneWindowMonths(7);
    expect(usePreferencesStore.getState().pruneWindowMonths).toBe(DEFAULT_WINDOW_MONTHS);
    usePreferencesStore.getState().setDowngradeWindowMonths(12);
    expect(usePreferencesStore.getState().downgradeWindowMonths).toBe(12);
  });
});

describe('usePreferencesStore — Phase 46 low-stock thresholds', () => {
  afterEach(() => {
    usePreferencesStore.setState({
      lowStockQtyThreshold: LOW_STOCK_QTY_THRESHOLD,
      lowStockGaugePercent: LOW_STOCK_GAUGE_PERCENT,
    });
  });

  it('defaults the low-stock thresholds to the shared constants', () => {
    const s = usePreferencesStore.getState();
    expect(s.lowStockQtyThreshold).toBe(LOW_STOCK_QTY_THRESHOLD);
    expect(s.lowStockGaugePercent).toBe(LOW_STOCK_GAUGE_PERCENT);
  });

  it('clamps the thresholds through their setters', () => {
    usePreferencesStore.getState().setLowStockQtyThreshold(99999);
    expect(usePreferencesStore.getState().lowStockQtyThreshold).toBe(LOW_STOCK_QTY_BOUNDS.max);
    usePreferencesStore.getState().setLowStockQtyThreshold(0);
    expect(usePreferencesStore.getState().lowStockQtyThreshold).toBe(LOW_STOCK_QTY_BOUNDS.min);
    usePreferencesStore.getState().setLowStockGaugePercent(150);
    expect(usePreferencesStore.getState().lowStockGaugePercent).toBe(LOW_STOCK_GAUGE_BOUNDS.max);
  });
});

describe('clampBudgetWarnPercent', () => {
  it('keeps an in-range value, rounding to a whole percent', () => {
    expect(clampBudgetWarnPercent(80)).toBe(80);
    expect(clampBudgetWarnPercent(72.4)).toBe(72);
  });

  it('clamps out-of-range values to the bounds', () => {
    expect(clampBudgetWarnPercent(0)).toBe(BUDGET_WARN_BOUNDS.min);
    expect(clampBudgetWarnPercent(-5)).toBe(BUDGET_WARN_BOUNDS.min);
    expect(clampBudgetWarnPercent(150)).toBe(BUDGET_WARN_BOUNDS.max);
  });

  it('falls back to the default for non-finite input', () => {
    expect(clampBudgetWarnPercent(Number.NaN)).toBe(BUDGET_WARN_PERCENT);
  });
});

describe('usePreferencesStore — Phase 58 budget warn percent', () => {
  afterEach(() => {
    usePreferencesStore.setState({ budgetWarnPercent: BUDGET_WARN_PERCENT });
  });

  it('defaults to the shared constant and clamps through its setter', () => {
    expect(usePreferencesStore.getState().budgetWarnPercent).toBe(BUDGET_WARN_PERCENT);
    usePreferencesStore.getState().setBudgetWarnPercent(150);
    expect(usePreferencesStore.getState().budgetWarnPercent).toBe(BUDGET_WARN_BOUNDS.max);
    usePreferencesStore.getState().setBudgetWarnPercent(0);
    expect(usePreferencesStore.getState().budgetWarnPercent).toBe(BUDGET_WARN_BOUNDS.min);
  });
});

describe('nav-tile count metrics (A1)', () => {
  it('derives a default for every configurable tile from the config, no drift', () => {
    for (const route of NAV_COUNT_ROUTES) {
      expect(DEFAULT_NAV_COUNT_METRICS[route]).toBe(NAV_COUNT_METRIC_CONFIG[route].default);
      // Each default is one of the tile's actual options.
      expect(
        NAV_COUNT_METRIC_CONFIG[route].options.some((o) => o.value === DEFAULT_NAV_COUNT_METRICS[route]),
      ).toBe(true);
    }
  });

  it('normaliseNavCountMetric passes valid ids and coerces stale ones to the tile default', () => {
    expect(normaliseNavCountMetric('/projects', 'all')).toBe('all');
    expect(normaliseNavCountMetric('/projects', 'nonsense')).toBe('active');
    expect(normaliseNavCountMetric('/bookings', '')).toBe('upcoming');
  });

  it('normaliseNavCountMetrics fills a partial/stale map with valid choices for every tile', () => {
    const result = normaliseNavCountMetrics({ '/projects': 'all', '/bookings': 'bogus' });
    expect(result).toEqual({
      '/inventory': 'total', // filled from default (absent)
      '/projects': 'all', // kept
      '/purchase-orders': 'open', // filled from default (absent)
      '/bookings': 'upcoming', // coerced (bogus)
    });
    // A wholly-undefined map yields the shipped defaults.
    expect(normaliseNavCountMetrics(undefined)).toEqual(DEFAULT_NAV_COUNT_METRICS);
  });

  it('navCountOption resolves the chosen option, falling back to the default option', () => {
    expect(navCountOption('/projects', 'all').noun).toBe('project');
    expect(navCountOption('/projects', 'nonsense').value).toBe('active');
  });
});

describe('nav-tile count metric tones (A2)', () => {
  it('tags each problem metric with its attention tone and leaves plain totals neutral', () => {
    // Inventory: total is a plain count; low-stock warns; out-of-stock is a danger.
    expect(navCountTone('/inventory', 'total')).toBe('neutral');
    expect(navCountTone('/inventory', 'lowStock')).toBe('warning');
    expect(navCountTone('/inventory', 'outOfStock')).toBe('danger');
    // Projects: active/all are neutral; over-budget is a danger.
    expect(navCountTone('/projects', 'active')).toBe('neutral');
    expect(navCountTone('/projects', 'overBudget')).toBe('danger');
  });

  it('falls back to the tile default tone for a stale/unknown metric id', () => {
    // Coerces '/inventory' → its default ('total'), whose tone is neutral.
    expect(navCountTone('/inventory', 'nonsense')).toBe('neutral');
  });

  it('the problem metrics carry the spoken nouns that state what the number is (a11y)', () => {
    expect(navCountOption('/inventory', 'lowStock').nounPlural).toBe('low-stock items');
    expect(navCountOption('/inventory', 'outOfStock').nounPlural).toBe('out-of-stock items');
    expect(navCountOption('/projects', 'overBudget').nounPlural).toBe('over-budget projects');
  });
});

describe('usePreferencesStore — nav-tile count metrics (A1)', () => {
  afterEach(() => {
    usePreferencesStore.setState({ navCountMetrics: { ...DEFAULT_NAV_COUNT_METRICS } });
  });

  it('defaults to the shipped per-tile metrics', () => {
    expect(usePreferencesStore.getState().navCountMetrics).toEqual(DEFAULT_NAV_COUNT_METRICS);
  });

  it('sets one tile through its setter without disturbing the others, and normalises', () => {
    usePreferencesStore.getState().setNavCountMetric('/projects', 'all');
    expect(usePreferencesStore.getState().navCountMetrics['/projects']).toBe('all');
    // Other tiles are untouched.
    expect(usePreferencesStore.getState().navCountMetrics['/bookings']).toBe('upcoming');
    // A stale id coerces to the tile default.
    usePreferencesStore.getState().setNavCountMetric('/purchase-orders', 'nonsense');
    expect(usePreferencesStore.getState().navCountMetrics['/purchase-orders']).toBe('open');
  });
});
