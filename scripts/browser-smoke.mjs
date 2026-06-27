/**
 * End-to-end browser smoke test for Gubbins (run against a live dev server).
 *
 * Drives the preinstalled Edge via Playwright against http://localhost:5173/Gubbins/
 * — a real cross-origin-isolated context, so OPFS + SharedArrayBuffer + the SQLite
 * worker actually run. Exercises the Phase 2 flows: cross-origin isolation, item
 * creation (Bulk + Consumable Gauge), quantity adjustment, the density toggle, and
 * nested location creation; plus the Phase 3 flows: category + custom-field schemas,
 * serialised auto-clone, freeform tagging, and the real image pipeline (canvas→WebP
 * compression → raw OPFS file → thumbnail); plus the Phase 4 flows: create a project,
 * add a BOM line, see the automated shopping list, toggle the costing mode, reserve
 * stock, and move a line into the "In Transit" procurement state. Asserts there are
 * no console/page errors.
 *
 *   node scripts/browser-smoke.mjs            # headless
 *   node scripts/browser-smoke.mjs --headed   # watch it run
 */
import zlib from 'node:zlib';
import { chromium } from 'playwright';

/** Build a tiny, guaranteed-valid RGB PNG buffer for the image-upload flow. */
function makePng(size = 8) {
  const crc32 = (buf) => {
    let c = ~0;
    for (let i = 0; i < buf.length; i += 1) {
      c ^= buf[i];
      for (let k = 0; k < 8; k += 1) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
    return (~c) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: RGB
  const raw = Buffer.alloc(size * (1 + size * 3));
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const o = y * (1 + size * 3) + 1 + x * 3;
      raw[o] = 210;
      raw[o + 1] = 90;
      raw[o + 2] = 40;
    }
  }
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Defaults to the conventional dev-server origin; override with SMOKE_BASE when the
// dev server picks a different port (e.g. 5173 already in use → 5174).
const BASE = process.env.SMOKE_BASE ?? 'http://localhost:5173/Gubbins/';
const headed = process.argv.includes('--headed');
const results = [];
const consoleErrors = [];
const pageErrors = [];

const ok = (name) => results.push({ name, pass: true });
const fail = (name, err) => results.push({ name, pass: false, err: String(err?.message ?? err) });

async function step(name, fn) {
  try {
    await fn();
    ok(name);
    console.log(`  ✓ ${name}`);
  } catch (err) {
    fail(name, err);
    console.log(`  ✗ ${name} — ${err?.message ?? err}`);
  }
}

const browser = await chromium.launch({ channel: 'msedge', headless: !headed });
const page = await browser.newPage();

page.on('console', (msg) => {
  if (msg.type() === 'error') consoleErrors.push(msg.text());
});
page.on('pageerror', (err) => pageErrors.push(String(err)));

const stamp = Date.now().toString().slice(-5);
const screwName = `Smoke Screws ${stamp}`;
const filamentName = `Smoke Filament ${stamp}`;
const categoryName = `Smoke Caps ${stamp}`;
const fieldName = `Voltage ${stamp}`;
const printerName = `Smoke Printer ${stamp}`;
const tagName = `smoke-${stamp}`;
const projectName = `Smoke Project ${stamp}`;
const partName = `Smoke Part ${stamp}`;

// A small valid PNG, enough for the canvas→WebP compression pipeline to decode.
const pngBuffer = makePng(8);

try {
  await step('loads and reaches the inventory workspace', async () => {
    await page.goto(`${BASE}inventory`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: 'Add item' }).waitFor({ state: 'visible', timeout: 20000 });
  });

  await step('context is cross-origin isolated (OPFS/SharedArrayBuffer)', async () => {
    const isolated = await page.evaluate(() => self.crossOriginIsolated === true);
    if (!isolated) throw new Error('crossOriginIsolated is false');
    const hasSab = await page.evaluate(() => typeof SharedArrayBuffer !== 'undefined');
    if (!hasSab) throw new Error('SharedArrayBuffer unavailable');
  });

  await step('creates a Bulk item', async () => {
    await page.getByRole('button', { name: 'Add item' }).click();
    const dialog = page.getByRole('dialog', { name: 'Add item' });
    await dialog.getByLabel('Name').fill(screwName);
    await dialog.getByLabel('Tracking').selectOption('DISCRETE');
    await dialog.getByLabel('Initial quantity').fill('100');
    await dialog.getByRole('button', { name: 'Create item' }).click();
    await page.getByText(screwName).waitFor({ state: 'visible', timeout: 10000 });
  });

  await step('creates a Consumable Gauge item with a rendered gauge', async () => {
    await page.getByRole('button', { name: 'Add item' }).click();
    const dialog = page.getByRole('dialog', { name: 'Add item' });
    await dialog.getByLabel('Name').fill(filamentName);
    await dialog.getByLabel('Tracking').selectOption('CONSUMABLE_GAUGE');
    await dialog.getByLabel('Unit').fill('g');
    await dialog.getByLabel('Full capacity').fill('1000');
    await dialog.getByLabel('Tare (empty)').fill('250');
    await dialog.getByRole('button', { name: 'Create item' }).click();
    await page.getByText(filamentName).waitFor({ state: 'visible', timeout: 10000 });
    // A gauge progressbar must be present somewhere in the list.
    await page.getByRole('progressbar').first().waitFor({ state: 'visible', timeout: 5000 });
  });

  await step('increments quantity via the stepper (optimistic)', async () => {
    const card = page.locator('div', { hasText: screwName }).last();
    // Find the increment button within the screws card and click it.
    await page.getByRole('button', { name: 'Increase quantity' }).first().click();
    await page.getByText('101', { exact: true }).first().waitFor({ state: 'visible', timeout: 5000 });
    void card;
  });

  await step('toggles Data-Heavy ↔ Visual-Heavy density', async () => {
    await page.getByRole('radio', { name: 'Data' }).click();
    await page.waitForTimeout(300);
    const dataChecked = await page.getByRole('radio', { name: 'Data' }).getAttribute('aria-checked');
    if (dataChecked !== 'true') throw new Error('Data density not selected');
    await page.getByRole('radio', { name: 'Visual' }).click();
    await page.waitForTimeout(300);
  });

  await step('creates nested locations', async () => {
    await page.getByRole('button', { name: 'Add location' }).click();
    let dialog = page.getByRole('dialog', { name: 'Add location' });
    await dialog.getByLabel('Name').fill(`Workshop ${stamp}`);
    await dialog.getByRole('button', { name: 'Create' }).click();
    await page.getByText(`Workshop ${stamp}`).waitFor({ state: 'visible', timeout: 8000 });

    await page.getByRole('button', { name: 'Add location' }).click();
    dialog = page.getByRole('dialog', { name: 'Add location' });
    await dialog.getByLabel('Name').fill(`Shelf ${stamp}`);
    await dialog.getByLabel('Parent (optional)').selectOption({ label: `Workshop ${stamp}` });
    await dialog.getByRole('button', { name: 'Create' }).click();
    await page.getByText(`Shelf ${stamp}`).waitFor({ state: 'visible', timeout: 8000 });
  });

  // --- Phase 3 flows ------------------------------------------------------------

  await step('creates a category with a custom field', async () => {
    await page.getByRole('button', { name: 'Categories' }).click();
    const dialog = page.getByRole('dialog', { name: 'Categories & schemas' });
    await dialog.getByLabel('New category name').fill(categoryName);
    await dialog.getByRole('button', { name: 'Add category' }).click();
    // The new category becomes selected; its add-field form appears.
    await dialog.getByLabel('Field name').fill(fieldName);
    await dialog.getByLabel('Field type').selectOption('NUMBER');
    await dialog.getByRole('button', { name: 'Add field' }).click();
    await dialog.getByText(fieldName).waitFor({ state: 'visible', timeout: 8000 });
    await page.keyboard.press('Escape');
  });

  // Scope to the tightest item card containing the printer name and a details button.
  const printerCard = () =>
    page
      .locator('div')
      .filter({ hasText: printerName })
      .filter({ has: page.getByRole('button', { name: 'Item details' }) })
      .last();

  await step('auto-clones a serialised item into distinct records', async () => {
    await page.getByRole('button', { name: 'Add item' }).click();
    const dialog = page.getByRole('dialog', { name: 'Add item' });
    await dialog.getByLabel('Name').fill(printerName);
    await dialog.getByLabel('Tracking').selectOption('SERIALISED');
    await dialog.getByLabel(/How many/).fill('3');
    await dialog.getByRole('button', { name: 'Create item' }).click();
    // Three distinct instance records share the name (#1..#3 shown beside it).
    await page.getByText(printerName).first().waitFor({ state: 'visible', timeout: 10000 });
    await page.waitForFunction(
      (name) =>
        document.querySelectorAll('h3').length > 0 &&
        [...document.querySelectorAll('h3')].filter((h) => h.textContent?.includes(name)).length >= 3,
      printerName,
      { timeout: 10000 },
    );
  });

  await step('opens an item, adds a freeform tag', async () => {
    await printerCard().getByRole('button', { name: 'Item details' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Add a tag').fill(tagName);
    await page.keyboard.press('Enter');
    await dialog.getByText(tagName).waitFor({ state: 'visible', timeout: 8000 });
    await page.keyboard.press('Escape');
  });

  await step('uploads an image through the real OPFS pipeline', async () => {
    await printerCard().getByRole('button', { name: 'Item details' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Upload image').setInputFiles({
      name: 'smoke.png',
      mimeType: 'image/png',
      buffer: pngBuffer,
    });
    // A thumbnail must render from the stored DB blob (round-trips the worker).
    await dialog.locator('img').first().waitFor({ state: 'visible', timeout: 15000 });
    await page.keyboard.press('Escape');
  });

  // --- Phase 4 flows ------------------------------------------------------------

  /** Poll a <select>'s value (it is server-controlled via TanStack Query). */
  async function expectSelectValue(locator, value, label) {
    for (let i = 0; i < 25; i += 1) {
      if ((await locator.inputValue()) === value) return;
      await page.waitForTimeout(150);
    }
    throw new Error(`${label} did not become ${value}`);
  }

  await step('navigates to projects and creates a project', async () => {
    await page.getByRole('link', { name: 'Projects' }).first().click();
    await page.getByRole('button', { name: 'New project' }).waitFor({ state: 'visible', timeout: 15000 });
    await page.getByRole('button', { name: 'New project' }).click();
    const dialog = page.getByRole('dialog', { name: 'New project' });
    await dialog.getByLabel('Name').fill(projectName);
    await dialog.getByRole('button', { name: 'Create project' }).click();
    // The new project becomes selected and its BOM workspace appears.
    await page.getByRole('heading', { name: 'Bill of materials' }).waitFor({ state: 'visible', timeout: 10000 });
  });

  await step('adds a manual BOM line', async () => {
    await page.getByRole('button', { name: 'Add line' }).click();
    const dialog = page.getByRole('dialog', { name: 'Add BOM line' });
    await dialog.getByLabel('Description').fill(partName);
    await dialog.getByLabel('Quantity').fill('5');
    await dialog.getByRole('button', { name: 'Add line' }).click();
    await page.getByText(partName).first().waitFor({ state: 'visible', timeout: 10000 });
  });

  await step('shows the part on the automated shopping list', async () => {
    // The un-reserved, un-ordered line must appear under the Shopping list heading.
    await page.getByRole('heading', { name: /Shopping list/ }).waitFor({ state: 'visible', timeout: 8000 });
    await page.waitForFunction(
      (name) =>
        [...document.querySelectorAll('table')].some((t) => t.textContent?.includes(name)),
      partName,
      { timeout: 8000 },
    );
  });

  await step('toggles the BOM costing mode', async () => {
    const costing = page.getByLabel('Costing mode');
    await costing.selectOption('POINT_IN_TIME');
    await expectSelectValue(costing, 'POINT_IN_TIME', 'Costing mode');
  });

  await step('reserves stock on the BOM line', async () => {
    const reservation = page.getByLabel('Reservation status');
    await reservation.selectOption('ACTUAL');
    await expectSelectValue(reservation, 'ACTUAL', 'Reservation status');
  });

  await step('moves the line into the In-Transit procurement state', async () => {
    const procurement = page.getByLabel('Procurement status');
    await procurement.selectOption('IN_TRANSIT');
    await expectSelectValue(procurement, 'IN_TRANSIT', 'Procurement status');
  });

  await page.screenshot({ path: 'scripts/.smoke-screenshot.png', fullPage: true });
} catch (err) {
  fail('unexpected failure', err);
}

// Edge can be slow to close; don't let it swallow the report or hang the run.
await Promise.race([browser.close(), new Promise((r) => setTimeout(r, 3000))]);

// --- Report --------------------------------------------------------------------
console.log('\n=== Summary ===');
const passed = results.filter((r) => r.pass).length;
console.log(`Steps: ${passed}/${results.length} passed`);
if (consoleErrors.length) {
  console.log(`\nConsole errors (${consoleErrors.length}):`);
  consoleErrors.forEach((e) => console.log(`  • ${e}`));
} else {
  console.log('Console errors: none');
}
if (pageErrors.length) {
  console.log(`\nPage errors (${pageErrors.length}):`);
  pageErrors.forEach((e) => console.log(`  • ${e}`));
} else {
  console.log('Page errors: none');
}

const failed = results.filter((r) => !r.pass);
// Spec §8.5.5: the smoke fails on any step failure, page error, or console error.
process.exit(failed.length === 0 && pageErrors.length === 0 && consoleErrors.length === 0 ? 0 : 1);
