import { describe, it, expect } from 'vitest';
import { buildCloneStatements } from './snapshot';
import { ITEM_HISTORY_TABLE } from '@/db/repositories';
import type { SchemaDictionary, SyncSnapshot } from './types';

const DICTIONARY: SchemaDictionary = {
  item_history: ['id', 'item_id', 'action', 'created_at'],
};

function snapshot(itemHistory: SyncSnapshot['itemHistory']): SyncSnapshot {
  return {
    formatVersion: 1,
    generatedAt: 0,
    tables: {},
    tombstones: [],
    gaugeHistory: [],
    itemTags: [],
    itemHistory,
  };
}

/** Ids of the INSERTed ledger rows in a clone plan (the `created_at` bind value). */
function clonedHistoryCreatedAt(stmts: ReturnType<typeof buildCloneStatements>): number[] {
  return stmts
    .filter((s) => s.sql.includes(`INSERT OR IGNORE INTO ${ITEM_HISTORY_TABLE}`))
    .map((s) => Number((s.params as unknown[])[3])); // (id, item_id, action, created_at)
}

describe('buildCloneStatements — §7.6.3-A clone-path history watermark (Phase 14)', () => {
  const remote = snapshot([
    { id: 'old', item_id: 'i1', action: 'CREATED', created_at: 100 },
    { id: 'mid', item_id: 'i1', action: 'ADJUSTED', created_at: 200 },
    { id: 'new', item_id: 'i1', action: 'ADJUSTED', created_at: 300 },
  ]);

  it('clones the whole remote ledger when no watermark is set (default 0)', () => {
    expect(clonedHistoryCreatedAt(buildCloneStatements(remote, DICTIONARY)).sort()).toEqual([
      100, 200, 300,
    ]);
  });

  it('skips remote ledger rows older than the local prune watermark', () => {
    // A device that pruned everything before 250 must not re-pull the 100/200 era.
    expect(clonedHistoryCreatedAt(buildCloneStatements(remote, DICTIONARY, 250))).toEqual([300]);
  });

  it('keeps rows exactly at the watermark (the cut is strict <)', () => {
    expect(clonedHistoryCreatedAt(buildCloneStatements(remote, DICTIONARY, 200)).sort()).toEqual([
      200, 300,
    ]);
  });
});
