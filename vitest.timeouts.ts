/**
 * The default per-test budget, shared by every Vitest config in the repo.
 *
 * Vitest's own 5s default is too tight here. The slowest test bodies measure several seconds
 * even on an idle machine — a snow drift simulated to saturation, a glyph catalogue re-filtered
 * per keystroke, a 2001-row keyset scan, a UPC-E round trip over the whole space — and none of
 * them is wasteful: each is doing the work it exists to check. Load multiplies all of it, and
 * this repo is routinely worked by several agents at once, so a run competing with another full
 * suite tipped those bodies past 5s and failed green code with "Test timed out".
 *
 * 15s absorbs that without hiding a hang: a test that genuinely stops still fails rather than
 * passing slowly. The handful of bodies that come close to it even so raise the budget again at
 * their own call site, where the reason can be stated next to the cost.
 *
 * Defined once and imported by both `vite.config.ts` and `bridge/vitest.config.ts` — the bridge
 * ships a standalone config (a Node environment, its own include glob), and a second copy of the
 * number would be free to drift from this one.
 */
export const DEFAULT_TEST_TIMEOUT_MS = 15_000;
