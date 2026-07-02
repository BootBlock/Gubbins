import { describe, it, expect } from 'vitest';
import { handlePermission, reconnectAction, type PersistableDirectoryHandle } from './fs-handle-store';

describe('reconnectAction (FS Access persistence policy, Phase 14)', () => {
  it('reconnects silently when the grant survives', () => {
    expect(reconnectAction('granted')).toBe('connect');
  });

  it('asks for a fresh gesture when the browser would prompt', () => {
    expect(reconnectAction('prompt')).toBe('needs-gesture');
  });

  it('forgets a handle whose grant is gone or unsupported', () => {
    expect(reconnectAction('denied')).toBe('forget');
    expect(reconnectAction('unsupported')).toBe('forget');
  });
});

describe('handlePermission', () => {
  it('reads the readwrite permission state from the handle', async () => {
    const handle: PersistableDirectoryHandle = {
      name: 'Sync',
      queryPermission: async ({ mode }) => (mode === 'readwrite' ? 'granted' : 'denied'),
    };
    await expect(handlePermission(handle)).resolves.toBe('granted');
  });

  it('reports unsupported when the handle predates the permission API', async () => {
    await expect(handlePermission({ name: 'Sync' })).resolves.toBe('unsupported');
  });

  it('reports unsupported when the query throws', async () => {
    const handle: PersistableDirectoryHandle = {
      name: 'Sync',
      queryPermission: async () => {
        throw new Error('boom');
      },
    };
    await expect(handlePermission(handle)).resolves.toBe('unsupported');
  });
});
