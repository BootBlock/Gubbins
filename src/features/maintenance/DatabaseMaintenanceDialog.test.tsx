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

const mockCompact = vi.hoisted(() => vi.fn());
const mockHealth = vi.hoisted(() => vi.fn());
const mockSweep = vi.hoisted(() => vi.fn());

vi.mock('./db-maintenance-actions', () => ({
  browserMaintenancePorts: () => ({}),
  compactDatabase: (...args: unknown[]) => (mockCompact as Mock)(...args),
  checkDatabaseHealth: (...args: unknown[]) => (mockHealth as Mock)(...args),
  sweepOrphanImages: (...args: unknown[]) => (mockSweep as Mock)(...args),
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
});
afterEach(cleanup);

describe('DatabaseMaintenanceDialog', () => {
  it('renders the three task cards', () => {
    renderDialog();
    expect(screen.getByTestId('maintenance-compact-run')).toBeTruthy();
    expect(screen.getByTestId('maintenance-health-run')).toBeTruthy();
    expect(screen.getByTestId('maintenance-sweep-run')).toBeTruthy();
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
});
