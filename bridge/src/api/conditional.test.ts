/**
 * Unit tests for the conditional-request seam (issue #363): how a feed's validators are derived,
 * and exactly when a conditional poll is answered `304 Not Modified`.
 */
import { describe, expect, it } from 'vitest';
import { cacheValidators, isNotModified, readConditionalHeaders, snapshotInstant } from './conditional.ts';

const AT = Date.parse('2026-07-11T09:15:30.000Z');

describe('cacheValidators', () => {
  it('derives a weak entity-tag and an IMF-fixdate Last-Modified', () => {
    const validators = cacheValidators(AT, 'calendar all');
    expect(validators.etag).toMatch(/^W\/"[A-Za-z0-9_-]+"$/);
    expect(validators.lastModified).toBe('Sat, 11 Jul 2026 09:15:30 GMT');
  });

  it('gives the same tag for the same variant and instant, and different tags for different variants', () => {
    expect(cacheValidators(AT, 'calendar all').etag).toBe(cacheValidators(AT, 'calendar all').etag);
    expect(cacheValidators(AT, 'calendar all').etag).not.toBe(cacheValidators(AT, 'calendar loans').etag);
  });

  it('changes the tag when the representation changes', () => {
    expect(cacheValidators(AT + 60_000, 'calendar all').etag).not.toBe(
      cacheValidators(AT, 'calendar all').etag,
    );
  });

  it('never leaks the variant (which may carry a ?token=) into the tag', () => {
    const validators = cacheValidators(
      AT,
      'activity rss http://localhost:8787/api/v1/activity.rss?token=sekrit',
    );
    expect(validators.etag).not.toContain('sekrit');
  });

  it('floors to whole seconds so the two validators can never disagree', () => {
    // Last-Modified has no sub-second resolution: two instants inside the same second describe
    // the same Last-Modified, so they must also share an entity-tag.
    expect(cacheValidators(AT + 400, 'metrics')).toEqual(cacheValidators(AT + 900, 'metrics'));
  });
});

describe('isNotModified', () => {
  const validators = cacheValidators(AT, 'calendar all');

  it('is false when the client sent no conditional header at all', () => {
    expect(isNotModified(undefined, validators)).toBe(false);
    expect(isNotModified({}, validators)).toBe(false);
  });

  it('matches the entity-tag we would serve', () => {
    expect(isNotModified({ ifNoneMatch: validators.etag }, validators)).toBe(true);
  });

  it('compares weakly, so a client that dropped or added the W/ prefix still matches', () => {
    const opaque = validators.etag.slice(2);
    expect(isNotModified({ ifNoneMatch: opaque }, validators)).toBe(true);
  });

  it('matches any tag in a list, and the * wildcard', () => {
    expect(isNotModified({ ifNoneMatch: `W/"stale", ${validators.etag}` }, validators)).toBe(true);
    expect(isNotModified({ ifNoneMatch: '*' }, validators)).toBe(true);
  });

  it('is false for a tag from a different representation', () => {
    const other = cacheValidators(AT, 'calendar loans');
    expect(isNotModified({ ifNoneMatch: other.etag }, validators)).toBe(false);
  });

  it('honours If-Modified-Since when no entity-tag was sent', () => {
    expect(isNotModified({ ifModifiedSince: validators.lastModified }, validators)).toBe(true);
    expect(isNotModified({ ifModifiedSince: 'Sat, 11 Jul 2026 10:00:00 GMT' }, validators)).toBe(true);
    expect(isNotModified({ ifModifiedSince: 'Sat, 11 Jul 2026 09:00:00 GMT' }, validators)).toBe(false);
  });

  it('ignores an unparseable If-Modified-Since rather than guessing (sends the full response)', () => {
    expect(isNotModified({ ifModifiedSince: 'whenever' }, validators)).toBe(false);
  });

  it('lets If-None-Match win outright when both headers are sent (RFC 9110 §13.2.2)', () => {
    // The date says "still current", the tag says otherwise — the tag is the stronger signal, so
    // the answer is the full response.
    expect(
      isNotModified(
        { ifNoneMatch: 'W/"something-else"', ifModifiedSince: 'Sat, 11 Jul 2026 10:00:00 GMT' },
        validators,
      ),
    ).toBe(false);
  });
});

describe('readConditionalHeaders', () => {
  it('reads both headers, and omits the ones the client did not send', () => {
    expect(readConditionalHeaders({ 'if-none-match': 'W/"abc"', 'if-modified-since': 'x' })).toEqual({
      ifNoneMatch: 'W/"abc"',
      ifModifiedSince: 'x',
    });
    expect(readConditionalHeaders({})).toEqual({});
  });
});

describe('snapshotInstant', () => {
  it('parses an ISO stamp back to UNIX-ms', () => {
    expect(snapshotInstant('2026-07-11T09:15:30.000Z')).toBe(AT);
  });

  it('is null when there is nothing honest to validate against', () => {
    expect(snapshotInstant(null)).toBeNull();
    expect(snapshotInstant('not a date')).toBeNull();
  });
});
