/**
 * SupplierPartPriceHistory — a compact price-over-time surface for one supplier part
 * (Phase 81). Shows a hand-rolled SVG sparkline + the latest cost with its trend, and the
 * last few recorded points. Read-only; rendered only when ≥1 point exists. Design tokens
 * only (colours via `currentColor` driven by a `text-*` token) — no chart dependency.
 */
import { useFormatters } from '@/lib/useFormatters';
import { useSupplierPartPriceHistory } from '../queries';
import { buildPriceSeries, sparklinePolyline, type PriceDirection } from '../price-history';

const SPARK_WIDTH = 120;
const SPARK_HEIGHT = 24;

/** How many recent points to list under the sparkline. */
const RECENT_LIMIT = 4;

/** A cost rise is a caution, a fall is welcome, flat/none is neutral — token colours only. */
const DIRECTION_TONE: Record<PriceDirection, string> = {
  up: 'text-warning',
  down: 'text-success',
  flat: 'text-muted-foreground',
  none: 'text-muted-foreground',
};

const DIRECTION_GLYPH: Record<PriceDirection, string> = {
  up: '↑',
  down: '↓',
  flat: '→',
  none: '',
};

export function SupplierPartPriceHistory({
  itemId,
  supplierPartId,
}: {
  itemId: string;
  supplierPartId: string;
}) {
  const { data } = useSupplierPartPriceHistory(itemId, supplierPartId);
  const fmt = useFormatters();

  const series = buildPriceSeries(data ?? []);
  if (series.count === 0) return null;

  const polyline = sparklinePolyline(
    series.points.map((p) => p.unitCost),
    SPARK_WIDTH,
    SPARK_HEIGHT,
  );
  const tone = DIRECTION_TONE[series.direction];
  const recent = [...series.points].reverse().slice(0, RECENT_LIMIT);

  const changeLabel =
    series.changeAbs === null || series.changeAbs === 0
      ? null
      : `${series.changeAbs > 0 ? '+' : '−'}${fmt.currency(Math.abs(series.changeAbs))}${
          series.changePct === null ? '' : ` (${series.changePct > 0 ? '+' : '−'}${Math.abs(Math.round(series.changePct))}%)`
        }`;

  return (
    <div className="mt-2 rounded-lg bg-secondary/40 p-2" data-testid="supplier-part-price-history">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Price history
        </span>
        {changeLabel ? (
          <span className={`inline-flex items-center gap-0.5 text-xs font-medium ${tone}`}>
            <span aria-hidden>{DIRECTION_GLYPH[series.direction]}</span>
            {changeLabel}
          </span>
        ) : null}
      </div>

      {series.count >= 2 ? (
        <svg
          viewBox={`0 0 ${SPARK_WIDTH} ${SPARK_HEIGHT}`}
          width={SPARK_WIDTH}
          height={SPARK_HEIGHT}
          className={`mt-1 ${tone}`}
          role="img"
          aria-label={`Cost trend over ${series.count} recorded points`}
          preserveAspectRatio="none"
        >
          <polyline
            points={polyline}
            fill="none"
            stroke="currentColor"
            strokeWidth={1.5}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      ) : null}

      <ul className="mt-1 flex flex-col gap-0.5">
        {recent.map((p) => (
          <li key={p.id} className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
            <span className="text-foreground tabular-nums">
              {fmt.currency(p.unitCost)}
              {p.currency ? ` ${p.currency}` : ''}
            </span>
            <span className="flex items-center gap-2">
              {p.source === 'SCRAPE' ? <span className="text-[10px] uppercase tracking-wide">Scraped</span> : null}
              <time dateTime={new Date(p.recordedAt).toISOString()}>{fmt.date(p.recordedAt)}</time>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
