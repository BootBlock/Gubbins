import { describe, it, expect } from 'vitest';

import {
  Code128Error,
  code128Modules,
  code128Svg,
  encodeCode128,
} from './code128';

/** Recompute the mod-103 checksum independently, to cross-check the encoder. */
function expectedChecksum(symbols: number[]): number {
  // symbols here are start + data only (no checksum, no stop).
  let sum = symbols[0]!;
  for (let i = 1; i < symbols.length; i += 1) sum += symbols[i]! * i;
  return sum % 103;
}

describe('encodeCode128 — structural invariants', () => {
  for (const input of ['ABC', 'CODE128', 'Gubbins-42', '1234', 'a1b2c3', '999999']) {
    it(`is well-formed for ${JSON.stringify(input)}`, () => {
      const symbols = encodeCode128(input);
      // Starts with a valid start code.
      expect([103, 104, 105]).toContain(symbols[0]);
      // Ends with the stop symbol.
      expect(symbols.at(-1)).toBe(106);
      // The second-to-last symbol is the mod-103 checksum of start + data.
      const dataPart = symbols.slice(0, -2);
      expect(symbols.at(-2)).toBe(expectedChecksum(dataPart));
    });
  }
});

describe('encodeCode128 — Code B reference vector', () => {
  it('encodes "CODE128" exactly', () => {
    // Start B = 104; C,O,D,E,1,2,8 → 35,47,36,37,17,18,24.
    // checksum = (104 + 35*1 + 47*2 + 36*3 + 37*4 + 17*5 + 18*6 + 24*7) mod 103
    //          = (104 + 35 + 94 + 108 + 148 + 85 + 108 + 168) mod 103
    //          = 850 mod 103 = 26.
    const symbols = encodeCode128('CODE128');
    expect(symbols).toEqual([104, 35, 47, 36, 37, 17, 18, 24, 26, 106]);
  });
});

describe('encodeCode128 — Code C numeric', () => {
  it('encodes "1234" as Start C, digit pairs, checksum, stop', () => {
    // Start C = 105; "12" → 12, "34" → 34.
    // checksum = (105 + 12*1 + 34*2) mod 103 = (105 + 12 + 68) mod 103 = 185 mod 103 = 82.
    const symbols = encodeCode128('1234');
    expect(symbols).toEqual([105, 12, 34, 82, 106]);
  });
});

describe('code128Modules', () => {
  it('begins with the start code pattern and ends with the 13-module stop', () => {
    const symbols = encodeCode128('1234');
    const modules = code128Modules('1234');

    // Start C = 105 → pattern '11010011100'.
    const startBits = '11010011100'.split('').map((b) => b === '1');
    expect(modules.slice(0, 11)).toEqual(startBits);

    // Stop (106) → 13-module pattern '1100011101011'.
    const stopBits = '1100011101011'.split('').map((b) => b === '1');
    expect(modules.slice(-13)).toEqual(stopBits);

    // 11 modules per symbol + 2 extra for the stop's termination bar.
    expect(modules.length).toBe(11 * symbols.length + 2);
  });

  it('keeps 11 modules per symbol across a Code B input', () => {
    const symbols = encodeCode128('ABC');
    const modules = code128Modules('ABC');
    expect(modules.length).toBe(11 * symbols.length + 2);
  });
});

describe('code128Svg', () => {
  it('renders a self-contained SVG with bars, quiet zone and human-readable text', () => {
    const svg = code128Svg('ABC');
    expect(svg).toContain('<svg');
    expect(svg).toContain('shape-rendering="crispEdges"');
    expect(svg).toContain('<rect');
    expect(svg).toContain('<text');
    expect(svg).toContain('ABC');

    // Width reflects modules + quiet zone (10 modules each side, scale 2 default).
    const modules = code128Modules('ABC');
    const expectedWidth = (modules.length + 10 * 2) * 2;
    expect(svg).toContain(`viewBox="0 0 ${expectedWidth} `);
    expect(svg).toContain(`width="${expectedWidth}"`);
  });

  it('omits the text element when showText is false', () => {
    const svg = code128Svg('ABC', { showText: false });
    expect(svg).not.toContain('<text');
    expect(svg).toContain('<rect');
  });

  it('escapes XML metacharacters in the human-readable text', () => {
    const svg = code128Svg('A&B<C>');
    expect(svg).toContain('A&amp;B&lt;C&gt;');
  });
});

describe('encodeCode128 — error handling', () => {
  it('throws on an empty string', () => {
    expect(() => encodeCode128('')).toThrow(Code128Error);
  });

  it('throws on a character above ASCII 126', () => {
    expect(() => encodeCode128('café')).toThrow(Code128Error);
  });

  it('throws on a control character below ASCII 32', () => {
    expect(() => encodeCode128('A\tB')).toThrow(Code128Error);
  });
});
