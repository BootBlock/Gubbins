/**
 * A lean, dependency-free Code 128 barcode encoder (renders to crisp SVG).
 *
 * Mirroring the hand-rolled QR encoder ({@link ../../scanner/qr-code}), we
 * hand-roll Code 128 from the spec rather than pulling in an npm barcode
 * library: the symbology is small and well-specified, and a pure encoder keeps
 * it testable and bloat-free. The pipeline is the classic three stages —
 * {@link encodeCode128} (text → symbol values), {@link code128Modules} (symbol
 * values → a flat module bitmap), and {@link code128Svg} (bitmap → a
 * self-contained, print-ready SVG with `shape-rendering="crispEdges"`).
 *
 * Implementation follows ISO/IEC 15417. We support **Code Set B** (printable
 * ASCII 32..126) and **Code Set C** (digit pairs, 2 digits per symbol):
 *
 *   - Encoding strategy: a greedy, decodable optimiser. We start in Code C when
 *     the data is an all-digit even-length string or begins with an even run of
 *     ≥ 4 digits; otherwise we start in Code B. Mid-stream we switch into Code C
 *     for any even-length run of ≥ 6 digits (the break-even point where the
 *     switch symbol pays for itself) and switch back to Code B afterwards. This
 *     never sacrifices decodability — any valid path through the code sets round-
 *     trips — it only trades a little compression for clarity.
 *   - Code Set B encodes ASCII 32..126 as value = `charCode - 32`.
 *   - Code Set C encodes digit pairs "00".."99" as values 0..99.
 *   - Checksum: weighted modulo-103. `check = (start + Σ valueᵢ·i) mod 103`,
 *     with `i` starting at 1 for the first data symbol. Appended before the stop
 *     symbol (106).
 *
 * Anything outside Code B's encodable range (or an empty string) throws
 * {@link Code128Error}.
 */

export class Code128Error extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Code128Error';
  }
}

// --- Symbol constants -----------------------------------------------------------

const START_B = 104;
const START_C = 105;
const CODE_B = 100; // switch-to-B symbol
const CODE_C = 99; // switch-to-C symbol
const STOP = 106;

/**
 * The canonical Code 128 module table (ISO/IEC 15417). Index = symbol value
 * 0..106; each entry is the 11-module bar/space pattern as a bit string
 * (`1` = bar/dark, `0` = space/light). Index 106 (stop) is the 13-module
 * pattern `1100011101011` (the 11-module stop plus its 2-module termination
 * bar). Transcribed exactly from the spec.
 */
const PATTERNS: readonly string[] = [
  '11011001100',
  '11001101100',
  '11001100110',
  '10010011000',
  '10010001100',
  '10001001100',
  '10011001000',
  '10011000100',
  '10001100100',
  '11001001000',
  '11001000100',
  '11000100100',
  '10110011100',
  '10011011100',
  '10011001110',
  '10111001100',
  '10011101100',
  '10011100110',
  '11001110010',
  '11001011100',
  '11001001110',
  '11011100100',
  '11001110100',
  '11101101110',
  '11101001100',
  '11100101100',
  '11100100110',
  '11101100100',
  '11100110100',
  '11100110010',
  '11011011000',
  '11011000110',
  '11000110110',
  '10100011000',
  '10001011000',
  '10001000110',
  '10110001000',
  '10001101000',
  '10001100010',
  '11010001000',
  '11000101000',
  '11000100010',
  '10110111000',
  '10110001110',
  '10001101110',
  '10111011000',
  '10111000110',
  '10001110110',
  '11101110110',
  '11010001110',
  '11000101110',
  '11011101000',
  '11011100010',
  '11011101110',
  '11101011000',
  '11101000110',
  '11100010110',
  '11101101000',
  '11101100010',
  '11100011010',
  '11101111010',
  '11001000010',
  '11110001010',
  '10100110000',
  '10100001100',
  '10010110000',
  '10010000110',
  '10000101100',
  '10000100110',
  '10110010000',
  '10110000100',
  '10011010000',
  '10011000010',
  '10000110100',
  '10000110010',
  '11000010010',
  '11001010000',
  '11110111010',
  '11000010100',
  '10001111010',
  '10100111100',
  '10010111100',
  '10010011110',
  '10111100100',
  '10011110100',
  '10011110010',
  '11110100100',
  '11110010100',
  '11110010010',
  '11011011110',
  '11011110110',
  '11110110110',
  '10101111000',
  '10100011110',
  '10001011110',
  '10111101000',
  '10111100010',
  '11110101000',
  '11110100010',
  '10111011110',
  '10111101110',
  '11101011110',
  '11110101110',
  '11010000100',
  '11010010000',
  '11010011100',
  '1100011101011',
];

/** True if `code` is a single ASCII digit ("0".."9"). */
function isDigit(code: number): boolean {
  return code >= 48 && code <= 57;
}

/**
 * Count the length of the leading digit run starting at `i` in `codes`.
 * Used by the Code-C switch heuristic.
 */
function digitRunLength(codes: number[], i: number): number {
  let n = 0;
  while (i + n < codes.length && isDigit(codes[i + n]!)) n += 1;
  return n;
}

/**
 * Encode `text` into the full Code 128 symbol-value sequence: start code,
 * encoded data, the mod-103 checksum symbol, and the stop symbol (106). Pure.
 *
 * @throws {Code128Error} on empty input or any character outside ASCII 32..126.
 */
export function encodeCode128(text: string): number[] {
  if (text.length === 0) throw new Code128Error('Cannot encode an empty string.');

  const codes: number[] = [];
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (code < 32 || code > 126) {
      throw new Code128Error(
        `Character ${JSON.stringify(ch)} (code ${code}) is not encodable in Code 128 (Code Set B, 32..126).`,
      );
    }
    codes.push(code);
  }

  // Decide the starting code set: Code C when the whole string is an even-length
  // run of digits, or it opens with an even run of ≥ 4 digits.
  const allDigits = codes.every(isDigit);
  const leadRun = digitRunLength(codes, 0);
  const startInC = (allDigits && codes.length % 2 === 0) || (leadRun >= 4 && leadRun % 2 === 0);

  const symbols: number[] = [];
  symbols.push(startInC ? START_C : START_B);
  let inC = startInC;
  let i = 0;

  while (i < codes.length) {
    if (inC) {
      const run = digitRunLength(codes, i);
      if (run >= 2) {
        // Emit as many digit pairs as the remaining even run allows.
        const pairs = Math.floor(run / 2);
        for (let p = 0; p < pairs; p += 1) {
          const hi = codes[i]! - 48;
          const lo = codes[i + 1]! - 48;
          symbols.push(hi * 10 + lo);
          i += 2;
        }
        // A trailing odd digit (or any non-digit) needs Code B.
        if (i < codes.length) {
          symbols.push(CODE_B);
          inC = false;
        }
      } else {
        symbols.push(CODE_B);
        inC = false;
      }
    } else {
      // In Code B: switch into Code C for an even-length run of ≥ 6 digits.
      const run = digitRunLength(codes, i);
      const switchLen = run % 2 === 0 ? run : run - 1; // even portion usable by C
      if (switchLen >= 6) {
        symbols.push(CODE_C);
        inC = true;
        continue;
      }
      symbols.push(codes[i]! - 32);
      i += 1;
    }
  }

  symbols.push(checksum(symbols));
  symbols.push(STOP);
  return symbols;
}

/**
 * Weighted mod-103 checksum: `(start + Σ valueᵢ·i) mod 103`, where the start
 * code contributes with weight 1 and the first data symbol has position 1.
 */
function checksum(symbols: number[]): number {
  // symbols[0] is the start code (weight 1); subsequent data symbols weight i.
  let sum = symbols[0]!;
  for (let i = 1; i < symbols.length; i += 1) sum += symbols[i]! * i;
  return sum % 103;
}

/**
 * Expand the symbol sequence to its flat module bitmap (`true` = bar/dark).
 * Each symbol is 11 modules; the stop symbol (106) contributes 13 modules (its
 * 11-module pattern plus the 2-module termination bar), so the canonical stop
 * pattern `1100011101011` ends the bitmap. No quiet zone is included here.
 */
export function code128Modules(text: string): boolean[] {
  const symbols = encodeCode128(text);
  const modules: boolean[] = [];
  for (const value of symbols) {
    const pattern = PATTERNS[value]!;
    for (const bit of pattern) modules.push(bit === '1');
  }
  return modules;
}

export interface Code128Options {
  /** Width in px of one module (default 2). */
  scale?: number;
  /** Bar height in px (default 60). */
  height?: number;
  /** Quiet-zone width in **modules** each side (default 10, spec minimum). */
  margin?: number;
  dark?: string;
  light?: string;
  /** Render the human-readable value below the bars (default true). */
  showText?: boolean;
}

/**
 * Encode `text` and render a crisp, print-ready Code 128 SVG string. Contiguous
 * dark modules merge into a single `<rect>` for compactness, and the left/right
 * quiet zone is included. With `showText`, the raw `text` is centred below the
 * bars in a system-ui font.
 */
export function code128Svg(text: string, options: Code128Options = {}): string {
  const scale = options.scale ?? 2;
  const height = options.height ?? 60;
  const margin = options.margin ?? 10;
  const dark = options.dark ?? '#000000';
  const light = options.light ?? '#ffffff';
  const showText = options.showText ?? true;

  const modules = code128Modules(text);
  const totalModules = modules.length + margin * 2;
  const width = totalModules * scale;
  const textGap = showText ? 14 : 0;
  const svgHeight = height + textGap;

  // Merge adjacent dark modules into one rect (horizontal run-length encoding).
  let rects = '';
  let run = 0;
  for (let i = 0; i <= modules.length; i += 1) {
    const isDark = i < modules.length && modules[i] === true;
    if (isDark) {
      run += 1;
    } else if (run > 0) {
      const x = (margin + i - run) * scale;
      rects += `<rect x="${x}" y="0" width="${run * scale}" height="${height}" fill="${dark}"/>`;
      run = 0;
    }
  }

  let textEl = '';
  if (showText) {
    const cx = width / 2;
    const ty = height + textGap - 2;
    const escaped = escapeXml(text);
    textEl =
      `<text x="${cx}" y="${ty}" text-anchor="middle" ` +
      `font-family="system-ui, sans-serif" font-size="12" fill="${dark}">${escaped}</text>`;
  }

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${svgHeight}" ` +
    `viewBox="0 0 ${width} ${svgHeight}" shape-rendering="crispEdges">` +
    `<rect width="${width}" height="${svgHeight}" fill="${light}"/>` +
    `${rects}${textEl}</svg>`
  );
}

/** Escape the five XML metacharacters so arbitrary text is safe in `<text>`. */
function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
