/**
 * Scrape failure classification & user-facing messaging (spec §9.4.2 / §9.4.3).
 *
 * Two pure, framework-free seams over the {@link ScrapeErrorType} taxonomy:
 *
 * - {@link classifyHttpStatus} (the *producer* side, §9.4.2) maps an HTTP status code
 *   to the precise failure reason. It is extracted out of the extension background
 *   worker so the mapping is exhaustively unit-tested (the worker itself is bundled by
 *   esbuild, not type-checked or run by Vitest) and shared verbatim with the worker.
 * - {@link detectChallengePage} (the body-inspection *producer* side, §9.4.2, Phase 36)
 *   flags a 200-OK anti-bot interstitial from the fetched HTML, so a challenge page is
 *   reported as `CHALLENGE` rather than mis-parsed into a `DOM_DRIFT`. Shared with the
 *   content script (which runs it before handing the body to the Strategy parsers).
 * - {@link describeScrapeError} (the *consumer* side, §9.4.3) maps a marshalled
 *   {@link ScrapeErrorPayload} to an actionable, manual-entry-nudging toast message,
 *   so the PWA's graceful degradation wording lives in one tested place rather than an
 *   inline ternary.
 *
 * No DOM, no Zod, no React — safe to import from both the extension and the PWA.
 */
import type { ScrapeErrorPayload, ScrapeErrorType } from './protocol';

/** A failed scrape outcome: the precise §9.4.2 failure type + a diagnostic reason. */
export interface HttpFailure {
  readonly errorType: ScrapeErrorType;
  readonly reason: string;
}

/**
 * Classify a fetch's HTTP status into a §9.4.2 failure, or `null` for a usable 2xx.
 *
 * Only a *received* response reaches here — a transport-level failure (abort, timeout,
 * DNS) has no status and is reported as `NETWORK_TIMEOUT` by the caller's catch, so this
 * function never returns `NETWORK_TIMEOUT`. The ranges, in priority order:
 * - 2xx → `null` (success; the caller reads the body).
 * - 429 → `RATE_LIMITED`.
 * - 404 / 410 → `NOT_FOUND` (a dead/wrong product URL).
 * - 401 / 403 / 407, and any other 4xx → `BLOCKED` (the supplier refused the request —
 *   anti-bot challenge, auth/proxy required, 406/451, …).
 * - everything else (5xx, and any unexpected non-2xx < 400) → `SERVER_ERROR`.
 */
export function classifyHttpStatus(status: number): HttpFailure | null {
  if (status >= 200 && status < 300) return null;
  if (status === 429) {
    return { errorType: 'RATE_LIMITED', reason: 'Supplier returned HTTP 429 (rate limited).' };
  }
  if (status === 404 || status === 410) {
    return { errorType: 'NOT_FOUND', reason: `Product page not found (HTTP ${status}).` };
  }
  if (status >= 400 && status < 500) {
    return { errorType: 'BLOCKED', reason: `Supplier blocked the request (HTTP ${status}).` };
  }
  return { errorType: 'SERVER_ERROR', reason: `Supplier server error (HTTP ${status}).` };
}

/**
 * High-confidence anti-bot interstitial signatures (§9.4.2 — Phase 36).
 *
 * Each marker appears *only* on a vendor challenge/block page, never in a legitimate
 * supplier product page, so a match reliably means the 200-OK body is an interstitial
 * rather than the part data. We deliberately do **not** treat a bare reCAPTCHA/hCaptcha
 * widget as a challenge — real pages embed those in contact/login forms — keeping the
 * false-positive rate near zero. That is the conscious trade-off the developer accepted
 * (declined in Phase 35 over false-positive risk): under-detect rather than misfire.
 */
const CHALLENGE_SIGNATURES: ReadonlyArray<readonly [vendor: string, marker: RegExp]> = [
  [
    'Cloudflare',
    /just a moment\.\.\.|cf-browser-verification|cdn-cgi\/challenge-platform|checking your browser before accessing|attention required! \| cloudflare/i,
  ],
  ['Imperva Incapsula', /_incapsula_resource|incapsula incident id/i],
  ['PerimeterX', /\bpx-captcha\b/i],
  ['DataDome', /geo\.captcha-delivery\.com/i],
];

/**
 * Inspect a fetched (200-OK) HTML body for a high-confidence anti-bot challenge page.
 * Returns a `CHALLENGE` failure naming the detected vendor, or `null` when the body is
 * an ordinary page (the caller then proceeds to parse it). Pure — no DOM, regex only —
 * so it runs identically in the esbuild-only content script and the unit tests.
 */
export function detectChallengePage(html: string): HttpFailure | null {
  for (const [vendor, marker] of CHALLENGE_SIGNATURES) {
    if (marker.test(html)) {
      return { errorType: 'CHALLENGE', reason: `Supplier returned an anti-bot challenge page (${vendor}).` };
    }
  }
  return null;
}

/** The actionable toast wording per failure type (§9.4.3 — always nudges manual entry). */
const MESSAGE_BY_TYPE: Record<ScrapeErrorType, (domain: string) => string> = {
  DOM_DRIFT: (d) => `${d}: the page layout changed. Manual entry required.`,
  NETWORK_TIMEOUT: (d) => `${d}: the request timed out. Check your connection, or enter manually.`,
  RATE_LIMITED: (d) => `${d}: too many requests — wait a moment and try again, or enter manually.`,
  BLOCKED: (d) =>
    `${d}: the supplier blocked the request. Try opening the page in a tab first, or enter manually.`,
  NOT_FOUND: (d) => `${d}: product page not found — check the URL, or enter manually.`,
  SERVER_ERROR: (d) => `${d}: the supplier is having problems — try again later, or enter manually.`,
  CHALLENGE: (d) =>
    `${d}: the supplier showed an anti-bot challenge. Open the page in a browser tab to clear it, then retry — or enter manually.`,
};

/**
 * Build the §9.4.3 graceful-degradation toast message for a marshalled scrape error.
 * Falls back to the raw `reason` for an unrecognised (future/forward-compat) type so a
 * peer that learns a newer taxonomy member still produces something legible.
 */
export function describeScrapeError(error: ScrapeErrorPayload): string {
  const template = MESSAGE_BY_TYPE[error.error_type];
  return template ? template(error.domain) : `${error.domain}: ${error.reason}`;
}
