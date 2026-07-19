import { describe, it, expect, afterEach } from 'vitest';
import { ensureStorageWritable, setStorageWriteGate, writeSuspendedError } from './write-gate';

afterEach(() => setStorageWriteGate(null));

describe('ensureStorageWritable', () => {
  it('resolves when no gate is installed — the Bridge and the test suite run unchecked', async () => {
    await expect(ensureStorageWritable()).resolves.toBeUndefined();
  });

  it('resolves when the installed gate permits the write', async () => {
    setStorageWriteGate(async () => {});
    await expect(ensureStorageWritable()).resolves.toBeUndefined();
  });

  it('propagates the gate’s WRITE_SUSPENDED rejection to the caller', async () => {
    setStorageWriteGate(async () => {
      throw writeSuspendedError();
    });
    await expect(ensureStorageWritable()).rejects.toMatchObject({ code: 'WRITE_SUSPENDED' });
  });

  it('stops consulting a gate once it is removed', async () => {
    setStorageWriteGate(async () => {
      throw writeSuspendedError();
    });
    setStorageWriteGate(null);
    await expect(ensureStorageWritable()).resolves.toBeUndefined();
  });
});
