/**
 * "Scrape Supplier" panel (spec §9.3 UI unlocking, §9.4.3 graceful degradation).
 *
 * Rendered inside the item-creation and item-edit workflows. It is **feature-detected**:
 * it shows nothing until a trusted EXTENSION_READY has unlocked the bridge (`ready`),
 * so when the companion extension is absent the UI silently degrades to manual entry.
 * On a SCRAPE_RESULT it hands the typed payload to `onResult`; on a SCRAPE_ERROR it
 * raises an actionable passive toast and stays out of the way (the manual fields
 * remain editable).
 *
 * A link the extension's allow-list would refuse is caught **here**, before the round-trip
 * (issue #667): the same {@link classifySupplierUrl} gate runs app-side, so an unsupported
 * site is answered inline — naming the distributors that do work — rather than coming back
 * as a remote-sounding failure the user cannot act on.
 */
import { useEffect, useRef, useState } from 'react';
import { Button, FormField, Input, Tooltip, useToast } from '@/components/foundry';
import { ScrapeIcon, SupplierIcon, WarningIcon } from '@/components/icons';
import { useT, type MessageKey } from '@/features/i18n';
import { useFeature } from '@/features/modules/useFeature';
import { useScrapeBridge } from '../ScrapeBridgeContext';
import { describeScrapeError } from '../scrape-errors';
import { SUPPORTED_SUPPLIER_LABELS } from '../parsers/registry';
import { classifySupplierUrl, type UrlRefusal } from '../parsers/suppliers';
import { hostOf } from '../parsers/types';
import type { ScrapeResultPayload } from '../protocol';

/** The inline copy for each way the allow-list can refuse a pasted link (issue #667). */
const REFUSAL_KEYS: Record<UrlRefusal, MessageKey> = {
  MALFORMED: 'scraping.panel.refusal.malformed',
  NOT_HTTPS: 'scraping.panel.refusal.notHttps',
  CREDENTIALS: 'scraping.panel.refusal.credentials',
  OFF_LIST: 'scraping.panel.refusal.offList',
};

export function ScrapeSupplierPanel({
  onResult,
  className,
  initialUrl,
}: {
  /** Called with the validated payload when a scrape succeeds. */
  onResult: (payload: ScrapeResultPayload) => void;
  className?: string;
  /** Pre-seed the URL box — e.g. a link shared into Gubbins (plan EI-4). */
  initialUrl?: string;
}) {
  const bridge = useScrapeBridge();
  const scrapingEnabled = useFeature('scraping');
  const { show } = useToast();
  const t = useT();
  const [url, setUrl] = useState(initialUrl ?? '');
  // Track only the scrape *this* panel started, by its requestId, so a concurrent
  // scrape elsewhere can never deliver its result here (§9 multi-scrape correlation).
  const [requestId, setRequestId] = useState<string | null>(null);
  // Set when the pasted link fails the app-side allow-list check, cleared as soon as it is
  // edited — a refusal describes the link as it was submitted, not as it is being retyped.
  const [refusal, setRefusal] = useState<UrlRefusal | null>(null);
  const request = requestId ? bridge.requests[requestId] : undefined;

  // Read from the unmount cleanup below, which must not close over a stale id.
  const abandoned = useRef<{ id: string | null; clear: (id: string) => void }>({
    id: null,
    clear: bridge.clear,
  });
  abandoned.current = { id: requestId, clear: bridge.clear };

  // Drop a still-tracked scrape when the panel goes away — the dialog was closed mid-scrape, so
  // there is nobody left to read its outcome. The bridge's own deadline would eventually settle
  // the entry, but it would settle it into a map nothing is watching, leaving the app-wide
  // pending count raised until it expired (issue #665).
  useEffect(
    () => () => {
      const { id, clear } = abandoned.current;
      if (id) clear(id);
    },
    [],
  );

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
        heading: t('scraping.panel.failedHeading'),
        // Per-type actionable wording (§9.4.3) — the deepened §9.4.2 taxonomy now
        // distinguishes a block / dead URL / supplier outage, each with its own nudge.
        // English-only: the wording lives in the framework-free module the extension
        // bundles, which cannot reach the `t()` seam.
        message: describeScrapeError(error),
        action: { label: t('scraping.panel.enterManually'), onClick: () => {} },
      });
      bridge.clear(request.id);
      setRequestId(null);
    }
  }, [request, onResult, show, bridge, t]);

  // §9.3: the Scrape control only exists once an extension that actually speaks the scrape
  // capability has announced itself (issue #664) — and only when the Product & supplier lookup
  // module is switched on (Modular UI). Gating on mere readiness would offer the button to a peer
  // that drops the request in silence, leaving it to time out with nothing to show for it.
  if (!bridge.supports('scrape') || !scrapingEnabled) return null;

  const trimmed = url.trim();
  const isScraping = request?.status === 'SCRAPING';
  const suppliers = SUPPORTED_SUPPLIER_LABELS.join(', ');

  const submit = () => {
    if (trimmed.length === 0 || isScraping) return;
    // The extension's privileged worker enforces this same gate before it fetches, so a link
    // it would refuse has no round-trip worth making: answer it here, with the reason.
    const refused = classifySupplierUrl(trimmed);
    setRefusal(refused);
    if (refused !== null) return;
    setRequestId(bridge.requestScrape(trimmed));
  };

  return (
    <div className={className} data-testid="scrape-supplier-panel">
      <div className="rounded-xl border border-primary/30 bg-primary/5 p-3">
        <p className="mb-2 flex items-center gap-2 text-sm font-medium [&_svg]:size-4 [&_svg]:text-primary">
          <SupplierIcon />
          {t('scraping.panel.title')}
        </p>
        {/* The Scrape button sits beside the field but *outside* the FormField's `<label>`, so it
            never folds into the input's accessible name. Top-aligned past a spacer mirroring the
            label's own line (the BarcodeField pattern): the field grows downward when a refusal
            appears, and bottom-alignment would drag the button down with it. */}
        <div className="flex items-start gap-2">
          <FormField
            className="min-w-0 flex-1"
            compact
            label={t('scraping.panel.urlLabel')}
            hint={t('scraping.panel.urlHint', { vars: { suppliers } })}
            hintSize="lg"
            error={
              refusal ? t(REFUSAL_KEYS[refusal], { vars: { suppliers, domain: hostOf(trimmed) } }) : undefined
            }
          >
            <Input
              type="url"
              inputMode="url"
              placeholder={t('scraping.panel.urlPlaceholder')}
              value={url}
              onChange={(e) => {
                setUrl(e.target.value);
                setRefusal(null);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  submit();
                }
              }}
            />
          </FormField>
          <div className="flex flex-col">
            <span className="mb-field-gap-compact block text-xs" aria-hidden>
              &nbsp;
            </span>
            <Tooltip content={t('scraping.panel.tooltip')}>
              <Button
                type="button"
                variant="secondary"
                onClick={submit}
                disabled={trimmed.length === 0 || isScraping}
                className="shrink-0"
              >
                <ScrapeIcon className="size-4" />
                {isScraping ? t('scraping.panel.actionBusy') : t('scraping.panel.action')}
              </Button>
            </Tooltip>
          </div>
        </div>
      </div>
    </div>
  );
}
