/**
 * The Settings surface for a refused background wake-up (issue #315).
 *
 * A browser that declines the periodic background check leaves reminders arriving only while
 * Gubbins is open. These tests pin that the reminders switch stops reading as an unqualified
 * "On" in that case — and that nothing is said when there is nothing to report.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { ReminderSettings } from './ReminderSettings';
import type { ReminderApi } from './reminder-api';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';
import { useReminderWakeStore } from './useReminderWakeStore';

function fakeApi(over: Partial<ReminderApi> = {}): ReminderApi {
  return {
    supported: true,
    periodicSyncSupported: true,
    permission: () => 'granted',
    requestPermission: vi.fn(async () => 'granted' as const),
    show: vi.fn(async () => {}),
    isPeriodicSyncRegistered: vi.fn(async () => false),
    registerPeriodicSync: vi.fn(async () => true),
    unregisterPeriodicSync: vi.fn(async () => {}),
    ...over,
  };
}

beforeEach(() => {
  usePreferencesStore.setState({ remindersEnabled: true });
  useReminderWakeStore.setState({ status: 'unknown' });
});
afterEach(cleanup);

describe('ReminderSettings', () => {
  it('says so when the browser refused the background check', () => {
    useReminderWakeStore.setState({ status: 'unavailable' });
    render(<ReminderSettings apiOverride={fakeApi()} />);
    expect(screen.getByTestId('reminders-background-wake-note')).toBeInTheDocument();
    expect(screen.getByText('Background checks unavailable')).toBeInTheDocument();
  });

  it('stays quiet while the background check is registered', () => {
    useReminderWakeStore.setState({ status: 'registered' });
    render(<ReminderSettings apiOverride={fakeApi()} />);
    expect(screen.queryByTestId('reminders-background-wake-note')).not.toBeInTheDocument();
  });

  it('stays quiet while reminders are off, whatever the background check did', () => {
    usePreferencesStore.setState({ remindersEnabled: false });
    useReminderWakeStore.setState({ status: 'unavailable' });
    render(<ReminderSettings apiOverride={fakeApi()} />);
    expect(screen.queryByTestId('reminders-background-wake-note')).not.toBeInTheDocument();
  });
});
