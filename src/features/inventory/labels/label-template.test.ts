import { describe, expect, it } from 'vitest';
import {
  A4_HEIGHT_MM,
  A4_WIDTH_MM,
  BARCODE_QUIET_ZONE_MODULES,
  DEFAULT_LABEL_TEMPLATE,
  LABEL_COLUMNS_BOUNDS,
  LABEL_ROWS_BOUNDS,
  LABEL_SIZE_BOUNDS,
  LABEL_SIZE_CUSTOM_ID,
  LABEL_SIZE_PRESETS,
  LABEL_SIZE_SHEET_ID,
  MIN_BARCODE_MODULE_MM,
  MIN_SHEET_CELL_MM,
  PLAIN_PAPER_SHEET_LAYOUT,
  SHEET_GAP_BOUNDS,
  SHEET_LAYOUT_CUSTOM_ID,
  SHEET_MARGIN_BOUNDS,
  SHEET_STOCK_PRESETS,
  barcodeFitsWidth,
  barcodeFitsWidthUncompressed,
  barcodeModuleWidth,
  clampColumns,
  clampLabelDimension,
  clampRows,
  fitBarcodeValue,
  formatSheetCellSize,
  labelSizeSelection,
  normaliseLabelTemplate,
  normaliseSheetLayout,
  sheetCellSizeMm,
  sheetLayoutSelection,
  sheetPresetLabel,
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
    expect(clampColumns('nonsense')).toBe(PLAIN_PAPER_SHEET_LAYOUT.columns);
    expect(clampColumns(undefined)).toBe(PLAIN_PAPER_SHEET_LAYOUT.columns);
  });
});

describe('clampRows', () => {
  it('clamps to the inclusive bounds, rounds, and falls back for garbage', () => {
    expect(clampRows(0)).toBe(LABEL_ROWS_BOUNDS.min);
    expect(clampRows(999)).toBe(LABEL_ROWS_BOUNDS.max);
    expect(clampRows(6.4)).toBe(6);
    expect(clampRows('nonsense')).toBe(PLAIN_PAPER_SHEET_LAYOUT.rows);
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
    const t = normaliseLabelTemplate({
      symbology: 'both',
      showMpn: true,
      sheet: { ...PLAIN_PAPER_SHEET_LAYOUT, columns: 4 },
    });
    expect(t.symbology).toBe('both');
    expect(t.showMpn).toBe(true);
    expect(t.sheet.columns).toBe(4);
    expect(t.showName).toBe(DEFAULT_LABEL_TEMPLATE.showName);
  });

  it('clamps an out-of-range column count', () => {
    expect(normaliseLabelTemplate({ sheet: { columns: 99 } }).sheet.columns).toBe(LABEL_COLUMNS_BOUNDS.max);
  });

  it('carries a pre-sheet-layout template forward on its saved column count (issue #333)', () => {
    // The bare `columns` a template used to carry meant a plain-paper tiling, so the rest of
    // the layout comes from that — the user's chosen column count is all there is to keep.
    const t = normaliseLabelTemplate({ symbology: 'barcode', columns: 2 });
    expect(t.sheet).toEqual({ ...PLAIN_PAPER_SHEET_LAYOUT, columns: 2 });
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
  it('clamps to the mm bounds', () => {
    expect(clampLabelDimension(0)).toBe(LABEL_SIZE_BOUNDS.min);
    expect(clampLabelDimension(9999)).toBe(LABEL_SIZE_BOUNDS.max);
  });

  it('keeps fractions of a millimetre, so an imperial size survives (issue #333)', () => {
    // 4 × 6" is 101.6 × 152.4 mm; rounded to whole millimetres each edge would lose 0.4 mm.
    expect(clampLabelDimension(101.6)).toBe(101.6);
    expect(clampLabelDimension(152.4)).toBe(152.4);
    expect(clampLabelDimension(38.1)).toBe(38.1);
    // Beyond a hundredth is noise on a printed label, and is rounded away.
    expect(clampLabelDimension(40.4444)).toBe(40.44);
  });

  it('falls back to the (clamped) fallback for non-finite input', () => {
    expect(clampLabelDimension('nope', 30)).toBe(30);
    expect(clampLabelDimension(undefined, 5)).toBe(LABEL_SIZE_BOUNDS.min);
  });
});

describe('sheet layouts (issue #333)', () => {
  it('derives each shipped stock size from its published tiling', () => {
    // The size a box of this stock is sold as. Deriving it — rather than storing it beside
    // the tiling — is what keeps a preset from claiming a label size its own geometry does
    // not produce.
    const sizes = Object.fromEntries(SHEET_STOCK_PRESETS.map((p) => [p.id, formatSheetCellSize(p.layout)]));
    expect(sizes).toEqual({
      plain: '60 × 42 mm',
      'a4-2up': '199.6 × 143.5 mm',
      'a4-4up': '99.1 × 139 mm',
      'a4-8up': '99.1 × 67.7 mm',
      'a4-14up': '99.1 × 38.1 mm',
      'a4-18up': '63.5 × 46.6 mm',
      'a4-21up': '63.5 × 38.1 mm',
      'a4-24up': '63.5 × 33.9 mm',
      'a4-40up': '45.7 × 25.4 mm',
      'a4-65up': '38.1 × 21.2 mm',
    });
  });

  it('never tiles more than the page holds', () => {
    for (const preset of SHEET_STOCK_PRESETS) {
      const { widthMm, heightMm } = sheetCellSizeMm(preset.layout);
      const l = preset.layout;
      const across = widthMm * l.columns + l.columnGapMm * (l.columns - 1) + l.marginSideMm * 2;
      const down = heightMm * l.rows + l.rowGapMm * (l.rows - 1) + l.marginTopMm * 2;
      expect(across, `${preset.id} across`).toBeLessThanOrEqual(A4_WIDTH_MM);
      expect(down, `${preset.id} down`).toBeLessThanOrEqual(A4_HEIGHT_MM);
    }
  });

  it('names a preset by its count and derived size', () => {
    const twentyOne = SHEET_STOCK_PRESETS.find((p) => p.id === 'a4-21up')!;
    expect(sheetPresetLabel(twentyOne)).toBe('21 per sheet — 63.5 × 38.1 mm');
  });

  it('bottoms a cell out rather than deriving a negative size from an absurd layout', () => {
    const size = sheetCellSizeMm({
      ...PLAIN_PAPER_SHEET_LAYOUT,
      rows: LABEL_ROWS_BOUNDS.max,
      rowGapMm: SHEET_GAP_BOUNDS.max,
      marginTopMm: SHEET_MARGIN_BOUNDS.max,
    });
    expect(size.heightMm).toBe(MIN_SHEET_CELL_MM);
  });

  it('coerces a stale/garbage layout back to a usable one', () => {
    expect(normaliseSheetLayout(undefined)).toEqual(PLAIN_PAPER_SHEET_LAYOUT);
    const l = normaliseSheetLayout({ columns: 'x', rows: 99, marginTopMm: -5, columnGapMm: 999 });
    expect(l.columns).toBe(PLAIN_PAPER_SHEET_LAYOUT.columns);
    expect(l.rows).toBe(LABEL_ROWS_BOUNDS.max);
    expect(l.marginTopMm).toBe(SHEET_MARGIN_BOUNDS.min);
    expect(l.columnGapMm).toBe(SHEET_GAP_BOUNDS.max);
  });

  it('keeps a published margin to the hundredth of a millimetre', () => {
    expect(normaliseSheetLayout({ ...PLAIN_PAPER_SHEET_LAYOUT, marginTopMm: 15.15 }).marginTopMm).toBe(15.15);
  });

  it('resolves a layout to its preset, and an edited one to "custom"', () => {
    for (const preset of SHEET_STOCK_PRESETS) {
      expect(sheetLayoutSelection(preset.layout)).toBe(preset.id);
    }
    const edited = { ...PLAIN_PAPER_SHEET_LAYOUT, rowGapMm: 7 };
    expect(sheetLayoutSelection(edited)).toBe(SHEET_LAYOUT_CUSTOM_ID);
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
    // 27 mm is the usable width of the 30 x 15 mm die-cut label. `DIGIT_ID`'s short id is
    // all digits, so Code Set C would squeeze it into two-thirds the width of `ID`'s — but
    // the fallback is measured uncompressed, so both labels behave the same way.
    const NARROW_MM = 27;
    expect(fitBarcodeValue('A very long location name', DIGIT_ID, NARROW_MM).fit).toBe('unprintable');
    expect(fitBarcodeValue('A very long location name', ID, NARROW_MM).fit).toBe('unprintable');
    // …and with no preferred value to lose, still nothing to print.
    expect(fitBarcodeValue('', DIGIT_ID, NARROW_MM).fit).toBe('unprintable');
    expect(fitBarcodeValue('', ID, NARROW_MM).fit).toBe('unprintable');
  });

  it('still prints a fallback on a label with room for one', () => {
    // 37 mm is the usable width of the 40 x 30 mm die-cut label and of a 4-column A4 cell.
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
