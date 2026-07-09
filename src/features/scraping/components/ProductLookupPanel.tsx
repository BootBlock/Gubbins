/**
 * "Look up product" panel (recommendation point 2) — keyless barcode enrichment.
 *
 * The sibling of {@link import('./ScrapeSupplierPanel').ScrapeSupplierPanel}, but keyed by a
 * **retail barcode** rather than a supplier URL: given a GTIN it asks the companion extension
 * to resolve the product against an open, key-less database (Open Food Facts) and hands the
 * typed result to `onResult`. Like the scrape panel it is **feature-detected** — it renders
 * nothing until a trusted EXTENSION_READY has unlocked the bridge, and nothing when there is
 * no barcode to look up — so with no extension (or no barcode) the UI silently degrades to
 * manual entry. On a `NOT_FOUND` (the open database's coverage is groceries/consumables, so a
 * hardware barcode legitimately misses) it raises a quiet, actionable toast and stays out of
 * the way.
 */
import { useEffect, useState } from 'react';
import { Button, Tooltip, useToast } from '@/components/foundry';
import { PackageIcon, SearchIcon, WarningIcon } from '@/components/icons';
import { useFeature } from '@/features/modules/useFeature';
import { useScrapeBridge } from '../ScrapeBridgeContext';
import { describeScrapeError } from '../scrape-errors';
import type { ProductLookupResultPayload } from '../protocol';

export function ProductLookupPanel({
  barcode,
  onResult,
  className,
}: {
  /** The GTIN to look up — typically the item form's barcode field (may be blank). */
  barcode: string;
  /** Called with the validated product when a lookup succeeds. */
  onResult: (payload: ProductLookupResultPayload) => void;
  className?: string;
}) {
  const bridge = useScrapeBridge();
  const scrapingEnabled = useFeature('scraping');
  const { show } = useToast();
  // Track only the lookup *this* panel started, by its requestId, so a concurrent lookup
  // elsewhere can never deliver its result here (multi-request correlation, mirroring §9).
  const [requestId, setRequestId] = useState<string | null>(null);
  const lookup = requestId ? bridge.lookups[requestId] : undefined;

  // React only to the outcome of our own correlated lookup.
  useEffect(() => {
    if (!lookup) return;
    if (lookup.status === 'SUCCESS' && lookup.result) {
      onResult(lookup.result);
      bridge.clearLookup(lookup.id);
      setRequestId(null);
    } else if (lookup.status === 'ERROR' && lookup.error) {
      show({
        tone: 'warning',
        icon: <WarningIcon />,
        heading: 'Product lookup failed',
        message: describeScrapeError(lookup.error),
        action: { label: 'Enter manually', onClick: () => {} },
      });
      bridge.clearLookup(lookup.id);
      setRequestId(null);
    }
  }, [lookup, onResult, show, bridge]);

  const trimmed = barcode.trim();
  // Feature-detect: module off, no bridge, or nothing to look up → no control at all.
  if (!scrapingEnabled || !bridge.ready || trimmed.length === 0) return null;

  const isLooking = lookup?.status === 'LOOKING_UP';

  const submit = () => {
    if (trimmed.length === 0 || isLooking) return;
    setRequestId(bridge.requestLookup(trimmed));
  };

  return (
    <div className={className} data-testid="product-lookup-panel">
      <div className="rounded-xl border border-primary/30 bg-primary/5 p-3">
        <p className="mb-2 flex items-center gap-2 text-sm font-medium [&_svg]:size-4 [&_svg]:text-primary">
          <PackageIcon />
          Look up product
        </p>
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm text-muted-foreground">
            Fetch the name and brand for barcode <span className="font-mono">{trimmed}</span> from an open
            product database.
          </p>
          <Tooltip content="Looks the barcode up via the companion extension (never overwrites your own entries).">
            <Button
              type="button"
              variant="secondary"
              onClick={submit}
              disabled={isLooking}
              className="shrink-0"
            >
              <SearchIcon className="size-4" />
              {isLooking ? 'Looking up…' : 'Look up'}
            </Button>
          </Tooltip>
        </div>
      </div>
    </div>
  );
}
