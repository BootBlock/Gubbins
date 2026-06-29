/**
 * Spoken-answer shaper (Phase HA-2) — the voice UX.
 *
 * Turns a {@link WhereIsMatch} list into ONE short, British-English sentence a Home
 * Assistant voice assistant can read aloud. Deliberately **pure** (no DB, no I/O, no
 * transport) so it is exhaustively unit-testable in isolation — given the same matches
 * it always yields the same sentence.
 *
 * Three shapes, mirroring how a person would answer "where is X?":
 *   - **not-found**  — nothing matched the query.
 *   - **found-one**  — a single item: its location(s) and stock.
 *   - **found-several** — a handful of items: a count and the first few, with location.
 *
 * Phrasing is concise on purpose: a voice device should speak a sentence, not recite an
 * inventory. The location *preposition* ("on Shelf 2" vs "in Drawer A") is chosen from
 * the location name's leading word so the answer reads naturally.
 */
import type { LocationBreakdown, WhereIsMatch } from './query.ts';

/** Up to this many matched items are named aloud before falling back to "and N more". */
const MAX_SPOKEN_ITEMS = 3;

/**
 * Leading location-name words that read better with "on" than "in" (a shelf, a rack, a
 * bench…). Everything else — drawers, bins, boxes, rooms — takes "in".
 */
const ON_PREFIXES = new Set(['shelf', 'rack', 'peg', 'pegboard', 'board', 'bench', 'table', 'tray']);

/** Compose the single spoken sentence for a "where is X?" answer. */
export function speakWhereIs(query: string, matches: readonly WhereIsMatch[]): string {
  const q = query.trim();
  if (matches.length === 0) return `I couldn't find anything matching "${q}".`;
  if (matches.length === 1) return speakSingle(matches[0]!);
  return speakSeveral(q, matches);
}

/** "Your ESP32 Dev Board is on Shelf 2 — 7 in stock." (one item, one or more places). */
function speakSingle(match: WhereIsMatch): string {
  const places = match.placements;

  // No per-location rows (e.g. nothing on hand): answer honestly rather than invent a place.
  if (places.length === 0) {
    return match.locationName
      ? `Your ${match.name} is in ${match.locationName}, but there's none in stock.`
      : `I found ${match.name}, but there's no location or stock recorded for it.`;
  }

  if (places.length === 1) {
    const place = places[0]!;
    return `Your ${match.name} is ${prepositionFor(place.locationName)} ${place.locationName} — ${stockPhrase(match.quantity)}.`;
  }

  const breakdown = listToProse(places.map(describePlacement));
  return `Your ${match.name} is spread across ${places.length} locations: ${breakdown} — ${match.quantity} in total.`;
}

/** "I found 3 items matching 'screws': … " (several items, named with their location). */
function speakSeveral(query: string, matches: readonly WhereIsMatch[]): string {
  const named = matches.slice(0, MAX_SPOKEN_ITEMS).map((match) => {
    const place = primaryPlace(match);
    return place ? `${match.name} ${place}` : match.name;
  });
  const remainder = matches.length - named.length;
  const list = remainder > 0 ? `${named.join(', ')} and ${remainder} more` : listToProse(named);
  return `I found ${matches.length} items matching "${query}": ${list}.`;
}

/** "5 on Shelf 2" — a single placement's quantity and location. */
function describePlacement(placement: LocationBreakdown): string {
  return `${placement.quantity} ${prepositionFor(placement.locationName)} ${placement.locationName}`;
}

/** The item's busiest location as a spoken phrase ("on Shelf 2"), or null if unknown. */
function primaryPlace(match: WhereIsMatch): string | null {
  const busiest = match.placements[0];
  if (busiest) return `${prepositionFor(busiest.locationName)} ${busiest.locationName}`;
  if (match.locationName) return `${prepositionFor(match.locationName)} ${match.locationName}`;
  return null;
}

/** "42 in stock" / "1 in stock" — "in stock" reads correctly for any count. */
function stockPhrase(quantity: number): string {
  return `${quantity} in stock`;
}

/** Pick the natural preposition for a location name from its leading word. */
function prepositionFor(locationName: string): string {
  const first = locationName.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
  return ON_PREFIXES.has(first) ? 'on' : 'in';
}

/** Join a list as British prose: "a", "a and b", "a, b and c" (no Oxford comma). */
function listToProse(parts: readonly string[]): string {
  if (parts.length === 0) return '';
  if (parts.length === 1) return parts[0]!;
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]!}`;
}
