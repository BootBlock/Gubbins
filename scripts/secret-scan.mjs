/**
 * Credential-shaped secret scanner — the single source of truth for the checks used both by
 * the local `.githooks/pre-commit` hook and by the CI backstop in `.github/workflows/tests.yml`.
 * The patterns and the placeholder rules live in `scripts/secret-detect.mjs` (unit tested); this
 * file is the git plumbing and the CLI around them.
 *
 * Gubbins is a PUBLIC repository where a committed secret is treated as build-breaking and is
 * effectively permanent once pushed (see CLAUDE.md). The pre-commit hook is the fast, local
 * first line of defence, but it runs only on a developer's machine, only against staged lines,
 * and can be skipped with `git commit --no-verify` or simply by never running `npm install`.
 * CI is therefore the authoritative gate: this same scanner runs there over the lines a push or
 * pull request adds, so a secret that slips past the hook still fails the build.
 *
 * Both callers scan only *added* lines of a diff — never the whole tree — so a value that has
 * always lived in a committed test fixture is not re-flagged on every unrelated change; only
 * newly introduced content is judged, which is exactly what the hook does locally.
 *
 *   node scripts/secret-scan.mjs --staged         # pre-commit: added lines of the staged diff
 *   node scripts/secret-scan.mjs --diff <baseRef>  # CI: added lines of <baseRef>..HEAD
 *
 * Exits non-zero and prints every suspect line (not just the first) so one run gives the full
 * list. A false positive is resolved by making the VALUE itself an obvious placeholder —
 * `<YOUR_API_KEY>`, `sk-xxxx`, `$API_TOKEN` — because the exclusions are judged against the
 * matched credential, not against the rest of the line.
 */
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanAddedLines } from './secret-detect.mjs';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(scriptDir, '..');

/** Run git in the repo root and return stdout as text. */
function git(args) {
  return execFileSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
}

const args = process.argv.slice(2);
const diffIndex = args.indexOf('--diff');

let diff;
let where;
if (args.includes('--staged')) {
  diff = git(['diff', '--cached', '--no-color', '-U0', '--diff-filter=ACM']);
  where = 'staged changes';
} else if (diffIndex !== -1) {
  const baseRef = args[diffIndex + 1];
  if (!baseRef) {
    console.error('secret-scan: --diff requires a base ref, e.g. `--diff origin/main`.');
    process.exit(2);
  }
  diff = git(['diff', '--no-color', '-U0', '--diff-filter=ACM', baseRef, 'HEAD']);
  where = `changes since ${baseRef}`;
} else {
  console.error('secret-scan: usage — `--staged` or `--diff <baseRef>`.');
  process.exit(2);
}

const hits = scanAddedLines(diff);

if (hits.length > 0) {
  console.error(`secret-scan: possible secret in ${where} — ${hits.length} suspect line(s).`);
  console.error('This is a PUBLIC repository; a secret is effectively permanent once pushed.');
  console.error('Review each line and remove the secret or replace it with a placeholder:');
  for (const hit of hits) console.error(`  ${hit}`);
  console.error('False positive? Make the value itself a placeholder (<YOUR_API_KEY>, sk-xxxx).');
  process.exit(1);
}

process.exit(0);
