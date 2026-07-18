/**
 * Pure iCalendar emitter tests (EI-2): TEXT escaping, 75-octet line folding, date formatting
 * (all-day DATE, timed UTC DATE-TIME, ISO-string, exclusive-end arithmetic), and the overall
 * VCALENDAR/VEVENT structure. No DB, no I/O — every rule is exercised directly.
 */
import { describe, expect, it } from 'vitest';
import {
  addDays,
  escapeText,
  foldLine,
  formatCalendar,
  icalDate,
  icalDateFromIso,
  icalDateTimeUtc,
  type VEvent,
} from './emitter.ts';

describe('escapeText', () => {
  it('escapes backslash, semicolon, comma and newlines (RFC 5545 §3.3.11)', () => {
    expect(escapeText('a;b,c\\d')).toBe('a\\;b\\,c\\\\d');
    expect(escapeText('line1\nline2')).toBe('line1\\nline2');
    expect(escapeText('crlf\r\nhere')).toBe('crlf\\nhere');
  });

  it('escapes the backslash first so an escaped char is not double-escaped', () => {
    // A literal backslash followed by a semicolon → escaped backslash + escaped semicolon.
    expect(escapeText('\\;')).toBe('\\\\\\;');
  });

  it('leaves a colon untouched (colons are legal in TEXT values)', () => {
    expect(escapeText('Loan due: Drill')).toBe('Loan due: Drill');
  });
});

describe('date formatting', () => {
  it('formats an all-day DATE in UTC components', () => {
    expect(icalDate(1751000000000)).toEqual({ kind: 'date', value: '20250627' });
  });

  it('formats a timed UTC DATE-TIME with a trailing Z', () => {
    expect(icalDateTimeUtc(1751000000000)).toEqual({ kind: 'date-time', value: '20250627T045320Z' });
  });

  it('converts an ISO calendar-date string verbatim (no timezone maths)', () => {
    expect(icalDateFromIso('2027-03-15')).toEqual({ kind: 'date', value: '20270315' });
    expect(icalDateFromIso('  2028-01-20 ')).toEqual({ kind: 'date', value: '20280120' });
  });

  it('rejects a malformed ISO date', () => {
    expect(icalDateFromIso('2027-3-15')).toBeNull();
    expect(icalDateFromIso('not-a-date')).toBeNull();
    expect(icalDateFromIso('2027-03-15T00:00:00Z')).toBeNull();
  });

  it('adds days for an exclusive all-day end, rolling across month and year boundaries', () => {
    expect(addDays({ kind: 'date', value: '20270315' }, 1)).toEqual({ kind: 'date', value: '20270316' });
    expect(addDays({ kind: 'date', value: '20270331' }, 1)).toEqual({ kind: 'date', value: '20270401' });
    expect(addDays({ kind: 'date', value: '20271231' }, 1)).toEqual({ kind: 'date', value: '20280101' });
  });

  it('leaves a DATE-TIME untouched when asked to add days', () => {
    const dt = { kind: 'date-time', value: '20250627T045320Z' } as const;
    expect(addDays(dt, 1)).toEqual(dt);
  });
});

describe('foldLine', () => {
  it('leaves a short line unfolded', () => {
    expect(foldLine('SUMMARY:short')).toBe('SUMMARY:short');
  });

  it('folds a long line at ≤75 octets with CRLF + a leading space, and unfolds cleanly', () => {
    const line = `DESCRIPTION:${'x'.repeat(200)}`;
    const folded = foldLine(line);
    expect(folded).toContain('\r\n ');
    // Every physical line is within the octet budget.
    for (const physical of folded.split('\r\n')) {
      expect(Buffer.byteLength(physical, 'utf8')).toBeLessThanOrEqual(75);
    }
    // Unfolding (strip CRLF + the single continuation space) reconstructs the original.
    expect(
      folded
        .split('\r\n')
        .map((l, i) => (i === 0 ? l : l.slice(1)))
        .join(''),
    ).toBe(line);
  });

  it('never splits a multi-byte character across a fold', () => {
    const line = `SUMMARY:${'é'.repeat(80)}`; // each é is 2 octets in UTF-8
    const folded = foldLine(line);
    for (const physical of folded.split('\r\n')) {
      expect(Buffer.byteLength(physical, 'utf8')).toBeLessThanOrEqual(75);
      // No replacement char — a clean decode means no character was cut in half.
      expect(physical).not.toContain('�');
    }
  });
});

describe('formatCalendar', () => {
  const dtstamp = icalDateTimeUtc(1751000000000);

  function event(overrides: Partial<VEvent> = {}): VEvent {
    return {
      uid: 'warranty-item-esp32@gubbins.invalid',
      dtstamp,
      start: { kind: 'date', value: '20270615' },
      end: { kind: 'date', value: '20270616' },
      summary: 'Warranty expires: ESP32 Dev Board',
      categories: ['Gubbins', 'Warranty'],
      ...overrides,
    };
  }

  it('emits a well-formed VCALENDAR with CRLF endings and a trailing CRLF', () => {
    const out = formatCalendar({
      prodId: '-//Gubbins//Bridge Calendar//EN',
      calName: 'Gubbins',
      events: [event()],
    });
    expect(out.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true);
    expect(out.endsWith('END:VCALENDAR\r\n')).toBe(true);
    expect(out).toContain('VERSION:2.0\r\n');
    expect(out).toContain('PRODID:-//Gubbins//Bridge Calendar//EN\r\n');
    expect(out).toContain('X-WR-CALNAME:Gubbins\r\n');
  });

  it('emits no METHOD, so clients treat it as a subscribable feed and not an invitation', () => {
    const out = formatCalendar({ prodId: 'p', calName: 'Gubbins', events: [event()] });
    expect(out).not.toContain('METHOD:');
  });

  it('renders an all-day VEVENT with VALUE=DATE start/end, UID, DTSTAMP, SUMMARY and CATEGORIES', () => {
    const out = formatCalendar({ prodId: 'p', events: [event()] });
    expect(out).toContain('BEGIN:VEVENT\r\n');
    expect(out).toContain('UID:warranty-item-esp32@gubbins.invalid\r\n');
    expect(out).toContain('DTSTAMP:20250627T045320Z\r\n');
    expect(out).toContain('DTSTART;VALUE=DATE:20270615\r\n');
    expect(out).toContain('DTEND;VALUE=DATE:20270616\r\n');
    expect(out).toContain('SUMMARY:Warranty expires: ESP32 Dev Board\r\n');
    expect(out).toContain('CATEGORIES:Gubbins,Warranty\r\n');
    expect(out).toContain('END:VEVENT\r\n');
  });

  it('omits DTEND, DESCRIPTION and CATEGORIES when absent/empty', () => {
    const out = formatCalendar({
      prodId: 'p',
      events: [event({ end: undefined, description: '', categories: [] })],
    });
    expect(out).not.toContain('DTEND');
    expect(out).not.toContain('DESCRIPTION');
    expect(out).not.toContain('CATEGORIES');
  });

  it('escapes structural characters in the SUMMARY/DESCRIPTION', () => {
    const out = formatCalendar({
      prodId: 'p',
      events: [event({ summary: 'A; B, C', description: 'note\nline' })],
    });
    expect(out).toContain('SUMMARY:A\\; B\\, C\r\n');
    expect(out).toContain('DESCRIPTION:note\\nline\r\n');
  });
});
