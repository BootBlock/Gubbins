/**
 * Lightweight fuzzy subsequence matching with weighted scoring (§2.4 — no third-party libs).
 *
 * `fuzzyMatch(query, target)` returns a score and the matched character positions when the
 * query is a (case-insensitive) subsequence of the target, or `null` when it isn't a match
 * at all. The score rewards the qualities that make a match feel "right" in a command
 * palette — matches at the start, at word boundaries, and in unbroken runs — so a short,
 * on-the-nose hit outranks a scattered one. `rankFuzzy` layers the sort on top: it keeps
 * only the matches, orders them best-first, and breaks ties by the original order so results
 * stay stable as the user types.
 *
 * Deliberately greedy (nearest-occurrence) rather than a full dynamic-programming search:
 * the inputs here are short screen labels and item names, so the simpler pass is both fast
 * and predictable, and every weight below is a single tunable constant.
 */

/** A successful fuzzy match: its weighted `score` and the matched indices into the target. */
export interface FuzzyMatch {
  /** Higher is a better match. Only comparable between matches against different targets. */
  readonly score: number;
  /** Indices in `target` (ascending) that the query characters matched, for highlighting. */
  readonly positions: readonly number[];
}

// Scoring weights — one place to tune the "feel" of ranking.
const SCORE_PER_MATCH = 16; // base reward for each matched character
const BONUS_START = 12; // the match begins at the very first character
const BONUS_BOUNDARY = 8; // the match sits at a word boundary (after a separator / camelCase hump)
const BONUS_CONSECUTIVE = 8; // the match immediately follows the previous one (an unbroken run)
const PENALTY_PER_GAP = 1; // per character skipped before this match (capped, see MAX_GAP_PENALTY)
const MAX_GAP_PENALTY = 4; // never punish a single gap by more than this
const LENGTH_TIEBREAK = 0.1; // subtle nudge so shorter targets win otherwise-equal matches

const SEPARATORS = new Set([' ', '-', '_', '/', '.', ',', ':']);

/** Whether target index `i` starts a "word" — index 0, after a separator, or a camelCase hump. */
function isBoundary(target: string, i: number): boolean {
  if (i === 0) return true;
  const prev = target[i - 1] ?? '';
  if (SEPARATORS.has(prev)) return true;
  // camelCase / PascalCase hump: a lowercase-or-digit followed by an uppercase letter.
  return /[a-z0-9]/.test(prev) && /[A-Z]/.test(target[i] ?? '');
}

/**
 * Score `query` against `target`. Returns `null` unless `query` is a case-insensitive
 * subsequence of `target`. Whitespace in the query is ignored, so `"pur ord"` and
 * `"purord"` match `"Purchase orders"` identically. An empty query matches everything with
 * a neutral score of 0 (handy for "show all" states).
 */
export function fuzzyMatch(query: string, target: string): FuzzyMatch | null {
  const q = query.replace(/\s+/g, '').toLowerCase();
  if (q.length === 0) return { score: 0, positions: [] };

  const lower = target.toLowerCase();
  const positions: number[] = [];
  let score = 0;
  let prevMatch = -2; // so the first match is never counted "consecutive"
  let cursor = 0;

  for (const ch of q) {
    let idx = -1;
    for (let k = cursor; k < lower.length; k++) {
      if (lower[k] === ch) {
        idx = k;
        break;
      }
    }
    if (idx === -1) return null; // query char has no remaining occurrence — not a subsequence

    score += SCORE_PER_MATCH;
    if (idx === 0) score += BONUS_START;
    else if (isBoundary(target, idx)) score += BONUS_BOUNDARY;
    if (idx === prevMatch + 1) score += BONUS_CONSECUTIVE;

    const gap = idx - (prevMatch + 1);
    if (gap > 0) score -= Math.min(gap, MAX_GAP_PENALTY) * PENALTY_PER_GAP;

    positions.push(idx);
    prevMatch = idx;
    cursor = idx + 1;
  }

  // Subtle length normalisation: among equally-scored matches, prefer the shorter target.
  score -= Math.min(target.length, 40) * LENGTH_TIEBREAK;

  return { score, positions };
}

/** An item paired with the fuzzy match that placed it, as returned by {@link rankFuzzy}. */
export interface RankedFuzzy<T> {
  readonly item: T;
  readonly match: FuzzyMatch;
}

/**
 * Filter `items` to those whose `getText(item)` fuzzily matches `query`, best match first.
 * Ties (equal score) keep their original relative order, so the list doesn't jitter as the
 * query changes. An empty query returns every item, unranked, in its original order.
 */
export function rankFuzzy<T>(
  items: readonly T[],
  query: string,
  getText: (item: T) => string,
): readonly RankedFuzzy<T>[] {
  const ranked: { entry: RankedFuzzy<T>; order: number }[] = [];
  items.forEach((item, order) => {
    const match = fuzzyMatch(query, getText(item));
    if (match) ranked.push({ entry: { item, match }, order });
  });
  ranked.sort((a, b) => b.entry.match.score - a.entry.match.score || a.order - b.order);
  return ranked.map((r) => r.entry);
}
