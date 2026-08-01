import { describe, expect, it } from 'vitest';
import { customFieldValue } from './card-fields';
import { isForeignFilePointer, isForeignOrigin } from './device-origin';

/**
 * W1g — the rule deciding whether something recorded on a device belongs to *this* one, shared
 * by the datasheet list (`resolveAttachmentLink`) and the custom-field `FILE` surfaces.
 */

const THIS_DEVICE = 'device-this';
const OTHER_DEVICE = 'device-other';

describe('isForeignOrigin', () => {
  it('is true only for an origin naming another device', () => {
    expect(isForeignOrigin(OTHER_DEVICE, THIS_DEVICE)).toBe(true);
    expect(isForeignOrigin(THIS_DEVICE, THIS_DEVICE)).toBe(false);
  });

  /**
   * Two populations store NULL: every row written before the column existed, and every writer
   * that deliberately makes no claim (a clone, a spreadsheet import). Both must read as local,
   * or the app warns about values nothing is wrong with — the same call
   * `resolveAttachmentLink` has made for a pre-v18 pointer since it shipped.
   */
  it('never treats an unattributed origin as foreign', () => {
    expect(isForeignOrigin(null, THIS_DEVICE)).toBe(false);
  });
});

describe('isForeignFilePointer', () => {
  const PATH = '\\\\server\\share\\boiler.pdf';

  it('is true for a FILE path recorded on another device', () => {
    expect(isForeignFilePointer('FILE', PATH, OTHER_DEVICE, THIS_DEVICE)).toBe(true);
  });

  it.each([
    ['a path recorded here', 'FILE' as const, PATH, THIS_DEVICE],
    ['an unattributed path', 'FILE' as const, PATH, null],
    // A web address opens on any device, so its origin says nothing worth saying — the carve-out
    // `resolveAttachmentLink` makes by answering `url` before it looks at the origin at all.
    ['a FILE value holding a web address', 'FILE' as const, 'https://example.com/b.pdf', OTHER_DEVICE],
    // Only a *path* is device-specific; no other type stores one.
    ['a TEXT value', 'TEXT' as const, 'Acme', OTHER_DEVICE],
    ['a URL value', 'URL' as const, 'https://example.com/b.pdf', OTHER_DEVICE],
    ['an absent value', 'FILE' as const, null, OTHER_DEVICE],
    ['a blank value', 'FILE' as const, '   ', OTHER_DEVICE],
  ])('is false for %s', (_label, fieldType, value, origin) => {
    expect(isForeignFilePointer(fieldType, value, origin, THIS_DEVICE)).toBe(false);
  });

  it('judges a value on its trimmed form, as the renderer does', () => {
    expect(isForeignFilePointer('FILE', `  ${PATH}  `, OTHER_DEVICE, THIS_DEVICE)).toBe(true);
    expect(isForeignFilePointer('FILE', '  https://example.com/b.pdf  ', OTHER_DEVICE, THIS_DEVICE)).toBe(
      false,
    );
  });

  /**
   * The editors ask {@link isForeignFilePointer} about a raw value; the read surfaces reach the
   * same conclusion inside `customFieldValue`, which has already split address from path and so
   * tests only the origin clause. Two spellings of one rule is exactly how they come to
   * disagree, so this pins them together over the cases where they could.
   */
  it('agrees with the pointer arm customFieldValue builds', () => {
    const cases: readonly [string, string | null][] = [
      [PATH, OTHER_DEVICE],
      [PATH, THIS_DEVICE],
      [PATH, null],
      ['https://example.com/b.pdf', OTHER_DEVICE],
      ['file:///srv/manuals/b.pdf', OTHER_DEVICE],
      ['C:\\Manuals\\boiler.pdf', OTHER_DEVICE],
      ['   ', OTHER_DEVICE],
    ];
    for (const [value, originDeviceId] of cases) {
      const rendered = customFieldValue('FILE', value, null, null, {
        originDeviceId,
        currentDeviceId: THIS_DEVICE,
      });
      const markedByRenderer = rendered.kind === 'pointer' && rendered.foreign;
      expect(markedByRenderer).toBe(isForeignFilePointer('FILE', value, originDeviceId, THIS_DEVICE));
    }
  });
});
