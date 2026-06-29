/**
 * "Scrape Supplier" panel (spec §9.3 UI unlocking, §9.4.3 graceful degradation).
 *
 * Rendered inside the item-creation and item-edit workflows. It is **feature-detected**:
 * it shows nothing until a trusted EXTENSION_READY has unlocked the bridge (`ready`),
 * so when the companion extension is absent the UI silently degrades to manual entry.
 * On a SCRAPE_RESULT it hands the typed payload to `onResult`; on a SCRAPE_ERROR it
 * raises an actionable passive toast and stays out of the way (the manual fields
 * remain editable).
 */
import { useEffect, useState } from 'react';
import { Button, Input, Tooltip, useToast } from '@/components/foundry';
import { ScrapeIcon, SupplierIcon, WarningIcon } from '@/components/icons';
import { useScrapeBridge } from '../ScrapeBridgeContext';
import { describeScrapeError } from '../scrape-errors';
import type { ScrapeResultPayload } from '../protocol';

export function ScrapeSupplierPanel({
  onResult,
  className,
}: {
  /** Called with the validated payload when a scrape succeeds. */
  onResult: (payload: ScrapeResultPayload) => void;
  className?: string;
}) {
  const bridge = useScrapeBridge();
  const { show } = useToast();
  const [url, setUrl] = useState('');
  // Track only the scrape *this* panel started, by its requestId, so a concurrent
  // scrape elsewhere can never deliver its result here (§9 multi-scrape correlation).
  const [requestId, setRequestId] = useState<string | null>(null);
  const request = requestId ? bridge.requests[requestId] : undefined;

  // React only to the outcome of our own correlated request.
  useEffect(() => {
    if (!request) return;
    if (request.status === 'SUCCESS' && request.result) {
      onResult(request.result);
      bridge.clear(request.id);
      setRequestId(null);
    } else if (request.status === 'ERROR' && request.error) {
      const { error } = request;
      show({
        tone: 'warning',
        icon: <WarningIcon />,
        heading: 'Supplier scrape failed',
        // Per-type actionable wording (§9.4.3) — the deepened §9.4.2 taxonomy now
        // distinguishes a block / dead URL / supplier outage, each with its own nudge.
        message: describeScrapeError(error),
        action: { label: 'Enter manually', onClick: () => {} },
      });
      bridge.clear(request.id);
      setRequestId(null);
    }
  }, [request, onResult, show, bridge]);

  // §9.3: the Scrape control only exists once the extension has announced itself.
  if (!bridge.ready) return null;

  const trimmed = url.trim();
  const isScraping = request?.status === 'SCRAPING';

  const submit = () => {
    if (trimmed.length === 0 || isScraping) return;
    setRequestId(bridge.requestScrape(trimmed));
  };

  return (
    <div className={className} data-testid="scrape-supplier-panel">
      <div className="rounded-xl border border-primary/30 bg-primary/5 p-3">
        <p className="mb-2 flex items-center gap-2 text-sm font-medium [&_svg]:size-4 [&_svg]:text-primary">
          <SupplierIcon />
          Scrape supplier
        </p>
        <div className="flex gap-2">
          <Input
            type="url"
            inputMode="url"
            placeholder="https://www.digikey.co.uk/…"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                submit();
              }
            }}
          />
          <Tooltip content="Fetch part details via the companion extension (never overwrites your own entries).">
            <Button
              type="button"
              variant="secondary"
              onClick={submit}
              disabled={trimmed.length === 0 || isScraping}
              className="shrink-0"
            >
              <ScrapeIcon className="size-4" />
              {isScraping ? 'Scraping…' : 'Scrape'}
            </Button>
          </Tooltip>
        </div>
      </div>
    </div>
  );
}
