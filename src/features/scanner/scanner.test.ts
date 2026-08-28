import { describe, it, expect } from 'vitest';
import {
  asOpenableLink,
  buildItemQrUrl,
  buildLocationQrUrl,
  isInsecureLabelBaseUrl,
  isShortItemCode,
  isStructuredQrPayload,
  isUuid,
  parseScannedCode,
  parseScannedItemId,
  resolveLabelBaseUrl,
} from './scan-payload';
import { shortId } from '@/features/inventory/labels/label-template';
import { CooldownMap, COOLDOWN_WINDOW_MS } from './cooldown';
import { initialScannerState, scannerReducer, isStreaming, type ScannerState } from './scanner-machine';
import { dueDateFromDays, daysUntil, dueStatus, isOverdue, MS_PER_DAY } from './due-date';
import {
  BinaryBitmap,
  DecodeHintType,
  HybridBinarizer,
  QRCodeReader,
  RGBLuminanceSource,
} from '@zxing/library';
import {
  encodeQr,
  qrSvg,
  qrSvgOrNull,
  fitsInQr,
  qrModuleCount,
  MAX_QR_BYTES,
  MAX_QR_MODULE_COUNT,
  QR_QUIET_ZONE_MODULES,
  QrError,
} from './qr-code';
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

  describe('isShortItemCode — the label fallback identifier (issue #338)', () => {
    it('recognises exactly what shortId prints, whatever the id', () => {
      // The guard against drift: the printed form and the recognised form are pinned together,
      // so changing how a short code is derived without changing this fails here.
      for (const id of [
        UUID,
        '11111111-1111-4111-8111-111111111111',
        'a1b2c3d4-3333-4333-8333-333333333333',
      ]) {
        expect(isShortItemCode(shortId(id))).toBe(true);
      }
    });

    it('accepts either case and surrounding whitespace', () => {
      expect(isShortItemCode('a1b2c3d4')).toBe(true);
      expect(isShortItemCode('A1B2C3D4')).toBe(true);
      expect(isShortItemCode('  A1B2C3D4  ')).toBe(true);
    });

    it('rejects anything that is not eight hex characters', () => {
      expect(isShortItemCode('A1B2C3D')).toBe(false); // too short
      expect(isShortItemCode('A1B2C3D4E')).toBe(false); // too long
      expect(isShortItemCode('A1B2C3DZ')).toBe(false); // Z is not hex
      expect(isShortItemCode('A1B2C3D%')).toBe(false); // a LIKE wildcard must never get through
      expect(isShortItemCode(UUID)).toBe(false);
      expect(isShortItemCode('')).toBe(false);
    });

    it('is not itself a ScannedCode kind — a short code names nothing without a lookup', () => {
      expect(parseScannedCode('A1B2C3D4')).toBeNull();
    });
  });

  describe('structured-QR detection (issue #59)', () => {
    it('flags website links and structured URIs as not-a-barcode', () => {
      expect(isStructuredQrPayload('https://wa.me/message/ABCDEFGHIJ?src=qr')).toBe(true);
      expect(isStructuredQrPayload('http://example.com/promo')).toBe(true);
      expect(isStructuredQrPayload('whatsapp://send?phone=123')).toBe(true);
      expect(isStructuredQrPayload('mailto:hello@example.com')).toBe(true);
      expect(isStructuredQrPayload('tel:+15551234567')).toBe(true);
      expect(isStructuredQrPayload('WIFI:S:MyNet;T:WPA;P:secret;;')).toBe(true);
      expect(isStructuredQrPayload('BEGIN:VCARD\nFN:Ada\nEND:VCARD')).toBe(true);
      expect(isStructuredQrPayload('wa.me/message/ABCDEFGHIJ')).toBe(true); // scheme-less domain
    });

    it('does not flag genuine barcodes or plain part labels', () => {
      expect(isStructuredQrPayload('4006381333931')).toBe(false); // EAN-13
      expect(isStructuredQrPayload('ABC-123-XYZ')).toBe(false); // Code 128 part label
      expect(isStructuredQrPayload('RES-4K7-0805')).toBe(false);
      expect(isStructuredQrPayload('')).toBe(false);
    });
  });

  describe('asOpenableLink (issue #59)', () => {
    it('returns a safe http(s) URL, promoting a scheme-less domain to https', () => {
      expect(asOpenableLink('https://wa.me/message/AB?src=qr')).toBe('https://wa.me/message/AB?src=qr');
      expect(asOpenableLink('wa.me/message/AB')).toBe('https://wa.me/message/AB');
    });

    it('refuses non-http(s) schemes and non-links', () => {
      expect(asOpenableLink('mailto:hello@example.com')).toBeNull();
      expect(asOpenableLink('tel:+15551234567')).toBeNull();
      expect(asOpenableLink('javascript:alert(1)')).toBeNull();
      expect(asOpenableLink('4006381333931')).toBeNull();
      expect(asOpenableLink('ABC-123')).toBeNull();
    });
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

  it('classifies a valid retail barcode as kind gtin (unknown-product fallback)', () => {
    expect(parseScannedCode('4006381333931')).toEqual({ kind: 'gtin', gtin: '4006381333931' });
    expect(parseScannedCode(' 036000291452 ')).toEqual({ kind: 'gtin', gtin: '036000291452' });
    // A Gubbins code is never re-classified as a GTIN, and a plain barcode is not an item.
    expect(parseScannedItemId('4006381333931')).toBeNull();
    // A bad check digit is not a GTIN (stays unrecognised).
    expect(parseScannedCode('4006381333930')).toBeNull();
  });
});

describe('resolveLabelBaseUrl (Link host override)', () => {
  it('derives origin + base path when no override is set', () => {
    expect(resolveLabelBaseUrl('', 'http://localhost:5173', '/Gubbins/')).toBe(
      'http://localhost:5173/Gubbins/',
    );
    expect(resolveLabelBaseUrl('   ', 'http://localhost:5173', '/Gubbins/')).toBe(
      'http://localhost:5173/Gubbins/',
    );
  });

  it('uses a full override URL verbatim, ignoring origin and base path', () => {
    expect(resolveLabelBaseUrl('https://gubbins.local/Gubbins/', 'http://localhost:5173', '/Gubbins/')).toBe(
      'https://gubbins.local/Gubbins/',
    );
  });

  // Issue #509: the old guess was `http://`, which is not a secure context — Gubbins cannot boot
  // there, so every label printed against it scanned to the boot-failure screen.
  it('assumes https:// for a scheme-less host, keeping any port', () => {
    expect(resolveLabelBaseUrl('gubbins.local', 'http://localhost:5173', '/Gubbins/')).toBe(
      'https://gubbins.local/',
    );
    expect(resolveLabelBaseUrl('gubbins.local:8080', 'http://localhost:5173', '/Gubbins/')).toBe(
      'https://gubbins.local:8080/',
    );
  });

  it('keeps http:// for a scheme-less loopback host, which is a secure context', () => {
    expect(resolveLabelBaseUrl('localhost:5173', 'http://localhost:5173', '/Gubbins/')).toBe(
      'http://localhost:5173/',
    );
    expect(resolveLabelBaseUrl('127.0.0.1:5173', 'http://localhost:5173', '/Gubbins/')).toBe(
      'http://127.0.0.1:5173/',
    );
  });

  it('leaves an explicit scheme alone, even the one the app cannot boot from', () => {
    expect(resolveLabelBaseUrl('http://gubbins.local/', 'http://localhost:5173', '/Gubbins/')).toBe(
      'http://gubbins.local/',
    );
  });

  it('feeds a parseable deep-link so the override round-trips through the scanner', () => {
    const base = resolveLabelBaseUrl('gubbins.local', 'http://localhost:5173', '/Gubbins/');
    expect(parseScannedItemId(buildItemQrUrl(UUID, base))).toBe(UUID);
  });

  it('flags only a non-loopback plain-http base as unbootable', () => {
    expect(isInsecureLabelBaseUrl('http://gubbins.local/')).toBe(true);
    expect(isInsecureLabelBaseUrl('http://192.168.1.20:5173/')).toBe(true);
    expect(isInsecureLabelBaseUrl('https://gubbins.local/')).toBe(false);
    expect(isInsecureLabelBaseUrl('http://localhost:5173/')).toBe(false);
    expect(isInsecureLabelBaseUrl('http://127.0.0.1:5173/')).toBe(false);
    expect(isInsecureLabelBaseUrl('http://[::1]:5173/')).toBe(false);
    // A hash-only fallback base is not a URL at all, and is nothing to warn about.
    expect(isInsecureLabelBaseUrl('#')).toBe(false);
  });

  it('falls back to the derived default on an unparseable override', () => {
    expect(resolveLabelBaseUrl('http://', 'http://localhost:5173', '/Gubbins/')).toBe(
      'http://localhost:5173/Gubbins/',
    );
  });

  it('returns a hash-only link when there is no origin and no usable override', () => {
    expect(resolveLabelBaseUrl('', null, '/Gubbins/')).toBe('#');
    // …but an absolute override still resolves without a DOM origin.
    expect(resolveLabelBaseUrl('https://gubbins.local/', null, '/Gubbins/')).toBe('https://gubbins.local/');
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

  it('REOPEN re-requests from the live view, so a camera swap has one acquisition path (issue #135)', () => {
    const live = scannerReducer(open(initialScannerState()), { type: 'PERMISSION_GRANTED' });
    const reopening = scannerReducer(live, { type: 'REOPEN' });
    expect(reopening.status).toBe('REQUESTING_PERMISSIONS');
    expect(reopening.error).toBeNull();
    expect(scannerReducer(reopening, { type: 'PERMISSION_GRANTED' }).status).toBe('STREAM_ACTIVE');
  });

  it('REOPEN is a no-op anywhere the camera menu is not on screen', () => {
    // Only the live view offers the picker: from IDLE/ERROR the way in is OPEN, and from the batch
    // review pane a re-request would discard the queue the user is standing in.
    const idle = initialScannerState();
    expect(scannerReducer(idle, { type: 'REOPEN' })).toBe(idle);
    const requesting = open(idle);
    expect(scannerReducer(requesting, { type: 'REOPEN' })).toBe(requesting);
    const denied = scannerReducer(requesting, { type: 'PERMISSION_DENIED' });
    expect(scannerReducer(denied, { type: 'REOPEN' })).toBe(denied);
    const reviewing = scannerReducer(scannerReducer(requesting, { type: 'PERMISSION_GRANTED' }), {
      type: 'REVIEW_QUEUE',
    });
    expect(scannerReducer(reviewing, { type: 'REOPEN' })).toBe(reviewing);
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

  it('renders an SVG and rejects a payload past the version-10 ceiling', () => {
    const svg = qrSvg(`https://example.com/Gubbins/#/inventory?item=${UUID}`);
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toContain('<path');
    expect(() => encodeQr('x'.repeat(MAX_QR_BYTES + 1))).toThrow(QrError);
  });

  // Issue #329: the deep-link base comes from the user's "Link host" setting, so a long
  // host must still encode. Versions 7–10 carry an extra 18-bit version-information block.
  it('encodes payloads up to the ceiling, using versions 7–10 for long links', () => {
    expect(encodeQr('x'.repeat(MAX_QR_BYTES)).version).toBe(10);
    // A realistically long host (a Tailscale name) used to throw at the version-6 ceiling.
    const long = `https://gubbins-workshop.remote-access.example.com/apps/gubbins/#/inventory?item=${UUID}`;
    expect(long.length).toBeGreaterThan(106);
    expect(encodeQr(long).version).toBeGreaterThanOrEqual(7);
  });

  it('sizes and reserves the version-information block correctly at v7+', () => {
    const m = encodeQr('x'.repeat(MAX_QR_BYTES));
    expect(m.size).toBe(10 * 4 + 17); // 57×57
    // The 18-bit block sits in two 3×6 strips; the two copies must be transposes of
    // each other, which only holds if both were placed from the same bits.
    for (let i = 0; i < 18; i += 1) {
      const near = m.size - 11 + (i % 3);
      const far = Math.floor(i / 3);
      expect(m.modules[near][far]).toBe(m.modules[far][near]);
    }
  });

  // MAX_QR_BYTES is derived from the version table, so this pins the two to each other: a
  // payload at the ceiling must encode, and one byte past it must not.
  it('reports a ceiling that exactly matches what the encoder accepts', () => {
    expect(() => encodeQr('x'.repeat(MAX_QR_BYTES))).not.toThrow();
    expect(() => encodeQr('x'.repeat(MAX_QR_BYTES + 1))).toThrow(QrError);
  });

  // Issue #330: the quiet zone is part of the symbol, not layout padding a call site may trade
  // away — so it is no longer an option `toSvg` accepts, and every render carries the spec 4.
  it('always renders the mandatory 4-module quiet zone', () => {
    expect(QR_QUIET_ZONE_MODULES).toBe(4);
    const scale = 3;
    const m = encodeQr(`https://example.com/Gubbins/#/inventory?item=${UUID}`);
    const svg = qrSvg(`https://example.com/Gubbins/#/inventory?item=${UUID}`, { scale });
    const side = (m.size + QR_QUIET_ZONE_MODULES * 2) * scale;
    expect(svg).toContain(`width="${side}" height="${side}"`);
    // The first dark module is inset by the quiet zone rather than sitting on the edge.
    expect(svg).toContain(`<path d="M${QR_QUIET_ZONE_MODULES * scale} ${QR_QUIET_ZONE_MODULES * scale}h`);
  });

  // The module count is what a printed size is divided by to get one module's physical width
  // (issue #330), so it has to agree exactly with the matrix the encoder would build.
  it('reports a module count matching the symbol it would encode', () => {
    for (const payload of [
      'x',
      `https://example.com/Gubbins/#/inventory?item=${UUID}`,
      'x'.repeat(MAX_QR_BYTES),
    ]) {
      expect(qrModuleCount(payload)).toBe(encodeQr(payload).size);
    }
    expect(qrModuleCount('x'.repeat(MAX_QR_BYTES + 1))).toBeNull();
    expect(MAX_QR_MODULE_COUNT).toBe(encodeQr('x'.repeat(MAX_QR_BYTES)).size);
  });

  it('degrades to null instead of throwing when a payload cannot fit', () => {
    expect(qrSvgOrNull('x'.repeat(MAX_QR_BYTES + 1))).toBeNull();
    expect(qrSvgOrNull('https://example.com/')).toContain('<svg');
    expect(fitsInQr('x'.repeat(MAX_QR_BYTES))).toBe(true);
    expect(fitsInQr('x'.repeat(MAX_QR_BYTES + 1))).toBe(false);
    // Multi-byte characters count as their UTF-8 length, not their code-unit count.
    expect(fitsInQr('é'.repeat(MAX_QR_BYTES))).toBe(false);
  });
});

/**
 * The structural assertions above can't tell a *correct* symbol from a self-consistent but
 * undecodable one — a wrong version-information or block-layout entry produces a matrix that
 * looks fine and scans as nothing. So round-trip our own output through zxing (already a
 * dependency, used by the fallback scan engine) and require the payload back verbatim.
 */
describe('QR encoder — round-trips through a real decoder (issue #329)', () => {
  /** Render a matrix to the packed-RGB bitmap zxing's RGBLuminanceSource expects. */
  function decodeQr(text: string): string {
    const m = encodeQr(text);
    const quiet = 4;
    const scale = 4;
    const dim = (m.size + quiet * 2) * scale;
    const pixels = new Int32Array(dim * dim).fill(0xffffff);
    for (let r = 0; r < m.size; r += 1) {
      for (let c = 0; c < m.size; c += 1) {
        if (!m.modules[r][c]) continue;
        for (let dy = 0; dy < scale; dy += 1) {
          for (let dx = 0; dx < scale; dx += 1) {
            pixels[((r + quiet) * scale + dy) * dim + ((c + quiet) * scale + dx)] = 0x000000;
          }
        }
      }
    }
    const bitmap = new BinaryBitmap(new HybridBinarizer(new RGBLuminanceSource(pixels, dim, dim)));
    const hints = new Map();
    hints.set(DecodeHintType.TRY_HARDER, true);
    return new QRCodeReader().decode(bitmap, hints).getText();
  }

  it.each([
    ['a short string (v1)', 'HI'],
    ['a default deep-link', `https://example.com/Gubbins/#/inventory?item=${UUID}`],
    // The case from the issue: a long "Link host" that used to exceed the v6 ceiling.
    [
      'a long custom host (v7+)',
      `https://gubbins-workshop.remote-access.example.com/apps/gubbins/#/inventory?item=${UUID}`,
    ],
    ['a v8-sized payload', 'y'.repeat(140)],
    ['a v9-sized payload', 'y'.repeat(170)],
    ['the maximum payload (v10)', 'x'.repeat(MAX_QR_BYTES)],
  ])('decodes %s back to the original text', (_label, payload) => {
    expect(decodeQr(payload)).toBe(payload);
  });
});
