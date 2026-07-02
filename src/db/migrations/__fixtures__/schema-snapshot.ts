/**
 * Canonical schema-snapshot capture used by the Phase 69 migration-baseline
 * equivalence test.
 *
 * The squash of the historical v1…v24 migration chain into a single `v1-initial`
 * baseline must produce a database whose schema is **byte-for-byte identical** to
 * the one the old chain produced. `captureSchemaSnapshot` dumps the full,
 * deterministic schema shape of a migrated database so two builds can be compared
 * exactly:
 *
 *  - every `sqlite_master` object's stored `sql` text (tables, indexes, triggers,
 *    virtual tables and the FTS5 shadow tables),
 *  - per-table column metadata (`PRAGMA table_info`),
 *  - per-table foreign keys (`PRAGMA foreign_key_list`),
 *  - per-table indexes (`PRAGMA index_list`), and
 *  - the resulting `PRAGMA user_version`.
 *
 * The committed `schema-baseline.snapshot.json` fixture is the contract: it is the
 * dump of the ORIGINAL v1…v24 chain, captured once, and the equivalence test asserts
 * the NEW single-baseline build reproduces it exactly.
 *
 * Test-only: it depends on the in-memory `node:sqlite` driver and is never imported
 * by production code.
 */
import type { IDatabaseDriver } from '@/db/rpc/driver';

export interface SchemaObject {
  readonly type: string;
  readonly name: string;
  readonly tbl_name: string;
  readonly sql: string;
}

export interface ColumnInfo {
  readonly cid: number;
  readonly name: string;
  readonly type: string;
  readonly notnull: number;
  readonly dflt_value: string | null;
  readonly pk: number;
}

export interface ForeignKeyInfo {
  readonly id: number;
  readonly seq: number;
  readonly table: string;
  readonly from: string;
  readonly to: string | null;
  readonly on_update: string;
  readonly on_delete: string;
  readonly match: string;
}

export interface IndexInfo {
  readonly seq: number;
  readonly name: string;
  readonly unique: number;
  readonly origin: string;
  readonly partial: number;
}

export interface SchemaSnapshot {
  readonly userVersion: number;
  readonly objects: readonly SchemaObject[];
  readonly tables: Readonly<
    Record<
      string,
      {
        readonly columns: readonly ColumnInfo[];
        readonly foreignKeys: readonly ForeignKeyInfo[];
        readonly indexes: readonly IndexInfo[];
      }
    >
  >;
}

/** Normalise a row's BigInt-or-number flag columns to plain numbers for stable JSON. */
function num(value: unknown): number {
  return Number(value ?? 0);
}

/**
 * Dump the full, deterministic schema shape of a migrated database. Ordering is
 * fixed (by type then name; columns by cid; FKs by id+seq; indexes by seq) so the
 * output is byte-stable across runs and devices.
 */
export async function captureSchemaSnapshot(driver: IDatabaseDriver): Promise<SchemaSnapshot> {
  const userVersionRow = await driver.queryOne<{ user_version: number | bigint }>('PRAGMA user_version;');

  const rawObjects = await driver.query<{
    type: string;
    name: string;
    tbl_name: string;
    sql: string;
  }>('SELECT type, name, tbl_name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type, name;');
  const objects: SchemaObject[] = rawObjects.map((o) => ({
    type: o.type,
    name: o.name,
    tbl_name: o.tbl_name,
    sql: o.sql,
  }));

  // Real (non-virtual, non-shadow) tables we can introspect with table PRAGMAs.
  const tableNames = await driver.query<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name;",
  );

  const tables: Record<
    string,
    { columns: ColumnInfo[]; foreignKeys: ForeignKeyInfo[]; indexes: IndexInfo[] }
  > = {};

  for (const { name } of tableNames) {
    const columns = (
      await driver.query<Record<string, unknown>>(`PRAGMA table_info(${quoteIdent(name)});`)
    ).map((c): ColumnInfo => ({
      cid: num(c.cid),
      name: String(c.name),
      type: String(c.type),
      notnull: num(c.notnull),
      dflt_value: c.dflt_value == null ? null : String(c.dflt_value),
      pk: num(c.pk),
    }));

    const foreignKeys = (
      await driver.query<Record<string, unknown>>(`PRAGMA foreign_key_list(${quoteIdent(name)});`)
    )
      .map((f): ForeignKeyInfo => ({
        id: num(f.id),
        seq: num(f.seq),
        table: String(f.table),
        from: String(f.from),
        to: f.to == null ? null : String(f.to),
        on_update: String(f.on_update),
        on_delete: String(f.on_delete),
        match: String(f.match),
      }))
      .sort((a, b) => a.id - b.id || a.seq - b.seq);

    const indexes = (await driver.query<Record<string, unknown>>(`PRAGMA index_list(${quoteIdent(name)});`))
      .map((i): IndexInfo => ({
        seq: num(i.seq),
        name: String(i.name),
        unique: num(i.unique),
        origin: String(i.origin),
        partial: num(i.partial),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    tables[name] = { columns, foreignKeys, indexes };
  }

  return {
    userVersion: num(userVersionRow?.user_version),
    objects,
    tables,
  };
}

/** Quote an identifier for safe interpolation into a PRAGMA call. */
function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}
