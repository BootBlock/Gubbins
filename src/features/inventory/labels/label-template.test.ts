import { describe, expect, it } from 'vitest';
import {
  BARCODE_QUIET_ZONE_MODULES,
  DEFAULT_LABEL_TEMPLATE,
  LABEL_COLUMNS_BOUNDS,
  LABEL_SIZE_BOUNDS,
  LABEL_SIZE_CUSTOM_ID,
  LABEL_SIZE_PRESETS,
  LABEL_SIZE_SHEET_ID,
  MIN_BARCODE_MODULE_MM,
  barcodeFitsWidth,
  barcodeFitsWidthUncompressed,
  barcodeModuleWidth,
  clampColumns,
  clampLabelDimension,
  fitBarcodeValue,
  labelSizeSelection,
  normaliseLabelTemplate,
  shortId,
  templateHasBarcode,
  templateHasQr,
  toBarcodeText,
  type LabelTemplate,
} from './label-template';

const ID = 'a1b2c3d4-1111-4111-8111-111111111111';
/** An id whose short form is all digits — the case Code 128 can compress. */
const DIGIT_ID = '12345678-1111-4111-8111-111111111111';

describe('clampColumns', () => {
  it('clamps to the inclusive bounds and rounds', () => {
    expect(clampColumns(0)).toBe(LABEL_COLUMNS_BOUNDS.min);
    expect(clampColumns(99)).toBe(LABEL_COLUMNS_BOUNDS.max);
    expect(clampColumns(2.6)).toBe(3);
  });

  it('falls back to the default for non-finite input', () => {
    expect(clampColumns('nonsense')).toBe(DEFAULT_LABEL_TEMPLATE.columns);
    expect(clampColumns(undefined)).toBe(DEFAULT_LABEL_TEMPLATE.columns);
  });
});

describe('normaliseLabelTemplate', () => {
  it('returns the default for nullish / garbage input', () => {
    expect(normaliseLabelTemplate(undefined)).toEqual(DEFAULT_LABEL_TEMPLATE);
    expect(normaliseLabelTemplate(null)).toEqual(DEFAULT_LABEL_TEMPLATE);
    expect(normaliseLabelTemplate(42)).toEqual(DEFAULT_LABEL_TEMPLATE);
  });

  it('coerces an unknown symbology back to the default', () => {
    expect(normaliseLabelTemplate({ symbology: 'datamatrix' }).symbology).toBe(
      DEFAULT_LABEL_TEMPLATE.symbology,
    );
  });

  it('preserves valid fields and fills the rest from the default', () => {
    const t = normaliseLabelTemplate({ symbology: 'both', showMpn: true, columns: 4 });
    expect(t.symbology).toBe('both');
    expect(t.showMpn).toBe(true);
    expect(t.columns).toBe(4);
    expect(t.showName).toBe(DEFAULT_LABEL_TEMPLATE.showName);
  });

  it('clamps an out-of-range column count', () => {
    expect(normaliseLabelTemplate({ columns: 99 }).columns).toBe(LABEL_COLUMNS_BOUNDS.max);
  });

  it('defaults the size mode to the A4 sheet and coerces an unknown mode', () => {
    expect(normaliseLabelTemplate({}).sizeMode).toBe('sheet');
    expect(normaliseLabelTemplate({ sizeMode: 'nonsense' }).sizeMode).toBe('sheet');
    expect(normaliseLabelTemplate({ sizeMode: 'die-cut' }).sizeMode).toBe('die-cut');
  });

  it('clamps out-of-range / garbage die-cut dimensions to the bounds', () => {
    const t = normaliseLabelTemplate({ sizeMode: 'die-cut', labelWidthMm: 5, labelHeightMm: 9999 });
    expect(t.labelWidthMm).toBe(LABEL_SIZE_BOUNDS.min);
    expect(t.labelHeightMm).toBe(LABEL_SIZE_BOUNDS.max);
    const g = normaliseLabelTemplate({ labelWidthMm: 'x' });
    expect(g.labelWidthMm).toBe(DEFAULT_LABEL_TEMPLATE.labelWidthMm);
  });
});

describe('clampLabelDimension', () => {
  it('clamps and rounds to the mm bounds', () => {
    expect(clampLabelDimension(0)).toBe(LABEL_SIZE_BOUNDS.min);
    expect(clampLabelDimension(9999)).toBe(LABEL_SIZE_BOUNDS.max);
    expect(clampLabelDimension(40.4)).toBe(40);
  });
  it('falls back to the (clamped) fallback for non-finite input', () => {
    expect(clampLabelDimension('nope', 30)).toBe(30);
    expect(clampLabelDimension(undefined, 5)).toBe(LABEL_SIZE_BOUNDS.min);
  });
});

describe('labelSizeSelection', () => {
  const size = (over: Partial<LabelTemplate> = {}): LabelTemplate => ({ ...DEFAULT_LABEL_TEMPLATE, ...over });

  it('is the sheet id in sheet mode', () => {
    expect(labelSizeSelection(size({ sizeMode: 'sheet' }))).toBe(LABEL_SIZE_SHEET_ID);
  });
  it('matches a preset id when the die-cut dimensions equal that preset', () => {
    const preset = LABEL_SIZE_PRESETS[0]!;
    expect(
      labelSizeSelection(
        size({ sizeMode: 'die-cut', labelWidthMm: preset.widthMm, labelHeightMm: preset.heightMm }),
      ),
    ).toBe(preset.id);
  });
  it('is the custom id for a bespoke die-cut size', () => {
    expect(labelSizeSelection(size({ sizeMode: 'die-cut', labelWidthMm: 37, labelHeightMm: 23 }))).toBe(
      LABEL_SIZE_CUSTOM_ID,
    );
  });
});

describe('templateHasQr / templateHasBarcode', () => {
  const at = (symbology: LabelTemplate['symbology']): LabelTemplate => ({
    ...DEFAULT_LABEL_TEMPLATE,
    symbology,
  });
  it('reflect the symbology', () => {
    expect(templateHasQr(at('qr'))).toBe(true);
    expect(templateHasBarcode(at('qr'))).toBe(false);
    expect(templateHasBarcode(at('barcode'))).toBe(true);
    expect(templateHasQr(at('barcode'))).toBe(false);
    expect(templateHasQr(at('both'))).toBe(true);
    expect(templateHasBarcode(at('both'))).toBe(true);
    expect(templateHasQr(at('none'))).toBe(false);
    expect(templateHasBarcode(at('none'))).toBe(false);
  });
});

describe('shortId', () => {
  it('uppercases the first UUID group', () => {
    expect(shortId(ID)).toBe('A1B2C3D4');
  });
  it('falls back to the whole string when there is no hyphen', () => {
    expect(shortId('abc')).toBe('ABC');
  });
});

describe('toBarcodeText', () => {
  it('passes plain ASCII through, trimmed and with whitespace collapsed', () => {
    expect(toBarcodeText('RC0805-10K')).toBe('RC0805-10K');
    expect(toBarcodeText('  Bin 3 \n B  ')).toBe('Bin 3 B');
  });

  it('transliterates accented Latin rather than deleting the accents (issue #332)', () => {
    // The bug: `Café Störage` used to encode as `Caf Strage`, sitting beneath a name
    // line that still read `Café Störage`.
    expect(toBarcodeText('Café Störage')).toBe('Cafe Storage');
    expect(toBarcodeText('Zaÿçon')).toBe('Zaycon');
    // A decomposed `é` (e + combining acute) reaches the same value as a precomposed one.
    expect(toBarcodeText('Café')).toBe('Cafe');
  });

  it('spells out the letters decomposition leaves alone', () => {
    expect(toBarcodeText('Größe')).toBe('Grosse');
    expect(toBarcodeText('Ærø Þing Łódź')).toBe('AEro THing Lodz');
  });

  it('folds typographic punctuation to its ASCII form', () => {
    expect(toBarcodeText('Dave’s bin — no. 3')).toBe("Dave's bin - no. 3");
    expect(toBarcodeText('40×30 “spare”')).toBe('40x30 "spare"');
    // A vulgar fraction decomposes to digits around a fraction slash, which maps to '/'.
    expect(toBarcodeText('½" pipe')).toBe('1/2" pipe');
    // A non-breaking space becomes an ordinary one, via NFKD.
    expect(toBarcodeText('Bay 1')).toBe('Bay 1');
  });

  it('rejects a value with any character that has no ASCII form', () => {
    // Partly-representable is the case the old code mangled: it must reject, not truncate.
    expect(toBarcodeText('AB£é')).toBeNull();
    expect(toBarcodeText('Bin 3 鈴木')).toBeNull();
    expect(toBarcodeText('Полка 4')).toBeNull();
    // An astral character is examined whole, not as the lone surrogate `charCodeAt` saw.
    expect(toBarcodeText('Shelf \u{1f9f0}')).toBeNull();
    // A ZWJ family sequence: the joiners go, but the emoji themselves still reject it.
    expect(toBarcodeText('\u{1f468}‍\u{1f469}‍\u{1f467}')).toBeNull();
  });

  it('is null for a value that is blank or only whitespace', () => {
    expect(toBarcodeText('')).toBeNull();
    expect(toBarcodeText('   ')).toBeNull();
  });

  it('strips invisible formatting characters rather than failing over them', () => {
    // A zero-width space or bidi mark pasted into a name prints nothing either way, so it
    // must not cost the label its barcode.
    expect(toBarcodeText('Bin​ 3')).toBe('Bin 3');
    expect(toBarcodeText('‎Shelf B')).toBe('Shelf B');
  });
});

/** The widest a barcode prints in an A4 label cell — a comfortable, realistic width. */
const WIDE_MM = 40;
/**
 * A width that a compressible eight-character value clears and an uncompressible one does
 * not, so the two measurements can be told apart.
 */
const BETWEEN_MM = 20;

describe('barcodeModuleWidth', () => {
  it('counts 11 modules per character plus start/check/stop and both quiet zones', () => {
    // 8 data characters: (1 start + 8 data + 1 check) × 11 + 13 (stop) + 2 × 10 (quiet).
    expect(barcodeModuleWidth('A1B2C3D4')).toBe(10 * 11 + 13 + BARCODE_QUIET_ZONE_MODULES * 2);
  });

  it('is null for a value Code 128 cannot encode', () => {
    expect(barcodeModuleWidth('')).toBeNull();
    expect(barcodeModuleWidth('é')).toBeNull();
  });
});

describe('barcodeFitsWidth', () => {
  it('accepts a value whose modules stay at or above the readable floor', () => {
    const modules = barcodeModuleWidth('A1B2C3D4')!;
    expect(barcodeFitsWidth('A1B2C3D4', modules * MIN_BARCODE_MODULE_MM)).toBe(true);
  });

  it('rejects a value that would print below the floor', () => {
    const modules = barcodeModuleWidth('A1B2C3D4')!;
    expect(barcodeFitsWidth('A1B2C3D4', modules * MIN_BARCODE_MODULE_MM - 0.01)).toBe(false);
  });

  it('rejects a value that cannot be encoded at all, however wide the label', () => {
    expect(barcodeFitsWidth('', 1000)).toBe(false);
  });

  it('lets a compressible value use the room its real encoding saves', () => {
    // Eight digits pack into Code Set C (99 modules), so they genuinely need less width
    // than eight mixed characters (143) — the exact measurement allows for that. 20 mm
    // sits between the two thresholds.
    expect(barcodeFitsWidth('12345678', BETWEEN_MM)).toBe(true);
    expect(barcodeFitsWidth('A1B2C3D4', BETWEEN_MM)).toBe(false);
  });
});

describe('barcodeFitsWidthUncompressed', () => {
  it('gives the same answer for every value of the same length (issue #331)', () => {
    // At the width where the exact measurement disagrees between these values, judging
    // them uncompressed makes them agree — the label size decides, not the characters.
    for (const value of ['12345678', 'A1B2C3D4', 'ABCDEFGH', '1234ABCD']) {
      expect(barcodeFitsWidthUncompressed(value, BETWEEN_MM)).toBe(false);
    }
  });

  it('agrees with the exact measurement for a value that cannot compress anyway', () => {
    const width = barcodeModuleWidth('A1B2C3D4')! * MIN_BARCODE_MODULE_MM;
    expect(barcodeFitsWidthUncompressed('A1B2C3D4', width + 0.01)).toBe(true);
    expect(barcodeFitsWidthUncompressed('A1B2C3D4', width - 0.01)).toBe(false);
  });

  it('still rejects a value Code 128 cannot encode at all', () => {
    expect(barcodeFitsWidthUncompressed('', 1000)).toBe(false);
    expect(barcodeFitsWidthUncompressed('é', 1000)).toBe(false);
  });
});

describe('fitBarcodeValue', () => {
  it('uses the preferred value when it prints wide enough to scan', () => {
    expect(fitBarcodeValue('RC0805-10K', ID, WIDE_MM)).toEqual({ value: 'RC0805-10K', fit: 'ok' });
  });

  it('falls back to the short id when there is no preferred value — not a downgrade', () => {
    expect(fitBarcodeValue('', ID, WIDE_MM)).toEqual({ value: 'A1B2C3D4', fit: 'ok' });
    expect(fitBarcodeValue('   ', ID, WIDE_MM)).toEqual({ value: 'A1B2C3D4', fit: 'ok' });
  });

  it('transliterates a value Code 128 cannot encode verbatim (issue #332)', () => {
    // `Café Störage` prints `Cafe Storage` — legible, and the same value the human-readable
    // line under the bars shows. It never prints the old `Caf Strage`.
    expect(fitBarcodeValue('Café Störage', ID, WIDE_MM)).toEqual({
      value: 'Cafe Storage',
      fit: 'ok',
    });
  });

  it('falls back rather than printing a value it can only partly represent (issue #332)', () => {
    // The "£" has no ASCII spelling, so `AB£é` is rejected whole instead of printing `ABe`.
    expect(fitBarcodeValue('AB£é', ID, WIDE_MM)).toEqual({ value: 'A1B2C3D4', fit: 'ok' });
    expect(fitBarcodeValue('鈴木電子', ID, WIDE_MM)).toEqual({ value: 'A1B2C3D4', fit: 'ok' });
  });

  it('shortens a value too long to print readably (issue #331)', () => {
    // A free-text location name: 30 characters is ~0.1 mm per module across 40 mm — a smear.
    expect(fitBarcodeValue('Workshop shelf B, third drawer', ID, WIDE_MM)).toEqual({
      value: 'A1B2C3D4',
      fit: 'shortened',
    });
  });

  it('keeps the preferred value right up to the width it stops being readable', () => {
    expect(fitBarcodeValue('ABCDEFGHIJKLMN', ID, WIDE_MM).fit).toBe('ok');
    expect(fitBarcodeValue('ABCDEFGHIJKLMNO', ID, WIDE_MM).fit).toBe('shortened');
  });

  it('prints no barcode at all when not even the short id fits', () => {
    // An unreadable symbol is worse than none — it looks like it ought to work.
    expect(fitBarcodeValue('BIN3', ID, 10)).toEqual({ value: null, fit: 'unprintable' });
    expect(fitBarcodeValue('', ID, 10)).toEqual({ value: null, fit: 'unprintable' });
  });

  it('decides "unprintable" from the label size alone, not the shape of the id (issue #331)', () => {
    // 27 mm is just under the ~27.2 mm an 8-character fallback needs. `DIGIT_ID`'s short id
    // is all digits, so Code Set C would squeeze it into two-thirds the width of `ID`'s —
    // but the fallback is measured uncompressed, so both labels behave the same way.
    const NARROW_MM = 27;
    expect(fitBarcodeValue('A very long location name', DIGIT_ID, NARROW_MM).fit).toBe('unprintable');
    expect(fitBarcodeValue('A very long location name', ID, NARROW_MM).fit).toBe('unprintable');
    // …and with no preferred value to lose, still nothing to print.
    expect(fitBarcodeValue('', DIGIT_ID, NARROW_MM).fit).toBe('unprintable');
    expect(fitBarcodeValue('', ID, NARROW_MM).fit).toBe('unprintable');
  });

  it('still prints a fallback on a label with room for one', () => {
    // 37 mm is the usable width of a 4-column A4 cell.
    const ROOMY_MM = 37;
    expect(fitBarcodeValue('A very long location name', DIGIT_ID, ROOMY_MM)).toEqual({
      value: '12345678',
      fit: 'shortened',
    });
    expect(fitBarcodeValue('A very long location name', ID, ROOMY_MM)).toEqual({
      value: 'A1B2C3D4',
      fit: 'shortened',
    });
  });
});
