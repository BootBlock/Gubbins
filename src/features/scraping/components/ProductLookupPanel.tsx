/**
 * "Look up product" panel (recommendation point 2) — keyless barcode enrichment.
 *
 * The sibling of {@link import('./ScrapeSupplierPanel').ScrapeSupplierPanel}, but keyed by a
 * **retail barcode** rather than a supplier URL: given a GTIN it resolves the product against an
 * open, key-less database (Open Food Facts) and hands the typed result to `onResult`.
 *
 * Two resolution paths, transparently (issue #59):
 *  - **Companion extension present** — the privileged extension performs the network request and
 *    bridges a typed payload back (as with the §9 supplier scrape).
 *  - **No extension** (e.g. on a phone) — the app queries Open Food Facts **directly**, but only
 *    after the user consents. The first direct lookup shows a one-time prompt; the choice is
 *    remembered in the `allowOnlineProductLookup` preference and changeable in Settings.
 *
 * It stays **feature-detected**: it renders nothing when the lookup capability is off or there is
 * no barcode to look up, so it degrades silently to manual entry. A `NOT_FOUND` (the open
 * database's coverage is groceries/consumables, so a hardware barcode legitimately misses) raises
 * a quiet, actionable toast and stays out of the way.
 */
import { useEffect, useState } from 'react';
import { Button, Modal, Tooltip, useToast } from '@/components/foundry';
import { CloudIcon, PackageIcon, SearchIcon, WarningIcon } from '@/components/icons';
import { useFeature } from '@/features/modules/useFeature';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';
import { useScrapeBridge } from '../ScrapeBridgeContext';
import { describeScrapeError } from '../scrape-errors';
import { lookupProductOnline } from '../product-lookup-online';
import { OPEN_FOOD_FACTS_HOST } from '../product-lookup';
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
  const allowOnline = usePreferencesStore((s) => s.allowOnlineProductLookup);
  const setAllowOnline = usePreferencesStore((s) => s.setAllowOnlineProductLookup);
  // Track only the bridge lookup *this* panel started, by its requestId, so a concurrent lookup
  // elsewhere can never deliver its result here (multi-request correlation, mirroring §9).
  const [requestId, setRequestId] = useState<string | null>(null);
  const lookup = requestId ? bridge.lookups[requestId] : undefined;
  // The direct (extension-less) online lookup runs here rather than over the bridge.
  const [onlineBusy, setOnlineBusy] = useState(false);
  const [consentOpen, setConsentOpen] = useState(false);

  const trimmed = barcode.trim();

  // React only to the outcome of our own correlated bridge lookup.
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

  // Feature-detect: module off, or nothing to look up → no control at all.
  if (!scrapingEnabled || trimmed.length === 0) return null;

  const isLooking = lookup?.status === 'LOOKING_UP' || onlineBusy;

  // Query Open Food Facts directly (no extension). Fail-soft: a miss or network error raises a
  // quiet, actionable toast rather than throwing.
  const runOnline = async () => {
    setOnlineBusy(true);
    const parsed = await lookupProductOnline(trimmed);
    setOnlineBusy(false);
    if (parsed.ok) {
      onResult(parsed.payload);
    } else {
      show({
        tone: 'warning',
        icon: <WarningIcon />,
        heading: 'Product lookup failed',
        message: parsed.reason,
        action: { label: 'Enter manually', onClick: () => {} },
      });
    }
  };

  const submit = () => {
    if (trimmed.length === 0 || isLooking) return;
    // Prefer the privileged extension when present; otherwise go online — gated by consent.
    if (bridge.ready) {
      setRequestId(bridge.requestLookup(trimmed));
    } else if (allowOnline) {
      void runOnline();
    } else {
      setConsentOpen(true);
    }
  };

  // The user agreed to online lookups: remember it (so we don't ask again) and run this one.
  const confirmConsent = () => {
    setConsentOpen(false);
    setAllowOnline(true);
    void runOnline();
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
          <Tooltip content="Looks the barcode up (never overwrites your own entries).">
            <Button
              type="button"
              variant="secondary"
              onClick={submit}
              disabled={isLooking}
              className="shrink-0"
              data-testid="product-lookup-submit"
            >
              <SearchIcon className="size-4" />
              {isLooking ? 'Looking up…' : 'Look up'}
            </Button>
          </Tooltip>
        </div>
      </div>

      {/* One-time consent before the app first reaches the network for a lookup (issue #59). */}
      <Modal open={consentOpen} onClose={() => setConsentOpen(false)} title="Look this barcode up online?">
        <div className="space-y-4">
          <p className="flex gap-2 text-sm text-muted-foreground">
            <CloudIcon className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
            <span>
              Gubbins will send this barcode number to{' '}
              <span className="font-mono">{OPEN_FOOD_FACTS_HOST}</span> — an open, free product database — to
              fetch the item’s name and brand. Nothing else about your inventory is sent.
            </span>
          </p>
          <p className="text-sm text-muted-foreground">
            This happens only when you tap “Look up”, never automatically. You can change this any time in
            Settings → Notifications &amp; files.
          </p>
          <div className="flex justify-end gap-2">
            <Button
              variant="outline"
              onClick={() => setConsentOpen(false)}
              data-testid="product-lookup-consent-cancel"
            >
              Not now
            </Button>
            <Button onClick={confirmConsent} data-testid="product-lookup-consent-confirm">
              Continue
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
