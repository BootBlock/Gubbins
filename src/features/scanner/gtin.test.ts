import { describe, expect, it } from 'vitest';
import {
  barcodeMatchForms,
  canonicaliseBarcode,
  describeGtinConcern,
  hasValidGtinCheckDigit,
  isValidGtin,
  parseGtin,
} from './gtin';

describe('GTIN check digit', () => {
  it('accepts known-valid codes across every width', () => {
    expect(hasValidGtinCheckDigit('96385074')).toBe(true); // EAN-8
    expect(hasValidGtinCheckDigit('036000291452')).toBe(true); // UPC-A (12)
    expect(hasValidGtinCheckDigit('4006381333931')).toBe(true); // EAN-13
    expect(hasValidGtinCheckDigit('00012345678905')).toBe(true); // GTIN-14
  });

  it('rejects a code with a wrong check digit', () => {
    expect(hasValidGtinCheckDigit('4006381333930')).toBe(false);
    expect(hasValidGtinCheckDigit('036000291451')).toBe(false);
  });

  it('rejects non-digit input', () => {
    expect(hasValidGtinCheckDigit('40063813339A1')).toBe(false);
    expect(hasValidGtinCheckDigit('')).toBe(false);
  });
});

describe('isValidGtin', () => {
  it('requires a recognised length', () => {
    // A run of digits with a correct-looking length but wrong count is not a GTIN.
    expect(isValidGtin('12345')).toBe(false); // 5 digits — no such GTIN width
    expect(isValidGtin('4006381333931')).toBe(true); // 13
  });

  it('ignores surrounding whitespace', () => {
    expect(isValidGtin('  4006381333931  ')).toBe(true);
  });

  it('rejects a UUID and other non-numeric strings (never collides with a Gubbins code)', () => {
    expect(isValidGtin('550e8400-e29b-41d4-a716-446655440000')).toBe(false);
    expect(isValidGtin('gubbins:item:550e8400-e29b-41d4-a716-446655440000')).toBe(false);
  });
});

describe('parseGtin', () => {
  it('returns the trimmed digits verbatim (no zero-padding)', () => {
    expect(parseGtin('  036000291452 ')).toBe('036000291452');
    expect(parseGtin('96385074')).toBe('96385074');
  });

  it('returns null for a non-GTIN', () => {
    expect(parseGtin('not-a-code')).toBeNull();
    expect(parseGtin('4006381333930')).toBeNull(); // bad check digit
  });
});

describe('describeGtinConcern — judging a hand-typed entry (issue #344)', () => {
  it('stays quiet for a blank field', () => {
    expect(describeGtinConcern('')).toBeNull();
    expect(describeGtinConcern('   ')).toBeNull();
  });

  it('stays quiet for a valid GTIN of any width, whitespace and all', () => {
    expect(describeGtinConcern('96385074')).toBeNull();
    expect(describeGtinConcern('036000291452')).toBeNull();
    expect(describeGtinConcern('  4006381333931  ')).toBeNull();
    expect(describeGtinConcern('00012345678905')).toBeNull();
  });

  it('flags a transposed digit — the exact silent-corruption case', () => {
    // …930 for …931: saved verbatim today, and then never resolves on a re-scan.
    expect(describeGtinConcern('4006381333930')).toBe('check-digit');
  });

  it('flags digits of no recognised GTIN width', () => {
    expect(describeGtinConcern('12345')).toBe('length');
    expect(describeGtinConcern('4006381333')).toBe('length'); // 10 — between UPC-A and EAN-13
    // A partially-typed EAN-13 passes through 12 digits, which *is* a GTIN width, so it is
    // judged on its check digit rather than its length — hence the blur gate at the call site.
    expect(describeGtinConcern('400638133393')).toBe('check-digit');
  });

  it('never judges a code containing anything but digits', () => {
    // The field legitimately holds internal/Code-128 labels, so these are left alone
    // rather than policed — see the GtinConcern note.
    expect(describeGtinConcern('SHELF-A12')).toBeNull();
    expect(describeGtinConcern('4006 3813 3393 1')).toBeNull();
    expect(describeGtinConcern('X4006381333930')).toBeNull();
  });
});

describe('UPC-E — the compressed 8-digit code (issue #508)', () => {
  it('expands a scanned UPC-E to the UPC-A it compresses', () => {
    // The printed check digit belongs to the expansion, so the eight digits alone fail the
    // length-agnostic mod-10 rule — this is the case that used to dead-end at the scanner.
    expect(hasValidGtinCheckDigit('04252614')).toBe(false);
    expect(parseGtin('04252614')).toBe('042100005264');
    expect(isValidGtin('04252614')).toBe(true);
  });

  it('expands number system 1 as well as 0', () => {
    expect(parseGtin('14252611')).toBe('142100005261');
  });

  it('stores the same value a UPC-A scan of the same article would', () => {
    expect(parseGtin('04252614')).toBe(parseGtin('042100005264'));
  });

  it('leaves a genuine EAN-8 verbatim', () => {
    // No UPC-E number system, so there is nothing to expand.
    expect(parseGtin('96385074')).toBe('96385074');
  });

  it('prefers the UPC-E reading when the code can be read either way', () => {
    // `01234565` passes the EAN-8 check *and* expands to a valid UPC-A. GS1 reserves the
    // GTIN-8 prefix 0 for this compressed form, so the expansion wins.
    expect(hasValidGtinCheckDigit('01234565')).toBe(true);
    expect(parseGtin('01234565')).toBe('012345000065');
  });

  it('still rejects eight digits that are neither an EAN-8 nor a UPC-E', () => {
    expect(parseGtin('07350053')).toBeNull();
  });

  it('stops flagging a correctly typed UPC-E as mistyped', () => {
    expect(describeGtinConcern('04252614')).toBeNull();
    expect(describeGtinConcern('14252611')).toBeNull();
    // A genuinely wrong eight digits is still flagged.
    expect(describeGtinConcern('07350053')).toBe('check-digit');
  });
});

describe('canonicaliseBarcode — what is rewritten on the way into storage (issue #508)', () => {
  it('replaces a UPC-E with the UPC-A it compresses', () => {
    expect(canonicaliseBarcode('04252614')).toBe('042100005264');
    expect(canonicaliseBarcode('  04252614  ')).toBe('042100005264');
  });

  it('rewrites an EAN-8 that is also a valid UPC-E, following the same precedence', () => {
    // The docstring's 'left exactly as typed' has this one exception, and it is deliberate: the
    // camera resolves this code the same way, so storing the eight digits would not match a scan.
    expect(canonicaliseBarcode('01234565')).toBe('012345000065');
  });

  it('leaves every other entry byte-for-byte as given', () => {
    expect(canonicaliseBarcode('96385074')).toBe('96385074');
    expect(canonicaliseBarcode('4006381333931')).toBe('4006381333931');
    expect(canonicaliseBarcode('SHELF-A12')).toBe('SHELF-A12');
    expect(canonicaliseBarcode('07350053')).toBe('07350053');
    // Untrimmed input is returned untouched rather than quietly trimmed.
    expect(canonicaliseBarcode('  RS-482-9021 ')).toBe('  RS-482-9021 ');
    expect(canonicaliseBarcode('')).toBe('');
  });
});

describe('the UPC-E round-trip guard (issue #508)', () => {
  it('refuses an expansion that compresses back to a different code', () => {
    // `00000030` and `00000040` both expand to `000000000000`, so treating either as a UPC-E
    // would store two distinct printed codes as one value and lose whichever was written second.
    // Neither is a code any encoder produces, so both are left alone instead.
    expect(parseGtin('00000030')).toBeNull();
    expect(parseGtin('00000040')).toBeNull();
    expect(canonicaliseBarcode('00000030')).toBe('00000030');
    expect(canonicaliseBarcode('00000040')).toBe('00000040');
  });
});

describe('barcodeMatchForms — every stored form of one barcode (issue #508)', () => {
  it('adds the compressed UPC-E for a UPC-A that compresses', () => {
    expect(barcodeMatchForms('042100005264')).toEqual(['042100005264', '04252614']);
    expect(barcodeMatchForms('  042100005264 ')).toEqual(['042100005264', '04252614']);
  });

  it('adds the expansion when given the printed eight digits', () => {
    // The other direction: a caller holding the compressed form must still find an item recorded
    // since the expansion landed.
    expect(barcodeMatchForms('04252614')).toEqual(['04252614', '042100005264']);
  });

  it('is the value alone for everything else', () => {
    expect(barcodeMatchForms('4006381333931')).toEqual(['4006381333931']);
    expect(barcodeMatchForms('036000291452')).toEqual(['036000291452']); // no zero run to squeeze
    expect(barcodeMatchForms('96385074')).toEqual(['96385074']);
    expect(barcodeMatchForms('RS-482-9021')).toEqual(['RS-482-9021']);
    // A 12-digit code that is not a valid GTIN is never asked for under a UPC-E it never was.
    expect(barcodeMatchForms('012345000067')).toEqual(['012345000067']);
  });
});
