/**
 * The critical-tier promise ("new high-resolution image uploads are disabled") is only worth
 * anything if it is enforced, so these characterise the enforcement rather than the wording:
 * at `critical`/`locked` no OPFS write happens at all, and the row is stamped downgraded so
 * the reserved path is never mistaken for a file that exists.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isFullResWriteAllowed, placeFullResImage } from './full-res-policy';

const saveImageFile = vi.hoisted(() => vi.fn(async () => 'images/written.webp'));
const reserveImagePath = vi.hoisted(() => vi.fn(() => 'images/reserved.webp'));

vi.mock('./opfs-images', () => ({ saveImageFile, reserveImagePath }));

const BLOB = new Blob(['not-really-webp']);
const NOW = 1_700_000_000_000;

beforeEach(() => {
  saveImageFile.mockClear();
  reserveImagePath.mockClear();
});

describe('isFullResWriteAllowed', () => {
  it('permits the full-resolution write only below the critical tier', () => {
    expect(isFullResWriteAllowed('ok')).toBe(true);
    expect(isFullResWriteAllowed('warning')).toBe(true);
    expect(isFullResWriteAllowed('critical')).toBe(false);
    expect(isFullResWriteAllowed('locked')).toBe(false);
  });
});

describe('placeFullResImage', () => {
  it.each(['ok', 'warning'] as const)(
    'writes the file and leaves the row un-downgraded at %s',
    async (tier) => {
      const placement = await placeFullResImage(BLOB, tier, NOW);

      expect(saveImageFile).toHaveBeenCalledWith(BLOB);
      expect(reserveImagePath).not.toHaveBeenCalled();
      expect(placement).toEqual({ fullResOpfsPath: 'images/written.webp', fullResDowngradedAt: null });
    },
  );

  it.each(['critical', 'locked'] as const)('writes nothing to OPFS at %s', async (tier) => {
    const placement = await placeFullResImage(BLOB, tier, NOW);

    // The whole point of the issue: the banner said the brakes were on while they were off.
    expect(saveImageFile).not.toHaveBeenCalled();
    expect(placement).toEqual({ fullResOpfsPath: 'images/reserved.webp', fullResDowngradedAt: NOW });
  });

  it('always yields a non-empty path, since the column is NOT NULL', async () => {
    for (const tier of ['ok', 'warning', 'critical', 'locked'] as const) {
      const { fullResOpfsPath } = await placeFullResImage(BLOB, tier, NOW);
      expect(fullResOpfsPath.trim()).not.toBe('');
    }
  });
});
