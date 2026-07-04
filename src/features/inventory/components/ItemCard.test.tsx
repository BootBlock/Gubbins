import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, render, screen, cleanup } from '@testing-library/react';
import type { Item } from '@/db/repositories';
import { ItemDragProvider } from '../item-drag';

/**
 * Light render tests for the Visual-Heavy {@link ItemCard}. The heavy children (the action
 * row and its dialogs, the ± stepper, the gauge, the thumbnail and the discrete hero) are
 * stubbed to inert markers so this exercises the card's own wiring: the drag-source props it
 * spreads (per the [[component-test-gotchas]] guidance), and its per-tracking-mode hero
 * branches. The pointer-drag machinery itself is covered end-to-end by item-drag.test.tsx.
 */

vi.mock('./ItemActions', () => ({ ItemActions: () => <div data-testid="item-actions" /> }));
vi.mock('./QuantityStepper', () => ({
  QuantityStepper: ({ quantity }: { quantity: number }) => (
    <div data-testid="quantity-stepper">{quantity}</div>
  ),
}));
vi.mock('./DiscreteCardMetric', () => ({
  DiscreteCardMetric: () => <div data-testid="discrete-card-metric" />,
}));
vi.mock('./GaugeBar', () => ({
  GaugeBar: () => <div data-testid="gauge-bar" />,
  GaugeRing: () => <div data-testid="gauge-ring" />,
}));
vi.mock('./Thumbnail', () => ({
  Thumbnail: ({ alt }: { alt: string }) => <img data-testid="thumbnail" alt={alt} />,
}));

import { ItemCard } from './ItemCard';

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

function renderCard(item: Item, extra: Partial<React.ComponentProps<typeof ItemCard>> = {}) {
  return render(<ItemCard item={item} locations={[]} locationName="Workshop" {...extra} />);
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
});

describe('ItemCard — content branches', () => {
  it('renders the name, location and a plain DISCRETE hero with the ± stepper', () => {
    const { container } = renderCard(makeItem());
    expect(screen.getByRole('heading', { name: /NE555 timer/ })).not.toBeNull();
    expect(screen.getByText('Workshop')).not.toBeNull();
    expect(screen.getByTestId('discrete-card-metric')).not.toBeNull();
    expect(screen.getByTestId('quantity-stepper')).not.toBeNull();
    // The root is a drag source: the unified pointer path needs select-none + grab affordance.
    const root = container.firstElementChild!;
    expect(root.className).toContain('cursor-grab');
    expect(root.className).toContain('select-none');
  });

  it('appends the serial number to the heading when present', () => {
    renderCard(makeItem({ trackingMode: 'SERIALISED', serialNo: 7 }));
    expect(screen.getByRole('heading', { name: /NE555 timer #7/ })).not.toBeNull();
    // A serialised unit shows a descriptive hero, never the ± stepper.
    expect(screen.getByText('Single serialised unit')).not.toBeNull();
    expect(screen.queryByTestId('quantity-stepper')).toBeNull();
  });

  it('shows the untracked hero for a presence-only item', () => {
    renderCard(makeItem({ trackingMode: 'UNTRACKED' }));
    expect(screen.getByText('Presence only — not counted')).not.toBeNull();
    expect(screen.queryByTestId('quantity-stepper')).toBeNull();
  });

  it('shows the gauge hero for a consumable item', () => {
    renderCard(
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
    expect(screen.getByTestId('gauge-bar')).not.toBeNull();
    expect(screen.queryByTestId('discrete-card-metric')).toBeNull();
  });

  it('shows the ∞ hero and no stepper for an unlimited-supply item', () => {
    renderCard(makeItem({ isUnlimited: true }));
    expect(screen.getByLabelText('Unlimited supply')).not.toBeNull();
    expect(screen.getByText('unlimited supply')).not.toBeNull();
    expect(screen.queryByTestId('quantity-stepper')).toBeNull();
  });

  it('renders a selection checkbox and marks the card selected when in select mode', () => {
    renderCard(makeItem(), { selection: { onToggle: vi.fn() }, selected: true });
    const checkbox = screen.getByRole('checkbox', { name: 'Select NE555 timer' }) as HTMLInputElement;
    expect(checkbox.checked).toBe(true);
  });
});

describe('ItemCard — drag-source wiring', () => {
  it('begins a pointer drag from the card root, mounting the floating preview', () => {
    const { container } = render(
      <ItemDragProvider>
        <ItemCard item={makeItem()} locations={[]} locationName="Workshop" />
      </ItemDragProvider>,
    );
    const root = container.querySelector('.cursor-grab')!;

    // A press on the card, then a move past the mouse activation threshold, arms the drag —
    // proving the card's onPointerDown is wired into the drag provider.
    firePointer(root, 'pointerdown', { x: 10, y: 10 });
    firePointer(window, 'pointermove', { x: 40, y: 40 });

    expect(screen.getByTestId('item-drag-preview')).toHaveTextContent('NE555 timer');
  });
});
