/**
 * Location-photo and region row + DTO types (issue #81).
 *
 * A **location photo** is a picture of a place, stored exactly like an item image: the
 * full-resolution WebP is a raw OPFS file and only its path is kept here, while a small
 * `thumbnail_blob` lives in the row so a peer can render without the original (§4.2.1
 * Anti-Base64 Directive).
 *
 * A **region** is a named shape drawn onto that photo — "Top shelf", "Drawer 2" — whose
 * geometry is stored as JSON in normalised image space so re-encoding the photo at a
 * different size never moves it. Items reference regions many-to-many: a region is a place
 * that exists independently of what is in it.
 */
import type { RegionShape } from '../constants';

export interface LocationPhotoRow {
  readonly id: string;
  readonly location_id: string;
  readonly caption: string | null;
  readonly thumbnail_blob: Uint8Array | null;
  readonly full_res_opfs_path: string;
  readonly full_res_downgraded_at: number | null;
  readonly natural_width: number;
  readonly natural_height: number;
  readonly position: number;
  readonly created_at: number;
  readonly updated_at: number;
}

export interface LocationPhoto {
  readonly id: string;
  readonly locationId: string;
  readonly caption: string | null;
  readonly thumbnailBlob: Uint8Array | null;
  /** Relative OPFS path to the high-resolution WebP (§4.2.2). Never Base64. */
  readonly fullResOpfsPath: string;
  /**
   * UNIX-ms instant the full-resolution file was dropped to reclaim OPFS space
   * (§7.6.3 Workflow B), or null while it is still present. Per-device state — it is
   * excluded from the synced payload, since a peer that still holds its own copy must not
   * be told the file is gone.
   */
  readonly fullResDowngradedAt: number | null;
  /**
   * Pixel dimensions of the source image, stored rather than measured. Region geometry is
   * normalised, so the overlay needs the aspect ratio *before* the full-resolution file
   * decodes — and on a peer device that file may never arrive at all, since only the
   * thumbnail syncs.
   */
  readonly naturalWidth: number;
  readonly naturalHeight: number;
  readonly position: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface CreateLocationPhotoInput {
  readonly locationId: string;
  readonly caption?: string | null;
  readonly thumbnailBlob: Uint8Array | null;
  readonly fullResOpfsPath: string;
  readonly naturalWidth: number;
  readonly naturalHeight: number;
  readonly position?: number;
}

export interface LocationRegionRow {
  readonly id: string;
  readonly photo_id: string;
  readonly name: string;
  readonly shape: RegionShape;
  readonly geometry: string;
  readonly color: string | null;
  readonly position: number;
  readonly created_at: number;
  readonly updated_at: number;
}

export interface LocationRegion {
  readonly id: string;
  readonly photoId: string;
  readonly name: string;
  readonly shape: RegionShape;
  /**
   * The shape's geometry as a JSON string in **normalised image space** (0–1 per axis).
   * Parsed defensively through the pure `features/inventory/regions` seam — a corrupt or
   * hand-edited value must degrade to "no shape", never throw.
   */
  readonly geometry: string;
  /** A `--loc-*` palette key, or null to fall back to the default overlay stroke. */
  readonly color: string | null;
  /** Draw order; the topmost region wins a hit test. */
  readonly position: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface CreateLocationRegionInput {
  readonly photoId: string;
  readonly name: string;
  readonly shape: RegionShape;
  readonly geometry: string;
  readonly color?: string | null;
  readonly position?: number;
}

export interface UpdateLocationRegionInput {
  readonly name?: string;
  readonly geometry?: string;
  readonly color?: string | null;
  readonly position?: number;
}

/** A region plus how many items currently reference it (the list projection). */
export interface LocationRegionWithCount extends LocationRegion {
  readonly itemCount: number;
}

/**
 * A region an item belongs to, resolved back up through its photo to the location — the
 * item-side answer to "where, exactly, is this?".
 */
export interface ItemRegionPlacement {
  readonly regionId: string;
  readonly regionName: string;
  readonly shape: RegionShape;
  readonly geometry: string;
  readonly color: string | null;
  readonly photoId: string;
  readonly locationId: string;
  readonly locationName: string;
}
