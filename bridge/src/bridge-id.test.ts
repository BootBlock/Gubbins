/**
 * Bridge-identity tests (issue #672) — the pure resolution order and the id's shape.
 *
 * The point of every case here is that an id a consumer keys on must be **stable**: the tests pin
 * the order the four sources are tried in, and pin the one thing that must never happen — a random
 * id that could not be persisted being handed out anyway, which would change on each restart.
 */
import { describe, expect, it } from 'vitest';
import {
  MAX_BRIDGE_ID_LENGTH,
  deriveBridgeId,
  parseBridgeId,
  resolveBridgeId,
  type BridgeIdIo,
} from './bridge-id.ts';

/** A fake {@link BridgeIdIo} that records what it was asked to do. */
function fakeIo(
  overrides: Partial<BridgeIdIo> & { persisted?: string | undefined; writable?: boolean } = {},
): BridgeIdIo & { written: string[]; warnings: string[] } {
  const written: string[] = [];
  const warnings: string[] = [];
  return {
    written,
    warnings,
    readPersisted: () => overrides.persisted,
    persist: (id: string) => {
      if (overrides.writable === false) return false;
      written.push(id);
      return true;
    },
    mint: overrides.mint ?? (() => 'minted-0000'),
    hostname: overrides.hostname ?? (() => 'workshop-nas'),
    warn: (message: string) => void warnings.push(message),
  };
}

describe('parseBridgeId', () => {
  it('accepts a plain identifier and trims it', () => {
    expect(parseBridgeId('  8f14e45f-ceea-467a-9f39-2b0d1e5a77cc \n')).toBe(
      '8f14e45f-ceea-467a-9f39-2b0d1e5a77cc',
    );
    expect(parseBridgeId('workshop-nas-8787')).toBe('workshop-nas-8787');
  });

  it('rejects blank, over-long and unsafe values', () => {
    expect(parseBridgeId(undefined)).toBeUndefined();
    expect(parseBridgeId('   ')).toBeUndefined();
    expect(parseBridgeId('a'.repeat(MAX_BRIDGE_ID_LENGTH + 1))).toBeUndefined();
    // A space or an `=` would split the DNS-SD TXT entry the id travels in.
    expect(parseBridgeId('two words')).toBeUndefined();
    expect(parseBridgeId('id=oops')).toBeUndefined();
  });
});

describe('deriveBridgeId', () => {
  it('folds the hostname into a safe label and keeps the port', () => {
    expect(deriveBridgeId('Workshop NAS.local', 8787)).toBe('workshop-nas-local-8787');
  });

  it('falls back to a fixed label when the hostname yields nothing usable', () => {
    expect(deriveBridgeId('...', 9000)).toBe('gubbins-bridge-9000');
  });

  it('distinguishes two bridges on the same machine by port', () => {
    expect(deriveBridgeId('nas', 8787)).not.toBe(deriveBridgeId('nas', 8788));
  });

  it('caps a long hostname without leaving a dangling separator', () => {
    const id = deriveBridgeId(`${'a'.repeat(40)}-suffix`, 8787);
    expect(id).toBe(`${'a'.repeat(40)}-8787`);
    expect(parseBridgeId(id)).toBe(id);
  });
});

describe('resolveBridgeId', () => {
  it('prefers the operator-pinned id and never touches the file', () => {
    const io = fakeIo({ persisted: 'persisted-id' });
    expect(resolveBridgeId('pinned-id', 8787, io)).toEqual({ id: 'pinned-id', source: 'configured' });
    expect(io.written).toEqual([]);
  });

  it('uses the persisted id when there is no pinned one', () => {
    const io = fakeIo({ persisted: 'persisted-id' });
    expect(resolveBridgeId(undefined, 8787, io)).toEqual({ id: 'persisted-id', source: 'persisted' });
    expect(io.written).toEqual([]);
  });

  it('mints and persists an id on a first start', () => {
    const io = fakeIo({ mint: () => 'fresh-id' });
    expect(resolveBridgeId(undefined, 8787, io)).toEqual({ id: 'fresh-id', source: 'minted' });
    expect(io.written).toEqual(['fresh-id']);
    expect(io.warnings).toEqual([]);
  });

  // The one case that must not regress: an id that could not be saved would be different on the
  // next start, so the *derived* value is handed out instead — stable, and honestly warned about.
  it('never hands out an unpersistable random id, deriving a stable one instead', () => {
    const io = fakeIo({ mint: () => 'fresh-id', writable: false });
    expect(resolveBridgeId(undefined, 8787, io)).toEqual({
      id: 'workshop-nas-8787',
      source: 'derived',
    });
    expect(io.written).toEqual([]);
    expect(io.warnings).toHaveLength(1);
    expect(io.warnings[0]).toContain('GUBBINS_BRIDGE_ID');
  });
});
