/**
 * Pure receipt / product-label parsing seam (feature-gap **G2**, on-device OCR prefill).
 *
 * On-device OCR (Tesseract.js WASM) turns a photographed receipt or product label into a
 * blob of noisy text; this seam turns that text into **structured candidate fields** —
 * price, acquired date, model/MPN and serial number — so an add/edit-item draft can be
 * pre-filled for the user to *review* (it never writes anything itself). All the messy
 * heuristics (currency parsing, ambiguous date order, label matching, OCR noise) live here,
 * with no DOM, no worker and no Tesseract import, so they are exhaustively unit-testable out
 * of glue — mirroring `reorder-policy.ts` / `reminders.ts` / `asset-lifecycle.ts`.
 *
 * The engine (worker + WASM) and the reviewable draft UI are the glue elsewhere
 * ({@link ./ocr-engine} and the OCR prefill dialog); this file is deliberately dependency-free.
 */

// ---------------------------------------------------------------------------
// Result shape
// ---------------------------------------------------------------------------

/** A monetary amount lifted from the text, with its detected currency where known. */
export interface OcrPrice {
  /** Amount in major currency units (e.g. `12.99`). Always finite and non-negative. */
  readonly amount: number;
  /** ISO 4217 code when a currency symbol/code was detected (e.g. `'GBP'`), else undefined. */
  readonly currency?: string;
}

/** A single extracted field: its value plus the raw text fragment it came from (for review). */
export interface ReceiptField<T> {
  readonly value: T;
  /** The trimmed source line the value was lifted from — shown beside it in the review UI. */
  readonly source: string;
}

/**
 * The structured candidates parsed from an OCR pass. Every field is optional — a quiet
 * receipt (or pure noise) yields an empty object, which the UI treats as "nothing found".
 */
export interface ReceiptCandidates {
  /** Best total / price found (currency-aware). */
  readonly price?: ReceiptField<OcrPrice>;
  /** Acquired / purchase date, normalised to `YYYY-MM-DD`. */
  readonly acquiredAt?: ReceiptField<string>;
  /** Model / manufacturer part number. */
  readonly mpn?: ReceiptField<string>;
  /** Serial number. */
  readonly serial?: ReceiptField<string>;
}

/** Options for {@link parseReceiptText}. Kept explicit so parsing stays deterministic/pure. */
export interface ParseReceiptOptions {
  /**
   * Reference year used to (a) expand 2-digit years (`24` → `2024`) and (b) reject dates
   * implausibly far in the future. When omitted, any year in {@link MIN_PLAUSIBLE_YEAR}…
   * {@link MAX_PLAUSIBLE_YEAR} is accepted and 2-digit years map to the 2000s.
   */
  readonly referenceYear?: number;
}

/** True when at least one field was extracted — the UI's "did OCR find anything?" gate. */
export function hasAnyCandidate(candidates: ReceiptCandidates): boolean {
  return Boolean(candidates.price || candidates.acquiredAt || candidates.mpn || candidates.serial);
}

// ---------------------------------------------------------------------------
// Currency
// ---------------------------------------------------------------------------

/** Currency symbol → ISO 4217. `$` is treated as USD (the un-prefixed dollar default). */
const SYMBOL_TO_ISO: Readonly<Record<string, string>> = {
  '£': 'GBP',
  $: 'USD',
  '€': 'EUR',
  '¥': 'JPY',
  '₹': 'INR',
};

const CURRENCY_SYMBOLS = Object.keys(SYMBOL_TO_ISO).join('');
/** ISO codes we recognise when written out (e.g. `USD 12.99`, `12.99 EUR`). */
const CURRENCY_CODES = ['GBP', 'USD', 'EUR', 'JPY', 'INR', 'CAD', 'AUD', 'CHF', 'CNY', 'NZD'] as const;
const CODE_RE = new RegExp(`\\b(${CURRENCY_CODES.join('|')})\\b`);

/**
 * Detect the dominant currency of the text: the first symbol seen wins (they are
 * unambiguous), else the first written ISO code. Returns undefined when none is present, so
 * the price is offered without forcing a currency the user didn't intend.
 *
 * @internal Exported for unit tests only.
 */
export function detectCurrency(text: string): string | undefined {
  const symbol = text.match(new RegExp(`[${CURRENCY_SYMBOLS}]`));
  if (symbol) return SYMBOL_TO_ISO[symbol[0]];
  const code = text.toUpperCase().match(CODE_RE);
  return code ? code[1] : undefined;
}

// ---------------------------------------------------------------------------
// Amounts
// ---------------------------------------------------------------------------

/**
 * Parse a money-ish token (`"1,234.56"`, `"1.234,56"`, `"12,99"`, `"£12.99"`) into a
 * number, or null when it isn't a plausible amount.
 *
 * Handles both decimal conventions: when both `.` and `,` appear, the **right-most** is the
 * decimal separator and the other is grouping; when only one separator appears, a trailing
 * run of exactly three digits is read as grouping (`1,234` → 1234), while one or two trailing
 * digits are a decimal fraction (`12,99` → 12.99). This is the standard receipt heuristic and
 * keeps mixed UK/EU scans correct.
 */
export function parseMoneyNumber(token: string): number | null {
  const cleaned = token.replace(new RegExp(`[${CURRENCY_SYMBOLS}\\s]`, 'g'), '');
  if (!/\d/.test(cleaned)) return null;
  // Reject tokens with stray non-numeric characters (letters, multiple signs, etc.).
  if (!/^-?[\d.,]+$/.test(cleaned)) return null;

  const negative = cleaned.startsWith('-');
  const digitsAndSeps = cleaned.replace(/^-/, '');
  const lastComma = digitsAndSeps.lastIndexOf(',');
  const lastDot = digitsAndSeps.lastIndexOf('.');

  let normalised: string;
  if (lastComma >= 0 && lastDot >= 0) {
    // Two different separators: the right-most is the decimal point, the other is grouping.
    const decimalSep = lastComma > lastDot ? ',' : '.';
    const groupSep = decimalSep === ',' ? '.' : ',';
    normalised = digitsAndSeps.split(groupSep).join('').replace(decimalSep, '.');
  } else if (lastComma >= 0 || lastDot >= 0) {
    const sep = lastComma >= 0 ? ',' : '.';
    const frac = digitsAndSeps.length - digitsAndSeps.lastIndexOf(sep) - 1;
    const parts = digitsAndSeps.split(sep);
    if (frac === 1 || frac === 2) {
      // A one/two-digit tail is the decimal fraction; everything before it is grouping —
      // so the last part is the fraction and the rest concatenate into the integer.
      const fraction = parts.pop() ?? '';
      normalised = `${parts.join('')}.${fraction}`;
    } else {
      // Otherwise the separator is grouping (or noise) — drop every occurrence.
      normalised = parts.join('');
    }
  } else {
    normalised = digitsAndSeps;
  }

  const value = Number(normalised);
  if (!Number.isFinite(value)) return null;
  return negative ? -value : value;
}

/** A money amount found on a line. `priced` marks a genuine price (symbol or 2-decimal tail). */
interface LineAmount {
  readonly amount: number;
  readonly token: string;
  /** True when the token carried a currency symbol or a two-digit decimal fraction. */
  readonly priced: boolean;
}

// A number token that could be an amount: an optional currency symbol then a run of digits
// with grouping/decimal separators. Kept greedy on separators; validated by parseMoneyNumber.
const AMOUNT_TOKEN_RE = new RegExp(
  `[${CURRENCY_SYMBOLS}]?\\s?\\d[\\d.,]*\\d|[${CURRENCY_SYMBOLS}]?\\s?\\d`,
  'g',
);

// A whole token that is really a `D.M.Y` / `D/M/Y` date, so it is never read as an amount.
const DATE_SHAPED_TOKEN_RE = /^\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}$/;

/** Every plausible money amount on a line, in order of appearance (date tokens excluded). */
function amountsOnLine(line: string): LineAmount[] {
  const out: LineAmount[] = [];
  for (const match of line.matchAll(AMOUNT_TOKEN_RE)) {
    const token = match[0].trim();
    if (DATE_SHAPED_TOKEN_RE.test(token)) continue;
    const amount = parseMoneyNumber(token);
    if (amount === null || amount < 0) continue;
    const bare = token.replace(new RegExp(`[${CURRENCY_SYMBOLS}\\s]`, 'g'), '');
    const priced = token !== bare || /[.,]\d{2}$/.test(bare);
    out.push({ amount, token, priced });
  }
  return out;
}

/** Total-keyword tiers, most specific/authoritative first (higher tier wins). */
const TOTAL_KEYWORDS: readonly (readonly [tier: number, re: RegExp])[] = [
  [3, /\b(?:grand\s*total|total\s*to\s*pay|amount\s*(?:due|payable)|balance\s*due|total\s*due)\b/i],
  [2, /\b(?:total|amount)\b/i],
];

/** Lines that *contain* "total" but are never the price we want. */
const TOTAL_EXCLUSIONS =
  /\b(?:sub\s*-?\s*total|total\s*(?:savings|saved|discount|items?|qty|quantity|units?|weight|vat|tax)|(?:vat|tax)\s*total)\b/i;

/**
 * Pick the most likely purchase price from the receipt lines.
 *
 * Prefers an amount on a **total** line (grand total / amount due beat a bare "total", and
 * sub-total / tax-total / savings lines are excluded), taking the last amount on that line
 * (totals sit at the line's end). With no usable total keyword it falls back to the largest
 * genuinely-priced amount (currency-symboled or two-decimal) — a receipt's total is almost
 * always its biggest money figure.
 *
 * @internal Exported for unit tests only.
 */
export function extractPrice(
  lines: readonly string[],
  currency: string | undefined,
): ReceiptField<OcrPrice> | undefined {
  let best: { tier: number; amount: number; source: string } | undefined;

  for (const line of lines) {
    if (TOTAL_EXCLUSIONS.test(line)) continue;
    const amounts = amountsOnLine(line);
    if (amounts.length === 0) continue;

    let tier = 0;
    for (const [t, re] of TOTAL_KEYWORDS) {
      if (re.test(line)) {
        tier = t;
        break;
      }
    }
    if (tier === 0) continue;

    // Totals are conventionally the last money figure on their line. Prefer the last
    // genuinely-priced figure so a trailing bare number — e.g. a slash-date's year, which the
    // tokeniser splits into digit runs — can't outrank the actual total; fall back to the last
    // amount for a bare total like "Total 5".
    const priced = amounts.filter((a) => a.priced);
    const pool = priced.length > 0 ? priced : amounts;
    const last = pool[pool.length - 1];
    if (!last) continue;
    const amount = last.amount;
    if (!best || tier > best.tier || (tier === best.tier && amount > best.amount)) {
      best = { tier, amount, source: line.trim() };
    }
  }

  if (!best) {
    // No total keyword: take the largest genuinely-priced amount across the receipt (a real
    // price carries a currency symbol or a two-decimal tail — bare counts/dates are ignored).
    let fallback: { amount: number; source: string } | undefined;
    for (const line of lines) {
      if (TOTAL_EXCLUSIONS.test(line)) continue;
      for (const { amount, priced } of amountsOnLine(line)) {
        if (priced && (!fallback || amount > fallback.amount)) fallback = { amount, source: line.trim() };
      }
    }
    if (!fallback) return undefined;
    best = { tier: 0, ...fallback };
  }

  const price: OcrPrice = currency ? { amount: best.amount, currency } : { amount: best.amount };
  return { value: price, source: best.source };
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

export const MIN_PLAUSIBLE_YEAR = 1990;
export const MAX_PLAUSIBLE_YEAR = 2099;

const MONTHS: Readonly<Record<string, number>> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function isLeap(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/** Compose a validated `YYYY-MM-DD`, or null when the day/month/year is out of range. */
function toIso(year: number, month: number, day: number, referenceYear?: number): string | null {
  if (month < 1 || month > 12) return null;
  const maxDay = month === 2 && isLeap(year) ? 29 : (DAYS_IN_MONTH[month - 1] ?? 31);
  if (day < 1 || day > maxDay) return null;
  if (year < MIN_PLAUSIBLE_YEAR || year > MAX_PLAUSIBLE_YEAR) return null;
  if (referenceYear !== undefined && year > referenceYear + 1) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Expand a 1–4 digit year to a full year (2-digit years map to the 2000s). */
function expandYear(raw: string): number {
  const n = Number(raw);
  return raw.length <= 2 ? 2000 + n : n;
}

/**
 * Resolve an ambiguous `A[sep]B[sep]Y` numeric date. Defaults to **day-first** (the app's
 * en-GB locale), swapping to month-first only when the numbers force it (first > 12, or
 * second ≤ 12 is impossible so first must be the month).
 */
function parseNumericDate(a: string, b: string, y: string, referenceYear?: number): string | null {
  const first = Number(a);
  const second = Number(b);
  const year = expandYear(y);
  let day: number;
  let month: number;
  if (first > 12 && second <= 12) {
    day = first;
    month = second;
  } else if (second > 12 && first <= 12) {
    month = first;
    day = second;
  } else {
    // Both ≤ 12 (or both invalid): honour day-first.
    day = first;
    month = second;
  }
  return toIso(year, month, day, referenceYear);
}

// D/M/Y, D-M-Y, D.M.Y (2- or 4-digit year).
const NUMERIC_DATE_RE = /\b(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})\b/g;
// ISO: Y-M-D.
const ISO_DATE_RE = /\b(\d{4})-(\d{1,2})-(\d{1,2})\b/g;
// 15 Mar 2024 / 15th March, 2024.
const DAY_MONTH_YEAR_RE = /\b(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\.?,?\s+(\d{2,4})\b/g;
// Mar 15 2024 / March 15th, 2024.
const MONTH_DAY_YEAR_RE = /\b([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{2,4})\b/g;

/** Lines whose date is the one we want (purchase/order/invoice), preferred over stray dates. */
const DATE_LABEL_RE = /\b(?:date|purchased?|order(?:ed)?|invoice|sold|bought|receipt|transaction)\b/i;

interface FoundDate {
  readonly iso: string;
  readonly source: string;
  readonly labelled: boolean;
}

function monthFromName(name: string): number | null {
  const m = MONTHS[name.slice(0, 3).toLowerCase()];
  return m ?? null;
}

/** All plausible full calendar dates in a line, each normalised to ISO. */
function datesOnLine(line: string, referenceYear?: number): string[] {
  const found: string[] = [];
  for (const [, y, mo, d] of line.matchAll(ISO_DATE_RE)) {
    if (!y || !mo || !d) continue;
    const iso = toIso(Number(y), Number(mo), Number(d), referenceYear);
    if (iso) found.push(iso);
  }
  for (const [, a, b, y] of line.matchAll(NUMERIC_DATE_RE)) {
    if (!a || !b || !y) continue;
    const iso = parseNumericDate(a, b, y, referenceYear);
    if (iso) found.push(iso);
  }
  for (const [, d, name, y] of line.matchAll(DAY_MONTH_YEAR_RE)) {
    if (!d || !name || !y) continue;
    const month = monthFromName(name);
    if (month) {
      const iso = toIso(expandYear(y), month, Number(d), referenceYear);
      if (iso) found.push(iso);
    }
  }
  for (const [, name, d, y] of line.matchAll(MONTH_DAY_YEAR_RE)) {
    if (!name || !d || !y) continue;
    const month = monthFromName(name);
    if (month) {
      const iso = toIso(expandYear(y), month, Number(d), referenceYear);
      if (iso) found.push(iso);
    }
  }
  return found;
}

/**
 * Extract the most likely acquisition date. A date on a line labelled *date / purchased /
 * order / invoice* wins; otherwise the first plausible full date in the text is used (a
 * receipt's date is near the top). Two-component fragments like a card's `MM/YY` never match —
 * a full day+month+year is required — so an expiry date can't be mistaken for a purchase date.
 *
 * @internal Exported for unit tests only.
 */
export function extractDate(
  lines: readonly string[],
  referenceYear?: number,
): ReceiptField<string> | undefined {
  let firstUnlabelled: FoundDate | undefined;
  for (const line of lines) {
    const first = datesOnLine(line, referenceYear)[0];
    if (!first) continue;
    const labelled = DATE_LABEL_RE.test(line);
    if (labelled) return { value: first, source: line.trim() };
    if (!firstUnlabelled) firstUnlabelled = { iso: first, source: line.trim(), labelled: false };
  }
  return firstUnlabelled ? { value: firstUnlabelled.iso, source: firstUnlabelled.source } : undefined;
}

// ---------------------------------------------------------------------------
// Labelled part / serial numbers
// ---------------------------------------------------------------------------

/** A labelled-value spec: the label matcher and the acceptable value shape. */
interface LabelledField {
  readonly label: RegExp;
}

// Value tokens for MPN / serial: start alphanumeric, then alphanumerics plus - / . _ ; length
// 3–24. Validated further (must contain a digit) so a stray word isn't mistaken for a code.
const CODE_VALUE = String.raw`([A-Za-z0-9][A-Za-z0-9/._-]{2,23})`;

const MPN_LABEL = new RegExp(
  String.raw`\b(?:mpn|model(?:\s*(?:no|number|#|:))?|part\s*(?:no|number|#)|p\/n|cat(?:alogue|alog)?\.?\s*(?:no|#)?)\b\s*[:#.-]?\s*` +
    CODE_VALUE,
  'i',
);
const SERIAL_LABEL = new RegExp(
  String.raw`\b(?:serial(?:\s*(?:no|number))?|s\/n|s\.?n\.?)\b\s*[:#.-]?\s*` + CODE_VALUE,
  'i',
);

/** A labelled code must carry at least one digit and not read as a bare price/date. */
function isPlausibleCode(value: string): boolean {
  if (!/\d/.test(value)) return false;
  // A pure number that's really an amount/date shouldn't be offered as a part/serial number.
  if (/^\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}$/.test(value)) return false;
  return true;
}

/** Extract the first labelled code (MPN or serial) matching `spec`, validated. */
function extractLabelledCode(
  lines: readonly string[],
  spec: LabelledField,
): ReceiptField<string> | undefined {
  for (const line of lines) {
    const m = line.match(spec.label);
    if (!m?.[1]) continue;
    const value = m[1].replace(/[./_-]+$/, ''); // trim trailing punctuation the regex may grab
    if (isPlausibleCode(value)) return { value, source: line.trim() };
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Top-level parse
// ---------------------------------------------------------------------------

/** Split raw OCR text into trimmed, non-empty lines. */
function toLines(raw: string): string[] {
  return raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

/**
 * Parse raw OCR text from a receipt or product label into reviewable candidate fields.
 *
 * Deliberately fail-soft: unrecognised or noisy text simply yields fewer (or no) candidates,
 * never a throw. The caller shows whatever was found for the user to confirm; nothing here
 * writes to the item.
 */
export function parseReceiptText(raw: string, options: ParseReceiptOptions = {}): ReceiptCandidates {
  const lines = toLines(raw);
  if (lines.length === 0) return {};
  const { referenceYear } = options;

  const currency = detectCurrency(raw);
  const price = extractPrice(lines, currency);
  const acquiredAt = extractDate(lines, referenceYear);
  const mpn = extractLabelledCode(lines, { label: MPN_LABEL });
  const serial = extractLabelledCode(lines, { label: SERIAL_LABEL });

  return {
    ...(price ? { price } : {}),
    ...(acquiredAt ? { acquiredAt } : {}),
    ...(mpn ? { mpn } : {}),
    ...(serial ? { serial } : {}),
  };
}
