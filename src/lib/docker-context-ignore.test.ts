/**
 * Guards the agreement between the ignore lists (issue #566).
 *
 * `bridge/Dockerfile` copies the whole `bridge/` directory into the image, so every file an
 * operator keeps there travels into an image layer — and image layers are pushed to registries,
 * shared between hosts, and readable with `docker save`. The files an operator keeps there are
 * exactly the ones git refuses to track: a real `webhooks.json` full of HMAC signing secrets, a
 * `*.env`, a snapshot, a database. `.dockerignore` is the stated safety net, but nothing kept the
 * two lists in step, and `bridge/webhooks.json` was git-ignored while remaining copyable.
 *
 * The invariant asserted here: **whatever `.gitignore` and `bridge/.gitignore` refuse to track
 * inside the bridge's build context, `.dockerignore` refuses to copy.** That makes the rule
 * enforceable rather than remembered, so the next feature that git-ignores a local file cannot
 * quietly reintroduce the same leak.
 *
 * Both ignore files are mirrored in *full*, not just their obviously-sensitive lines. Narrowing
 * the sweep to the names that read as secrets is how the gap reappears: `*.sqlite` was mirrored
 * while `*.sqlite3` beside it was not, and a `*.key` or `gubbins-backup*.zip` an operator left in
 * `bridge/` is no less of a leak than `webhooks.json`. Excluding editor and log noise from an
 * image costs nothing, so there is no reason to carve out exceptions and every reason not to.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { repoPath } from '../test/repo-path';

// Resolved from *this file's* checkout, never `process.cwd()` — see `repoPath`.
const read = (...segments: string[]) => readFileSync(repoPath(import.meta.dirname, ...segments), 'utf8');

/** Ignore-file lines with comments and blanks removed, in order. */
function patterns(source: string): string[] {
  return source
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
}

// ---------------------------------------------------------------------------
// A minimal `.dockerignore` matcher.
//
// Docker matches a context-relative path against each pattern in order, last match wins, and a
// matched *directory* excludes everything beneath it. `**` spans any number of path components,
// while `*` and `?` stop at a separator. This mirrors that closely enough to assert the
// invariant; it is deliberately small, and supports only the pattern shapes this repo uses.
// ---------------------------------------------------------------------------

// Wildcards are parked on private-use characters before expansion so that the regex syntax the
// expansion emits (`(?:`, `)?`, `.*`) is never itself rewritten by a later replacement.
const ANY_CHAR = '\u{E000}'; // `?`
const ANY_DEPTH = '\u{E001}'; // `**`
const ANY_NAME = '\u{E002}'; // `*`

function toRegExp(pattern: string): RegExp {
  let body = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replaceAll('?', ANY_CHAR)
    .replaceAll('**', ANY_DEPTH)
    .replaceAll('*', ANY_NAME);

  body = body
    // `a/**/b` also matches `a/b` — the doubled star may span zero components.
    .replaceAll(`/${ANY_DEPTH}/`, '/(?:.*/)?')
    // A leading `**/` likewise matches at the context root, so `**/x` matches a bare `x`.
    .replace(new RegExp(`^${ANY_DEPTH}/`), '(?:.*/)?')
    .replace(new RegExp(`/${ANY_DEPTH}$`), '/.*')
    .replaceAll(ANY_DEPTH, '.*')
    .replaceAll(ANY_NAME, '[^/]*')
    .replaceAll(ANY_CHAR, '[^/]');

  return new RegExp(`^${body}$`);
}

/**
 * True when Docker would keep `path` — a context-relative, `/`-separated file path — out of the
 * image.
 */
function isIgnored(path: string, dockerignore: string[]): boolean {
  // A pattern matching any ancestor directory excludes the file below it, so test the path and
  // each of its prefixes. Later patterns win, hence the scan across all of them.
  const segments = path.split('/');
  const candidates = segments.map((_, index) => segments.slice(0, index + 1).join('/'));

  let ignored = false;
  for (const raw of dockerignore) {
    const negated = raw.startsWith('!');
    // Docker cleans each pattern, which drops any trailing separator.
    const pattern = (negated ? raw.slice(1) : raw).replace(/\/+$/, '');
    if (pattern.length === 0) continue;
    const re = toRegExp(pattern);
    if (candidates.some((candidate) => re.test(candidate))) ignored = !negated;
  }
  return ignored;
}

// ---------------------------------------------------------------------------
// Turning a git-ignore pattern into concrete paths it would refuse to track.
// ---------------------------------------------------------------------------

/**
 * @param pattern a non-negated `.gitignore` line
 * @param base    the directory the ignore file governs (`''` for the repository root)
 * @param nested  real subdirectories of `base`. An unanchored git rule applies at *every*
 *                depth, so probing only one level would pass a `.dockerignore` that spelled the
 *                rule out per directory instead of using a doubled star.
 */
function samplePaths(pattern: string, base: string, nested: string[]): string[] {
  // A leading `**/` is git's explicit spelling of "at any depth", which is already how an
  // unanchored rule is treated below — strip it and let the same branch handle it.
  const rule = pattern.replace(/^\*\*\//, '');
  if (rule.includes('**')) {
    // Not a shape this generator understands; fail loudly rather than assert nothing.
    throw new Error(`samplePaths: unsupported git-ignore pattern "${pattern}" — extend this helper`);
  }

  const isDirectory = rule.endsWith('/');
  const trimmed = rule.replace(/\/+$/, '');
  // A `*` stands for at least one character and `?` for exactly one; any literal builds a
  // concrete example. A `[cod]` class expands into one sample per member, so a rule such as
  // `*.py[cod]` is checked for every extension it covers rather than only the first.
  const expanded = expandClasses(trimmed.replaceAll('*', 'sample').replaceAll('?', 'x'));
  const withFile = (path: string) => (isDirectory ? `${path}/kept-locally.txt` : path);
  const under = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);

  return expanded.flatMap((raw) => {
    const concrete = raw.replace(/^\//, '');
    // Anchored: a leading slash, or a slash anywhere but the end, pins the rule to `base`.
    if (raw.startsWith('/') || raw.includes('/')) return [withFile(under(base, concrete))];

    // Unanchored: git applies it at every depth below `base`, so an image must exclude it there.
    return [
      withFile(under(base, concrete)),
      ...nested.map((dir) => withFile(under(base ? `${base}/${dir}` : dir, concrete))),
    ];
  });
}

/** `a.py[cod]` → `['a.pyc', 'a.pyo', 'a.pyd']`; a pattern with no class comes back unchanged. */
function expandClasses(pattern: string): string[] {
  const match = /\[([^\]]+)\]/.exec(pattern);
  if (!match) return [pattern];
  const [whole, members] = match;
  return [...members].flatMap((member) => expandClasses(pattern.replace(whole, member)));
}

const dockerignore = patterns(read('.dockerignore'));

/** Every bridge-relevant git-ignore rule, paired with the directory it governs. */
const mirrored = [
  ...patterns(read('bridge', '.gitignore')).map((pattern) => ({
    pattern,
    base: 'bridge',
    nested: ['src', 'src/api', 'src/api/schemas'],
    source: 'bridge/.gitignore',
  })),
  // The root list governs the whole repository, and the bridge's build context *is* the repo
  // root — so every one of its rules applies to what an image would copy.
  ...patterns(read('.gitignore')).map((pattern) => ({
    pattern,
    base: '',
    nested: ['bridge', 'bridge/src', 'src/db/repositories'],
    source: '.gitignore',
  })),
].filter(({ pattern }) => !pattern.startsWith('!'));

describe('.dockerignore mirrors the git-ignore rules', () => {
  it('finds the ignore rules at all (guards against a silently-empty sweep)', () => {
    expect(dockerignore.length).toBeGreaterThan(10);
    expect(mirrored.length).toBeGreaterThan(20);
    // Both files must contribute — a read that silently returned nothing would otherwise leave
    // the sweep looking healthy on the strength of the other one alone.
    expect(mirrored.some((rule) => rule.source === '.gitignore')).toBe(true);
    expect(mirrored.some((rule) => rule.source === 'bridge/.gitignore')).toBe(true);
  });

  it.each(mirrored)('$source rule "$pattern" is also excluded from the build context', (rule) => {
    for (const path of samplePaths(rule.pattern, rule.base, rule.nested)) {
      expect(
        isIgnored(path, dockerignore),
        `"${path}" is git-ignored by ${rule.source} but .dockerignore would copy it into an image`,
      ).toBe(true);
    }
  });

  // The named offender from issue #566, asserted directly so the intent survives any later
  // refactor of the generator above.
  it.each([
    'bridge/webhooks.json',
    'bridge/webhooks.production.json',
    'webhooks.json',
    'bridge/production.env',
    'bridge/.env',
    'bridge/bridge-id',
    'bridge/local/real-snapshot.json',
    'bridge/inventory.sqlite',
    'bridge/inventory.sqlite3',
    'bridge/dump.sql',
    'bridge/gubbins-backup-2026-08-27.zip',
    'bridge/tls.key',
    'bridge/certs/client.p12',
  ])('never copies %s into an image', (path) => {
    expect(isIgnored(path, dockerignore)).toBe(true);
  });

  it.each([
    'bridge/serve.mjs',
    'bridge/loader.mjs',
    'bridge/node-version.mjs',
    'bridge/package.json',
    'bridge/src/serve.ts',
    'bridge/src/fixtures/synthetic-snapshot.json',
    'src/db/repositories/ItemRepository.ts',
    'package.json',
  ])('still copies %s, which the bridge image needs to run', (path) => {
    expect(isIgnored(path, dockerignore)).toBe(false);
  });
});
