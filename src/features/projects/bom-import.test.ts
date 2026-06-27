import { describe, it, expect } from 'vitest';
import { parseCsv, parseBom, BomImportError } from './bom-import';

describe('parseCsv (RFC-4180-ish, native)', () => {
  it('parses simple rows', () => {
    expect(parseCsv('a,b,c\n1,2,3')).toEqual([
      ['a', 'b', 'c'],
      ['1', '2', '3'],
    ]);
  });

  it('honours quoted fields containing commas', () => {
    expect(parseCsv('"R1, R2",10k,3')).toEqual([['R1, R2', '10k', '3']]);
  });

  it('unescapes doubled quotes inside quoted fields', () => {
    expect(parseCsv('"a ""b"" c",d')).toEqual([['a "b" c', 'd']]);
  });

  it('handles CRLF line endings and ignores a trailing blank line', () => {
    expect(parseCsv('a,b\r\n1,2\r\n')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('preserves embedded newlines within quoted fields', () => {
    expect(parseCsv('"line1\nline2",x')).toEqual([['line1\nline2', 'x']]);
  });
});

describe('parseBom — KiCad / generic column mapping', () => {
  it('maps a typical KiCad BOM export', () => {
    const csv = [
      'Reference,Value,Footprint,Quantity,MPN,Manufacturer',
      '"R1, R2",10k,R_0805,2,RC0805FR-0710KL,Yageo',
      'U1,NE555,SOIC-8,1,NE555P,Texas Instruments',
    ].join('\n');

    const lines = parseBom(csv);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({
      designator: 'R1, R2',
      mpn: 'RC0805FR-0710KL',
      manufacturer: 'Yageo',
      requiredQty: 2,
    });
    expect(lines[1].mpn).toBe('NE555P');
    expect(lines[1].requiredQty).toBe(1);
  });

  it('recognises generic synonyms (Qty, Mfr Part Number, Mfr)', () => {
    const csv = ['Qty,Mfr Part Number,Mfr,Description', '5,GRM188R71H104KA93D,Murata,0.1uF cap'].join(
      '\n',
    );
    const lines = parseBom(csv);
    expect(lines[0]).toMatchObject({
      requiredQty: 5,
      mpn: 'GRM188R71H104KA93D',
      manufacturer: 'Murata',
      description: '0.1uF cap',
    });
  });

  it('falls back to the Value column for the description when no Description exists', () => {
    const csv = ['Reference,Value,Quantity', 'C1,100nF,1'].join('\n');
    expect(parseBom(csv)[0].description).toBe('100nF');
  });

  it('defaults quantity to 1 when missing or unparseable', () => {
    const csv = ['Reference,MPN,Quantity', 'R1,ABC,', 'R2,DEF,notanumber'].join('\n');
    const lines = parseBom(csv);
    expect(lines[0].requiredQty).toBe(1);
    expect(lines[1].requiredQty).toBe(1);
  });

  it('skips fully blank rows', () => {
    const csv = ['Reference,MPN,Quantity', 'R1,ABC,1', '', '  ,  ,  ', 'R2,DEF,2'].join('\n');
    expect(parseBom(csv)).toHaveLength(2);
  });

  it('is case- and whitespace-insensitive about headers', () => {
    const csv = ['  QUANTITY , mpn ', '3, XYZ'].join('\n');
    const lines = parseBom(csv);
    expect(lines[0]).toMatchObject({ requiredQty: 3, mpn: 'XYZ' });
  });

  it('throws a BomImportError on empty input', () => {
    expect(() => parseBom('   ')).toThrow(BomImportError);
  });

  it('throws a BomImportError when no recognisable columns are present', () => {
    const csv = ['Colour,Shape', 'red,round'].join('\n');
    expect(() => parseBom(csv)).toThrow(BomImportError);
  });
});
