/**
 * Hook-wiring tests for `useAgenda` feature gating (Modular UI Phase 7).
 *
 * The pure `buildAgenda` seam is covered in `agenda.test.ts`; here we verify the hook's
 * deep-cascade wiring: each date-driven lane gates on its owning feature (bookings→bookings,
 * checkouts→contacts, maintenance→maintenance, warranty→warranty, expiry→perishables,
 * field-due→custom-fields), while
 * reorder stays (core inventory). A gated-off lane passes `enabled: false` to its feed query
 * and feeds an empty array into the seam, so it produces no events even though the mocked feed
 * still returns rows (a stale-cache stand-in).
 *
 * `useQuery` is mocked and keyed off the query key so each of the seven feeds returns its own
 * rows and records the `enabled` flag it was called with; the modules store is the real store.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';

const h = vi.hoisted(() => ({ useQuery: vi.fn() }));
vi.mock('@tanstack/react-query', () => ({ useQuery: h.useQuery }));

import { useAgenda } from './useAgenda';
import type { AgendaKind } from './agenda';
import { useModulesStore } from '@/state/stores/useModulesStore';

const DAY_MS = 24 * 60 * 60 * 1000;
const PAST = Date.now() - DAY_MS;

/** Per-lane feed data, keyed by the second query-key segment. */
const LANE_DATA: Record<string, unknown> = {
  maintenance: {
    rows: [
      {
        id: 'sch-1',
        itemId: 'it-1',
        itemName: 'Mower',
        name: 'Oil change',
        basis: 'TIME',
        lastPerformedAt: null,
        createdAt: PAST - DAY_MS,
        intervalDays: 1,
        intervalUsage: null,
        usageSinceService: null,
        accrueCheckoutHours: false,
        autoUsageHours: null,
      },
    ],
  },
  warranty: {
    rows: [{ id: 'it-2', name: 'Drill', warrantyExpiresAt: new Date(PAST).toISOString().slice(0, 10) }],
  },
  expiry: { rows: [{ id: 'it-3', name: 'Milk', expiryDate: PAST }] },
  checkouts: {
    rows: [{ id: 'ck-1', itemId: 'it-4', itemName: 'Camera', borrowerName: 'Alex', dueDate: PAST }],
  },
  reorder: [{ itemId: 'it-5', itemName: 'Screws', shortfall: 3 }],
  bookings: {
    rows: [
      {
        id: 'bk-1',
        itemId: 'it-6',
        itemName: 'Projector',
        contactName: 'Sam',
        startDate: PAST,
        endDate: PAST + DAY_MS,
      },
    ],
  },
  // The due-date lane reads through `readAllPages`, whose envelope is `{ rows, truncated }`.
  'field-due': {
    rows: [
      {
        itemId: 'it-7',
        itemName: 'Studio insurance',
        defId: 'def-1',
        fieldName: 'Renewal date',
        leadDays: 14,
        dueAt: Date.parse(new Date(PAST).toISOString().slice(0, 10)),
      },
    ],
    truncated: false,
  },
};

/** `enabled` flag captured per lane during the last render. */
let enabledByLane: Record<string, boolean | undefined> = {};

beforeEach(() => {
  useModulesStore.setState({ intent: {} });
  enabledByLane = {};
  h.useQuery.mockImplementation((opts: { queryKey: readonly unknown[]; enabled?: boolean }) => {
    const lane = String(opts.queryKey[1]);
    enabledByLane[lane] = opts.enabled;
    return { data: LANE_DATA[lane], isLoading: false, isError: false };
  });
});

afterEach(() => {
  vi.clearAllMocks();
  useModulesStore.setState({ intent: {} });
});

function kinds(): Set<AgendaKind> {
  const { result } = renderHook(() => useAgenda());
  return new Set(result.current.events.map((e) => e.kind));
}

describe('useAgenda — all features on (default)', () => {
  it('produces every lane and enables every gated feed; reorder is ungated', () => {
    const present = kinds();
    expect(present).toEqual(
      new Set<AgendaKind>([
        'maintenance',
        'warranty',
        'expiry',
        'checkout-due',
        'reorder',
        'booking',
        'field-due',
      ]),
    );
    expect(enabledByLane.maintenance).toBe(true);
    expect(enabledByLane.warranty).toBe(true);
    expect(enabledByLane.expiry).toBe(true);
    expect(enabledByLane.checkouts).toBe(true);
    expect(enabledByLane.bookings).toBe(true);
    expect(enabledByLane['field-due']).toBe(true);
    // Reorder is core inventory — never passed an `enabled` flag (always fetches).
    expect(enabledByLane.reorder).toBeUndefined();
  });
});

describe('useAgenda — per-lane gating', () => {
  it('Maintenance off drops the maintenance lane and disables its feed', () => {
    useModulesStore.getState().setFeatureIntent('maintenance', false);
    const present = kinds();
    expect(present.has('maintenance')).toBe(false);
    expect(present.has('reorder')).toBe(true);
    expect(enabledByLane.maintenance).toBe(false);
  });

  it('Warranty off drops the warranty lane and disables its feed', () => {
    useModulesStore.getState().setFeatureIntent('warranty', false);
    const present = kinds();
    expect(present.has('warranty')).toBe(false);
    expect(enabledByLane.warranty).toBe(false);
  });

  it('Expiry tracking off drops the expiry lane and disables its feed', () => {
    useModulesStore.getState().setFeatureIntent('perishables', false);
    const present = kinds();
    expect(present.has('expiry')).toBe(false);
    expect(enabledByLane.expiry).toBe(false);
  });

  it('Contacts off drops the checkout lane and disables its feed', () => {
    useModulesStore.getState().setFeatureIntent('contacts', false);
    const present = kinds();
    expect(present.has('checkout-due')).toBe(false);
    expect(enabledByLane.checkouts).toBe(false);
  });

  it('Bookings off drops the booking lane and disables its feed', () => {
    useModulesStore.getState().setFeatureIntent('bookings', false);
    const present = kinds();
    expect(present.has('booking')).toBe(false);
    expect(present.has('reorder')).toBe(true);
    expect(enabledByLane.bookings).toBe(false);
  });

  it('Custom fields off drops the custom-field due-date lane and disables its feed', () => {
    useModulesStore.getState().setFeatureIntent('custom-fields', false);
    const present = kinds();
    expect(present.has('field-due')).toBe(false);
    expect(present.has('reorder')).toBe(true);
    expect(enabledByLane['field-due']).toBe(false);
  });
});

describe('useAgenda — custom-field due-date truncation is reported, not swallowed', () => {
  it("passes the read-everything walk's ceiling flag through to the screen", () => {
    h.useQuery.mockImplementation((opts: { queryKey: readonly unknown[]; enabled?: boolean }) => {
      const lane = String(opts.queryKey[1]);
      const data = lane === 'field-due' ? { rows: [], truncated: true } : LANE_DATA[lane];
      return { data, isLoading: false, isError: false };
    });
    const { result } = renderHook(() => useAgenda());
    expect(result.current.fieldDueTruncated).toBe(true);
  });

  it('never reports truncation for a lane whose module is off', () => {
    useModulesStore.getState().setFeatureIntent('custom-fields', false);
    h.useQuery.mockImplementation((opts: { queryKey: readonly unknown[]; enabled?: boolean }) => {
      const lane = String(opts.queryKey[1]);
      // A stale cache entry from when the module was on still claiming truncation.
      const data = lane === 'field-due' ? { rows: [], truncated: true } : LANE_DATA[lane];
      return { data, isLoading: false, isError: false };
    });
    const { result } = renderHook(() => useAgenda());
    expect(result.current.fieldDueTruncated).toBe(false);
  });
});
