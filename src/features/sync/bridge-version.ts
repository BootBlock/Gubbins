/**
 * Is the bridge you are talking to as up-to-date as the app talking to it? (issue #282)
 *
 * The bridge has no auto-update and no published artefact — it runs from a checkout of this
 * repository, so it only moves when someone runs `git pull` and restarts it. Nothing about
 * that is visible from the app, which means the natural failure is a months-old bridge
 * quietly answering Home Assistant with data shaped the way it *used* to be.
 *
 * The bridge now reports its own build in the `/api/v1` index, and the app knows its own, so
 * the drift is finally comparable. This module is the pure half of that comparison: given the
 * two pairs of numbers it returns a {@link BridgeVersionStatus}, and the screen decides how
 * loudly to say it.
 *
 * ## Why the schema is judged separately from the version
 *
 * They answer different questions, and collapsing them would either cry wolf or miss the real
 * problem:
 *
 * - **`schemaVersion`** is the compatibility generation of the stored data. A bridge behind on
 *   *this* may read columns that have since moved — the "silently serving wrong data" case,
 *   and the only one worth interrupting someone over.
 * - **`version`** is just which release it is. A bridge a version or two behind is untidy and
 *   worth mentioning, but it is still reading the data correctly.
 *
 * A bridge *ahead* of the app is reported rather than ignored: it is unusual (an app that
 * hasn't reloaded since the checkout advanced), harmless, and confusing to hit with no
 * explanation.
 */
import { compareVersions } from '@/lib/version-compare';

/** How a bridge's build compares to the app's. */
export type BridgeVersionStatus =
  /** Same version and same schema generation — nothing to say. */
  | 'current'
  /**
   * The bridge is on an older schema generation than the app. It may be reading the snapshot
   * with out-of-date assumptions, so this is the one that warrants a warning rather than a note.
   */
  | 'schema-behind'
  /** Same schema, older version — informational: worth updating, but not misreading anything. */
  | 'behind'
  /** The bridge is newer than the app (the app's tab has not reloaded since the checkout moved). */
  | 'ahead'
  /** The bridge did not report a usable version — an older bridge, from before it reported one. */
  | 'unknown';

/** A build pair, as reported by the bridge's `/api/v1` index or held by the app itself. */
export interface BridgeBuild {
  readonly version: string;
  readonly schemaVersion: number;
}

/**
 * Compare the bridge's build against the app's.
 *
 * `bridge` is `null` when the bridge answered without a `bridge` block at all — which is
 * itself the signal that it predates this check, i.e. is definitely old.
 */
export function compareBridgeBuild(bridge: BridgeBuild | null, app: BridgeBuild): BridgeVersionStatus {
  if (bridge === null) return 'unknown';

  // Schema first: it is the question that actually decides whether the answers can be trusted,
  // so an older schema outranks whatever the version strings happen to say.
  if (bridge.schemaVersion < app.schemaVersion) return 'schema-behind';
  if (bridge.schemaVersion > app.schemaVersion) return 'ahead';

  const order = compareVersions(bridge.version, app.version);
  if (order < 0) return 'behind';
  if (order > 0) return 'ahead';
  return 'current';
}

/** Whether a status is worth showing at all — `current` is silence, everything else is a note. */
export function isBridgeBuildNoteworthy(status: BridgeVersionStatus): boolean {
  return status !== 'current';
}
