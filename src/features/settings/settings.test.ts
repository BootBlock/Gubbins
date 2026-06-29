import { afterEach, describe, expect, it } from 'vitest';
import {
  EXPIRY_SOON_WINDOW_DAYS,
  LOW_STOCK_GAUGE_PERCENT,
  LOW_STOCK_QTY_THRESHOLD,
} from '@/db/repositories/constants';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';
import {
  clampExpiryWindowDays,
  clampLowStockGaugePercent,
  clampLowStockQty,
  DEFAULT_WINDOW_MONTHS,
  EXPIRY_WINDOW_BOUNDS,
  LOW_STOCK_GAUGE_BOUNDS,
  LOW_STOCK_QTY_BOUNDS,
  normaliseWindowMonths,
  THEME_OPTIONS,
  WINDOW_MONTH_OPTIONS,
} from './settings';
import { applyTheme, DARK_CLASS, resolveTheme } from './theme';

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

describe('THEME_OPTIONS', () => {
  it('offers Dark, Light and System (spec §2.1)', () => {
    expect(THEME_OPTIONS.map((o) => o.value)).toEqual(['dark', 'light', 'system']);
  });
});

describe('resolveTheme', () => {
  it('passes an explicit theme through, ignoring the OS preference', () => {
    expect(resolveTheme('dark', false)).toBe('dark');
    expect(resolveTheme('dark', true)).toBe('dark');
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('light', false)).toBe('light');
  });

  it('follows the OS preference for the system theme', () => {
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
  });
});

describe('applyTheme', () => {
  afterEach(() => {
    document.documentElement.classList.remove(DARK_CLASS);
  });

  it('adds .dark for the dark theme and removes it for light', () => {
    const root = document.createElement('div');
    applyTheme('dark', root);
    expect(root.classList.contains(DARK_CLASS)).toBe(true);
    applyTheme('light', root);
    expect(root.classList.contains(DARK_CLASS)).toBe(false);
  });

  it('is idempotent', () => {
    const root = document.createElement('div');
    applyTheme('dark', root);
    applyTheme('dark', root);
    expect(root.className.split(/\s+/).filter((c) => c === DARK_CLASS)).toHaveLength(1);
  });

  it('defaults to the document root', () => {
    applyTheme('dark');
    expect(document.documentElement.classList.contains(DARK_CLASS)).toBe(true);
  });
});

describe('usePreferencesStore — Phase 12 window preferences', () => {
  afterEach(() => {
    usePreferencesStore.setState({
      theme: 'dark',
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
