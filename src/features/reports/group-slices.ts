/**
 * Mapping a document-wide page onto the per-group reads that cover it.
 *
 * Both printable documents — the insurance schedule (issue #163) and the parts catalogue
 * (issue #410) — order their *groups* in TypeScript over a bounded set (the location
 * hierarchy, the category names), and read a group's *lines* from SQLite one bounded page at
 * a time. A reader's page is therefore a handful of single-group reads rather than an ordering
 * SQLite would have to reproduce, and a page straddling a group boundary simply yields two
 * slices.
 *
 * Kept in its own dependency-free module because it is the one piece both documents share
 * verbatim: `scheduleSlices` is a thin adapter over it, so the two can never drift on what a
 * page of a grouped document *is*.
 */

/** A contiguous run of one group's lines, addressed by the group's own offset. */
export interface GroupSlice<T> {
  /** The group the run comes from. */
  readonly group: T;
  /** Offset **within the group**, not within the document. */
  readonly offset: number;
  readonly limit: number;
}

/** The only thing slicing needs to know about a group: how many lines it holds in total. */
export interface CountedGroup {
  readonly itemCount: number;
}

/**
 * Map a document-wide `offset`/`limit` onto the per-group slices that cover it.
 *
 * Groups are consumed in the order given — which is the order the document prints them in — so
 * the caller's group ordering is the document's global ordering, and nothing here needs to know
 * how it was arrived at. A non-positive `limit` selects nothing, and an `offset` past the end of
 * the last group yields no slices at all.
 */
export function sliceGroupsForPage<T extends CountedGroup>(
  groups: readonly T[],
  offset: number,
  limit: number,
): GroupSlice<T>[] {
  const slices: GroupSlice<T>[] = [];
  if (limit <= 0) return slices;

  let remaining = limit;
  let cursor = Math.max(0, offset);
  for (const group of groups) {
    if (remaining <= 0) break;
    if (cursor >= group.itemCount) {
      // The whole group sits before the requested window — skip it and charge its size.
      cursor -= group.itemCount;
      continue;
    }
    const take = Math.min(group.itemCount - cursor, remaining);
    slices.push({ group, offset: cursor, limit: take });
    remaining -= take;
    cursor = 0;
  }
  return slices;
}
