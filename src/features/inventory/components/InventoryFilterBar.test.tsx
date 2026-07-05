import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { useModulesStore } from '@/state/stores/useModulesStore';
import type { ItemStatusFilter } from '@/db/repositories';
import { InventoryFilterBar } from './InventoryFilterBar';

/**
 * The inventory status-filter bar: toggle chips for the common attention filters, each
 * gated on its capability (Modular UI). Feature state is driven through the real
 * `useModulesStore` intent, exactly as the alert-centre / agenda tests do.
 */
describe('InventoryFilterBar', () => {
  beforeEach(() => {
    useModulesStore.setState({ intent: {} }); // all capabilities at their defaults (on)
  });
  afterEach(() => {
    cleanup();
    useModulesStore.setState({ intent: {} });
  });

  function renderBar(overrides: Partial<Parameters<typeof InventoryFilterBar>[0]> = {}) {
    const onToggle = vi.fn();
    const onClear = vi.fn();
    render(
      <InventoryFilterBar
        value={overrides.value ?? new Set<ItemStatusFilter>()}
        onToggle={onToggle}
        onClear={onClear}
        disabled={overrides.disabled}
      />,
    );
    return { onToggle, onClear };
  }

  it('shows all four attention chips when every capability is enabled', () => {
    renderBar();
    expect(screen.getByTestId('inventory-filter-low-stock')).toBeInTheDocument();
    expect(screen.getByTestId('inventory-filter-expiring')).toBeInTheDocument();
    expect(screen.getByTestId('inventory-filter-overdue')).toBeInTheDocument();
    expect(screen.getByTestId('inventory-filter-maintenance-due')).toBeInTheDocument();
  });

  it('toggles a status when its chip is clicked', () => {
    const { onToggle } = renderBar();
    fireEvent.click(screen.getByTestId('inventory-filter-low-stock'));
    expect(onToggle).toHaveBeenCalledWith('low-stock');
  });

  it('marks the active chip as pressed and offers a Clear button', () => {
    const { onClear } = renderBar({ value: new Set<ItemStatusFilter>(['expiring']) });
    expect(screen.getByTestId('inventory-filter-expiring')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('inventory-filter-low-stock')).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(screen.getByTestId('inventory-filter-clear'));
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it('hides the Clear button when nothing is active', () => {
    renderBar();
    expect(screen.queryByTestId('inventory-filter-clear')).not.toBeInTheDocument();
  });

  it('drops the Overdue chip when Contacts (the loan facet) is off', () => {
    useModulesStore.getState().setFeatureIntent('contacts', false);
    renderBar();
    expect(screen.queryByTestId('inventory-filter-overdue')).not.toBeInTheDocument();
    // Low stock is core inventory and stays regardless.
    expect(screen.getByTestId('inventory-filter-low-stock')).toBeInTheDocument();
  });

  it('drops the Maintenance-due chip when Maintenance is off', () => {
    useModulesStore.getState().setFeatureIntent('maintenance', false);
    renderBar();
    expect(screen.queryByTestId('inventory-filter-maintenance-due')).not.toBeInTheDocument();
  });

  it('disables every chip while the Visual Builder supersedes the quick filters', () => {
    const { onToggle } = renderBar({ disabled: true });
    const chip = screen.getByTestId('inventory-filter-low-stock');
    expect(chip).toBeDisabled();
    fireEvent.click(chip);
    expect(onToggle).not.toHaveBeenCalled();
  });
});
