/**
 * Regenerate (or verify) `package-lock.json` so that `npm ci` accepts it everywhere.
 *
 *   node scripts/lockfile.mjs            # regenerate the lockfile, then verify it
 *   node scripts/lockfile.mjs --check    # verify only; never writes
 *
 * **Why this exists.** Running `npm install` on Windows silently produces a lockfile that
 * `npm ci` then refuses, with an error that names neither the cause nor the culprit:
 *
 *   npm error Missing: @emnapi/wasi-threads@1.2.3 from lock file
 *   npm error Missing: tslib@2.8.1 from lock file
 *
 * `@tailwindcss/oxide` fans out to one prebuilt binary per platform, and one of them —
 * `@tailwindcss/oxide-wasm32-wasi` — declares `cpu: ["wasm32"]`. On an x64 host npm skips it,
 * and drops its private `@emnapi/core` / `@emnapi/runtime` entries from the lockfile while
 * leaving the *requirement* on them in place. `npm ci` re-resolves `@emnapi/core@^1.11.1` to a
 * newer release, finds its pinned `@emnapi/wasi-threads` absent, and gives up. Nothing about the
 * repository causes this and no combination of npm flags (`--cpu`, `--os`, `--include=optional`,
 * `--force`) avoids it — the lockfile has to be produced on Linux.
 *
 * The same npm also quietly strips the `libc` markers that tell a glibc build of a native package
 * apart from a musl one, so a lockfile it has touched is degraded even where `npm ci` still
 * accepts it. The container therefore reseeds from the lockfile **as committed**, not the copy in
 * the working tree, and re-resolves the working tree's `package.json` against it. That is what
 * makes this a repair and not just a regeneration: a lockfile a bare `npm install` has already
 * damaged comes back whole.
 *
 * So on Linux this shells out to npm directly. Anywhere else it runs the same npm inside a Linux
 * container over a scratch copy, and copies the result back. Either way it finishes with a
 * `npm ci --dry-run`, so a lockfile that would break CI fails here instead — where it is one
 * command to fix rather than a red build to read backwards.
 *
 * Run it after any change to dependencies. CI needs no wiring: its own `npm ci` is the same gate.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** Keep in step with `node-version` in `.github/workflows/tests.yml`. */
const LINUX_IMAGE = 'node:25';

const checkOnly = process.argv.includes('--check');

/** Run a command, streaming its output. Returns the exit status rather than throwing. */
function run(command, args, options = {}) {
  return spawnSync(command, args, { stdio: 'inherit', shell: false, ...options }).status ?? 1;
}

/**
 * Run npm. On Windows `npm` is a `.cmd` shim, which Node refuses to spawn without a shell, so this
 * goes through one — passing a single command string rather than an argument array, because the
 * array form under `shell: true` is what Node deprecated in DEP0190. Every argument below is a
 * literal from this file, so there is nothing to escape.
 */
function npm(args, { quiet = false } = {}) {
  const status = spawnSync(`npm ${args.join(' ')}`, {
    cwd: ROOT,
    shell: true,
    stdio: quiet ? 'ignore' : 'inherit',
  }).status;
  return status ?? 1;
}

/** Is a Linux Docker daemon reachable? */
function hasLinuxDocker() {
  try {
    const os = execFileSync('docker', ['info', '--format', '{{.OSType}}'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return os.toString().trim() === 'linux';
  } catch {
    return false;
  }
}

/**
 * Seed the scratch directory's lockfile from the committed copy, so npm re-resolves against the
 * last version Linux produced rather than one this platform may already have degraded. Falls back
 * to the working tree's copy when git cannot supply one.
 */
function seedLockfile(scratch) {
  try {
    const committed = execFileSync('git', ['show', 'HEAD:package-lock.json'], {
      cwd: ROOT,
      maxBuffer: 64 * 1024 * 1024,
    });
    writeFileSync(join(scratch, 'package-lock.json'), committed);
  } catch {
    copyFileSync(join(ROOT, 'package-lock.json'), join(scratch, 'package-lock.json'));
  }
}

/** Resolve the lockfile in a scratch directory, so a failed run can never leave a broken one behind. */
function regenerateViaDocker() {
  const scratch = mkdtempSync(join(tmpdir(), 'gubbins-lock-'));
  try {
    copyFileSync(join(ROOT, 'package.json'), join(scratch, 'package.json'));
    seedLockfile(scratch);
    // `--ignore-scripts`: the repo's `prepare` script wires a git hook path, which is meaningless
    // (and would fail) inside the container.
    const status = run('docker', [
      'run',
      '--rm',
      '-v',
      `${scratch}:/lock`,
      '-w',
      '/lock',
      LINUX_IMAGE,
      'npm',
      'install',
      '--package-lock-only',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
    ]);
    if (status !== 0) return status;
    copyFileSync(join(scratch, 'package-lock.json'), join(ROOT, 'package-lock.json'));
    return 0;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (!checkOnly) {
  if (process.platform === 'linux') {
    const status = npm(['install', '--package-lock-only', '--no-audit', '--no-fund']);
    if (status !== 0) process.exit(status);
  } else if (hasLinuxDocker()) {
    console.log(
      `Regenerating package-lock.json in ${LINUX_IMAGE} (npm on ${process.platform} drops wasm32 entries)…`,
    );
    const status = regenerateViaDocker();
    if (status !== 0) process.exit(status);
  } else {
    console.error(
      `No Linux Docker daemon is reachable, and npm on ${process.platform} cannot produce a lockfile\n` +
        'that `npm ci` accepts. Start Docker and run this again, or regenerate the lockfile on Linux.',
    );
    process.exit(1);
  }
}

console.log('Verifying the lockfile with `npm ci --dry-run`…');
const verified = npm(['ci', '--dry-run', '--ignore-scripts', '--no-audit', '--no-fund'], { quiet: true });
if (verified !== 0) {
  console.error(
    checkOnly
      ? '\nThe lockfile is out of step with package.json. Run `npm run lock` to rebuild it.'
      : '\nThe regenerated lockfile still fails `npm ci`. This is not the known wasm32 problem.',
  );
  process.exit(1);
}
console.log('Lockfile OK — `npm ci` accepts it.');
