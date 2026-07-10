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
  CURRENCY_OPTIONS,
  DEFAULT_CARD_CLICK_ACTION,
  DEFAULT_WINDOW_MONTHS,
  EXPIRY_WINDOW_BOUNDS,
  guessBaseCurrency,
  LOW_STOCK_GAUGE_BOUNDS,
  LOW_STOCK_QTY_BOUNDS,
  normaliseCardClickAction,
  normaliseVisualCardMetric,
  normaliseWindowMonths,
  DEFAULT_VISUAL_CARD_METRIC,
  DEFAULT_NAV_COUNT_METRICS,
  NAV_COUNT_METRIC_CONFIG,
  NAV_COUNT_ROUTES,
  navCountOption,
  navCountTone,
  normaliseNavCountMetric,
  normaliseNavCountMetrics,
  VISUAL_CARD_METRIC_OPTIONS,
  WINDOW_MONTH_OPTIONS,
} from './settings';
import { applyAppearance, DARK_CLASS, resolveMode } from './theme';
import type { Appearance } from './theme';

/** A base appearance for applyAppearance tests — override just the field under test. */
const APPEARANCE: Appearance = {
  mode: 'dark',
  accent: 'violet',
  oledDark: false,
  highContrast: false,
  reduceEffects: false,
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
  });

  it('coerces an unknown/stale persisted value to the default', () => {
    expect(normaliseVisualCardMetric('turnover')).toBe(DEFAULT_VISUAL_CARD_METRIC);
    expect(normaliseVisualCardMetric('')).toBe(DEFAULT_VISUAL_CARD_METRIC);
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

  it('sets and clears data-reduce-effects for the "Reduce effects" switch (F9)', () => {
    const root = document.createElement('div');
    applyAppearance({ ...APPEARANCE, reduceEffects: true }, root);
    expect(root.dataset.reduceEffects).toBe('');
    applyAppearance({ ...APPEARANCE, reduceEffects: false }, root);
    expect(root.dataset.reduceEffects).toBeUndefined();
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
