/**
 * A tiny, hand-rolled iCalendar (RFC 5545) emitter — EI-2.
 *
 * Same posture as the bridge's other encoders (the JSON-RPC framing, the mDNS wire format,
 * the OpenAPI YAML emitter): a small, RFC-specified subset written by hand rather than a
 * dependency (CLAUDE.md "minimal dependency surface"; the plan's stdlib-first invariant). It
 * covers exactly what the calendar feed needs and nothing more:
 *
 *   - `BEGIN/END:VCALENDAR` with `VERSION`, `PRODID`, `CALSCALE`, `METHOD` and an optional
 *     `X-WR-CALNAME` (the de-facto "calendar name" hint most clients honour);
 *   - one `VEVENT` per row with a stable `UID`, a `DTSTAMP`, a `DTSTART` (+ optional `DTEND`),
 *     `SUMMARY`, and optional `DESCRIPTION` / `CATEGORIES`;
 *   - **all-day** dates (`VALUE=DATE`, `YYYYMMDD`) and **timed** UTC date-times
 *     (`YYYYMMDDTHHMMSSZ`);
 *   - RFC 5545 §3.3.11 TEXT escaping (`\ ; , \n`) and §3.1 line folding at 75 octets.
 *
 * Pure and deterministic: no clock, no I/O, no DB. Every value is passed in, so each rule
 * unit-tests directly. Output uses CRLF line endings (RFC 5545 §3.1) and always ends with a
 * final CRLF.
 */

/** A single content line's maximum length in octets before it must be folded (RFC 5545 §3.1). */
const MAX_LINE_OCTETS = 75;

/**
 * An iCalendar date value: either an **all-day** `DATE` (`YYYYMMDD`, rendered with a
 * `VALUE=DATE` parameter) or a **timed** UTC `DATE-TIME` (`YYYYMMDDTHHMMSSZ`). Callers build
 * these through {@link icalDate} / {@link icalDateTimeUtc} / {@link icalDateFromIso} so the
 * string form is always well-formed.
 */
export interface ICalDate {
  readonly kind: 'date' | 'date-time';
  /** `YYYYMMDD` for a DATE; `YYYYMMDDTHHMMSSZ` for a UTC DATE-TIME. */
  readonly value: string;
}

/** One calendar event. `dtstamp` must be a timed UTC value (RFC 5545 requires DTSTAMP be UTC). */
export interface VEvent {
  /** Globally-unique, **stable** identifier so subscribers update in place, not duplicate. */
  readonly uid: string;
  /** When this event object was assembled (UTC) — the feed uses the snapshot's generation time. */
  readonly dtstamp: ICalDate;
  readonly start: ICalDate;
  /** Optional end. For an all-day event it is **exclusive** (the day after the last day). */
  readonly end?: ICalDate;
  readonly summary: string;
  readonly description?: string;
  readonly categories?: readonly string[];
}

/** A whole calendar: its product id, an optional display name, and its events. */
export interface VCalendar {
  readonly prodId: string;
  readonly calName?: string;
  readonly events: readonly VEvent[];
}

/** Two-digit zero-pad for date/time components. */
function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/**
 * An all-day `DATE` value derived from a UNIX-ms instant, using **UTC** calendar components.
 *
 * The bridge does not know the user's timezone, so an instant that represents a *local* day
 * start (e.g. a booking day) is read in UTC. For most of the world this is the intended day; a
 * far-eastern-timezone local midnight can land on the previous UTC day — a documented, minor
 * limitation of a timezone-less feed. Values that are already calendar dates (a warranty
 * `YYYY-MM-DD` string) avoid this entirely via {@link icalDateFromIso}.
 */
export function icalDate(unixMs: number): ICalDate {
  const d = new Date(unixMs);
  const value = `${d.getUTCFullYear()}${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())}`;
  return { kind: 'date', value };
}

/** A timed UTC `DATE-TIME` value (`YYYYMMDDTHHMMSSZ`) from a UNIX-ms instant. */
export function icalDateTimeUtc(unixMs: number): ICalDate {
  const d = new Date(unixMs);
  const value =
    `${d.getUTCFullYear()}${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())}` +
    `T${pad2(d.getUTCHours())}${pad2(d.getUTCMinutes())}${pad2(d.getUTCSeconds())}Z`;
  return { kind: 'date-time', value };
}

/**
 * An all-day `DATE` value from an ISO calendar-date string (`YYYY-MM-DD`, how the app stores
 * `warranty_expires_at`). Returns `null` for anything not matching that exact shape, so a
 * malformed value is skipped rather than emitting a broken date. No timezone maths — the date
 * is used verbatim.
 */
export function icalDateFromIso(iso: string): ICalDate | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso.trim());
  if (match === null) return null;
  return { kind: 'date', value: `${match[1]}${match[2]}${match[3]}` };
}

/**
 * Return the all-day `DATE` `days` after `date`. Used to compute an all-day event's
 * **exclusive** `DTEND` (RFC 5545 §3.8.2.2: an all-day DTEND is the day *after* the last day).
 * Only valid for a `DATE` value; a `DATE-TIME` is returned unchanged.
 */
export function addDays(date: ICalDate, days: number): ICalDate {
  if (date.kind !== 'date') return date;
  const y = Number(date.value.slice(0, 4));
  const m = Number(date.value.slice(4, 6));
  const d = Number(date.value.slice(6, 8));
  // Build in UTC so the arithmetic never drifts across a DST boundary (there is none in UTC).
  return icalDate(Date.UTC(y, m - 1, d + days));
}

/**
 * Escape a value for an iCalendar TEXT field (RFC 5545 §3.3.11): backslash, then the
 * structural `;` and `,`, then CR/LF collapse to the literal `\n` escape. Applied to every
 * human string (SUMMARY / DESCRIPTION / UID / each CATEGORY value / PRODID / calendar name).
 */
export function escapeText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}

/**
 * Fold one content line to ≤ {@link MAX_LINE_OCTETS} octets (RFC 5545 §3.1) by inserting
 * `CRLF` + a single leading space between physical lines. Folding happens on **code-point**
 * boundaries (never mid-character): each physical line stays within the octet budget, and a
 * continuation line's leading space counts toward its 75. A reader unfolds by stripping the
 * `CRLF ` before parsing, reconstructing the original line exactly.
 */
export function foldLine(line: string): string {
  // Fast path: already short enough (ASCII-common case), no per-char accounting needed.
  if (Buffer.byteLength(line, 'utf8') <= MAX_LINE_OCTETS) return line;

  const pieces: string[] = [];
  let current = '';
  let currentOctets = 0;
  let first = true;
  for (const ch of line) {
    const chOctets = Buffer.byteLength(ch, 'utf8');
    // A continuation line begins with a space that eats one of the 75 octets.
    const budget = MAX_LINE_OCTETS - (first ? 0 : 1);
    if (current.length > 0 && currentOctets + chOctets > budget) {
      pieces.push(first ? current : ` ${current}`);
      first = false;
      current = '';
      currentOctets = 0;
    }
    current += ch;
    currentOctets += chOctets;
  }
  pieces.push(first ? current : ` ${current}`);
  return pieces.join('\r\n');
}

/** Render a `DATE`/`DATE-TIME` property line (adds `;VALUE=DATE` for an all-day value). */
function dateProperty(name: string, date: ICalDate): string {
  return date.kind === 'date' ? `${name};VALUE=DATE:${date.value}` : `${name}:${date.value}`;
}

/** The (unfolded) content lines of one VEVENT, in RFC-conventional order. */
function eventLines(event: VEvent): string[] {
  const lines: string[] = ['BEGIN:VEVENT', `UID:${escapeText(event.uid)}`];
  lines.push(dateProperty('DTSTAMP', event.dtstamp));
  lines.push(dateProperty('DTSTART', event.start));
  if (event.end !== undefined) lines.push(dateProperty('DTEND', event.end));
  lines.push(`SUMMARY:${escapeText(event.summary)}`);
  if (event.description !== undefined && event.description.length > 0) {
    lines.push(`DESCRIPTION:${escapeText(event.description)}`);
  }
  if (event.categories !== undefined && event.categories.length > 0) {
    // CATEGORIES is a comma-separated TEXT list; escaping each value keeps a comma *inside*
    // a category from being read as a separator.
    lines.push(`CATEGORIES:${event.categories.map(escapeText).join(',')}`);
  }
  lines.push('END:VEVENT');
  return lines;
}

/**
 * Emit a complete `VCALENDAR` document. Every content line is TEXT-escaped where applicable
 * and folded to the octet limit; lines are joined with CRLF and the document ends with a
 * trailing CRLF, as RFC 5545 expects.
 */
export function formatCalendar(calendar: VCalendar): string {
  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:${escapeText(calendar.prodId)}`,
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
  ];
  if (calendar.calName !== undefined && calendar.calName.length > 0) {
    lines.push(`X-WR-CALNAME:${escapeText(calendar.calName)}`);
  }
  for (const event of calendar.events) lines.push(...eventLines(event));
  lines.push('END:VCALENDAR');
  return `${lines.map(foldLine).join('\r\n')}\r\n`;
}
