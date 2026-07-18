/**
 * Issue #187 — §7.5 natural-key collision resolution.
 *
 * Eight synced tables carry a UNIQUE index that is not the primary key while creating rows
 * with `crypto.randomUUID()`, so two offline devices that each add a tag "Bolts" (or a
 * contact, or a custom field) end up with two ids under one key. Before this resolution the
 * merge emitted a plain `ON CONFLICT(id)` upsert, the INSERT tripped
 * `SQLITE_CONSTRAINT_UNIQUE`, the whole atomic apply rolled back and the watermark never
 * advanced — sync was bricked, identically, forever.
 *
 * These tests pin both halves of the fix: the collision is resolved rather than applied, and
 * the losing row's *associations* follow the winner instead of being cascaded away.
 */
import { describe, it, expect } from 'vitest';
import { reconcile } from './reconcile';
import type { SqlRow } from '@/db/rpc/driver';
import type { SyncSnapshot } from './types';

const DICTIONARY = {
  items: ['id', 'name', 'location_id', 'updated_at'],
  tags: ['id', 'name', 'updated_at'],
  contacts: ['id', 'name', 'updated_at'],
  checkouts: ['id', 'item_id', 'contact_id', 'updated_at'],
  field_defs: ['id', 'name', 'field_type', 'updated_at'],
  item_field_values: ['id', 'item_id', 'def_id', 'value', 'updated_at'],
  capabilities: ['id', 'item_id', 'key', 'value', 'updated_at'],
};

function snapshot(partial: {
  tables?: Partial<Record<string, SqlRow[]>>;
  itemTags?: { itemId: string; tagId: string }[];
}): SyncSnapshot {
  return {
    formatVersion: 1,
    generatedAt: 0,
    tables: partial.tables ?? {},
    tombstones: [],
    gaugeHistory: [],
    itemTags: partial.itemTags ?? [],
    locationTags: [],
    itemHistory: [],
  };
}

const opts = { offset: 0, dictionary: DICTIONARY };

describe('§7.5 natural-key collisions (issue #187)', () => {
  describe('dictionaries are merged, not dropped', () => {
    it('two devices that each created the tag "Bolts" converge on one id', () => {
      const local = snapshot({
        tables: {
          items: [{ id: 'iA', name: 'Item A', updated_at: 1 }],
          tags: [{ id: 'tagLocal', name: 'Bolts', updated_at: 10 }],
        },
        itemTags: [{ itemId: 'iA', tagId: 'tagLocal' }],
      });
      const remote = snapshot({
        tables: {
          items: [{ id: 'iB', name: 'Item B', updated_at: 1 }],
          tags: [{ id: 'tagRemote', name: 'bolts', updated_at: 20 }],
        },
        itemTags: [{ itemId: 'iB', tagId: 'tagRemote' }],
      });

      const plan = reconcile(local, remote, opts);

      // The newer remote row keeps the name; the local id is retired ahead of the upsert.
      expect(plan.collisions).toEqual([
        { table: 'tags', loserId: 'tagLocal', winnerId: 'tagRemote', deletedAt: 20 },
      ]);
      // Crucially, BOTH devices' items end up tagged — the local link followed the re-key
      // rather than being cascaded away with the losing row.
      expect(plan.itemTagUpserts).toContainEqual({ itemId: 'iA', tagId: 'tagRemote' });
      expect(plan.itemTagUpserts).toContainEqual({ itemId: 'iB', tagId: 'tagRemote' });
      expect(plan.itemTagUpserts.some((e) => e.tagId === 'tagLocal')).toBe(false);
    });

    it('a custom field created on both devices keeps both devices’ values', () => {
      const local = snapshot({
        tables: {
          items: [{ id: 'iA', name: 'A', updated_at: 1 }],
          field_defs: [{ id: 'defLocal', name: 'Voltage', field_type: 'text', updated_at: 30 }],
          item_field_values: [{ id: 'vA', item_id: 'iA', def_id: 'defLocal', value: '5V', updated_at: 30 }],
        },
      });
      const remote = snapshot({
        tables: {
          items: [{ id: 'iB', name: 'B', updated_at: 1 }],
          field_defs: [{ id: 'defRemote', name: 'voltage', field_type: 'text', updated_at: 10 }],
          item_field_values: [{ id: 'vB', item_id: 'iB', def_id: 'defRemote', value: '12V', updated_at: 10 }],
        },
      });

      const plan = reconcile(local, remote, opts);

      // The local definition is newer, so the incoming one is retired.
      expect(plan.collisions).toEqual([
        { table: 'field_defs', loserId: 'defRemote', winnerId: 'defLocal', deletedAt: 30 },
      ]);
      // The incoming value row is repointed at the surviving definition, so item B keeps its
      // "12V" instead of the value being dropped along with the retired def.
      expect(plan.localUpserts).toContainEqual({
        table: 'item_field_values',
        row: { id: 'vB', item_id: 'iB', def_id: 'defLocal', value: '12V', updated_at: 10 },
      });
    });

    it('re-keying a contact preserves the checkout history that pointed at it', () => {
      const local = snapshot({
        tables: {
          items: [{ id: 'iA', name: 'A', updated_at: 1 }],
          contacts: [{ id: 'cLocal', name: 'Alex Smith', updated_at: 10 }],
          checkouts: [{ id: 'ck1', item_id: 'iA', contact_id: 'cLocal', updated_at: 10 }],
        },
      });
      const remote = snapshot({
        tables: { contacts: [{ id: 'cRemote', name: 'alex smith', updated_at: 20 }] },
      });

      const plan = reconcile(local, remote, opts);

      expect(plan.collisions).toEqual([
        { table: 'contacts', loserId: 'cLocal', winnerId: 'cRemote', deletedAt: 20 },
      ]);
      // `checkouts.contact_id` is ON DELETE CASCADE, so without the re-key the local checkout
      // would be silently destroyed by retiring the losing contact.
      expect(plan.localUpserts).toContainEqual({
        table: 'checkouts',
        row: { id: 'ck1', item_id: 'iA', contact_id: 'cRemote', updated_at: 10 },
      });
    });
  });

  describe('composite child keys', () => {
    it('resolves a concurrently-added capability on the same item', () => {
      const local = snapshot({
        tables: {
          items: [{ id: 'iA', name: 'A', updated_at: 1 }],
          capabilities: [{ id: 'capLocal', item_id: 'iA', key: 'Voltage', value: '5', updated_at: 10 }],
        },
      });
      const remote = snapshot({
        tables: {
          items: [{ id: 'iA', name: 'A', updated_at: 1 }],
          capabilities: [{ id: 'capRemote', item_id: 'iA', key: 'voltage', value: '12', updated_at: 20 }],
        },
      });

      const plan = reconcile(local, remote, opts);

      expect(plan.collisions).toEqual([
        { table: 'capabilities', loserId: 'capLocal', winnerId: 'capRemote', deletedAt: 20 },
      ]);
      expect(plan.localUpserts.some((u) => u.row.id === 'capRemote')).toBe(true);
    });

    it('settles the follow-on collision a field_defs re-key creates', () => {
      // Both devices defined "Voltage" AND both already recorded a value for the same item.
      // Repointing the incoming value at the surviving def would put two rows on
      // (item_id, def_id) — the child pass must resolve that too, or the re-key just moves
      // the constraint violation rather than removing it.
      const local = snapshot({
        tables: {
          items: [{ id: 'iA', name: 'A', updated_at: 1 }],
          field_defs: [{ id: 'defLocal', name: 'Voltage', field_type: 'text', updated_at: 30 }],
          item_field_values: [
            { id: 'vLocal', item_id: 'iA', def_id: 'defLocal', value: '5V', updated_at: 15 },
          ],
        },
      });
      const remote = snapshot({
        tables: {
          items: [{ id: 'iA', name: 'A', updated_at: 1 }],
          field_defs: [{ id: 'defRemote', name: 'voltage', field_type: 'text', updated_at: 10 }],
          item_field_values: [
            { id: 'vRemote', item_id: 'iA', def_id: 'defRemote', value: '12V', updated_at: 25 },
          ],
        },
      });

      const plan = reconcile(local, remote, opts);

      expect(plan.collisions).toContainEqual({
        table: 'field_defs',
        loserId: 'defRemote',
        winnerId: 'defLocal',
        deletedAt: 30,
      });
      // The newer (incoming) value wins the (item, def) pair; the older local row is retired.
      expect(plan.collisions).toContainEqual({
        table: 'item_field_values',
        loserId: 'vLocal',
        winnerId: 'vRemote',
        deletedAt: 25,
      });
      const values = plan.localUpserts.filter((u) => u.table === 'item_field_values');
      expect(values).toEqual([
        {
          table: 'item_field_values',
          row: { id: 'vRemote', item_id: 'iA', def_id: 'defLocal', value: '12V', updated_at: 25 },
        },
      ]);
    });
  });

  describe('determinism', () => {
    it('breaks an exact updated_at tie by id, so both devices reach the same verdict', () => {
      const rowsA = [{ id: 'aaa', name: 'Bolts', updated_at: 10 }];
      const rowsB = [{ id: 'bbb', name: 'bolts', updated_at: 10 }];

      // Device A merging B's snapshot, and device B merging A's, must retire the SAME id.
      // A local-preference tie would have each keep its own row and re-push it forever.
      const asSeenByA = reconcile(
        snapshot({ tables: { tags: rowsA } }),
        snapshot({ tables: { tags: rowsB } }),
        opts,
      );
      const asSeenByB = reconcile(
        snapshot({ tables: { tags: rowsB } }),
        snapshot({ tables: { tags: rowsA } }),
        opts,
      );

      expect(asSeenByA.collisions).toEqual([
        { table: 'tags', loserId: 'bbb', winnerId: 'aaa', deletedAt: 10 },
      ]);
      expect(asSeenByB.collisions).toEqual([
        { table: 'tags', loserId: 'bbb', winnerId: 'aaa', deletedAt: 10 },
      ]);
    });

    it('leaves an ordinary merge with no collisions untouched', () => {
      const local = snapshot({ tables: { tags: [{ id: 't1', name: 'Bolts', updated_at: 10 }] } });
      const remote = snapshot({ tables: { tags: [{ id: 't2', name: 'Nuts', updated_at: 10 }] } });
      const plan = reconcile(local, remote, opts);
      expect(plan.collisions).toEqual([]);
      expect(plan.localUpserts).toEqual([{ table: 'tags', row: { id: 't2', name: 'Nuts', updated_at: 10 } }]);
    });

    it('does not treat a same-id update as a collision', () => {
      const local = snapshot({ tables: { tags: [{ id: 't1', name: 'Bolts', updated_at: 10 }] } });
      const remote = snapshot({ tables: { tags: [{ id: 't1', name: 'Bolts', updated_at: 20 }] } });
      expect(reconcile(local, remote, opts).collisions).toEqual([]);
    });
  });
});
