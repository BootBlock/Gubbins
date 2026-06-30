import { describe, it, expect } from 'vitest';
import {
  buildItemQrUrl,
  buildLocationQrUrl,
  isUuid,
  parseScannedCode,
  parseScannedItemId,
} from './scan-payload';
import { CooldownMap, COOLDOWN_WINDOW_MS } from './cooldown';
import {
  initialScannerState,
  scannerReducer,
  isStreaming,
  type ScannerState,
} from './scanner-machine';
import { dueDateFromDays, daysUntil, dueStatus, isOverdue, MS_PER_DAY } from './due-date';
import { encodeQr, qrSvg, QrError } from './qr-code';
import { emptyQueue, queueReducer } from './queue-reducer';

const UUID = '00000000-0000-4000-8000-0000000000ab';

describe('scan-payload', () => {
  it('builds a parseable deep-link URL', () => {
    const url = buildItemQrUrl(UUID, 'https://example.com/Gubbins/');
    expect(url).toBe(`https://example.com/Gubbins/#/inventory?item=${UUID}`);
    expect(parseScannedItemId(url)).toBe(UUID);
  });

  it('round-trips through buildItemQrUrl → parseScannedItemId', () => {
    expect(parseScannedItemId(buildItemQrUrl(UUID, 'https://x.test/Gubbins/'))).toBe(UUID);
  });

  it('accepts a bare UUID and a namespaced token', () => {
    expect(parseScannedItemId(UUID)).toBe(UUID);
    expect(parseScannedItemId(`gubbins:item:${UUID}`)).toBe(UUID);
    expect(parseScannedItemId(UUID.toUpperCase())).toBe(UUID);
  });

  it('rejects non-Gubbins payloads', () => {
    expect(parseScannedItemId('hello world')).toBeNull();
    expect(parseScannedItemId('https://example.com/other')).toBeNull();
    expect(parseScannedItemId('')).toBeNull();
    expect(isUuid('not-a-uuid')).toBe(false);
  });

  it('parses a location deep-link and namespaced token (Phase 73)', () => {
    const url = buildLocationQrUrl(UUID, 'https://example.com/Gubbins/');
    expect(url).toBe(`https://example.com/Gubbins/#/inventory?location=${UUID}`);
    expect(parseScannedCode(url)).toEqual({ kind: 'location', id: UUID });
    expect(parseScannedCode(`gubbins:location:${UUID}`)).toEqual({ kind: 'location', id: UUID });
    // A location code is never mistaken for an item.
    expect(parseScannedItemId(url)).toBeNull();
  });

  it('classifies item codes as kind item, including bare UUIDs', () => {
    expect(parseScannedCode(UUID)).toEqual({ kind: 'item', id: UUID });
    expect(parseScannedCode(buildItemQrUrl(UUID, 'https://x.test/Gubbins/'))).toEqual({
      kind: 'item',
      id: UUID,
    });
    expect(parseScannedCode(`gubbins:item:${UUID}`)).toEqual({ kind: 'item', id: UUID });
    expect(parseScannedCode('hello world')).toBeNull();
  });
});

describe('CooldownMap (§6.4)', () => {
  it('ignores a repeat within the 2000 ms window', () => {
    const map = new CooldownMap();
    expect(map.accept('A', 0)).toBe(true);
    expect(map.accept('A', 1999)).toBe(false);
    expect(map.accept('A', 2000)).toBe(true); // window elapsed
  });

  it('tracks distinct codes independently', () => {
    const map = new CooldownMap();
    expect(map.accept('A', 0)).toBe(true);
    expect(map.accept('B', 100)).toBe(true);
    expect(map.accept('A', 100)).toBe(false);
  });

  it('defaults to the spec window and prunes/clears', () => {
    expect(COOLDOWN_WINDOW_MS).toBe(2000);
    const map = new CooldownMap();
    map.accept('A', 0);
    map.prune(3000);
    expect(map.accept('A', 3001)).toBe(true);
    map.clear();
    expect(map.accept('A', 3002)).toBe(true);
  });
});

describe('scannerReducer (§6.2)', () => {
  const open = (s: ScannerState) => scannerReducer(s, { type: 'OPEN' });

  it('runs the happy path IDLE → REQUESTING → STREAM_ACTIVE', () => {
    let s = initialScannerState();
    expect(s.status).toBe('IDLE');
    s = open(s);
    expect(s.status).toBe('REQUESTING_PERMISSIONS');
    s = scannerReducer(s, { type: 'PERMISSION_GRANTED' });
    expect(s.status).toBe('STREAM_ACTIVE');
    expect(isStreaming(s.status)).toBe(true);
  });

  it('moves to ERROR_STATE on denial and recovers via OPEN', () => {
    let s = open(initialScannerState());
    s = scannerReducer(s, { type: 'PERMISSION_DENIED' });
    expect(s.status).toBe('ERROR_STATE');
    expect(s.error).toBeTruthy();
    s = open(s);
    expect(s.status).toBe('REQUESTING_PERMISSIONS');
    expect(s.error).toBeNull();
  });

  it('toggles between STREAM_ACTIVE and PROCESSING_QUEUE', () => {
    let s = scannerReducer(open(initialScannerState()), { type: 'PERMISSION_GRANTED' });
    s = scannerReducer(s, { type: 'REVIEW_QUEUE' });
    expect(s.status).toBe('PROCESSING_QUEUE');
    s = scannerReducer(s, { type: 'RESUME_SCANNING' });
    expect(s.status).toBe('STREAM_ACTIVE');
  });

  it('SUSPEND tears an active stream down to IDLE; no-op when idle', () => {
    let s = scannerReducer(open(initialScannerState()), { type: 'PERMISSION_GRANTED' });
    s = scannerReducer(s, { type: 'SUSPEND' });
    expect(s.status).toBe('IDLE');
    expect(scannerReducer(s, { type: 'SUSPEND' })).toBe(s);
  });

  it('changes mode without disturbing the lifecycle', () => {
    let s = scannerReducer(open(initialScannerState()), { type: 'PERMISSION_GRANTED' });
    s = scannerReducer(s, { type: 'SET_MODE', mode: 'CONTINUOUS' });
    expect(s.mode).toBe('CONTINUOUS');
    expect(s.status).toBe('STREAM_ACTIVE');
  });

  it('CLOSE always returns to IDLE', () => {
    const s = scannerReducer(open(initialScannerState()), { type: 'CLOSE' });
    expect(s.status).toBe('IDLE');
  });
});

describe('due-date maths (§4)', () => {
  it('converts days to an absolute due date, null for non-positive', () => {
    expect(dueDateFromDays(7, 0)).toBe(7 * MS_PER_DAY);
    expect(dueDateFromDays(0)).toBeNull();
    expect(dueDateFromDays(-3)).toBeNull();
    expect(dueDateFromDays(Number.NaN)).toBeNull();
  });

  it('computes whole days until due (negative when overdue)', () => {
    expect(daysUntil(5 * MS_PER_DAY, 0)).toBe(5);
    expect(daysUntil(0, 3 * MS_PER_DAY)).toBe(-3);
  });

  it('classifies due status and overdue', () => {
    const now = 10 * MS_PER_DAY;
    expect(dueStatus(null, now)).toBe('NONE');
    expect(dueStatus(now - MS_PER_DAY, now)).toBe('OVERDUE');
    expect(dueStatus(now + MS_PER_DAY, now)).toBe('DUE_SOON');
    expect(dueStatus(now + 10 * MS_PER_DAY, now)).toBe('UPCOMING');
    expect(isOverdue(now - 1, now)).toBe(true);
    expect(isOverdue(null, now)).toBe(false);
  });
});

describe('queueReducer (Continuous-Checkout queue, §6.3)', () => {
  const entry = (itemId: string) => ({ itemId, name: null, scannedAt: 0 });

  it('adds entries and de-duplicates by item id', () => {
    let s = queueReducer(emptyQueue, { type: 'ADD', entry: entry('a') });
    s = queueReducer(s, { type: 'ADD', entry: entry('b') });
    expect(s.entries).toHaveLength(2);
    const same = queueReducer(s, { type: 'ADD', entry: entry('a') });
    expect(same).toBe(s); // duplicate ignored, identity preserved
  });

  it('removes and clears', () => {
    let s = queueReducer(emptyQueue, { type: 'ADD', entry: entry('a') });
    s = queueReducer(s, { type: 'ADD', entry: entry('b') });
    s = queueReducer(s, { type: 'REMOVE', itemId: 'a' });
    expect(s.entries.map((e) => e.itemId)).toEqual(['b']);
    expect(queueReducer(s, { type: 'CLEAR' }).entries).toHaveLength(0);
  });
});

describe('QR encoder (§2.4.3 lean, §5)', () => {
  it('encodes a short string to a version-1 21×21 matrix', () => {
    const m = encodeQr('HI');
    expect(m.version).toBe(1);
    expect(m.size).toBe(21);
    expect(m.modules).toHaveLength(21);
  });

  it('places the three finder patterns (dark corners)', () => {
    const m = encodeQr('GUBBINS');
    // Finder centres are dark; the module just outside the pattern is light.
    expect(m.modules[3][3]).toBe(true);
    expect(m.modules[3][m.size - 4]).toBe(true);
    expect(m.modules[m.size - 4][3]).toBe(true);
  });

  it('grows the version with the payload and is deterministic', () => {
    const url = `https://example.com/Gubbins/#/inventory?item=${UUID}`;
    const a = encodeQr(url);
    const b = encodeQr(url);
    expect(a.version).toBeGreaterThanOrEqual(2);
    expect(a.modules).toEqual(b.modules);
  });

  it('renders an SVG and rejects an over-large payload', () => {
    const svg = qrSvg(`https://example.com/Gubbins/#/inventory?item=${UUID}`);
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toContain('<path');
    expect(() => encodeQr('x'.repeat(200))).toThrow(QrError);
  });
});
