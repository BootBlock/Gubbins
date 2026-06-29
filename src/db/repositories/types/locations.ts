/**
 * Location domain row + DTO types (spec §4).
 */

export interface LocationRow {
  readonly id: string;
  readonly name: string;
  readonly parent_id: string | null;
  readonly is_system: number;
  /** Free-text description for the user's reference (nullable, v19). */
  readonly description: string | null;
  /** Semantic colour swatch key (e.g. 'teal'); NULL = standard text colour (v19). */
  readonly color: string | null;
  readonly updated_at: number;
}

export interface Location {
  readonly id: string;
  readonly name: string;
  readonly parentId: string | null;
  readonly isSystem: boolean;
  /** Free-text description for the user's reference (v19). */
  readonly description: string | null;
  /** Semantic colour swatch key; null = standard text colour (v19). */
  readonly color: string | null;
  readonly updatedAt: number;
}

/** A location plus its denormalised live item count, for tree/list rendering. */
export interface LocationWithCount extends Location {
  readonly itemCount: number;
}

/** A location node with its children resolved, for the nested tree view. */
export interface LocationTreeNode extends LocationWithCount {
  readonly children: LocationTreeNode[];
}

export interface CreateLocationInput {
  readonly name: string;
  readonly parentId?: string | null;
  readonly description?: string | null;
  readonly color?: string | null;
}

export interface UpdateLocationInput {
  readonly name?: string;
  readonly parentId?: string | null;
  readonly description?: string | null;
  readonly color?: string | null;
}
