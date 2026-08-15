import { describe, expect, it } from 'vitest';
import en from '@/features/i18n/catalogs/en.json';
import { describeNetworkError, isTransportFailure, TRANSPORT_FAILURE_MARKERS } from './network-error-message';

const catalog = en as Record<string, string>;

/** `fetch` rejects with a `TypeError`; the message is the browser's own wording. */
const fetchFailure = (message: string): TypeError => new TypeError(message);

describe('isTransportFailure', () => {
  it.each([
    'Failed to fetch', // Chromium
    'NetworkError when attempting to fetch resource.', // Firefox
    'Load failed', // Safari
    'The network connection was lost.', // Safari
    'The Internet connection appears to be offline.', // Safari (iOS)
    'A server with the specified hostname could not be found.', // Safari
  ])('recognises the browser wording %j', (message) => {
    expect(isTransportFailure(fetchFailure(message))).toBe(true);
  });

  it('rejects a TypeError that is a genuine bug rather than a transport failure', () => {
    // "Check your connection" would send the user somewhere there is nothing to find.
    expect(isTransportFailure(new TypeError('x.map is not a function'))).toBe(false);
    expect(isTransportFailure(new TypeError('Cannot read properties of undefined'))).toBe(false);
  });

  it('rejects an authored sentence that happens to contain a marker fragment', () => {
    // The `TypeError` name is half the signal: our own code never throws one, so a plain `Error`
    // saying "load failed" is somebody's copy and must survive intact.
    expect(isTransportFailure(new Error('The image load failed. Choose another file.'))).toBe(false);
  });

  it('rejects an abort, which in this app means a deliberate cancellation', () => {
    expect(isTransportFailure(new DOMException('The user aborted a request.', 'AbortError'))).toBe(false);
  });

  it('rejects non-Error values', () => {
    expect(isTransportFailure('Failed to fetch')).toBe(false);
    expect(isTransportFailure(undefined)).toBe(false);
  });
});

describe('describeNetworkError', () => {
  it('names being offline when the device knows it has no connection', () => {
    expect(describeNetworkError(fetchFailure('Failed to fetch'), false)).toEqual({
      key: 'network.error.offline',
    });
  });

  it('blames the remote when the device believes it is online', () => {
    expect(describeNetworkError(fetchFailure('Failed to fetch'), true)).toEqual({
      key: 'network.error.unreachable',
    });
  });

  it('returns undefined for anything that is not a transport failure', () => {
    expect(describeNetworkError(new Error('That project is already archived.'), true)).toBeUndefined();
    expect(describeNetworkError(new TypeError('x is not a function'), false)).toBeUndefined();
    expect(describeNetworkError('boom', true)).toBeUndefined();
  });

  it('resolves every key it can emit against the base catalog', () => {
    // The pure module stays catalog-free by design, so `useErrorMessage` casts its keys to
    // `MessageKey`. This is the check that makes the cast safe, and that catches a renamed key.
    for (const online of [true, false]) {
      const described = describeNetworkError(fetchFailure('Failed to fetch'), online);
      expect(described, `online=${online} should describe`).toBeDefined();
      expect(catalog[described!.key], `en["${described!.key}"]`).toBeTypeOf('string');
    }
  });

  it('keeps every marker lower-cased, since matching lower-cases the message', () => {
    for (const marker of TRANSPORT_FAILURE_MARKERS) {
      expect(marker, `${marker} must be lower-case to ever match`).toBe(marker.toLowerCase());
    }
  });
});
