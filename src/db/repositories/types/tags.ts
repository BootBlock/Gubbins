/**
 * Tag row + DTO types (spec §4, §5 freeform tagging).
 */

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

/** A tag plus how many items currently carry it, for the dictionary view. */
export interface TagWithCount extends Tag {
  readonly itemCount: number;
}
