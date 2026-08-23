import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Button, Money, Tooltip, useToast } from '@/components/foundry';
import { CostIcon, RefreshIcon, SupplierIcon, WarningIcon } from '@/components/icons';
import type { Item, SupplierPart } from '@/db/repositories';
import { useFeature } from '@/features/modules/useFeature';
import {
  SUPPORTED_SUPPLIER_LABELS,
  planPriceRefresh,
  summarisePriceRefresh,
  useScrapeBridge,
  type RefreshOutcome,
  type RefreshPrice,
  type RefreshSummary,
} from '@/features/scraping';
import { useFormatters } from '@/lib/useFormatters';
import { useUpdateSupplierPart } from '../mutations';

/** Force-finish a run this long after it starts, so a hung scrape can't strand the spinner. */
const REFRESH_TIMEOUT_MS = 30_000;

/** How the current run selected its suppliers — drives the summary wording. */
type RefreshMode = 'pinned' | 'all';

/** What we remember about each in-flight scrape so its result maps back to a supplier row. */
interface RunMeta {
  readonly supplierPartId: string;
  readonly supplierName: string;
}

interface Run {
  readonly ids: string[];
  readonly meta: Record<string, RunMeta>;
  readonly mode: RefreshMode;
}

/**
 * "Refresh prices" — one-click live pricing for an item's supplier(s) (issue #28).
 *
 * When the item has a pinned **price source** (a supplier starred as its source), a refresh
 * fetches just that supplier and reports its new price. Otherwise it fetches **every** supplier
 * whose product URL is on a distributor the companion extension can background-fetch, and reports
 * the **cheapest** and which supplier it came from. Either way each fetched cost is written back
 * to its supplier row (recording a `SCRAPE` price-history point via the §4 write path).
 *
 * When the action can't run it says why and how to fix it: no supplier set, the pinned source has
 * no fetchable URL, no supplier has a fetchable URL, or the companion extension is not installed.
 *
 * Rendered only when the Product & supplier lookup module is on; the button itself stays
 * available even with no suppliers so a click can explain the fix (the issue's requirement).
 */
export function RefreshPricesButton({ item, parts }: { item: Item; parts: readonly SupplierPart[] }) {
  const scrapingEnabled = useFeature('scraping');
  const bridge = useScrapeBridge();
  const update = useUpdateSupplierPart();
  const { show } = useToast();
  const fmt = useFormatters();

  const [isRefreshing, setIsRefreshing] = useState(false);
  // The current run's scrape ids + their supplier metadata; null when idle. A ref (not state)
  // so the settle effect reads a stable snapshot without re-subscribing on each render.
  const runRef = useRef<Run | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Latest bridge, readable from the timeout callback without stale-closure risk.
  const bridgeRef = useRef(bridge);
  bridgeRef.current = bridge;

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  // On unmount (e.g. the dialog closes mid-refresh) stop the timeout and drop any still-tracked
  // scrapes from the shared app-wide bridge, so an abandoned run leaves nothing behind.
  useEffect(
    () => () => {
      clearTimer();
      const run = runRef.current;
      if (run) run.ids.forEach((id) => bridgeRef.current.clear(id));
    },
    [clearTimer],
  );

  const showSummary = useCallback(
    (summary: RefreshSummary, mode: RefreshMode) => {
      if (summary.priceCount === 0) {
        show({
          tone: 'warning',
          icon: <WarningIcon />,
          heading: 'No live price found',
          message:
            summary.errorCount > 0
              ? 'Could not fetch a live price. Open the supplier page in a browser tab, then try again.'
              : 'The supplier page carried no price we could read.',
        });
        return;
      }

      const renderPrice = (p: RefreshPrice) => (
        <Money value={p.value} currency={p.currency} formatters={fmt} className="text-foreground" />
      );

      let message: ReactNode;
      if (mode === 'pinned' && summary.cheapest) {
        // Pinned price source: exactly one supplier was fetched.
        message = (
          <span>
            {summary.cheapest.supplierName}: {renderPrice(summary.cheapest)}
          </span>
        );
      } else if (summary.mixedCurrencies) {
        // Prices are in different currencies, so a single "cheapest" would be dishonest — list each.
        message = (
          <span className="flex flex-col gap-0.5">
            <span>Prices are in different currencies:</span>
            {summary.prices.map((p) => (
              <span key={p.id}>
                {p.supplierName}: {renderPrice(p)}
              </span>
            ))}
          </span>
        );
      } else if (summary.cheapest) {
        message = (
          <span>
            Cheapest: {summary.cheapest.supplierName} {renderPrice(summary.cheapest)}
          </span>
        );
      }

      show({ tone: 'success', icon: <CostIcon />, heading: 'Prices refreshed', message });
    },
    [fmt, show],
  );

  /**
   * Settle the current run: build an outcome per tracked scrape, persist each fetched price
   * against its supplier row (a `SCRAPE` cost write records price history), clear the bridge
   * entries, and report the summary. `forced` finalises a timed-out run even if some scrapes
   * never settled (their outcome is an error).
   */
  const finalize = useCallback(
    (forced: boolean) => {
      const run = runRef.current;
      if (!run) return;
      const b = bridgeRef.current;
      const states = run.ids.map((id) => b.requests[id]);
      const allSettled = states.every((s) => s !== undefined && s.status !== 'SCRAPING');
      if (!forced && !allSettled) return;

      runRef.current = null;
      clearTimer();

      const outcomes: RefreshOutcome[] = run.ids.map((id) => {
        const state = b.requests[id];
        const meta = run.meta[id]!;
        const base = { id: meta.supplierPartId, supplierName: meta.supplierName };
        if (state?.status === 'SUCCESS' && state.result) {
          const pricing = state.result.scraped_pricing;
          if (pricing) {
            update.mutate({
              id: meta.supplierPartId,
              itemId: item.id,
              input: { unitCost: pricing.value, currency: pricing.currency, source: 'SCRAPE' },
            });
            return { kind: 'PRICE', ...base, value: pricing.value, currency: pricing.currency };
          }
          return { kind: 'NO_PRICE', ...base };
        }
        return { kind: 'ERROR', ...base, errorType: state?.error?.error_type ?? 'NETWORK_TIMEOUT' };
      });

      run.ids.forEach((id) => b.clear(id));
      setIsRefreshing(false);
      showSummary(summarisePriceRefresh(outcomes), run.mode);
    },
    [clearTimer, item.id, showSummary, update],
  );

  // Re-check completion whenever a tracked scrape settles.
  useEffect(() => {
    finalize(false);
  }, [bridge.requests, finalize]);

  const start = (
    mode: RefreshMode,
    fetchable: readonly { id: string; supplierName: string; url: string }[],
  ) => {
    const ids: string[] = [];
    const meta: Record<string, RunMeta> = {};
    for (const f of fetchable) {
      const id = bridge.requestScrape(f.url);
      ids.push(id);
      meta[id] = { supplierPartId: f.id, supplierName: f.supplierName };
    }
    runRef.current = { ids, meta, mode };
    setIsRefreshing(true);
    clearTimer();
    timerRef.current = setTimeout(() => finalize(true), REFRESH_TIMEOUT_MS);
  };

  const handleClick = () => {
    if (isRefreshing) return;

    if (parts.length === 0) {
      show({
        tone: 'warning',
        icon: <SupplierIcon />,
        heading: 'No supplier set',
        message:
          'This item has no supplier, so there is no price to fetch. Add a supplier with a product ' +
          'URL from a supported distributor, then refresh.',
      });
      return;
    }

    // A peer that does not speak the scrape capability is no more use here than no peer at all
    // (issue #664), but it needs a different sentence: the extension *is* installed, so telling
    // the user to install it would send them round a loop they cannot leave.
    if (!bridge.supports('scrape')) {
      show({
        tone: 'warning',
        icon: <WarningIcon />,
        heading: 'Companion extension needed',
        message: bridge.ready
          ? 'The installed Gubbins companion extension is too old to fetch prices. Rebuild and ' +
            'reload it, then try again.'
          : 'Live prices are fetched by the Gubbins companion browser extension. Install and ' +
            'enable it, then try again.',
      });
      return;
    }

    // A pinned price source narrows the refresh to that one supplier; otherwise fetch them all.
    const pinned = parts.find((p) => p.isPriceSource);
    const candidates = pinned ? [pinned] : parts;
    const plan = planPriceRefresh(
      candidates.map((p) => ({ id: p.id, supplierName: p.supplierName, url: p.url })),
    );

    if (plan.fetchable.length === 0) {
      show({
        tone: 'warning',
        icon: <WarningIcon />,
        heading: pinned ? 'Price source cannot be fetched' : 'No fetchable supplier URL',
        message: pinned
          ? `The pinned price source (${pinned.supplierName}) has no product link from a supported distributor. Add one, or unpin it to compare all suppliers.`
          : `Give a supplier a product link from a supported distributor (${SUPPORTED_SUPPLIER_LABELS.join(', ')}) so its price can be fetched.`,
      });
      return;
    }

    start(pinned ? 'pinned' : 'all', plan.fetchable);
  };

  if (!scrapingEnabled) return null;

  return (
    <Tooltip content="Fetch the current price from this item's supplier(s) via the companion extension.">
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={handleClick}
        disabled={isRefreshing}
        data-testid="supplier-price-refresh"
      >
        <RefreshIcon className={isRefreshing ? 'animate-spin' : undefined} />
        {isRefreshing ? 'Refreshing…' : 'Refresh prices'}
      </Button>
    </Tooltip>
  );
}
