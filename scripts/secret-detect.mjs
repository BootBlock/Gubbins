/**
 * Pure credential-detection logic for the secret scanner (see `scripts/secret-scan.mjs`, which
 * owns the git plumbing and the CLI). Keeping the decision in its own module lets it be unit
 * tested directly — this is the one gate standing between a PUBLIC repository and a permanent
 * leak, so the heuristic is exercised against must-flag and must-not-flag lines rather than
 * trusted by inspection (`scripts/secret-detect.test.mjs`).
 *
 * The central rule: a placeholder exclusion is judged against the CREDENTIAL VALUE a pattern
 * matched, never against the whole line. An earlier version tested the line, and because one of
 * the placeholder alternatives was `<…>`, every JSX element, HTML snippet and XML line in the
 * repository exempted itself — a real key sitting on such a line was dropped before a single
 * credential pattern ran.
 */

/**
 * Generic `key = "value"` / `key: "value"` assignment. Kept in a string (like the hook was) so
 * the quote characters stay readable. Requires a quoted value of 8+ non-space, non-quote
 * characters so short or obviously-templated values don't trip it. Group 1 is the value, which
 * is what the placeholder exclusions are tested against.
 */
const KV_PATTERN =
  '(?:password|passwd|secret|token|api[_-]?key|client[_-]?secret|access[_-]?key)["\' ]*[:=][ ]*["\']([^"\' ]{8,})';

/**
 * The credential shapes we block. `valueGroup` names the capture group holding the credential
 * itself; without one, the whole match IS the credential (an `AKIA…` key is its own value).
 * All are matched case-insensitively, as the original `grep -nEi` did.
 */
export const SECRET_PATTERNS = [
  { name: 'private-key block', re: /-----BEGIN[ A-Z]*PRIVATE KEY-----/gi },
  { name: 'AWS access key id', re: /AKIA[0-9A-Z]{16}/gi },
  { name: 'sk- style API key', re: /sk-[A-Za-z0-9]{20,}/gi },
  { name: 'GitHub token', re: /(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}/gi },
  { name: 'GitHub fine-grained token', re: /github_pat_[A-Za-z0-9_]{20,}/gi },
  { name: 'Slack token', re: /xox[baprs]-[A-Za-z0-9-]{10,}/gi },
  { name: 'Google API key', re: /AIza[0-9A-Za-z_-]{35}/gi },
  { name: 'credential assignment', re: new RegExp(KV_PATTERN, 'gi'), valueGroup: 1 },
];

/**
 * Words that mark a value as an obvious example rather than a live credential. Tested against
 * the matched value ONLY — `example` in a neighbouring `example.com` URL, or the `noreply`
 * in an author address, no longer excuses a real key elsewhere on the same line.
 */
const PLACEHOLDER_WORD = /xxxx|example|placeholder|your[_-]|changeme|redacted|dummy|noreply/i;

/**
 * A value that is wholly a substitution marker rather than a secret: `<YOUR_API_KEY>`, `$TOKEN`,
 * `${TOKEN}`, `{{ token }}`, `%TOKEN%`. Anchored, so the marker has to BE the value — an angle
 * bracket merely appearing elsewhere on the line, as in any JSX element, excuses nothing.
 */
const TEMPLATE_VALUE = /^(?:<[^>]*>|\$\{[^}]*\}|\$[A-Za-z_][A-Za-z0-9_]*|\{\{[^}]*\}\}|%[^%]+%)$/;

/** True if the matched credential value is an obvious placeholder rather than a real secret. */
export function isPlaceholderValue(value) {
  return TEMPLATE_VALUE.test(value) || PLACEHOLDER_WORD.test(value);
}

/**
 * Every credential-shaped value on `line` that is not an obvious placeholder.
 *
 * @param {string} line
 * @returns {Array<{ pattern: string, value: string }>} one entry per suspect match.
 */
export function findSuspectValues(line) {
  const found = [];
  for (const { name, re, valueGroup } of SECRET_PATTERNS) {
    // `matchAll` iterates against an internal clone, so the shared regex's `lastIndex` is
    // never carried between lines.
    for (const match of line.matchAll(re)) {
      const value = valueGroup === undefined ? match[0] : match[valueGroup];
      if (value === undefined || isPlaceholderValue(value)) continue;
      found.push({ pattern: name, value });
    }
  }
  return found;
}

/** True if a line carries a credential-shaped value that is not an obvious placeholder. */
export function isSuspect(line) {
  return findSuspectValues(line).length > 0;
}

/**
 * Scan the added lines of a unified diff. `-U0` means no context lines, so every `+…` line
 * (other than the `+++ b/file` header) is genuinely new content.
 *
 * @param {string} diff
 * @returns {string[]} the trimmed text of each suspect added line.
 */
export function scanAddedLines(diff) {
  const hits = [];
  for (const raw of diff.split('\n')) {
    if (!raw.startsWith('+') || raw.startsWith('+++')) continue;
    const line = raw.slice(1);
    if (isSuspect(line)) hits.push(line.trim());
  }
  return hits;
}
