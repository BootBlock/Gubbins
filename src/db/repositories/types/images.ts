/**
 * Item-image row + DTO types and the storage-triage projections (spec §4.2, §7.6).
 */

export interface ItemImageRow {
  readonly id: string;
  readonly item_id: string;
  readonly thumbnail_blob: Uint8Array | null;
  readonly full_res_opfs_path: string;
  readonly position: number;
  readonly created_at: number;
  readonly updated_at: number;
  readonly full_res_downgraded_at: number | null;
}

export interface ItemImage {
  readonly id: string;
  readonly itemId: string;
  readonly thumbnailBlob: Uint8Array | null;
  /** Relative OPFS path to the high-resolution WebP (§4.2.2). Never Base64. */
  readonly fullResOpfsPath: string;
  readonly position: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  /**
   * UNIX-ms instant the full-resolution file was dropped to reclaim OPFS space
   * (§7.6.3 Workflow B), or null while it is still present. When set, only the
   * thumbnail remains; `fullResOpfsPath` points at a file that no longer exists.
   */
  readonly fullResDowngradedAt: number | null;
}

export interface CreateImageInput {
  readonly itemId: string;
  readonly thumbnailBlob: Uint8Array | null;
  readonly fullResOpfsPath: string;
  readonly position?: number;
}

// --- Storage triage (spec §7.6.2, §7.6.3, Phase 10) -----------------------------

/**
 * Row counts for the tables that dominate OPFS consumption (§7.6.2). Structurally
 * compatible with the pure `estimateTableBytes` input in `features/storage/triage`,
 * but defined here so the db layer never imports a feature module (no cycle).
 */
export interface StorageRowCounts {
  readonly items: number;
  readonly itemHistory: number;
  readonly itemImages: number;
}

/** An image whose full-resolution OPFS file can be dropped (§7.6.3 Workflow B). */
export interface DowngradableImage {
  readonly id: string;
  readonly fullResOpfsPath: string;
}
