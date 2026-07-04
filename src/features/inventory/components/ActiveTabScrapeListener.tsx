/**
 * Active-tab Amazon enrichment surface (Path A2) — the PWA-side receiver.
 *
 * The companion extension scrapes the user's live Amazon tab on an explicit gesture and
 * pushes the result across the origin-verified §9 bridge, where it lands in
 * {@link useScrapeBridge}'s `incoming` map (unsolicited — the PWA never requested it). This
 * globally-mounted listener watches that map and, for each arriving scrape, opens the
 * **reviewable add-item dialog pre-filled** from the payload — Gubbins never auto-commits, so
 * the user always confirms. A failed scrape surfaces as an actionable toast instead.
 *
 * It deliberately **reuses the canonical add-item flow** ({@link CreateItemDialog}) rather than
 * forking a bespoke form: the item's title/brand/price seed the form fields, and the ASIN +
 * buy-box price ride along as `initialScrape` so the dialog persists an **Amazon supplier part**
 * (ASIN → order code) through the §4 no-overwrite-safe write path on confirm.
 */
import { useEffect, useState } from 'react';
import { useToast } from '@/components/foundry';
import { WarningIcon } from '@/components/icons';
import { describeScrapeError, useScrapeBridge, type ScrapeResultPayload } from '@/features/scraping';
import { useLocations } from '../queries';
import { defaultLocationForNewItem, markedDefaultLocationId } from '../location-tree';
import { CreateItemDialog, type CreateItemInitialValues } from './CreateItemDialog';

/**
 * Map an Amazon active-tab scrape to add-item form seed values. Only the item's *own* fields
 * are seeded here — the ASIN is an Amazon **order code**, not an item MPN (§9 data-model), so
 * it never fills the MPN field; it becomes the supplier part's order code via `initialScrape`.
 * The listing title, brand and price seed the name, manufacturer and unit cost; the ASIN and
 * link are recorded in the notes for provenance.
 */
function draftFromScrape(payload: ScrapeResultPayload): CreateItemInitialValues {
  const noteLines = ['Added from your Amazon tab.', `Amazon ASIN: ${payload.mpn}`];
  if (payload.distributor_url) noteLines.push(`Listing: ${payload.distributor_url}`);
  return {
    ...(payload.description ? { name: payload.description } : {}),
    ...(payload.manufacturer ? { manufacturer: payload.manufacturer } : {}),
    ...(payload.scraped_pricing ? { unitCost: String(payload.scraped_pricing.value) } : {}),
    notes: noteLines.join('\n'),
  };
}

export function ActiveTabScrapeListener() {
  const bridge = useScrapeBridge();
  const { show } = useToast();
  const flat = useLocations();
  // The scrape currently being reviewed. One at a time — a second arrival waits until this
  // dialog is closed, then the effect picks it up.
  const [active, setActive] = useState<{ id: string; payload: ScrapeResultPayload } | null>(null);

  useEffect(() => {
    if (active) return;
    for (const entry of Object.values(bridge.incoming)) {
      if (entry.status === 'ERROR' && entry.error) {
        // A drift/block reading the tab — explain it and drop it (nothing to review).
        show({
          tone: 'warning',
          icon: <WarningIcon />,
          heading: 'Amazon import failed',
          message: describeScrapeError(entry.error),
        });
        bridge.clearIncoming(entry.id);
        return;
      }
      if (entry.status === 'SUCCESS' && entry.result) {
        setActive({ id: entry.id, payload: entry.result });
        return;
      }
    }
  }, [bridge, active, show]);

  // Wait for the location tree before opening (the dialog needs a home list); the scrape
  // stays queued in `active` meanwhile.
  if (!active || flat.data === undefined) return null;
  const locations = flat.data.rows;
  const close = () => {
    bridge.clearIncoming(active.id);
    setActive(null);
  };

  return (
    <CreateItemDialog
      open
      onClose={close}
      locations={locations}
      defaultLocationId={defaultLocationForNewItem(null, locations, markedDefaultLocationId(locations))}
      initialValues={draftFromScrape(active.payload)}
      initialScrape={active.payload}
    />
  );
}
