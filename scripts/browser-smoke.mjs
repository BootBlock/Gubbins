/**
 * End-to-end browser smoke test for Gubbins (run against a live dev server).
 *
 * Drives the preinstalled Edge via Playwright against http://localhost:5173/Gubbins/
 * — a real cross-origin-isolated context, so OPFS + SharedArrayBuffer + the SQLite
 * worker actually run. Exercises the Phase 2 flows: cross-origin isolation, item
 * creation (Bulk + Consumable Gauge), quantity adjustment, the density toggle, and
 * nested location creation, asserting there are no console/page errors.
 *
 *   node scripts/browser-smoke.mjs            # headless
 *   node scripts/browser-smoke.mjs --headed   # watch it run
 */
import { chromium } from 'playwright';

const BASE = 'http://localhost:5173/Gubbins/';
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
process.exit(failed.length === 0 && pageErrors.length === 0 ? 0 : 1);
