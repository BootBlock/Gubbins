import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, fireEvent, render, screen, cleanup } from '@testing-library/react';
import type { Item } from '@/db/repositories';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';
import { ItemDragProvider, useLocationRowDrop } from '../item-drag';
import { RARITY_IDS, itemRarity } from '../rarity';

// Capture the imperative `open` the card drives on a body click (the cardClickAction shortcut).
const { openSpy } = vi.hoisted(() => ({ openSpy: vi.fn() }));

/**
 * Light render tests for the Visual-Heavy {@link ItemCard}. The heavy children (the action
 * row and its dialogs, the ± stepper, the gauge, the thumbnail and the discrete hero) are
 * stubbed to inert markers so this exercises the card's own wiring: the drag-source props it
 * spreads (per the [[component-test-gotchas]] guidance), and its per-tracking-mode hero
 * branches. The pointer-drag machinery itself is covered end-to-end by item-drag.test.tsx.
 */

// Forward the ref (the card opens a dialog through it) and expose an inner button so the
// interactive-origin guard on the body click can be exercised. It also renders a *portaled*
// element (as the card's real dialogs do via the Modal's createPortal) carrying a
// `role="combobox"` — a click on it bubbles here through the React tree but is not inside the
// card's DOM, mirroring the Move dialog's Location combobox.
vi.mock('./ItemActions', async () => {
  const { forwardRef, useImperativeHandle } = await import('react');
  const { createPortal } = await import('react-dom');
  return {
    ItemActions: forwardRef((_props: unknown, ref: React.Ref<{ open: (kind: string) => void }>) => {
      useImperativeHandle(ref, () => ({ open: openSpy }), []);
      return (
        <div data-testid="item-actions">
          <button type="button" aria-label="inner-action">
            act
          </button>
          {createPortal(
            <div role="combobox" data-testid="portaled-dialog-combobox">
              Location
            </div>,
            document.body,
          )}
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
  isFavourite: false,
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

/** Scan short synthetic names for the first that satisfies `pred` (both cases exist well within). */
function firstName(pred: (name: string) => boolean): string {
  for (let i = 0; i < 100000; i++) {
    const name = `Probe ${i}`;
    if (pred(name)) return name;
  }
  throw new Error('no matching name found');
}

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
  openSpy.mockClear();
  usePreferencesStore.setState({ cardClickAction: 'none' });
});

describe('ItemCard — content branches', () => {
  it('renders the name, location and a plain DISCRETE hero with the ± stepper', () => {
    const { container } = renderCard(makeItem());
    expect(screen.getByRole('heading', { name: /NE555 timer/ })).not.toBeNull();
    expect(screen.getByText('Workshop')).not.toBeNull();
    expect(screen.getByTestId('discrete-card-metric')).not.toBeNull();
    expect(screen.getByTestId('quantity-stepper')).not.toBeNull();
    // The root is a drag source needing select-none, but shows no hover grab-hand: the grabbing
    // cursor is press-only (`:active`), so it appears only while actively dragging. (Exact class
    // tokens — `cursor-grabbing` is a substring of nothing here, but `classList` avoids the trap.)
    const root = container.firstElementChild!;
    expect(root.classList.contains('cursor-grab')).toBe(false);
    expect(root.classList.contains('select-none')).toBe(true);
    expect(root.classList.contains('active:cursor-grabbing')).toBe(true);
    // F5 spotlight ring: the card carries the focal-card class. The ring is CSS-only and
    // scoped to `:hover`/`:focus-within` (invisible/paused at rest), so exactly one card is
    // ever lit; its rotation + reduced-motion static fallback are verified against the real
    // built CSS (no runtime motion logic to assert here).
    expect(root.classList.contains('gubbins-spotlight-border')).toBe(true);
  });

  it('wires the collector-card frame only on the ~5% of items that are collectors — no badge on the card', () => {
    // Collector status is a stable hash of the item name; pick one of each deterministically so the
    // test never depends on a hand-computed hash. On the card, a collector carries the frame wiring
    // (the `gubbins-rarity` class + a `data-rarity` tier); the rarity gem badge itself lives in the
    // detail dialog, never on the card face.
    const collectorName = firstName((n) => itemRarity(makeItem({ name: n })) != null);
    const ordinaryName = firstName((n) => itemRarity(makeItem({ name: n })) == null);

    const { container } = renderCard(makeItem({ name: collectorName }));
    const root = container.firstElementChild as HTMLElement;
    expect(root.classList.contains('gubbins-rarity')).toBe(true);
    expect(RARITY_IDS).toContain(root.dataset.rarity);
    // The gem badge is NOT rendered on the card any more.
    expect(container.querySelector('[data-testid="rarity-badge"]')).toBeNull();

    // A non-collector item carries no rarity wiring at all.
    const { container: plain } = renderCard(makeItem({ name: ordinaryName }));
    const plainRoot = plain.firstElementChild as HTMLElement;
    expect(plainRoot.classList.contains('gubbins-rarity')).toBe(false);
    expect(plainRoot.dataset.rarity).toBeUndefined();
  });

  it('paints the per-location edge tint (F10) on the root only when a tint class is given', () => {
    const { container: tinted } = renderCard(makeItem(), {
      locationTintClass: 'gubbins-loc-tint loc-tint-teal',
    });
    const tintedRoot = tinted.firstElementChild!;
    expect(tintedRoot.classList.contains('gubbins-loc-tint')).toBe(true);
    expect(tintedRoot.classList.contains('loc-tint-teal')).toBe(true);

    // An uncoloured / unassigned location passes no class, so the card stays a neutral surface.
    const { container: plain } = renderCard(makeItem());
    expect(plain.firstElementChild!.classList.contains('gubbins-loc-tint')).toBe(false);
  });

  it('shows the manufacturer as a subtitle under the name only when the item has one (issue #107)', () => {
    const { container } = renderCard(makeItem({ manufacturer: 'Texas Instruments' }));
    const heading = screen.getByRole('heading', { name: /NE555 timer/ });
    const subtitle = heading.nextElementSibling;
    expect(subtitle?.textContent).toBe('Texas Instruments');

    // No manufacturer → no subtitle line (the heading has no following sibling in that block).
    cleanup();
    const { container: plain } = renderCard(makeItem({ manufacturer: null }));
    expect(plain.textContent).not.toContain('Texas Instruments');
    const plainHeading = screen.getByRole('heading', { name: /NE555 timer/ });
    expect(plainHeading.nextElementSibling).toBeNull();
    void container;
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

  it('shows the favourite watermark + an sr-only label only for a favourited item', () => {
    const { container } = renderCard(makeItem({ isFavourite: true }));
    // The decorative watermark is aria-hidden and clipped to the card corner.
    expect(container.querySelector('[aria-hidden="true"].overflow-hidden')).not.toBeNull();
    // Assistive tech still hears "Favourite" via the sr-only label.
    expect(screen.getByText('Favourite', { selector: '.sr-only' })).toBeInTheDocument();

    // A non-favourite card carries neither.
    cleanup();
    const { container: plain } = renderCard(makeItem({ isFavourite: false }));
    expect(plain.querySelector('[aria-hidden="true"].overflow-hidden')).toBeNull();
    expect(screen.queryByText('Favourite', { selector: '.sr-only' })).toBeNull();
  });

  it('paints the category glyph watermark when a glyph is supplied (issue #83)', () => {
    const { container } = renderCard(makeItem(), { categoryGlyph: '🔋' });
    // The decorative watermark is aria-hidden; assert its glyph is present in the DOM.
    expect(container.textContent).toContain('🔋');
  });

  it('omits the category glyph watermark when none is supplied (issue #83)', () => {
    const { container } = renderCard(makeItem());
    expect(container.textContent).not.toContain('🔋');
  });

  it('renders a selection checkbox and marks the card selected when in select mode', () => {
    renderCard(makeItem(), { selection: { onToggle: vi.fn() }, selected: true });
    const checkbox = screen.getByRole('checkbox', { name: 'Select NE555 timer' }) as HTMLInputElement;
    expect(checkbox.checked).toBe(true);
  });

  it('renders the configured card fields (E1): condition, total value and a custom field', () => {
    const customFields = new Map([
      [
        'f1',
        {
          id: 'f1',
          categoryId: 'cat',
          name: 'Voltage',
          fieldType: 'TEXT',
          defaultValue: null,
          unit: null,
          precision: null,
        },
      ],
    ]);
    renderCard(makeItem({ categoryId: 'cat', condition: 'GOOD', unitCost: 2, quantity: 3 }), {
      fieldOrder: ['condition', 'value', 'custom:f1'],
      categoryName: 'Resistors',
      customFields,
      customValues: new Map([['f1', '5V']]),
    });
    // Field labels (dt) and their resolved values (dd).
    expect(screen.getByText('Condition')).toBeInTheDocument();
    expect(screen.getByText('Good')).toBeInTheDocument();
    expect(screen.getByText('Total value')).toBeInTheDocument();
    expect(screen.getByText('Voltage')).toBeInTheDocument();
    expect(screen.getByText('5V')).toBeInTheDocument();
  });

  it('renders an em-dash for an inapplicable custom field so every card keeps one row per field', () => {
    const customFields = new Map([
      [
        'f1',
        {
          id: 'f1',
          categoryId: 'cat',
          name: 'Voltage',
          fieldType: 'TEXT',
          defaultValue: null,
          unit: null,
          precision: null,
        },
      ],
    ]);
    // The item is in a *different* category, so its Voltage field is not applicable.
    renderCard(makeItem({ categoryId: 'other' }), {
      fieldOrder: ['custom:f1'],
      customFields,
      customValues: undefined,
    });
    expect(screen.getByText('Voltage')).toBeInTheDocument();
    expect(screen.getByText('—')).toBeInTheDocument();
  });
});

describe('ItemCard — click-to-act (cardClickAction)', () => {
  it('does nothing and shows no pointer cursor when the action is "none" (opt-out)', () => {
    usePreferencesStore.setState({ cardClickAction: 'none' });
    const { container } = renderCard(makeItem());
    const root = container.firstElementChild as HTMLElement;
    expect(root.className).not.toContain('cursor-pointer');
    fireEvent.click(root);
    expect(openSpy).not.toHaveBeenCalled();
  });

  it('opens item details on a body click by default (and shows a pointer cursor)', () => {
    // 'details' is the default (asserted in settings.test.ts); set explicitly for isolation.
    usePreferencesStore.setState({ cardClickAction: 'details' });
    const { container } = renderCard(makeItem());
    const root = container.firstElementChild as HTMLElement;
    expect(root.className).toContain('cursor-pointer');
    fireEvent.click(root);
    expect(openSpy).toHaveBeenCalledWith('details');
  });

  it('ignores a click that originates on an interactive control', () => {
    usePreferencesStore.setState({ cardClickAction: 'move' });
    renderCard(makeItem());
    fireEvent.click(screen.getByLabelText('inner-action'));
    expect(openSpy).not.toHaveBeenCalled();
  });

  it('suppresses the click action during batch selection', () => {
    usePreferencesStore.setState({ cardClickAction: 'details' });
    const { container } = renderCard(makeItem(), { selection: { onToggle: vi.fn() } });
    const root = container.firstElementChild as HTMLElement;
    expect(root.className).not.toContain('cursor-pointer');
    fireEvent.click(root);
    expect(openSpy).not.toHaveBeenCalled();
  });

  it('ignores a click that bubbled from a portaled dialog (e.g. the Move dialog combobox)', () => {
    // Regression: a card dialog (Move/details/label) renders in a portal, so a click on its
    // Location combobox bubbles to the card through the React tree. It must NOT re-fire the card
    // action (which would pop the details dialog on top). The combobox is a role="combobox", which
    // the interactive-origin guard deliberately doesn't match — only the DOM-containment check saves it.
    usePreferencesStore.setState({ cardClickAction: 'details' });
    renderCard(makeItem());
    fireEvent.click(screen.getByTestId('portaled-dialog-combobox'));
    expect(openSpy).not.toHaveBeenCalled();
  });
});

/**
 * A location row to drop onto. The real screen always has the tree mounted beside the list, and
 * the provider refuses to arm a drag while nothing is registered as a target (issue #147) — so a
 * card alone in a provider is a state that can't occur, and wouldn't prove the wiring.
 */
function DropRow() {
  useLocationRowDrop('loc-1', { onDropItem: () => {} });
  return <div data-tree-id="loc-1" />;
}

describe('ItemCard — drag-source wiring', () => {
  it('begins a pointer drag from the card root, mounting the floating preview', () => {
    const { container } = render(
      <ItemDragProvider>
        <DropRow />
        <ItemCard item={makeItem()} locations={[]} locationName="Workshop" />
      </ItemDragProvider>,
    );
    const root = container.querySelector('.select-none')!;

    // A press on the card, then a move past the mouse activation threshold, arms the drag —
    // proving the card's onPointerDown is wired into the drag provider.
    firePointer(root, 'pointerdown', { x: 10, y: 10 });
    firePointer(window, 'pointermove', { x: 40, y: 40 });

    expect(screen.getByTestId('item-drag-preview')).toHaveTextContent('NE555 timer');
  });
});

describe('ItemCard — crash containment (issue #313)', () => {
  /** An item whose `name` throws on read — stands in for a malformed row the card can't render. */
  function poisonedItem(): Item {
    const item = makeItem();
    Object.defineProperty(item, 'name', {
      get() {
        throw new Error('malformed item row');
      },
    });
    return item;
  }

  it('renders a placeholder card instead of letting the crash escape the list', () => {
    // React logs the caught error, as does the boundary itself — both are expected here.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { container } = render(
      <>
        <ItemCard item={poisonedItem()} locations={[]} locationName="Workshop" />
        <ItemCard item={makeItem({ id: 'item-2' })} locations={[]} locationName="Workshop" />
      </>,
    );

    // The broken card degrades to the inline stand-in…
    expect(screen.getByTestId('item-crashed')).toHaveTextContent('This item couldn’t be displayed.');
    // …and the healthy sibling beside it is untouched.
    expect(screen.getByRole('heading', { name: /NE555 timer/ })).not.toBeNull();
    expect(container.querySelectorAll('[data-testid="item-crashed"]')).toHaveLength(1);
  });
});
