/**
 * Share-target inbox — the hand-off between the service worker and the app.
 *
 * The PWA has no server, so a Web Share Target POST is intercepted by the service worker
 * ({@link ../../sw}), which cannot render UI. It stashes the shared payload here (in the Cache
 * Storage API, available identically in the worker and the page) under a one-shot id, then
 * redirects the navigation to the share-landing route ({@link ../../routes/share-target}) with that
 * id in the query string. The route reads the stash back, opens a pre-filled add-item draft, and
 * clears the entry — so a shared image blob survives the worker→page boundary without a server.
 *
 * Keys are anchored at the **origin root** (`/gubbins-share/<id>/…`), independent of the app's
 * base path: they are Cache Storage keys only (never fetched over the network), and the worker and
 * page must derive an identical key without sharing the `import.meta.env.BASE_URL` build constant.
 */
import type { SharePayload } from './share-draft';

/** Dedicated cache the share inbox owns; the service worker's `activate` prune leaves it alone. */
export const SHARE_INBOX_CACHE = 'gubbins-share-inbox';

/** Response header stamped on each stashed entry, so a stale (never-consumed) share can be swept. */
const STASHED_AT_HEADER = 'x-gubbins-stashed-at';

/** How long an unconsumed share may linger before {@link pruneStaleShares} reclaims it (1 hour). */
const SHARE_MAX_AGE_MS = 60 * 60 * 1000;

/** A stashed share: the text payload plus an optional shared image blob. */
export interface StashedShare {
  payload: SharePayload;
  image: Blob | null;
}

/**
 * Read a Web Share Target `multipart/form-data` submission into the payload + image the inbox
 * stashes. The field names match the manifest `share_target.params` (`title` / `text` / `url` and
 * an `image` file). Kept pure (no cache, no worker globals) so the mapping is unit-testable.
 */
export function parseShareForm(form: FormData): StashedShare {
  const payload: SharePayload = {};
  const title = form.get('title');
  const text = form.get('text');
  const url = form.get('url');
  if (typeof title === 'string' && title.trim()) payload.title = title;
  if (typeof text === 'string' && text.trim()) payload.text = text;
  if (typeof url === 'string' && url.trim()) payload.url = url;

  const file = form.get('image');
  const image = file instanceof File && file.size > 0 ? file : null;
  if (image) payload.imageName = image.name;

  return { payload, image };
}

/** The origin-anchored synthetic base key for one stashed share. */
function stashBase(id: string): string {
  return new URL(`gubbins-share/${encodeURIComponent(id)}`, self.location.origin).href;
}

/**
 * Stash a shared payload (service-worker side). Writes the JSON metadata and, when present, the
 * image blob as separate cache entries under the share's id.
 */
export async function stashShare(id: string, share: StashedShare): Promise<void> {
  const cache = await caches.open(SHARE_INBOX_CACHE);
  const stampedAt = String(Date.now());
  await cache.put(
    new Request(`${stashBase(id)}/meta`),
    new Response(JSON.stringify(share.payload), {
      headers: { 'content-type': 'application/json', [STASHED_AT_HEADER]: stampedAt },
    }),
  );
  if (share.image) {
    await cache.put(
      new Request(`${stashBase(id)}/image`),
      new Response(share.image, {
        headers: {
          'content-type': share.image.type || 'application/octet-stream',
          [STASHED_AT_HEADER]: stampedAt,
        },
      }),
    );
  }
}

/**
 * Read a stashed share back (page side). Returns `null` when the id is unknown or already
 * consumed — the landing route treats that as "opened directly" and shows an empty draft.
 */
export async function readShare(id: string): Promise<StashedShare | null> {
  const cache = await caches.open(SHARE_INBOX_CACHE);
  const meta = await cache.match(`${stashBase(id)}/meta`);
  if (!meta) return null;
  const payload = (await meta.json()) as SharePayload;
  const imageRes = await cache.match(`${stashBase(id)}/image`);
  const image = imageRes ? await imageRes.blob() : null;
  return { payload, image };
}

/** Delete a stashed share once the draft has consumed it (a one-shot inbox). */
export async function clearShare(id: string): Promise<void> {
  const cache = await caches.open(SHARE_INBOX_CACHE);
  await cache.delete(`${stashBase(id)}/meta`);
  await cache.delete(`${stashBase(id)}/image`);
}

/**
 * Reclaim stashed shares that were never consumed — e.g. a share whose landing tab was dismissed
 * before the draft opened, so `clearShare` never ran. The `activate` prune deliberately preserves
 * this cache (an in-flight share must survive a mid-share update), so without this sweep an
 * abandoned share — including a full-resolution image blob — would linger forever. Entries older
 * than {@link SHARE_MAX_AGE_MS} are dropped; a just-stashed, still-in-flight share is well within
 * the window and kept. Missing/garbled timestamps are treated as stale and reclaimed.
 */
export async function pruneStaleShares(now: number = Date.now()): Promise<void> {
  const cache = await caches.open(SHARE_INBOX_CACHE);
  const requests = await cache.keys();
  await Promise.all(
    requests.map(async (request) => {
      const res = await cache.match(request);
      const stampedAt = Number(res?.headers.get(STASHED_AT_HEADER));
      if (!Number.isFinite(stampedAt) || now - stampedAt > SHARE_MAX_AGE_MS) {
        await cache.delete(request);
      }
    }),
  );
}
