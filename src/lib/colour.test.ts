import { describe, expect, it } from 'vitest';
import {
  COLOUR_FORMATS,
  CSS_COLOUR_NAMES,
  colourName,
  contrastingInk,
  formatColour,
  hsbToRgb,
  hslToRgb,
  parseColour,
  relativeLuminance,
  rgbToHsb,
  rgbToHsl,
  toRgb,
} from './colour';

describe('parseColour', () => {
  it('canonicalises every hex length to lowercase #rrggbb', () => {
    expect(parseColour('#F00')).toBe('#ff0000');
    expect(parseColour('#Ff0000')).toBe('#ff0000');
    expect(parseColour('ff0000')).toBe('#ff0000');
    expect(parseColour('  #00FF00  ')).toBe('#00ff00');
  });

  it('drops a fully opaque alpha so the two spellings store identically', () => {
    expect(parseColour('#ff0000ff')).toBe('#ff0000');
    expect(parseColour('#f00f')).toBe('#ff0000');
  });

  it('keeps a partial alpha as an eight-digit value', () => {
    expect(parseColour('#ff000080')).toBe('#ff000080');
    expect(parseColour('#f008')).toBe('#ff000088');
    // Four-digit #rgba is valid CSS, including a fully transparent one.
    expect(parseColour('#ff00')).toBe('#ffff0000');
  });

  it('reads rgb() in both the legacy comma and CSS Color 4 space forms', () => {
    expect(parseColour('rgb(255, 0, 0)')).toBe('#ff0000');
    expect(parseColour('rgb(255 0 0)')).toBe('#ff0000');
    expect(parseColour('rgba(255, 0, 0, 0.5)')).toBe('#ff000080');
    expect(parseColour('rgb(255 0 0 / 50%)')).toBe('#ff000080');
  });

  it('reads rgb() percentages', () => {
    expect(parseColour('rgb(100%, 0%, 0%)')).toBe('#ff0000');
  });

  it('reads hsl() in both forms, with or without a deg suffix', () => {
    expect(parseColour('hsl(0, 100%, 50%)')).toBe('#ff0000');
    expect(parseColour('hsl(120 100% 50%)')).toBe('#00ff00');
    expect(parseColour('hsl(240deg 100% 50%)')).toBe('#0000ff');
    expect(parseColour('hsla(0, 100%, 50%, 0.5)')).toBe('#ff000080');
  });

  it('reads hsb()/hsv(), which are not CSS but are what pickers quote', () => {
    expect(parseColour('hsb(0, 100%, 100%)')).toBe('#ff0000');
    expect(parseColour('hsv(120 100% 50%)')).toBe('#008000');
  });

  it('distinguishes HSB from HSL at the same numbers', () => {
    // 100% saturation, 100% of the second axis: white in HSL, pure red in HSB.
    expect(parseColour('hsl(0, 100%, 100%)')).toBe('#ffffff');
    expect(parseColour('hsb(0, 100%, 100%)')).toBe('#ff0000');
  });

  it('reads CSS colour names, including the British grey spellings', () => {
    expect(parseColour('Chocolate')).toBe('#d2691e');
    expect(parseColour('grey')).toBe('#808080');
    expect(parseColour('gray')).toBe('#808080');
    expect(parseColour('dimgrey')).toBe('#696969');
  });

  it('wraps and clamps out-of-range components rather than rejecting them', () => {
    expect(parseColour('hsl(-120, 100%, 50%)')).toBe('#0000ff');
    expect(parseColour('rgb(300, -20, 0)')).toBe('#ff0000');
  });

  it('rejects anything that is not a colour', () => {
    for (const raw of [
      '',
      '   ',
      null,
      undefined,
      'not a colour',
      '#fffffff',
      '#gggggg',
      'rgb(1, 2)',
      'rgb(1, 2, 3, 4, 5)',
      'rgb(1,2,3,)',
      'rgb(a, b, c)',
      'transparent',
      'currentColor',
      'oklch(0.7 0.1 30)',
      'color(display-p3 1 0 0)',
    ]) {
      expect(parseColour(raw), String(raw)).toBeNull();
    }
  });
});

describe('conversions', () => {
  it('round-trips every named colour through HSL', () => {
    for (const hex of Object.values(CSS_COLOUR_NAMES)) {
      const { rgb } = toRgb(hex);
      const back = hslToRgb(rgbToHsl(rgb));
      // Whole-degree/percent rounding costs at most a shade per channel.
      expect(Math.abs(back.r - rgb.r), hex).toBeLessThanOrEqual(3);
      expect(Math.abs(back.g - rgb.g), hex).toBeLessThanOrEqual(3);
      expect(Math.abs(back.b - rgb.b), hex).toBeLessThanOrEqual(3);
    }
  });

  it('round-trips every named colour through HSB', () => {
    for (const hex of Object.values(CSS_COLOUR_NAMES)) {
      const { rgb } = toRgb(hex);
      const back = hsbToRgb(rgbToHsb(rgb));
      expect(Math.abs(back.r - rgb.r), hex).toBeLessThanOrEqual(3);
      expect(Math.abs(back.g - rgb.g), hex).toBeLessThanOrEqual(3);
      expect(Math.abs(back.b - rgb.b), hex).toBeLessThanOrEqual(3);
    }
  });

  it('reports the achromatic cases without a spurious hue or saturation', () => {
    expect(rgbToHsl({ r: 0, g: 0, b: 0 })).toEqual({ h: 0, s: 0, l: 0 });
    expect(rgbToHsl({ r: 255, g: 255, b: 255 })).toEqual({ h: 0, s: 0, l: 100 });
    expect(rgbToHsb({ r: 0, g: 0, b: 0 })).toEqual({ h: 0, s: 0, b: 0 });
    expect(rgbToHsb({ r: 255, g: 255, b: 255 })).toEqual({ h: 0, s: 0, b: 100 });
  });

  it('separates the two saturation models on a mid-tone', () => {
    // #808000 (olive) is a case where HSL and HSB disagree on both axes.
    const { rgb } = toRgb('#808000');
    expect(rgbToHsl(rgb)).toEqual({ h: 60, s: 100, l: 25 });
    expect(rgbToHsb(rgb)).toEqual({ h: 60, s: 100, b: 50 });
  });
});

describe('formatColour', () => {
  it('renders an opaque colour in every format', () => {
    expect(formatColour('#d2691e', 'HEX')).toBe('#D2691E');
    expect(formatColour('#d2691e', 'RGB')).toBe('rgb(210, 105, 30)');
    expect(formatColour('#d2691e', 'HSL')).toBe('hsl(25, 75%, 47%)');
    expect(formatColour('#d2691e', 'HSB')).toBe('hsb(25, 86%, 82%)');
    expect(formatColour('#d2691e', 'NAME')).toBe('chocolate');
  });

  it('carries alpha through the formats that can express it', () => {
    expect(formatColour('#ff000080', 'RGB')).toBe('rgba(255, 0, 0, 0.5)');
    expect(formatColour('#ff000080', 'HSL')).toBe('hsla(0, 100%, 50%, 0.5)');
    expect(formatColour('#ff000080', 'HEX')).toBe('#FF000080');
  });

  it('falls back to hex for a name that would misstate a translucent colour', () => {
    expect(formatColour('#ff000080', 'NAME')).toBe('#FF000080');
  });

  it('falls back to hex when the colour has no name', () => {
    expect(formatColour('#d2691f', 'NAME')).toBe('#D2691F');
  });

  it('produces a value parseColour accepts back, exactly, for the lossless formats', () => {
    for (const hex of ['#d2691e', '#000000', '#ffffff', '#123456', '#00ff7f', '#ff000080']) {
      for (const format of ['HEX', 'RGB', 'NAME'] as const) {
        const rendered = formatColour(hex, format);
        expect(parseColour(rendered), `${hex} as ${format}`).toBe(hex);
      }
    }
  });

  it('renders every format as something parseColour reads back as a colour', () => {
    for (const format of COLOUR_FORMATS) {
      expect(parseColour(formatColour('#123456', format)), format).not.toBeNull();
    }
  });

  it('round-trips the whole-percent formats to within a shade', () => {
    // HSL and HSB are rendered at the precision a user reads and types, so they cannot
    // name every 8-bit colour exactly. Storage is unaffected — the stored form is the hex.
    for (const hex of ['#d2691e', '#000000', '#ffffff', '#123456', '#00ff7f']) {
      for (const format of ['HSL', 'HSB'] as const) {
        const back = parseColour(formatColour(hex, format));
        expect(back, `${hex} as ${format}`).not.toBeNull();
        const from = toRgb(hex).rgb;
        const to = toRgb(back as string).rgb;
        expect(Math.abs(to.r - from.r), `${hex} as ${format}`).toBeLessThanOrEqual(3);
        expect(Math.abs(to.g - from.g), `${hex} as ${format}`).toBeLessThanOrEqual(3);
        expect(Math.abs(to.b - from.b), `${hex} as ${format}`).toBeLessThanOrEqual(3);
      }
    }
  });
});

describe('colourName', () => {
  it('names an exact match only', () => {
    expect(colourName('#d2691e')).toBe('chocolate');
    expect(colourName('#D2691E')).toBe('chocolate');
    expect(colourName('#d2691f')).toBeNull();
  });

  it('prefers the gray spelling where two names share a hex', () => {
    expect(colourName('#808080')).toBe('gray');
    expect(colourName('#00ffff')).toBe('aqua');
  });
});

describe('legibility helpers', () => {
  it('measures luminance at the ends of the range', () => {
    expect(relativeLuminance('#000000')).toBeCloseTo(0, 5);
    expect(relativeLuminance('#ffffff')).toBeCloseTo(1, 5);
  });

  it('picks ink that contrasts with the swatch', () => {
    expect(contrastingInk('#ffffff')).toBe('#000000');
    expect(contrastingInk('#ffff00')).toBe('#000000');
    expect(contrastingInk('#000000')).toBe('#ffffff');
    expect(contrastingInk('#0000ff')).toBe('#ffffff');
  });
});
