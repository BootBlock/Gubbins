/**
 * Web Share Target — payload → add-item draft mapping (pure, DOM-free, exhaustively testable).
 *
 * When the OS share sheet sends content to Gubbins ("Share to Gubbins"), the service worker
 * ({@link ../../sw}) captures the POST and the share-landing route ({@link ../../routes/share-target})
 * opens a **pre-filled add-item draft the user confirms** — Gubbins never auto-commits a share
 * (a share can be accidental; the reviewable draft is non-negotiable — plan EI-4).
 *
 * This module is the shared, transport-agnostic core that turns the raw share payload into the
 * fields the add-item form seeds. It reuses the existing enrichment seams rather than forking
 * them: a shared **URL** is run through the Amazon-ASIN parser ({@link ../inventory/asin}) so a
 * listing link pre-fills the item's SKU/MPN and pre-seeds the supplier-scraper panel; shared
 * **text/title** become the item name and a provenance note. No network, no DOM — just data in,
 * draft out.
 */
import { findAsin, parseAsin } from '@/features/inventory/asin';

/** The raw fields a Web Share Target delivers (all optional — the OS fills what it has). */
export interface SharePayload {
  /** The subject/title of the shared content (often a page title or a note heading). */
  title?: string;
  /** Free text — a note body, a selection, or (on Android) frequently the URL itself. */
  text?: string;
  /** The shared URL, when the source app supplies one in the dedicated `url` field. */
  url?: string;
  /** The name of a shared image file, when one was attached (the blob is handled separately). */
  imageName?: string;
}

/**
 * The seed values for the add-item form. Every field is optional; the form keeps its own
 * defaults for anything left unset. `sourceUrl` is not a form field — it pre-seeds the
 * supplier-scraper panel's URL box so the user can enrich the draft in one click.
 */
export interface ShareDraft {
  name?: string;
  mpn?: string;
  notes?: string;
  /** The canonical source URL, used to pre-seed the scraper panel (not a stored field). */
  sourceUrl?: string;
}

/** A loose URL match used only to recover a URL the OS packed into the free-text field. */
const URL_IN_TEXT_RE = /https?:\/\/[^\s<>"']+/i;

/** Trim, collapse internal runs of whitespace, and drop to `null` when nothing is left. */
function clean(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.replace(/\s+/g, ' ').trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** The first non-empty, non-URL line of a block of text (a plausible item name). */
function firstMeaningfulLine(text: string | null): string | null {
  if (!text) return null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    if (URL_IN_TEXT_RE.test(line) && /^https?:\/\/\S+$/i.test(line)) continue; // a bare URL line
    return line;
  }
  return null;
}

/** A human-friendly label for a URL — its hostname without a leading `www.`. */
function hostLabel(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, '') || null;
  } catch {
    return null;
  }
}

/**
 * Turn a raw share payload into add-item draft seed values. Deterministic and side-effect free.
 *
 * - **URL:** taken from `payload.url`, or recovered from `payload.text` when the source app packed
 *   it there (common on Android). If it resolves to an Amazon ASIN it fills `mpn`; the raw URL is
 *   always kept in `notes` for provenance and echoed as `sourceUrl` to pre-seed the scraper.
 * - **Name:** the shared `title`, else the first meaningful line of `text`, else the URL's host.
 * - **Notes:** a short provenance block (source URL, any shared text distinct from the name, and a
 *   recognised ASIN) so nothing the user shared is silently dropped before they confirm.
 */
export function buildShareDraft(payload: SharePayload): ShareDraft {
  const title = clean(payload.title);
  const rawText = payload.text?.trim() ? payload.text : null;
  const explicitUrl = clean(payload.url);
  const urlFromText = rawText ? (URL_IN_TEXT_RE.exec(rawText)?.[0] ?? null) : null;
  const url = explicitUrl ?? urlFromText;

  // A recognised Amazon ASIN (from the URL, or found loose in the shared text) → the SKU/MPN slot,
  // exactly as the line-list importer treats a shared Amazon listing.
  const asin = (url ? parseAsin(url) : null) ?? (rawText ? (findAsin(rawText)?.asin ?? null) : null);

  // Name: the title wins; then the first real line of text (unless it is merely the bare URL);
  // then the URL host as a last resort so the draft is never entirely blank when a link was shared.
  const textLine = firstMeaningfulLine(rawText);
  const name = title ?? textLine ?? (url ? hostLabel(url) : null) ?? undefined;

  // Provenance note: keep the source link, any shared prose the name didn't already capture, and a
  // detected ASIN, each on its own line. The user sees exactly what arrived before confirming.
  const noteLines: string[] = ['Added via Share to Gubbins.'];
  if (url) noteLines.push(`Source: ${url}`);
  const sharedProse = clean(rawText);
  if (sharedProse && sharedProse !== name && sharedProse !== url) noteLines.push(sharedProse);
  if (asin) noteLines.push(`Amazon ASIN: ${asin}`);
  if (payload.imageName) noteLines.push(`Shared image: ${payload.imageName}`);

  return {
    ...(name ? { name } : {}),
    ...(asin ? { mpn: asin } : {}),
    ...(url ? { sourceUrl: url } : {}),
    notes: noteLines.join('\n'),
  };
}
