/**
 * Integrity check for the staged wiki under `docs/wiki/`.
 *
 * A GitHub wiki resolves `[[Label|Page-Name]]` links and `images/…` paths only once it is
 * published, so a typo in either renders as a dead link or a broken image on the live site
 * while looking perfectly fine in the source. This is the same class of bug as the unescaped
 * table separator: invisible in markdown, obvious to a reader.
 *
 * Run it before publishing (the publish workflow gates on it) or any time:
 *
 *   node scripts/wiki-check.mjs
 *
 * Checks, all of which are things only the *set* of pages can answer — a single-file linter
 * cannot:
 *   1. every `[[…]]` link points at a page that exists (GitHub matches on the filename);
 *   2. every referenced image exists on disk;
 *   3. no image is orphaned (present but referenced by nothing) — these are published and
 *      never seen, and usually mean a page was edited to drop the image. Reported as a
 *      *warning* only: it is cosmetic, and failing on it would block a publish and leave
 *      readers on stale docs;
 *   4. `_Sidebar.md` links resolve, since a broken entry there is on every page.
 *
 * Escaping of the `|` separator inside table cells is deliberately NOT checked here — that is
 * already guarded by `src/lib/wiki-table-links.test.ts` in the unit suite, and one rule with
 * one owner is the point.
 *
 * Exits non-zero and prints every problem (not just the first) so one run gives the full list.
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const WIKI_DIR = join(scriptDir, '..', 'docs', 'wiki');
const IMAGES_DIR = join(WIKI_DIR, 'images');

/** A `[[…]]` wiki link. Non-greedy so adjacent links on one line stay separate. */
const WIKI_LINK = /\[\[([^\]]*?)\]\]/g;
/**
 * A markdown image: `![alt](path)`. The alt text is matched lazily rather than as "anything but
 * `]`", so alt text that itself contains brackets (`![The dialog [beta]](images/x.png)`) still
 * matches — otherwise such an image would be skipped silently, which is the exact failure mode
 * this script exists to remove.
 */
const IMAGE = /!\[[^\n]*?\]\(([^)\s]+)/g;

/**
 * The page a `[[…]]` link targets. `[[Label|Page]]` (escaped as `Label\|Page` inside a table)
 * points at `Page`; a bare `[[Page]]` points at itself.
 *
 * A trailing `#section` is stripped: `[[Label|Page#heading]]` is a legitimate deep link, and
 * treating the fragment as part of the filename would report a working link as broken — which,
 * since this check gates publishing, would block the whole wiki over a false positive.
 */
function linkTarget(inner) {
  const parts = inner.split(/\\?\|/);
  const target = (parts.length > 1 ? parts[parts.length - 1] : parts[0]).trim();
  return target.split('#')[0].trim();
}

const problems = [];
const report = (page, line, message) => problems.push(`${page}:${line}  ${message}`);

if (!existsSync(WIKI_DIR)) {
  console.error(`wiki-check: ${WIKI_DIR} does not exist.`);
  process.exit(1);
}

const pages = readdirSync(WIKI_DIR).filter((f) => f.endsWith('.md'));
// GitHub resolves a wiki link against the page's filename, so that — not the heading — is the
// set of valid targets. `_Sidebar` / `_Footer` are real pages too.
const pageNames = new Set(pages.map((f) => basename(f, '.md')));
const imagesOnDisk = existsSync(IMAGES_DIR) ? new Set(readdirSync(IMAGES_DIR)) : new Set();
const imagesReferenced = new Set();

for (const page of pages) {
  const lines = readFileSync(join(WIKI_DIR, page), 'utf8').split(/\r?\n/);

  lines.forEach((text, i) => {
    const lineNo = i + 1;

    for (const [, inner] of text.matchAll(WIKI_LINK)) {
      const target = linkTarget(inner);
      // An anchor-only or external target is not a page reference.
      if (!target || target.startsWith('#') || /^https?:/.test(target)) continue;
      if (!pageNames.has(target)) {
        report(page, lineNo, `[[…]] link points at a page that does not exist: "${target}"`);
      }
    }

    for (const [, path] of text.matchAll(IMAGE)) {
      if (/^https?:/.test(path)) continue;
      const file = basename(path);
      imagesReferenced.add(file);
      if (!path.startsWith('images/')) {
        report(page, lineNo, `image path should be relative to "images/": "${path}"`);
      } else if (!imagesOnDisk.has(file)) {
        report(page, lineNo, `image referenced but missing from docs/wiki/images/: "${file}"`);
      }
    }
  });
}

// Orphans are reported but do NOT fail: an unreferenced image wastes a few KB, whereas failing
// here would block the publish and leave readers on stale docs over something cosmetic. Broken
// links and missing images are the opposite — they are visibly wrong, so they do fail.
const orphans = [...imagesOnDisk].filter((f) => !imagesReferenced.has(f)).sort();

const summary = `${pages.length} pages, ${imagesOnDisk.size} images`;

if (orphans.length > 0) {
  console.warn(`wiki-check: ${orphans.length} orphaned image(s), referenced by no page:`);
  for (const f of orphans) console.warn(`  images/${f}`);
  console.warn('These publish but are never seen — delete them, or reference them from a page.\n');
}

if (problems.length > 0) {
  console.error(`wiki-check: ${problems.length} problem(s) found across ${summary}:\n`);
  for (const p of problems) console.error(`  ${p}`);
  console.error('\nFix these before publishing — each one is a dead link or broken image for readers.');
  process.exit(1);
}

console.log(`wiki-check: OK — ${summary}, all links and images resolve.`);
