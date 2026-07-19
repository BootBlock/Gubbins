/**
 * A lean, dependency-free QR Code generator (spec §2.4.3 native/no-bloat, §5).
 *
 * Per the §2.4.3 "native APIs over NPM bloat" mandate we hand-roll a compact
 * encoder instead of pulling in a QR library. It supports exactly what Gubbins
 * needs: **byte mode**, error-correction level **M**, automatically choosing the
 * smallest QR version (1–10) that fits the payload — version 10 holds 213 bytes,
 * which comfortably covers an item deep-link even when the "Link host" setting
 * points at a long name (a Tailscale/ngrok host, a deep GitHub-Pages path). From
 * version 7 the symbol also carries an 18-bit version-information block in two
 * corners; that is encoded from a small pre-computed table below. The output is a
 * boolean module matrix; rendering it to SVG (for crisp printing) lives in
 * {@link toSvg}, keeping the encoder pure/testable.
 *
 * A payload that still doesn't fit throws {@link QrError}. Callers must treat that as
 * "no QR for this one" rather than letting it escape — see {@link qrSvgOrNull}, which
 * is what every rendering call site uses.
 *
 * Implementation follows the ISO/IEC 18004 reference: Reed–Solomon ECC over GF(256),
 * the fixed function patterns (finders, timing, alignment), data masking with the
 * eight standard masks, and penalty-based mask selection.
 */

// --- Galois field GF(256) tables (generator 0x11d) -----------------------------
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i += 1) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i += 1) EXP[i] = EXP[i - 255]!;
})();

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return EXP[LOG[a]! + LOG[b]!]!;
}

/**
 * Build the Reed–Solomon generator polynomial `∏(x − α^i)` of `degree`, as coefficients in
 * **descending** power order — `poly[0]` is the leading (always 1) `x^degree` term.
 *
 * The ordering is load-bearing: {@link rsEncode} keeps its running remainder in the same
 * descending order, and pairing one order with the other silently yields plausible-looking
 * but invalid check bytes (the symbol scans as nothing rather than failing loudly).
 */
function rsGenerator(degree: number): number[] {
  let poly = [1];
  for (let i = 0; i < degree; i += 1) {
    const next = new Array<number>(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j += 1) {
      next[j] = next[j]! ^ poly[j]!; // multiply by x — degree up, index unchanged
      next[j + 1] = next[j + 1]! ^ gfMul(poly[j]!, EXP[i]!); // × α^i at the same degree
    }
    poly = next;
  }
  return poly;
}

/**
 * Compute `ecLen` Reed–Solomon error-correction codewords for `data`, given the generator
 * polynomial from {@link rsGenerator}. The generator is passed in rather than derived here so a
 * multi-block symbol builds it once instead of once per block.
 *
 * `gen[0]` is the monic leading term, which the division below implies; the coefficients that
 * multiply into the remainder are `gen[1…ecLen]`.
 */
function rsEncode(data: number[], ecLen: number, gen: number[]): number[] {
  const res = new Array<number>(ecLen).fill(0);
  for (const byte of data) {
    const factor = byte ^ res[0]!;
    res.shift();
    res.push(0);
    for (let i = 0; i < ecLen; i += 1) res[i] = res[i]! ^ gfMul(gen[i + 1]!, factor);
  }
  return res;
}

// --- Version capacities for byte mode, EC level M (versions 1–10) ---------------
// Values are the ISO/IEC 18004 Table 9 block layout for EC level M.
// [ total data codewords, EC codewords per block, [block counts/sizes] ]
interface VersionSpec {
  readonly version: number;
  readonly totalCodewords: number; // data codewords available (mode M)
  readonly ecPerBlock: number;
  readonly group1Blocks: number;
  readonly group1Size: number;
  readonly group2Blocks: number;
  readonly group2Size: number;
  readonly alignment: number[]; // alignment pattern centre coordinates
}

const VERSIONS: VersionSpec[] = [
  {
    version: 1,
    totalCodewords: 16,
    ecPerBlock: 10,
    group1Blocks: 1,
    group1Size: 16,
    group2Blocks: 0,
    group2Size: 0,
    alignment: [],
  },
  {
    version: 2,
    totalCodewords: 28,
    ecPerBlock: 16,
    group1Blocks: 1,
    group1Size: 28,
    group2Blocks: 0,
    group2Size: 0,
    alignment: [6, 18],
  },
  {
    version: 3,
    totalCodewords: 44,
    ecPerBlock: 26,
    group1Blocks: 1,
    group1Size: 44,
    group2Blocks: 0,
    group2Size: 0,
    alignment: [6, 22],
  },
  {
    version: 4,
    totalCodewords: 64,
    ecPerBlock: 18,
    group1Blocks: 2,
    group1Size: 32,
    group2Blocks: 0,
    group2Size: 0,
    alignment: [6, 26],
  },
  {
    version: 5,
    totalCodewords: 86,
    ecPerBlock: 24,
    group1Blocks: 2,
    group1Size: 43,
    group2Blocks: 0,
    group2Size: 0,
    alignment: [6, 30],
  },
  {
    version: 6,
    totalCodewords: 108,
    ecPerBlock: 16,
    group1Blocks: 4,
    group1Size: 27,
    group2Blocks: 0,
    group2Size: 0,
    alignment: [6, 34],
  },
  {
    version: 7,
    totalCodewords: 124,
    ecPerBlock: 18,
    group1Blocks: 4,
    group1Size: 31,
    group2Blocks: 0,
    group2Size: 0,
    alignment: [6, 22, 38],
  },
  {
    version: 8,
    totalCodewords: 154,
    ecPerBlock: 22,
    group1Blocks: 2,
    group1Size: 38,
    group2Blocks: 2,
    group2Size: 39,
    alignment: [6, 24, 42],
  },
  {
    version: 9,
    totalCodewords: 182,
    ecPerBlock: 22,
    group1Blocks: 3,
    group1Size: 36,
    group2Blocks: 2,
    group2Size: 37,
    alignment: [6, 26, 46],
  },
  {
    version: 10,
    totalCodewords: 216,
    ecPerBlock: 26,
    group1Blocks: 4,
    group1Size: 43,
    group2Blocks: 1,
    group2Size: 44,
    alignment: [6, 28, 50],
  },
];

/** Bits the byte-mode header costs: a 4-bit mode indicator plus the character count. */
function headerBits(version: number): number {
  return 4 + (version >= 10 ? 16 : 8);
}

/**
 * The largest payload (in UTF-8 bytes) the encoder can carry — the biggest version in
 * {@link VERSIONS}, less its byte-mode header. **Derived, not hard-coded**, so extending the
 * table above automatically raises this rather than leaving {@link fitsInQr} quietly
 * disagreeing with {@link chooseVersion}.
 */
export const MAX_QR_BYTES = (() => {
  const largest = VERSIONS[VERSIONS.length - 1]!;
  return Math.floor((largest.totalCodewords * 8 - headerBits(largest.version)) / 8);
})();

/**
 * 18-bit version information (6 data bits + 12 BCH(18,6) bits), required from version 7.
 * Pre-computed rather than derived, matching the format-info table below.
 */
const VERSION_INFO: Readonly<Record<number, number>> = {
  7: 0x07c94,
  8: 0x085bc,
  9: 0x09a99,
  10: 0x0a4d3,
};

/** @internal Exported for unit tests only. */
export class QrError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QrError';
  }
}

export interface QrMatrix {
  readonly size: number;
  /** Row-major `size × size` modules; true = dark. */
  readonly modules: boolean[][];
  readonly version: number;
}

/**
 * Encode UTF-8 `text` into a QR module matrix (byte mode, EC level M).
 *
 * @internal Exported for unit tests only.
 */
export function encodeQr(text: string): QrMatrix {
  const bytes = utf8Bytes(text);
  const spec = chooseVersion(bytes.length);
  const dataCodewords = buildDataCodewords(bytes, spec);
  const finalCodewords = interleave(dataCodewords, spec);
  return buildMatrix(finalCodewords, spec);
}

function utf8Bytes(text: string): number[] {
  return Array.from(new TextEncoder().encode(text));
}

function chooseVersion(byteLen: number): VersionSpec {
  for (const spec of VERSIONS) {
    // mode(4) + length(8 or 16) + data(8·n) bits must fit the data capacity.
    if (headerBits(spec.version) + byteLen * 8 <= spec.totalCodewords * 8) return spec;
  }
  throw new QrError(`Payload is ${byteLen} bytes; the largest supported QR symbol holds ${MAX_QR_BYTES}.`);
}

/** Build the bitstream, pad it, and split into per-block data codewords. */
function buildDataCodewords(bytes: number[], spec: VersionSpec): number[][] {
  const bits: number[] = [];
  const push = (value: number, len: number) => {
    for (let i = len - 1; i >= 0; i -= 1) bits.push((value >> i) & 1);
  };

  push(0b0100, 4); // byte mode indicator
  push(bytes.length, spec.version >= 10 ? 16 : 8); // character count
  for (const b of bytes) push(b, 8);

  const capacityBits = spec.totalCodewords * 8;
  // Terminator (up to 4 zero bits) then pad to a byte boundary.
  for (let i = 0; i < 4 && bits.length < capacityBits; i += 1) bits.push(0);
  while (bits.length % 8 !== 0) bits.push(0);

  const codewords: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    codewords.push(parseInt(bits.slice(i, i + 8).join(''), 2));
  }
  // Pad bytes alternate 0xEC / 0x11 until the data capacity is filled.
  const pads = [0xec, 0x11];
  let p = 0;
  while (codewords.length < spec.totalCodewords) {
    codewords.push(pads[p % 2]!);
    p += 1;
  }

  // Split into blocks per the version's group layout.
  const blocks: number[][] = [];
  let offset = 0;
  for (let i = 0; i < spec.group1Blocks; i += 1) {
    blocks.push(codewords.slice(offset, offset + spec.group1Size));
    offset += spec.group1Size;
  }
  for (let i = 0; i < spec.group2Blocks; i += 1) {
    blocks.push(codewords.slice(offset, offset + spec.group2Size));
    offset += spec.group2Size;
  }
  return blocks;
}

/** Interleave data + EC codewords across blocks per ISO/IEC 18004 §8.6. */
function interleave(dataBlocks: number[][], spec: VersionSpec): number[] {
  const gen = rsGenerator(spec.ecPerBlock);
  const ecBlocks = dataBlocks.map((b) => rsEncode(b, spec.ecPerBlock, gen));
  const result: number[] = [];

  const maxData = Math.max(...dataBlocks.map((b) => b.length));
  for (let i = 0; i < maxData; i += 1) {
    for (const block of dataBlocks) if (i < block.length) result.push(block[i]!);
  }
  for (let i = 0; i < spec.ecPerBlock; i += 1) {
    for (const block of ecBlocks) result.push(block[i]!);
  }
  return result;
}

// --- Matrix construction --------------------------------------------------------

function buildMatrix(codewords: number[], spec: VersionSpec): QrMatrix {
  const size = spec.version * 4 + 17;
  const modules: (boolean | null)[][] = Array.from({ length: size }, () =>
    new Array<boolean | null>(size).fill(null),
  );
  const reserved: boolean[][] = Array.from({ length: size }, () => new Array(size).fill(false));

  placeFinder(modules, reserved, 0, 0, size);
  placeFinder(modules, reserved, size - 7, 0, size);
  placeFinder(modules, reserved, 0, size - 7, size);
  placeTiming(modules, reserved, size);
  placeAlignment(modules, reserved, spec, size);
  reserveFormat(reserved, size);
  // Version information (v7+) is mask-independent, so it is placed once, up front, and
  // reserved so the data walk and the mask both leave it alone.
  placeVersionInfo(modules, reserved, spec, size);
  // Dark module (always set) beside the bottom-left finder.
  modules[size - 8]![8] = true;
  reserved[size - 8]![8] = true;

  placeData(modules, reserved, codewords, size);

  // Try all 8 masks, keep the lowest-penalty result.
  let best: boolean[][] | null = null;
  let bestPenalty = Infinity;
  for (let mask = 0; mask < 8; mask += 1) {
    const candidate = applyMask(modules, reserved, mask, size);
    placeFormat(candidate, mask, size);
    const penalty = scorePenalty(candidate, size);
    if (penalty < bestPenalty) {
      bestPenalty = penalty;
      best = candidate;
    }
  }
  return { size, modules: best!, version: spec.version };
}

function placeFinder(m: (boolean | null)[][], r: boolean[][], row: number, col: number, size: number): void {
  for (let dr = -1; dr <= 7; dr += 1) {
    for (let dc = -1; dc <= 7; dc += 1) {
      const rr = row + dr;
      const cc = col + dc;
      if (rr < 0 || rr >= size || cc < 0 || cc >= size) continue;
      const isBorder = dr === 0 || dr === 6 || dc === 0 || dc === 6;
      const isCore = dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4;
      m[rr]![cc] = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6 && (isBorder || isCore);
      r[rr]![cc] = true;
    }
  }
}

function placeTiming(m: (boolean | null)[][], r: boolean[][], size: number): void {
  for (let i = 8; i < size - 8; i += 1) {
    const dark = i % 2 === 0;
    if (!r[6]![i]) {
      m[6]![i] = dark;
      r[6]![i] = true;
    }
    if (!r[i]![6]) {
      m[i]![6] = dark;
      r[i]![6] = true;
    }
  }
}

function placeAlignment(m: (boolean | null)[][], r: boolean[][], spec: VersionSpec, size: number): void {
  const centres = spec.alignment;
  for (const cy of centres) {
    for (const cx of centres) {
      // Skip the three corners occupied by finder patterns.
      if ((cy === 6 && cx === 6) || (cy === 6 && cx === size - 7) || (cy === size - 7 && cx === 6)) {
        continue;
      }
      for (let dr = -2; dr <= 2; dr += 1) {
        for (let dc = -2; dc <= 2; dc += 1) {
          const rr = cy + dr;
          const cc = cx + dc;
          const ring = Math.max(Math.abs(dr), Math.abs(dc));
          m[rr]![cc] = ring === 2 || ring === 0;
          r[rr]![cc] = true;
        }
      }
    }
  }
}

function reserveFormat(r: boolean[][], size: number): void {
  for (let i = 0; i < 9; i += 1) {
    r[8]![i] = true;
    r[i]![8] = true;
  }
  for (let i = 0; i < 8; i += 1) {
    r[8]![size - 1 - i] = true;
    r[size - 1 - i]![8] = true;
  }
}

/**
 * Place the 18-bit version information block (ISO/IEC 18004 §8.10), present from version 7 only.
 *
 * Two transposed copies are written, each holding all 18 bits (LSB first):
 *
 * - **Above the bottom-left finder** — a 3-row × 6-column block at rows `size-11 … size-9`,
 *   columns `0 … 5`. Bit `i` sits at row `size-11 + (i % 3)`, column `⌊i / 3⌋`.
 * - **Left of the top-right finder** — the transpose of the above: a 6-row × 3-column block at
 *   rows `0 … 5`, columns `size-11 … size-9`.
 *
 * A no-op below version 7, where the symbol carries no version information at all.
 */
function placeVersionInfo(m: (boolean | null)[][], r: boolean[][], spec: VersionSpec, size: number): void {
  const bits = VERSION_INFO[spec.version];
  if (bits === undefined) return;
  for (let i = 0; i < 18; i += 1) {
    const bit = ((bits >> i) & 1) === 1;
    const near = size - 11 + (i % 3);
    const far = Math.floor(i / 3);
    m[near]![far] = bit; // bottom-left strip
    r[near]![far] = true;
    m[far]![near] = bit; // top-right strip
    r[far]![near] = true;
  }
}

function placeData(m: (boolean | null)[][], r: boolean[][], codewords: number[], size: number): void {
  const bits: number[] = [];
  for (const cw of codewords) for (let i = 7; i >= 0; i -= 1) bits.push((cw >> i) & 1);

  let bitIndex = 0;
  let upward = true;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col -= 1; // skip the vertical timing column
    for (let i = 0; i < size; i += 1) {
      const row = upward ? size - 1 - i : i;
      for (let c = 0; c < 2; c += 1) {
        const cc = col - c;
        if (r[row]![cc]) continue;
        m[row]![cc] = bitIndex < bits.length ? bits[bitIndex] === 1 : false;
        bitIndex += 1;
      }
    }
    upward = !upward;
  }
}

function maskFn(mask: number, row: number, col: number): boolean {
  switch (mask) {
    case 0:
      return (row + col) % 2 === 0;
    case 1:
      return row % 2 === 0;
    case 2:
      return col % 3 === 0;
    case 3:
      return (row + col) % 3 === 0;
    case 4:
      return (Math.floor(row / 2) + Math.floor(col / 3)) % 2 === 0;
    case 5:
      return ((row * col) % 2) + ((row * col) % 3) === 0;
    case 6:
      return (((row * col) % 2) + ((row * col) % 3)) % 2 === 0;
    default:
      return (((row + col) % 2) + ((row * col) % 3)) % 2 === 0;
  }
}

function applyMask(m: (boolean | null)[][], r: boolean[][], mask: number, size: number): boolean[][] {
  const out: boolean[][] = Array.from({ length: size }, () => new Array(size).fill(false));
  for (let row = 0; row < size; row += 1) {
    for (let col = 0; col < size; col += 1) {
      let v = m[row]![col] === true;
      if (!r[row]![col] && maskFn(mask, row, col)) v = !v;
      out[row]![col] = v;
    }
  }
  return out;
}

// Format info for EC level M, indexed by mask (15-bit BCH, pre-computed).
const FORMAT_BITS_M = [0x5412, 0x5125, 0x5e7c, 0x5b4b, 0x45f9, 0x40ce, 0x4f97, 0x4aa0];

/**
 * Place the two copies of the 15-bit format information (ISO/IEC 18004 §8.9).
 *
 * Orientation matters and is easy to invert:
 *
 * - **First copy**, around the top-left finder — bits 0–7 run **down column 8** (rows 0–5, then
 *   row 7, skipping the row-6 timing module, ending at the (8,8) corner); bits 8–14 continue
 *   **leftwards along row 8** (columns 7, then 5→0, skipping the column-6 timing module).
 * - **Second copy**, split across the other two finders — bits 0–7 run **leftwards along row 8**
 *   from the right edge (columns `size-1` → `size-8`, beside the top-right finder); bits 8–14 run
 *   **down column 8** (rows `size-7` → `size-1`, beside the bottom-left finder).
 *
 * Writing either copy along the wrong axis yields a symbol whose declared mask disagrees with the
 * mask actually applied, so a decoder unmasks the wrong pattern and fails Reed–Solomon — a code
 * that looks perfectly well-formed but scans as nothing.
 */
function placeFormat(m: boolean[][], mask: number, size: number): void {
  const bits = FORMAT_BITS_M[mask]!;
  for (let i = 0; i < 15; i += 1) {
    const bit = ((bits >> i) & 1) === 1;
    // First copy, around the top-left finder.
    if (i < 6) m[i]![8] = bit;
    else if (i === 6) m[7]![8] = bit;
    else if (i === 7) m[8]![8] = bit;
    else if (i === 8) m[8]![7] = bit;
    else m[8]![14 - i] = bit;
    // The split second copy, around the other two finders.
    if (i < 8) m[8]![size - 1 - i] = bit;
    else m[size - 15 + i]![8] = bit;
  }
}

/** Extract column `i` as a dense boolean array (the matrix is fully populated). */
function column(m: boolean[][], i: number): boolean[] {
  return m.map((row) => row[i]!);
}

// --- Mask penalty scoring (ISO/IEC 18004 §8.8.2) --------------------------------
function scorePenalty(m: boolean[][], size: number): number {
  let penalty = 0;

  // Rule 1: runs of 5+ same-colour modules in a row/column.
  for (let i = 0; i < size; i += 1) {
    penalty += runPenalty(m[i]!);
    penalty += runPenalty(column(m, i));
  }

  // Rule 2: 2×2 blocks of the same colour.
  for (let row = 0; row < size - 1; row += 1) {
    for (let col = 0; col < size - 1; col += 1) {
      const v = m[row]![col];
      if (v === m[row]![col + 1] && v === m[row + 1]![col] && v === m[row + 1]![col + 1]) penalty += 3;
    }
  }

  // Rule 3: finder-like 1:1:3:1:1 patterns in rows and columns.
  for (let i = 0; i < size; i += 1) {
    penalty += finderPenalty(m[i]!);
    penalty += finderPenalty(column(m, i));
  }

  // Rule 4: overall dark/light balance.
  let dark = 0;
  for (let row = 0; row < size; row += 1) for (let col = 0; col < size; col += 1) if (m[row]![col]) dark += 1;
  const ratio = (dark * 100) / (size * size);
  penalty += Math.floor(Math.abs(ratio - 50) / 5) * 10;

  return penalty;
}

function runPenalty(line: boolean[]): number {
  let penalty = 0;
  let run = 1;
  for (let i = 1; i < line.length; i += 1) {
    if (line[i] === line[i - 1]!) {
      run += 1;
      if (run === 5) penalty += 3;
      else if (run > 5) penalty += 1;
    } else {
      run = 1;
    }
  }
  return penalty;
}

function finderPenalty(line: boolean[]): number {
  let penalty = 0;
  const pattern = [true, false, true, true, true, false, true];
  for (let i = 0; i + 7 <= line.length; i += 1) {
    if (pattern.every((p, j) => line[i + j]! === p)) {
      const before = i >= 4 && line.slice(i - 4, i).every((v) => !v);
      const after = i + 11 <= line.length && line.slice(i + 7, i + 11).every((v) => !v);
      if (before || after) penalty += 40;
    }
  }
  return penalty;
}

// --- Rendering ------------------------------------------------------------------

export interface SvgOptions {
  /** Module size in px (default 4). */
  readonly scale?: number;
  /** Quiet-zone width in modules (default 4, per spec). */
  readonly margin?: number;
  readonly dark?: string;
  readonly light?: string;
}

/** Render a matrix to a crisp, print-ready SVG string. */
export function toSvg(matrix: QrMatrix, options: SvgOptions = {}): string {
  const scale = options.scale ?? 4;
  const margin = options.margin ?? 4;
  const dark = options.dark ?? '#000000';
  const light = options.light ?? '#ffffff';
  const dim = (matrix.size + margin * 2) * scale;

  let path = '';
  for (let row = 0; row < matrix.size; row += 1) {
    for (let col = 0; col < matrix.size; col += 1) {
      if (matrix.modules[row]![col]) {
        const x = (col + margin) * scale;
        const y = (row + margin) * scale;
        path += `M${x} ${y}h${scale}v${scale}h-${scale}z`;
      }
    }
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${dim}" height="${dim}" ` +
    `viewBox="0 0 ${dim} ${dim}" shape-rendering="crispEdges">` +
    `<rect width="${dim}" height="${dim}" fill="${light}"/>` +
    `<path d="${path}" fill="${dark}"/></svg>`
  );
}

/** Convenience: encode text straight to an SVG string. Throws {@link QrError} if it can't fit. */
export function qrSvg(text: string, options?: SvgOptions): string {
  return toSvg(encodeQr(text), options);
}

/**
 * The **guarded** encoder every rendering call site should use: identical to {@link qrSvg},
 * but an un-encodable payload degrades to `null` ("no QR for this one") instead of throwing.
 *
 * A deep-link's length is user-controlled — Settings → "Link host" feeds the base URL — so an
 * over-long host must never take a screen down with it. This mirrors the existing barcode
 * guard in the label sheet, so both symbologies fail the same, survivable way.
 */
export function qrSvgOrNull(text: string, options?: SvgOptions): string | null {
  try {
    return qrSvg(text, options);
  } catch {
    return null;
  }
}

/**
 * True when `text` fits in a QR symbol this encoder can produce. Pure and cheap (a UTF-8
 * byte count), so UI can warn *before* a code is printed rather than silently omitting it.
 */
export function fitsInQr(text: string): boolean {
  return utf8Bytes(text).length <= MAX_QR_BYTES;
}
