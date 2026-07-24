/**
 * Guards hover-revealed affordances against becoming unreachable by touch (issue #258).
 *
 * A control that is hidden until `group-hover:` brings it back has no way to appear on a phone
 * or tablet — there is no hover state to enter — and once it is also collapsed to zero width or
 * zero opacity there is not even a hit target left to tap. That is how "Print a label for this
 * location" and "Remove image" silently stopped existing on the hardware this app is most used
 * on, which no type-checker or component test would ever catch.
 *
 * The fix is the `touch:` variant (`@media (hover: none)`, defined in `src/styles/index.css`),
 * which pins the affordance open where hover can never fire. This scan makes forgetting it a
 * build failure rather than a review catch — the same posture as the storage-key registry and
 * `docs/todo/` banner guards.
 *
 * The rule is per *file*, not per class string: a `cn()` call routinely splits the hover state
 * and its touch counterpart across separate lines, so requiring them to sit adjacent would fail
 * on perfectly correct code. A file that reveals something on hover must mention the matching
 * `touch:` utility somewhere — close enough to catch the omission, loose enough not to dictate
 * how the classes are written.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Vitest runs from the project root; under happy-dom `import.meta.url` is an http: URL, not a
// file: one, so resolve against cwd (the same approach as the other source-scanning guards).
const SRC_DIR = resolve(process.cwd(), 'src');

/**
 * The utilities that make a hidden element *appear* (or reclaim its size) on hover. Styling that
 * merely decorates an already-visible control — a background tint, a colour, a cursor — is
 * deliberately not listed: losing it on touch costs the user nothing. Extend this only with
 * utilities whose absence hides a control or removes its hit target.
 */
const REVEAL_UTILITY = /group-hover:(opacity-100|visible|max-w-[^\s'"`]+)/g;

/**
 * Files whose hover reveal is genuinely decorative, so a touch counterpart would only add
 * permanent visual noise. Keep this short, and only for elements that are `aria-hidden` and
 * carry no action of their own — never for a control the user has to reach.
 */
const DECORATIVE_ALLOW_LIST: readonly string[] = [
  // An external-link glyph beside the dashboard's brand hero. It is aria-hidden decoration on a
  // link that stays fully tappable without it.
  'src/features/dashboard/DashboardScreen.tsx',
];

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx']);

/** Every non-test source file under `src/`, recursively. */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...sourceFiles(path));
    } else if (SOURCE_EXTENSIONS.has(extname(entry.name)) && !/\.test\.tsx?$/.test(entry.name)) {
      out.push(path);
    }
  }
  return out;
}

/**
 * Every file that reveals something on hover, mapped to the `touch:` utilities it is missing.
 * An allow-listed file is scanned (so the staleness check below still sees it) but never
 * reported as missing anything.
 */
function scanReveals(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const path of sourceFiles(SRC_DIR)) {
    const text = readFileSync(path, 'utf8');
    const utilities = new Set([...text.matchAll(REVEAL_UTILITY)].map((match) => match[1]));
    if (utilities.size === 0) continue;
    const file = relative(process.cwd(), path).replaceAll('\\', '/');
    const missing = [...utilities].filter((utility) => !text.includes(`touch:${utility}`));
    found.set(file, DECORATIVE_ALLOW_LIST.includes(file) ? [] : missing);
  }
  return found;
}

const scanned = scanReveals();

describe('hover-revealed affordances stay reachable by touch', () => {
  it('finds hover reveals at all (guards against a silently-empty sweep)', () => {
    expect(scanned.size).toBeGreaterThan(0);
  });

  it('pairs every hover-revealed control with its `touch:` counterpart', () => {
    const missing = [...scanned].flatMap(([file, utilities]) =>
      utilities.map((utility) => `${file} → touch:${utility}`),
    );
    expect(
      missing,
      'These controls only appear on hover, so they are invisible — and, when the hover state ' +
        'also restores their size, untappable — on a touch device. Add the matching `touch:` ' +
        'utility (see the variant in src/styles/index.css), or add the file to ' +
        'DECORATIVE_ALLOW_LIST if the reveal is aria-hidden decoration rather than a control.',
    ).toEqual([]);
  });

  it('does not allow-list a file that no longer reveals anything on hover', () => {
    const stale = DECORATIVE_ALLOW_LIST.filter((file) => !scanned.has(file));
    expect(stale, 'Remove these from DECORATIVE_ALLOW_LIST — they have no hover reveal left.').toEqual([]);
  });
});
