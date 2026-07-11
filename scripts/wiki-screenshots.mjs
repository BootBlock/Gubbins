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
