/**
 * DiagnosticsRepository — read-only content stats for the About screen's Diagnostics card.
 *
 * Surfaces two non-identifying, aggregate facts about the local database: the true on-disk size
 * (SQLite's `page_count × page_size`, the canonical logical DB size) and the row count of each
 * top-level entity. It exists so the About feature never reaches past the repository seam into the
 * driver for ad-hoc SQL — the counts are plain `COUNT(*)`s, the size is a PRAGMA pair.
 */
import { BaseRepository } from './base';

/** Row counts of the top-level entities a user creates. */
export interface DiagnosticCounts {
  readonly items: number;
  readonly locations: number;
  readonly projects: number;
  readonly contacts: number;
  readonly categories: number;
  readonly tags: number;
}

/** Aggregate, non-identifying database facts for diagnostics. */
export interface DiagnosticsSnapshot {
  /** True logical database size in bytes (`page_count × page_size`). */
  readonly databaseBytes: number;
  readonly counts: DiagnosticCounts;
}

export class DiagnosticsRepository extends BaseRepository {
  /** Gather the database size and every entity count in one round of parallel reads. */
  async snapshot(): Promise<DiagnosticsSnapshot> {
    const [databaseBytes, items, locations, projects, contacts, categories, tags] = await Promise.all([
      this.databaseBytes(),
      this.count('items'),
      this.count('locations'),
      this.count('projects'),
      this.count('contacts'),
      this.count('categories'),
      this.count('tags'),
    ]);
    return { databaseBytes, counts: { items, locations, projects, contacts, categories, tags } };
  }

  /** The database's logical byte size — pages times page size. */
  private async databaseBytes(): Promise<number> {
    const [pages, pageSize] = await Promise.all([
      this.driver.queryOne<{ page_count: number }>('PRAGMA page_count;'),
      this.driver.queryOne<{ page_size: number }>('PRAGMA page_size;'),
    ]);
    return Number(pages?.page_count ?? 0) * Number(pageSize?.page_size ?? 0);
  }

  /** `COUNT(*)` of a fixed, internally-named table (never user input — no injection surface). */
  private async count(table: string): Promise<number> {
    const row = await this.driver.queryOne<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table};`);
    return Number(row?.n ?? 0);
  }
}
