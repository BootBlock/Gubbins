/**
 * What the bridge published last time, remembered across restarts (issue #565) — **pure**.
 *
 * The publisher retracts a removed location's retained state topic (and its HA discovery entity) by
 * diffing the new location set against the set it published before. That diff is only as good as
 * its "before" side, which used to be a process-local variable starting empty: a location deleted
 * while the bridge was *stopped* — an upgrade, a reboot — was never in the before side, so its
 * retained topics stayed on the broker for good, and Home Assistant re-created the ghost sensor
 * from the retained config on every start. The publish-only client cannot subscribe, so the broker
 * itself can never be asked what it is holding; the bridge has to remember.
 *
 * This module is the memory's *shape* and its two decisions. The file IO is the composition root's
 * job (`serve.ts`), injected as a {@link RetainedLocationsStore}, so every branch here — including
 * a hand-mangled or future-version file — is unit-testable with no filesystem.
 *
 * The record is keyed by the two prefixes it was written under, because a topic is only ours to
 * retract if it is where we put it. Changing `GUBBINS_BRIDGE_MQTT_PREFIX` (or the discovery prefix)
 * abandons a whole tree under the old one, so a record from a different prefix is not a stale
 * baseline to diff against — it is a list of topics to blank, once, and forget.
 *
 * Nothing here is a secret: location ids and topic prefixes, the same values already on the wire.
 */
import { discoveryConfigTopic, discoveryConfigTopics, locationSensorObjectId } from './discovery.ts';
import { topicsFor } from './topics.ts';

/**
 * The format version of the persisted record. A file written by a *newer* bridge is ignored rather
 * than guessed at — the cost is one run without a diff baseline, against retracting topics from a
 * shape we do not understand.
 */
export const RETAINED_LOCATIONS_VERSION = 1;

/** Default filename for the persisted record, resolved relative to the bridge's working directory. */
export const DEFAULT_MQTT_STATE_FILE = 'mqtt-retained.json';

/** The MQTT prefixes a record was written under. A record only applies to its own scope. */
export interface RetainedScope {
  /** The topic prefix the state topics were published under (`GUBBINS_BRIDGE_MQTT_PREFIX`). */
  readonly prefix: string;
  /** The HA discovery prefix the config topics were published under. */
  readonly discoveryPrefix: string;
}

/** What one previous run left retained on the broker. */
export interface RetainedLocationsRecord extends RetainedScope {
  readonly version: number;
  /** The location ids that have retained state topics under {@link RetainedScope.prefix}. */
  readonly locationIds: readonly string[];
  /**
   * Whether discovery configs may exist under {@link RetainedScope.discoveryPrefix}. Sticky once
   * true: turning the discovery flag off does not delete what it already published, so the
   * retraction still has to cover it.
   */
  readonly discoveryPublished: boolean;
}

/** The persistence seam. Both halves are best-effort: MQTT must never stop the bridge serving. */
export interface RetainedLocationsStore {
  /** The record from a previous run, or `undefined` when there is no readable, valid one. */
  load(): RetainedLocationsRecord | undefined;
  /** Remember the current record. A failure is swallowed by the implementation. */
  save(record: RetainedLocationsRecord): void;
}

/** What a loaded record means for the run that is starting. */
export interface RetainedRestorePlan {
  /**
   * The diff baseline: ids with retained state topics under the *current* prefix. The publisher
   * seeds its "published" set with these, so the first `publishState` after a restart clears
   * whatever disappeared while the bridge was down.
   */
  readonly seedLocationIds: readonly string[];
  /**
   * Retained topics under a prefix this run no longer uses, to blank once at startup. Ordered so a
   * discovery config is retracted before the state topic its entity reads attributes from.
   */
  readonly staleTopics: readonly string[];
  /** Whether discovery configs may already exist under the current discovery prefix. */
  readonly discoveryPublished: boolean;
}

/** Serialise a record for persistence (pretty-printed — an operator may well read this file). */
export function serialiseRetainedLocations(record: RetainedLocationsRecord): string {
  return `${JSON.stringify(record, null, 2)}\n`;
}

/**
 * Parse a persisted record, or `undefined` when there is nothing usable: absent, not JSON, not an
 * object, a version we do not understand, or a field of the wrong type. A mangled file degrades to
 * "no memory of the last run" — the behaviour before this existed — rather than taking MQTT down.
 */
export function parseRetainedLocations(raw: string | undefined): RetainedLocationsRecord | undefined {
  if (raw === undefined || raw.trim().length === 0) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;

  const candidate = parsed as Record<string, unknown>;
  if (candidate.version !== RETAINED_LOCATIONS_VERSION) return undefined;
  if (typeof candidate.prefix !== 'string' || candidate.prefix.length === 0) return undefined;
  if (typeof candidate.discoveryPrefix !== 'string' || candidate.discoveryPrefix.length === 0) {
    return undefined;
  }
  if (typeof candidate.discoveryPublished !== 'boolean') return undefined;
  if (!Array.isArray(candidate.locationIds)) return undefined;
  if (!candidate.locationIds.every((id): id is string => typeof id === 'string' && id.length > 0)) {
    return undefined;
  }

  return {
    version: RETAINED_LOCATIONS_VERSION,
    prefix: candidate.prefix,
    discoveryPrefix: candidate.discoveryPrefix,
    discoveryPublished: candidate.discoveryPublished,
    locationIds: candidate.locationIds,
  };
}

/**
 * Decide what a loaded record means for a run using `scope`.
 *
 * The ordinary case is both prefixes unchanged: the recorded ids are still where the record says
 * they are, so they become the diff baseline and nothing is blanked.
 *
 * A prefix that moved abandons a tree instead:
 *
 *   - **The topic prefix moved** — nothing of ours is under the new prefix yet, so the baseline is
 *     empty and the old state tree is blanked, the fixed `status`, `summary` and `snapshot` topics
 *     included. No run will ever overwrite those again.
 *   - **The discovery prefix moved, with configs out there** — the whole old config tree is
 *     blanked. Home Assistant would otherwise re-create the entire device from the abandoned tree
 *     on every restart, its entities reading state topics nothing writes to. When only the topic
 *     prefix moved, the per-location configs go and the shared device-level ones stay — see the
 *     comment on that branch below.
 *
 * A location that survives the move is retracted here and re-published moments later by the first
 * `publishState`, which is the correct order: an entity must never be left pointing at a dead topic.
 */
export function planRetainedRestore(
  record: RetainedLocationsRecord | undefined,
  scope: RetainedScope,
): RetainedRestorePlan {
  if (record === undefined) {
    return { seedLocationIds: [], staleTopics: [], discoveryPublished: false };
  }

  const prefixKept = record.prefix === scope.prefix;
  const discoveryPrefixKept = record.discoveryPrefix === scope.discoveryPrefix;
  const staleTopics: string[] = [];

  // Configs first: a location sensor reads its attributes from the state topic blanked below, so
  // the other order hands Home Assistant an empty payload to run its attribute template over.
  //
  // How much of the config tree goes depends on WHICH prefix moved, because the two halves of that
  // tree are not equally ours. The device-level entities sit at fixed object ids under the
  // discovery prefix alone (`<discoveryPrefix>/sensor/gubbins/items_total/config` and friends), so
  // a second bridge sharing that discovery prefix publishes to the very same topics:
  //
  //   - **The discovery prefix moved** — that whole tree is abandoned by us. Blank all of it,
  //     device entities included: nothing will ever overwrite them again, and Home Assistant would
  //     re-create the device from them on every restart.
  //   - **Only the topic prefix moved** — the tree is still the one we publish to. Blank the
  //     per-location configs, whose ids are ours, and leave the device-level ones alone: with
  //     discovery on the first `publishState` rewrites them under the new topic prefix moments
  //     later, and blanking them first would take a co-located bridge's live entities down with
  //     them.
  if (record.discoveryPublished) {
    if (!discoveryPrefixKept) {
      staleTopics.push(...discoveryConfigTopics(record.discoveryPrefix, record.locationIds));
    } else if (!prefixKept) {
      staleTopics.push(
        ...record.locationIds.map((id) =>
          discoveryConfigTopic(record.discoveryPrefix, 'sensor', locationSensorObjectId(id)),
        ),
      );
    }
  }
  if (!prefixKept) {
    const old = topicsFor(record.prefix);
    staleTopics.push(
      ...record.locationIds.map((id) => old.locationState(id)),
      old.summaryState,
      old.snapshotState,
      // A retained `online` under an abandoned prefix would tell a subscriber the bridge is up on a
      // tree it has stopped publishing to.
      old.status,
    );
  }

  return {
    seedLocationIds: prefixKept ? record.locationIds : [],
    staleTopics,
    discoveryPublished: discoveryPrefixKept && record.discoveryPublished,
  };
}
