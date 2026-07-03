import { describe, it, expect, beforeEach, vi } from 'vitest';
import { parseShareForm, stashShare, readShare, clearShare, pruneStaleShares } from './share-inbox';

describe('parseShareForm', () => {
  it('reads title/text/url and an image file into the stash shape', () => {
    const form = new FormData();
    form.set('title', 'Widget');
    form.set('text', 'a note');
    form.set('url', 'https://example.test/w');
    form.set('image', new File([new Uint8Array([1, 2, 3])], 'shot.png', { type: 'image/png' }));

    const { payload, image } = parseShareForm(form);
    expect(payload).toEqual({
      title: 'Widget',
      text: 'a note',
      url: 'https://example.test/w',
      imageName: 'shot.png',
    });
    expect(image).toBeInstanceOf(File);
    expect(image?.type).toBe('image/png');
  });

  it('ignores blank fields and a zero-byte image', () => {
    const form = new FormData();
    form.set('title', '   ');
    form.set('image', new File([], 'empty.png', { type: 'image/png' }));
    const { payload, image } = parseShareForm(form);
    expect(payload).toEqual({});
    expect(image).toBeNull();
  });
});

/** A minimal in-memory CacheStorage, keyed by normalised request URL — enough for the inbox. */
function installFakeCaches(): void {
  const caches = new Map<string, Map<string, Response>>();
  const keyOf = (req: RequestInfo | URL): string => {
    if (typeof req === 'string') return new URL(req).href;
    if (req instanceof URL) return req.href;
    return (req as Request).url;
  };
  const fake = {
    open: async (name: string) => {
      let cache = caches.get(name);
      if (!cache) caches.set(name, (cache = new Map()));
      return {
        put: async (req: RequestInfo | URL, res: Response) => void cache!.set(keyOf(req), res),
        match: async (req: RequestInfo | URL) => cache!.get(keyOf(req)),
        delete: async (req: RequestInfo | URL) => cache!.delete(keyOf(req)),
        keys: async () => [...cache!.keys()].map((url) => new Request(url)),
      };
    },
  };
  vi.stubGlobal('caches', fake);
}

describe('share inbox cache round-trip', () => {
  beforeEach(() => {
    installFakeCaches();
  });

  it('stashes and reads back a text payload, then clears it (one-shot)', async () => {
    const id = 'test-id-1';
    await stashShare(id, { payload: { title: 'Cable', url: 'https://example.test/c' }, image: null });

    const back = await readShare(id);
    expect(back?.payload).toEqual({ title: 'Cable', url: 'https://example.test/c' });
    expect(back?.image).toBeNull();

    await clearShare(id);
    expect(await readShare(id)).toBeNull();
  });

  it('round-trips a shared image blob', async () => {
    const id = 'test-id-2';
    const image = new File([new Uint8Array([9, 9, 9])], 'p.png', { type: 'image/png' });
    await stashShare(id, { payload: { imageName: 'p.png' }, image });

    const back = await readShare(id);
    expect(back?.payload.imageName).toBe('p.png');
    expect(back?.image).not.toBeNull();
    expect(await back!.image!.arrayBuffer()).toEqual(new Uint8Array([9, 9, 9]).buffer);
  });

  it('returns null for an unknown id', async () => {
    expect(await readShare('nope')).toBeNull();
  });

  it('prunes shares older than the max age but keeps a just-stashed one', async () => {
    await stashShare('fresh', { payload: { title: 'Fresh' }, image: null });

    // A sweep "now" leaves the just-stashed entry alone.
    await pruneStaleShares(Date.now());
    expect(await readShare('fresh')).not.toBeNull();

    // A sweep from two hours in the future reclaims it (past the 1-hour window).
    await pruneStaleShares(Date.now() + 2 * 60 * 60 * 1000);
    expect(await readShare('fresh')).toBeNull();
  });

  it('reclaims both the meta and image entries of a stale share', async () => {
    const image = new File([new Uint8Array([7])], 's.png', { type: 'image/png' });
    await stashShare('with-image', { payload: { imageName: 's.png' }, image });
    await pruneStaleShares(Date.now() + 2 * 60 * 60 * 1000);
    expect(await readShare('with-image')).toBeNull();
  });
});
