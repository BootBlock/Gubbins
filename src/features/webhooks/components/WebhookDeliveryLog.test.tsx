/**
 * Delivery-log rendering tests, focused on the row that has no event behind it (issue #643).
 *
 * A subscription whose bridge-held secret is missing is refused before any event is considered, so
 * its row names no event type. The row must still read as a refusal rather than as a delivery of
 * something unnamed.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { WebhookDeliveryLog } from './WebhookDeliveryLog';
import type { WebhookDelivery } from '../bridge-client';

afterEach(cleanup);

const DELIVERY: WebhookDelivery = {
  seq: 1,
  at: 1_751_000_000_000,
  targetId: 'w1',
  targetName: 'Workshop notifier',
  source: 'database',
  url: 'https://hooks.example.test/inventory',
  method: 'POST',
  eventId: 'e1',
  eventType: 'item.low_stock',
  outcome: 'delivered',
  attempts: 1,
  status: 204,
  detail: null,
};

function renderLog(deliveries: readonly WebhookDelivery[]) {
  return render(<WebhookDeliveryLog state={{ status: 'ready', deliveries }} onRefresh={() => {}} />);
}

describe('WebhookDeliveryLog', () => {
  it('shows the event type of an ordinary delivery', () => {
    renderLog([DELIVERY]);
    expect(screen.getByText('item.low_stock')).toBeTruthy();
  });

  it('shows a blocked subscription with its reason and no invented event type', () => {
    const { container } = renderLog([
      {
        ...DELIVERY,
        eventId: '',
        eventType: '',
        outcome: 'blocked',
        attempts: 0,
        status: null,
        detail: 'Webhook "Workshop notifier" references a bridge-side secret named "discord".',
      },
    ]);
    expect(screen.getByText(/Blocked/i)).toBeTruthy();
    expect(screen.getByText(/references a bridge-side secret/)).toBeTruthy();
    // The slot the event type occupies for an ordinary delivery is left out entirely, rather than
    // rendered empty: there was no event, so the row must not keep a place for one.
    const empty = [...container.querySelectorAll('span')].filter((el) => el.textContent === '');
    expect(empty).toEqual([]);
  });
});
