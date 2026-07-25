/**
 * Tag row + DTO types (spec §4, §5 freeform tagging).
 */
import type { PageParams } from './pagination';

export interface TagRow {
  readonly id: string;
  readonly name: string;
  readonly updated_at: number;
}

export interface Tag {
  readonly id: string;
  readonly name: string;
  readonly updatedAt: number;
}

/** A tag plus how many items and locations currently carry it, for the dictionary view. */
export interface TagWithCount extends Tag {
  readonly itemCount: number;
  readonly locationCount: number;
}

/**
 * What narrows a tag-dictionary read (issue #137). `search` is a case-insensitive **substring**
 * of the tag's name — not the prefix match the tag-entry combobox uses, because tidying up a
 * dictionary means finding `project-x` by typing `project` *or* `x`.
 */
export interface TagFilter {
  readonly search?: string;
}

/**
 * How the tag dictionary is ordered (issue #137). Name order is the default and the order the
 * screen has always used; the usage orders exist for the job this screen is for — the tags on
 * nothing are the ones worth deleting, and the tags on everything are the ones worth keeping.
 */
export type TagSort = 'NAME_ASC' | 'NAME_DESC' | 'USAGE_DESC' | 'USAGE_ASC';

/** {@link TagFilter} plus the ordering and the page to read of the matching tags. */
export interface TagListParams extends PageParams, TagFilter {
  readonly sort?: TagSort;
}
