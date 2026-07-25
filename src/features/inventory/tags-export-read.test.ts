/**
 * The tag export reads the *filtered* dictionary, page by page (issues #132 + #137).
 *
 * Two features met on this screen: the export re-reads every page rather than serialising the
 * page on screen, and the dictionary gained a filter and sort. Composing them wrongly is silent
 * in both directions — dropping `browse` exports rows the user had just narrowed away, and
 * letting `browse` override the walk's `limit`/`offset` would re-read one page forever. These
 * pin the composition rather than trusting the spread order.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const list = vi.hoisted(() => vi.fn(async () => ({ rows: [], hasMore: false })));
vi.mock('@/db/repositories', () => ({ getTagRepository: () => ({ list }) }));

const { readTagDictionaryPage } = await import('./tags');

beforeEach(() => list.mockClear());

describe('readTagDictionaryPage', () => {
  it('passes the screen’s filter and sort to the repository', async () => {
    await readTagDictionaryPage({ search: 'frag', sort: 'USAGE_DESC' })({ limit: 100, offset: 0 });
    expect(list).toHaveBeenCalledWith({ search: 'frag', sort: 'USAGE_DESC', limit: 100, offset: 0 });
  });

  it('reads the unfiltered dictionary when the screen is not narrowed', async () => {
    await readTagDictionaryPage()({ limit: 100, offset: 0 });
    expect(list).toHaveBeenCalledWith({ limit: 100, offset: 0 });
  });

  it('lets the walk own limit and offset, so a page can never pin itself', async () => {
    // `browse` is spread first deliberately: were it spread last, a stray limit/offset on it
    // would override the walk's and re-read the same page until the ceiling stopped it.
    const browse = { search: 'frag', limit: 5, offset: 999 } as Parameters<typeof readTagDictionaryPage>[0];
    await readTagDictionaryPage(browse)({ limit: 100, offset: 200 });
    expect(list).toHaveBeenCalledWith(expect.objectContaining({ limit: 100, offset: 200 }));
  });

  it('advances through pages as the walk asks for them', async () => {
    const read = readTagDictionaryPage({ search: 'frag' });
    await read({ limit: 100, offset: 0 });
    await read({ limit: 100, offset: 100 });
    expect(list.mock.calls.map((c) => (c[0] as { offset: number }).offset)).toEqual([0, 100]);
  });
});
