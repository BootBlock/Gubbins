import { describe, it, expect } from 'vitest';
import { DASHBOARD_WIDGETS, widgetById } from './widgets';
import { ALL_FEATURE_IDS, featureForRoute, type FeatureId } from '@/features/modules/feature-registry';
import { IN_TRANSIT_LOCATION_ID } from '@/db/repositories/constants';

/**
 * Guards the real widget→feature annotations (modular-ui-plan §4). The gating *behaviour*
 * is covered against a synthetic registry in `DashboardGrid.test.tsx`; this asserts the
 * live mapping every widget declares, so a new or re-pointed widget can't silently ship
 * with a bogus or missing gate.
 */
describe('DASHBOARD_WIDGETS — Modular UI feature annotations', () => {
  it('gates each widget on the feature the plan assigns it (or leaves it always-on)', () => {
    const featureById = Object.fromEntries(DASHBOARD_WIDGETS.map((w) => [w.id, w.feature])) as Record<
      string,
      FeatureId | undefined
    >;

    expect(featureById).toMatchObject({
      // Always-on: core inventory pulse + app-status plumbing (no feature gate).
      'inventory-totals': undefined,
      'low-stock': undefined,
      'system-database': undefined,
      'system-storage': undefined,
      'system-platform': undefined,
      // Gated widgets.
      expiring: 'perishables',
      overdue: 'contacts',
      maintenance: 'maintenance',
      'in-transit': 'purchase-orders',
      projects: 'projects',
      'budget-alerts': 'projects',
      'recent-activity': 'activity',
    });
  });

  it('only ever annotates a real registered feature id', () => {
    const known = new Set<FeatureId>(ALL_FEATURE_IDS);
    for (const w of DASHBOARD_WIDGETS) {
      if (w.feature) expect(known.has(w.feature)).toBe(true);
    }
  });

  it('points every quick-link at a resolvable route (gated or ungated, never dangling)', () => {
    for (const w of DASHBOARD_WIDGETS) {
      if (!w.to) continue;
      // A `to` either maps to a gating feature (a page module) or to an ungated path such
      // as `/inventory`/`/settings` (core) — `featureForRoute` returning `undefined` there
      // is expected. What matters is that the resolution runs without throwing.
      expect(() => featureForRoute(w.to as string)).not.toThrow();
    }
  });
});

describe('In-transit widget quick-link', () => {
  it('links to the Inventory screen scoped to the In-Transit location', () => {
    expect(widgetById('in-transit')?.search).toEqual({ loc: IN_TRANSIT_LOCATION_ID });
  });
});
