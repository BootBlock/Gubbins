/**
 * `web+gubbins:` protocol-handler parsing (pure, DOM-free, exhaustively testable).
 *
 * Gubbins registers a `web+gubbins:` protocol handler in its web app manifest (see the VitePWA
 * config in `vite.config.ts`), so a link like `web+gubbins://item/<id>` in a note-taking app or
 * another tool deep-links straight into the installed PWA. The browser routes such a click to the
 * handler URL with the full custom-scheme link as a query parameter; the deep-link landing route
 * ({@link ../../routes/deep-link}) hands that raw string here to decide what to open.
 *
 * Two intents are recognised, both **read/draft only** — a deep link never mutates inventory on its
 * own:
 *   - `web+gubbins://item/<id>` opens that item's detail dialog.
 *   - `web+gubbins://add?url=…&title=…&text=…` opens a pre-filled add-item draft (the same reviewable
 *     draft the share target produces — {@link ./share-draft}).
 * Anything else is `unknown`, and the route falls back to the inventory screen.
 */
import type { SharePayload } from './share-draft';

/** The Gubbins custom-scheme prefix (mandated form: a `web+` scheme, per the manifest spec). */
export const GUBBINS_SCHEME = 'web+gubbins:';

/** A parsed deep-link intent. */
export type DeepLinkIntent =
  { kind: 'item'; id: string } | { kind: 'add'; payload: SharePayload } | { kind: 'unknown' };

/**
 * Parse a raw `web+gubbins:` link into an intent. Tolerates both the authority form
 * (`web+gubbins://item/<id>`) and the opaque form (`web+gubbins:item/<id>`); a missing or
 * foreign scheme, or an unrecognised action, yields `{ kind: 'unknown' }` so the caller can
 * fall back gracefully. Never throws.
 */
export function parseDeepLink(raw: string): DeepLinkIntent {
  const trimmed = raw.trim();
  if (!trimmed.toLowerCase().startsWith(GUBBINS_SCHEME)) return { kind: 'unknown' };

  // Strip the scheme and any `//` authority marker, leaving `<action>/<rest>?<query>`.
  const body = trimmed.slice(GUBBINS_SCHEME.length).replace(/^\/\//, '');
  if (body.length === 0) return { kind: 'unknown' };

  const [pathPart = '', queryPart = ''] = body.split('?', 2);
  const segments = pathPart
    .split('/')
    .filter((s) => s.length > 0)
    .map(decodeSegment);
  const [action, ...rest] = segments;

  if (action === 'item') {
    const id = rest[0];
    return id ? { kind: 'item', id } : { kind: 'unknown' };
  }

  if (action === 'add') {
    const params = new URLSearchParams(queryPart);
    const payload: SharePayload = {};
    const title = params.get('title');
    const text = params.get('text');
    const url = params.get('url');
    if (title) payload.title = title;
    if (text) payload.text = text;
    if (url) payload.url = url;
    return { kind: 'add', payload };
  }

  return { kind: 'unknown' };
}

/** Best-effort percent-decode of a single path segment (a raw segment on failure). */
function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}
