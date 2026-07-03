import { describe, it, expect } from 'vitest';
import { parseDeepLink } from './deep-link';

describe('parseDeepLink', () => {
  it('parses an item deep link in the authority form', () => {
    expect(parseDeepLink('web+gubbins://item/abc-123')).toEqual({ kind: 'item', id: 'abc-123' });
  });

  it('parses an item deep link in the opaque (no-authority) form', () => {
    expect(parseDeepLink('web+gubbins:item/abc-123')).toEqual({ kind: 'item', id: 'abc-123' });
  });

  it('percent-decodes an id segment', () => {
    expect(parseDeepLink('web+gubbins://item/a%2Fb')).toEqual({ kind: 'item', id: 'a/b' });
  });

  it('parses an add deep link with title/text/url query params', () => {
    const intent = parseDeepLink('web+gubbins://add?title=Resistor%2010k&url=https%3A%2F%2Fexample.test%2Fr');
    expect(intent).toEqual({
      kind: 'add',
      payload: { title: 'Resistor 10k', url: 'https://example.test/r' },
    });
  });

  it('treats a missing item id as unknown', () => {
    expect(parseDeepLink('web+gubbins://item/')).toEqual({ kind: 'unknown' });
    expect(parseDeepLink('web+gubbins://item')).toEqual({ kind: 'unknown' });
  });

  it('rejects a foreign or empty scheme', () => {
    expect(parseDeepLink('https://item/1')).toEqual({ kind: 'unknown' });
    expect(parseDeepLink('web+evil://item/1')).toEqual({ kind: 'unknown' });
    expect(parseDeepLink('')).toEqual({ kind: 'unknown' });
    expect(parseDeepLink('web+gubbins://')).toEqual({ kind: 'unknown' });
  });

  it('treats an unrecognised action as unknown', () => {
    expect(parseDeepLink('web+gubbins://frobnicate/1')).toEqual({ kind: 'unknown' });
  });
});
