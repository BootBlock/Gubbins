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
      // A bare `%` is not zero. `Number('')` is, which is how this used to become black.
      'rgb(%,%,%)',
      'rgba(0,0,0,%)',
      // `Number()` also reads these; a colour component is a plain decimal or nothing.
      'rgb(0x10,0,0)',
      'rgb(Infinity,0,0)',
      'rgb(NaN,0,0)',
      // In the space form the alpha only ever follows a slash — a bare fourth component is
      // a typo, not a transparency.
      'rgb(1 2 3 4)',
      // A hue is an angle, never a percentage.
      'hsl(50% 100% 50%)',
    ]) {
      expect(parseColour(raw), String(raw)).toBeNull();
    }
  });

  it('reads a deg-suffixed hue with the space the comma form allows', () => {
    expect(parseColour('hsl(30deg , 100%, 50%)')).toBe(parseColour('hsl(30deg, 100%, 50%)'));
    expect(parseColour('hsl(30deg , 100%, 50%)')).toBe('#ff8000');
  });

  it('gives a colour one canonical spelling however nearly opaque its alpha was', () => {
    // An alpha of 0.999 rounds to the byte `ff`, and an `ff` alpha is dropped — so deciding
    // opacity from the fraction rather than the byte produced a second spelling of red.
    expect(parseColour('rgba(255, 0, 0, 0.999)')).toBe('#ff0000');
    expect(parseColour('rgba(255, 0, 0, 1)')).toBe('#ff0000');
    expect(parseColour('hsl(0 100% 50% / 99.9%)')).toBe('#ff0000');
    // Still eight digits where the byte genuinely is not opaque.
    expect(parseColour('rgba(255, 0, 0, 0.99)')).toBe('#ff0000fc');
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

  it('rounds an exact half up, where float arithmetic would land just under it', () => {
    // Each of these is a channel that comes to exactly `x.5` in real arithmetic and to
    // `x.4999…` in binary floating point. They are the three distinct ways the old code lost
    // it: subtracting fractions, adding a residual back, and dividing the hue by 60 first.
    expect(parseColour('hsb(0, 75%, 40%)')).toBe('#661a1a');
    expect(parseColour('hsl(0, 60%, 75%)')).toBe('#e69999');
    expect(parseColour('hsl(0, 100%, 5%)')).toBe('#1a0000');
    expect(hsbToRgb({ h: 2, s: 100, b: 100 })).toEqual({ r: 255, g: 9, b: 0 });
    expect(hslToRgb({ h: 6, s: 100, l: 50 })).toEqual({ r: 255, g: 26, b: 0 });
  });

  it('matches the HSV definition exactly, rather than reaching a channel by addition', () => {
    // Both the via-HSL route and the chroma-plus-offset form reach the brightest channel by
    // adding a residual back, and the sum lands just under the value it should equal:
    // `0.9 * 0.35 + (0.9 - 0.9 * 0.35)` is 0.8999999999999999, so × 255 rounds to 229 where
    // the definition gives 230. One shade, but it breaks the rgb → hsb → rgb identity.
    expect(hsbToRgb({ h: 0, s: 10, b: 70 })).toEqual({ r: 179, g: 161, b: 161 });
    expect(hsbToRgb({ h: 0, s: 35, b: 90 })).toEqual({ r: 230, g: 149, b: 149 });
    expect(parseColour('hsb(0, 35%, 90%)')).toBe('#e69595');
    // The brightest channel is exactly `b`% of 255, for every hue and saturation.
    for (let hue = 0; hue < 360; hue += 7) {
      for (let sat = 0; sat <= 100; sat += 3) {
        const { r, g, b } = hsbToRgb({ h: hue, s: sat, b: 90 });
        expect(Math.max(r, g, b), `hsb(${hue}, ${sat}%, 90%)`).toBe(230);
      }
    }
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
    // `0.502`, not `0.5` — the stored byte is `80`, which is 128/255. Rendering the rounder
    // number would be showing the user an alpha that is not the one they have.
    expect(formatColour('#ff000080', 'RGB')).toBe('rgba(255, 0, 0, 0.502)');
    expect(formatColour('#ff000080', 'HSL')).toBe('hsla(0, 100%, 50%, 0.502)');
    expect(formatColour('#ff000080', 'HEX')).toBe('#FF000080');
  });

  it('falls back to hex for the formats that cannot express a translucent colour', () => {
    expect(formatColour('#ff000080', 'NAME')).toBe('#FF000080');
    // HSB used to append an ` @ 50%` suffix nothing could read back, so choosing it in the
    // control marked the user's own colour invalid.
    expect(formatColour('#ff000080', 'HSB')).toBe('#FF000080');
  });

  it('renders alpha precisely enough for every byte to survive the round trip', () => {
    // At two decimals the byte `01` rendered as `0`, turning a nearly-opaque colour
    // transparent on the way back in.
    expect(formatColour('#ff000001', 'RGB')).toBe('rgba(255, 0, 0, 0.004)');
    for (let byte = 0; byte < 255; byte += 1) {
      const hex = `#ff0000${byte.toString(16).padStart(2, '0')}`;
      expect(parseColour(formatColour(hex, 'RGB')), hex).toBe(hex);
      expect(parseColour(formatColour(hex, 'HSL')), hex).toBe(hex);
    }
  });

  it('falls back to hex when the colour has no name', () => {
    expect(formatColour('#d2691f', 'NAME')).toBe('#D2691F');
  });

  it('produces a value parseColour accepts back, exactly, for the lossless formats', () => {
    for (const hex of ['#d2691e', '#000000', '#ffffff', '#123456', '#00ff7f', '#ff000080', '#ff000001']) {
      for (const format of ['HEX', 'RGB', 'NAME'] as const) {
        const rendered = formatColour(hex, format);
        expect(parseColour(rendered), `${hex} as ${format}`).toBe(hex);
      }
    }
  });

  it('renders every format as something parseColour reads back, translucent colours included', () => {
    // The control drops this string straight into an editable box, so a rendering the parser
    // rejects would mark a colour the user already stored as invalid.
    for (const hex of ['#123456', '#ff000080', '#00000000']) {
      for (const format of COLOUR_FORMATS) {
        expect(parseColour(formatColour(hex, format)), `${hex} as ${format}`).not.toBeNull();
      }
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
