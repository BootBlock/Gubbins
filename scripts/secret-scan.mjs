/**
 * Credential-shaped secret scanner — the single source of truth for the patterns used both by
 * the local `.githooks/pre-commit` hook and by the CI backstop in `.github/workflows/tests.yml`.
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
 * list. A false positive is resolved the same way as in the hook: use an obvious placeholder
 * (`<YOUR_API_KEY>`, `sk-xxxx`) — the placeholder exclusions below let example snippets through.
 */
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(scriptDir, '..');

/**
 * Generic `key = "value"` / `key: "value"` assignment. Kept in a string (like the hook) so the
 * quote characters stay readable. Requires a quoted value of 8+ non-space, non-quote characters
 * so short or obviously-templated values don't trip it.
 */
const KV_PATTERN =
  '(password|passwd|secret|token|api[_-]?key|client[_-]?secret|access[_-]?key)["\' ]*[:=][ ]*["\'][^"\' ]{8,}';

/**
 * The credential shapes we block. These mirror `.githooks/pre-commit` exactly — keep the two in
 * step (the hook now calls this script, so there is a single definition to maintain). All are
 * matched case-insensitively, as the hook's `grep -nEi` did.
 */
const SECRET_PATTERNS = [
  /-----BEGIN[ A-Z]*PRIVATE KEY-----/i,
  /AKIA[0-9A-Z]{16}/i,
  /sk-[A-Za-z0-9]{20,}/i,
  /(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}/i,
  /github_pat_[A-Za-z0-9_]{20,}/i,
  /xox[baprs]-[A-Za-z0-9-]{10,}/i,
  /AIza[0-9A-Za-z_-]{35}/i,
  new RegExp(KV_PATTERN, 'i'),
];

/**
 * Obvious placeholders and example values that should never be treated as a real secret — the
 * same exclusion list the hook applies with `grep -viE`. A line matching any of these is let
 * through even if it also matches a credential shape.
 */
const PLACEHOLDER = /xxxx|<[^>]*>|example|placeholder|your[_-]|changeme|redacted|dummy|noreply/i;

/** True if a line looks credential-shaped and is not an obvious placeholder. */
function isSuspect(line) {
  if (PLACEHOLDER.test(line)) return false;
  return SECRET_PATTERNS.some((re) => re.test(line));
}

/** Run git in the repo root and return stdout as text. */
function git(args) {
  return execFileSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
}

/**
 * Scan the added lines of a unified diff. `-U0` means no context lines, so every `+…` line
 * (other than the `+++ b/file` header) is genuinely new content.
 */
function scanAddedLines(diff) {
  const hits = [];
  for (const raw of diff.split('\n')) {
    if (!raw.startsWith('+') || raw.startsWith('+++')) continue;
    const line = raw.slice(1);
    if (isSuspect(line)) hits.push(`  ${line.trim()}`);
  }
  return hits;
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
  for (const hit of hits) console.error(hit);
  console.error('False positive? Use a placeholder (<YOUR_API_KEY>, sk-xxxx).');
  process.exit(1);
}

process.exit(0);
