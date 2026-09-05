/**
 * Storage Triage Workflow A (§7.6.3) and the guard added in issue #502: the cold-storage archive
 * is not merely *attempted* before the history is deleted, it has to have landed.
 *
 * This is the least forgiving of the three destructive paths. The prune also advances the
 * §7.6.3-A watermark, so peers will not re-supply the rows either — if the archive did not reach
 * the user, the deleted history is simply gone. And it runs *because the device is short of
 * space*, which is exactly the state in which a save is most likely to fail.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const listHistoryBefore = vi.hoisted(() => vi.fn());
const pruneHistoryBefore = vi.hoisted(() => vi.fn());

vi.mock('@/db/repositories', () => ({
  getStorageRepository: () => ({ listHistoryBefore, pruneHistoryBefore }),
}));
vi.mock('@/features/images/opfs-images', () => ({ deleteImageFile: vi.fn() }));

import { archiveAndPruneHistory, historyArchiveFilename } from './triage-actions';
import type { SafeSave } from '@/lib/save-file';

const NOW = Date.parse('2026-07-31T09:00:00.000Z');

/**
 * The rows the read hands back. Shaped as the DTO actually is, attribution included (issue
 * #774): the archive is these objects written verbatim, so what the read omits the file omits,
 * and the prune that follows deletes the originals.
 */
const ROWS = [
  { id: 'h1', createdAt: 1, actorUserId: 'user-ada', actorDisplayName: 'Ada Okafor' },
  { id: 'h2', createdAt: 2, actorUserId: 'user-admin', actorDisplayName: 'Admin' },
];

/** One page of history rows, terminating the collection loop. */
function onePage(rows: unknown[]) {
  return { rows, hasMore: false };
}

/**
 * A destination for the archive. `outcome` is what the platform could establish; `confirm` is
 * the user's answer where it could establish nothing.
 */
function save(
  outcome: 'saved' | 'unverified',
  confirm = true,
): SafeSave & { written: Blob[]; asked: () => boolean } {
  const written: Blob[] = [];
  let asked = false;
  return {
    written,
    asked: () => asked,
    saver: {
      filename: 'inventory_history_archive_test.json',
      save: async (blob: Blob) => {
        written.push(blob);
        return outcome;
      },
    },
    confirmUnverified: async () => {
      asked = true;
      return confirm;
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  listHistoryBefore.mockResolvedValue(onePage(ROWS));
  pruneHistoryBefore.mockResolvedValue(2);
});

describe('archiveAndPruneHistory', () => {
  it('archives the rows, then deletes them once the copy is confirmed', async () => {
    const target = save('saved');

    const result = await archiveAndPruneHistory(6, NOW, target);

    expect(result).toEqual({ cutoff: expect.any(Number), archived: 2, pruned: 2, archiveSaved: true });
    expect(pruneHistoryBefore).toHaveBeenCalledWith(result.cutoff);
    // What was written is the archive of exactly those rows, not an empty envelope — and each
    // row entire. A field the read carried but the file dropped would be gone from the device
    // the moment the prune below ran, with no route back from the archive (issue #774).
    const payload = JSON.parse(await target.written[0]!.text()) as {
      rowCount: number;
      rows: unknown[];
    };
    expect(payload.rowCount).toBe(2);
    expect(payload.rows).toEqual(ROWS);
  });

  it('deletes nothing when the archive was not confirmed as saved', async () => {
    // The failure this closes: `downloadBlob` returns whether or not the browser saved anything,
    // so the prune ran regardless and the toast reported "Archived N entries".
    const result = await archiveAndPruneHistory(6, NOW, save('unverified', false));

    expect(pruneHistoryBefore).not.toHaveBeenCalled();
    expect(result).toEqual({ cutoff: expect.any(Number), archived: 0, pruned: 0, archiveSaved: false });
  });

  it('proceeds on an unverified save the user vouched for', async () => {
    const target = save('unverified', true);

    const result = await archiveAndPruneHistory(6, NOW, target);

    expect(target.asked()).toBe(true);
    expect(result.archiveSaved).toBe(true);
    expect(pruneHistoryBefore).toHaveBeenCalledOnce();
  });

  it('does not trouble the user when the save reported itself', async () => {
    const target = save('saved');

    await archiveAndPruneHistory(6, NOW, target);

    expect(target.asked()).toBe(false);
  });

  it('saves nothing and deletes nothing for an empty window', async () => {
    listHistoryBefore.mockResolvedValue(onePage([]));
    const target = save('saved');

    const result = await archiveAndPruneHistory(6, NOW, target);

    expect(result).toEqual({ cutoff: expect.any(Number), archived: 0, pruned: 0, archiveSaved: true });
    expect(target.written).toHaveLength(0);
    expect(pruneHistoryBefore).not.toHaveBeenCalled();
  });

  it('collects every page before archiving', async () => {
    listHistoryBefore
      .mockResolvedValueOnce({ rows: [{ id: 'a' }], hasMore: true })
      .mockResolvedValueOnce({ rows: [{ id: 'b' }], hasMore: false });
    const target = save('saved');

    const result = await archiveAndPruneHistory(6, NOW, target);

    expect(result.archived).toBe(2);
    const payload = JSON.parse(await target.written[0]!.text()) as { rows: { id: string }[] };
    expect(payload.rows.map((r) => r.id)).toEqual(['a', 'b']);
  });
});

describe('historyArchiveFilename', () => {
  it('stamps the archive with the run instant, so the reserved name matches what is written', () => {
    expect(historyArchiveFilename(NOW)).toBe('inventory_history_archive_2026-07-31_09-00-00.json');
  });
});
