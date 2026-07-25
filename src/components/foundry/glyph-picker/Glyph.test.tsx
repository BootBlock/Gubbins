/**
 * A failed catalogue fetch must not be terminal (issue #315).
 *
 * `<Glyph>` loads the icon catalogue from a lazily-imported chunk. Offline — or behind a stale
 * service worker — that import rejects. These tests pin the two things that has to do: observe
 * the rejection (rather than leaving an unhandled one from a component mounted all over the
 * app) and re-attempt, delivering a later success to the glyphs already on screen.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';

const registryState = vi.hoisted(() => ({ fail: true, loads: 0 }));

vi.mock('./glyph-registry', () => {
  registryState.loads += 1;
  if (registryState.fail) throw new Error('failed to fetch dynamically imported module');
  return {
    GLYPH_NAMES: ['Box'],
    isGlyphName: (name: string) => name === 'Box',
    getGlyphIcon: (name: string) => (name === 'Box' ? () => <svg data-testid="glyph-box" /> : undefined),
  };
});

function Fallback() {
  return <svg data-testid="glyph-fallback" />;
}

beforeEach(() => {
  registryState.fail = true;
  registryState.loads = 0;
  vi.resetModules();
});
afterEach(cleanup);

describe('Glyph', () => {
  it('renders the fallback and observes the rejection when the catalogue chunk fails to load', async () => {
    const { Glyph } = await import('./Glyph');
    render(<Glyph name="Box" fallback={Fallback} />);

    await waitFor(() => expect(registryState.loads).toBe(1));
    expect(await screen.findByTestId('glyph-fallback')).toBeInTheDocument();
  });

  it('re-attempts the load on a later mount, and the retry reaches the glyph already on screen', async () => {
    const { Glyph } = await import('./Glyph');
    // A wrapper so the first glyph keeps its identity across the re-render — the point of the
    // test is that a glyph *already mounted* through the failure picks up the later success.
    const Two = ({ second }: { readonly second: boolean }) => (
      <>
        <Glyph name="Box" fallback={Fallback} />
        {second ? <Glyph name="Box" fallback={Fallback} /> : null}
      </>
    );

    const view = render(<Two second={false} />);
    await waitFor(() => expect(registryState.loads).toBe(1));
    expect(await screen.findByTestId('glyph-fallback')).toBeInTheDocument();

    // A second glyph mounts once the chunk is reachable again. The failed attempt was not
    // cached, so this mount really re-fetches...
    registryState.fail = false;
    view.rerender(<Two second={true} />);

    // ...and both glyphs — including the one that sat through the failure — settle on the real
    // icon, from that single retry.
    await waitFor(() => expect(screen.getAllByTestId('glyph-box')).toHaveLength(2));
    expect(registryState.loads).toBe(2);
    expect(screen.queryByTestId('glyph-fallback')).not.toBeInTheDocument();
  });
});
