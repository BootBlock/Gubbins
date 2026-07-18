/**
 * Guards how `[[wiki links]]` are written inside `docs/wiki/` tables.
 *
 * GitHub renders the wiki with GFM, which splits table rows on unescaped `|` *before* wiki-link
 * syntax is resolved. So a `[[Label|Page-Name]]` in a table cell is torn in half at the pipe: the
 * row gains a phantom column and the link never resolves — it renders as literal `[[Label |
 * Page-Name]]` text. Inside a table the separator must therefore be escaped (`[[Label\|Page]]`);
 * everywhere else it must NOT be, or the backslash renders literally.
 *
 * That rule is conditional on context and invisible in the source, which is exactly why it drifted:
 * three pages shipped 31 broken links to the published wiki before anyone read the rendered output.
 * This test makes the drift a build failure, in the same spirit as the `docs/todo` status guard.
 *
 * Known limit: this guards the separator in `[[…]]` links only. A raw `|` reaching a table cell any
 * other way splits the row identically — note that a backtick code span is *not* protection, as GFM
 * splits inside code spans too. The corpus contains no such case today; if one appears, widen this
 * test rather than escaping it by hand at the call site.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { repoPath } from '../test/repo-path';

// Resolved from *this file's* checkout, never `process.cwd()` — see `repoPath`.
const WIKI_DIR = repoPath(import.meta.dirname, 'docs', 'wiki');

/** A `[[…]]` wiki link. Non-greedy so adjacent links on one line stay separate. */
const WIKI_LINK = /\[\[([^\]]*?)\]\]/g;

/**
 * A GFM delimiter row (`| --- | --- |`), with or without the leading pipe. Two columns are
 * required deliberately: a one-column pattern would also match a bare `---` thematic break, which
 * these pages use constantly, and every such rule would be reported as a stray table.
 */
const DELIMITER_ROW = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/;

/** A pipe not already escaped. */
const UNESCAPED_PIPE = /(?<!\\)\|/;

const pages = readdirSync(WIKI_DIR)
  .filter((f) => f.endsWith('.md'))
  .map((f) => ({ name: f, text: readFileSync(join(WIKI_DIR, f), 'utf8') }));

/** Strip any blockquote markers so a table nested in a `>` block classifies as a table. */
const unquote = (line: string) => line.replace(/^\s*(?:>\s?)+/, '');

/**
 * Split a page into table rows and everything else. Every table in the wiki uses a leading pipe,
 * which the delimiter-row check below asserts rather than assumes — so "line starts with `|`" is a
 * sound test for "is a table row".
 *
 * Fenced code blocks are skipped entirely: a fence may legitimately *show* either form as an
 * example (this rule is itself documented with a literal `[[Label\|Page-Name]]`), and asserting
 * against sample code would fail a page for documenting the convention correctly.
 */
function classify(text: string) {
  const tableRows: { line: string; n: number }[] = [];
  const proseLines: { line: string; n: number }[] = [];
  let inFence = false;
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = unquote(raw);
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      return;
    }
    if (inFence) return;
    (line.trim().startsWith('|') ? tableRows : proseLines).push({ line, n: i + 1 });
  });
  return { tableRows, proseLines };
}

/** Wiki links on a line, keeping only those that actually carry a `Label|Page` separator. */
function separatorLinks(line: string): string[] {
  return [...line.matchAll(WIKI_LINK)].map((m) => m[1]).filter((inner) => inner.includes('|'));
}

describe('docs/wiki table-cell wiki links', () => {
  it('finds the wiki pages at all (guards against a silently-empty sweep)', () => {
    expect(pages.length).toBeGreaterThan(50);
  });

  it('every table uses a leading pipe, so a leading `|` identifies a table row', () => {
    const offenders = pages.flatMap(({ name, text }) =>
      text
        .split(/\r?\n/)
        .map((line, i) => ({ line: unquote(line), n: i + 1 }))
        .filter(({ line }) => DELIMITER_ROW.test(line) && !line.trim().startsWith('|'))
        .map(({ n }) => `${name}:${n}`),
    );
    expect(
      offenders,
      'A table was written without a leading pipe on its delimiter row. This test identifies ' +
        'table rows by that leading pipe, so such a table would escape the checks below. Add ' +
        'the leading pipe, or teach this test to track table blocks properly.',
    ).toEqual([]);
  });

  it.each(pages)('$name escapes the separator in table-cell wiki links', ({ name, text }) => {
    const offenders = classify(text)
      .tableRows.flatMap(({ line, n }) =>
        separatorLinks(line)
          .filter((inner) => UNESCAPED_PIPE.test(inner))
          .map((inner) => `${name}:${n}  [[${inner}]]`),
      )
      .sort();
    expect(
      offenders,
      'Unescaped `|` inside a wiki link in a table cell. GFM splits the row at that pipe before ' +
        'resolving the link, so it renders as literal text and the row gains a phantom column. ' +
        'Write it as [[Label\\|Page-Name]] inside tables.',
    ).toEqual([]);
  });

  it.each(pages)('$name leaves the separator unescaped outside tables', ({ name, text }) => {
    const offenders = classify(text)
      .proseLines.flatMap(({ line, n }) =>
        separatorLinks(line)
          .filter((inner) => inner.includes('\\|'))
          .map((inner) => `${name}:${n}  [[${inner}]]`),
      )
      .sort();
    expect(
      offenders,
      'Escaped `\\|` inside a wiki link outside a table. There is no table cell to split here, ' +
        'so the backslash renders literally. Write it as [[Label|Page-Name]] in prose.',
    ).toEqual([]);
  });
});
