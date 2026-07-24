import { describe, expect, it } from 'vitest';

import { uuidv5 } from './derived-uuid';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** The RFC 4122 DNS namespace, used for the published test vector. */
const DNS_NAMESPACE = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';

describe('uuidv5', () => {
  it('matches the canonical RFC 4122 test vector', async () => {
    // The published example: v5(name="www.example.com", ns=DNS) is a fixed UUID. Getting this
    // exact value proves the namespace-then-name SHA-1 hashing and the version/variant bit-set
    // are all correct — not just "some stable string".
    expect(await uuidv5('www.example.com', DNS_NAMESPACE)).toBe('2ed6657d-e927-568b-95e1-2665a8aea6a2');
  });

  it('is a canonical, version-5 UUID', async () => {
    const id = await uuidv5('anything', DNS_NAMESPACE);
    expect(id).toMatch(UUID_RE);
    expect(id[14]).toBe('5'); // version nibble
    expect(['8', '9', 'a', 'b']).toContain(id[19]); // RFC 4122 variant
  });

  it('is deterministic for the same (name, namespace) and distinct otherwise', async () => {
    expect(await uuidv5('a', DNS_NAMESPACE)).toBe(await uuidv5('a', DNS_NAMESPACE));
    expect(await uuidv5('a', DNS_NAMESPACE)).not.toBe(await uuidv5('b', DNS_NAMESPACE));
  });
});
