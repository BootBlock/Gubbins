import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import type { MaintenanceSchedule, ItemStockPlacement } from '@/db/repositories';

/**
 * Behaviour tests for the {@link MaintenanceEditor} item-detail facet (spec §4.3 Tool
 * Maintenance & Calibration, Phases 9/22/30). The due-ness maths lives in the pure
 * `maintenance` seam (covered by maintenance.test.ts) and is used here for real; this pins
 * the *editor's* decision logic — how the New-schedule form assembles the exact
 * {@link CreateMaintenanceInput} for each basis (TIME vs. USAGE, the accrue-checkout-hours
 * variant, and the per-placement location scope), the empty-name gate, the create-error
 * alert, and the ScheduleRow actions (Done / Remove / Log-usage). Per the component-test
 * conventions every `../hooks` hook the component calls is mocked; the pure
 * `maintenanceStatus` / `maintenancePerformedNote` seam runs for real.
 */

const h = vi.hoisted(() => ({
  schedules: [] as MaintenanceSchedule[],
  placements: [] as ItemStockPlacement[],
  create: vi.fn(),
  log: vi.fn(),
  addUsage: vi.fn(),
  remove: vi.fn(),
}));

vi.mock('../hooks', () => ({
  useItemMaintenance: () => ({ data: h.schedules }),
  useItemStock: () => ({ data: h.placements }),
  useCreateMaintenance: () => ({ mutate: h.create, isPending: false }),
  useLogMaintenance: () => ({ mutate: h.log, isPending: false }),
  useAddMaintenanceUsage: () => ({ mutate: h.addUsage, isPending: false }),
  useRemoveMaintenance: () => ({ mutate: h.remove, isPending: false }),
}));

import { MaintenanceEditor } from './MaintenanceEditor';

const MS_PER_DAY = 86_400_000;

/** A whole, correctly-shaped schedule row; override only the fields a test cares about. */
const schedule = (o: Partial<MaintenanceSchedule> = {}): MaintenanceSchedule => ({
  id: 'sch-1',
  itemId: 'item-1',
  name: 'Lubricate rails',
  basis: 'TIME',
  intervalDays: 30,
  intervalUsage: null,
  usageUnit: null,
  usageSinceService: 0,
  accrueCheckoutHours: false,
  autoUsageHours: 0,
  locationId: null,
  locationName: null,
  lastPerformedAt: null,
  note: null,
  createdAt: Date.now(),
  updatedAt: Date.now(),
  ...o,
});

const placement = (locationId: string, locationName: string, quantity: number): ItemStockPlacement => ({
  locationId,
  locationName,
  quantity,
});

function renderEditor(itemId = 'item-1') {
  return render(<MaintenanceEditor itemId={itemId} />);
}

const nameInput = () => screen.getByTestId('maintenance-name');
const addButton = () => screen.getByTestId('add-maintenance');

beforeEach(() => {
  h.schedules = [];
  h.placements = [placement('loc-1', 'Workshop', 3)];
  h.create.mockReset().mockImplementation((_input, opts) => opts?.onSuccess?.());
  h.log.mockReset();
  h.addUsage.mockReset().mockImplementation((_input, opts) => opts?.onSuccess?.());
  h.remove.mockReset();
});
afterEach(cleanup);

describe('MaintenanceEditor — adding a TIME schedule', () => {
  it('assembles the exact TIME payload with defaults and resets the name box on success', async () => {
    renderEditor();
    fireEvent.change(nameInput(), { target: { value: 'Calibrate' } });
    fireEvent.click(addButton());

    await waitFor(() =>
      expect(h.create).toHaveBeenCalledWith(
        { itemId: 'item-1', name: 'Calibrate', basis: 'TIME', intervalDays: 90, locationId: null },
        expect.anything(),
      ),
    );
    // A single placement offers no location scope, so it stays item-level (null).
    expect(screen.queryByTestId('maintenance-location')).toBeNull();
    // onSuccess clears the name box for the next entry.
    expect(nameInput()).toHaveValue('');
  });

  it('trims the name and honours a custom interval', async () => {
    renderEditor();
    fireEvent.change(nameInput(), { target: { value: '  Grease bearings  ' } });
    fireEvent.change(screen.getByLabelText('Interval in days'), { target: { value: '45' } });
    fireEvent.click(addButton());

    await waitFor(() =>
      expect(h.create).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'Grease bearings', intervalDays: 45 }),
        expect.anything(),
      ),
    );
  });
});

describe('MaintenanceEditor — adding a USAGE schedule', () => {
  /** Flip the basis Select (a Foundry custom listbox) to Usage-based. */
  function chooseUsageBasis() {
    fireEvent.click(screen.getByRole('combobox', { name: 'Schedule basis' }));
    fireEvent.click(screen.getByRole('option', { name: 'Usage-based' }));
  }

  it('sends the manual-usage payload with the typed interval and unit', async () => {
    renderEditor();
    fireEvent.change(nameInput(), { target: { value: 'Replace filter' } });
    chooseUsageBasis();
    fireEvent.change(screen.getByLabelText('Usage interval'), { target: { value: '100' } });
    fireEvent.change(screen.getByPlaceholderText('hours'), { target: { value: 'cycles' } });
    fireEvent.click(addButton());

    await waitFor(() =>
      expect(h.create).toHaveBeenCalledWith(
        {
          itemId: 'item-1',
          name: 'Replace filter',
          basis: 'USAGE',
          intervalUsage: 100,
          usageUnit: 'cycles',
          accrueCheckoutHours: false,
          locationId: null,
        },
        expect.anything(),
      ),
    );
  });

  it('ticking accrue-checkout-hours forces the unit to hours and sets the flag', async () => {
    renderEditor();
    fireEvent.change(nameInput(), { target: { value: 'Service motor' } });
    chooseUsageBasis();
    fireEvent.change(screen.getByLabelText('Usage interval'), { target: { value: '250' } });
    fireEvent.click(screen.getByTestId('accrue-checkout-hours'));
    fireEvent.click(addButton());

    await waitFor(() =>
      expect(h.create).toHaveBeenCalledWith(
        expect.objectContaining({
          basis: 'USAGE',
          intervalUsage: 250,
          usageUnit: 'hours',
          accrueCheckoutHours: true,
        }),
        expect.anything(),
      ),
    );
  });
});

describe('MaintenanceEditor — per-placement location scope (Phase 30)', () => {
  beforeEach(() => {
    h.placements = [placement('loc-1', 'Workshop', 2), placement('loc-2', 'Van', 5)];
  });

  it('scopes the schedule to the chosen placement', async () => {
    renderEditor();
    fireEvent.change(nameInput(), { target: { value: 'Calibrate' } });
    // The location Select only appears with more than one placement.
    fireEvent.click(screen.getByRole('combobox', { name: 'Applies to' }));
    fireEvent.click(screen.getByRole('option', { name: 'Van' }));
    fireEvent.click(addButton());

    await waitFor(() =>
      expect(h.create).toHaveBeenCalledWith(
        expect.objectContaining({ locationId: 'loc-2' }),
        expect.anything(),
      ),
    );
  });

  it('leaves the schedule item-level when "Whole item" is kept', async () => {
    renderEditor();
    fireEvent.change(nameInput(), { target: { value: 'Calibrate' } });
    // Default option is "Whole item (any location)" → null even though a scope is offered.
    fireEvent.click(addButton());

    await waitFor(() =>
      expect(h.create).toHaveBeenCalledWith(expect.objectContaining({ locationId: null }), expect.anything()),
    );
  });
});

describe('MaintenanceEditor — the add gates', () => {
  it('a blank name adds nothing and shows no error', () => {
    renderEditor();
    fireEvent.click(addButton());
    expect(h.create).not.toHaveBeenCalled();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('surfaces a create failure in an alert without clearing the name', async () => {
    h.create.mockImplementation((_input, opts) =>
      opts?.onError?.(new Error('A schedule by that name exists.')),
    );
    renderEditor();
    fireEvent.change(nameInput(), { target: { value: 'Calibrate' } });
    fireEvent.click(addButton());

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('A schedule by that name exists.'),
    );
    expect(nameInput()).toHaveValue('Calibrate');
  });
});

describe('MaintenanceEditor — ScheduleRow actions', () => {
  it('logs a performed service, passing a composed note', () => {
    h.schedules = [schedule({ id: 'sch-1', name: 'Lubricate rails' })];
    renderEditor();
    fireEvent.click(screen.getByTestId('log-maintenance'));
    expect(h.log).toHaveBeenCalledWith({ id: 'sch-1', itemId: 'item-1', note: expect.any(String) });
  });

  it('removes a schedule', () => {
    h.schedules = [schedule({ id: 'sch-1' })];
    renderEditor();
    fireEvent.click(screen.getByRole('button', { name: 'Remove schedule' }));
    expect(h.remove).toHaveBeenCalledWith({ id: 'sch-1', itemId: 'item-1' });
  });

  it('gates Log-usage on a positive amount, then accrues the typed usage', () => {
    h.schedules = [
      schedule({
        id: 'sch-1',
        basis: 'USAGE',
        intervalDays: null,
        intervalUsage: 100,
        usageUnit: 'cycles',
        accrueCheckoutHours: false,
      }),
    ];
    renderEditor();
    const logUsage = screen.getByRole('button', { name: /Log usage/ });
    expect(logUsage).toBeDisabled();

    // The manual-usage input is scoped by its placeholder (the add form has its own number field).
    fireEvent.change(screen.getByPlaceholderText('Log cycles'), { target: { value: '5' } });
    expect(logUsage).toBeEnabled();
    fireEvent.click(logUsage);

    expect(h.addUsage).toHaveBeenCalledWith({ id: 'sch-1', itemId: 'item-1', amount: 5 }, expect.anything());
  });

  it('hides the manual-usage input for an accrue-checkout-hours schedule', () => {
    h.schedules = [
      schedule({
        id: 'sch-1',
        basis: 'USAGE',
        intervalDays: null,
        intervalUsage: 100,
        usageUnit: 'hours',
        accrueCheckoutHours: true,
        autoUsageHours: 4,
      }),
    ];
    renderEditor();
    expect(screen.queryByRole('button', { name: /Log usage/ })).toBeNull();
  });

  it('consumes the pure due-status maths — an overdue schedule flags up', () => {
    h.schedules = [
      schedule({
        id: 'sch-1',
        basis: 'TIME',
        intervalDays: 10,
        lastPerformedAt: null,
        createdAt: Date.now() - 100 * MS_PER_DAY,
      }),
    ];
    renderEditor();
    expect(screen.getByText(/overdue/)).toBeInTheDocument();
  });
});
