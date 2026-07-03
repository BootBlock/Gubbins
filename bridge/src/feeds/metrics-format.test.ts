/**
 * Pure Prometheus-exposition tests (EI-6) — the formatter's HELP/TYPE/sample layout, label
 * escaping and float rendering. No DB: the snapshot is constructed inline.
 */
import { describe, expect, it } from 'vitest';
import { escapeLabel, formatMetrics } from './metrics-format.ts';
import type { MetricsSnapshot } from './metrics.ts';

const SNAPSHOT: MetricsSnapshot = {
  itemsTotal: 3,
  lowStockItems: 2,
  outOfStockItems: 1,
  locationsTotal: 2,
  locations: [
    { id: 'loc-store', name: 'Store Room', itemCount: 2, capacity: 10, fullnessRatio: 0.2 },
    { id: 'loc-bench', name: 'Workbench', itemCount: 1, capacity: null, fullnessRatio: null },
  ],
};

describe('escapeLabel', () => {
  it('escapes backslash, double-quote and newline', () => {
    expect(escapeLabel('a "b" \\ c\nd')).toBe('a \\"b\\" \\\\ c\\nd');
  });
});

describe('formatMetrics', () => {
  const text = formatMetrics(SNAPSHOT);

  it('emits HELP/TYPE and the scalar gauges', () => {
    expect(text).toContain('# HELP gubbins_items_total Total active items in the inventory.');
    expect(text).toContain('# TYPE gubbins_items_total gauge');
    expect(text).toContain('\ngubbins_items_total 3\n');
    expect(text).toContain('\ngubbins_low_stock_items 2\n');
    expect(text).toContain('\ngubbins_out_of_stock_items 1\n');
    expect(text).toContain('\ngubbins_locations_total 2\n');
  });

  it('labels per-location samples by id and name', () => {
    expect(text).toContain('gubbins_location_items{location_id="loc-store",location="Store Room"} 2');
    expect(text).toContain('gubbins_location_items{location_id="loc-bench",location="Workbench"} 1');
  });

  it('emits capacity + fullness ONLY for a location with a capacity', () => {
    expect(text).toContain('gubbins_location_capacity{location_id="loc-store",location="Store Room"} 10');
    expect(text).toContain(
      'gubbins_location_fullness_ratio{location_id="loc-store",location="Store Room"} 0.2',
    );
    // The uncapped Workbench contributes an item count but no capacity/fullness line.
    expect(text).not.toContain('gubbins_location_capacity{location_id="loc-bench"');
    expect(text).not.toContain('gubbins_location_fullness_ratio{location_id="loc-bench"');
  });

  it('still declares HELP/TYPE for a family with no samples', () => {
    const empty = formatMetrics({ ...SNAPSHOT, locations: [] });
    expect(empty).toContain('# TYPE gubbins_location_capacity gauge');
    // ...but no sample line follows it.
    expect(empty).not.toMatch(/gubbins_location_capacity\{/);
  });

  it('ends with a trailing newline (a well-formed exposition)', () => {
    expect(text.endsWith('\n')).toBe(true);
  });
});
