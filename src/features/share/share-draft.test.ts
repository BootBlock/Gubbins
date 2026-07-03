import { describe, it, expect } from 'vitest';
import { buildShareDraft } from './share-draft';

describe('buildShareDraft', () => {
  it('maps a shared title + Amazon URL to a name, ASIN mpn, scraper seed, and provenance note', () => {
    const draft = buildShareDraft({
      title: 'USB-C Cable',
      url: 'https://www.amazon.co.uk/dp/B0F3XF5ZKF?ref=synthetic',
    });
    expect(draft.name).toBe('USB-C Cable');
    expect(draft.mpn).toBe('B0F3XF5ZKF');
    expect(draft.sourceUrl).toBe('https://www.amazon.co.uk/dp/B0F3XF5ZKF?ref=synthetic');
    expect(draft.notes).toContain('Added via Share to Gubbins.');
    expect(draft.notes).toContain('Source: https://www.amazon.co.uk/dp/B0F3XF5ZKF');
    expect(draft.notes).toContain('Amazon ASIN: B0F3XF5ZKF');
  });

  it('recovers a URL the OS packed into the text field (common on Android)', () => {
    const draft = buildShareDraft({
      title: 'Widget bracket',
      text: 'Check this out https://example.test/widget/42',
    });
    expect(draft.sourceUrl).toBe('https://example.test/widget/42');
    expect(draft.name).toBe('Widget bracket');
    expect(draft.notes).toContain('Source: https://example.test/widget/42');
  });

  it('falls back to the first meaningful line of text for the name', () => {
    const draft = buildShareDraft({ text: 'Brass M3 standoffs\nassorted lengths' });
    expect(draft.name).toBe('Brass M3 standoffs');
    // The full prose is preserved as a provenance note (nothing shared is dropped).
    expect(draft.notes).toContain('Brass M3 standoffs assorted lengths');
    expect(draft.mpn).toBeUndefined();
    expect(draft.sourceUrl).toBeUndefined();
  });

  it('uses the URL host as a last-resort name when only a bare link is shared', () => {
    const draft = buildShareDraft({ url: 'https://www.digikey.test/product/ABC' });
    expect(draft.name).toBe('digikey.test');
    expect(draft.sourceUrl).toBe('https://www.digikey.test/product/ABC');
  });

  it('does not repeat the shared text in the note when it is merely the name or the URL', () => {
    const draft = buildShareDraft({ text: 'https://example.test/x' });
    // The bare URL appears only in the "Source: …" line — never echoed again as a standalone
    // prose line.
    const standaloneEchoes = draft.notes?.split('\n').filter((l) => l === 'https://example.test/x') ?? [];
    expect(standaloneEchoes).toHaveLength(0);
    expect(draft.notes).toContain('Source: https://example.test/x');
  });

  it('records a shared image filename in the note', () => {
    const draft = buildShareDraft({ title: 'Photo of part', imageName: 'part.jpg' });
    expect(draft.notes).toContain('Shared image: part.jpg');
  });

  it('produces a still-usable (name-less) draft for an empty share', () => {
    const draft = buildShareDraft({});
    expect(draft.name).toBeUndefined();
    expect(draft.mpn).toBeUndefined();
    expect(draft.notes).toBe('Added via Share to Gubbins.');
  });
});
