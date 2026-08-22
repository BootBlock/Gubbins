/**
 * `useHealthyWidgetIds` — the "nothing to report" probe behind the Dashboard's *Hide cards with
 * nothing to report* option (issue #111).
 *
 * Each card's branch has to mirror the widget's own empty state, and has to stay silent while the
 * data is still loading or errored — a card that hasn't answered yet must keep its place rather
 * than vanish and pop back. These tests pin both halves per card, so a widget whose empty rule
 * changes without its branch fails here rather than silently hiding the wrong tile.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';

/** A resolved react-query result carrying `data`; `undefined` stands in for loading/errored. */
const resolved = <T,>(data: T) => ({ data }) as never;
const pending = () => ({ data: undefined }) as never;

const rows = {
  lowStock: pending(),
  expiring: pending(),
  maintenance: pending(),
  inTransit: pending(),
  checkouts: pending(),
  projects: pending(),
  budget: pending(),
};

vi.mock('@/features/lifecycle/hooks', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useLowStockItems: () => rows.lowStock,
  useExpiringItems: () => rows.expiring,
  useDueMaintenance: () => rows.maintenance,
  useInTransitLines: () => rows.inTransit,
}));
vi.mock('@/features/contacts/contacts', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useOpenCheckouts: () => rows.checkouts,
}));
vi.mock('@/features/projects/projects', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useProjects: () => rows.projects,
  useBudgetAlerts: () => rows.budget,
}));

const { useHealthyWidgetIds } = await import('./widgets');

/** The probe's verdict for the current `rows` fixture. */
function probe(): ReadonlySet<string> {
  return renderHook(() => useHealthyWidgetIds()).result.current;
}

beforeEach(() => {
  for (const key of Object.keys(rows) as (keyof typeof rows)[]) rows[key] = pending();
  usePreferencesStore.setState({ budgetWarnPercent: 80 });
});

describe('useHealthyWidgetIds — nothing to report (issue #111)', () => {
  it('reports nothing while every card is still loading', () => {
    // A card whose query hasn't resolved keeps its place — hiding it now would make the board
    // shuffle as the data lands.
    expect(probe().size).toBe(0);
  });

  it('reports every card once they all resolve empty', () => {
    rows.lowStock = resolved({ rows: [] });
    rows.expiring = resolved({ rows: [] });
    rows.maintenance = resolved({ rows: [] });
    rows.inTransit = resolved({ rows: [] });
    rows.checkouts = resolved({ rows: [] });
    rows.projects = resolved({ rows: [] });
    rows.budget = resolved([]);
    expect([...probe()].sort()).toEqual([
      'budget-alerts',
      'expiring',
      'in-transit',
      'low-stock',
      'maintenance',
      'overdue',
      'projects',
    ]);
  });

  it('keeps Overdue on the board while a loan is actually late, but clears on merely-on-loan', () => {
    rows.checkouts = resolved({ rows: [{ isOverdue: true }] });
    expect(probe().has('overdue')).toBe(false);
    rows.checkouts = resolved({ rows: [{ isOverdue: false }] });
    expect(probe().has('overdue')).toBe(true);
  });

  it('keeps Budget alerts on the board only while a project is over or approaching budget', () => {
    rows.budget = resolved([{ budget: 100, committedFromBom: 95, manualExpenseTotal: 0, estimatedCost: 95 }]);
    expect(probe().has('budget-alerts')).toBe(false);
    rows.budget = resolved([{ budget: 100, committedFromBom: 5, manualExpenseTotal: 0, estimatedCost: 5 }]);
    expect(probe().has('budget-alerts')).toBe(true);
  });

  it('clears In transit only when nothing is on its way', () => {
    rows.inTransit = resolved({ rows: [{ lineId: 'l1', label: 'Bolts', requiredQty: 4, receivedQty: 0 }] });
    expect(probe().has('in-transit')).toBe(false);
    rows.inTransit = resolved({ rows: [] });
    expect(probe().has('in-transit')).toBe(true);
  });

  it('clears Project statuses when only archived projects remain, matching what the card lists', () => {
    // The card lists the non-archived projects, so a board of nothing but archived ones shows its
    // empty state — the probe has to agree, or the card stays up saying nothing.
    rows.projects = resolved({ rows: [{ status: 'ACTIVE' }] });
    expect(probe().has('projects')).toBe(false);
    rows.projects = resolved({ rows: [{ status: 'ARCHIVED' }] });
    expect(probe().has('projects')).toBe(true);
  });

  it('never reports the cards that always have something to say', () => {
    rows.lowStock = resolved({ rows: [] });
    rows.expiring = resolved({ rows: [] });
    rows.maintenance = resolved({ rows: [] });
    rows.inTransit = resolved({ rows: [] });
    rows.checkouts = resolved({ rows: [] });
    rows.projects = resolved({ rows: [] });
    rows.budget = resolved([]);
    const healthy = probe();
    for (const id of [
      'inventory-totals',
      'recent-activity',
      'system-database',
      'system-storage',
      'system-platform',
    ]) {
      expect(healthy.has(id)).toBe(false);
    }
  });
});
