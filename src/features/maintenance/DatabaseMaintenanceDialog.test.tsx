/**
 * DatabaseMaintenanceDialog UI wiring + a11y.
 *
 * The engine functions are the async IO boundary — mocked at the module level so no DB,
 * OPFS or worker is touched. These tests verify each task card runs its action on click
 * and renders its outcome (with the problem list surfaced for an unhealthy database).
 */
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { render, screen, cleanup, fireEvent, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from '@/components/foundry';
import { DatabaseMaintenanceDialog } from './DatabaseMaintenanceDialog';
import { DatabaseMaintenance } from './DatabaseMaintenance';
import { useSessionStore } from '@/state/stores/useSessionStore';
import { UNRESTRICTED_AUTHORITY } from '@/features/users/permissions';

const mockCompact = vi.hoisted(() => vi.fn());
const mockHealth = vi.hoisted(() => vi.fn());
const mockSweep = vi.hoisted(() => vi.fn());
const mockStats = vi.hoisted(() => vi.fn());
const mockSearch = vi.hoisted(() => vi.fn());
const mockStock = vi.hoisted(() => vi.fn());
const mockMissing = vi.hoisted(() => vi.fn());

vi.mock('./db-maintenance-actions', () => ({
  browserMaintenancePorts: () => ({}),
  compactDatabase: (...args: unknown[]) => (mockCompact as Mock)(...args),
  checkDatabaseHealth: (...args: unknown[]) => (mockHealth as Mock)(...args),
  sweepOrphanImages: (...args: unknown[]) => (mockSweep as Mock)(...args),
  gatherDatabaseStats: (...args: unknown[]) => (mockStats as Mock)(...args),
  checkSearchIndex: (...args: unknown[]) => (mockSearch as Mock)(...args),
  verifyStockTotals: (...args: unknown[]) => (mockStock as Mock)(...args),
  findMissingImageFiles: (...args: unknown[]) => (mockMissing as Mock)(...args),
}));

vi.mock('@/lib/useFormatters', () => ({
  useFormatters: () => ({
    bytes: (n: number) => `${n} B`,
    percent: (ratio: number) => `${Math.round(ratio * 100)}%`,
    quantity: (n: number) => String(n),
  }),
}));

vi.mock('@/state/stores/useStorageStore', () => ({
  useStorageStore: { getState: () => ({ refresh: vi.fn() }) },
}));

function renderDialog() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <DatabaseMaintenanceDialog open onClose={() => {}} />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mockCompact.mockReset();
  mockHealth.mockReset();
  mockSweep.mockReset();
  mockStats.mockReset();
  mockSearch.mockReset();
  mockStock.mockReset();
  mockMissing.mockReset();
  useSessionStore.setState({ authority: UNRESTRICTED_AUTHORITY });
});
afterEach(() => {
  cleanup();
  useSessionStore.setState({ authority: UNRESTRICTED_AUTHORITY });
});

/** A session that may look but not touch: read-only everywhere, no `storage:write`. */
function readOnlySession() {
  useSessionStore.setState({ authority: { mode: 'granted', grants: new Set(['storage:read']) } });
}

describe('DatabaseMaintenanceDialog', () => {
  it('renders every task card', () => {
    renderDialog();
    for (const id of ['stats', 'health', 'search', 'stock', 'missing', 'compact', 'sweep']) {
      expect(screen.getByTestId(`maintenance-${id}-run`)).toBeTruthy();
    }
  });

  it('reports the space reclaimed by compaction with its stats', async () => {
    mockCompact.mockResolvedValue({
      beforeBytes: 1000,
      afterBytes: 600,
      reclaimedBytes: 400,
      reclaimedFraction: 0.4,
      freePagesBefore: 3,
    });
    renderDialog();
    await act(async () => {
      fireEvent.click(screen.getByTestId('maintenance-compact-run'));
    });
    await waitFor(() => {
      const text = screen.getByTestId('maintenance-compact-result').textContent ?? '';
      expect(text).toContain('400 B'); // reclaimed
      expect(text).toContain('40%'); // fraction of the file
      expect(text).toContain('3 unused pages'); // the free pages behind it
      expect(text).toContain('was 1000 B'); // before size
    });
    expect(mockCompact).toHaveBeenCalledTimes(1);
  });

  it('reports an already-compact database without inventing stats', async () => {
    mockCompact.mockResolvedValue({
      beforeBytes: 600,
      afterBytes: 600,
      reclaimedBytes: 0,
      reclaimedFraction: 0,
      freePagesBefore: 0,
    });
    renderDialog();
    await act(async () => {
      fireEvent.click(screen.getByTestId('maintenance-compact-run'));
    });
    await waitFor(() => {
      expect(screen.getByTestId('maintenance-compact-result').textContent).toMatch(/already compact/i);
    });
  });

  it('reports a clean bill of health', async () => {
    mockHealth.mockResolvedValue({ ok: true, problems: [] });
    renderDialog();
    await act(async () => {
      fireEvent.click(screen.getByTestId('maintenance-health-run'));
    });
    await waitFor(() => {
      expect(screen.getByTestId('maintenance-health-result').textContent).toMatch(/healthy/i);
    });
  });

  it('surfaces the problem list when the database is unhealthy', async () => {
    mockHealth.mockResolvedValue({
      ok: false,
      problems: ['Foreign-key violation in "item_images" → missing "items".'],
    });
    renderDialog();
    await act(async () => {
      fireEvent.click(screen.getByTestId('maintenance-health-run'));
    });
    await waitFor(() => {
      const result = screen.getByTestId('maintenance-health-result');
      expect(result.textContent).toContain('1 problem');
      expect(result.textContent).toContain('item_images');
    });
  });

  it('reports the number of orphaned files removed', async () => {
    mockSweep.mockResolvedValue({ supported: true, scanned: 3, referenced: 1, removed: 2 });
    renderDialog();
    await act(async () => {
      fireEvent.click(screen.getByTestId('maintenance-sweep-run'));
    });
    await waitFor(() => {
      expect(screen.getByTestId('maintenance-sweep-result').textContent).toContain('Removed 2');
    });
  });

  it('reports when the orphan sweep is unsupported', async () => {
    mockSweep.mockResolvedValue({ supported: false, scanned: 0, referenced: 0, removed: 0 });
    renderDialog();
    await act(async () => {
      fireEvent.click(screen.getByTestId('maintenance-sweep-run'));
    });
    await waitFor(() => {
      expect(screen.getByTestId('maintenance-sweep-result').textContent).toMatch(/could not be read/i);
    });
  });

  it('renders the database statistics breakdown', async () => {
    mockStats.mockResolvedValue({
      fileBytes: 5000,
      freePages: 2,
      freeBytes: 400,
      tables: [
        { table: 'items', rows: 12 },
        { table: 'item_history', rows: 30 },
      ],
      totalRows: 42,
      imageCount: 3,
      imageBytes: 9000,
      imageBytesMeasured: true,
      sqliteVersion: '3.45.0',
      schemaVersion: 13,
    });
    renderDialog();
    await act(async () => {
      fireEvent.click(screen.getByTestId('maintenance-stats-run'));
    });
    await waitFor(() => {
      const text = screen.getByTestId('maintenance-stats-result').textContent ?? '';
      expect(text).toContain('5000 B'); // file size
      expect(text).toContain('42 across 2 tables'); // rows
      expect(text).toContain('SQLite 3.45.0'); // engine
      expect(text).toContain('schema v13');
      expect(text).toContain('items 12'); // per-table chip
    });
  });

  it('confirms a healthy search index', async () => {
    mockSearch.mockResolvedValue({ ok: true, repaired: false });
    renderDialog();
    await act(async () => {
      fireEvent.click(screen.getByTestId('maintenance-search-run'));
    });
    await waitFor(() => {
      expect(screen.getByTestId('maintenance-search-result').textContent).toMatch(/verified/i);
    });
  });

  it('reports a rebuilt search index', async () => {
    mockSearch.mockResolvedValue({ ok: true, repaired: true });
    renderDialog();
    await act(async () => {
      fireEvent.click(screen.getByTestId('maintenance-search-run'));
    });
    await waitFor(() => {
      expect(screen.getByTestId('maintenance-search-result').textContent).toMatch(/rebuilt/i);
    });
  });

  it('confirms reconciled stock totals', async () => {
    mockStock.mockResolvedValue({ ok: true, itemDrift: [], placementDrift: [] });
    renderDialog();
    await act(async () => {
      fireEvent.click(screen.getByTestId('maintenance-stock-run'));
    });
    await waitFor(() => {
      expect(screen.getByTestId('maintenance-stock-result').textContent).toMatch(/reconcile/i);
    });
  });

  it('lists drifted stock totals', async () => {
    mockStock.mockResolvedValue({
      ok: false,
      itemDrift: [{ subject: 'Nut', declared: 999, computed: 5 }],
      placementDrift: [],
    });
    renderDialog();
    await act(async () => {
      fireEvent.click(screen.getByTestId('maintenance-stock-run'));
    });
    await waitFor(() => {
      const text = screen.getByTestId('maintenance-stock-result').textContent ?? '';
      expect(text).toContain('Nut');
      expect(text).toContain('shows 999');
      expect(text).toContain('ledger has 5');
    });
  });

  it('reports missing photo files with a sample', async () => {
    mockMissing.mockResolvedValue({
      supported: true,
      checked: 4,
      missing: 2,
      sampleNames: ['Scope', 'Camera'],
    });
    renderDialog();
    await act(async () => {
      fireEvent.click(screen.getByTestId('maintenance-missing-run'));
    });
    await waitFor(() => {
      const text = screen.getByTestId('maintenance-missing-result').textContent ?? '';
      expect(text).toContain('2 of 4');
      expect(text).toContain('Scope, Camera');
    });
  });

  it('confirms when all photo files are present', async () => {
    mockMissing.mockResolvedValue({ supported: true, checked: 4, missing: 0, sampleNames: [] });
    renderDialog();
    await act(async () => {
      fireEvent.click(screen.getByTestId('maintenance-missing-run'));
    });
    await waitFor(() => {
      expect(screen.getByTestId('maintenance-missing-result').textContent).toMatch(/present/i);
    });
  });
});

describe('Database maintenance — storage:write gating (issue #429)', () => {
  it('hides the Optimise & reclaim group, keeping the read-only checks', () => {
    readOnlySession();
    renderDialog();
    for (const id of ['stats', 'health', 'search', 'stock', 'missing']) {
      expect(screen.getByTestId(`maintenance-${id}-run`)).toBeTruthy();
    }
    expect(screen.queryByTestId('maintenance-compact-run')).toBeNull();
    expect(screen.queryByTestId('maintenance-sweep-run')).toBeNull();
    expect(screen.queryByText(/optimise & reclaim/i)).toBeNull();
  });

  it('drops the whole Settings section without storage:write', () => {
    readOnlySession();
    render(<DatabaseMaintenance />);
    expect(screen.queryByTestId('open-database-maintenance')).toBeNull();
    expect(screen.queryByRole('heading', { name: /database maintenance/i })).toBeNull();
  });

  it('offers the Settings section to an unrestricted session', () => {
    render(<DatabaseMaintenance />);
    expect(screen.queryByTestId('open-database-maintenance')).not.toBeNull();
  });
});
