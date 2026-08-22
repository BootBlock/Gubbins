/**
 * Pure colour seam — parsing, canonicalisation and format conversion for the `COLOUR`
 * custom field type (issue #452).
 *
 * A `COLOUR` value is stored in `item_field_values.value` as a **canonical lowercase
 * `#rrggbb`** string (eight digits, `#rrggbbaa`, when the colour carries alpha). One
 * spelling in the column is what lets a value entered as `hsl(30 100% 50%)` on one device
 * render as `Chocolate` on another, and what keeps grouping/equality working without a
 * parser in every SQL comparison.
 *
 * Everything here is pure and dependency-free: no DOM, no `Date`, no canvas. That matters
 * because the same conversions run in the browser, in Vitest, and under the bridge's
 * strip-only Node loader.
 *
 * The formats are the ones a user is likely to have in their hand: hex, `rgb()`, `hsl()`,
 * HSB/HSV (what most colour pickers and filament vendors quote), and the CSS/Web named
 * colours. `parseColour` accepts all of them; `formatColour` renders a canonical value back
 * out as any of them.
 */

/** 8-bit sRGB channels, `0`–`255`. */
export interface Rgb {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

/** Hue `0`–`360`, saturation and lightness `0`–`100`. */
export interface Hsl {
  readonly h: number;
  readonly s: number;
  readonly l: number;
}

/**
 * Hue `0`–`360`, saturation and brightness `0`–`100`. Also called HSV. Distinct from
 * {@link Hsl}: the same hue/saturation pair means different things in the two models, so a
 * value quoted as HSB must never be fed to the HSL parser.
 */
export interface Hsb {
  readonly h: number;
  readonly s: number;
  readonly b: number;
}

/**
 * The spellings a canonical colour can be rendered back out as. `NAME` falls back to hex
 * when the colour is not exactly one of the CSS named colours — a name is only ever offered
 * when it is *the* colour, never as an approximation the user did not ask for.
 */
export const COLOUR_FORMATS = ['HEX', 'RGB', 'HSL', 'HSB', 'NAME'] as const;
export type ColourFormat = (typeof COLOUR_FORMATS)[number];

/**
 * The CSS/Web named colours (CSS Color Module Level 4), lowercased, mapped to their hex.
 * Kept as plain fact data rather than a dependency — it is a fixed list that never changes
 * and costs less than a package would.
 *
 * `grey` spellings are included alongside `gray`, because this is a British-English app and
 * a user typing `dimgrey` should not be told it is not a colour.
 */
export const CSS_COLOUR_NAMES: Readonly<Record<string, string>> = {
  aliceblue: '#f0f8ff',
  antiquewhite: '#faebd7',
  aqua: '#00ffff',
  aquamarine: '#7fffd4',
  azure: '#f0ffff',
  beige: '#f5f5dc',
  bisque: '#ffe4c4',
  black: '#000000',
  blanchedalmond: '#ffebcd',
  blue: '#0000ff',
  blueviolet: '#8a2be2',
  brown: '#a52a2a',
  burlywood: '#deb887',
  cadetblue: '#5f9ea0',
  chartreuse: '#7fff00',
  chocolate: '#d2691e',
  coral: '#ff7f50',
  cornflowerblue: '#6495ed',
  cornsilk: '#fff8dc',
  crimson: '#dc143c',
  cyan: '#00ffff',
  darkblue: '#00008b',
  darkcyan: '#008b8b',
  darkgoldenrod: '#b8860b',
  darkgray: '#a9a9a9',
  darkgrey: '#a9a9a9',
  darkgreen: '#006400',
  darkkhaki: '#bdb76b',
  darkmagenta: '#8b008b',
  darkolivegreen: '#556b2f',
  darkorange: '#ff8c00',
  darkorchid: '#9932cc',
  darkred: '#8b0000',
  darksalmon: '#e9967a',
  darkseagreen: '#8fbc8f',
  darkslateblue: '#483d8b',
  darkslategray: '#2f4f4f',
  darkslategrey: '#2f4f4f',
  darkturquoise: '#00ced1',
  darkviolet: '#9400d3',
  deeppink: '#ff1493',
  deepskyblue: '#00bfff',
  dimgray: '#696969',
  dimgrey: '#696969',
  dodgerblue: '#1e90ff',
  firebrick: '#b22222',
  floralwhite: '#fffaf0',
  forestgreen: '#228b22',
  fuchsia: '#ff00ff',
  gainsboro: '#dcdcdc',
  ghostwhite: '#f8f8ff',
  gold: '#ffd700',
  goldenrod: '#daa520',
  gray: '#808080',
  grey: '#808080',
  green: '#008000',
  greenyellow: '#adff2f',
  honeydew: '#f0fff0',
  hotpink: '#ff69b4',
  indianred: '#cd5c5c',
  indigo: '#4b0082',
  ivory: '#fffff0',
  khaki: '#f0e68c',
  lavender: '#e6e6fa',
  lavenderblush: '#fff0f5',
  lawngreen: '#7cfc00',
  lemonchiffon: '#fffacd',
  lightblue: '#add8e6',
  lightcoral: '#f08080',
  lightcyan: '#e0ffff',
  lightgoldenrodyellow: '#fafad2',
  lightgray: '#d3d3d3',
  lightgrey: '#d3d3d3',
  lightgreen: '#90ee90',
  lightpink: '#ffb6c1',
  lightsalmon: '#ffa07a',
  lightseagreen: '#20b2aa',
  lightskyblue: '#87cefa',
  lightslategray: '#778899',
  lightslategrey: '#778899',
  lightsteelblue: '#b0c4de',
  lightyellow: '#ffffe0',
  lime: '#00ff00',
  limegreen: '#32cd32',
  linen: '#faf0e6',
  magenta: '#ff00ff',
  maroon: '#800000',
  mediumaquamarine: '#66cdaa',
  mediumblue: '#0000cd',
  mediumorchid: '#ba55d3',
  mediumpurple: '#9370db',
  mediumseagreen: '#3cb371',
  mediumslateblue: '#7b68ee',
  mediumspringgreen: '#00fa9a',
  mediumturquoise: '#48d1cc',
  mediumvioletred: '#c71585',
  midnightblue: '#191970',
  mintcream: '#f5fffa',
  mistyrose: '#ffe4e1',
  moccasin: '#ffe4b5',
  navajowhite: '#ffdead',
  navy: '#000080',
  oldlace: '#fdf5e6',
  olive: '#808000',
  olivedrab: '#6b8e23',
  orange: '#ffa500',
  orangered: '#ff4500',
  orchid: '#da70d6',
  palegoldenrod: '#eee8aa',
  palegreen: '#98fb98',
  paleturquoise: '#afeeee',
  palevioletred: '#db7093',
  papayawhip: '#ffefd5',
  peachpuff: '#ffdab9',
  peru: '#cd853f',
  pink: '#ffc0cb',
  plum: '#dda0dd',
  powderblue: '#b0e0e6',
  purple: '#800080',
  rebeccapurple: '#663399',
  red: '#ff0000',
  rosybrown: '#bc8f8f',
  royalblue: '#4169e1',
  saddlebrown: '#8b4513',
  salmon: '#fa8072',
  sandybrown: '#f4a460',
  seagreen: '#2e8b57',
  seashell: '#fff5ee',
  sienna: '#a0522d',
  silver: '#c0c0c0',
  skyblue: '#87ceeb',
  slateblue: '#6a5acd',
  slategray: '#708090',
  slategrey: '#708090',
  snow: '#fffafa',
  springgreen: '#00ff7f',
  steelblue: '#4682b4',
  tan: '#d2b48c',
  teal: '#008080',
  thistle: '#d8bfd8',
  tomato: '#ff6347',
  turquoise: '#40e0d0',
  violet: '#ee82ee',
  wheat: '#f5deb3',
  white: '#ffffff',
  whitesmoke: '#f5f5f5',
  yellow: '#ffff00',
  yellowgreen: '#9acd32',
};

/**
 * Hex → the canonical name, for the reverse lookup {@link formatColour} needs. Built once.
 *
 * Several names share a hex (`aqua`/`cyan`, `gray`/`grey`). The first insertion wins, and
 * the map above is ordered so the winner is the one a British-English reader expects to see
 * offered back: `grey` is listed after `gray`, so `gray` wins — deliberately, because it is
 * the spelling CSS itself canonicalises to and the one that round-trips through every other
 * tool the user may paste the value into.
 */
const NAME_BY_HEX: Readonly<Record<string, string>> = Object.freeze(
  Object.entries(CSS_COLOUR_NAMES).reduce<Record<string, string>>((acc, [name, hex]) => {
    acc[hex] ??= name;
    return acc;
  }, {}),
);

/** Clamp `n` into `[lo, hi]`. NaN clamps to `lo` — a non-number is never let through. */
function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return n < lo ? lo : n > hi ? hi : n;
}

/** Two lowercase hex digits for one 8-bit channel. */
function hex2(n: number): string {
  return Math.round(clamp(n, 0, 255))
    .toString(16)
    .padStart(2, '0');
}

/**
 * Parse one channel token from an `rgb()` / `hsl()` argument list. A trailing `%` is read as
 * a percentage of `scale`; anything else is read as a plain number.
 */
function channel(token: string, scale: number): number | null {
  const text = token.trim();
  if (text.length === 0) return null;
  const isPercent = text.endsWith('%');
  const numeric = Number(isPercent ? text.slice(0, -1) : text);
  if (!Number.isFinite(numeric)) return null;
  return isPercent ? (numeric / 100) * scale : numeric;
}

/**
 * Split the argument list of a functional colour notation, accepting **both** the legacy
 * comma form (`rgb(1, 2, 3)`) and the CSS Color 4 space form (`rgb(1 2 3 / 50%)`). The alpha
 * separator is a `/` in the space form and a fourth comma in the legacy one.
 */
function splitArgs(body: string): string[] | null {
  const trimmed = body.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.includes(',')) return trimmed.split(',');
  const slashed = trimmed.split('/');
  if (slashed.length > 2) return null;
  const parts = (slashed[0] ?? '').trim().split(/\s+/);
  const alpha = slashed[1];
  return alpha === undefined ? parts : [...parts, alpha];
}

/** Alpha `0`–`1` from an optional fourth argument (`0.5` or `50%`); absent ⇒ opaque. */
function alphaOf(token: string | undefined): number | null {
  if (token === undefined) return 1;
  const value = channel(token, 1);
  return value === null ? null : clamp(value, 0, 1);
}

/** Wrap a hue into `[0, 360)` so `-30` and `330` mean the same colour. */
function wrapHue(h: number): number {
  if (!Number.isFinite(h)) return 0;
  const wrapped = h % 360;
  return wrapped < 0 ? wrapped + 360 : wrapped;
}

/** HSL (h `0`–`360`, s/l `0`–`100`) → 8-bit sRGB. */
export function hslToRgb({ h, s, l }: Hsl): Rgb {
  const hue = wrapHue(h);
  const sat = clamp(s, 0, 100) / 100;
  const light = clamp(l, 0, 100) / 100;
  const chroma = (1 - Math.abs(2 * light - 1)) * sat;
  const secondary = chroma * (1 - Math.abs(((hue / 60) % 2) - 1));
  const base = light - chroma / 2;
  const sector = Math.floor(hue / 60) % 6;
  const triples = [
    [chroma, secondary, 0],
    [secondary, chroma, 0],
    [0, chroma, secondary],
    [0, secondary, chroma],
    [secondary, 0, chroma],
    [chroma, 0, secondary],
  ] as const;
  // `sector` is `floor(hue/60) % 6` over a hue already wrapped into `[0, 360)`, so it indexes
  // this six-entry tuple; the fallback exists only to satisfy the compiler's index checking.
  const [r, g, b] = triples[sector] ?? triples[0];
  return {
    r: Math.round((r + base) * 255),
    g: Math.round((g + base) * 255),
    b: Math.round((b + base) * 255),
  };
}

/** 8-bit sRGB → HSL, rounded to whole degrees/percent (the precision a user types in). */
export function rgbToHsl({ r, g, b }: Rgb): Hsl {
  const red = clamp(r, 0, 255) / 255;
  const green = clamp(g, 0, 255) / 255;
  const blue = clamp(b, 0, 255) / 255;
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const delta = max - min;
  const light = (max + min) / 2;

  let hue = 0;
  if (delta !== 0) {
    if (max === red) hue = ((green - blue) / delta) % 6;
    else if (max === green) hue = (blue - red) / delta + 2;
    else hue = (red - green) / delta + 4;
    hue *= 60;
  }
  const sat = delta === 0 ? 0 : delta / (1 - Math.abs(2 * light - 1));
  return { h: Math.round(wrapHue(hue)), s: Math.round(sat * 100), l: Math.round(light * 100) };
}

/** HSB/HSV (h `0`–`360`, s/b `0`–`100`) → 8-bit sRGB, via the equivalent HSL. */
export function hsbToRgb({ h, s, b }: Hsb): Rgb {
  const sat = clamp(s, 0, 100) / 100;
  const brightness = clamp(b, 0, 100) / 100;
  const light = brightness * (1 - sat / 2);
  // At pure black or pure white the HSL saturation is undefined; 0 is the only sane reading.
  const hslSat = light === 0 || light === 1 ? 0 : (brightness - light) / Math.min(light, 1 - light);
  return hslToRgb({ h, s: hslSat * 100, l: light * 100 });
}

/**
 * 8-bit sRGB → HSB/HSV, rounded to whole degrees/percent.
 *
 * Computed straight from the channels rather than via {@link rgbToHsl}: that function rounds
 * its own output, and feeding rounded saturation/lightness back through the HSL↔HSB identity
 * compounds the error into a visibly wrong brightness on mid-tones.
 */
export function rgbToHsb({ r, g, b }: Rgb): Hsb {
  const red = clamp(r, 0, 255) / 255;
  const green = clamp(g, 0, 255) / 255;
  const blue = clamp(b, 0, 255) / 255;
  const max = Math.max(red, green, blue);
  const delta = max - Math.min(red, green, blue);
  return {
    h: rgbToHsl({ r, g, b }).h,
    s: Math.round((max === 0 ? 0 : delta / max) * 100),
    b: Math.round(max * 100),
  };
}

/** Canonical `#rrggbb` (or `#rrggbbaa`) for an RGB triple plus alpha `0`–`1`. */
function canonicalise(rgb: Rgb, alpha: number): string {
  const base = `#${hex2(rgb.r)}${hex2(rgb.g)}${hex2(rgb.b)}`;
  return alpha >= 1 ? base : `${base}${hex2(Math.round(alpha * 255))}`;
}

/** Match a functional notation such as `hsl(30 100% 50%)`, capturing the name and body. */
const FUNCTIONAL = /^([a-z]+)\(([^()]*)\)$/;

/**
 * Parse any accepted spelling of a colour into the canonical `#rrggbb` / `#rrggbbaa` form,
 * or `null` when the text is not a colour. **Never throws** — every caller branches on
 * `null`, the same contract the rest of the validation seam uses.
 *
 * Accepted:
 * - `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa` (the leading `#` is optional)
 * - `rgb()` / `rgba()`, legacy-comma or CSS Color 4 space-and-slash
 * - `hsl()` / `hsla()`, both forms, with or without a `deg` suffix on the hue
 * - `hsb()` / `hsv()`, both forms — not CSS, but what most pickers and filament vendors quote
 * - a CSS/Web colour name, `gray` and `grey` spellings alike
 *
 * Deliberately **not** accepted: `transparent` (an absent value, which the field already
 * expresses by being empty), `currentColor` (meaningless outside a stylesheet), and the wide
 * -gamut `color()` / `lab()` / `oklch()` functions. The stored form is 8-bit sRGB, so
 * accepting a wider gamut would silently clip the value the user typed.
 */
export function parseColour(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const text = raw.trim().toLowerCase();
  if (text.length === 0) return null;

  const named = CSS_COLOUR_NAMES[text];
  if (named !== undefined) return named;

  const functional = FUNCTIONAL.exec(text);
  if (functional) return parseFunctional(functional[1] ?? '', functional[2] ?? '');

  return parseHex(text.startsWith('#') ? text.slice(1) : text);
}

/** Parse the digits of a hex colour (no leading `#`), in 3, 4, 6 or 8 digit form. */
function parseHex(digits: string): string | null {
  if (!/^[0-9a-f]+$/.test(digits)) return null;
  const expanded =
    digits.length === 3 || digits.length === 4 ? [...digits].map((d) => d + d).join('') : digits;
  if (expanded.length !== 6 && expanded.length !== 8) return null;
  // An `ff` alpha is opaque and is dropped, so `#ff0000ff` and `#ff0000` store identically.
  return expanded.length === 8 && expanded.endsWith('ff') ? `#${expanded.slice(0, 6)}` : `#${expanded}`;
}

/** Parse one of the functional notations, given its lowercase name and argument body. */
function parseFunctional(name: string, body: string): string | null {
  const args = splitArgs(body);
  if (args === null || args.length < 3 || args.length > 4) return null;
  const [first = '', second = '', third = ''] = args;
  const alpha = alphaOf(args[3]);
  if (alpha === null) return null;

  if (name === 'rgb' || name === 'rgba') {
    const [r, g, b] = [channel(first, 255), channel(second, 255), channel(third, 255)];
    if (r === null || g === null || b === null) return null;
    return canonicalise({ r: clamp(r, 0, 255), g: clamp(g, 0, 255), b: clamp(b, 0, 255) }, alpha);
  }

  if (name === 'hsl' || name === 'hsla' || name === 'hsb' || name === 'hsv') {
    const hue = channel(first.replace(/deg$/, ''), 360);
    const axis = channel(second, 100);
    const level = channel(third, 100);
    if (hue === null || axis === null || level === null) return null;
    const rgb =
      name === 'hsb' || name === 'hsv'
        ? hsbToRgb({ h: hue, s: axis, b: level })
        : hslToRgb({ h: hue, s: axis, l: level });
    return canonicalise(rgb, alpha);
  }

  return null;
}

/** Split a canonical value into its RGB triple and alpha. Assumes {@link parseColour} output. */
export function toRgb(canonical: string): { readonly rgb: Rgb; readonly alpha: number } {
  const digits = canonical.startsWith('#') ? canonical.slice(1) : canonical;
  const rgb: Rgb = {
    r: Number.parseInt(digits.slice(0, 2), 16),
    g: Number.parseInt(digits.slice(2, 4), 16),
    b: Number.parseInt(digits.slice(4, 6), 16),
  };
  const alpha = digits.length === 8 ? Number.parseInt(digits.slice(6, 8), 16) / 255 : 1;
  return { rgb, alpha };
}

/** Round to at most `places` decimals without leaving a trailing `.0`. */
function trim(n: number, places: number): string {
  return String(Number(n.toFixed(places)));
}

/**
 * Render a canonical colour in one of the {@link COLOUR_FORMATS}. Alpha is carried through
 * every format that can express it (`rgba()`, `hsla()`, the 8-digit hex); `HSB` and `NAME`
 * cannot, so a translucent colour falls back to the form that can — the same rule as
 * "never show the user a value that is not the value they stored".
 */
export function formatColour(canonical: string, format: ColourFormat): string {
  const { rgb, alpha } = toRgb(canonical);
  const opaque = alpha >= 1;

  switch (format) {
    case 'HEX':
      return canonical.toUpperCase();
    case 'RGB':
      return opaque
        ? `rgb(${rgb.r}, ${rgb.g}, ${rgb.b})`
        : `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${trim(alpha, 2)})`;
    case 'HSL': {
      const { h, s, l } = rgbToHsl(rgb);
      return opaque ? `hsl(${h}, ${s}%, ${l}%)` : `hsla(${h}, ${s}%, ${l}%, ${trim(alpha, 2)})`;
    }
    case 'HSB': {
      const { h, s, b } = rgbToHsb(rgb);
      const base = `hsb(${h}, ${s}%, ${b}%)`;
      return opaque ? base : `${base} @ ${Math.round(alpha * 100)}%`;
    }
    case 'NAME': {
      const name = opaque ? NAME_BY_HEX[canonical] : undefined;
      return name ?? canonical.toUpperCase();
    }
  }
}

/**
 * The CSS colour name for a canonical value, or `null` when it is not exactly a named
 * colour. Exact only, never a nearest-match: telling a user their `#d2691f` filament is
 * "Chocolate" would be inventing a fact about their spool.
 */
export function colourName(canonical: string): string | null {
  return NAME_BY_HEX[canonical.toLowerCase()] ?? null;
}

/**
 * Relative luminance (WCAG 2.x) of a canonical colour, `0`–`1`. Alpha is ignored — a swatch
 * is drawn over an unknown background, so the honest reading is of the colour itself.
 */
export function relativeLuminance(canonical: string): number {
  const { rgb } = toRgb(canonical);
  const linearise = (v: number): number => {
    const channelValue = v / 255;
    return channelValue <= 0.04045 ? channelValue / 12.92 : ((channelValue + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linearise(rgb.r) + 0.7152 * linearise(rgb.g) + 0.0722 * linearise(rgb.b);
}

/**
 * `'#000000'` or `'#ffffff'` — whichever reads better as text or a border **on** the given
 * colour. Used so a swatch stays legible at both ends of the range without a theme token
 * (the swatch is the user's colour, not the app's, so no token could apply).
 */
export function contrastingInk(canonical: string): '#000000' | '#ffffff' {
  return relativeLuminance(canonical) > 0.179 ? '#000000' : '#ffffff';
}
