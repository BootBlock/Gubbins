import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LABEL_TEMPLATE,
  LABEL_COLUMNS_BOUNDS,
  LABEL_SIZE_BOUNDS,
  LABEL_SIZE_CUSTOM_ID,
  LABEL_SIZE_PRESETS,
  LABEL_SIZE_SHEET_ID,
  clampColumns,
  clampLabelDimension,
  labelBarcodeValue,
  labelSizeSelection,
  normaliseLabelTemplate,
  shortId,
  templateHasBarcode,
  templateHasQr,
  type LabelTemplate,
} from './label-template';

const ID = 'a1b2c3d4-1111-4111-8111-111111111111';

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

describe('labelBarcodeValue', () => {
  it('uses the MPN when present', () => {
    expect(labelBarcodeValue({ id: ID, mpn: 'RC0805-10K' })).toBe('RC0805-10K');
  });
  it('falls back to the short id when the MPN is blank/missing', () => {
    expect(labelBarcodeValue({ id: ID, mpn: '   ' })).toBe('A1B2C3D4');
    expect(labelBarcodeValue({ id: ID })).toBe('A1B2C3D4');
    expect(labelBarcodeValue({ id: ID, mpn: null })).toBe('A1B2C3D4');
  });
  it('strips characters Code 128 Code-B cannot encode, falling back if nothing remains', () => {
    // The "é" (charCode 233) is outside 32..126 and is stripped.
    expect(labelBarcodeValue({ id: ID, mpn: 'AB£é' })).toBe('AB');
    expect(labelBarcodeValue({ id: ID, mpn: 'é' })).toBe('A1B2C3D4');
  });
});
