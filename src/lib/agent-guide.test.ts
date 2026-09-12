/**
 * Keeps the agent guide small: `CLAUDE.md` within its budgets, and `AGENTS.md` a pointer to it.
 *
 * `CLAUDE.md` is loaded into every agent session, so its size is a cost on every task. It grew to
 * about 30 KB one reasonable-looking addition at a time — each rule arrived with its recipe, its root
 * cause and its incident history — until detail that matters to one kind of change crowded out the
 * rules that matter to all of them. It was cut back to the rules, with the detail moved to notes the
 * file names. These budgets stop that growth returning: a new rule has to fit, which means shortening
 * or moving something rather than appending. Raising a budget is the maintainer's decision, not a way
 * to make a change pass.
 *
 * `AGENTS.md` used to reproduce some rules and index the rest, which took a parity test to hold the
 * two copies together — and the index still fell a month behind once. With no copy there is nothing
 * to drift, so this test guards only against a copy coming back.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { repoPath } from '../test/repo-path';

// Resolved from *this file's* checkout, never `process.cwd()` — see `repoPath`.
const REPO_ROOT = repoPath(import.meta.dirname);
const read = (name: string) => readFileSync(join(REPO_ROOT, name), 'utf8');

const CLAUDE = read('CLAUDE.md');
const AGENTS = read('AGENTS.md');

/** Character budgets. `CLAUDE.md` states these numbers too, and the last `CLAUDE.md` test holds it to them. */
const BUDGET = { claudeFile: 10_000, claudeSection: 1_500, agentsFile: 600 };

const HOW_TO_FIX =
  'Move detail that applies to one kind of change into a memory note, and name the note from a ' +
  'short rule. Do not raise the budget without asking the maintainer.';

/** `10000` → `10,000`, as the budgets are written in `CLAUDE.md`'s prose. */
const grouped = (n: number) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/** Each `##` section, from its heading up to the next one. Content above the first is not a section. */
function sections(markdown: string): { title: string; length: number }[] {
  return markdown
    .split(/^(?=## )/m)
    .filter((chunk) => chunk.startsWith('## '))
    .map((chunk) => ({ title: chunk.slice(3, chunk.indexOf('\n')).trim(), length: chunk.length }));
}

describe('CLAUDE.md stays within its budgets', () => {
  it('finds the sections at all (guards against a silently-empty sweep)', () => {
    expect(sections(CLAUDE).length).toBeGreaterThan(5);
  });

  it('the whole file', () => {
    expect(
      CLAUDE.length,
      `CLAUDE.md is ${CLAUDE.length} characters, over its ${BUDGET.claudeFile} budget. ${HOW_TO_FIX}`,
    ).toBeLessThanOrEqual(BUDGET.claudeFile);
  });

  it.each(sections(CLAUDE))('section $title', ({ title, length }) => {
    expect(
      length,
      `CLAUDE.md's "${title}" is ${length} characters, over the ${BUDGET.claudeSection} section budget. ${HOW_TO_FIX}`,
    ).toBeLessThanOrEqual(BUDGET.claudeSection);
  });

  it('states the budgets this test enforces', () => {
    for (const budget of Object.values(BUDGET)) expect(CLAUDE).toContain(grouped(budget));
  });
});

describe('AGENTS.md defers to CLAUDE.md', () => {
  it('links CLAUDE.md, which exists', () => {
    expect(AGENTS).toContain('](CLAUDE.md)');
    expect(existsSync(join(REPO_ROOT, 'CLAUDE.md'))).toBe(true);
  });

  it('states no rule sections of its own', () => {
    const headings = AGENTS.split('\n').filter((line) => /^#{2,} /.test(line));
    expect(headings, 'AGENTS.md is a pointer. Put the rule in CLAUDE.md instead.').toEqual([]);
  });

  it('stays within its budget', () => {
    expect(
      AGENTS.length,
      `AGENTS.md is ${AGENTS.length} characters, over its ${BUDGET.agentsFile} budget. It is a pointer: put the rule in CLAUDE.md instead.`,
    ).toBeLessThanOrEqual(BUDGET.agentsFile);
  });
});
