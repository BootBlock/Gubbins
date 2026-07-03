/**
 * Prometheus text-exposition formatter (EI-6) — pure serialisation of a {@link MetricsSnapshot}.
 *
 * Emits the Prometheus text exposition format (version 0.0.4), which a Prometheus/OpenMetrics
 * scrape accepts directly: a `# HELP` and `# TYPE` line per metric family, then one sample line
 * `name{labels} value`. Hand-rolled (no client library) — the same stdlib-first posture as the
 * bridge's iCal / YAML / feed emitters; the surface we need is tiny and stable.
 *
 * Pure and deterministic: no clock, no I/O, no DB — the projection (`metrics.ts`) does the reads,
 * this file only renders, so every escaping / layout rule unit-tests directly. Label values flow
 * through {@link escapeLabel} so a hostile location name can't break a sample line.
 */
import type { MetricsSnapshot } from './metrics.ts';

/** The metric-name prefix for every Gubbins series. */
const PREFIX = 'gubbins';

/**
 * Escape a Prometheus label value (spec §exposition-formats): backslash, double-quote and newline.
 * A label value is the only place free-text (a location name) reaches the exposition, so this is
 * the injection guard.
 */
export function escapeLabel(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

/** One metric family: its (already-prefixed) name, help text, and rendered sample lines. */
interface MetricFamily {
  readonly name: string;
  readonly help: string;
  readonly samples: readonly string[];
}

/** Render a `{k="v",…}` label set (empty string when there are no labels). */
function labels(pairs: readonly (readonly [string, string])[]): string {
  if (pairs.length === 0) return '';
  return `{${pairs.map(([k, v]) => `${k}="${escapeLabel(v)}"`).join(',')}}`;
}

/** A single scalar-gauge family (no labels). */
function scalar(name: string, help: string, value: number): MetricFamily {
  return { name: `${PREFIX}_${name}`, help, samples: [`${PREFIX}_${name} ${value}`] };
}

/**
 * Format the snapshot as a Prometheus text-exposition document. Every metric is a `gauge` (a
 * point-in-time reading of the current snapshot). Per-location families carry `location_id` +
 * `location` labels; capacity/fullness lines are emitted only for a location that has a capacity.
 */
export function formatMetrics(snapshot: MetricsSnapshot): string {
  const locLabels = (id: string, name: string): string =>
    labels([
      ['location_id', id],
      ['location', name],
    ]);

  const families: MetricFamily[] = [
    scalar('items_total', 'Total active items in the inventory.', snapshot.itemsTotal),
    scalar('low_stock_items', 'Active items at or below their low-stock threshold.', snapshot.lowStockItems),
    scalar(
      'out_of_stock_items',
      'Active items that are fully depleted (a subset of low-stock).',
      snapshot.outOfStockItems,
    ),
    scalar(
      'locations_total',
      'Number of user-defined locations (system buckets excluded).',
      snapshot.locationsTotal,
    ),
    {
      name: `${PREFIX}_location_items`,
      help: 'Current item count in a location.',
      samples: snapshot.locations.map(
        (loc) => `${PREFIX}_location_items${locLabels(loc.id, loc.name)} ${loc.itemCount}`,
      ),
    },
    {
      name: `${PREFIX}_location_capacity`,
      help: 'Configured item capacity of a location (only present when a capacity is set).',
      samples: snapshot.locations
        .filter((loc) => loc.capacity !== null)
        .map((loc) => `${PREFIX}_location_capacity${locLabels(loc.id, loc.name)} ${loc.capacity}`),
    },
    {
      name: `${PREFIX}_location_fullness_ratio`,
      help: 'Item count divided by capacity (0..1+; only present when a capacity is set).',
      samples: snapshot.locations
        .filter((loc) => loc.fullnessRatio !== null)
        .map(
          (loc) =>
            `${PREFIX}_location_fullness_ratio${locLabels(loc.id, loc.name)} ${formatFloat(loc.fullnessRatio!)}`,
        ),
    },
  ];

  const lines: string[] = [];
  for (const family of families) {
    // A family with no samples (e.g. no capacity set anywhere) still declares HELP/TYPE so a
    // scraper sees a known-but-empty series rather than a silently missing one.
    lines.push(`# HELP ${family.name} ${family.help}`);
    lines.push(`# TYPE ${family.name} gauge`);
    lines.push(...family.samples);
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Render a finite float for the exposition. Trims a trailing `.0`-style zero fraction to an
 * integer form and avoids scientific notation for the small ratios we emit.
 */
function formatFloat(n: number): string {
  if (Number.isInteger(n)) return String(n);
  // Round to 4 dp (ample for a fullness ratio) and drop trailing zeros.
  return String(Number(n.toFixed(4)));
}
