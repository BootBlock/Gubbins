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
        applicable={overrides.applicable}
        counts={overrides.counts}
        disabled={overrides.disabled}
      />,
    );
    return { onToggle, onClear };
  }

  it('shows every attention chip when all capabilities are enabled', () => {
    renderBar();
    for (const status of [
      'low-stock',
      'out-of-stock',
      'expiring',
      'warranty',
      'on-loan',
      'overdue',
      'maintenance-due',
    ]) {
      expect(screen.getByTestId(`inventory-filter-${status}`)).toBeInTheDocument();
    }
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

  it('drops the loan chips (On loan, Overdue) when Contacts is off', () => {
    useModulesStore.getState().setFeatureIntent('contacts', false);
    renderBar();
    expect(screen.queryByTestId('inventory-filter-overdue')).not.toBeInTheDocument();
    expect(screen.queryByTestId('inventory-filter-on-loan')).not.toBeInTheDocument();
    // Core stock chips stay regardless.
    expect(screen.getByTestId('inventory-filter-low-stock')).toBeInTheDocument();
    expect(screen.getByTestId('inventory-filter-out-of-stock')).toBeInTheDocument();
  });

  it('drops the Maintenance-due chip when Maintenance is off', () => {
    useModulesStore.getState().setFeatureIntent('maintenance', false);
    renderBar();
    expect(screen.queryByTestId('inventory-filter-maintenance-due')).not.toBeInTheDocument();
  });

  it('drops the Warranty chip when Warranty is off', () => {
    useModulesStore.getState().setFeatureIntent('warranty', false);
    renderBar();
    expect(screen.queryByTestId('inventory-filter-warranty')).not.toBeInTheDocument();
  });

  it('drops the Expiring chip when Expiry tracking is off', () => {
    useModulesStore.getState().setFeatureIntent('perishables', false);
    renderBar();
    expect(screen.queryByTestId('inventory-filter-expiring')).not.toBeInTheDocument();
    // Core stock chips are unaffected.
    expect(screen.getByTestId('inventory-filter-low-stock')).toBeInTheDocument();
  });

  it('disables every chip while the Visual Builder supersedes the quick filters', () => {
    const { onToggle } = renderBar({ disabled: true });
    const chip = screen.getByTestId('inventory-filter-low-stock');
    expect(chip).toBeDisabled();
    fireEvent.click(chip);
    expect(onToggle).not.toHaveBeenCalled();
  });

  it('hides filters that currently match nothing (the applicable set)', () => {
    renderBar({ applicable: new Set<ItemStatusFilter>(['low-stock', 'expiring']) });
    expect(screen.getByTestId('inventory-filter-low-stock')).toBeInTheDocument();
    expect(screen.getByTestId('inventory-filter-expiring')).toBeInTheDocument();
    // Not in the applicable set and not active → hidden.
    expect(screen.queryByTestId('inventory-filter-overdue')).not.toBeInTheDocument();
    expect(screen.queryByTestId('inventory-filter-warranty')).not.toBeInTheDocument();
  });

  it('keeps an active filter visible even when it now matches nothing', () => {
    renderBar({
      value: new Set<ItemStatusFilter>(['overdue']),
      applicable: new Set<ItemStatusFilter>(['low-stock']),
    });
    // Active but not applicable → still shown, so it can be switched off.
    expect(screen.getByTestId('inventory-filter-overdue')).toBeInTheDocument();
    expect(screen.getByTestId('inventory-filter-low-stock')).toBeInTheDocument();
    expect(screen.queryByTestId('inventory-filter-expiring')).not.toBeInTheDocument();
  });

  it('shows every enabled chip while applicability is still unknown', () => {
    renderBar({ applicable: undefined });
    expect(screen.getByTestId('inventory-filter-overdue')).toBeInTheDocument();
    expect(screen.getByTestId('inventory-filter-warranty')).toBeInTheDocument();
  });

  it('renders no bar when nothing is applicable and nothing is active', () => {
    renderBar({ applicable: new Set<ItemStatusFilter>() });
    expect(screen.queryByTestId('inventory-filter-bar')).not.toBeInTheDocument();
  });

  it('gives each chip a Foundry tooltip, not a plain title attribute', () => {
    renderBar();
    const chip = screen.getByTestId('inventory-filter-low-stock');
    expect(chip).not.toHaveAttribute('title');
    // The Foundry Tooltip wraps the control in a describedby-capable trigger.
    expect(chip.closest('span')).toBeTruthy();
  });

  it('shows the match count in a chip label once known', () => {
    renderBar({ counts: new Map<ItemStatusFilter, number>([['out-of-stock', 8]]) });
    expect(screen.getByTestId('inventory-filter-out-of-stock')).toHaveTextContent('Out of stock (8)');
  });

  it('renders a chip label with no count while counts are still unknown', () => {
    renderBar();
    expect(screen.getByTestId('inventory-filter-low-stock')).toHaveTextContent('Low stock');
    expect(screen.getByTestId('inventory-filter-low-stock')).not.toHaveTextContent('(');
  });
});
