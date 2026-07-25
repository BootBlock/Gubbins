/**
 * Guards the printed catalogue's QR column against shrinking below a scannable size (issue #330).
 *
 * The column is sized in CSS (`.catalogue-qr` in `src/styles/index.css`), and CSS knows nothing
 * about how many modules a QR has — so the box was set at 16 mm by eye. A QR's module count comes
 * from its payload, and the payload is a deep-link whose length the user controls via Settings →
 * "Link host", so at the encoder's ceiling that box was dividing 65 modules into 16 mm: below the
 * readable-module floor, printed against the neighbouring table rule.
 *
 * Nothing in the type system connects a millimetre in a stylesheet to a module count in the
 * encoder, and nothing about a too-small QR looks wrong on screen — it is a perfectly tidy little
 * square that phones decline to read. So the connection is made here instead: the CSS value is
 * read back and checked against the constants it was derived from, which makes shrinking the box —
 * *or* raising the payload ceiling without revisiting it — a build failure rather than a batch of
 * unscannable catalogues. The same posture as the storage-key registry and hover-reveal guards.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { repoPath } from '@/test/repo-path';
import { MAX_QR_MODULE_COUNT, QR_QUIET_ZONE_MODULES } from '@/features/scanner/qr-code';
import { MIN_QR_MODULE_MM } from '@/features/inventory/labels/label-template';

/** The `width` (mm) the print stylesheet gives a catalogue QR cell. */
function catalogueQrWidthMm(): number {
  const css = readFileSync(repoPath(import.meta.dirname, 'src', 'styles', 'index.css'), 'utf8');
  const rule = /\.catalogue-qr\s*\{([^}]*)\}/.exec(css);
  expect(rule, '.catalogue-qr rule not found in src/styles/index.css').not.toBeNull();
  const width = /width:\s*([\d.]+)mm/.exec(rule![1]!);
  expect(width, '.catalogue-qr has no mm width').not.toBeNull();
  return Number(width![1]);
}

describe('printed catalogue QR column', () => {
  it('is wide enough for the largest symbol the encoder can produce', () => {
    // The whole drawn square is measured: the quiet zone is part of the symbol, so it takes
    // printed width exactly like a data module does.
    const needed = (MAX_QR_MODULE_COUNT + QR_QUIET_ZONE_MODULES * 2) * MIN_QR_MODULE_MM;
    expect(catalogueQrWidthMm()).toBeGreaterThanOrEqual(needed);
  });

  it('keeps the cell square, so the QR is not distorted to fit', () => {
    const css = readFileSync(repoPath(import.meta.dirname, 'src', 'styles', 'index.css'), 'utf8');
    const rule = /\.catalogue-qr\s*\{([^}]*)\}/.exec(css)![1]!;
    expect(/height:\s*([\d.]+)mm/.exec(rule)![1]).toBe(/width:\s*([\d.]+)mm/.exec(rule)![1]);
  });
});
