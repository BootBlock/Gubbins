import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';
import type { Alert } from './alerts';
import type { ReminderApi } from './reminder-api';
import type { ReminderPermission } from './reminders';
import { useReminderFiring, useReminderPeriodicSync } from './useReminderNotifications';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';
import { useNotifiedRemindersStore } from './useNotifiedRemindersStore';
import { useReminderWakeStore } from './useReminderWakeStore';

// The hook reads the live alert feed via useAlerts; mock it so tests drive the input directly
// without a database / react-query.
let mockAlerts: Alert[] = [];
vi.mock('./useAlerts', () => ({
  useAlerts: () => ({ alerts: mockAlerts, allAlerts: mockAlerts, isLoading: false, isError: false }),
}));

function alert(id: string, kind: Alert['kind'] = 'low-stock'): Alert {
  return {
    id,
    kind,
    severity: 'warning',
    title: `Alert ${id}`,
    detail: `Detail ${id}`,
    dueAt: null,
    target: { route: '/inventory', itemId: id, itemName: `Item ${id}` },
  };
}

function fakeApi(over: Partial<ReminderApi> = {}): ReminderApi {
  const permission: ReminderPermission = 'granted';
  return {
    supported: true,
    periodicSyncSupported: false,
    permission: () => permission,
    requestPermission: vi.fn(async () => permission),
    show: vi.fn(async () => {}),
    isPeriodicSyncRegistered: vi.fn(async () => false),
    registerPeriodicSync: vi.fn(async () => true),
    unregisterPeriodicSync: vi.fn(async () => {}),
    ...over,
  };
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

beforeEach(() => {
  mockAlerts = [];
  useNotifiedRemindersStore.setState({ notifiedIds: new Set() });
  useReminderWakeStore.setState({ status: 'unknown' });
  usePreferencesStore.setState({ remindersEnabled: true });
});
afterEach(cleanup);

describe('useReminderNotifications', () => {
  it('fires a notification for each new alert and records it as notified', async () => {
    mockAlerts = [alert('a'), alert('b')];
    const api = fakeApi();
    renderHook(() => useReminderFiring(api));
    await flush();

    expect(api.show).toHaveBeenCalledTimes(2);
    expect(useNotifiedRemindersStore.getState().notifiedIds).toEqual(new Set(['a', 'b']));
  });

  it('does not re-fire an already-notified alert on re-render', async () => {
    mockAlerts = [alert('a')];
    const api = fakeApi();
    const { rerender } = renderHook(() => useReminderFiring(api));
    await flush();
    expect(api.show).toHaveBeenCalledTimes(1);

    rerender();
    await flush();
    expect(api.show).toHaveBeenCalledTimes(1);
  });

  it('fires nothing when reminders are disabled', async () => {
    usePreferencesStore.setState({ remindersEnabled: false });
    mockAlerts = [alert('a')];
    const api = fakeApi();
    renderHook(() => useReminderFiring(api));
    await flush();
    expect(api.show).not.toHaveBeenCalled();
  });

  it('fires nothing when permission is not granted', async () => {
    mockAlerts = [alert('a')];
    const api = fakeApi({ permission: () => 'denied' });
    renderHook(() => useReminderFiring(api));
    await flush();
    expect(api.show).not.toHaveBeenCalled();
  });

  it('does nothing when the platform is unsupported', async () => {
    mockAlerts = [alert('a')];
    const api = fakeApi({ supported: false });
    renderHook(() => useReminderFiring(api));
    await flush();
    expect(api.show).not.toHaveBeenCalled();
  });

  it('registers periodic sync when supported, enabled and granted', async () => {
    const api = fakeApi({ periodicSyncSupported: true });
    renderHook(() => useReminderPeriodicSync(api, true));
    await flush();
    expect(api.registerPeriodicSync).toHaveBeenCalled();
    expect(api.unregisterPeriodicSync).not.toHaveBeenCalled();
    expect(useReminderWakeStore.getState().status).toBe('registered');
  });

  it('unregisters periodic sync when disabled but still registered', async () => {
    const api = fakeApi({ periodicSyncSupported: true, isPeriodicSyncRegistered: vi.fn(async () => true) });
    renderHook(() => useReminderPeriodicSync(api, false));
    await flush();
    expect(api.unregisterPeriodicSync).toHaveBeenCalled();
    expect(api.registerPeriodicSync).not.toHaveBeenCalled();
    expect(useReminderWakeStore.getState().status).toBe('unknown');
  });

  // A browser may simply refuse the background wake (Chrome declines it for a site it considers
  // too little used). Reminders still fire while the app is open, so the registration stays
  // best-effort — but the refusal is reported rather than left looking like an unqualified "on".
  it('reports the background wake unavailable when the browser refuses the registration', async () => {
    const api = fakeApi({ periodicSyncSupported: true, registerPeriodicSync: vi.fn(async () => false) });
    renderHook(() => useReminderPeriodicSync(api, true));
    await flush();
    expect(useReminderWakeStore.getState().status).toBe('unavailable');
  });

  it('observes a rejecting seam rather than leaving an unhandled rejection', async () => {
    const api = fakeApi({
      periodicSyncSupported: true,
      registerPeriodicSync: vi.fn(async () => {
        throw new Error('registration failed');
      }),
    });
    renderHook(() => useReminderPeriodicSync(api, true));
    await flush();
    expect(useReminderWakeStore.getState().status).toBe('unavailable');
  });

  it('leaves the reported status alone once the effect is torn down', async () => {
    const api = fakeApi({ periodicSyncSupported: true });
    const { unmount } = renderHook(() => useReminderPeriodicSync(api, true));
    unmount();
    await flush();
    expect(useReminderWakeStore.getState().status).toBe('unknown');
  });
});
