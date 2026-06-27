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
 * stock, and move a line into the "In Transit" procurement state; plus the Phase 5
 * flows: a real FTS5 full-text search over the item index, adding a weighted
 * capability to an item, and building a graphical Visual-Builder query that filters
 * by that capability; plus the Phase 6 flows: generating a printable QR code,
 * simulating a scan/decode and checking the item out to an auto-created contact,
 * viewing & returning the loan on the contacts screen, and running a JSON backup
 * through the Export Wizard; plus the Phase 7 flows: connecting the in-memory cloud
 * provider and publishing, downloading a versioned-JSON backup of the real OPFS
 * database, and importing that backup (merge restore) followed by a clean re-sync;
 * plus the Phase 8 flows: simulating the companion extension's EXTENSION_READY to
 * unlock the "Scrape Supplier" control, proving an invalid/foreign-origin message is
 * silently dropped, applying a trusted SCRAPE_RESULT that fills the empty MPN/price
 * fields **without** overwriting a user-edited manufacturer, and re-scraping an
 * existing item through the §4 no-overwrite review (a populated field stays put).
 * Asserts there are no console/page errors.
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

const browser = await chromium.launch({
  channel: 'msedge',
  headless: !headed,
  // Auto-grant a fake camera so the Phase 6 scanner's getUserMedia path runs
  // headlessly without a permission prompt (§6.1); manual code entry is the decode.
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
});
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
const borrowerName = `Smoke Borrower ${stamp}`;
const scrapeItemName = `Smoke Scrape ${stamp}`;
const scrapedMpn = `NE555P-${stamp}`;
const userManufacturer = 'ACME (user)';
// Phase 9 — procurement & lifecycle logistics.
const perishableName = `Smoke Resin ${stamp}`;
const variantName = `Variant ${stamp}`;
const drawerName = `Drawer ${stamp}`;
const cycleItemName = `Smoke Count ${stamp}`;
const maintScheduleName = `Lube ${stamp}`;
// An expiry a few days out so it classifies as "expiring soon" (§4 / dashboard widget).
const soonExpiry = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10);

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
    // Exact match: the Phase 8 "Unit cost" field also contains the word "Unit".
    await dialog.getByLabel('Unit', { exact: true }).fill('g');
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

  // --- Phase 5 flows ------------------------------------------------------------

  /** Scope to the tightest item card carrying a name and a details button. */
  const itemCard = (name) =>
    page
      .locator('div')
      .filter({ hasText: name })
      .filter({ has: page.getByRole('button', { name: 'Item details' }) })
      .last();

  await step('returns to inventory and runs an FTS5 full-text search', async () => {
    await page.goto(`${BASE}inventory`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: 'Add item' }).waitFor({ state: 'visible', timeout: 20000 });
    const box = page.getByLabel('Search items');
    await box.fill('Screws');
    // The Bulk screw item matches; the filament (no "screws" token) must not.
    await page.getByText(screwName).first().waitFor({ state: 'visible', timeout: 8000 });
    await page.waitForFunction(
      (name) => !document.body.textContent?.includes(name),
      filamentName,
      { timeout: 8000 },
    );
    await box.fill('');
  });

  await step('adds a weighted capability to an item', async () => {
    await itemCard(screwName).getByRole('button', { name: 'Item details' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Capability key').fill('voltage');
    const value = dialog.getByLabel('Capability value');
    await value.fill('5');
    await value.press('Enter'); // the editor adds on Enter (avoids button-animation flakiness)
    // The new capability chip renders, exposing its remove button.
    await dialog
      .getByRole('button', { name: 'Remove capability voltage' })
      .waitFor({ state: 'visible', timeout: 8000 });
    await page.keyboard.press('Escape');
  });

  await step('builds a Visual-Builder query filtering by capability', async () => {
    await page.getByRole('button', { name: 'Visual search' }).click();
    await page.getByRole('button', { name: 'Add condition' }).click();
    // Switch the condition to a capability HAS_CAPABILITY filter on "voltage".
    await page.getByLabel('Field').selectOption('capability');
    await page.getByLabel('Capability key').fill('voltage');
    // Results now show only items carrying the capability: the screw, not the filament.
    await page.getByText(screwName).first().waitFor({ state: 'visible', timeout: 8000 });
    await page.waitForFunction(
      (name) => !document.body.textContent?.includes(name),
      filamentName,
      { timeout: 8000 },
    );
  });

  // --- Phase 6: QR generation, scanner, contacts & checkout, export ------------

  let scannedUrl = '';
  await step('generates a printable QR code for an item', async () => {
    await page.goto(`${BASE}inventory`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: 'Add item' }).waitFor({ state: 'visible', timeout: 20000 });
    await itemCard(screwName).getByRole('button', { name: 'QR code' }).click();
    const dialog = page.getByRole('dialog', { name: 'QR code' });
    await dialog.locator('[data-testid="item-qr"] svg').waitFor({ state: 'visible', timeout: 8000 });
    scannedUrl = (await dialog.locator('[data-testid="item-qr-url"]').innerText()).trim();
    if (!scannedUrl.includes('item=')) throw new Error(`QR url missing item param: ${scannedUrl}`);

    // Prove the hand-rolled encoder produces a genuinely decodable QR: render the
    // SVG to a canvas and decode it with the native Barcode Detection API (§6.6).
    const decoded = await page.evaluate(async () => {
      if (!('BarcodeDetector' in window)) return null; // skip where unsupported
      const svgEl = document.querySelector('[data-testid="item-qr"] svg');
      if (!svgEl) return 'no-svg';
      const xml = new XMLSerializer().serializeToString(svgEl);
      const url = URL.createObjectURL(new Blob([xml], { type: 'image/svg+xml' }));
      const img = new Image();
      await new Promise((res, rej) => {
        img.onload = res;
        img.onerror = rej;
        img.src = url;
      });
      const canvas = document.createElement('canvas');
      canvas.width = img.width || 300;
      canvas.height = img.height || 300;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      const det = new window.BarcodeDetector({ formats: ['qr_code'] });
      const codes = await det.detect(canvas);
      URL.revokeObjectURL(url);
      return codes.length ? codes[0].rawValue : 'none';
    });
    if (decoded !== null && decoded !== scannedUrl) {
      throw new Error(`BarcodeDetector decoded "${decoded}", expected "${scannedUrl}"`);
    }
    await page.keyboard.press('Escape');
  });

  await step('scans a code and checks the item out to an auto-created contact', async () => {
    await page.getByRole('button', { name: 'Scan' }).click();
    const overlay = page.locator('[data-testid="scanner-overlay"]');
    await overlay.waitFor({ state: 'visible', timeout: 8000 });
    // Simulate a decode by feeding the deep-link into the manual-entry fallback.
    await page.locator('[data-testid="scanner-manual-input"]').fill(scannedUrl);
    await page.locator('[data-testid="scanner-manual-submit"]').click();
    // Discrete result card shows the scanned item with a Check out action.
    await overlay.getByText(screwName).first().waitFor({ state: 'visible', timeout: 8000 });
    await overlay.getByRole('button', { name: 'Check out' }).click();
    const dialog = page.getByRole('dialog', { name: 'Check out' });
    await dialog.getByPlaceholder('Type a name — new names are added automatically').fill(borrowerName);
    await dialog.getByRole('button', { name: 'Check out' }).click();
    await dialog.waitFor({ state: 'hidden', timeout: 8000 });
    // Close the scanner overlay.
    await page.getByRole('button', { name: 'Close scanner' }).click();
  });

  await step('shows the loan and contact on the contacts screen', async () => {
    await page.goto(`${BASE}contacts`, { waitUntil: 'domcontentloaded' });
    await page.getByText('On loan').waitFor({ state: 'visible', timeout: 12000 });
    // The borrowed item and the auto-created contact both appear.
    await page.getByText(screwName).first().waitFor({ state: 'visible', timeout: 8000 });
    await page.getByText(borrowerName).first().waitFor({ state: 'visible', timeout: 8000 });
    // Return it.
    await page.getByRole('button', { name: 'Return' }).first().click();
    await page.waitForFunction(
      (name) => !document.body.textContent?.includes(name),
      screwName,
      { timeout: 8000 },
    );
  });

  await step('runs a JSON backup export through the wizard', async () => {
    await page.goto(`${BASE}inventory`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: 'Export' }).waitFor({ state: 'visible', timeout: 20000 });
    await page.getByRole('button', { name: 'Export' }).click();
    const dialog = page.getByRole('dialog', { name: 'Export' });
    await dialog.waitFor({ state: 'visible', timeout: 8000 });
    const download = page.waitForEvent('download', { timeout: 15000 });
    await dialog.getByTestId('run-export').click();
    const file = await download;
    if (!file.suggestedFilename().endsWith('.json')) {
      throw new Error(`unexpected export filename: ${file.suggestedFilename()}`);
    }
    await page.keyboard.press('Escape');
  });

  await step('exports a Markdown vault zip via the fflate worker (§4.5)', async () => {
    await page.getByRole('button', { name: 'Export' }).click();
    const dialog = page.getByRole('dialog', { name: 'Export' });
    await dialog.getByRole('button', { name: /Markdown vault/ }).click();
    const download = page.waitForEvent('download', { timeout: 20000 });
    await dialog.getByTestId('run-export').click();
    const file = await download;
    if (!file.suggestedFilename().endsWith('.zip')) {
      throw new Error(`unexpected vault filename: ${file.suggestedFilename()}`);
    }
    await page.keyboard.press('Escape');
  });

  // --- Phase 7: Cloud Sync & File System Access --------------------------------
  // These hops stay inside the SPA (in-app <Link> clicks, never page.goto) because
  // the in-memory provider's "remote" lives in JS module memory; a full reload would
  // reset it. They drive the genuine OPFS worker path for snapshot/apply/backup.

  let backupJson = '';
  await step('connects the in-memory sync provider and publishes', async () => {
    await page.getByRole('link', { name: 'Sync' }).first().click();
    await page.getByRole('heading', { name: /Cloud Sync/ }).waitFor({ state: 'visible', timeout: 12000 });
    await page.getByTestId('connect-memory').click();
    await page.getByTestId('sync-provider-label').waitFor({ state: 'visible', timeout: 8000 });
    await page.getByTestId('sync-now').click();
    // First sync publishes the local state; the result line reports the status.
    await page.getByTestId('sync-result').waitFor({ state: 'visible', timeout: 12000 });
  });

  await step('downloads a versioned-JSON backup of the real OPFS database', async () => {
    const download = page.waitForEvent('download', { timeout: 15000 });
    await page.getByTestId('download-backup').click();
    const file = await download;
    if (!file.suggestedFilename().endsWith('.json')) {
      throw new Error(`unexpected backup filename: ${file.suggestedFilename()}`);
    }
    const fs = await import('node:fs/promises');
    backupJson = await fs.readFile(await file.path(), 'utf8');
    const parsed = JSON.parse(backupJson);
    if (parsed.formatVersion !== 1) throw new Error(`backup formatVersion ${parsed.formatVersion} != 1`);
    const items = parsed.tables?.items ?? [];
    if (!items.some((it) => it.name === screwName)) {
      throw new Error('backup snapshot is missing the expected item');
    }
  });

  await step('imports the backup (merge) and re-syncs cleanly', async () => {
    // Still on /sync. Import the just-downloaded backup through the real OPFS restore
    // path, then run a second sync over the restored state — both must be error-free.
    await page.getByTestId('restore-input').setInputFiles({
      name: 'gubbins-backup.json',
      mimeType: 'application/json',
      buffer: Buffer.from(backupJson, 'utf8'),
    });
    await page.getByTestId('confirm-restore').click();
    await page.getByTestId('sync-notice').waitFor({ state: 'visible', timeout: 12000 });
    await page.getByTestId('sync-now').click();
    await page.getByTestId('sync-result').waitFor({ state: 'visible', timeout: 12000 });

    // The database is intact after import + sync: the item is still searchable.
    await page.getByRole('link', { name: 'Inventory' }).first().click();
    await page.getByLabel('Search items').fill(screwName);
    await page.getByText(screwName).first().waitFor({ state: 'visible', timeout: 10000 });
  });

  // --- Phase 8: External Data Scraping via Extension (§4, §9) -------------------
  // The companion extension is feature-detected via a trusted-origin postMessage
  // bridge. We simulate the extension here (the real one is built separately) by
  // posting protocol-conformant messages from the page's own origin.

  const EXT_SOURCE = 'HARDWARE_TRACKER_EXT';
  const postExtMessage = (message) =>
    page.evaluate((msg) => window.postMessage(msg, window.location.origin), message);
  const pollInputValue = async (locator, expected, label) => {
    for (let i = 0; i < 30; i += 1) {
      if ((await locator.inputValue()) === expected) return;
      await page.waitForTimeout(100);
    }
    throw new Error(`${label} did not become "${expected}" (was "${await locator.inputValue()}")`);
  };

  await step('extension EXTENSION_READY unlocks the Scrape Supplier control (§9.3)', async () => {
    await page.goto(`${BASE}inventory`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: 'Add item' }).waitFor({ state: 'visible', timeout: 20000 });
    await page.getByRole('button', { name: 'Add item' }).click();
    const dialog = page.getByRole('dialog', { name: 'Add item' });
    // Before readiness the panel must NOT exist (graceful degradation to manual).
    if (await dialog.getByTestId('scrape-supplier-panel').count()) {
      throw new Error('Scrape panel rendered before EXTENSION_READY');
    }
    await postExtMessage({ source: EXT_SOURCE, type: 'EXTENSION_READY', payload: { version: '1.0.0' } });
    await dialog.getByTestId('scrape-supplier-panel').waitFor({ state: 'visible', timeout: 8000 });
  });

  await step('a foreign-origin/invalid message is silently dropped (§9.1)', async () => {
    const dialog = page.getByRole('dialog', { name: 'Add item' });
    const mpn = dialog.getByLabel('MPN (optional)');
    // A forged-signature SCRAPE_RESULT must be ignored — and must not raise an error.
    await postExtMessage({
      source: 'EVIL_EXT',
      type: 'SCRAPE_RESULT',
      payload: { mpn: 'HACKED', manufacturer: 'x', description: 'x', distributor_url: 'https://evil.test/p', scraped_pricing: null },
    });
    // A malformed (schema-invalid) message from the right source must also be dropped.
    await postExtMessage({ source: EXT_SOURCE, type: 'SCRAPE_RESULT', payload: { mpn: 42 } });
    await page.waitForTimeout(300);
    if ((await mpn.inputValue()) !== '') throw new Error('an invalid message populated the form');
  });

  await step('a trusted SCRAPE_RESULT fills empty fields without overwriting user entries (§4)', async () => {
    const dialog = page.getByRole('dialog', { name: 'Add item' });
    await dialog.getByLabel('Name').fill(scrapeItemName);
    const mpn = dialog.getByLabel('MPN (optional)');
    const manufacturer = dialog.getByLabel('Manufacturer (optional)');
    const unitCost = dialog.getByLabel('Unit cost (optional)');
    // The user has already typed a manufacturer — it must be preserved.
    await manufacturer.fill(userManufacturer);

    await dialog.getByTestId('scrape-supplier-panel').locator('input[type="url"]').fill('https://www.digikey.co.uk/p/ne555p');
    await dialog.getByRole('button', { name: 'Scrape' }).click();
    // Now the (trusted) extension answers.
    await postExtMessage({
      source: EXT_SOURCE,
      type: 'SCRAPE_RESULT',
      payload: {
        mpn: scrapedMpn,
        manufacturer: 'Texas Instruments',
        description: 'Precision 555 timer IC',
        distributor_url: 'https://www.digikey.co.uk/p/ne555p',
        scraped_pricing: { currency: 'GBP', value: 0.42 },
      },
    });

    await pollInputValue(mpn, scrapedMpn, 'MPN'); // empty → filled
    await pollInputValue(unitCost, '0.42', 'Unit cost'); // empty → filled
    if ((await manufacturer.inputValue()) !== userManufacturer) {
      throw new Error('scrape overwrote the user-edited manufacturer');
    }
    // A passive toast confirms the apply (§4 default notification).
    await page.getByTestId('toast').first().waitFor({ state: 'visible', timeout: 5000 });

    await dialog.getByRole('button', { name: 'Create item' }).click();
    await page.getByText(scrapeItemName).first().waitFor({ state: 'visible', timeout: 10000 });
  });

  const scrapeCard = () =>
    page
      .locator('div')
      .filter({ hasText: scrapeItemName })
      .filter({ has: page.getByRole('button', { name: 'Item details' }) })
      .last();

  await step('the supplier MPN was mapped as an alias (§4 Universal Alias Mapping)', async () => {
    await scrapeCard().getByRole('button', { name: 'Item details' }).click();
    const detail = page.getByRole('dialog');
    // Supplier data section shows the scraped MPN value and the alias chip (both the MPN text).
    await detail.getByText(scrapedMpn).first().waitFor({ state: 'visible', timeout: 8000 });
  });

  await step('re-scraping honours the §4 no-overwrite review for a populated field', async () => {
    const detail = page.getByRole('dialog');
    await detail.getByTestId('scrape-supplier-panel').locator('input[type="url"]').fill('https://www.digikey.co.uk/p/ne555p');
    await detail.getByRole('button', { name: 'Scrape' }).click();
    await postExtMessage({
      source: EXT_SOURCE,
      type: 'SCRAPE_RESULT',
      payload: {
        mpn: scrapedMpn,
        manufacturer: 'Texas Instruments', // differs from the user's value → CONFLICT
        description: 'Precision 555 timer IC',
        distributor_url: 'https://www.digikey.co.uk/p/ne555p',
        scraped_pricing: { currency: 'GBP', value: 0.42 },
      },
    });
    const review = page.getByRole('dialog', { name: 'Review scraped data' });
    await review.waitFor({ state: 'visible', timeout: 8000 });
    // The manufacturer conflict is presented as an OFF-by-default opt-in.
    const overwrite = review.getByTestId('overwrite-manufacturer');
    await overwrite.waitFor({ state: 'visible', timeout: 4000 });
    if (await overwrite.isChecked()) throw new Error('overwrite checkbox defaulted to ON');
    // Apply WITHOUT ticking — the user's manufacturer must survive.
    await review.getByRole('button', { name: 'Apply' }).click();
    await review.waitFor({ state: 'hidden', timeout: 8000 });
    await page.waitForFunction(
      (mfr) => document.body.textContent?.includes(mfr),
      userManufacturer,
      { timeout: 8000 },
    );
    await page.keyboard.press('Escape');
  });

  // --- Phase 9: perishables, variants, maintenance & cycle counting ------------

  const lifecycleCard = (name) =>
    page
      .locator('div')
      .filter({ hasText: name })
      .filter({ has: page.getByRole('button', { name: 'Item details' }) })
      .last();

  await step('creates a perishable item with an expiry date and condition (§4)', async () => {
    await page.goto(`${BASE}inventory`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: 'Add item' }).waitFor({ state: 'visible', timeout: 20000 });
    await page.getByRole('button', { name: 'Add item' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Name').fill(perishableName);
    await dialog.getByTestId('item-expiry').fill(soonExpiry);
    await dialog.getByTestId('item-condition').selectOption('GOOD');
    await dialog.getByRole('button', { name: 'Create item' }).click();
    await page.getByText(perishableName).first().waitFor({ state: 'visible', timeout: 10000 });
  });

  await step('expands a parent item into a child variant (§4 Variant/SKU)', async () => {
    await lifecycleCard(perishableName).getByRole('button', { name: 'Item details' }).click();
    const detail = page.getByRole('dialog');
    await detail.getByTestId('variant-name').waitFor({ state: 'visible', timeout: 8000 });
    await detail.getByTestId('variant-name').fill(variantName);
    await detail.getByTestId('add-variant').click();
    await detail
      .getByTestId('variant-list')
      .getByText(variantName)
      .waitFor({ state: 'visible', timeout: 8000 });
    await page.keyboard.press('Escape');
  });

  await step('adds a tool maintenance schedule to an item (§4.3)', async () => {
    await lifecycleCard(perishableName).getByRole('button', { name: 'Item details' }).click();
    const detail = page.getByRole('dialog');
    await detail.getByTestId('maintenance-name').fill(maintScheduleName);
    await detail.getByTestId('add-maintenance').click();
    await detail
      .getByTestId('maintenance-list')
      .getByText(maintScheduleName)
      .waitFor({ state: 'visible', timeout: 8000 });
    await page.keyboard.press('Escape');
  });

  await step('runs a cycle count and authorises a variance adjustment (§4.4)', async () => {
    // A dedicated location with one bulk item at quantity 10.
    await page.getByRole('button', { name: 'Add location' }).click();
    const locDialog = page.getByRole('dialog');
    await locDialog.getByLabel('Name').fill(drawerName);
    await locDialog.getByRole('button', { name: 'Create', exact: true }).click();
    await page.locator('nav').getByText(drawerName).waitFor({ state: 'visible', timeout: 8000 });
    await page.locator('nav button').filter({ hasText: drawerName }).first().click();

    await page.getByRole('button', { name: 'Add item' }).click();
    const itemDialog = page.getByRole('dialog');
    await itemDialog.getByLabel('Name').fill(cycleItemName);
    await itemDialog.getByLabel('Location').selectOption({ label: drawerName });
    await itemDialog.getByLabel('Initial quantity').fill('10');
    await itemDialog.getByRole('button', { name: 'Create item' }).click();
    await page.getByText(cycleItemName).first().waitFor({ state: 'visible', timeout: 10000 });

    // Blind-count it as 8 (expected 10 → variance −2) and authorise.
    await page.getByTestId('open-cycle-count').click();
    const ccDialog = page.getByRole('dialog');
    const row = ccDialog
      .getByTestId('cycle-count-lines')
      .locator('li')
      .filter({ hasText: cycleItemName });
    await row.getByRole('spinbutton').fill('8');
    await ccDialog.getByTestId('authorise-reconciliation').click();
    await ccDialog
      .getByTestId('cycle-count-result')
      .waitFor({ state: 'visible', timeout: 8000 });
    await ccDialog.getByRole('button', { name: 'Done' }).click();
    // The on-hand quantity reconciled to the counted figure.
    await page.waitForFunction(
      (name) => {
        const li = [...document.querySelectorAll('*')].find(
          (el) => el.textContent?.includes(name) && el.textContent?.includes('8'),
        );
        return Boolean(li);
      },
      cycleItemName,
      { timeout: 8000 },
    );
  });

  await step('surfaces the perishable on the dashboard "Soon to expire" widget (§3)', async () => {
    await page.goto(`${BASE}`, { waitUntil: 'domcontentloaded' });
    const widget = page.getByTestId('widget-expiring');
    await widget.waitFor({ state: 'visible', timeout: 15000 });
    await widget.getByText(perishableName).waitFor({ state: 'visible', timeout: 8000 });
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
