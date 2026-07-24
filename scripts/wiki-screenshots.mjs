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

/**
 * Set the shared items-per-page preference from Settings.
 *
 * Settings is a rail *dialog*, not a page: the control only mounts once its own rail tab is
 * selected, so the tab click is load-bearing rather than incidental.
 */
async function setPageSize(size) {
  await page.goto(`${BASE}settings`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: 'Settings' }).waitFor({ state: 'visible', timeout: 8000 });
  await page.getByRole('tab', { name: 'Inventory' }).click();
  const input = page.locator('[data-testid="setting-page-size"]');
  await input.waitFor({ state: 'visible', timeout: 8000 });
  await input.fill(size);
  await input.blur();
  await page.keyboard.press('Escape').catch(() => {});
}

async function gotoInventory() {
  await page.goto(`${BASE}inventory`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Add item' }).waitFor({ state: 'visible', timeout: 15000 });
}

/**
 * Dismiss the first-run module chooser if it is showing.
 *
 * It *waits* for the dialog rather than testing `isVisible()` once: on a fast machine the app
 * reaches "Add item" before the chooser mounts, so a single probe misses it and the overlay
 * then swallows every subsequent click. Signing in remounts the router, which can re-offer it,
 * so this is called again there rather than only at boot.
 */
async function dismissFirstRun(timeout = 6000) {
  const skip = page.getByTestId('first-run-skip');
  try {
    await skip.waitFor({ state: 'visible', timeout });
  } catch {
    return; // Not offered (already dismissed for this profile) — nothing to do.
  }
  // Past this point the chooser *is* up, so a failure here is real: its overlay swallows every
  // later click, and staying quiet would surface as a baffling timeout on an unrelated locator.
  await skip.click();
  await skip.waitFor({ state: 'hidden', timeout: 5000 });
}

// ── Boot + dismiss the first-run module chooser ──────────────────────────────
await mkdir(OUT, { recursive: true });
await gotoInventory();
await dismissFirstRun();

// ── Seed synthetic demo data (idempotent-ish: created once per fresh profile) ─
// A unit cost gives the valuation/spend reports something to show.
async function addBulkItem(name, qty, cost) {
  await page.getByRole('button', { name: 'Add item' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add item' });
  await dialog.getByLabel('Name').fill(name);
  await chooseOption(dialog.getByLabel('Tracking'), 'Bulk');
  await dialog.getByLabel('Initial quantity').fill(String(qty));
  if (cost) await dialog.getByLabel('Unit cost (optional)').fill(String(cost));
  await dialog.getByRole('button', { name: 'Create item' }).click();
  await dialog.waitFor({ state: 'hidden', timeout: 8000 });
  await page.getByText(name).first().waitFor({ state: 'visible', timeout: 8000 });
}

async function addDiscreteItem(name, cost, { category, location } = {}) {
  await page.getByRole('button', { name: 'Add item' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add item' });
  await dialog.getByLabel('Name').fill(name);
  // Tracking defaults to DISCRETE ("Bulk"-labelled family); leave it as-is for a plain unit.
  if (cost) await dialog.getByLabel('Unit cost (optional)').fill(String(cost));
  // A category is what gives the item a custom-field schema, and the location is what it
  // inherits values *from* — both are needed for the inheritance shots.
  // Not exact: both option lists render a `meta` suffix (an item count) inside the option, so
  // its accessible name is "<name> <n> items", not the bare name.
  if (category) await chooseOption(dialog.getByLabel('Category (optional)'), category, { exact: false });
  if (location) {
    await chooseOption(dialog.getByRole('combobox', { name: 'Location' }), location, { exact: false });
  }
  await dialog.getByRole('button', { name: 'Create item' }).click();
  await dialog.waitFor({ state: 'hidden', timeout: 8000 });
  await page.getByText(name).first().waitFor({ state: 'visible', timeout: 8000 });
}

async function addContact(name) {
  await page.goto(`${BASE}contacts`, { waitUntil: 'domcontentloaded' });
  const input = page.getByPlaceholder('Add a contact…');
  await input.waitFor({ state: 'visible', timeout: 10000 });
  await input.fill(name);
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await page.getByText(name).first().waitFor({ state: 'visible', timeout: 8000 });
}

async function addProject(name) {
  await page.goto(`${BASE}projects`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'New project' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Name').fill(name);
  await dialog.getByRole('button', { name: 'Create project' }).click();
  await dialog.waitFor({ state: 'hidden', timeout: 8000 });
  await page.getByText(name).first().waitFor({ state: 'visible', timeout: 8000 });
}

async function addWish(name, price) {
  await page.goto(`${BASE}purchase-orders`, { waitUntil: 'domcontentloaded' });
  await page.getByText('Wishlist', { exact: true }).first().click();
  await page.locator('[data-testid="wishlist-add"]').click();
  const dialog = page.getByRole('dialog');
  await dialog.locator('[data-testid="wishlist-name"]').fill(name);
  if (price) await dialog.locator('[data-testid="wishlist-target-price"]').fill(String(price));
  await dialog.getByRole('button', { name: /Add to wishlist|Save/ }).click();
  await dialog.waitFor({ state: 'hidden', timeout: 8000 });
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

/**
 * Create a category and give it one custom field (issue #97's dictionary).
 *
 * The category manager is a dialog reached from the inventory "More" menu, so this opens it,
 * creates the category, fills the add-field form and closes up again. Seeding a category is
 * what makes the inheritance shots possible at all — without one there is no custom field to
 * hold an inheritable value.
 */
async function addCategoryWithField(categoryName, fieldName) {
  await gotoInventory();
  await page.getByRole('button', { name: 'More inventory actions' }).click();
  await page.getByRole('menuitem', { name: 'Categories', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Categories & schemas' });
  await dialog.waitFor({ state: 'visible', timeout: 8000 });

  await dialog.getByRole('textbox', { name: 'New category name' }).fill(categoryName);
  await dialog.getByRole('button', { name: 'Add category' }).click();
  await dialog.getByRole('button', { name: new RegExp(categoryName) }).click();

  await dialog.getByRole('textbox', { name: 'Field name' }).fill(fieldName);
  await dialog.getByRole('button', { name: /Add field/ }).click();
  await dialog.getByText(fieldName).first().waitFor({ state: 'visible', timeout: 8000 });

  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden', timeout: 8000 });
}

/**
 * Wait for any success toast to disappear.
 *
 * Toasts stack in an overlay above the page and intercept pointer events while they animate
 * out, so a click issued straight after a save-driven toast retries until it times out — even
 * though its target is visible and enabled the whole time.
 */
async function waitForToastsToClear() {
  await page
    .locator('[data-testid="toast"]')
    .last()
    .waitFor({ state: 'hidden', timeout: 10000 })
    .catch(() => {});
}

/** Open a location's Edit dialog from its row in the tree. */
async function openLocationEditor(locationName) {
  await gotoInventory();
  const row = page.getByRole('treeitem', { name: new RegExp(locationName) }).first();
  await row.hover();
  await row.getByRole('button', { name: `Edit ${locationName}` }).click();
  const dialog = page.getByRole('dialog', { name: 'Edit location' });
  await dialog.waitFor({ state: 'visible', timeout: 8000 });
  return dialog;
}

/**
 * Give a location an inheritable value for a dictionary field (issue #97) — the offer that
 * everything stored inside it can then adopt.
 */
async function setInheritableLocationField(locationName, fieldName, value) {
  const dialog = await openLocationEditor(locationName);
  await chooseOption(dialog.getByRole('combobox', { name: 'Custom field to add' }), fieldName);
  await dialog.getByRole('button', { name: 'Add', exact: true }).click();

  // The row's value box commits on blur, not per keystroke.
  const input = dialog.getByRole('textbox', { name: fieldName });
  await input.waitFor({ state: 'visible', timeout: 8000 });
  await input.fill(value);
  await input.blur();
  await page.waitForTimeout(600);
  return dialog;
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
  // A category with a custom field, and a location offering an inheritable value for it —
  // the setup the location-inheritance shots photograph (issue #97).
  await addCategoryWithField('Power tools', 'Storage conditions');
  await waitForToastsToClear();
  await setInheritableLocationField('Garage', 'Storage conditions', 'Dry, unheated');
  await page.keyboard.press('Escape').catch(() => {});
  // The save toast overlays the page and would swallow the next dialog's clicks.
  await waitForToastsToClear();

  await addBulkItem('M3 × 10 Socket Screws', 250, 0.05);
  await addBulkItem('USB-C Cable 1m', 12, 4.5);
  await addDiscreteItem('Raspberry Pi 5 (8GB)', 65);
  // Sits inside Garage, so it can inherit the Storage conditions the Garage offers.
  await addDiscreteItem('Cordless Drill', 45, {
    category: 'Power tools',
    location: 'Workshop Shelf A',
  });
  await addGaugeItem('PLA Filament — Galaxy Black');
  // A few more so a long list spans more than one page for the pagination shot.
  await addDiscreteItem('Multimeter', 30);
  await addBulkItem('Heat-shrink Assortment', 200, 0.02);
  await addDiscreteItem('Label Printer', 55);
  // Data for the people/purchasing/reports screens (all invented — public-repo hygiene).
  await addContact('Alex Rivera');
  await addProject('Workshop LED Sign');
  await addWish('Cordless impact driver', 120);
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

// --- Location photos & regions (issue #81) ---------------------------------------
// The photo is *generated in-page* rather than loaded from a fixture: it keeps the repo free
// of a binary asset, and it guarantees the sample stays synthetic — a real photograph of a
// real space is exactly the personal data public-repo hygiene forbids.
try {
  const dialog = await openLocationEditor('Workshop Shelf A');
  await dialog.getByRole('tab', { name: 'Photos' }).click();

  const bytes = await page.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 1200;
    canvas.height = 800;
    const g = canvas.getContext('2d');
    g.fillStyle = '#8a6a44';
    g.fillRect(0, 0, canvas.width, canvas.height);
    ['#c9d6df', '#e8d5b7', '#bcd4c4', '#d9c2d4'].forEach((fill, i) => {
      g.fillStyle = fill;
      g.fillRect(40 + i * 290, 120, 250, 560);
      g.fillStyle = '#333';
      g.font = 'bold 40px sans-serif';
      g.fillText(`Bay ${i + 1}`, 70 + i * 290, 730);
    });
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/webp', 0.9));
    return Array.from(new Uint8Array(await blob.arrayBuffer()));
  });

  await dialog
    .locator('input[type="file"]')
    .first()
    .setInputFiles({
      name: 'shelf-bays.webp',
      mimeType: 'image/webp',
      buffer: Buffer.from(bytes),
    });
  await page.waitForTimeout(2500);
  await shot('location-photos-tab', dialog, { settle: 500 });

  await dialog
    .getByRole('button', { name: /Draw regions/i })
    .first()
    .click();
  const editor = page.getByRole('dialog').last();
  await editor.waitFor({ state: 'visible', timeout: 8000 });
  await page.waitForTimeout(1200);

  // Drag a rectangle over the second bay, in the image's own proportions.
  await editor.getByRole('radio', { name: 'Rectangle' }).first().click();
  const canvasBox = await editor.locator('img').first().boundingBox();
  if (canvasBox) {
    const at = (fx, fy) => ({
      x: canvasBox.x + canvasBox.width * fx,
      y: canvasBox.y + canvasBox.height * fy,
    });
    const from = at(0.28, 0.16);
    const to = at(0.48, 0.84);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 12 });
    await page.mouse.up();
    await page.waitForTimeout(900);
    const nameField = editor.getByLabel(/Region name/i).first();
    if (await nameField.isVisible().catch(() => false)) {
      await nameField.fill('Bay 2 — capacitors');
      await nameField.blur();
      await page.waitForTimeout(600);
    }
  }
  await shot('location-region-editor', editor, { settle: 500 });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  await page.keyboard.press('Escape');
} catch (err) {
  failed += 1;
  console.warn(`  ✗ location photos — ${err instanceof Error ? err.message : String(err)}`);
}

// --- Location statistics (issue #458) --------------------------------------------
// Garage holds nothing loose itself, so roll the figures up its subtree: the shot then shows
// the scope toggle plus real value (the priced Cordless Drill on Workshop Shelf A beneath it)
// and the value-by-category breakdown.
try {
  const dialog = await openLocationEditor('Garage');
  await dialog.getByRole('tab', { name: 'Statistics' }).click();
  await dialog.getByTestId('location-stats-scope-subtree').click();
  await dialog.getByTestId('location-stats-value').waitFor({ state: 'visible', timeout: 8000 });
  await shot('location-statistics', dialog, { settle: 600 });
  await page.keyboard.press('Escape');
} catch (err) {
  failed += 1;
  console.warn(`  ✗ location statistics — ${err instanceof Error ? err.message : String(err)}`);
}

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

// The container-weight (tare) picker, reached from the gauge fields of the Add-item dialog.
// It only appears once the gauge is measured by mass, so the unit is set to `g` first.
await gotoInventory();
await page.getByRole('button', { name: 'Add item' }).click();
{
  const dialog = page.getByRole('dialog', { name: 'Add item' });
  await chooseOption(dialog.getByLabel('Tracking'), 'Consumable');
  await dialog.getByLabel('Unit', { exact: true }).fill('g');
  await dialog.getByTestId('create-item-tare-preset').click();
  const picker = page.getByRole('dialog', { name: 'Pick a container' });
  await picker.waitFor({ state: 'visible', timeout: 8000 });
  await shot('tare-preset-picker', picker, { settle: 500 });
  await page.keyboard.press('Escape').catch(() => {});
  await page.keyboard.press('Escape').catch(() => {});
}

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

// The pagination control (issue #20) — enable "Paginate list", shrink the page size so the
// seeded items span more than one page, and capture the control at the foot of the list. Both
// preferences are restored afterwards so they don't leak into later shots (or a re-run).
//
// The page size is set from **Settings**, not from the control's own picker: `Pagination`
// renders nothing at all while there is only one page (`pageCount <= 1`), and the default size
// of 50 comfortably holds the whole seeded inventory — so the picker this step used to reach
// for does not exist yet at the moment it is needed. Setting the preference first is what
// splits the list and brings the control into being.
try {
  await setPageSize('5');

  await gotoInventory();
  await page.getByRole('button', { name: 'More inventory actions' }).click();
  await page.getByRole('menuitemcheckbox', { name: 'Paginate list' }).click();
  await page.waitForTimeout(600);
  await shot('inventory-pagination', page.getByTestId('inventory-pagination'), { settle: 400 });

  // Restore infinite scroll and the default page size.
  await page.getByRole('button', { name: 'More inventory actions' }).click();
  await page.getByRole('menuitemcheckbox', { name: 'Paginate list' }).click();
  await setPageSize('50');
} catch (err) {
  failed += 1;
  console.warn(`  ✗ inventory-pagination.png — ${err instanceof Error ? err.message : String(err)}`);
}

// ── Location-inherited custom fields (issue #97) ─────────────────────────────
// The location's side of the feature: the "Inheritable fields" panel in the Edit-location
// dialog, where a location sets a value and chooses whether to offer it to its contents.
try {
  const dialog = await openLocationEditor('Garage');
  const panel = dialog.getByText('Inheritable fields', { exact: true }).locator('xpath=ancestor::section[1]');
  await shot('location-inheritable-fields', panel.first(), { settle: 500 });
  await page.keyboard.press('Escape').catch(() => {});
} catch (err) {
  failed += 1;
  console.warn(`  ✗ location-inheritable-fields.png — ${err instanceof Error ? err.message : String(err)}`);
}

// The item's side: the source picker on the Classification tab, offering
// "Inherit — <value> (from <location>)" beside the option to set the item's own value.
try {
  await gotoInventory();
  const drillCard = page
    .locator('#main-content')
    .getByRole('heading', { name: 'Cordless Drill' })
    .locator('xpath=ancestor::div[contains(@class,"select-none")][1]');
  await drillCard.first().getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name: 'Edit details' }).click();
  const detail = page.getByRole('dialog').first();
  await detail.getByRole('tab', { name: 'Classification' }).click();

  // Switch the field to Inherit before capturing. The picker defaults to "Set a value for this
  // item", so an untouched shot would document the option the page *isn't* about — the point
  // here is the resolved inherited value and where it came from.
  await chooseOption(
    detail.getByRole('combobox', { name: 'Storage conditions — Where this value comes from' }),
    /^Inherit —/,
    { exact: false },
  );
  await page.waitForTimeout(600);

  const fields = detail.getByText('Custom fields', { exact: true }).locator('xpath=ancestor::section[1]');
  await shot('item-inherited-field', fields.first(), { settle: 600 });
  await page.keyboard.press('Escape').catch(() => {});
} catch (err) {
  failed += 1;
  console.warn(`  ✗ item-inherited-field.png — ${err instanceof Error ? err.message : String(err)}`);
}

// ── Data-dependent screens (need the seed above) ─────────────────────────────
async function screenShot(name, path) {
  try {
    await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(800);
    await shot(name, page.locator('#main-content'), { settle: 400 });
  } catch (err) {
    failed += 1;
    console.warn(`  ✗ ${name}.png — ${err instanceof Error ? err.message : String(err)}`);
  }
}

await screenShot('contacts', 'contacts');
await screenShot('projects', 'projects');
await screenShot('bookings', 'bookings');
await screenShot('reports', 'reports');
await screenShot('activity', 'activity');
await screenShot('alerts', 'alerts');
await screenShot('upcoming', 'upcoming');
await screenShot('sync', 'sync');
await screenShot('home-assistant', 'home-assistant');

// ── Webhooks ─────────────────────────────────────────────────────────────────
// The Add dialog first (captured before submitting, so the form is shown filled in), then the
// screen itself with the resulting row.
//
// The signing mode is left on its default — a secret held by the bridge — which stores only a
// *name*. That is deliberate: the alternative generates a real secret and shows it once, and a
// screenshot of anything secret-shaped has no business in a public repository. The endpoint is a
// reserved `example.test` address for the same reason.
const WEBHOOK_NAME = 'Workshop automation';

try {
  await page.goto(`${BASE}webhooks`, { waitUntil: 'domcontentloaded' });
  const addButton = page.getByRole('button', { name: 'Add webhook' }).first();
  await addButton.waitFor({ state: 'visible', timeout: 12000 });

  // The dialog is always opened and always captured, so the form shot stays current — but it is
  // only *submitted* when this profile hasn't got the webhook already. Unlike the seeding block
  // above, this step sits among the captures, which a re-run against a persistent profile reaches
  // directly; submitting unconditionally would stack up another row every run until the list
  // outgrew the clip below.
  const alreadyAdded = await page
    .getByText(WEBHOOK_NAME, { exact: true })
    .first()
    .isVisible()
    .catch(() => false);

  await addButton.click();
  const dialog = page.getByRole('dialog', { name: 'Add webhook' });
  await dialog.waitFor({ state: 'visible', timeout: 8000 });
  // Exact: `getByLabel` matches on substring by default, and "Name" is also a substring of the
  // signing block's "Secret name" — an inexact match would depend on field order to pick right.
  await dialog.getByLabel('Name', { exact: true }).fill(WEBHOOK_NAME);
  await dialog.getByLabel('URL').fill('https://automation.example.test/gubbins');
  await dialog.getByLabel('Secret name').fill('workshop-hook');
  await shot('webhooks-form', dialog, { settle: 600 });

  if (alreadyAdded) {
    await page.keyboard.press('Escape');
  } else {
    await dialog.getByRole('button', { name: 'Add webhook' }).click();
  }
  await dialog.waitFor({ state: 'hidden', timeout: 8000 });
  await waitForToastsToClear();

  // The clip is *measured*, not hardcoded. An element shot of `#main-content` is mostly empty
  // space — main is a flex column that stretches to the viewport, and one webhook fills little of
  // it — but a fixed top-region clip is no better: the transient storage-permission banner shifts
  // the whole page down on the runs where it appears, so the same numbers frame the content on one
  // run and cut it off on the next. Measuring main and its last child instead brackets exactly the
  // content, whatever sits above it.
  const main = page.locator('#main-content');
  const mainBox = await main.boundingBox();
  const lastBox = await main.locator('> *').last().boundingBox();
  await shot('webhooks', null, {
    settle: 600,
    clip:
      mainBox && lastBox
        ? {
            // Flush to main's top edge rather than a few pixels above it: anything above is the
            // page header, and a clip that reaches for breathing room catches a sliver of its
            // button instead.
            x: 0,
            y: mainBox.y,
            width: VIEWPORT.width,
            height: lastBox.y + lastBox.height - mainBox.y + 24,
          }
        : undefined,
  });
} catch (err) {
  failed += 1;
  console.warn(`  ✗ webhooks — ${err instanceof Error ? err.message : String(err)}`);
}

// The Purchase Orders screen — a top-region clip so the Orders/Reorder/Wishlist tab bar and
// the New-order button (which sit above #main-content) are included, not just the empty list.
try {
  await page.goto(`${BASE}purchase-orders`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(700);
  await shot('purchase-orders', null, {
    settle: 400,
    clip: { x: 0, y: 48, width: VIEWPORT.width, height: 420 },
  });
  // Then the Wishlist tab with the seeded entry.
  await page.getByText('Wishlist', { exact: true }).first().click();
  await page.waitForTimeout(600);
  await shot('wishlist', null, { settle: 400, clip: { x: 0, y: 48, width: VIEWPORT.width, height: 480 } });
} catch (err) {
  failed += 1;
  console.warn(`  ✗ purchase-orders/wishlist.png — ${err instanceof Error ? err.message : String(err)}`);
}

// The Suppliers dictionary. Whatever suppliers the seeded items and orders named above have
// already created are listed here, so no extra seeding step is needed.
await screenShot('suppliers', 'suppliers');

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

// ── Users, roles & sign-in (issue #79) ───────────────────────────────────────
// Deliberately last. The `users` module is opt-in and switching it on raises the sign-in gate
// in front of the whole app, so anything captured after this point would have to sign in first.
// Every account here is invented (public-repo hygiene) and `example.com` is the only domain.
try {
  await page.keyboard.press('Escape').catch(() => {});
  await page.goto(`${BASE}modules`, { waitUntil: 'domcontentloaded' });
  // Each module's control is a Foundry Select of On/Off, not a switch — it has to be opened
  // and the option chosen, or the click merely expands the listbox.
  const usersToggle = page.getByTestId('module-toggle-users');
  await usersToggle.waitFor({ state: 'visible', timeout: 10000 });
  await chooseOption(usersToggle, 'On');
  // Enabling is confirmed against a live "can anyone still sign in?" check, so the confirm
  // button only becomes clickable once that read resolves.
  const confirmEnable = page.getByTestId('confirm-users-enable');
  await confirmEnable.waitFor({ state: 'visible', timeout: 8000 });
  await confirmEnable.click({ timeout: 8000 });

  // The gate goes up immediately; the built-in Admin account has no password, so one click in.
  const adminTile = page.getByRole('button', { name: /Admin/ }).first();
  await adminTile.waitFor({ state: 'visible', timeout: 10000 });
  await adminTile.click();

  await page.goto(`${BASE}users`, { waitUntil: 'domcontentloaded' });
  await dismissFirstRun(3000);
  await page.getByRole('button', { name: 'Add user' }).waitFor({ state: 'visible', timeout: 12000 });

  /** Create one synthetic account with a role assigned. */
  async function addUser(username, displayName, email, role) {
    await page.getByRole('button', { name: 'Add user' }).click();
    const dialog = page.getByRole('dialog', { name: 'Add user' });
    await dialog.getByLabel('Username').fill(username);
    await dialog.getByLabel('Display name').fill(displayName);
    await dialog.getByLabel('Email (optional)').fill(email);
    await chooseOption(dialog.getByRole('combobox', { name: 'Role' }), role, { exact: false });
    await dialog.getByRole('button', { name: 'Save' }).click();
    await dialog.waitFor({ state: 'hidden', timeout: 8000 });
    await page.getByText(displayName).first().waitFor({ state: 'visible', timeout: 8000 });
  }

  await addUser('sam', 'Sam Okonkwo', 'sam@example.com', 'Manager');
  await addUser('priya', 'Priya Nair', 'priya@example.com', 'Stocker');
  await addUser('jo', 'Jo Brennan', 'jo@example.com', 'Viewer');

  // Give one account a password so both states appear side by side — the wiki is explicit that
  // an account may legitimately have none, and a list where every row says so shows only half of
  // it. The value is throwaway demo data for a fresh browser profile, not a credential.
  const samRow = page.locator('li', { hasText: 'Sam Okonkwo' }).first();
  await samRow.getByRole('button', { name: 'Password' }).click();
  const pwDialog = page.getByRole('dialog').first();
  await pwDialog.waitFor({ state: 'visible', timeout: 8000 });
  await pwDialog.getByLabel('New password', { exact: true }).fill('demo-passphrase-1');
  await pwDialog.getByLabel('Confirm password', { exact: true }).fill('demo-passphrase-1');
  await pwDialog.getByRole('button', { name: 'Save password' }).click();
  await pwDialog.waitFor({ state: 'hidden', timeout: 8000 });

  await shot('users-screen', page.locator('#main-content'), { settle: 600 });

  // The role editor for Stocker — a partly-ticked role shows the grid far better than an
  // all-or-nothing one. Scoped to the row naming Stocker rather than a positional index, so
  // adding or reordering a built-in role fails the capture loudly instead of quietly shooting
  // some other role's grid while the page around it still says "Stocker".
  // `role="dialog"` sits on the full-screen Modal wrapper, so the shot targets the panel inside
  // it (the sibling after the overlay) to get a cropped image.
  // Both lists are `<li>`s and an account row shows its role name too ("priya · Stocker"), so
  // the row is pinned by *also* holding an "Edit role" button — which only a role row does.
  const stockerRow = page
    .locator('li')
    .filter({ hasText: 'Stocker' })
    .filter({ has: page.getByRole('button', { name: 'Edit role' }) });
  await stockerRow.getByRole('button', { name: 'Edit role' }).click();
  const roleDialog = page.getByRole('dialog').first();
  await roleDialog.waitFor({ state: 'visible', timeout: 8000 });
  await shot('users-role-editor', roleDialog.locator('> div').nth(1), { settle: 900 });
  await page.keyboard.press('Escape').catch(() => {});

  // Sign out to capture the gate itself, now that there are several accounts to show.
  await page.getByRole('button', { name: 'Navigation menu' }).click();
  const signOut = page.getByTestId('app-nav-sign-out');
  await signOut.waitFor({ state: 'visible', timeout: 8000 });
  await signOut.click();
  await page
    .getByRole('heading', { name: /Who’s using Gubbins/ })
    .waitFor({ state: 'visible', timeout: 10000 });
  await shot('sign-in', page.locator('#main-content'), { settle: 700 });

  // Leave the profile as the run found it: the gate would otherwise front every later shot
  // if a capture step is ever appended below this one.
  await page.getByRole('button', { name: /Can’t sign in/ }).click();
  await page.getByTestId('sign-in-turn-off-users').click();
  // The gate comes down in place, leaving the router on whichever route it was on (`/users`,
  // which is now module-guarded) — so navigate rather than waiting for a screen to appear.
  await gotoInventory();
} catch (err) {
  failed += 1;
  console.warn(`  ✗ users screenshots — ${err instanceof Error ? err.message : String(err)}`);
}

console.log(`\nDone: ${captured} captured, ${failed} failed. → ${OUT}`);

// Close on a deadline. Every image is on disk by this point, so a browser that declines to shut
// down — the app's SQLite worker and service worker can both keep the context alive — must not
// hold the run open indefinitely; the exit code still reflects the captures.
await Promise.race([browser.close(), new Promise((resolve) => setTimeout(resolve, 10000))]);
process.exit(failed > 0 ? 1 : 0);
