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
});
