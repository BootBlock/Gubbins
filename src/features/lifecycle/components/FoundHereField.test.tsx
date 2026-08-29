/**
 * Behaviour tests for {@link FoundHereField} — the count sheet's "I found something that isn't
 * listed" control (issue #640).
 *
 * What matters here is the decision the control makes on the way in, because the sheet has no
 * later chance to make it: an item joins the count as a quantity line or as a relocation
 * depending on how it is tracked, and an item the sheet cannot count at all must be refused with
 * a reason rather than added and rejected at authorisation. The picker's own reading of the
 * catalogue is covered in `ItemPicker.test.tsx`; the inventory queries behind it are stubbed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import type { Item } from '@/db/repositories';
import type { LocationCycleCount } from '../useLocationCycleCount';

const h = vi.hoisted(() => ({ rows: [] as Item[] }));

vi.mock('@/features/inventory/queries', () => ({
  useInventoryItems: (_filters: unknown, _limit: number, enabled = true) => ({
    data: enabled ? { pages: [{ rows: h.rows, hasMore: false }] } : undefined,
  }),
  useItemRelevanceSearch: (_search: string, _limit: number, enabled = true) => ({
    data: enabled ? { rows: h.rows, total: h.rows.length } : undefined,
  }),
  useItem: () => ({ data: undefined }),
}));

import { FoundHereField } from './FoundHereField';

const item = (id: string, name: string, o: Partial<Item> = {}): Item =>
  ({ id, name, serialNo: null, trackingMode: 'DISCRETE', isUnlimited: false, ...o }) as Item;

/** A count with nothing on its sheet, capturing whatever the field adds. */
function sheet(added: unknown[]): LocationCycleCount {
  return {
    lines: [],
    serialised: [],
    found: [],
    addFound: (entry: unknown) => added.push(entry),
  } as unknown as LocationCycleCount;
}

const box = () => screen.getByRole('combobox', { name: /Found something/ });

/** Open the list and choose the row named `name`. */
function pick(name: string) {
  fireEvent.click(box());
  fireEvent.mouseDown(screen.getByRole('option', { name }));
}

beforeEach(() => {
  h.rows = [];
});
afterEach(cleanup);

describe('FoundHereField — what a find becomes', () => {
  it('adds a bulk item as a DISCRETE find, so it joins the sheet as a count line', () => {
    h.rows = [item('a', 'Loose screws')];
    const added: unknown[] = [];
    render(<FoundHereField count={sheet(added)} />);

    pick('Loose screws');

    expect(added).toEqual([{ itemId: 'a', name: 'Loose screws', serialNo: null, mode: 'DISCRETE' }]);
  });

  it('adds a serialised unit as a SERIALISED find, whose correction is a move, not a count', () => {
    h.rows = [item('b', 'Multimeter', { trackingMode: 'SERIALISED', serialNo: 3 })];
    const added: unknown[] = [];
    render(<FoundHereField count={sheet(added)} />);

    pick('Multimeter #3');

    expect(added).toEqual([{ itemId: 'b', name: 'Multimeter', serialNo: 3, mode: 'SERIALISED' }]);
  });

  it('refuses an item the sheet has no way to count, and says why', () => {
    // Added silently, this would reach the repository and be thrown out there — a failed
    // authorisation for the whole location, explained by nothing the auditor did.
    h.rows = [item('c', 'Tap water', { trackingMode: 'UNTRACKED' })];
    const added: unknown[] = [];
    render(<FoundHereField count={sheet(added)} />);

    pick('Tap water');

    expect(added).toEqual([]);
    expect(screen.getByTestId('found-here-refused').textContent).toContain('Tap water');
  });

  it('refuses an unlimited item, which is never short of anything', () => {
    h.rows = [item('d', 'Mains air', { isUnlimited: true })];
    const added: unknown[] = [];
    render(<FoundHereField count={sheet(added)} />);

    pick('Mains air');

    expect(added).toEqual([]);
    expect(screen.getByTestId('found-here-refused').textContent).toContain('Mains air');
  });

  it('announces a refusal through a region that was already mounted', () => {
    // The message has to be announced when it appears rather than inserted along with its region,
    // or many screen readers say nothing at all (WCAG 4.1.3).
    h.rows = [item('c', 'Tap water', { trackingMode: 'UNTRACKED' })];
    const { container } = render(<FoundHereField count={sheet([])} />);
    const region = container.querySelector('[role="status"]');
    expect(region).not.toBeNull();

    pick('Tap water');

    expect(container.querySelector('[role="status"]')).toBe(region);
  });

  it('clears the box after a find, so the next one starts from an empty search', () => {
    h.rows = [item('a', 'Loose screws')];
    render(<FoundHereField count={sheet([])} />);

    pick('Loose screws');

    // The picker owns its own text, so a value reset alone would leave the chosen name sitting
    // in the box as though it were still the query.
    expect((box() as HTMLInputElement).value).toBe('');
  });
});

describe('FoundHereField — what it will not offer', () => {
  it('leaves out the untracked lots and instances the sheet already lists', () => {
    h.rows = [item('a', 'Loose screws'), item('b', 'Multimeter', { trackingMode: 'SERIALISED' })];
    const count = {
      lines: [{ key: 'a|', itemId: 'a', name: 'Loose screws', expected: 4, batch: {} }],
      serialised: [{ itemId: 'b', name: 'Multimeter', serialNo: null }],
      found: [],
      addFound: () => {},
    } as unknown as LocationCycleCount;
    render(<FoundHereField count={count} />);

    fireEvent.click(box());

    // Both are already countable on the sheet; offering them again would put a second,
    // expected-zero line beside a line that already asks the same question.
    expect(screen.queryByRole('option', { name: 'Loose screws' })).toBeNull();
    expect(screen.queryByRole('option', { name: 'Multimeter' })).toBeNull();
  });

  it('still offers an item whose only line here is a numbered lot', () => {
    h.rows = [item('a', 'Solder paste')];
    const count = {
      lines: [{ key: 'a|LOT-7', itemId: 'a', name: 'Solder paste · Lot 7', expected: 4, batch: {} }],
      serialised: [],
      found: [],
      addFound: () => {},
    } as unknown as LocationCycleCount;
    render(<FoundHereField count={count} />);

    fireEvent.click(box());

    // Unlabelled stock of an item whose tracked lot is also in this drawer is a genuine find:
    // the two are different lots and reconcile at different rows.
    expect(screen.getByRole('option', { name: 'Solder paste' })).toBeInTheDocument();
  });
});
