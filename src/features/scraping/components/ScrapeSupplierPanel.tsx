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
import { useEffect, useRef, useState } from 'react';
import { Button, Input, Tooltip, useToast } from '@/components/foundry';
import { ScrapeIcon, SupplierIcon, WarningIcon } from '@/components/icons';
import { useScrapeBridge } from '../ScrapeBridgeContext';
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
  const awaiting = useRef(false);

  // React only to the outcome of a scrape *this* panel initiated.
  useEffect(() => {
    if (!awaiting.current) return;
    if (bridge.status === 'SUCCESS' && bridge.result) {
      awaiting.current = false;
      onResult(bridge.result);
      bridge.reset();
    } else if (bridge.status === 'ERROR' && bridge.error) {
      awaiting.current = false;
      const { error } = bridge;
      show({
        tone: 'warning',
        icon: <WarningIcon />,
        heading: 'Supplier scrape failed',
        message:
          error.error_type === 'DOM_DRIFT'
            ? `${error.domain}: the page layout changed. Manual entry required.`
            : `${error.domain}: ${error.reason}`,
        action: { label: 'Enter manually', onClick: () => {} },
      });
      bridge.reset();
    }
  }, [bridge, onResult, show]);

  // §9.3: the Scrape control only exists once the extension has announced itself.
  if (!bridge.ready) return null;

  const trimmed = url.trim();
  const isScraping = bridge.status === 'SCRAPING' && awaiting.current;

  const submit = () => {
    if (trimmed.length === 0 || isScraping) return;
    awaiting.current = true;
    bridge.requestScrape(trimmed);
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
