/**
 * Wiki screenshot generator (issue #39).
 *
 * Drives the preinstalled Edge via Playwright against a running dev server
 * (http://localhost:5173/Gubbins/ by default — a real cross-origin-isolated OPFS
 * context, same as `scripts/browser-smoke.mjs`), seeds a small set of **synthetic**
 * demo data (invented items/locations — no real people or data, public-repo hygiene),
 * and captures **cropped** screenshots of the documented surfaces into
 * `docs/wiki/images/`. Re-run it to regenerate the images as the UI evolves.
 *
 * Usage: start the dev server (`npm run dev`), then `node scripts/wiki-screenshots.mjs`.
 * Each shot is independent — one failing capture logs and is skipped, it never aborts
 * the run — so a partial UI change still refreshes every other image.
 */
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdir } from 'node:fs/promises';

const BASE = process.env.WIKI_BASE ?? 'http://localhost:5173/Gubbins/';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'docs', 'wiki', 'images');

// A fixed, generous window so panels aren't clipped and layout is deterministic.
const VIEWPORT = { width: 1440, height: 960 };

let captured = 0;
let failed = 0;

const browser = await chromium.launch({ channel: 'msedge' });
const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 2 });
const page = await context.newPage();
page.setDefaultTimeout(12000);
page.setDefaultNavigationTimeout(20000);

/** Choose an option from a Foundry `role="combobox"` Select by its visible label. */
async function chooseOption(combo, name, { exact = true } = {}) {
  await combo.click();
  await page.getByRole('option', { name, exact }).click();
}

/** Capture a single cropped shot of `locator` (or the viewport when omitted); tolerant. */
async function shot(name, locator, opts = {}) {
  const path = join(OUT, `${name}.png`);
  try {
    if (locator) {
      await locator.waitFor({ state: 'visible', timeout: 8000 });
      await page.waitForTimeout(opts.settle ?? 350);
      await locator.screenshot({ path });
    } else {
      await page.waitForTimeout(opts.settle ?? 350);
      await page.screenshot({ path, clip: opts.clip });
    }
    captured += 1;
    console.log(`  ✓ ${name}.png`);
  } catch (err) {
    failed += 1;
    console.warn(`  ✗ ${name}.png — ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function gotoInventory() {
  await page.goto(`${BASE}inventory`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Add item' }).waitFor({ state: 'visible', timeout: 15000 });
}

// ── Boot + dismiss the first-run module chooser ──────────────────────────────
await mkdir(OUT, { recursive: true });
await gotoInventory();
const skip = page.getByTestId('first-run-skip');
if (await skip.isVisible().catch(() => false)) {
  await skip.click();
  await skip.waitFor({ state: 'hidden', timeout: 5000 });
}

// ── Seed synthetic demo data (idempotent-ish: created once per fresh profile) ─
async function addBulkItem(name, qty) {
  await page.getByRole('button', { name: 'Add item' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add item' });
  await dialog.getByLabel('Name').fill(name);
  await chooseOption(dialog.getByLabel('Tracking'), 'Bulk');
  await dialog.getByLabel('Initial quantity').fill(String(qty));
  await dialog.getByRole('button', { name: 'Create item' }).click();
  await dialog.waitFor({ state: 'hidden', timeout: 8000 });
  await page.getByText(name).first().waitFor({ state: 'visible', timeout: 8000 });
}

async function addDiscreteItem(name) {
  await page.getByRole('button', { name: 'Add item' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add item' });
  await dialog.getByLabel('Name').fill(name);
  // Tracking defaults to DISCRETE ("Bulk"-labelled family); leave it as-is for a plain unit.
  await dialog.getByRole('button', { name: 'Create item' }).click();
  await dialog.waitFor({ state: 'hidden', timeout: 8000 });
  await page.getByText(name).first().waitFor({ state: 'visible', timeout: 8000 });
}

async function addGaugeItem(name) {
  await page.getByRole('button', { name: 'Add item' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add item' });
  await dialog.getByLabel('Name').fill(name);
  await chooseOption(dialog.getByLabel('Tracking'), 'Consumable');
  await dialog.getByLabel('Unit', { exact: true }).fill('g');
  await dialog.getByLabel('Full capacity').fill('1000');
  await dialog.getByLabel('Tare (empty)').fill('250');
  await dialog.getByRole('button', { name: 'Create item' }).click();
  await dialog.waitFor({ state: 'hidden', timeout: 8000 });
  await page.getByText(name).first().waitFor({ state: 'visible', timeout: 8000 });
}

async function addLocation(name, { description, colour, parent } = {}) {
  await page.getByRole('button', { name: 'Add location' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add location' });
  await dialog.getByLabel('Name').fill(name);
  if (description) await dialog.getByLabel('Description (optional)').fill(description);
  if (colour) await dialog.getByRole('radio', { name: colour }).click();
  if (parent) {
    await dialog.getByRole('combobox', { name: 'Parent (optional)' }).click();
    await page.getByRole('option', { name: parent }).click();
  }
  await dialog.getByRole('button', { name: 'Create' }).click();
  await dialog.waitFor({ state: 'hidden', timeout: 8000 });
  await page.getByText(name).first().waitFor({ state: 'visible', timeout: 8000 });
}

// Only seed if the inventory looks empty (a fresh profile). Re-runs against an already
// seeded profile skip straight to capture.
const alreadySeeded = await page
  .getByText('M3 × 10 Socket Screws')
  .isVisible()
  .catch(() => false);

if (!alreadySeeded) {
  console.log('Seeding synthetic demo data…');
  await addLocation('Garage', { description: 'Main workshop and storage', colour: 'Teal' });
  await addLocation('Workshop Shelf A', { parent: 'Garage' });
  await addLocation('Kitchen', { description: 'Household consumables', colour: 'Amber' });
  await addBulkItem('M3 × 10 Socket Screws', 250);
  await addBulkItem('USB-C Cable 1m', 12);
  await addDiscreteItem('Raspberry Pi 5 (8GB)');
  await addDiscreteItem('Cordless Drill');
  await addGaugeItem('PLA Filament — Galaxy Black');
}

// ── Captures ─────────────────────────────────────────────────────────────────
console.log('Capturing screenshots…');

// Dashboard overview.
await page.goto(`${BASE}`, { waitUntil: 'domcontentloaded' });
await shot('dashboard', page.locator('#main-content'), { settle: 800 });

// Inventory workspace (location tree + item list).
await gotoInventory();
await shot('inventory-workspace', page.locator('#main-content'), { settle: 600 });

// The location tree on its own.
await shot('locations-tree', page.getByRole('tree', { name: 'Locations' }));

// A single item card (crop). The card root Surface carries the `select-none` class.
const firstCard = page
  .locator('#main-content')
  .getByRole('heading', { name: 'M3 × 10 Socket Screws' })
  .locator('xpath=ancestor::div[contains(@class,"select-none")][1]');
await shot('item-card', firstCard.first());

// The Add-item dialog.
await gotoInventory();
await page.getByRole('button', { name: 'Add item' }).click();
await shot('add-item-dialog', page.getByRole('dialog', { name: 'Add item' }));
await page.keyboard.press('Escape').catch(() => {});

// ── Search ───────────────────────────────────────────────────────────────────
// Quick search: type a term and capture the top of the screen — the header, the search box
// with the query, and the matching result. A clipped viewport region reads far better than
// the full-height list panel (which is mostly empty when a query narrows to a few results).
await gotoInventory();
await page.getByLabel('Search items').fill('screw');
await page.waitForTimeout(600);
// Start a little below the top so the transient storage-permission banner isn't half-caught.
await shot('search-quick', null, { settle: 400, clip: { x: 0, y: 48, width: VIEWPORT.width, height: 540 } });
await page.getByLabel('Search items').fill('');

// Visual builder: open it from the More menu and capture the panel (its NL box, text-query
// box and the graphical condition group are all in one Surface headed "Visual search").
// The menu row is a checkbox item (it toggles the panel), so it has the menuitemcheckbox role.
try {
  await page.getByRole('button', { name: 'More inventory actions' }).click();
  await page.getByRole('menuitemcheckbox', { name: 'Visual search' }).click();
  const builder = page
    .getByRole('heading', { name: 'Visual search' })
    .locator('xpath=ancestor::div[contains(@class,"space-y-3")][1]');
  await shot('search-visual-builder', builder.first(), { settle: 500 });
} catch (err) {
  failed += 1;
  console.warn(`  ✗ search-visual-builder.png — ${err instanceof Error ? err.message : String(err)}`);
}

// ── Inventory detail & views ─────────────────────────────────────────────────
// A consumable item's card, to show the gauge (crop of the PLA filament card).
await gotoInventory();
const gaugeCard = page
  .locator('#main-content')
  .getByRole('heading', { name: 'PLA Filament — Galaxy Black' })
  .locator('xpath=ancestor::div[contains(@class,"select-none")][1]');
await shot('item-card-gauge', gaugeCard.first());

// The tabbed item-detail dialog (reused across many feature pages): open a card's More menu
// and choose "Edit details…".
try {
  const drillCard = page
    .locator('#main-content')
    .getByRole('heading', { name: 'Cordless Drill' })
    .locator('xpath=ancestor::div[contains(@class,"select-none")][1]');
  await drillCard.first().getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name: 'Edit details' }).click();
  await shot('item-detail', page.getByRole('dialog').first(), { settle: 600 });
  await page.keyboard.press('Escape').catch(() => {});
} catch (err) {
  failed += 1;
  console.warn(`  ✗ item-detail.png — ${err instanceof Error ? err.message : String(err)}`);
}

// The Table (spreadsheet) view — More → View → Table.
try {
  await gotoInventory();
  await page.getByRole('button', { name: 'More inventory actions' }).click();
  await page.getByRole('menuitem', { name: /^View:/ }).click();
  await page.getByRole('menuitemradio', { name: 'Table' }).click();
  await page.waitForTimeout(500);
  await shot('inventory-table', null, {
    settle: 400,
    clip: { x: 0, y: 48, width: VIEWPORT.width, height: 620 },
  });
  // Restore Card view for any later shots.
  await page.getByRole('button', { name: 'More inventory actions' }).click();
  await page.getByRole('menuitem', { name: /^View:/ }).click();
  await page.getByRole('menuitemradio', { name: 'Card' }).click();
} catch (err) {
  failed += 1;
  console.warn(`  ✗ inventory-table.png — ${err instanceof Error ? err.message : String(err)}`);
}

// The Modules manager (populated purely from the feature registry — no seed data needed).
try {
  await page.goto(`${BASE}modules`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(700);
  await shot('modules', page.locator('#main-content'), { settle: 400 });
} catch (err) {
  failed += 1;
  console.warn(`  ✗ modules.png — ${err instanceof Error ? err.message : String(err)}`);
}

// Settings → Appearance (light, then dark).
await page.goto(`${BASE}settings`, { waitUntil: 'domcontentloaded' });
await page.getByRole('heading', { name: 'Settings' }).waitFor({ state: 'visible', timeout: 8000 });
await page.getByRole('tab', { name: 'Appearance' }).click();

// Force Light, capture; then Dark, capture — so the pair genuinely contrasts the themes
// (the app's default is Dark, so an untoggled shot would be dark twice). After each click
// move the pointer off the control so its hover tooltip doesn't obscure the panel.
await page
  .locator('[data-testid="mode-light"]')
  .click()
  .catch(() => {});
await page.mouse.move(10, 10);
await page.waitForTimeout(700);
await shot('settings-appearance', page.getByRole('dialog').first(), { settle: 500 });

await page
  .locator('[data-testid="mode-dark"]')
  .click()
  .catch(() => {});
await page.mouse.move(10, 10);
await page.waitForTimeout(700);
await shot('settings-appearance-dark', page.getByRole('dialog').first(), { settle: 500 });
// Leave the app on its default Dark theme for any later shots.

console.log(`\nDone: ${captured} captured, ${failed} failed. → ${OUT}`);
await browser.close();
process.exit(failed > 0 ? 1 : 0);
