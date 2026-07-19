/**
 * Snapshot reload health — the pure seam behind `/health`'s honesty about stale data (issue #312).
 *
 * A re-hydrate that fails keeps the last good snapshot live (see `watcher.ts`), which is the right
 * availability trade-off: a partially-written file must not tear the server down. The hazard is
 * that the bridge then answers every read from data it *knows* is out of date, while `/health`
 * still says `ok: true` — a consumer (a Home Assistant dashboard, a monitor) shows confidently
 * wrong stock levels instead of degrading to `unavailable`.
 *
 * So the watcher counts consecutive reload failures, and this module turns that raw tally into the
 * report `/health` serves. Past {@link DEFAULT_STALE_AFTER_FAILURES} consecutive failures the
 * snapshot is declared stale and `ok` goes false — the bridge keeps serving (a stale answer still
 * beats none, and the caller can now tell), but it no longer claims to be healthy.
 *
 * Everything here is pure and clock-free: callers pass the timestamps in.
 */

/**
 * Default number of consecutive failed reloads before the served snapshot is called stale.
 *
 * Above one, because a snapshot is written non-atomically: catching it mid-write is routine and
 * self-heals on the next filesystem event, so a single failure is not a fault. Low enough that a
 * genuinely stuck reload (deleted file, corrupt JSON, permissions) surfaces within seconds rather
 * than after the consumer has already acted on stale numbers.
 */
export const DEFAULT_STALE_AFTER_FAILURES = 3;

/** Longest reload-error message echoed in `/health`; anything beyond is truncated. */
const MAX_ERROR_MESSAGE_LENGTH = 200;

/** The watcher's running tally of how the last reloads went. */
export interface SnapshotReloadHealth {
  /** Consecutive failed reloads since the last successful one. Zero when the last reload worked. */
  readonly consecutiveFailures: number;
  /** Message of the most recent failure, or null if none has happened since the last success. */
  readonly lastError: string | null;
  /** ISO-8601 timestamp of the most recent failure, or null. */
  readonly lastErrorAt: string | null;
  /** ISO-8601 timestamp of the most recent *successful* reload, or null before the first. */
  readonly lastSuccessAt: string | null;
}

/** The reload-health block `/health` serves. */
export interface SnapshotHealthReport {
  /** True once the failures have crossed the threshold: the served data is knowingly out of date. */
  readonly snapshotStale: boolean;
  /** Consecutive failed reloads since the last successful one. */
  readonly reloadFailures: number;
  /** Redacted message of the most recent reload failure, or null. */
  readonly lastReloadError: string | null;
  /** ISO-8601 timestamp of the most recent reload failure, or null. */
  readonly lastReloadErrorAt: string | null;
  /** ISO-8601 timestamp of the most recent successful reload, or null. */
  readonly lastReloadAt: string | null;
}

/**
 * The exact JSON body `/health` and `/api/v1/health` return.
 *
 * Spelled out field by field rather than spread from {@link SnapshotHealthReport}: this is a
 * published wire contract mirrored in the OpenAPI spec, so renaming an internal field must be a
 * deliberate edit here (and a compile error) rather than something that silently reshapes the
 * response — the spec's drift-guard compares the spec to the YAML, never to a live response.
 */
export interface HealthBody {
  /** False once the snapshot is stale — a *data* verdict, not liveness. */
  readonly ok: boolean;
  readonly itemCount: number;
  readonly snapshotGeneratedAt: string | null;
  readonly snapshotStale: boolean;
  readonly reloadFailures: number;
  readonly lastReloadError: string | null;
  readonly lastReloadErrorAt: string | null;
  readonly lastReloadAt: string | null;
}

/** A watcher that has never failed — the starting tally, and the default when none is wired. */
export const HEALTHY_RELOAD: SnapshotReloadHealth = {
  consecutiveFailures: 0,
  lastError: null,
  lastErrorAt: null,
  lastSuccessAt: null,
};

/**
 * Fold a reload tally into the `/health` report.
 *
 * `staleAfterFailures` of `0` disables the staleness verdict entirely (the counters are still
 * reported, `snapshotStale` just never flips) — an escape hatch for an operator who would rather
 * a monitor never saw `ok: false` from this cause.
 */
export function summarizeSnapshotHealth(
  health: SnapshotReloadHealth,
  staleAfterFailures: number = DEFAULT_STALE_AFTER_FAILURES,
): SnapshotHealthReport {
  return {
    snapshotStale: staleAfterFailures > 0 && health.consecutiveFailures >= staleAfterFailures,
    reloadFailures: health.consecutiveFailures,
    lastReloadError: health.lastError === null ? null : redactReloadError(health.lastError),
    lastReloadErrorAt: health.lastErrorAt,
    lastReloadAt: health.lastSuccessAt,
  };
}

/**
 * The shared `/health` (and `/api/v1/health`) body — one shape, two paths.
 *
 * `ok` is the *data* verdict, not liveness: it goes false once reloads have been failing long
 * enough that the served snapshot is knowingly out of date, so a consumer can degrade honestly
 * instead of rendering confidently-wrong stock levels. The status stays `200` — the bridge is up
 * and this is a successful health *report*; the counters beside `ok` say why it is unhappy. (A
 * bridge that has never loaded a snapshot at all is still the pre-existing `503`.)
 */
export function healthBody(
  snapshotGeneratedAt: string | null,
  itemCount: number,
  health: SnapshotHealthReport | undefined,
): HealthBody {
  const report = health ?? summarizeSnapshotHealth(HEALTHY_RELOAD);
  return {
    ok: !report.snapshotStale,
    itemCount,
    snapshotGeneratedAt,
    snapshotStale: report.snapshotStale,
    reloadFailures: report.reloadFailures,
    lastReloadError: report.lastReloadError,
    lastReloadErrorAt: report.lastReloadErrorAt,
    lastReloadAt: report.lastReloadAt,
  };
}

/**
 * Strip filesystem paths out of a reload-error message and cap its length.
 *
 * `/health` is authenticated, but the server's standing rule is that a *response* never carries
 * internals — paths, SQL, stack traces (see `server.ts`). A hydrate failure's message is mostly
 * `ENOENT: no such file or directory, open '<path>'`, which is exactly the useful part *and*
 * exactly the disclosure, so the path is replaced rather than the message dropped: the caller
 * still learns which failure mode it is, without learning the operator's directory layout.
 */
export function redactReloadError(message: string): string {
  const redacted = message
    // A drive-letter or root-anchored path, and anything that walks through a separator. The
    // trailing `+` matters: a separator with nothing after it is punctuation, not a path — a
    // JSON error naming the offending character ("Unexpected token / in JSON") must survive
    // intact rather than being redacted down to meaninglessness.
    .replace(/(?:[A-Za-z]:)?[\\/][^\s'"`]+/g, '<path>')
    .trim();
  const collapsed = redacted.length > 0 ? redacted : 'Snapshot reload failed.';
  return collapsed.length > MAX_ERROR_MESSAGE_LENGTH
    ? `${collapsed.slice(0, MAX_ERROR_MESSAGE_LENGTH - 1)}…`
    : collapsed;
}
