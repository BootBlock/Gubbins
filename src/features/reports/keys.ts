/**
 * Query-key SSOT for the §3 Reports screen.
 *
 * Every report query hangs off the `['reports', …]` prefix, so invalidating the prefix
 * refreshes the whole screen at once. This lives in its own dependency-free module (rather
 * than in `./queries`, which consumes the preferences store) so the write side — inventory,
 * purchasing, sales, projects — can import the prefix without pulling the read hooks in.
 */
export const reportKeys = {
  /** The prefix every report query is built from; invalidate this to refresh them all. */
  all: ['reports'] as const,
} as const;
