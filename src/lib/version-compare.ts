/**
 * compareVersions — order two dotted-numeric version strings (e.g. `0.1.1`, `0.2.0`).
 *
 * Gubbins versions come from package.json (`0.MINOR.PATCH` while pre-1.0), so a full semver
 * parser (pre-release tags, build metadata) would be overkill. This compares the numeric
 * release components left-to-right, treating a missing component as `0` (so `0.2` === `0.2.0`),
 * and returns the usual comparator triple. It backs the PWA update banner's "skip this version"
 * logic (issue #74): a skipped version stays hidden until a *newer* version appears.
 *
 * @returns `-1` when `a` is older than `b`, `1` when newer, `0` when equal.
 */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const pa = parseParts(a);
  const pb = parseParts(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const na = pa[i] ?? 0;
    const nb = pb[i] ?? 0;
    if (na > nb) return 1;
    if (na < nb) return -1;
  }
  return 0;
}

/**
 * Split a version into its numeric release components, ignoring any pre-release/build suffix
 * (e.g. `1.2.3-beta.1` → `[1, 2, 3]`). A non-numeric component parses to `0` rather than `NaN`
 * so comparison stays total.
 */
function parseParts(version: string): number[] {
  return (version.split('-')[0] ?? '').split('.').map((part) => {
    const n = Number.parseInt(part, 10);
    return Number.isFinite(n) ? n : 0;
  });
}
