/**
 * "Read the scale" panel + its wiring into the weigh-count dialog (issue #122).
 *
 * Rendered through the real {@link WeighCountDialog} rather than in isolation, because the
 * behaviour worth protecting is the *seam*: a pulled reading must land in the gross field in the
 * user's weight unit and then flow through the existing count/delta path unchanged. `fetch` is
 * stubbed, so no bridge and no Home Assistant are involved.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import type { Item } from '@/db/repositories';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';

const spies = vi.hoisted(() => ({ adjust: vi.fn() }));
vi.mock('../mutations', () => ({
  useAdjustQuantity: () => ({ mutate: spies.adjust, isPending: false }),
}));
vi.mock('@/lib/useFormatters', () => ({
  useFormatters: () => ({
    weight: (grams: number) => `${grams} g`,
    currencyParts: () => ({ prefix: '', suffix: '' }),
  }),
}));

import { WeighCountDialog } from './WeighCountDialog';
import { clearScaleEntityCache } from '../scale-entity-cache';

/** The issue #101 worked example: 0.5 g screws, 80 recorded. */
const screws = {
  id: 'item-1',
  name: 'M3 screw',
  trackingMode: 'DISCRETE',
  quantity: 80,
  weight: 0.5,
  isActive: true,
  isUnlimited: false,
  gauge: null,
} as unknown as Item;

const ENTITIES = { entities: [{ entityId: 'sensor.bench', name: 'Bench scale', unit: 'kg' }] };

/** Stub `fetch`, routing the entity-list and state calls to separate canned responses. */
function stubFetch(routes: { entities?: [number, unknown]; state?: [number, unknown] }) {
  const impl = vi.fn(async (url: string) => {
    const [status, payload] = url.includes('/scale/state')
      ? (routes.state ?? [200, {}])
      : (routes.entities ?? [200, ENTITIES]);
    return { status, json: async () => payload } as unknown as Response;
  });
  vi.stubGlobal('fetch', impl);
  return impl;
}

const grossField = () => screen.getByLabelText(/Weight on scale/i);
const tareField = () => screen.getByLabelText(/Container weight/i);

beforeEach(() => {
  spies.adjust.mockReset();
  // The entity list is cached per bridge for the session; clear it so each case starts cold.
  clearScaleEntityCache();
  // A configured bridge is the precondition for the panel appearing at all.
  usePreferencesStore.setState({
    bridgeUrl: 'http://127.0.0.1:8787',
    bridgeToken: 'token',
    scaleEntityId: '',
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('ScaleReadPanel (issue #122)', () => {
  it('reads the scale and fills the gross field in the user’s weight unit', async () => {
    stubFetch({ state: [200, { grams: 43, value: 43, unit: 'g' }] });
    usePreferencesStore.setState({ scaleEntityId: 'sensor.bench' });
    render(<WeighCountDialog item={screws} open onClose={() => {}} />);

    fireEvent.click(await screen.findByTestId('scale-read'));

    // 43 g of 0.5 g screws → 86 units, exactly as if the user had typed 43.
    await waitFor(() => expect(grossField()).toHaveValue('43'));
    expect(screen.getByTestId('weigh-count-result')).toHaveTextContent('86 units');
    expect(screen.getByTestId('weigh-count-scale-source')).toHaveTextContent('43 g');
  });

  it('converts a kilogram reading into the user’s configured unit', async () => {
    // The sensor reports kg; the user reads grams. The bridge hands over canonical grams and the
    // dialog converts once — so the field shows 1250, not 1.25.
    usePreferencesStore.setState({ scaleEntityId: 'sensor.bench', weightUnit: 'g' });
    stubFetch({ state: [200, { grams: 1250, value: 1.25, unit: 'kg' }] });
    render(<WeighCountDialog item={screws} open onClose={() => {}} />);

    fireEvent.click(await screen.findByTestId('scale-read'));

    await waitFor(() => expect(grossField()).toHaveValue('1250'));
    // The hint still quotes what the scale itself said, not the converted figure.
    expect(screen.getByTestId('weigh-count-scale-source')).toHaveTextContent('1.25 kg');
  });

  it('applies a pulled reading through the same delta path as a typed one', async () => {
    usePreferencesStore.setState({ scaleEntityId: 'sensor.bench' });
    stubFetch({ state: [200, { grams: 43, value: 43, unit: 'g' }] });
    render(<WeighCountDialog item={screws} open onClose={() => {}} />);

    fireEvent.click(await screen.findByTestId('scale-read'));
    await waitFor(() => expect(grossField()).toHaveValue('43'));
    fireEvent.click(screen.getByTestId('weigh-count-apply'));

    expect(spies.adjust).toHaveBeenCalledTimes(1);
    expect(spies.adjust.mock.calls[0]![0]).toMatchObject({ id: 'item-1', delta: 6 });
  });

  it('drops the "read from the scale" note once the field is edited by hand', async () => {
    usePreferencesStore.setState({ scaleEntityId: 'sensor.bench' });
    stubFetch({ state: [200, { grams: 43, value: 43, unit: 'g' }] });
    render(<WeighCountDialog item={screws} open onClose={() => {}} />);

    fireEvent.click(await screen.findByTestId('scale-read'));
    await screen.findByTestId('weigh-count-scale-source');

    fireEvent.change(grossField(), { target: { value: '50' } });
    expect(screen.queryByTestId('weigh-count-scale-source')).toBeNull();
  });

  it('surfaces an unusable reading instead of counting it', async () => {
    usePreferencesStore.setState({ scaleEntityId: 'sensor.bench' });
    stubFetch({
      state: [
        409,
        { error: { code: 'scale_unavailable', message: 'The scale is unavailable in Home Assistant.' } },
      ],
    });
    render(<WeighCountDialog item={screws} open onClose={() => {}} />);

    fireEvent.click(await screen.findByTestId('scale-read'));

    expect(await screen.findByTestId('scale-error')).toHaveTextContent(
      'The scale is unavailable in Home Assistant.',
    );
    // The failure is announced, not merely displayed.
    expect(screen.getByTestId('scale-error')).toHaveAttribute('role', 'alert');
    // Critically, nothing was written into the weight field.
    expect(grossField()).toHaveValue('');
    expect(screen.queryByTestId('weigh-count-result')).toBeNull();
  });

  it('stays hidden when no bridge is configured, leaving manual entry untouched', async () => {
    usePreferencesStore.setState({ bridgeUrl: '', bridgeToken: '' });
    const impl = stubFetch({});
    render(<WeighCountDialog item={screws} open onClose={() => {}} />);

    expect(screen.queryByTestId('scale-read')).toBeNull();
    expect(impl).not.toHaveBeenCalled();
    // Manual entry still works exactly as before.
    fireEvent.change(grossField(), { target: { value: '43' } });
    expect(screen.getByTestId('weigh-count-result')).toHaveTextContent('86 units');
  });

  it('stays hidden when the bridge has no Home Assistant opt-in (404)', async () => {
    stubFetch({ entities: [404, { error: { code: 'not_found', message: 'Not found' } }] });
    render(<WeighCountDialog item={screws} open onClose={() => {}} />);

    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(screen.queryByTestId('scale-read')).toBeNull();
  });

  it('stays hidden when Home Assistant reports no weight sensors', async () => {
    stubFetch({ entities: [200, { entities: [] }] });
    render(<WeighCountDialog item={screws} open onClose={() => {}} />);

    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(screen.queryByTestId('scale-read')).toBeNull();
  });

  it('reuses the cached scale list instead of refetching on every open', async () => {
    // The bridge answers this by pulling Home Assistant's whole entity list, so counting a run of
    // items must not re-request it each time.
    const impl = stubFetch({});
    const first = render(<WeighCountDialog item={screws} open onClose={() => {}} />);
    await screen.findByTestId('scale-read');
    expect(impl).toHaveBeenCalledTimes(1);

    first.unmount();
    render(<WeighCountDialog item={screws} open onClose={() => {}} />);
    await screen.findByTestId('scale-read');
    expect(impl).toHaveBeenCalledTimes(1);
  });

  it('does not cache a failed listing, so a transient outage is retried', async () => {
    const impl = stubFetch({ entities: [502, { error: { code: 'home_assistant_unreachable' } }] });
    const first = render(<WeighCountDialog item={screws} open onClose={() => {}} />);
    await waitFor(() => expect(impl).toHaveBeenCalledTimes(1));

    first.unmount();
    render(<WeighCountDialog item={screws} open onClose={() => {}} />);
    await waitFor(() => expect(impl).toHaveBeenCalledTimes(2));
  });

  it('will not read until a scale is chosen', async () => {
    // No `scaleEntityId` persisted: the picker is offered but the button is inert, so a stray
    // click cannot pull a reading from an arbitrary sensor.
    stubFetch({});
    render(<WeighCountDialog item={screws} open onClose={() => {}} />);
    expect(await screen.findByTestId('scale-read')).toBeDisabled();
  });

  it('treats a saved scale that no longer exists as unchosen', async () => {
    usePreferencesStore.setState({ scaleEntityId: 'sensor.removed' });
    stubFetch({});
    render(<WeighCountDialog item={screws} open onClose={() => {}} />);

    // The stale id must not silently read from the wrong sensor.
    expect(await screen.findByTestId('scale-read')).toBeDisabled();
  });

  describe('taring from the scale (issue #124 §5)', () => {
    it('fills the container field from the same scale, leaving the gross field alone', async () => {
      usePreferencesStore.setState({ scaleEntityId: 'sensor.bench' });
      stubFetch({ state: [200, { grams: 12, value: 12, unit: 'g' }] });
      render(<WeighCountDialog item={screws} open onClose={() => {}} />);

      fireEvent.click(await screen.findByTestId('scale-read-tare'));

      await waitFor(() => expect(tareField()).toHaveValue('12'));
      expect(grossField()).toHaveValue('');
      expect(screen.getByTestId('weigh-count-tare-source')).toHaveTextContent('12 g');
      // The gross field's own note must not appear — nothing was read into it.
      expect(screen.queryByTestId('weigh-count-scale-source')).toBeNull();
    });

    it('counts the net weight once both the tray and the parts have been weighed', async () => {
      // Weigh the empty tray (12 g), then the tray with parts (55 g): 43 g of 0.5 g screws → 86.
      usePreferencesStore.setState({ scaleEntityId: 'sensor.bench' });
      stubFetch({ state: [200, { grams: 12, value: 12, unit: 'g' }] });
      render(<WeighCountDialog item={screws} open onClose={() => {}} />);

      fireEvent.click(await screen.findByTestId('scale-read-tare'));
      await waitFor(() => expect(tareField()).toHaveValue('12'));

      stubFetch({ state: [200, { grams: 55, value: 55, unit: 'g' }] });
      fireEvent.click(screen.getByTestId('scale-read'));
      await waitFor(() => expect(grossField()).toHaveValue('55'));

      expect(screen.getByTestId('weigh-count-result')).toHaveTextContent('86 units');
    });

    it('drops the container note once that field is edited by hand', async () => {
      usePreferencesStore.setState({ scaleEntityId: 'sensor.bench' });
      stubFetch({ state: [200, { grams: 12, value: 12, unit: 'g' }] });
      render(<WeighCountDialog item={screws} open onClose={() => {}} />);

      fireEvent.click(await screen.findByTestId('scale-read-tare'));
      await screen.findByTestId('weigh-count-tare-source');

      fireEvent.change(tareField(), { target: { value: '20' } });
      expect(screen.queryByTestId('weigh-count-tare-source')).toBeNull();
    });

    it('will not read a container weight until a scale is chosen', async () => {
      stubFetch({});
      render(<WeighCountDialog item={screws} open onClose={() => {}} />);
      expect(await screen.findByTestId('scale-read-tare')).toBeDisabled();
    });
  });

  describe('refreshing the scale list (issue #124 §4)', () => {
    it('re-asks the bridge, so a scale just added in Home Assistant appears without a reload', async () => {
      const impl = stubFetch({});
      render(<WeighCountDialog item={screws} open onClose={() => {}} />);
      await screen.findByTestId('scale-read');
      expect(impl).toHaveBeenCalledTimes(1);

      // A second scale has since been added in Home Assistant.
      stubFetch({
        entities: [
          200,
          {
            entities: [
              ...ENTITIES.entities,
              { entityId: 'sensor.kitchen', name: 'Kitchen scale', unit: 'g' },
            ],
          },
        ],
      });
      fireEvent.click(screen.getByTestId('scale-refresh'));

      await waitFor(() => expect(screen.getByTestId('scale-entity-select')).toBeInTheDocument());
      fireEvent.click(screen.getByTestId('scale-entity-select'));
      expect(await screen.findByText('Kitchen scale')).toBeInTheDocument();
    });

    it('keeps the existing list when a refresh fails, and says why', async () => {
      // A blip while refreshing must not take the whole panel — refresh control included — off
      // the screen, stranding the user with no way to try again.
      stubFetch({});
      render(<WeighCountDialog item={screws} open onClose={() => {}} />);
      await screen.findByTestId('scale-read');

      stubFetch({ entities: [502, { error: { code: 'home_assistant_unreachable' } }] });
      fireEvent.click(screen.getByTestId('scale-refresh'));

      expect(await screen.findByTestId('scale-error')).toHaveTextContent(/could not reach Home Assistant/i);
      expect(screen.getByTestId('scale-read')).toBeInTheDocument();
      expect(screen.getByTestId('scale-refresh')).toBeEnabled();
    });

    it('names the refresh control for screen readers, since it is icon-only', async () => {
      stubFetch({});
      render(<WeighCountDialog item={screws} open onClose={() => {}} />);

      expect(await screen.findByTestId('scale-refresh')).toHaveAccessibleName('Refresh the list of scales');
    });
  });
});

/**
 * Watching the scale live (issue #125).
 *
 * Driven through the same real dialog, with a **controllable** stream: the test pushes frames one
 * at a time, so the settle window's behaviour is observed rather than raced. What matters here is
 * that a moving reading is never presented as a count, and never applied on its own.
 */
describe('ScaleReadPanel — watching (issue #125)', () => {
  /** Hand back a `fetch` that serves the entity list, plus a stream the test writes into. */
  function stubStream() {
    const encoder = new TextEncoder();
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    let aborted = false;
    const impl = vi.fn(async (url: string, init?: { signal?: AbortSignal }) => {
      if (!url.includes('/scale/stream')) {
        return { status: 200, json: async () => ENTITIES } as unknown as Response;
      }
      init?.signal?.addEventListener('abort', () => {
        aborted = true;
      });
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          controller = c;
        },
      });
      return { status: 200, json: async () => undefined, body } as unknown as Response;
    });
    vi.stubGlobal('fetch', impl);
    return {
      /** Push one reading, in grams, as the bridge would frame it. */
      async sample(grams: number) {
        const reading = { entityId: 'sensor.bench', grams, value: grams, unit: 'g' };
        controller?.enqueue(encoder.encode(`data: ${JSON.stringify({ ok: true, reading })}\n\n`));
        await waitFor(() => expect(grossField()).toHaveValue(String(grams)));
      },
      /** Push a failure frame. */
      fail(issue: string) {
        controller?.enqueue(encoder.encode(`data: ${JSON.stringify({ ok: false, issue })}\n\n`));
      },
      wasAborted: () => aborted,
    };
  }

  /** Start a watch on a chosen scale and wait for the panel to be live. */
  async function startWatching() {
    usePreferencesStore.setState({ scaleEntityId: 'sensor.bench' });
    const stream = stubStream();
    render(<WeighCountDialog item={screws} open onClose={() => {}} />);
    fireEvent.click(await screen.findByTestId('scale-watch'));
    return stream;
  }

  it('fills the gross field from each sample and shows the count as provisional', async () => {
    const stream = await startWatching();
    await stream.sample(43);

    // The reading has landed, but one sample proves nothing about whether the pan has stopped.
    expect(await screen.findByTestId('weigh-count-result')).toHaveTextContent('Settling…');
    expect(screen.getByTestId('weigh-count-apply')).toBeDisabled();
    expect(screen.getByTestId('scale-watch-status')).toHaveTextContent(/waiting for the reading to settle/i);
  });

  it('shows the count once consecutive samples agree', async () => {
    const stream = await startWatching();
    await stream.sample(43);
    await stream.sample(43);
    await stream.sample(43);

    // 43 g of 0.5 g screws is 86, against 80 recorded.
    await waitFor(() => expect(screen.getByTestId('weigh-count-result')).toHaveTextContent('86 units'));
    expect(screen.getByTestId('weigh-count-apply')).toBeEnabled();
    expect(screen.getByTestId('scale-watch-status')).toHaveTextContent(/has settled/i);
  });

  // Tipping a second handful in is a new weight, not a nudge to the old one.
  it('re-opens the settle when the weight jumps, and withholds the count again', async () => {
    const stream = await startWatching();
    await stream.sample(43);
    await stream.sample(43);
    await stream.sample(43);
    await waitFor(() => expect(screen.getByTestId('weigh-count-result')).toHaveTextContent('86 units'));

    await stream.sample(60);
    await waitFor(() => expect(screen.getByTestId('weigh-count-result')).toHaveTextContent('Settling…'));
    expect(screen.getByTestId('weigh-count-apply')).toBeDisabled();
  });

  // A live reading is never applied automatically — the user still confirms, exactly as for a
  // typed figure, and this is the check that no watch can write stock on its own.
  it('never applies a reading on its own', async () => {
    const stream = await startWatching();
    await stream.sample(43);
    await stream.sample(43);
    await stream.sample(43);
    await waitFor(() => expect(screen.getByTestId('weigh-count-apply')).toBeEnabled());
    expect(spies.adjust).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('weigh-count-apply'));
    expect(spies.adjust).toHaveBeenCalledTimes(1);
  });

  it('closes the stream when the watch is switched off', async () => {
    const stream = await startWatching();
    await stream.sample(43);

    fireEvent.click(screen.getByTestId('scale-watch'));
    await waitFor(() => expect(stream.wasAborted()).toBe(true));
    expect(screen.getByTestId('scale-watch-status')).toBeEmptyDOMElement();
  });

  // Nothing keeps reading the user's scale once nobody is looking at it.
  it('closes the stream when the dialog closes', async () => {
    const stream = await startWatching();
    await stream.sample(43);

    cleanup();
    await waitFor(() => expect(stream.wasAborted()).toBe(true));
  });

  it('reports a failure frame without ending the watch', async () => {
    const stream = await startWatching();
    await stream.sample(43);
    stream.fail('unavailable');

    expect(await screen.findByTestId('scale-error')).toHaveTextContent(/scale is unavailable/i);
    expect(screen.getByTestId('scale-watch')).toHaveAttribute('aria-pressed', 'true');
  });

  // The one-shot buttons write the same field four times a second slower, so a pull landing
  // mid-watch would be overwritten before it was read.
  it('disables the one-shot reads while watching', async () => {
    await startWatching();
    await waitFor(() => expect(screen.getByTestId('scale-read')).toBeDisabled());
    expect(screen.getByTestId('scale-read-tare')).toBeDisabled();
  });
});
