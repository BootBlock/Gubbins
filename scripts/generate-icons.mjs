// Generates the Gubbins app-icon set from a single source-of-truth glyph.
//
// The icon is a Gridfinity-style storage baseplate: a rounded rectangle hugging a 2×2 grid
// of bins, drawn as a rainbow-"sheen" stroke over a solid-black interior. The area outside
// the rounded rectangle is transparent. The glyph is composed once and rendered into every
// variant the PWA needs, so the favicon, manifest icons, maskable icon, and iOS
// apple-touch-icon can never drift apart.
//
// SVG is the master format; the PNG fallbacks (some platforms — notably iOS, which ignores
// manifest icons entirely — need raster) are rasterised with the Playwright Chromium engine
// already used by the browser-smoke test (falling back to a system Edge/Chrome channel), so
// this script adds no dependency.
//
//   node scripts/generate-icons.mjs
//
// Outputs into public/icons/: gubbins.svg, icon-192.png, icon-512.png,
// maskable-512.png, apple-touch-icon.png.

import { fileURLToPath } from 'node:url';
import { writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';

const OUT_DIR = fileURLToPath(new URL('../public/icons/', import.meta.url));

const round = (n) => Math.round(n * 100) / 100;

/** The rainbow "sheen" gradient, spanning the icon's bounding box so one continuous
 *  rainbow maps across the whole glyph. `userSpaceOnUse` is required because the bin
 *  strokes would otherwise collapse on their degenerate object bounding boxes. */
function sheenDef(box) {
  const a = box.x;
  const b = box.x + box.s;
  return `<linearGradient id="sheen" gradientUnits="userSpaceOnUse" x1="${a}" y1="${a}" x2="${b}" y2="${b}">
      <stop offset="0" stop-color="#ff8ba7" />
      <stop offset="0.18" stop-color="#ffb86b" />
      <stop offset="0.36" stop-color="#f6f08a" />
      <stop offset="0.54" stop-color="#7ee0a0" />
      <stop offset="0.72" stop-color="#6bc7ff" />
      <stop offset="0.88" stop-color="#9b9bff" />
      <stop offset="1" stop-color="#c79bff" />
    </linearGradient>`;
}

/** The Gridfinity baseplate glyph for a square bounding box `{ x, s }` (centred). The
 *  baseplate is filled solid black so the bins and the lines around them read as black;
 *  a tight inset keeps the rainbow border hugging the four bins. Strokes/insets scale
 *  with the box so the proportions are identical at every size. */
function glyph({ x, s }) {
  const baseStroke = round(s * 0.0625); // 26 at s=416
  const baseRx = round(s * 0.135); //  56 at s=416
  const inset = round(s * 0.12); //  50 at s=416
  const gap = round(s * 0.019); //   8 at s=416
  const pocketStroke = round(s * 0.048); //  20 at s=416
  const pocketRx = round(s * 0.053); //  22 at s=416

  const region = s - 2 * inset;
  const cell = round((region - gap) / 2);
  const p0 = round(x + inset);
  const p1 = round(p0 + cell + gap);

  const pockets = [
    [p0, p0],
    [p1, p0],
    [p0, p1],
    [p1, p1],
  ]
    .map(([px, py]) => `<rect x="${px}" y="${py}" width="${cell}" height="${cell}" rx="${pocketRx}" />`)
    .join('');

  return `
    <rect x="${x}" y="${x}" width="${s}" height="${s}" rx="${baseRx}" fill="#000000" />
    <g fill="none" stroke="url(#sheen)" stroke-linejoin="round" stroke-linecap="round">
      <rect x="${x}" y="${x}" width="${s}" height="${s}" rx="${baseRx}" stroke-width="${baseStroke}" />
      <g stroke-width="${pocketStroke}">${pockets}</g>
    </g>`;
}

/** Compose a full 512×512 icon document.
 *  - `any` icons fill the canvas (48→464) with transparency outside the rounded rect.
 *  - opaque icons (maskable/iOS) add a solid-black full-bleed backdrop and shrink the
 *    glyph into the maskable safe zone so platform masking can't clip the border. */
function iconSvg({ opaque }) {
  const box = opaque ? { x: 86, s: 340 } : { x: 48, s: 416 };
  const backdrop = opaque ? '<rect width="512" height="512" fill="#000000" />' : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512" role="img" aria-label="Gubbins">
  <defs>${sheenDef(box)}</defs>
  ${backdrop}${glyph(box)}
</svg>
`;
}

async function rasterise(browser, svg, size, opaque) {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  const sized = svg.replace('width="512" height="512" role', `width="${size}" height="${size}" role`);
  await page.setContent(
    `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;padding:0}</style>${sized}`,
  );
  const png = await page.screenshot({
    omitBackground: !opaque,
    clip: { x: 0, y: 0, width: size, height: size },
  });
  await page.close();
  return png;
}

/** Launch a Chromium engine, trying Playwright's bundled build first, then the
 *  common system channels (Edge, then Chrome). */
async function launchChromium() {
  const attempts = [{}, { channel: 'msedge' }, { channel: 'chrome' }];
  let lastErr;
  for (const opts of attempts) {
    try {
      return await chromium.launch(opts);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });

  const transparent = iconSvg({ opaque: false });
  const opaque = iconSvg({ opaque: true });

  // Master vector icon (favicon + manifest `any`) — transparent outside the rounded rect.
  await writeFile(resolve(OUT_DIR, 'gubbins.svg'), transparent, 'utf8');

  const browser = await launchChromium();
  try {
    const outputs = [
      ['icon-192.png', transparent, 192, false],
      ['icon-512.png', transparent, 512, false],
      ['maskable-512.png', opaque, 512, true],
      ['apple-touch-icon.png', opaque, 180, true],
    ];
    for (const [name, svg, size, isOpaque] of outputs) {
      const png = await rasterise(browser, svg, size, isOpaque);
      await writeFile(resolve(OUT_DIR, name), png);
      console.log(`  wrote ${name} (${size}×${size})`);
    }
  } finally {
    await browser.close();
  }
  console.log('Icon set generated in', OUT_DIR);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
