/**
 * Behaviour tests for {@link ItemPicker} — the shared item picker (issue #484).
 *
 * The defect it exists to fix is a picker that reads a fixed first page of the catalogue and
 * offers it as the whole choice, so these pin the two things that make it not do that: the typed
 * text reaches the *search* read rather than filtering rows already in hand, and the control says
 * how much it is not showing. The rest is the id ↔ label contract the callers depend on.
 */
import { useState } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import type { Item } from '@/db/repositories';

const h = vi.hoisted(() => ({
  /** What the browse read (empty box) answers with, and whether it says more rows exist. */
  browse: { rows: [] as Item[], hasMore: false },
  /** What the relevance read (typed query) answers with — rows plus the whole match count. */
  relevance: { rows: [] as Item[], total: 0 },
  /** Every (search, limit, enabled, includeInactive) the relevance read was asked for. */
  searches: [] as { search: string; limit: number; enabled: boolean; includeInactive: boolean }[],
  /** Every filter the browse read was asked for. */
  browsed: [] as { filters: unknown; enabled: boolean }[],
  /** The catalogue an externally-set id resolves against. */
  byId: new Map<string, Item>(),
}));

vi.mock('../queries', () => ({
  useInventoryItems: (filters: unknown, _limit: number, enabled = true) => {
    h.browsed.push({ filters, enabled });
    return { data: enabled ? { pages: [h.browse] } : undefined };
  },
  useItemRelevanceSearch: (search: string, limit: number, enabled = true, includeInactive = false) => {
    h.searches.push({ search, limit, enabled, includeInactive });
    return { data: enabled ? h.relevance : undefined };
  },
  useItem: (id?: string) => ({ data: id === undefined ? undefined : h.byId.get(id) }),
}));

import { ItemPicker } from './ItemPicker';

const item = (id: string, name: string, o: Partial<Item> = {}): Item =>
  ({ id, name, serialNo: null, ...o }) as Item;

/** A controlled harness, so the value the picker reports is the value it is then given back. */
function Harness(rest: { exclude?: ReadonlySet<string>; includeInactive?: boolean } = {}) {
  const [value, setValue] = useState<string | null>(null);
  return <ItemPicker label="Item" value={value} onChange={(id) => setValue(id)} {...rest} />;
}

const box = () => screen.getByRole('combobox', { name: 'Item' }) as HTMLInputElement;
const status = () => screen.queryByTestId('item-picker-status');

beforeEach(() => {
  h.browse = { rows: [], hasMore: false };
  h.relevance = { rows: [], total: 0 };
  h.searches = [];
  h.browsed = [];
  h.byId = new Map();
});
afterEach(cleanup);

describe('ItemPicker — what it reads', () => {
  it('browses the first page while the box is empty, and does not search', () => {
    h.browse = { rows: [item('a', 'Bolt')], hasMore: false };
    render(<Harness />);
    fireEvent.click(box());

    expect(screen.getByRole('option', { name: 'Bolt' })).toBeInTheDocument();
    expect(h.searches.every((s) => !s.enabled)).toBe(true);
  });

  it('sends the typed text to the search read rather than filtering the page in hand', () => {
    // The whole point of the issue: a "Zener diode" that sorts past the first page is reachable
    // only if the query goes to the database. Rows already in hand could never contain it.
    h.relevance = { rows: [item('z', 'Zener diode')], total: 1 };
    render(<Harness />);
    fireEvent.change(box(), { target: { value: 'zener' } });

    const live = h.searches.filter((s) => s.enabled);
    expect(live.at(-1)?.search).toBe('zener');
    expect(screen.getByRole('option', { name: 'Zener diode' })).toBeInTheDocument();
    // …and the browse read is off while a query is being answered, so only one read is in flight.
    expect(h.browsed.at(-1)?.enabled).toBe(false);
  });

  it('offers decommissioned items only when asked to', () => {
    render(<Harness includeInactive />);
    fireEvent.change(box(), { target: { value: 'zener' } });
    expect(h.searches.at(-1)?.includeInactive).toBe(true);
    expect(h.browsed.some((b) => (b.filters as { includeInactive?: boolean }).includeInactive)).toBe(true);
  });

  it('leaves out the excluded ids', () => {
    h.browse = { rows: [item('a', 'Bolt'), item('b', 'Nut')], hasMore: false };
    render(<Harness exclude={new Set(['a'])} />);
    fireEvent.click(box());

    expect(screen.queryByRole('option', { name: 'Bolt' })).toBeNull();
    expect(screen.getByRole('option', { name: 'Nut' })).toBeInTheDocument();
  });
});

describe('ItemPicker — what it reports', () => {
  it('reports the chosen row’s id, and the row itself', () => {
    h.browse = { rows: [item('b', 'Nut')], hasMore: false };
    const onChange = vi.fn();
    render(<ItemPicker label="Item" value={null} onChange={onChange} />);
    fireEvent.click(box());
    fireEvent.mouseDown(screen.getByRole('option', { name: 'Nut' }));

    expect(onChange).toHaveBeenCalledWith('b', expect.objectContaining({ id: 'b' }));
  });

  it('reports null once the text stops naming a row, and keeps the typed text', () => {
    h.browse = { rows: [item('b', 'Nut')], hasMore: false };
    const onChange = vi.fn();
    const { rerender } = render(<ItemPicker label="Item" value={null} onChange={onChange} />);
    fireEvent.click(box());
    fireEvent.mouseDown(screen.getByRole('option', { name: 'Nut' }));
    rerender(<ItemPicker label="Item" value="b" onChange={onChange} />);

    onChange.mockClear();
    fireEvent.change(box(), { target: { value: 'Nu' } });

    expect(onChange).toHaveBeenCalledWith(null, undefined);
    // The value going back to null must not be mistaken for the caller clearing the box —
    // that would wipe the very text being typed.
    expect(box().value).toBe('Nu');
  });

  it('empties the box when the caller clears the value — the reset after a successful add', () => {
    h.browse = { rows: [item('b', 'Nut')], hasMore: false };
    const { rerender } = render(<ItemPicker label="Item" value="b" onChange={vi.fn()} />);
    fireEvent.click(box());
    fireEvent.mouseDown(screen.getByRole('option', { name: 'Nut' }));
    expect(box().value).toBe('Nut');

    rerender(<ItemPicker label="Item" value="" onChange={vi.fn()} />);
    expect(box().value).toBe('');
  });

  it('does not search for the label it just wrote in the box', async () => {
    // The box's text doubles as the search box, and a decorated label ("· Serialised — no stock
    // movement") matches nothing — so searching for it would answer a successful choice by
    // announcing that nothing matches it, and empty the list.
    const decorated = (i: Item) => `${i.name} · Serialised — no stock movement`;
    h.browse = { rows: [item('b', 'Nut')], hasMore: false };
    h.byId.set('b', item('b', 'Nut'));
    const { rerender } = render(
      <ItemPicker label="Item" value={null} onChange={vi.fn()} labelFor={decorated} />,
    );
    fireEvent.click(box());
    fireEvent.mouseDown(screen.getByRole('option', { name: /Nut/ }));
    rerender(<ItemPicker label="Item" value="b" onChange={vi.fn()} labelFor={decorated} />);

    expect(box().value).toBe('Nut · Serialised — no stock movement');
    await waitFor(() => expect(status()).toBeNull());
    // No query was ever run for that text — the relevance read stayed disabled throughout.
    expect(h.searches.filter((q) => q.enabled)).toEqual([]);
  });

  it('names an item the caller chose elsewhere — a remembered export target', () => {
    h.byId.set('r', item('r', 'Remembered part'));
    render(<ItemPicker label="Item" value="r" onChange={vi.fn()} />);
    expect(box().value).toBe('Remembered part');
  });
});

describe('ItemPicker — saying what it is not showing', () => {
  it('says how many matches are beyond the ones offered', async () => {
    h.relevance = { rows: [item('a', 'Bolt')], total: 143 };
    render(<Harness />);
    fireEvent.change(box(), { target: { value: 'bo' } });
    await waitFor(() => expect(status()?.textContent).toContain('143'));
  });

  it('says the browse is only the first page of the catalogue', async () => {
    h.browse = { rows: [item('a', 'Bolt')], hasMore: true };
    render(<Harness />);
    await waitFor(() => expect(status()?.textContent).toMatch(/first 1 items/));
  });

  it('counts what the search returned, not what survived the exclusions', async () => {
    // Hiding the item being edited must not be reported as matches left unshown: no amount of
    // further typing would ever reveal them.
    h.relevance = { rows: [item('a', 'Bolt'), item('b', 'Bolt clip')], total: 2 };
    render(<Harness exclude={new Set(['a'])} />);
    fireEvent.change(box(), { target: { value: 'bolt' } });
    await waitFor(() => expect(screen.getByRole('option', { name: 'Bolt clip' })).toBeInTheDocument());
    expect(status()).toBeNull();
  });

  it('says so when a query matches nothing', async () => {
    h.relevance = { rows: [], total: 0 };
    render(<Harness />);
    fireEvent.change(box(), { target: { value: 'nothing like this' } });
    await waitFor(() => expect(status()?.textContent).toContain('nothing like this'));
  });

  it('stays quiet when everything that matches is on offer', async () => {
    h.browse = { rows: [item('a', 'Bolt')], hasMore: false };
    render(<Harness />);
    expect(status()).toBeNull();

    h.relevance = { rows: [item('a', 'Bolt')], total: 1 };
    fireEvent.change(box(), { target: { value: 'bolt' } });
    await waitFor(() => expect(screen.getByRole('option', { name: 'Bolt' })).toBeInTheDocument());
    expect(status()).toBeNull();
  });
});
