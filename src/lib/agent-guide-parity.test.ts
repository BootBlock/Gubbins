/**
 * Guards the contract between `AGENTS.md` and `CLAUDE.md`.
 *
 * `CLAUDE.md` is the source of truth for how this repo is worked on; `AGENTS.md` is the
 * cross-agent entry point that points at it. `AGENTS.md` is deliberately *not* a copy — it
 * reproduces in full only the rules whose cost of being missed is unrecoverable, and links the
 * rest from an index. That design only holds while the index is complete.
 *
 * It stopped holding once already: `CLAUDE.md` gained three sections marked `(mandatory)` —
 * worktrees, GitHub attribution and wiki parity — across sixteen commits, and `AGENTS.md` was
 * never told. An agent reading only the entry point could not have known those rules existed.
 * The failure was silent because nothing compares the two files, so this test does:
 *
 * 1. Every `##` section of `CLAUDE.md` is either reproduced on the `AGENTS.md` page or linked
 *    from its index — a new rule cannot land without `AGENTS.md` acknowledging it.
 * 2. The sections `AGENTS.md` claims to reproduce word-for-word actually match, so the two
 *    copies cannot drift into saying different things.
 * 3. The prose counts on the page match reality. This is the other bug that happened: the intro
 *    said "the two rules below" long after a third had been added underneath it.
 *
 * What it deliberately does not assert: whether a rule is *good*, whether the right rules were
 * chosen for full reproduction, or whether an adapted summary is faithful. Those are human
 * calls — this only enforces that the entry point cannot silently fall behind.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { repoPath } from '../test/repo-path';

// Resolved from *this file's* checkout, never `process.cwd()` — see `repoPath`.
const REPO_ROOT = repoPath(import.meta.dirname);
const read = (name: string) => readFileSync(join(REPO_ROOT, name), 'utf8');

const CLAUDE = read('CLAUDE.md');
const AGENTS = read('AGENTS.md');

/**
 * GitHub's heading-anchor rules, as far as this repo's headings exercise them: lower-case, drop
 * anything that is not a word character, whitespace or hyphen (punctuation *and* emoji), then
 * turn each remaining space into a hyphen.
 *
 * Runs of spaces are **not** collapsed — `## Controls & spacing: …` loses the `&` and keeps both
 * surrounding spaces, so its real anchor contains a double hyphen. Collapsing here would compute
 * an anchor GitHub never generates and pass a link that is actually broken.
 */
function slug(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[^\w\s-]/gu, '')
    .replace(/\s/g, '-');
}

interface Section {
  /** Heading text with the `## ` marker stripped, e.g. `Public-repository hygiene (mandatory)`. */
  title: string;
  /** The GitHub anchor the heading generates, with any leading hyphens (from a leading emoji) removed. */
  anchor: string;
  /** Everything below the heading, up to the next `##`. */
  body: string;
}

/** Splits a document into its `##` sections. Content above the first one is not a section. */
function sections(markdown: string): Section[] {
  const found: Section[] = [];
  let current: { title: string; lines: string[] } | undefined;

  for (const line of markdown.split('\n')) {
    const heading = /^## (.+)$/.exec(line);
    if (heading) {
      if (current) found.push(toSection(current));
      current = { title: heading[1].trim(), lines: [] };
    } else if (current) {
      current.lines.push(line);
    }
  }
  if (current) found.push(toSection(current));
  return found;
}

function toSection({ title, lines }: { title: string; lines: string[] }): Section {
  // A leading emoji slugs to a leading hyphen (`## 🔒 No secrets` → `-no-secrets`). Trimming it
  // lets an AGENTS.md section be matched against the CLAUDE.md one it reproduces, whose heading
  // carries no emoji.
  return { title, anchor: slug(title).replace(/^-+/, ''), body: lines.join('\n').trim() };
}

const claudeSections = sections(CLAUDE);
const agentsSections = sections(AGENTS);

/**
 * The `CLAUDE.md` sections `AGENTS.md` puts on the page instead of only linking, and how
 * faithfully.
 *
 * - `verbatim` — the text is duplicated word-for-word and is asserted to stay that way.
 * - `adapted` — deliberately condensed or reworded for the entry point (the worktree rule drops
 *   the sub-agent guidance; attribution drops the per-verb detail), so only its presence is
 *   asserted, not its wording.
 *
 * Adding an entry here is a deliberate act: it says "this rule is important enough that an agent
 * must not have to follow a link to find it". Everything else is linked from the index.
 */
const REPRODUCED: Record<string, 'verbatim' | 'adapted'> = {
  'no-secrets-in-the-repository-mandatory': 'verbatim',
  'public-repository-hygiene-mandatory': 'verbatim',
  'every-task-runs-in-a-worktree-and-parallelises-with-sub-agents-mandatory': 'adapted',
  'agent-attribution-on-github-content-mandatory': 'adapted',
};

/** Spelled-out counts used in the page's prose, so a stale number fails rather than misleads. */
const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight'];

describe('AGENTS.md tracks CLAUDE.md', () => {
  it('finds the sections at all (guards against a silently-empty sweep)', () => {
    expect(claudeSections.length).toBeGreaterThan(5);
    expect(agentsSections.length).toBeGreaterThan(2);
  });

  it.each(claudeSections)(
    '$title is reproduced on the AGENTS.md page or linked from it',
    ({ title, anchor }) => {
      const linked = AGENTS.includes(`CLAUDE.md#${anchor}`);
      const reproduced = anchor in REPRODUCED;
      expect(
        linked || reproduced,
        `CLAUDE.md's "${title}" is invisible to an agent reading only AGENTS.md.\n` +
          `Add a row to the "Mandatory rules" table in AGENTS.md linking ` +
          `[CLAUDE.md](CLAUDE.md#${anchor}) — or, if it is important enough that an agent must ` +
          `not have to follow a link, reproduce it on the page and add "${anchor}" to ` +
          `REPRODUCED in this test.`,
      ).toBe(true);
    },
  );

  it('the rules index has exactly one row per CLAUDE.md section', () => {
    // Table rows only: the header and its `| --- |` separator are not rules, and no other table
    // appears in AGENTS.md.
    const rows = AGENTS.split('\n').filter((line) => line.startsWith('|') && !/^\|\s*(Rule\b|-)/.test(line));
    expect(
      rows.length,
      `The AGENTS.md rules index lists ${rows.length} rules but CLAUDE.md has ` +
        `${claudeSections.length} sections. Every section needs exactly one row.`,
    ).toBe(claudeSections.length);
  });

  const verbatim = Object.entries(REPRODUCED)
    .filter(([, fidelity]) => fidelity === 'verbatim')
    .map(([anchor]) => ({ anchor }));

  it.each(verbatim)('$anchor is reproduced word-for-word', ({ anchor }) => {
    const source = claudeSections.find((s) => s.anchor === anchor);
    const copy = agentsSections.find((s) => s.anchor === anchor);
    expect(source, `no CLAUDE.md section anchors to "${anchor}"`).toBeDefined();
    expect(copy, `no AGENTS.md section anchors to "${anchor}"`).toBeDefined();
    expect(
      copy?.body,
      `AGENTS.md's copy of "${anchor}" has drifted from CLAUDE.md. CLAUDE.md is the source of ` +
        `truth — copy its version across verbatim, or mark this rule 'adapted' in REPRODUCED if ` +
        `the entry point is meant to summarise it.`,
    ).toBe(source?.body);
  });

  it('every reproduced anchor names a real CLAUDE.md section', () => {
    const real = new Set(claudeSections.map((s) => s.anchor));
    const stale = Object.keys(REPRODUCED).filter((anchor) => !real.has(anchor));
    expect(
      stale,
      `REPRODUCED names ${stale.join(', ')}, which no longer exists in CLAUDE.md — a renamed ` +
        `heading leaves this map pointing at nothing, and the coverage check above would then ` +
        `pass a rule that AGENTS.md does not actually cover.`,
    ).toEqual([]);
  });

  it('the page says how many rules it spells out, and the number is right', () => {
    const claim = /The first (\w+) are spelled out/.exec(AGENTS);
    expect(claim, 'AGENTS.md no longer states how many rules it spells out').not.toBeNull();
    expect(
      claim && NUMBER_WORDS.indexOf(claim[1].toLowerCase()),
      `AGENTS.md says it spells out "${claim?.[1]}" rules, but ` +
        `${Object.keys(REPRODUCED).length} are reproduced on the page.`,
    ).toBe(Object.keys(REPRODUCED).length);
  });
});
