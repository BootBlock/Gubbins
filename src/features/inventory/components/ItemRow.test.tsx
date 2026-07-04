import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, fireEvent, render, screen, cleanup } from '@testing-library/react';
import type { Item } from '@/db/repositories';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';
import { ItemDragProvider } from '../item-drag';

// Capture the imperative `open` the row drives on a body click (the cardClickAction shortcut).
const { openSpy } = vi.hoisted(() => ({ openSpy: vi.fn() }));

/**
 * Light render tests for the Data-Heavy {@link ItemRow}. As with ItemCard, the heavy
 * children (action row, ± stepper, gauge ring) and the formatters are stubbed so this
 * exercises the row's own drag-source wiring and its per-tracking-mode value branches. The
 * pointer-drag machinery itself is covered end-to-end by item-drag.test.tsx.
 */

// Forward the ref (the row opens a dialog through it) and expose an inner button so the
// interactive-origin guard on the body click can be exercised.
vi.mock('./ItemActions', async () => {
  const { forwardRef, useImperativeHandle } = await import('react');
  return {
    ItemActions: forwardRef((_props: unknown, ref: React.Ref<{ open: (kind: string) => void }>) => {
      useImperativeHandle(ref, () => ({ open: openSpy }), []);
      return (
        <div data-testid="item-actions">
          <button type="button" aria-label="inner-action">
            act
          </button>
        </div>
      );
    }),
  };
});
vi.mock('./QuantityStepper', () => ({
  QuantityStepper: ({ quantity }: { quantity: number }) => (
    <div data-testid="quantity-stepper">{quantity}</div>
  ),
}));
vi.mock('./GaugeBar', () => ({
  GaugeBar: () => <div data-testid="gauge-bar" />,
  GaugeRing: () => <div data-testid="gauge-ring" />,
}));
vi.mock('@/lib/useFormatters', () => ({
  useFormatters: () => ({
    quantity: (n: number) => String(n),
    measure: (n: number, unit: string) => `${n} ${unit}`,
  }),
}));

import { ItemRow } from './ItemRow';

const BASE: Item = {
  id: 'item-1',
  name: 'NE555 timer',
  description: null,
  notes: null,
  locationId: 'loc-1',
  categoryId: null,
  trackingMode: 'DISCRETE',
  quantity: 12,
  serialNo: null,
  mpn: null,
  manufacturer: null,
  barcode: null,
  unitCost: null,
  expiryDate: null,
  batchNumber: null,
  lotNumber: null,
  condition: null,
  parentId: null,
  isUnlimited: false,
  reorderPoint: null,
  reorderGaugePercent: null,
  reorderQty: null,
  acquiredAt: null,
  warrantyExpiresAt: null,
  purchasePrice: null,
  depreciationMonths: null,
  isActive: true,
  createdAt: 0,
  updatedAt: 0,
  gauge: null,
  operationalMetadata: null,
};
const makeItem = (overrides: Partial<Item> = {}): Item => ({ ...BASE, ...overrides });

function renderRow(item: Item, extra: Partial<React.ComponentProps<typeof ItemRow>> = {}) {
  return render(<ItemRow item={item} locations={[]} locationName="Workshop" {...extra} />);
}

/** Dispatch a fully-populated pointer event (happy-dom's PointerEvent is partial). */
function firePointer(
  target: EventTarget,
  type: 'pointerdown' | 'pointermove',
  init: { x?: number; y?: number } = {},
) {
  const { x = 0, y = 0 } = init;
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(event, { clientX: x, clientY: y, pointerType: 'mouse', pointerId: 1, button: 0 });
  act(() => {
    target.dispatchEvent(event);
  });
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  openSpy.mockClear();
  usePreferencesStore.setState({ cardClickAction: 'none' });
});

describe('ItemRow — content branches', () => {
  it('renders the name, location and the ± stepper for an active DISCRETE item, with drag affordance', () => {
    const { container } = renderRow(makeItem());
    expect(screen.getByText('NE555 timer')).not.toBeNull();
    expect(screen.getByText('Workshop')).not.toBeNull();
    expect(screen.getByTestId('quantity-stepper')).not.toBeNull();
    // Drag source (select-none), but no hover grab-hand: grabbing is press-only (`:active`).
    // Exact class tokens via `classList` (`cursor-grab` is a substring of `cursor-grabbing`).
    const root = container.firstElementChild!;
    expect(root.classList.contains('cursor-grab')).toBe(false);
    expect(root.classList.contains('select-none')).toBe(true);
    expect(root.classList.contains('active:cursor-grabbing')).toBe(true);
  });

  it('shows a static quantity (no stepper) for an archived item', () => {
    renderRow(makeItem({ isActive: false, quantity: 9 }));
    expect(screen.queryByTestId('quantity-stepper')).toBeNull();
    expect(screen.getByText('9')).not.toBeNull();
  });

  it('shows "1 unit" for a serialised item', () => {
    renderRow(makeItem({ trackingMode: 'SERIALISED', serialNo: 3 }));
    expect(screen.getByText('1 unit')).not.toBeNull();
    expect(screen.queryByTestId('quantity-stepper')).toBeNull();
  });

  it('shows "Not counted" for an untracked item', () => {
    renderRow(makeItem({ trackingMode: 'UNTRACKED' }));
    expect(screen.getByText('Not counted')).not.toBeNull();
  });

  it('renders the measured amount and gauge ring for a consumable item', () => {
    renderRow(
      makeItem({
        trackingMode: 'CONSUMABLE_GAUGE',
        gauge: {
          unitOfMeasure: 'g',
          grossCapacity: 1000,
          tareWeight: 250,
          currentNetValue: 500,
          percentageRemaining: 50,
          currentGrossWeight: 750,
        },
      }),
    );
    expect(screen.getByText('500 g')).not.toBeNull();
    expect(screen.getByTestId('gauge-ring')).not.toBeNull();
  });

  it('shows the ∞ glyph for an unlimited-supply item', () => {
    renderRow(makeItem({ isUnlimited: true }));
    expect(screen.getByLabelText('Unlimited supply')).not.toBeNull();
    expect(screen.queryByTestId('quantity-stepper')).toBeNull();
  });

  it('renders a selection checkbox reflecting the selected state', () => {
    renderRow(makeItem(), { selection: { onToggle: vi.fn() }, selected: true });
    const checkbox = screen.getByRole('checkbox', { name: 'Select NE555 timer' }) as HTMLInputElement;
    expect(checkbox.checked).toBe(true);
  });
});

describe('ItemRow — click-to-act (cardClickAction)', () => {
  it('does nothing and shows no pointer cursor when the action is "none" (default)', () => {
    const { container } = renderRow(makeItem());
    const root = container.firstElementChild as HTMLElement;
    expect(root.className).not.toContain('cursor-pointer');
    fireEvent.click(root);
    expect(openSpy).not.toHaveBeenCalled();
  });

  it('opens the chosen dialog on a body click and shows a pointer cursor when an action is set', () => {
    usePreferencesStore.setState({ cardClickAction: 'qr' });
    const { container } = renderRow(makeItem());
    const root = container.firstElementChild as HTMLElement;
    expect(root.className).toContain('cursor-pointer');
    fireEvent.click(root);
    expect(openSpy).toHaveBeenCalledWith('qr');
  });

  it('ignores a click that originates on an interactive control', () => {
    usePreferencesStore.setState({ cardClickAction: 'details' });
    renderRow(makeItem());
    fireEvent.click(screen.getByLabelText('inner-action'));
    expect(openSpy).not.toHaveBeenCalled();
  });

  it('suppresses the click action during batch selection', () => {
    usePreferencesStore.setState({ cardClickAction: 'details' });
    const { container } = renderRow(makeItem(), { selection: { onToggle: vi.fn() } });
    const root = container.firstElementChild as HTMLElement;
    expect(root.className).not.toContain('cursor-pointer');
    fireEvent.click(root);
    expect(openSpy).not.toHaveBeenCalled();
  });
});

describe('ItemRow — drag-source wiring', () => {
  it('begins a pointer drag from the row root, mounting the floating preview', () => {
    const { container } = render(
      <ItemDragProvider>
        <ItemRow item={makeItem()} locations={[]} locationName="Workshop" />
      </ItemDragProvider>,
    );
    const root = container.querySelector('.select-none')!;

    firePointer(root, 'pointerdown', { x: 10, y: 10 });
    firePointer(window, 'pointermove', { x: 40, y: 40 });

    expect(screen.getByTestId('item-drag-preview')).toHaveTextContent('NE555 timer');
  });
});
