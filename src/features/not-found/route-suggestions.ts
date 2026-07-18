/**
 * "Did you mean…?" ranking for the 404 screen (issue #41).
 *
 * When a URL doesn't resolve to a route, we take the path the user actually typed and rank
 * the real destinations by how close each one is — so a mistyped or half-remembered address
 * (`/inventroy`, `/setting`, `/purchase-order`) offers a one-click way to the page they
 * meant, rather than a dead end.
 *
 * The scoring layers two complementary signals from {@link ../../lib/fuzzy} (both dependency-
 * free): a prefix / subsequence check catches partial or abbreviated paths (`/inv` →
 * Inventory), and edit-distance {@link similarity} catches typos and transpositions
 * (`/reprots` → Reports) that a subsequence match misses entirely. A candidate scores as the
 * best it does on either signal, against either its route path or its display label, so
 * however the user mangled the URL the closest real page still surfaces. Genuinely unrelated
 * paths (`/notreal`) score below the threshold and produce no suggestions, so we never invent
 * a misleading match.
 */
import { fuzzyMatch, similarity } from '@/lib/fuzzy';

/** A destination the 404 screen can suggest — its route path and human label. */
export interface RouteCandidate {
  readonly to: string;
  readonly label: string;
}

/** A candidate paired with its closeness score (`0`–`1`, higher is nearer). */
export interface RouteSuggestion<T extends RouteCandidate> {
  readonly candidate: T;
  readonly score: number;
}

/** A prefix hit is a strong signal (`/inv` → Inventory) even though its edit distance is large. */
const PREFIX_SCORE = 0.9;
/** A subsequence hit (`/ivntory`-style scatter) is a weaker but still meaningful signal. */
const SUBSEQUENCE_SCORE = 0.6;
/** Below this, a candidate is too far to be a helpful guess — better to offer nothing. */
const DEFAULT_THRESHOLD = 0.4;
/** Never overwhelm the screen with guesses; the top few are all that help. */
const DEFAULT_LIMIT = 4;

/** Reduce a route path or label to the bare comparison token: lowercase, no separators. */
function normaliseToken(value: string): string {
  return value.toLowerCase().replace(/[\s/_-]+/g, '');
}

/**
 * The normalised path segments of the attempted path, most-specific (deepest) first — every
 * part that could name the intended page. Strips the app's base path, then splits on `/`
 * (`/Gubbins/foo/bar` → `['bar', 'foo']`), dropping empties. Ordered deepest-first because the
 * leaf is the likeliest target, but every segment is kept so a mistyped *nested* path
 * (`/inventory/99999`) can still match on the real page named earlier in it. Empty when the
 * path carries no segment (e.g. the bare base path).
 *
 * @internal Exported for unit tests only.
 */
export function extractQuerySegments(pathname: string, basepath?: string): readonly string[] {
  let path = pathname;
  if (basepath && path.startsWith(basepath)) path = path.slice(basepath.length);
  return path
    .split('/')
    .map(normaliseToken)
    .filter((s) => s.length > 0)
    .reverse();
}

/** Best closeness of `query` to a single candidate token, across all signals. */
function scoreToken(query: string, token: string): number {
  if (token.length === 0) return 0;
  const best = similarity(query, token);
  // The prefix / subsequence boosts only apply for a query of two or more characters: a
  // single letter is a prefix of, or a subsequence within, almost every token, so boosting
  // it would let a stray one-character path segment suggest half the app. A 1-char query
  // still scores via edit-distance similarity above — just without the strong-signal boost.
  if (query.length < 2) return best;
  if (token.startsWith(query) || query.startsWith(token)) return Math.max(best, PREFIX_SCORE);
  if (fuzzyMatch(query, token) !== null) return Math.max(best, SUBSEQUENCE_SCORE);
  return best;
}

/**
 * Rank `candidates` by how likely each is the page the `attemptedPath` meant, best first.
 * Only candidates scoring at or above `threshold` are returned, capped at `limit`; an
 * unrecognisable path yields an empty list.
 */
export function suggestRoutes<T extends RouteCandidate>(
  attemptedPath: string,
  candidates: readonly T[],
  options: { basepath?: string; threshold?: number; limit?: number } = {},
): readonly RouteSuggestion<T>[] {
  const { basepath, threshold = DEFAULT_THRESHOLD, limit = DEFAULT_LIMIT } = options;
  const segments = extractQuerySegments(attemptedPath, basepath);
  if (segments.length === 0) return [];

  /** Best score for a candidate token across every path segment. */
  const bestOverSegments = (token: string): number =>
    segments.reduce((best, segment) => Math.max(best, scoreToken(segment, token)), 0);

  return candidates
    .map((candidate) => ({
      candidate,
      score: Math.max(
        bestOverSegments(normaliseToken(candidate.to)),
        bestOverSegments(normaliseToken(candidate.label)),
      ),
    }))
    .filter((s) => s.score >= threshold)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
