# Releases, rollback and recovery

How a Gubbins deploy is recorded, how to roll one back, and what a user can do if a bad build
reaches them. This exists because none of it used to be answerable: with zero git tags, "what
is currently deployed?" required guessing at `git log`, and the only in-app escape from a
broken service worker also destroyed the user's inventory (issue #276).

## Every deploy is tagged

Publishing is manual: **Actions → Deploy to GitHub Pages → Run workflow**. The workflow now
brackets that with a release marker:

1. **Before building**, it reads `version` from `package.json` and checks whether `v<version>`
   already exists on the remote. If it does and it points at a *different* commit, the run
   fails immediately with "bump `version` in package.json before deploying new code". A
   re-deploy of the *same* commit is idempotent and allowed.
2. **After the deploy succeeds**, it pushes an annotated tag `v<version>` at the deployed
   commit.

So a tag means "this commit reached production", never "someone tried". `git tag` is the
release history, and the newest tag names the build currently being served.

### Cutting a release

1. Bump `version` (and `releaseDate`) in `package.json`. Bump `schemaVersion` too if the change
   is a breaking pre-1.0 schema change — the update banner reads it to decide whether it can
   promise the user's data survives.
2. Land it on `main`.
3. Run the deploy workflow.

Forgetting step 1 is not a silent mistake any more: the workflow refuses the run.

### Rolling back

There is no server-side kill switch — Gubbins is a static Pages site with no backend, so a bad
build cannot be withdrawn from users who already have it. Rollback means republishing an older
one:

1. `git tag` — pick the last known-good `v<version>`.
2. Run **Deploy to GitHub Pages** against that tag.

Because the tag already points at that commit, the pre-build check passes and the deploy is a
straight republish. Users pick it up on their next update check; users who are actively broken
can force it with the recovery routes below.

> **Data-corrupting deploys are not mitigated beyond "don't ship one."** A build that writes bad
> rows into the local database has already done so by the time it is rolled back. The migration
> baseline and the update banner's schema check are the guards; nothing downstream of them can
> undo a bad write. Treat schema-touching changes accordingly.

## Recovery routes for a user on a bad build

Three, in increasing order of what they cost the user. The first two touch **no data at all**.

| Route | Where | What it does |
| --- | --- | --- |
| **Reinstall app files** | Settings → Danger zone | `resetServiceWorkerOnly()` — unregisters the worker, empties Cache Storage, reloads. Data untouched. |
| **`?recover=1`** | Any Gubbins URL | `public/recovery.js`, a classic script in `<head>`. Same effect, but works when the bundle is too broken for React to mount. Data untouched. |
| **Hard reset & purge** | Safe Mode | `hardResetLocalData()` — the above **plus** deleting the OPFS database, images and all `gubbins:` keys. Last resort. |

The shared mechanism is [`src/lib/app-shell-reset.ts`](../../src/lib/app-shell-reset.ts) —
deliberately import-free, since it runs in situations where any module it pulled in could be the
broken one. `hardResetLocalData` calls it too, so the code half of a purge cannot drift from the
gentle version.

`?recover=1` is the one that matters for the worst case: a broken entry chunk or a failed
`coi-bootstrap` interaction kills the app before the error boundary mounts, and the cache-first
`respond()` in `src/sw.ts` then serves that same broken shell forever. `recovery.js` is
precached alongside the shell (it matches the `**/*.js` precache glob), so it is available even
when the build it shipped with is unusable.

## Related

- [`.github/workflows/deploy.yml`](../../.github/workflows/deploy.yml) — the workflow described above.
- [`src/app/error/safe-mode-actions.ts`](../../src/app/error/safe-mode-actions.ts) — the rescue actions.
- [`docs/wiki/Danger-Zone-Erasing-Data.md`](../wiki/Danger-Zone-Erasing-Data.md) — the user-facing copy.
- [`docs/wiki/FAQ-and-Troubleshooting.md`](../wiki/FAQ-and-Troubleshooting.md) — where `?recover=1` is documented for users.
