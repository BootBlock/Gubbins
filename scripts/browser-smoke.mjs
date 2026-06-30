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
 * stock, and move a line into the "In Transit" procurement state (plus the Phase 58
 * §4 budgeting flow: set a project budget, record an expense, and see the over-budget
 * status surface); plus the Phase 5
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
 * existing item through the §4 no-overwrite review (a populated field stays put);
 * plus the Phase 13 flow (§9 multi-scrape hardening): capturing the requestId the PWA
 * stamps on each outbound SCRAPE_REQUEST and proving a well-formed result carrying the
 * WRONG requestId is ignored while the correlated id fills the form;
 * plus the Phase 10 flows: being directed from the critical storage banner into the
 * §7.6.2 Storage Triage Dashboard (per-table OPFS breakdown), pruning old activity
 * history through the §7.6.3 Workflow A cold-storage JSON download (which must fire
 * before the delete), and downgrading old images (§7.6.3 Workflow B) to drop the
 * full-resolution file while keeping the thumbnail;
 * plus the Phase 11 flows (sync-set expansion): asserting the versioned-JSON backup now
 * carries the widened set — the `item_tags` membership, the `item_history` ledger and
 * base64-encoded `item_images` thumbnails (with the local-only §7.6.3-B downgrade marker
 * held back) — and that an item's tag and image survive the full download → import →
 * re-sync round-trip;
 * plus the Phase 12 flows (Settings & preferences UI, §3): opening Settings from the
 * dashboard gear and proving the theme toggle is actually applied to the document
 * (`.dark` on <html>), that preference controls (the §4 expiry window and the §7.6.3
 * prune window) persist to localStorage, and that the Storage Triage dashboard now has
 * a permanent entry-point (independent of the critical/locked banner) that honours the
 * saved default window;
 * plus the Phase 14 flows (export/import & sync resilience, §2.7/§3/§4.5/§7): unzipping
 * the Markdown vault to prove full-resolution images are extracted out of OPFS into
 * /assets (§4.5), running a scoped single-item export (§4.5 granularity), and asserting
 * the live OPFS database is a valid raw .sqlite binary that round-trips an OPFS
 * overwrite→reread (the restore premise, §3);
 * plus the Phase 15 flows (scanner/search/perf polish, §6.6): weighted-capability
 * "best match" ranking (a HAS_CAPABILITY query surfaces the heavier-weighted item
 * first), the Storage Triage image figure now being *measured* from the real on-disk
 * OPFS files (§7.6.2), and — in a dedicated mobile-emulation context — the §2.7 weekly
 * Full-Archive banner downloading a zip (carried-over Phase-14 residual) and the §6.6
 * WASM scanner fallback engine resolving when the native BarcodeDetector is absent;
 * plus the Phase 16 flows (Backlog polish, §3/§2.1): the chosen base currency
 * propagating end-to-end (switching to USD re-renders the project BOM total via the
 * `useFormatters` hook), and the new "System" theme tracking the emulated OS
 * `prefers-color-scheme` live;
 * plus the Phase 64 flow (aria-live Tier B, §3 WCAG 4.1.3): the Projects, Contacts,
 * and Purchase-Orders master-list result-count regions are always-mounted polite
 * live regions that announce the list count or empty state once data loads.
 * Asserts there are no console/page errors.
 *
 *   node scripts/browser-smoke.mjs            # headless
 *   node scripts/browser-smoke.mjs --headed   # watch it run
 */
import zlib from 'node:zlib';
import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
// When set, run ONLY the self-contained §2 PWA update-handshake block (which spins up
// its own production-build static server) and skip every dev-server-dependent step —
// so the handshake can be verified against a `npm run build` with no dev server running.
const PWA_ONLY = !!process.env.SMOKE_PWA_ONLY;
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
// Cap Playwright's implicit action timeout (default 30s) so a failing click/fill/
// selectOption surfaces in 5s instead of hanging the whole run for half a minute —
// if an action takes longer than this against a local dev server, something is wrong.
// Navigation keeps more headroom for the first cold-start app + sqlite-wasm boot.
page.setDefaultTimeout(5000);
page.setDefaultNavigationTimeout(10000);

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
const subVariantName = `Subvar ${stamp}`;
const drawerName = `Drawer ${stamp}`;
const cycleItemName = `Smoke Count ${stamp}`;
const checkoutBorrower = `Smoke Borrower ${stamp}`;
const serialAuditName = `Smoke Serial ${stamp}`;
const batchItemName = `Smoke Batch ${stamp}`;
const batchNo = `LOT-${stamp}`;
const maintScheduleName = `Lube ${stamp}`;
const loanScheduleName = `Recalibrate ${stamp}`;
const scopedScheduleName = `Bench calibrate ${stamp}`;
// An expiry a few days out so it classifies as "expiring soon" (§4 / dashboard widget).
const soonExpiry = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10);

// A small valid PNG, enough for the canvas→WebP compression pipeline to decode.
const pngBuffer = makePng(8);

try {
  if (PWA_ONLY) {
    console.log(
      '  ⓘ SMOKE_PWA_ONLY set — skipping the dev-server steps; running only the §2 PWA update handshake.',
    );
  }
  // The whole dev-server-dependent suite is gated so SMOKE_PWA_ONLY can drive just the
  // self-contained §2 PWA block (which serves its own production build). Default runs all.
  if (!PWA_ONLY) {
  await step('loads and reaches the inventory workspace', async () => {
    await page.goto(`${BASE}inventory`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: 'Add item' }).waitFor({ state: 'visible', timeout: 10000 });
  });

  await step('context is cross-origin isolated (OPFS/SharedArrayBuffer)', async () => {
    const isolated = await page.evaluate(() => self.crossOriginIsolated === true);
    if (!isolated) throw new Error('crossOriginIsolated is false');
    const hasSab = await page.evaluate(() => typeof SharedArrayBuffer !== 'undefined');
    if (!hasSab) throw new Error('SharedArrayBuffer unavailable');
  });

  await step('the skip-to-content link bypasses nav to the main landmark (§3 / WCAG 2.4.1)', async () => {
    // Reset focus to the top of the document; the skip link is the first focusable
    // element on every route, so a single Tab must land on it.
    await page.evaluate(() => {
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    });
    await page.keyboard.press('Tab');
    const onSkipLink = await page.evaluate(
      () => document.activeElement?.textContent?.trim() === 'Skip to content',
    );
    if (!onSkipLink) throw new Error('first Tab did not land on the skip-to-content link');

    // Activating it moves focus past the header nav to the screen's #main-content landmark.
    await page.keyboard.press('Enter');
    const onMain = await page.evaluate(() => {
      const el = document.activeElement;
      return !!el && el.id === 'main-content' && el.tagName === 'MAIN';
    });
    if (!onMain) throw new Error('activating the skip link did not focus the #main-content landmark');

    // The inventory result-count region announces result changes politely (aria-live).
    const hasLiveStatus = await page.evaluate(
      () => !!document.querySelector('#main-content [role="status"][aria-live="polite"]'),
    );
    if (!hasLiveStatus) throw new Error('inventory status region is not an aria-live polite status');
  });

  await step('a dialog traps focus and restores it on close (§3 accessible modal)', async () => {
    // The opener takes focus, then opens the accessible Foundry Modal.
    const opener = page.getByRole('button', { name: 'Add item' });
    await opener.focus();
    await opener.click();
    const dialog = page.getByRole('dialog', { name: 'Add item' });
    await dialog.waitFor({ state: 'visible', timeout: 5000 });

    // Focus moved into the dialog on open.
    const focusInDialogOnOpen = await page.evaluate(() => {
      const d = document.querySelector('[role="dialog"]');
      return !!d && (document.activeElement === d || d.contains(document.activeElement));
    });
    if (!focusInDialogOnOpen) throw new Error('focus did not move into the dialog on open');

    // Tabbing many times never escapes the dialog (the aria-modal trap).
    for (let i = 0; i < 12; i += 1) await page.keyboard.press('Tab');
    const trapped = await page.evaluate(() => {
      const d = document.querySelector('[role="dialog"]');
      return !!d && d.contains(document.activeElement);
    });
    if (!trapped) throw new Error('focus escaped the dialog while tabbing');

    // Shift+Tab also stays trapped.
    for (let i = 0; i < 3; i += 1) await page.keyboard.press('Shift+Tab');
    const stillTrapped = await page.evaluate(() => {
      const d = document.querySelector('[role="dialog"]');
      return !!d && d.contains(document.activeElement);
    });
    if (!stillTrapped) throw new Error('focus escaped the dialog on Shift+Tab');

    // Escape closes it and returns focus to the opener.
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'hidden', timeout: 5000 });
    const restored = await page.evaluate(
      () => document.activeElement?.textContent?.includes('Add item') ?? false,
    );
    if (!restored) throw new Error('focus was not restored to the opener on close');
  });

  await step('an invalid form submit announces & associates the field error (§3 / WCAG 3.3.1)', async () => {
    await page.getByRole('button', { name: 'Add item' }).click();
    const dialog = page.getByRole('dialog', { name: 'Add item' });
    await dialog.waitFor({ state: 'visible', timeout: 5000 });
    // Submit with an empty Name → Zod rejects and the Foundry FormField surfaces the error.
    await dialog.getByRole('button', { name: 'Create item' }).click();
    await dialog
      .getByRole('alert')
      .filter({ hasText: 'enter a name' })
      .first()
      .waitFor({ state: 'visible', timeout: 5000 });
    // The Name control is marked aria-invalid and described by that announced alert.
    const wired = await page.evaluate(() => {
      const d = document.querySelector('[role="dialog"]');
      const input = d?.querySelector('input[aria-invalid="true"]');
      const describedby = input?.getAttribute('aria-describedby');
      if (!describedby) return false;
      const desc = d?.querySelector(`#${CSS.escape(describedby)}`);
      return (
        !!desc && desc.getAttribute('role') === 'alert' && /enter a name/i.test(desc.textContent ?? '')
      );
    });
    if (!wired) throw new Error('the invalid Name field is not wired to its announced error');
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'hidden', timeout: 5000 });
  });

  await step('kiosk mode keeps the dashboard awake and contained (§3 Kiosk & Tablet)', async () => {
    // Record every Screen Wake Lock request the app makes, on this and later loads.
    await page.addInitScript(() => {
      window.__wakeLockRequests = 0;
      const wl = navigator.wakeLock;
      if (wl && typeof wl.request === 'function') {
        const orig = wl.request.bind(wl);
        wl.request = (type) => {
          window.__wakeLockRequests += 1;
          return orig(type);
        };
      }
    });

    // Opt into kiosk mode via the Settings control (default is off).
    await page.goto(`${BASE}settings`, { waitUntil: 'domcontentloaded' });
    const kiosk = page.getByTestId('setting-kiosk-mode');
    await kiosk.waitFor({ state: 'visible', timeout: 5000 });
    await kiosk.selectOption('on');

    // The dashboard now applies the §3 touch/selection containment to its landmark…
    await page.goto(`${BASE}`, { waitUntil: 'domcontentloaded' });
    const main = page.locator('main#main-content[data-kiosk="on"]');
    await main.waitFor({ state: 'visible', timeout: 5000 });
    const contained = await main.evaluate((el) => {
      const cs = getComputedStyle(el);
      return cs.touchAction.includes('pan-y') && cs.userSelect === 'none';
    });
    if (!contained) throw new Error('kiosk dashboard did not apply touch-action/user-select containment');

    // …and requests a screen wake lock where the API exists (else degrades silently).
    const supported = await page.evaluate(() => 'wakeLock' in navigator);
    const requests = await page.evaluate(() => window.__wakeLockRequests ?? 0);
    if (supported && requests < 1) throw new Error('kiosk dashboard did not request a screen wake lock');

    // Turn kiosk mode back off and return to the inventory workspace for later steps.
    await page.goto(`${BASE}settings`, { waitUntil: 'domcontentloaded' });
    await page.getByTestId('setting-kiosk-mode').selectOption('off');
    await page.goto(`${BASE}inventory`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: 'Add item' }).waitFor({ state: 'visible', timeout: 10000 });
  });

  await step('creates a Bulk item', async () => {
    await page.getByRole('button', { name: 'Add item' }).click();
    const dialog = page.getByRole('dialog', { name: 'Add item' });
    await dialog.getByLabel('Name').fill(screwName);
    await dialog.getByLabel('Tracking').selectOption('DISCRETE');
    await dialog.getByLabel('Initial quantity').fill('100');
    await dialog.getByRole('button', { name: 'Create item' }).click();
    await page.getByText(screwName).waitFor({ state: 'visible', timeout: 5000 });
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
    await page.getByText(filamentName).waitFor({ state: 'visible', timeout: 5000 });
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
    // §4 location description + colour swatch (Phase 54).
    await dialog.getByLabel('Description (optional)').fill('Main bench area');
    await dialog.getByRole('radio', { name: 'Teal' }).click();
    await dialog.getByRole('button', { name: 'Create' }).click();
    await page.getByText(`Workshop ${stamp}`).waitFor({ state: 'visible', timeout: 5000 });

    await page.getByRole('button', { name: 'Add location' }).click();
    dialog = page.getByRole('dialog', { name: 'Add location' });
    await dialog.getByLabel('Name').fill(`Shelf ${stamp}`);
    // The Parent picker is a custom listbox (so each row can show a right-aligned item
    // count); open it and click the option rather than using native selectOption.
    await dialog.getByRole('combobox', { name: 'Parent (optional)' }).click();
    await dialog.getByRole('option', { name: `Workshop ${stamp}` }).click();
    await dialog.getByRole('button', { name: 'Create' }).click();
    await page.getByText(`Shelf ${stamp}`).waitFor({ state: 'visible', timeout: 5000 });
  });

  await step('a location shows its chosen colour swatch and description tooltip (§4, Phase 54)', async () => {
    const workshop = page.getByRole('treeitem', { name: `Workshop ${stamp}` });
    // The name is tinted with the chosen swatch's text token…
    const tinted = workshop.locator('.text-loc-teal');
    await tinted.waitFor({ state: 'visible', timeout: 5000 });
    // …and the description surfaces as a Foundry tooltip on hover.
    await tinted.hover();
    await page.getByRole('tooltip').filter({ hasText: 'Main bench area' }).waitFor({
      state: 'visible',
      timeout: 5000,
    });
  });

  await step('the location tree is keyboard navigable (§3 APG tree)', async () => {
    const tree = page.getByRole('tree', { name: 'Locations' });
    await tree.waitFor({ state: 'visible', timeout: 5000 });

    // The whole tree is a single tab stop (roving tabindex).
    const tabStops = await page.evaluate(
      () => document.querySelectorAll('[role="tree"] [role="treeitem"][tabindex="0"]').length,
    );
    if (tabStops !== 1) throw new Error(`expected one roving tab stop, found ${tabStops}`);

    // Focus "All items" and arrow down into the locations — focus and the tab stop move together.
    await tree.getByRole('treeitem', { name: 'All items' }).focus();
    await page.keyboard.press('ArrowDown');
    const movedIn = await page.evaluate(() => {
      const el = document.activeElement;
      return (
        !!el &&
        el.getAttribute('role') === 'treeitem' &&
        el.getAttribute('aria-label') !== 'All items' &&
        el.getAttribute('tabindex') === '0'
      );
    });
    if (!movedIn) throw new Error('ArrowDown did not move the roving focus into the tree');

    // Workshop (a top-level node) is expanded by default, so its Shelf child shows.
    const workshop = tree.getByRole('treeitem', { name: `Workshop ${stamp}` });
    const shelf = tree.getByRole('treeitem', { name: `Shelf ${stamp}` });
    await shelf.waitFor({ state: 'visible', timeout: 5000 });
    // ArrowLeft collapses it (hiding Shelf); ArrowRight expands it again.
    await workshop.focus();
    await page.keyboard.press('ArrowLeft');
    await shelf.waitFor({ state: 'hidden', timeout: 5000 });
    await workshop.focus();
    await page.keyboard.press('ArrowRight');
    await shelf.waitFor({ state: 'visible', timeout: 5000 });

    // Enter selects the focused location (aria-selected reflects the active filter).
    await workshop.focus();
    await page.keyboard.press('Enter');
    const selected = await page.evaluate((label) => {
      const w = [...document.querySelectorAll('[role="treeitem"]')].find(
        (el) => el.getAttribute('aria-label') === label,
      );
      return w?.getAttribute('aria-selected') === 'true';
    }, `Workshop ${stamp}`);
    if (!selected) throw new Error('Enter did not select the focused location');

    // Restore the "All items" filter so downstream steps see the whole inventory.
    await tree.getByRole('treeitem', { name: 'All items' }).click();
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
    await dialog.getByText(fieldName).waitFor({ state: 'visible', timeout: 5000 });
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
    await page.getByText(printerName).first().waitFor({ state: 'visible', timeout: 5000 });
    await page.waitForFunction(
      (name) =>
        document.querySelectorAll('h3').length > 0 &&
        [...document.querySelectorAll('h3')].filter((h) => h.textContent?.includes(name)).length >= 3,
      printerName,
      { timeout: 5000 },
    );
  });

  await step('opens an item, adds a freeform tag', async () => {
    await printerCard().getByRole('button', { name: 'Item details' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('tab', { name: 'Classification' }).click();
    await dialog.getByLabel('Add a tag').fill(tagName);
    await page.keyboard.press('Enter');
    await dialog.getByText(tagName).waitFor({ state: 'visible', timeout: 5000 });
    await page.keyboard.press('Escape');
  });

  await step('uploads an image through the real OPFS pipeline', async () => {
    await printerCard().getByRole('button', { name: 'Item details' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('tab', { name: 'Media & docs' }).click();
    await dialog.getByLabel('Upload image').setInputFiles({
      name: 'smoke.png',
      mimeType: 'image/png',
      buffer: pngBuffer,
    });
    // A thumbnail must render from the stored DB blob (round-trips the worker).
    await dialog.locator('img').first().waitFor({ state: 'visible', timeout: 8000 });
    await page.keyboard.press('Escape');
  });

  await step('shows the item Activity Log of its immutable ledger (§4, Phase 52)', async () => {
    await printerCard().getByRole('button', { name: 'Item details' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('tab', { name: 'Activity' }).click();
    const log = dialog.getByTestId('activity-log');
    await log.scrollIntoViewIfNeeded();
    await log.waitFor({ state: 'visible', timeout: 5000 });
    // Every item carries at least its CREATED entry; the formatter titles it "Created".
    const entries = dialog.getByTestId('activity-log-entry');
    if ((await entries.count()) === 0) throw new Error('Activity Log rendered no entries');
    await dialog.getByText('Created', { exact: true }).first().waitFor({ state: 'visible', timeout: 5000 });
    await page.keyboard.press('Escape');
  });

  await step('edits §4.1.1 operational parameters and round-trips them (Phase 56)', async () => {
    await printerCard().getByRole('button', { name: 'Item details' }).click();
    let dialog = page.getByRole('dialog');
    await dialog.getByRole('tab', { name: 'Supplier & ops' }).click();
    await dialog.getByTestId('op-meta-add').click();
    await dialog.getByLabel('Parameter 1 name').fill('bed_temp_celsius');
    await dialog.getByLabel('Parameter 1 value').fill('60');
    const saveBtn = dialog.getByTestId('op-meta-save');
    await saveBtn.click();
    // After a successful save the button collapses to its disabled "Saved" state.
    await saveBtn.filter({ hasText: 'Saved' }).waitFor({ state: 'visible', timeout: 5000 });
    await page.keyboard.press('Escape');

    // Reopen — the value must come back from the DB (the item query was invalidated),
    // proving the §4.1.1 metadata persisted through the worker, not just local state.
    await printerCard().getByRole('button', { name: 'Item details' }).click();
    dialog = page.getByRole('dialog');
    await dialog.getByRole('tab', { name: 'Supplier & ops' }).click();
    await dialog.getByLabel('Parameter 1 name').waitFor({ state: 'visible', timeout: 5000 });
    const key = await dialog.getByLabel('Parameter 1 name').inputValue();
    const value = await dialog.getByLabel('Parameter 1 value').inputValue();
    if (key !== 'bed_temp_celsius' || value !== '60') {
      throw new Error(`operational metadata did not round-trip (got "${key}"="${value}")`);
    }
    await page.keyboard.press('Escape');
  });

  await step('sets a per-item reorder point and the Low Stock widget reacts (§4, Phase 59)', async () => {
    // The bulk screws were created with qty 100 — comfortably above the global default
    // (5), so they are NOT in the low-stock feed. Open the item and give it its own,
    // much higher reorder point so it now counts as low.
    await page.goto(`${BASE}inventory`, { waitUntil: 'domcontentloaded' });
    const screwCard = () =>
      page
        .locator('div')
        .filter({ hasText: screwName })
        .filter({ has: page.getByRole('button', { name: 'Item details' }) })
        .last();

    await screwCard().getByRole('button', { name: 'Item details' }).click();
    let dialog = page.getByRole('dialog');
    await dialog.getByRole('tab', { name: 'Supplier & ops' }).click();
    await dialog.getByTestId('reorder-point-input').fill('200');
    await dialog.getByTestId('reorder-qty-input').fill('300');
    const saveBtn = dialog.getByTestId('reorder-point-save');
    await saveBtn.click();
    await saveBtn.filter({ hasText: 'Saved' }).waitFor({ state: 'visible', timeout: 5000 });
    await page.keyboard.press('Escape');

    // Reopen — the override must come back from the DB (the item query was invalidated),
    // proving it persisted through the worker rather than living only in local state.
    await screwCard().getByRole('button', { name: 'Item details' }).click();
    dialog = page.getByRole('dialog');
    await dialog.getByRole('tab', { name: 'Supplier & ops' }).click();
    await dialog.getByTestId('reorder-point-input').waitFor({ state: 'visible', timeout: 5000 });
    const point = await dialog.getByTestId('reorder-point-input').inputValue();
    if (point !== '200') {
      throw new Error(`reorder point did not round-trip (got "${point}")`);
    }
    await page.keyboard.press('Escape');

    // The dashboard Low Stock widget now lists the screws (qty 100 ≤ its own 200 floor),
    // with the suggested top-up surfaced from the per-item reorder quantity.
    await page.goto(`${BASE}`, { waitUntil: 'domcontentloaded' });
    const widget = page.getByTestId('widget-low-stock');
    await widget.waitFor({ state: 'visible', timeout: 8000 });
    await widget.getByText(screwName).waitFor({ state: 'visible', timeout: 5000 });
    await widget.getByText(/reorder 300/).waitFor({ state: 'visible', timeout: 5000 });

    // Clear the override so the screws return to "healthy" for any later assertions.
    await page.goto(`${BASE}inventory`, { waitUntil: 'domcontentloaded' });
    await screwCard().getByRole('button', { name: 'Item details' }).click();
    dialog = page.getByRole('dialog');
    await dialog.getByRole('tab', { name: 'Supplier & ops' }).click();
    await dialog.getByTestId('reorder-point-input').fill('');
    await dialog.getByTestId('reorder-qty-input').fill('');
    const clearBtn = dialog.getByTestId('reorder-point-save');
    await clearBtn.click();
    await clearBtn.filter({ hasText: 'Saved' }).waitFor({ state: 'visible', timeout: 5000 });
    await page.keyboard.press('Escape');
  });

  await step('adds an editable supplier part and stars it preferred (§4, Phase 60)', async () => {
    await printerCard().getByRole('button', { name: 'Item details' }).click();
    let dialog = page.getByRole('dialog');
    await dialog.getByRole('tab', { name: 'Supplier & ops' }).click();

    // Open the add-supplier dialog and fill it in.
    await dialog.getByTestId('supplier-part-add').click();
    const form = page.getByTestId('supplier-part-form');
    await form.waitFor({ state: 'visible', timeout: 5000 });
    await form.getByTestId('supplier-part-name').fill('SmokeSupplier');
    await form.getByTestId('supplier-part-order-code').fill('SMK-001');
    await form.getByTestId('supplier-part-unit-cost').fill('1.25');
    await form.getByTestId('supplier-part-breaks').fill('10:1.10\n100:0.95');
    await form.getByTestId('supplier-part-save').click();

    // The new row appears in the suppliers list.
    const row = dialog.getByTestId('supplier-part-row').filter({ hasText: 'SmokeSupplier' });
    await row.waitFor({ state: 'visible', timeout: 5000 });
    // Star it preferred; the "Preferred" badge then renders.
    await row.getByTestId('supplier-part-prefer').click();
    await row.getByText('Preferred', { exact: true }).waitFor({ state: 'visible', timeout: 5000 });
    await page.keyboard.press('Escape');

    // Reopen — the supplier part must come back from the DB (the item query was invalidated),
    // proving it persisted through the worker rather than living only in local state.
    await printerCard().getByRole('button', { name: 'Item details' }).click();
    dialog = page.getByRole('dialog');
    await dialog.getByRole('tab', { name: 'Supplier & ops' }).click();
    const reopened = dialog.getByTestId('supplier-part-row').filter({ hasText: 'SmokeSupplier' });
    await reopened.waitFor({ state: 'visible', timeout: 5000 });
    await reopened.getByText('Preferred', { exact: true }).waitFor({ state: 'visible', timeout: 5000 });
    // Remove it again so later supplier-focused steps start clean.
    await reopened.getByTestId('supplier-part-remove').click();
    await dialog
      .getByTestId('supplier-part-row')
      .filter({ hasText: 'SmokeSupplier' })
      .waitFor({ state: 'detached', timeout: 5000 });
    await page.keyboard.press('Escape');
  });

  await step('opens the Reports screen and renders a non-zero inventory value (§3, Phase 61)', async () => {
    // Give the inventory a priced item so the valuation headline is non-zero. (The earlier
    // smoke items carry no unit cost.) Created on the inventory screen via the Add dialog.
    await page.goto(`${BASE}inventory`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: 'Add item' }).click();
    const addDialog = page.getByRole('dialog', { name: 'Add item' });
    await addDialog.getByLabel('Name').fill(`Smoke Priced ${stamp}`);
    await addDialog.getByLabel('Tracking').selectOption('DISCRETE');
    await addDialog.getByLabel('Initial quantity').fill('8');
    await addDialog.getByLabel('Unit cost (optional)').fill('12.50');
    await addDialog.getByRole('button', { name: 'Create item' }).click();
    await page.getByText(`Smoke Priced ${stamp}`).waitFor({ state: 'visible', timeout: 5000 });

    // Open the Reports screen and assert the headline value card shows a real total.
    await page.goto(`${BASE}reports`, { waitUntil: 'domcontentloaded' });
    const total = page.getByTestId('stat-total-value');
    await total.waitFor({ state: 'visible', timeout: 8000 });
    const totalText = (await total.textContent())?.trim() ?? '';
    // Must be a currency figure, not the "—" placeholder or a zero total.
    if (!/[1-9]/.test(totalText)) {
      throw new Error(`Reports inventory value did not render a non-zero total (got "${totalText}")`);
    }

    // The valuation breakdown and the movement chart legend are present.
    await page.getByTestId('value-breakdown').first().waitFor({ state: 'visible', timeout: 5000 });

    // The CSV export flows through the shared Export Wizard's "Report CSV" format.
    await page.getByTestId('open-report-export').click();
    const exportDialog = page.getByRole('dialog', { name: 'Export' });
    await exportDialog.getByRole('button', { name: 'Report CSV' }).click();
    await exportDialog.getByTestId('export-report-kind').waitFor({ state: 'visible', timeout: 5000 });
    // Restore the remembered format to the default so later export steps (which assume an
    // items-scoped export) open the wizard on JSON, not the Report-CSV format (§3 last-used).
    await exportDialog.getByRole('button', { name: 'JSON data export' }).click();
    await exportDialog.getByTestId('export-scope').waitFor({ state: 'visible', timeout: 5000 });
    await page.keyboard.press('Escape');
  });

  await step('creates a purchase order, receives a line and lifts on-hand stock (§4, Phase 62)', async () => {
    const poItemName = `Smoke PO Part ${stamp}`;

    // A fresh discrete item starting at qty 2 — the receipt must lift its on-hand stock.
    await page.goto(`${BASE}inventory`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: 'Add item' }).click();
    const addDialog = page.getByRole('dialog', { name: 'Add item' });
    await addDialog.getByLabel('Name').fill(poItemName);
    await addDialog.getByLabel('Tracking').selectOption('DISCRETE');
    await addDialog.getByLabel('Initial quantity').fill('2');
    await addDialog.getByRole('button', { name: 'Create item' }).click();
    await page.getByText(poItemName).waitFor({ state: 'visible', timeout: 5000 });

    // Create a purchase order.
    await page.goto(`${BASE}purchase-orders`, { waitUntil: 'domcontentloaded' });
    await page.getByTestId('po-new').click();
    const createForm = page.getByTestId('po-create-form');
    await createForm.waitFor({ state: 'visible', timeout: 5000 });
    await createForm.getByTestId('po-supplier-name').fill('SmokePO Supplier');
    await createForm.getByTestId('po-reference').fill(`PO-${stamp}`);
    await createForm.getByTestId('po-create-save').click();
    await page.getByTestId('po-detail-status').waitFor({ state: 'visible', timeout: 5000 });

    // Add a line for the new item, ordering 7 units.
    await page.getByTestId('po-add-line').click();
    const lineForm = page.getByTestId('po-line-form');
    await lineForm.waitFor({ state: 'visible', timeout: 5000 });
    await lineForm.getByTestId('po-line-item').selectOption({ label: poItemName });
    await lineForm.getByTestId('po-line-qty').fill('7');
    await lineForm.getByTestId('po-line-save').click();
    await page.getByTestId('po-line-row').filter({ hasText: poItemName }).waitFor({ state: 'visible', timeout: 5000 });

    // Move the order out of DRAFT so the line can be received.
    await page.getByTestId('po-mark-ordered').click();

    // Receive the whole outstanding quantity (defaults to 7).
    await page.getByTestId('po-receive-line').click();
    const receiveForm = page.getByTestId('po-receive-form');
    await receiveForm.waitFor({ state: 'visible', timeout: 5000 });
    await receiveForm.getByTestId('po-receive-save').click();

    // The order derives to RECEIVED once every line is fully received.
    await page.getByTestId('po-detail-status').filter({ hasText: 'Received' }).waitFor({ state: 'visible', timeout: 5000 });

    // On-hand stock rose from 2 to 9 (2 + 7). Assert on the item's inventory card.
    await page.goto(`${BASE}inventory`, { waitUntil: 'domcontentloaded' });
    const poCard = page
      .locator('div')
      .filter({ hasText: poItemName })
      .filter({ has: page.getByRole('button', { name: 'Item details' }) })
      .last();
    await poCard.waitFor({ state: 'visible', timeout: 8000 });
    await poCard.getByText('9', { exact: true }).first().waitFor({ state: 'visible', timeout: 8000 });
  });

  await step('Reports screen aria-live region announces aggregate completion (§3, Phase 63)', async () => {
    // Navigate to the Reports screen (a priced item already exists from Phase 61 step).
    await page.goto(`${BASE}reports`, { waitUntil: 'domcontentloaded' });

    // The always-mounted polite status region must exist in the DOM immediately.
    const liveRegion = page.getByTestId('reports-live-region');
    await liveRegion.waitFor({ state: 'attached', timeout: 5000 });
    if ((await liveRegion.getAttribute('role')) !== 'status') {
      throw new Error('reports live region does not have role="status"');
    }
    if ((await liveRegion.getAttribute('aria-live')) !== 'polite') {
      throw new Error('reports live region is not aria-live="polite"');
    }

    // Wait for the stat cards to finish loading (the headline value renders), then assert
    // the region's text content becomes non-empty — the aggregate "ready" announcement.
    await page.getByTestId('stat-total-value').waitFor({ state: 'visible', timeout: 8000 });
    await page.waitForFunction(
      () => {
        const el = document.querySelector('[data-testid="reports-live-region"]');
        return el != null && (el.textContent ?? '').trim().length > 0;
      },
      { timeout: 5000 },
    );
    const text = await liveRegion.textContent();
    if (!text || text.trim().length === 0) {
      throw new Error('reports live region did not announce a completion message');
    }
  });

  await step('Projects / Contacts / PO master-list result-count regions are aria-live polite (§3, Phase 64)', async () => {
    // Projects screen — the projects-count-live region must be mounted (always)
    // and announce a non-empty count or empty state after data loads.
    await page.goto(`${BASE}projects`, { waitUntil: 'domcontentloaded' });
    const projectsLive = page.getByTestId('projects-count-live');
    await projectsLive.waitFor({ state: 'attached', timeout: 5000 });
    if ((await projectsLive.getAttribute('role')) !== 'status') {
      throw new Error('projects-count-live does not have role="status"');
    }
    if ((await projectsLive.getAttribute('aria-live')) !== 'polite') {
      throw new Error('projects-count-live is not aria-live="polite"');
    }
    // Wait for the list to resolve then check the region carries text.
    await page.waitForFunction(
      () => {
        const el = document.querySelector('[data-testid="projects-count-live"]');
        return el != null && (el.textContent ?? '').trim().length > 0;
      },
      { timeout: 5000 },
    );

    // Contacts screen — both on-loan and contacts count regions must be present.
    await page.goto(`${BASE}contacts`, { waitUntil: 'domcontentloaded' });
    const onLoanLive = page.getByTestId('contacts-on-loan-live');
    const contactsLive = page.getByTestId('contacts-count-live');
    await onLoanLive.waitFor({ state: 'attached', timeout: 5000 });
    await contactsLive.waitFor({ state: 'attached', timeout: 5000 });
    if ((await onLoanLive.getAttribute('role')) !== 'status') {
      throw new Error('contacts-on-loan-live does not have role="status"');
    }
    if ((await contactsLive.getAttribute('role')) !== 'status') {
      throw new Error('contacts-count-live does not have role="status"');
    }
    if ((await onLoanLive.getAttribute('aria-live')) !== 'polite') {
      throw new Error('contacts-on-loan-live is not aria-live="polite"');
    }
    if ((await contactsLive.getAttribute('aria-live')) !== 'polite') {
      throw new Error('contacts-count-live is not aria-live="polite"');
    }
    // Both regions must announce something once data loads.
    await page.waitForFunction(
      () => {
        const a = document.querySelector('[data-testid="contacts-on-loan-live"]');
        const b = document.querySelector('[data-testid="contacts-count-live"]');
        return a != null && (a.textContent ?? '').trim().length > 0
          && b != null && (b.textContent ?? '').trim().length > 0;
      },
      { timeout: 5000 },
    );

    // Purchase orders screen — master-list count region must be present and announce.
    await page.goto(`${BASE}purchase-orders`, { waitUntil: 'domcontentloaded' });
    const poListLive = page.getByTestId('po-list-count-live');
    await poListLive.waitFor({ state: 'attached', timeout: 5000 });
    if ((await poListLive.getAttribute('role')) !== 'status') {
      throw new Error('po-list-count-live does not have role="status"');
    }
    if ((await poListLive.getAttribute('aria-live')) !== 'polite') {
      throw new Error('po-list-count-live is not aria-live="polite"');
    }
    await page.waitForFunction(
      () => {
        const el = document.querySelector('[data-testid="po-list-count-live"]');
        return el != null && (el.textContent ?? '').trim().length > 0;
      },
      { timeout: 5000 },
    );
  });

  await step('degrades a foreign local-pointer datasheet to "Unlinked Local File" (§4, Phase 53)', async () => {
    const datasheetPath = `C:\\smoke\\${stamp}.pdf`;
    const datasheetUrl = `https://smoke.test/${stamp}.pdf`;

    // Option B (Hybrid Pointers) must be enabled before a LOCAL_POINTER can be added.
    // Settings is reached from the dashboard root (the Inventory screen has no gear).
    await page.goto(`${BASE}`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('link', { name: 'Settings' }).first().click();
    await page.getByRole('heading', { name: 'Settings' }).waitFor({ state: 'visible', timeout: 6000 });
    await page.getByLabel('Attachment mode').selectOption('HYBRID');
    await page.goto(`${BASE}inventory`, { waitUntil: 'domcontentloaded' });
    await printerCard().getByRole('button', { name: 'Item details' }).waitFor({ state: 'visible', timeout: 8000 });

    // Link a local file pointer — it is stamped with *this* device's id.
    await printerCard().getByRole('button', { name: 'Item details' }).click();
    let dialog = page.getByRole('dialog');
    await dialog.getByRole('tab', { name: 'Media & docs' }).click();
    await dialog.getByLabel('Attachment kind').selectOption('LOCAL_POINTER');
    await dialog.getByLabel('Attachment location').fill(datasheetPath);
    await dialog.getByRole('button', { name: 'Link datasheet' }).click();
    await dialog.getByText(datasheetPath, { exact: false }).first().waitFor({ state: 'visible', timeout: 5000 });
    await page.keyboard.press('Escape');

    // Simulate opening the synced database on a *different* device, then reload.
    await page.evaluate(() => localStorage.setItem('gubbins:device-id', 'smoke-other-device'));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await printerCard().getByRole('button', { name: 'Item details' }).waitFor({ state: 'visible', timeout: 8000 });

    // The same pointer now degrades to the "Unlinked Local File" placeholder (§4).
    await printerCard().getByRole('button', { name: 'Item details' }).click();
    dialog = page.getByRole('dialog');
    await dialog.getByRole('tab', { name: 'Media & docs' }).click();
    const unlinked = dialog.getByTestId('attachment-unlinked');
    await unlinked.scrollIntoViewIfNeeded();
    await unlinked.waitFor({ state: 'visible', timeout: 5000 });
    await dialog.getByText('Unlinked Local File', { exact: true }).first().waitFor({ state: 'visible', timeout: 5000 });

    // Replace it with an external URL via the degradation flow.
    await dialog.getByTestId('attachment-use-url').click();
    await dialog.getByTestId('attachment-relink-input').fill(datasheetUrl);
    await dialog.getByTestId('attachment-relink-confirm').click();
    // The placeholder is gone and the datasheet is now a working link.
    await unlinked.waitFor({ state: 'detached', timeout: 5000 });
    await dialog.getByRole('link', { name: datasheetUrl }).waitFor({ state: 'visible', timeout: 5000 });
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
    await page.getByRole('button', { name: 'New project' }).waitFor({ state: 'visible', timeout: 8000 });
    await page.getByRole('button', { name: 'New project' }).click();
    const dialog = page.getByRole('dialog', { name: 'New project' });
    await dialog.getByLabel('Name').fill(projectName);
    await dialog.getByRole('button', { name: 'Create project' }).click();
    // The new project becomes selected and its BOM workspace appears.
    await page.getByRole('heading', { name: 'Bill of materials' }).waitFor({ state: 'visible', timeout: 5000 });
  });

  await step('creates and then deletes a throwaway project', async () => {
    // A self-contained create→delete round-trip on a disposable project, so the main
    // `projectName` workspace (which later steps depend on) is left untouched.
    const throwaway = `Smoke Delete ${stamp}`;
    await page.getByRole('button', { name: 'New project' }).click();
    const dialog = page.getByRole('dialog', { name: 'New project' });
    await dialog.getByLabel('Name').fill(throwaway);
    await dialog.getByRole('button', { name: 'Create project' }).click();
    // Newest-first ordering means the throwaway is auto-selected; its header h2 confirms it.
    await page.getByRole('heading', { level: 2, name: throwaway }).waitFor({ state: 'visible', timeout: 5000 });

    // Delete it: the header button opens a confirm Modal, the confirm button does the deed.
    await page.getByTestId('delete-project').click();
    await page.getByRole('dialog', { name: 'Delete project?' }).waitFor({ state: 'visible', timeout: 5000 });
    await page.getByTestId('delete-project-confirm').click();

    // The success toast fires and the throwaway vanishes from the master list…
    await page.getByText('Project deleted').waitFor({ state: 'visible', timeout: 5000 });
    await page.locator('aside').getByText(throwaway).waitFor({ state: 'detached', timeout: 5000 });
    // …and the selection falls back to the surviving project (its BOM workspace returns).
    await page.getByRole('heading', { name: 'Bill of materials' }).waitFor({ state: 'visible', timeout: 5000 });
  });

  await step('adds a manual BOM line', async () => {
    await page.getByRole('button', { name: 'Add line' }).click();
    const dialog = page.getByRole('dialog', { name: 'Add BOM line' });
    // Match the line to a real inventory item so the project has a component note for the
    // §4.5 Project-scope vault export (the only native <select> in this dialog is item-match).
    await dialog.getByRole('combobox').selectOption({ label: screwName });
    await dialog.getByLabel('Description').fill(partName);
    await dialog.getByLabel('Quantity').fill('5');
    await dialog.getByRole('button', { name: 'Add line' }).click();
    await page.getByText(partName).first().waitFor({ state: 'visible', timeout: 5000 });
  });

  await step('shows the part on the automated shopping list', async () => {
    // The un-reserved, un-ordered line must appear under the Shopping list heading.
    await page.getByRole('heading', { name: /Shopping list/ }).waitFor({ state: 'visible', timeout: 5000 });
    await page.waitForFunction(
      (name) =>
        [...document.querySelectorAll('table')].some((t) => t.textContent?.includes(name)),
      partName,
      { timeout: 5000 },
    );
  });

  await step('toggles the BOM costing mode', async () => {
    const costing = page.getByLabel('Costing mode');
    await costing.selectOption('POINT_IN_TIME');
    await expectSelectValue(costing, 'POINT_IN_TIME', 'Costing mode');
  });

  await step('sets a project budget and records an expense over it (§4 budgeting, Phase 58)', async () => {
    // Set a deliberately small budget so a single expense pushes the project over it.
    await page.getByTestId('set-budget').click();
    let dialog = page.getByRole('dialog', { name: 'Project budget' });
    await dialog.getByTestId('budget-amount-input').fill('10');
    await dialog.getByTestId('budget-save').click();
    await dialog.waitFor({ state: 'hidden', timeout: 5000 });

    // Record a manual expense that exceeds the budget.
    await page.getByTestId('add-expense').click();
    dialog = page.getByRole('dialog', { name: 'Add expense' });
    await dialog.getByLabel('Description').fill('Smoke shipping');
    await dialog.getByTestId('expense-amount-input').fill('25');
    await dialog.getByTestId('expense-save').click();
    await dialog.waitFor({ state: 'hidden', timeout: 5000 });

    // The expense lands in the ledger and the card reports an over-budget status.
    await page.getByText('Smoke shipping').first().waitFor({ state: 'visible', timeout: 5000 });
    await page
      .getByTestId('budget-status')
      .filter({ hasText: 'Over budget' })
      .waitFor({ state: 'visible', timeout: 5000 });
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

  await step('refills a consumable gauge back to full, capped at capacity (§4.1.2)', async () => {
    await page.goto(`${BASE}inventory`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: 'Add item' }).waitFor({ state: 'visible', timeout: 10000 });
    const card = itemCard(filamentName);
    await card.waitFor({ state: 'visible', timeout: 5000 });

    // The gauge was created full (no currentNetValue → defaults to capacity), so first
    // consume 600 g via the relative "Consumption" mode → 400/1000 = 40%.
    await card.getByRole('button', { name: 'Update gauge' }).click();
    let dialog = page.getByRole('dialog');
    await dialog.getByLabel(/Amount used/).fill('600');
    await dialog.getByTestId('gauge-apply').click();
    await dialog.waitFor({ state: 'hidden', timeout: 5000 });
    await card.getByText('40%', { exact: true }).waitFor({ state: 'visible', timeout: 5000 });

    // Now refill: switch to the new Refill mode, tap "Fill to full" (tops off to the
    // 1000 g capacity, never above), apply → back to 100%.
    await card.getByRole('button', { name: 'Update gauge' }).click();
    dialog = page.getByRole('dialog');
    await dialog.getByTestId('gauge-mode-refill').click();
    await dialog.getByTestId('gauge-fill-full').click();
    await dialog.getByTestId('gauge-apply').click();
    await dialog.waitFor({ state: 'hidden', timeout: 5000 });
    await card.getByText('100%', { exact: true }).waitFor({ state: 'visible', timeout: 5000 });
  });

  await step('returns to inventory and runs an FTS5 full-text search', async () => {
    await page.goto(`${BASE}inventory`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: 'Add item' }).waitFor({ state: 'visible', timeout: 10000 });
    const box = page.getByLabel('Search items');
    await box.fill('Screws');
    // The Bulk screw item matches; the filament (no "screws" token) must not.
    await page.getByText(screwName).first().waitFor({ state: 'visible', timeout: 5000 });
    await page.waitForFunction(
      (name) => !document.body.textContent?.includes(name),
      filamentName,
      { timeout: 5000 },
    );
    await box.fill('');
    // Clearing the box restores the full, unfiltered list — wait for it to settle
    // (the filament re-appears) so the next step opens a dialog against a list that
    // is no longer re-rendering and recycling its virtualised rows.
    await page.getByText(filamentName).first().waitFor({ state: 'visible', timeout: 5000 });
  });

  await step('surfaces distinct In-Transit incoming stock on the item (§4, Phase 20)', async () => {
    await itemCard(screwName).getByRole('button', { name: 'Item details' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('tab', { name: 'Lifecycle' }).click();
    const inTransit = dialog.getByTestId('detail-in-transit');
    await inTransit.waitFor({ state: 'visible', timeout: 5000 });
    // The matched BOM line (qty 5) sits IN_TRANSIT → the item shows 5 arriving, kept
    // distinct from on-hand stock (the indicator also carries an "on hand" figure).
    const qty = (await dialog.getByTestId('in-transit-qty').textContent())?.trim();
    if (qty !== '5') throw new Error(`Expected 5 arriving in transit, saw "${qty}"`);
    const text = (await inTransit.textContent()) ?? '';
    if (!/on hand/.test(text)) {
      throw new Error('In-Transit indicator did not distinguish on-hand stock');
    }
    await page.keyboard.press('Escape');
  });

  await step('receives the In-Transit BOM line in partial instalments (§4 split receipts)', async () => {
    await page.goto(`${BASE}projects`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { name: 'Bill of materials' }).waitFor({ state: 'visible', timeout: 8000 });

    // First instalment: receive 2 of the 5 in-transit units — the line stays In-Transit.
    const receiveQty = page.getByLabel('Quantity to receive');
    await receiveQty.waitFor({ state: 'visible', timeout: 5000 });
    await receiveQty.fill('2');
    await page.getByRole('button', { name: 'Receive into stock' }).click();
    await page.getByText('2/5 received').waitFor({ state: 'visible', timeout: 5000 });
    await expectSelectValue(page.getByLabel('Procurement status'), 'IN_TRANSIT', 'Procurement status');

    // The field re-seeds to the outstanding 3; receiving it completes the line → RECEIVED.
    await page.getByRole('button', { name: 'Receive into stock' }).click();
    await expectSelectValue(page.getByLabel('Procurement status'), 'RECEIVED', 'Procurement status');
    await page.getByLabel('Quantity to receive').waitFor({ state: 'detached', timeout: 5000 });

    // Restore the inventory view for the subsequent Phase-5 steps.
    await page.goto(`${BASE}inventory`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: 'Add item' }).waitFor({ state: 'visible', timeout: 10000 });
  });

  await step('adds a weighted capability to an item', async () => {
    await itemCard(screwName).getByRole('button', { name: 'Item details' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('tab', { name: 'Classification' }).click();
    await dialog.getByLabel('Capability key').fill('voltage');
    const value = dialog.getByLabel('Capability value');
    await value.fill('5');
    await value.press('Enter'); // the editor adds on Enter (avoids button-animation flakiness)
    // The new capability chip renders, exposing its remove button.
    await dialog
      .getByRole('button', { name: 'Remove capability voltage' })
      .waitFor({ state: 'visible', timeout: 5000 });
    await page.keyboard.press('Escape');
  });

  await step('builds a Visual-Builder query filtering by capability', async () => {
    await page.getByRole('button', { name: 'Visual search' }).click();
    await page.getByRole('button', { name: 'Add condition' }).click();
    // Switch the condition to a capability HAS_CAPABILITY filter on "voltage".
    await page.getByLabel('Field').selectOption('capability');
    await page.getByLabel('Capability key').fill('voltage');
    // Results now show only items carrying the capability: the screw, not the filament.
    await page.getByText(screwName).first().waitFor({ state: 'visible', timeout: 5000 });
    await page.waitForFunction(
      (name) => !document.body.textContent?.includes(name),
      filamentName,
      { timeout: 5000 },
    );
  });

  // Phase 47 (§3): the hybrid text-based search syntax. Typing `cap:voltage>3.3`
  // parses into the *same* Tier-3 AST the Visual Builder edits (the builder visibly
  // fills in), and the existing parseASTtoSQL → FTS path runs it — the screw
  // (voltage=5) matches, the filament does not. An invalid query surfaces an inline
  // error and keeps the previous results.
  await step('parses a text query into the Visual Builder (§3 hybrid syntax, Phase 47)', async () => {
    await page.goto(`${BASE}inventory`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: 'Add item' }).waitFor({ state: 'visible', timeout: 10000 });
    await page.getByRole('button', { name: 'Visual search' }).click();

    const textInput = page.locator('[data-testid="text-search-input"]');
    await textInput.waitFor({ state: 'visible', timeout: 5000 });
    await textInput.fill('cap:voltage>3.3');
    await textInput.press('Enter');

    // The graphical builder reflected the parsed condition (one source of truth).
    await expectSelectValue(page.getByLabel('Field'), 'capability', 'Field');
    const keyInput = page.getByLabel('Capability key');
    if ((await keyInput.inputValue()) !== 'voltage') {
      throw new Error('text query did not populate the builder capability key');
    }

    // Results are filtered exactly as the graphical capability query was.
    await page.getByText(screwName).first().waitFor({ state: 'visible', timeout: 5000 });
    await page.waitForFunction(
      (name) => !document.body.textContent?.includes(name),
      filamentName,
      { timeout: 5000 },
    );

    // An invalid query reports inline and does not blank the existing search.
    await textInput.fill('quantity>lots');
    await textInput.press('Enter');
    await page
      .locator('[data-testid="text-search-error"]')
      .waitFor({ state: 'visible', timeout: 5000 });
    await page.getByText(screwName).first().waitFor({ state: 'visible', timeout: 5000 });
  });

  // Phase 48 (§3): text-search grammar depth (OR / parentheses) + saved searches.
  // A parenthesised OR query parses into a *nested* AST and runs through the same
  // parseASTtoSQL → FTS path; the query can then be named, recalled and deleted.
  await step('parses an OR / parenthesised query and saves it (§3 grammar depth, Phase 48)', async () => {
    await page.goto(`${BASE}inventory`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: 'Add item' }).waitFor({ state: 'visible', timeout: 10000 });
    await page.getByRole('button', { name: 'Visual search' }).click();

    const textInput = page.locator('[data-testid="text-search-input"]');
    await textInput.waitFor({ state: 'visible', timeout: 5000 });
    // Only the screw carries voltage; the other OR branch is a never-matching capability,
    // so the parenthesised OR narrows to exactly the screw (proving the nested AST ran).
    await textInput.fill('(cap:voltage>3.3 OR cap:nonexistent)');
    await textInput.press('Enter');

    await page.getByText(screwName).first().waitFor({ state: 'visible', timeout: 5000 });
    await page.waitForFunction(
      (name) => !document.body.textContent?.includes(name),
      filamentName,
      { timeout: 5000 },
    );

    // Save the query under a name → a recall chip appears.
    await page.locator('[data-testid="saved-search-save"]').click();
    await page.locator('[data-testid="saved-search-name"]').fill('Voltage parts');
    await page.locator('[data-testid="saved-search-confirm"]').click();
    const chip = page.locator('[data-testid="saved-search-recall"]', { hasText: 'Voltage parts' });
    await chip.waitFor({ state: 'visible', timeout: 5000 });

    // Clear the builder (the filament returns), then recall the saved search → the same
    // filtered result comes back, proving the stored query re-parses and runs.
    await page.getByRole('button', { name: 'Clear' }).click();
    await page.getByText(filamentName).first().waitFor({ state: 'visible', timeout: 5000 });
    await chip.click();
    await page.getByText(screwName).first().waitFor({ state: 'visible', timeout: 5000 });
    await page.waitForFunction(
      (name) => !document.body.textContent?.includes(name),
      filamentName,
      { timeout: 5000 },
    );

    // Tidy up so the saved chip doesn't linger into later steps.
    await page.locator('[data-testid="saved-search-remove"]').first().click();
  });

  // Phase 15 (§4/§5.1): weighted-capability "best match" ranking. Two items share a
  // capability key with different weights; a HAS_CAPABILITY query must surface the
  // heavier-weighted one first (beating the alphabetical fallback).
  await step('ranks capability matches by weight — best match ordering (§4, §5.1)', async () => {
    await page.goto(`${BASE}inventory`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: 'Add item' }).waitFor({ state: 'visible', timeout: 10000 });
    // Heavy weight on the screw, light on the filament — so weight, not name, decides.
    for (const [name, w] of [
      [screwName, '9'],
      [filamentName, '1'],
    ]) {
      await itemCard(name).getByRole('button', { name: 'Item details' }).click();
      const dialog = page.getByRole('dialog');
      await dialog.getByRole('tab', { name: 'Classification' }).click();
      await dialog.getByLabel('Capability key').fill('rankcap');
      await dialog.getByLabel('Capability value').fill('1');
      await dialog.getByLabel('Capability weight').fill(w);
      await dialog.getByRole('button', { name: 'Add capability' }).click();
      await dialog
        .getByRole('button', { name: 'Remove capability rankcap' })
        .waitFor({ state: 'visible', timeout: 5000 });
      await page.keyboard.press('Escape');
    }
    // Query the shared capability — both items match; ranking decides their order.
    await page.getByRole('button', { name: 'Visual search' }).click();
    await page.getByRole('button', { name: 'Add condition' }).click();
    await page.getByLabel('Field').selectOption('capability');
    await page.getByLabel('Capability key').fill('rankcap');
    await itemCard(screwName).waitFor({ state: 'visible', timeout: 5000 });
    await itemCard(filamentName).waitFor({ state: 'visible', timeout: 5000 });
    // Compare render (DOM document) order — robust to grid vs list density, where two
    // cards can share a row. The heavier-weighted screw must precede the filament.
    const screwEl = await itemCard(screwName).elementHandle();
    const filamentEl = await itemCard(filamentName).elementHandle();
    const screwFirst = await page.evaluate(
      ([a, b]) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING),
      [screwEl, filamentEl],
    );
    if (!screwFirst) {
      throw new Error('best-match ranking: heavier-weighted item should render before the lighter one');
    }
  });

  // --- Phase 6: QR generation, scanner, contacts & checkout, export ------------

  let scannedUrl = '';
  await step('generates a printable QR code for an item', async () => {
    await page.goto(`${BASE}inventory`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: 'Add item' }).waitFor({ state: 'visible', timeout: 10000 });
    await itemCard(screwName).getByRole('button', { name: 'QR code' }).click();
    const dialog = page.getByRole('dialog', { name: 'QR code' });
    await dialog.locator('[data-testid="item-qr"] svg').waitFor({ state: 'visible', timeout: 5000 });
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

  await step('prints a batch QR label sheet for a multi-selection (§6, Phase 49)', async () => {
    await page.goto(`${BASE}inventory`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: 'Add item' }).waitFor({ state: 'visible', timeout: 10000 });

    // Enter select mode — checkboxes appear and the selection action bar shows.
    await page.getByTestId('toggle-select').click();
    await page.getByTestId('selection-bar').waitFor({ state: 'visible', timeout: 5000 });

    // Select two items; the count tracks them even though selection is keyed by id.
    await itemCard(screwName).getByTestId('item-select').check();
    await itemCard(filamentName).getByTestId('item-select').check();
    await page
      .getByTestId('selection-count')
      .filter({ hasText: '2 selected' })
      .waitFor({ state: 'visible', timeout: 5000 });

    // Open the print preview — it must render one QR label per selected item.
    await page.getByTestId('print-labels').click();
    const printDialog = page.getByRole('dialog', { name: 'Print QR labels' });
    await printDialog.waitFor({ state: 'visible', timeout: 5000 });
    await printDialog.locator('[data-testid="label-cell"] svg').first().waitFor({ state: 'visible', timeout: 5000 });
    const cellCount = await printDialog.locator('[data-testid="label-cell"]').count();
    if (cellCount !== 2) {
      throw new Error(`expected 2 label cells in the print preview, got ${cellCount}`);
    }
    if (!(await printDialog.getByText(screwName).count())) {
      throw new Error('print preview should show the selected item name');
    }

    // Close the preview and leave select mode — clean state for the next step.
    await page.keyboard.press('Escape');
    await printDialog.waitFor({ state: 'detached', timeout: 5000 });
    await page.getByTestId('toggle-select').click();
    await page.getByTestId('selection-bar').waitFor({ state: 'detached', timeout: 5000 });
  });

  await step('scans a code and checks the item out to an auto-created contact', async () => {
    await page.getByRole('button', { name: 'Scan' }).click();
    const overlay = page.locator('[data-testid="scanner-overlay"]');
    await overlay.waitFor({ state: 'visible', timeout: 5000 });
    // Simulate a decode by feeding the deep-link into the manual-entry fallback.
    await page.locator('[data-testid="scanner-manual-input"]').fill(scannedUrl);
    await page.locator('[data-testid="scanner-manual-submit"]').click();
    // Discrete result card shows the scanned item with a Check out action.
    await overlay.getByText(screwName).first().waitFor({ state: 'visible', timeout: 5000 });
    await overlay.getByRole('button', { name: 'Check out' }).click();
    const dialog = page.getByRole('dialog', { name: 'Check out' });
    await dialog.getByPlaceholder('Type a name — new names are added automatically').fill(borrowerName);
    await dialog.getByRole('button', { name: 'Check out' }).click();
    await dialog.waitFor({ state: 'hidden', timeout: 5000 });
    // Close the scanner overlay.
    await page.getByRole('button', { name: 'Close scanner' }).click();
  });

  await step('announces silent scanner status via aria-live regions (§3 a11y, Phase 42)', async () => {
    // In-place status that changes after an explicit action must be announced
    // (WCAG 4.1.3). The scanner's manual-entry feedback is the screen-reader channel:
    // an unknown code must announce a notice (always-mounted polite region), and a
    // real scan announces the matched item via a hidden region (the visible result
    // card is interactive, so it can't be the live region itself).
    await page.getByRole('button', { name: 'Scan' }).click();
    const overlay = page.locator('[data-testid="scanner-overlay"]');
    await overlay.waitFor({ state: 'visible', timeout: 5000 });

    const notice = page.locator('[data-testid="scanner-notice"]');
    if ((await notice.getAttribute('role')) !== 'status' || (await notice.getAttribute('aria-live')) !== 'polite') {
      throw new Error('scanner notice is not a polite live region');
    }
    await page.locator('[data-testid="scanner-manual-input"]').fill('not-a-gubbins-code');
    await page.locator('[data-testid="scanner-manual-submit"]').click();
    await notice.getByText('That code is not a Gubbins item.').waitFor({ state: 'visible', timeout: 5000 });

    // A real scan: the hidden announcement region carries "Scanned <name>".
    await page.locator('[data-testid="scanner-manual-input"]').fill(scannedUrl);
    await page.locator('[data-testid="scanner-manual-submit"]').click();
    const announce = page.locator('[data-testid="scanner-scan-announce"]');
    await announce.waitFor({ state: 'attached', timeout: 5000 });
    if ((await announce.getAttribute('role')) !== 'status') {
      throw new Error('scan announcement is not a status region');
    }
    await page.waitForFunction(
      (sel) => document.querySelector(sel)?.textContent?.startsWith('Scanned '),
      '[data-testid="scanner-scan-announce"]',
      { timeout: 5000 },
    );
    await page.getByRole('button', { name: 'Close scanner' }).click();
  });

  await step('moves a whole continuous-scan queue to a location (§6.3 batch action, Phase 50)', async () => {
    // §6.3 Continuous-Mode finalisation: the queue's headline batch action is "move all
    // to a new location". Capture the filament's deep-link too so the working queue holds
    // two distinct items (the queue de-dupes by id).
    await page.goto(`${BASE}inventory`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: 'Add item' }).waitFor({ state: 'visible', timeout: 10000 });
    await itemCard(filamentName).getByRole('button', { name: 'QR code' }).click();
    const qr = page.getByRole('dialog', { name: 'QR code' });
    await qr.locator('[data-testid="item-qr"] svg').waitFor({ state: 'visible', timeout: 5000 });
    const filamentUrl = (await qr.locator('[data-testid="item-qr-url"]').innerText()).trim();
    await page.keyboard.press('Escape');
    await qr.waitFor({ state: 'detached', timeout: 5000 });

    // Open the scanner and switch to Continuous (batch) mode.
    await page.getByRole('button', { name: 'Scan' }).click();
    const overlay = page.locator('[data-testid="scanner-overlay"]');
    await overlay.waitFor({ state: 'visible', timeout: 5000 });
    await overlay.getByRole('button', { name: 'Continuous' }).click();

    // Queue two distinct items via the manual-entry fallback (each decode offers to the queue).
    for (const url of [scannedUrl, filamentUrl]) {
      await page.locator('[data-testid="scanner-manual-input"]').fill(url);
      await page.locator('[data-testid="scanner-manual-submit"]').click();
    }

    // Tap the queue toast to review, then move the whole queue to a location.
    await overlay.getByText(/scanned · tap to review/).click();
    await page.getByTestId('scanner-move-location').selectOption({ label: `Workshop ${stamp}` });
    await page.getByTestId('scanner-move-all').click();

    // The pure `summariseBatch` announces the real outcome: a moved id only lands in
    // `succeeded` once `move.mutateAsync` resolved (a committed write), so two successes
    // here prove both items were genuinely re-homed.
    await page
      .getByTestId('scanner-notice')
      .getByText(`Moved 2 items to Workshop ${stamp}`)
      .waitFor({ state: 'visible', timeout: 5000 });

    await page.getByRole('button', { name: 'Close scanner' }).click();
    await overlay.waitFor({ state: 'detached', timeout: 5000 });
  });

  await step('shows the loan and contact on the contacts screen', async () => {
    await page.goto(`${BASE}contacts`, { waitUntil: 'domcontentloaded' });
    await page.getByText('On loan').waitFor({ state: 'visible', timeout: 6000 });
    // The borrowed item and the auto-created contact both appear.
    await page.getByText(screwName).first().waitFor({ state: 'visible', timeout: 5000 });
    await page.getByText(borrowerName).first().waitFor({ state: 'visible', timeout: 5000 });
    // Return it.
    await page.getByRole('button', { name: 'Return' }).first().click();
    await page.waitForFunction(
      (name) => !document.body.textContent?.includes(name),
      screwName,
      { timeout: 5000 },
    );
  });

  await step('runs a JSON backup export through the wizard', async () => {
    await page.goto(`${BASE}inventory`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: 'Export' }).waitFor({ state: 'visible', timeout: 10000 });
    await page.getByRole('button', { name: 'Export' }).click();
    const dialog = page.getByRole('dialog', { name: 'Export' });
    await dialog.waitFor({ state: 'visible', timeout: 5000 });
    const download = page.waitForEvent('download', { timeout: 8000 });
    await dialog.getByTestId('run-export').click();
    const file = await download;
    if (!file.suggestedFilename().endsWith('.json')) {
      throw new Error(`unexpected export filename: ${file.suggestedFilename()}`);
    }
    await page.keyboard.press('Escape');
  });

  await step('exports a Markdown vault zip with extracted image assets (§4.5)', async () => {
    await page.getByRole('button', { name: 'Export' }).click();
    const dialog = page.getByRole('dialog', { name: 'Export' });
    await dialog.getByRole('button', { name: /Markdown vault/ }).click();
    const download = page.waitForEvent('download', { timeout: 10000 });
    await dialog.getByTestId('run-export').click();
    const file = await download;
    if (!file.suggestedFilename().endsWith('.zip')) {
      throw new Error(`unexpected vault filename: ${file.suggestedFilename()}`);
    }
    // Phase 14: unzip and prove the vault carries .md notes AND a real full-res image
    // pulled out of OPFS into /assets (the cross-device full-res transport).
    const fs = await import('node:fs/promises');
    const { unzipSync } = await import('fflate');
    const bytes = new Uint8Array(await fs.readFile(await file.path()));
    const entries = Object.keys(unzipSync(bytes));
    if (!entries.some((p) => p.endsWith('.md'))) {
      throw new Error('vault zip has no .md notes');
    }
    if (!entries.some((p) => p.startsWith('assets/'))) {
      throw new Error('vault zip extracted no /assets image bytes (§4.5)');
    }
    await page.keyboard.press('Escape');
  });

  await step('exports a Project-scope vault nested in a project folder (§4.5, Phase 19)', async () => {
    await page.getByRole('button', { name: 'Export' }).click();
    const dialog = page.getByRole('dialog', { name: 'Export' });
    await dialog.getByRole('button', { name: /Markdown vault/ }).click();
    await dialog.getByTestId('export-scope').selectOption('PROJECT');
    await dialog.getByTestId('export-target-project').selectOption({ label: projectName });
    const download = page.waitForEvent('download', { timeout: 10000 });
    await dialog.getByTestId('run-export').click();
    const file = await download;
    // Phase 19: a Project-scope vault is one self-contained folder — the master note
    // alongside the component notes in their Location sub-folders (§4.5).
    const fs = await import('node:fs/promises');
    const { unzipSync } = await import('fflate');
    const bytes = new Uint8Array(await fs.readFile(await file.path()));
    const entries = Object.keys(unzipSync(bytes));
    const folder = `${projectName}/`;
    if (!entries.length || !entries.every((p) => p.startsWith(folder))) {
      throw new Error(`project vault did not nest every entry under "${folder}": ${entries.join(', ')}`);
    }
    if (!entries.includes(`${folder}${projectName}.md`)) {
      throw new Error('project vault is missing its master note inside the project folder');
    }
    // A component note must sit in a Location sub-folder beneath the project folder.
    if (!entries.some((p) => p.startsWith(folder) && p !== `${folder}${projectName}.md` && p.endsWith('.md'))) {
      throw new Error('project vault has no component note sub-folder');
    }
    // Reset the wizard so later steps export the whole inventory again.
    await dialog.getByTestId('export-scope').selectOption('ALL');
    await page.keyboard.press('Escape');
  });

  await step('runs a scoped single-item export (§4.5 granularity)', async () => {
    await page.getByRole('button', { name: 'Export' }).click();
    const dialog = page.getByRole('dialog', { name: 'Export' });
    await dialog.getByRole('button', { name: /JSON data/ }).click();
    await dialog.getByTestId('export-scope').selectOption('ITEM');
    await dialog.getByTestId('export-target-item').selectOption({ label: screwName });
    const download = page.waitForEvent('download', { timeout: 8000 });
    await dialog.getByTestId('run-export').click();
    const file = await download;
    const fs = await import('node:fs/promises');
    const parsed = JSON.parse(await fs.readFile(await file.path(), 'utf8'));
    if (parsed.items.length !== 1 || parsed.items[0].name !== screwName) {
      throw new Error(`scoped export should carry exactly the one chosen item (got ${parsed.items.length})`);
    }
    // Reset the wizard scope so later full exports are unaffected.
    await dialog.getByTestId('export-scope').selectOption('ALL');
    await page.keyboard.press('Escape');
  });

  await step('the live OPFS database is a valid raw .sqlite (restore premise, §3)', async () => {
    // The raw-restore path overwrites this OPFS file with an uploaded binary; assert the
    // file the app keeps IS a restorable SQLite database (magic header) and that an OPFS
    // overwrite→reread round-trips the exact bytes (the mechanism the restore relies on).
    const ok = await page.evaluate(async () => {
      const root = await navigator.storage.getDirectory();
      const handle = await root.getFileHandle('gubbins.sqlite3');
      const bytes = new Uint8Array(await (await handle.getFile()).arrayBuffer());
      const magic = 'SQLite format 3';
      for (let i = 0; i < magic.length; i += 1) {
        if (bytes[i] !== magic.charCodeAt(i)) return false;
      }
      // OPFS overwrite round-trip with a throwaway file (does not touch the live DB).
      const probe = await root.getFileHandle('gubbins-restore-probe.sqlite3', { create: true });
      const writable = await probe.createWritable();
      await writable.write(bytes);
      await writable.close();
      const back = new Uint8Array(await (await probe.getFile()).arrayBuffer());
      await root.removeEntry('gubbins-restore-probe.sqlite3');
      return back.length === bytes.length && back[0] === bytes[0];
    });
    if (!ok) throw new Error('live OPFS file is not a restorable raw .sqlite binary');
  });

  await step('Phase 17: full-archive restore re-hydrates OPFS images (§2.7/§3)', async () => {
    // The §2.7 archive zips the DB + full-res OPFS images; this proves the restore loop
    // unzips a real archive and writes the full-res images back into OPFS on a fresh
    // device. Exercises the genuine restore-archive + opfs-images modules (no reload —
    // we stop short of overwriting the live DB, which the "restore premise" step covers).
    const result = await page.evaluate(async (base) => {
      const [{ readArchive }, opfs, { buildFullArchive }] = await Promise.all([
        import(`${base}src/features/archive/restore-archive.ts`),
        import(`${base}src/features/images/opfs-images.ts`),
        import(`${base}src/features/archive/auto-archive.ts`),
      ]);
      // Seed a known full-resolution image into OPFS.
      const probe = new Uint8Array([11, 22, 33, 44, 55, 66, 77, 88]);
      const path = await opfs.saveImageFile(new Blob([probe], { type: 'image/webp' }), 'webp');
      const name = path.split('/').pop();
      // Build a genuine archive (DB binary + every OPFS image), then wipe the seeded file
      // to simulate a fresh device whose full-res images are gone.
      const zip = await buildFullArchive();
      await opfs.deleteImageFile(path);
      if ((await opfs.readImageBlob(path)) !== undefined) return 'seed image not cleared';
      // Re-hydrate: the real unzip→parse, then the real OPFS write-back.
      const { images } = readArchive(zip);
      if (!images.some((img) => img.name === name)) return 'archive did not carry the image';
      await opfs.writeImageFiles(images);
      const back = await opfs.readImageBlob(path);
      if (!back) return 'image not re-hydrated';
      const got = new Uint8Array(await back.arrayBuffer());
      await opfs.deleteImageFile(path); // keep OPFS clean for later steps
      return got.length === probe.length && got[0] === 11 && got[7] === 88
        ? 'ok'
        : 'rehydrated bytes differ';
    }, BASE);
    if (result !== 'ok') throw new Error(`archive image re-hydration failed: ${result}`);
  });

  // --- Phase 7: Cloud Sync & File System Access --------------------------------
  // These hops stay inside the SPA (in-app <Link> clicks, never page.goto) because
  // the in-memory provider's "remote" lives in JS module memory; a full reload would
  // reset it. They drive the genuine OPFS worker path for snapshot/apply/backup.

  let backupZip = new Uint8Array();
  await step('connects the in-memory sync provider and publishes', async () => {
    await page.getByRole('link', { name: 'Sync' }).first().click();
    await page.getByRole('heading', { name: /Cloud Sync/ }).waitFor({ state: 'visible', timeout: 6000 });
    await page.getByTestId('connect-memory').click();
    await page.getByTestId('sync-provider-label').waitFor({ state: 'visible', timeout: 5000 });
    await page.getByTestId('sync-now').click();
    // First sync publishes the local state; the result line reports the status.
    await page.getByTestId('sync-result').waitFor({ state: 'visible', timeout: 6000 });
    // Phase 42: the outcome appears in place, so it must be an announced live region.
    const syncLive = page.getByTestId('sync-result');
    if ((await syncLive.getAttribute('role')) !== 'status' || (await syncLive.getAttribute('aria-live')) !== 'polite') {
      throw new Error('sync result is not an announced polite live region (Phase 42)');
    }
  });

  await step('downloads a complete .zip backup of the real OPFS database', async () => {
    await page.getByTestId('open-backup').click();
    const dialog = page.getByRole('dialog', { name: 'Backup & restore' });
    await dialog.waitFor({ state: 'visible', timeout: 5000 });
    // Leave out the exact .sqlite copy and settings so the later *merge* restore needs no
    // reload — the in-memory provider's "remote" lives in module memory and a reload resets it.
    await dialog.getByTestId('backup-toggle-rawSqlite').uncheck();
    await dialog.getByTestId('backup-toggle-settings').uncheck();
    const download = page.waitForEvent('download', { timeout: 10000 });
    await dialog.getByTestId('create-backup').click();
    const file = await download;
    if (!/^gubbins-backup-.*\.zip$/.test(file.suggestedFilename())) {
      throw new Error(`unexpected backup filename: ${file.suggestedFilename()}`);
    }
    const fs = await import('node:fs/promises');
    const { unzipSync, strFromU8 } = await import('fflate');
    backupZip = new Uint8Array(await fs.readFile(await file.path()));
    const entries = unzipSync(backupZip);
    if (!entries['backup.json']) throw new Error('backup .zip is missing backup.json');
    if (!entries['manifest.json']) throw new Error('backup .zip is missing manifest.json');
    const parsed = JSON.parse(strFromU8(entries['backup.json']));
    if (parsed.formatVersion !== 1) throw new Error(`backup formatVersion ${parsed.formatVersion} != 1`);
    const items = parsed.tables?.items ?? [];
    if (!items.some((it) => it.name === screwName)) {
      throw new Error('backup snapshot is missing the expected item');
    }
    // Phase 11 sync-set expansion: the widened set must travel in the same payload.
    const images = parsed.tables?.item_images ?? [];
    if (images.length === 0) throw new Error('backup is missing item_images (Phase 11)');
    if (typeof images[0].thumbnail_blob !== 'string') {
      throw new Error('item_images thumbnail is not base64-encoded for JSON');
    }
    if ('full_res_downgraded_at' in images[0]) {
      throw new Error('local-only §7.6.3-B downgrade marker leaked into the sync payload');
    }
    if (!Array.isArray(parsed.itemTags) || parsed.itemTags.length === 0) {
      throw new Error('backup is missing item_tags membership (Phase 11)');
    }
    if (!Array.isArray(parsed.itemHistory) || parsed.itemHistory.length === 0) {
      throw new Error('backup is missing the item_history ledger (Phase 11)');
    }
    await page.keyboard.press('Escape');
  });

  await step('imports the backup (merge) and re-syncs cleanly', async () => {
    // Still on /sync. Import the just-downloaded backup through the real OPFS restore path
    // (a no-reload merge), then run a second sync over the restored state — both error-free.
    await page.getByTestId('open-backup').click();
    const dialog = page.getByRole('dialog', { name: 'Backup & restore' });
    await dialog.getByRole('tab', { name: /Restore/ }).click();
    await dialog.getByTestId('restore-backup-input').setInputFiles({
      name: 'gubbins-backup.zip',
      mimeType: 'application/zip',
      buffer: Buffer.from(backupZip),
    });
    // Merge is the default mode; confirm the two-step restore.
    await dialog.getByTestId('restore-backup').click();
    await dialog.getByTestId('confirm-restore-backup').click();
    await page.getByTestId('sync-notice').waitFor({ state: 'visible', timeout: 8000 });
    await page.getByTestId('sync-now').click();
    await page.getByTestId('sync-result').waitFor({ state: 'visible', timeout: 6000 });

    // The database is intact after import + sync: the item is still searchable.
    await page.getByRole('link', { name: 'Inventory' }).first().click();
    await page.getByLabel('Search items').fill(screwName);
    await page.getByText(screwName).first().waitFor({ state: 'visible', timeout: 5000 });
  });

  await step('Phase 11: the tag + image survive the backup round-trip and restore', async () => {
    // The printer item's freeform tag (item_tags membership) and its thumbnail
    // (item_images base64) must persist through download → import → re-sync.
    await page.getByLabel('Search items').fill(printerName);
    await printerCard().getByRole('button', { name: 'Item details' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('tab', { name: 'Classification' }).click();
    await dialog.getByText(tagName).waitFor({ state: 'visible', timeout: 5000 });
    await dialog.getByRole('tab', { name: 'Media & docs' }).click();
    await dialog.locator('img').first().waitFor({ state: 'visible', timeout: 5000 });
    await page.keyboard.press('Escape');
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

  // The PWA stamps a fresh requestId on each outbound SCRAPE_REQUEST (§9 multi-scrape);
  // the real extension echoes it back on the SCRAPE_RESULT/ERROR. To simulate that we
  // capture the requests the PWA posts and reply with the matching id.
  const installScrapeCapture = () =>
    page.evaluate((src) => {
      if (window.__scrapeCaptureInstalled) return;
      window.__scrapeCaptureInstalled = true;
      window.__scrapeRequests = [];
      window.addEventListener('message', (e) => {
        const d = e.data;
        if (d && typeof d === 'object' && d.source === src && d.type === 'SCRAPE_REQUEST') {
          window.__scrapeRequests.push({ id: d.requestId, url: d.payload && d.payload.url });
        }
      });
    }, EXT_SOURCE);
  const scrapeRequestCount = () => page.evaluate(() => (window.__scrapeRequests || []).length);
  const waitForScrapeRequest = async (sinceCount) => {
    for (let i = 0; i < 40; i += 1) {
      const reqs = await page.evaluate(() => window.__scrapeRequests || []);
      if (reqs.length > sinceCount) return reqs[reqs.length - 1];
      await page.waitForTimeout(75);
    }
    throw new Error('expected the PWA to post a SCRAPE_REQUEST but none was captured');
  };

  await step('extension EXTENSION_READY unlocks the Scrape Supplier control (§9.3)', async () => {
    await page.goto(`${BASE}inventory`, { waitUntil: 'domcontentloaded' });
    await installScrapeCapture();
    await page.getByRole('button', { name: 'Add item' }).waitFor({ state: 'visible', timeout: 10000 });
    await page.getByRole('button', { name: 'Add item' }).click();
    const dialog = page.getByRole('dialog', { name: 'Add item' });
    // Before readiness the panel must NOT exist (graceful degradation to manual).
    if (await dialog.getByTestId('scrape-supplier-panel').count()) {
      throw new Error('Scrape panel rendered before EXTENSION_READY');
    }
    await postExtMessage({ source: EXT_SOURCE, type: 'EXTENSION_READY', payload: { version: '1.1.0' } });
    await dialog.getByTestId('scrape-supplier-panel').waitFor({ state: 'visible', timeout: 5000 });
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

  // Shared across the next two steps: the requestId the PWA stamped on this scrape.
  let scrapeReqId = null;

  await step('a SCRAPE_RESULT with a mismatched requestId is ignored (§9 correlation)', async () => {
    const dialog = page.getByRole('dialog', { name: 'Add item' });
    await dialog.getByLabel('Name').fill(scrapeItemName);
    const manufacturer = dialog.getByLabel('Manufacturer (optional)');
    // The user has already typed a manufacturer — it must be preserved throughout.
    await manufacturer.fill(userManufacturer);

    const before = await scrapeRequestCount();
    await dialog.getByTestId('scrape-supplier-panel').locator('input[type="url"]').fill('https://www.digikey.co.uk/p/ne555p');
    await dialog.getByRole('button', { name: 'Scrape' }).click();

    const req = await waitForScrapeRequest(before);
    if (!req.id || typeof req.id !== 'string') throw new Error('SCRAPE_REQUEST carried no requestId');
    scrapeReqId = req.id;

    // A well-formed, trusted result for the WRONG requestId must be dropped (no fill).
    await postExtMessage({
      source: EXT_SOURCE,
      type: 'SCRAPE_RESULT',
      requestId: `${req.id}-stale`,
      payload: {
        mpn: 'WRONG-CORRELATION',
        manufacturer: 'Texas Instruments',
        description: 'Precision 555 timer IC',
        distributor_url: 'https://www.digikey.co.uk/p/ne555p',
        scraped_pricing: { currency: 'GBP', value: 0.42 },
      },
    });
    await page.waitForTimeout(300);
    if ((await dialog.getByLabel('MPN (optional)').inputValue()) !== '') {
      throw new Error('a result with a non-matching requestId populated the form');
    }
  });

  await step('the correlated SCRAPE_RESULT fills empty fields without overwriting user entries (§4)', async () => {
    const dialog = page.getByRole('dialog', { name: 'Add item' });
    const mpn = dialog.getByLabel('MPN (optional)');
    const manufacturer = dialog.getByLabel('Manufacturer (optional)');
    const unitCost = dialog.getByLabel('Unit cost (optional)');

    // The (trusted) extension answers with the MATCHING requestId.
    await postExtMessage({
      source: EXT_SOURCE,
      type: 'SCRAPE_RESULT',
      requestId: scrapeReqId,
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
    await page.getByText(scrapeItemName).first().waitFor({ state: 'visible', timeout: 5000 });
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
    await detail.getByText(scrapedMpn).first().waitFor({ state: 'visible', timeout: 5000 });
  });

  await step('a BLOCKED SCRAPE_ERROR surfaces the deepened-taxonomy degradation toast (§9.4.2/§9.4.3)', async () => {
    const detail = page.getByRole('dialog');
    const before = await scrapeRequestCount();
    await detail.getByTestId('scrape-supplier-panel').locator('input[type="url"]').fill('https://www.digikey.co.uk/p/ne555p');
    await detail.getByRole('button', { name: 'Scrape' }).click();
    const req = await waitForScrapeRequest(before);
    // The (trusted) extension answers the correlated request with a Phase-35 BLOCKED
    // failure (HTTP 403) — previously this would have mis-reported as NETWORK_TIMEOUT.
    await postExtMessage({
      source: EXT_SOURCE,
      type: 'SCRAPE_ERROR',
      requestId: req.id,
      payload: { domain: 'digikey.co.uk', error_type: 'BLOCKED', reason: 'Supplier blocked the request (HTTP 403).' },
    });
    // §9.4.3: an actionable toast with the BLOCKED-specific wording (not the raw reason).
    await page
      .getByTestId('toast')
      .filter({ hasText: 'blocked the request' })
      .first()
      .waitFor({ state: 'visible', timeout: 6000 });
  });

  await step('a CHALLENGE SCRAPE_ERROR surfaces the anti-bot-challenge degradation toast (§9.4.2/§9.4.3)', async () => {
    const detail = page.getByRole('dialog');
    const before = await scrapeRequestCount();
    await detail.getByTestId('scrape-supplier-panel').locator('input[type="url"]').fill('https://www.digikey.co.uk/p/ne555p');
    await detail.getByRole('button', { name: 'Scrape' }).click();
    const req = await waitForScrapeRequest(before);
    // A 200-OK anti-bot interstitial (Phase 36): the content script's detectChallengePage
    // marshals CHALLENGE rather than mis-parsing the page into a DOM_DRIFT.
    await postExtMessage({
      source: EXT_SOURCE,
      type: 'SCRAPE_ERROR',
      requestId: req.id,
      payload: {
        domain: 'digikey.co.uk',
        error_type: 'CHALLENGE',
        reason: 'Supplier returned an anti-bot challenge page (Cloudflare).',
      },
    });
    // §9.4.3: the CHALLENGE-specific wording (nudges opening the page in a tab).
    await page
      .getByTestId('toast')
      .filter({ hasText: 'anti-bot challenge' })
      .first()
      .waitFor({ state: 'visible', timeout: 6000 });
  });

  await step('re-scraping honours the §4 no-overwrite review for a populated field', async () => {
    const detail = page.getByRole('dialog');
    // The two prior steps each raise a degradation toast; wait for them to auto-dismiss so
    // the fixed-position toast overlay cannot intercept the "Scrape" button click below.
    await page
      .getByTestId('toast')
      .first()
      .waitFor({ state: 'detached', timeout: 8000 })
      .catch(() => {});
    const before = await scrapeRequestCount();
    await detail.getByTestId('scrape-supplier-panel').locator('input[type="url"]').fill('https://www.digikey.co.uk/p/ne555p');
    await detail.getByRole('button', { name: 'Scrape' }).click();
    const req = await waitForScrapeRequest(before);
    await postExtMessage({
      source: EXT_SOURCE,
      type: 'SCRAPE_RESULT',
      requestId: req.id,
      payload: {
        mpn: scrapedMpn,
        manufacturer: 'Texas Instruments', // differs from the user's value → CONFLICT
        description: 'Precision 555 timer IC',
        distributor_url: 'https://www.digikey.co.uk/p/ne555p',
        scraped_pricing: { currency: 'GBP', value: 0.42 },
      },
    });
    const review = page.getByRole('dialog', { name: 'Review scraped data' });
    await review.waitFor({ state: 'visible', timeout: 5000 });
    // The manufacturer conflict is presented as an OFF-by-default opt-in.
    const overwrite = review.getByTestId('overwrite-manufacturer');
    await overwrite.waitFor({ state: 'visible', timeout: 4000 });
    if (await overwrite.isChecked()) throw new Error('overwrite checkbox defaulted to ON');
    // Apply WITHOUT ticking — the user's manufacturer must survive.
    await review.getByRole('button', { name: 'Apply' }).click();
    await review.waitFor({ state: 'hidden', timeout: 5000 });
    await page.waitForFunction(
      (mfr) => document.body.textContent?.includes(mfr),
      userManufacturer,
      { timeout: 5000 },
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
    await page.getByRole('button', { name: 'Add item' }).waitFor({ state: 'visible', timeout: 10000 });
    await page.getByRole('button', { name: 'Add item' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Name').fill(perishableName);
    await dialog.getByTestId('item-expiry').fill(soonExpiry);
    await dialog.getByTestId('item-condition').selectOption('GOOD');
    await dialog.getByRole('button', { name: 'Create item' }).click();
    await page.getByText(perishableName).first().waitFor({ state: 'visible', timeout: 5000 });
  });

  await step('expands a parent item into a child variant (§4 Variant/SKU)', async () => {
    await lifecycleCard(perishableName).getByRole('button', { name: 'Item details' }).click();
    const detail = page.getByRole('dialog');
    await detail.getByRole('tab', { name: 'Lifecycle' }).click();
    await detail.getByTestId('variant-name').waitFor({ state: 'visible', timeout: 5000 });
    await detail.getByTestId('variant-name').fill(variantName);
    await detail.getByTestId('add-variant').click();
    await detail
      .getByTestId('variant-list')
      .getByText(variantName)
      .waitFor({ state: 'visible', timeout: 5000 });
    await page.keyboard.press('Escape');
  });

  await step('nests a sub-variant beneath a variant (§4 multi-level, Phase 18)', async () => {
    // The variant created above is itself a top-level inventory card. Open it and add
    // a sub-variant beneath it — proving Phase 18 lifted the single-level cap so a
    // variant can hold its own grandchildren (with cycles still rejected server-side).
    await lifecycleCard(variantName).getByRole('button', { name: 'Item details' }).click();
    const detail = page.getByRole('dialog');
    await detail.getByRole('tab', { name: 'Lifecycle' }).click();
    // This item is recognised as a child variant yet can still gain sub-variants.
    await detail.getByTestId('variant-is-child').waitFor({ state: 'visible', timeout: 5000 });
    await detail.getByTestId('variant-name').fill(subVariantName);
    await detail.getByTestId('add-variant').click();
    await detail
      .getByTestId('variant-list')
      .getByText(subVariantName)
      .waitFor({ state: 'visible', timeout: 5000 });
    await page.keyboard.press('Escape');
  });

  await step('adds a tool maintenance schedule to an item (§4.3)', async () => {
    await lifecycleCard(perishableName).getByRole('button', { name: 'Item details' }).click();
    const detail = page.getByRole('dialog');
    await detail.getByRole('tab', { name: 'Lifecycle' }).click();
    await detail.getByTestId('maintenance-name').fill(maintScheduleName);
    await detail.getByTestId('add-maintenance').click();
    await detail
      .getByTestId('maintenance-list')
      .getByText(maintScheduleName)
      .waitFor({ state: 'visible', timeout: 5000 });
    await page.keyboard.press('Escape');
  });

  await step('opts a tool into automatic checkout-hours telemetry (§4.3, Phase 22)', async () => {
    // Add a USAGE schedule that derives its usage from real checkout-hours instead of
    // the manual counter — proving the v11 opt-in persists and the editor renders the
    // derived loan-hours projection through the genuine OPFS worker + repository path.
    await lifecycleCard(perishableName).getByRole('button', { name: 'Item details' }).click();
    const detail = page.getByRole('dialog');
    await detail.getByRole('tab', { name: 'Lifecycle' }).click();
    await detail.getByTestId('maintenance-name').waitFor({ state: 'visible', timeout: 5000 });
    await detail.getByTestId('maintenance-name').fill(loanScheduleName);
    await detail.getByTestId('maintenance-basis').selectOption('USAGE');
    await detail.getByTestId('accrue-checkout-hours').check();
    await detail.getByTestId('add-maintenance').click();
    const row = detail.getByTestId('maintenance-row').filter({ hasText: loanScheduleName });
    // The derived "h from loans" figure renders and the manual log input is replaced by
    // the auto-accrual note (manual logging is disabled in accrue mode).
    await row.getByText(/from loans/).waitFor({ state: 'visible', timeout: 5000 });
    await row
      .getByText('Usage accrues automatically from checkout hours.')
      .waitFor({ state: 'visible', timeout: 5000 });
    await page.keyboard.press('Escape');
  });

  await step('runs a cycle count and authorises a variance adjustment (§4.4)', async () => {
    // A dedicated location with one bulk item at quantity 10.
    await page.getByRole('button', { name: 'Add location' }).click();
    const locDialog = page.getByRole('dialog');
    await locDialog.getByLabel('Name').fill(drawerName);
    await locDialog.getByRole('button', { name: 'Create', exact: true }).click();
    await page.getByRole('treeitem', { name: drawerName }).first().waitFor({ state: 'visible', timeout: 5000 });
    await page.getByRole('treeitem', { name: drawerName }).first().click();

    await page.getByRole('button', { name: 'Add item' }).click();
    const itemDialog = page.getByRole('dialog');
    await itemDialog.getByLabel('Name').fill(cycleItemName);
    await itemDialog.getByRole('combobox', { name: 'Location' }).click();
    // Phase 55: the Add Item location picker is now the tinted custom listbox — the
    // teal-swatched Workshop option carries its colour token (cf. the parent picker).
    await itemDialog
      .getByRole('option', { name: `Workshop ${stamp}` })
      .locator('.text-loc-teal')
      .waitFor({ state: 'visible', timeout: 5000 });
    await itemDialog.getByRole('option', { name: drawerName }).click();
    await itemDialog.getByLabel('Initial quantity').fill('10');
    await itemDialog.getByRole('button', { name: 'Create item' }).click();
    await page.getByText(cycleItemName).first().waitFor({ state: 'visible', timeout: 5000 });

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
      .waitFor({ state: 'visible', timeout: 5000 });
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
      { timeout: 5000 },
    );
  });

  await step('splits a DISCRETE item across two locations via the stock ledger (§4, Phase 25)', async () => {
    // cycleItemName is a DISCRETE item at `drawerName` with on-hand 8 (post-reconcile).
    await page.getByRole('treeitem', { name: drawerName }).first().click();
    await lifecycleCard(cycleItemName).getByRole('button', { name: 'Item details' }).click();
    const detail = page.getByRole('dialog');
    await detail.getByRole('tab', { name: 'Lifecycle' }).click();
    const placements = detail.getByTestId('stock-placements');
    await detail.getByTestId('stock-breakdown').waitFor({ state: 'visible', timeout: 5000 });

    const qtyAt = async (name) => {
      const li = placements.locator('li').filter({ hasText: name }).first();
      return (await li.locator('[data-testid^="stock-qty-"]').textContent())?.trim();
    };
    // Initially a single placement holding all 8 units.
    if ((await qtyAt(drawerName)) !== '8') {
      throw new Error('Expected a single placement of 8 before the split');
    }

    // Move 3 units to the Unassigned location → the item becomes multi-location.
    await detail.getByTestId('stock-transfer-qty').fill('3');
    await detail.getByTestId('stock-to').selectOption({ label: 'Unassigned' });
    await detail.getByTestId('stock-transfer-submit').click();

    // Two placements now: drawer 5 + Unassigned 3 (the total on hand is still 8).
    await placements
      .locator('li')
      .filter({ hasText: 'Unassigned' })
      .waitFor({ state: 'visible', timeout: 5000 });
    const drawerQty = await qtyAt(drawerName);
    const unassignedQty = await qtyAt('Unassigned');
    if (drawerQty !== '5' || unassignedQty !== '3') {
      throw new Error(`Expected drawer 5 / Unassigned 3 after the split, saw ${drawerQty} / ${unassignedQty}`);
    }
    await page.keyboard.press('Escape');
  });

  // Read the per-location breakdown for a split item from its detail dialog, returning a
  // { [locationName]: quantityString } map (an absent placement is undefined).
  const placementQuantities = async (itemName, locationNames) => {
    await lifecycleCard(itemName).getByRole('button', { name: 'Item details' }).click();
    const detail = page.getByRole('dialog');
    await detail.getByRole('tab', { name: 'Lifecycle' }).click();
    const placements = detail.getByTestId('stock-placements');
    await detail.getByTestId('stock-breakdown').waitFor({ state: 'visible', timeout: 5000 });
    const out = {};
    for (const name of locationNames) {
      const li = placements.locator('li').filter({ hasText: name }).first();
      out[name] = (await li.count())
        ? (await li.locator('[data-testid^="stock-qty-"]').textContent())?.trim()
        : undefined;
    }
    await page.keyboard.press('Escape');
    return out;
  };

  await step('cycle-counts a single placement of a split item (§4.4, Phase 26)', async () => {
    // cycleItemName now sits 5 @ drawer + 3 @ Unassigned. Counting the *drawer* must show
    // its placement (5), not the item's grand total (8), and absorb the variance there only.
    await page.getByRole('treeitem', { name: drawerName }).first().click();
    await page.getByTestId('open-cycle-count').click();
    const ccDialog = page.getByRole('dialog');
    const row = ccDialog.getByTestId('cycle-count-lines').locator('li').filter({ hasText: cycleItemName });
    await row.waitFor({ state: 'visible', timeout: 5000 });
    // Count 4 → a −1 variance against *this drawer's* placement of 5 (not the total of 8).
    // The final per-location split (drawer 4 / Unassigned 3) proves the expected was 5.
    await row.getByRole('spinbutton').fill('4');
    await ccDialog.getByTestId('authorise-reconciliation').click();
    await ccDialog.getByTestId('cycle-count-result').waitFor({ state: 'visible', timeout: 5000 });
    await ccDialog.getByRole('button', { name: 'Done' }).click();

    const qtys = await placementQuantities(cycleItemName, [drawerName, 'Unassigned']);
    if (qtys[drawerName] !== '4' || qtys['Unassigned'] !== '3') {
      throw new Error(
        `Per-location count should leave drawer 4 / Unassigned 3, saw ${qtys[drawerName]} / ${qtys['Unassigned']}`,
      );
    }
  });

  await step('checks a split item out from a chosen placement and returns it there (§4, Phase 26)', async () => {
    // cycleItemName is 4 @ drawer + 3 @ Unassigned. Lend 2 *from Unassigned* → 4 / 1.
    await page.getByRole('treeitem', { name: drawerName }).first().click();
    await lifecycleCard(cycleItemName).getByRole('button', { name: 'Check out' }).click();
    const coDialog = page.getByRole('dialog', { name: 'Check out' });
    await coDialog.getByTestId('checkout-from-location').waitFor({ state: 'visible', timeout: 5000 });
    await coDialog.getByTestId('checkout-from-location').selectOption({ label: 'Unassigned (3)' });
    await coDialog.getByPlaceholder(/Type a name/).fill(checkoutBorrower);
    await coDialog.locator('input[type="number"]').fill('2');
    await coDialog.getByRole('button', { name: 'Check out' }).click();
    await coDialog.waitFor({ state: 'hidden', timeout: 5000 });

    const qtys = await placementQuantities(cycleItemName, [drawerName, 'Unassigned']);
    if (qtys[drawerName] !== '4' || qtys['Unassigned'] !== '1') {
      throw new Error(
        `Lending 2 from Unassigned should leave drawer 4 / Unassigned 1, saw ${qtys[drawerName]} / ${qtys['Unassigned']}`,
      );
    }
  });

  await step('scopes a maintenance schedule to one placement of a split item (§4.3, Phase 30)', async () => {
    // cycleItemName now sits across two placements (drawer 4 / Unassigned 1), so the
    // maintenance editor offers a per-location scope. Pin a schedule to the drawer and
    // assert it renders with its "@ <location>" scope badge — proving the v17 location_id
    // round-trips through the real OPFS worker + repository + join path.
    await page.getByRole('treeitem', { name: drawerName }).first().click();
    await lifecycleCard(cycleItemName).getByRole('button', { name: 'Item details' }).click();
    const detail = page.getByRole('dialog');
    await detail.getByRole('tab', { name: 'Lifecycle' }).click();
    await detail.getByTestId('maintenance-name').waitFor({ state: 'visible', timeout: 5000 });
    await detail.getByTestId('maintenance-name').fill(scopedScheduleName);
    await detail.getByTestId('maintenance-location').selectOption({ label: drawerName });
    await detail.getByTestId('add-maintenance').click();
    const row = detail.getByTestId('maintenance-row').filter({ hasText: scopedScheduleName });
    await row.getByText(`@ ${drawerName}`).waitFor({ state: 'visible', timeout: 5000 });
    await page.keyboard.press('Escape');
  });

  await step('receives a BOM line into a tracked batch and FEFO-counts it (§4, Phase 28)', async () => {
    // A fresh DISCRETE item in the drawer, received from procurement under a tracked lot.
    await page.getByRole('treeitem', { name: drawerName }).first().click();
    await page.getByRole('button', { name: 'Add item' }).click();
    const itemDialog = page.getByRole('dialog', { name: 'Add item' });
    await itemDialog.getByLabel('Name').fill(batchItemName);
    await itemDialog.getByRole('combobox', { name: 'Location' }).click();
    await itemDialog.getByRole('option', { name: drawerName }).click();
    await itemDialog.getByLabel('Initial quantity').fill('0');
    await itemDialog.getByRole('button', { name: 'Create item' }).click();
    await page.getByText(batchItemName).first().waitFor({ state: 'visible', timeout: 5000 });

    // Order it on a project BOM and move it In-Transit so the receive control appears.
    await page.goto(`${BASE}projects`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { name: 'Bill of materials' }).waitFor({ state: 'visible', timeout: 8000 });
    await page.getByRole('button', { name: 'Add line' }).click();
    const lineDialog = page.getByRole('dialog', { name: 'Add BOM line' });
    await lineDialog.getByRole('combobox').selectOption({ label: batchItemName });
    await lineDialog.getByLabel('Quantity').fill('6');
    await lineDialog.getByRole('button', { name: 'Add line' }).click();
    // The new line is the one matched to batchItemName; move just it to In-Transit.
    const lineRow = page.locator('tr').filter({ hasText: batchItemName }).first();
    await lineRow.getByLabel('Procurement status').selectOption('IN_TRANSIT');

    // Receive all 6 under a tracked batch number + expiry (a perishable lot).
    const expiryDate = new Date(Date.now() + 90 * 86400000).toISOString().slice(0, 10);
    await page.getByLabel('Quantity to receive').first().fill('6');
    await page.getByLabel('Batch number (optional)').first().fill(batchNo);
    await page.getByLabel('Expiry date (optional)').first().fill(expiryDate);
    await page.getByRole('button', { name: 'Receive into stock' }).first().click();
    await lineRow.getByText('Received', { exact: false }).waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});

    // The item detail's stock breakdown shows the tracked lot as a FEFO sub-row.
    await page.goto(`${BASE}inventory`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: 'Add item' }).waitFor({ state: 'visible', timeout: 10000 });
    await page.getByRole('treeitem', { name: drawerName }).first().click();
    await lifecycleCard(batchItemName).getByRole('button', { name: 'Item details' }).click();
    const detail = page.getByRole('dialog');
    await detail.getByRole('tab', { name: 'Lifecycle' }).click();
    await detail.getByTestId('stock-breakdown').waitFor({ state: 'visible', timeout: 5000 });
    const batchRow = detail.locator('[data-testid^="stock-batch-"]').filter({ hasText: batchNo }).first();
    await batchRow.waitFor({ state: 'visible', timeout: 5000 });
    if (!/6/.test((await batchRow.textContent()) ?? '')) {
      throw new Error('Tracked batch sub-row did not show the received quantity of 6');
    }
    await page.keyboard.press('Escape');

    // A batch-aware cycle count of the drawer audits the lot itself: count 4 → −2 at that lot.
    await page.getByTestId('open-cycle-count').click();
    const ccDialog = page.getByRole('dialog');
    const lot = ccDialog
      .getByTestId('cycle-count-lines')
      .locator('li')
      .filter({ hasText: batchNo });
    await lot.waitFor({ state: 'visible', timeout: 5000 });
    await lot.getByRole('spinbutton').fill('4');
    await ccDialog.getByTestId('authorise-reconciliation').click();
    await ccDialog.getByTestId('cycle-count-result').waitFor({ state: 'visible', timeout: 5000 });
    await ccDialog.getByRole('button', { name: 'Done' }).click();

    // The lot reconciled to 4 at its placement.
    await lifecycleCard(batchItemName).getByRole('button', { name: 'Item details' }).click();
    const after = page.getByRole('dialog');
    await after.getByRole('tab', { name: 'Lifecycle' }).click();
    const lotAfter = after.locator('[data-testid^="stock-batch-"]').filter({ hasText: batchNo }).first();
    await lotAfter.waitFor({ state: 'visible', timeout: 5000 });
    if (!/4/.test((await lotAfter.textContent()) ?? '')) {
      throw new Error('Batch-aware cycle count did not reconcile the lot to 4');
    }
    await page.keyboard.press('Escape');
  });

  await step('moves a chosen lot to another location, preserving its identity (§4, Phase 29)', async () => {
    // The Phase-28 step left `batchItemName` holding 4 of the tracked lot `batchNo` at the
    // drawer (and no untracked remainder). Pick that lot explicitly and move 2 of it to
    // Unassigned — proving the per-lot selector + the identity-preserving destination split.
    await page.getByRole('treeitem', { name: drawerName }).first().click();
    await lifecycleCard(batchItemName).getByRole('button', { name: 'Item details' }).click();
    const detail = page.getByRole('dialog');
    await detail.getByRole('tab', { name: 'Lifecycle' }).click();
    await detail.getByTestId('stock-breakdown').waitFor({ state: 'visible', timeout: 5000 });

    // The lot picker only appears because the source placement holds a tracked lot.
    await detail.getByTestId('stock-lot').waitFor({ state: 'visible', timeout: 5000 });
    await detail.getByTestId('stock-lot').selectOption({ index: 1 }); // option 0 is "Any (soonest expiry)"
    await detail.getByTestId('stock-transfer-qty').fill('2');
    await detail.getByTestId('stock-to').selectOption({ label: 'Unassigned' });
    await detail.getByTestId('stock-transfer-submit').click();

    // The lot now sits at *both* placements with its identity intact: 2 moved, 2 left behind.
    const dest = detail
      .getByTestId('stock-placements')
      .locator('li')
      .filter({ hasText: 'Unassigned' })
      .first();
    await dest.waitFor({ state: 'visible', timeout: 5000 });
    const destLot = dest.locator('[data-testid^="stock-batch-"]').filter({ hasText: batchNo }).first();
    await destLot.waitFor({ state: 'visible', timeout: 5000 });
    if (!/2/.test((await destLot.textContent()) ?? '')) {
      throw new Error('Chosen lot did not arrive at the destination with its identity and quantity 2');
    }
    await page.keyboard.press('Escape');
  });

  await step('audits serialised instances and reconciles a missing one (§4.4)', async () => {
    // Two serialised instances (#1, #2) of one asset in the same drawer.
    await page.getByRole('treeitem', { name: drawerName }).first().click();
    await page.getByRole('button', { name: 'Add item' }).click();
    const itemDialog = page.getByRole('dialog', { name: 'Add item' });
    await itemDialog.getByLabel('Name').fill(serialAuditName);
    await itemDialog.getByRole('combobox', { name: 'Location' }).click();
    await itemDialog.getByRole('option', { name: drawerName }).click();
    await itemDialog.getByLabel('Tracking').selectOption('SERIALISED');
    await itemDialog.getByLabel(/How many/).fill('2');
    await itemDialog.getByRole('button', { name: 'Create item' }).click();
    await page.waitForFunction(
      (name) =>
        [...document.querySelectorAll('h3')].filter((h) => h.textContent?.includes(name)).length >= 2,
      serialAuditName,
      { timeout: 5000 },
    );

    // Open the cycle count and flag instance #2 as missing (blind presence audit).
    await page.getByTestId('open-cycle-count').click();
    const ccDialog = page.getByRole('dialog');
    const missingRow = ccDialog
      .getByTestId('serialised-audit-lines')
      .locator('li')
      .filter({ hasText: `${serialAuditName} #2` });
    await missingRow.waitFor({ state: 'visible', timeout: 5000 });
    // Default state is "Present"; one click flags it "Missing".
    const toggle = missingRow.getByRole('button');
    await toggle.click();
    await toggle.getByText('Missing').waitFor({ state: 'visible', timeout: 4000 });
    await ccDialog.getByTestId('authorise-reconciliation').click();
    await ccDialog.getByTestId('cycle-count-result').waitFor({ state: 'visible', timeout: 5000 });
    await ccDialog.getByRole('button', { name: 'Done' }).click();

    // The missing instance is soft-deleted (gone from active inventory); #1 remains.
    await page.waitForFunction(
      (name) => {
        const heads = [...document.querySelectorAll('h3')].filter((h) =>
          h.textContent?.includes(name),
        );
        return (
          heads.length === 1 &&
          heads.some((h) => h.textContent?.includes('#1')) &&
          !heads.some((h) => h.textContent?.includes('#2'))
        );
      },
      serialAuditName,
      { timeout: 5000 },
    );
  });

  await step('surfaces the perishable on the dashboard "Soon to expire" widget (§3)', async () => {
    await page.goto(`${BASE}`, { waitUntil: 'domcontentloaded' });
    const widget = page.getByTestId('widget-expiring');
    await widget.waitFor({ state: 'visible', timeout: 8000 });
    await widget.getByText(perishableName).waitFor({ state: 'visible', timeout: 5000 });
  });

  await step('customises the dashboard widget board — hide, re-pin & persist (§3, Phase 45)', async () => {
    await page.goto(`${BASE}`, { waitUntil: 'domcontentloaded' });
    // The new §3 widgets are pinned by default.
    await page.getByTestId('widget-low-stock').waitFor({ state: 'visible', timeout: 8000 });
    await page.getByTestId('widget-projects').waitFor({ state: 'visible', timeout: 5000 });

    // Enter customise (edit) mode and hide the Project-statuses widget; it leaves the
    // board and joins the "hidden widgets" list.
    await page.getByTestId('customise-dashboard').click();
    await page.getByTestId('widget-hide-projects').click();
    await page.getByTestId('widget-projects').waitFor({ state: 'detached', timeout: 5000 });
    await page.getByTestId('widget-add-projects').waitFor({ state: 'visible', timeout: 5000 });

    // Re-pin it — it returns to the board.
    await page.getByTestId('widget-add-projects').click();
    await page.getByTestId('widget-projects').waitFor({ state: 'visible', timeout: 5000 });

    // Hide it once more, finish, and prove the choice survives a reload (the layout is
    // persisted to localStorage — device-local, no DB migration).
    await page.getByTestId('widget-hide-projects').click();
    await page.getByTestId('widget-projects').waitFor({ state: 'detached', timeout: 5000 });
    await page.getByTestId('customise-dashboard').click(); // Done
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByTestId('widget-low-stock').waitFor({ state: 'visible', timeout: 8000 });
    if ((await page.getByTestId('widget-projects').count()) !== 0) {
      throw new Error('hidden dashboard widget reappeared after reload (layout not persisted)');
    }

    // Restore it so the board is left in its default state for later steps.
    await page.getByTestId('customise-dashboard').click();
    await page.getByTestId('widget-add-projects').click();
    await page.getByTestId('customise-dashboard').click();
    await page.getByTestId('widget-projects').waitFor({ state: 'visible', timeout: 5000 });
  });

  await step('resets the dashboard board to its defaults from customise mode', async () => {
    await page.goto(`${BASE}`, { waitUntil: 'domcontentloaded' });
    await page.getByTestId('widget-low-stock').waitFor({ state: 'visible', timeout: 8000 });

    // Customise: hide a widget so the board is demonstrably non-default…
    await page.getByTestId('customise-dashboard').click();
    await page.getByTestId('widget-hide-projects').click();
    await page.getByTestId('widget-projects').waitFor({ state: 'detached', timeout: 5000 });
    await page.getByTestId('hidden-widgets').waitFor({ state: 'visible', timeout: 5000 });

    // …then Reset returns every widget to its default position & visibility, so the
    // hidden widget is pinned again and the "hidden widgets" list empties out.
    await page.getByTestId('reset-dashboard').click();
    await page.getByTestId('widget-projects').waitFor({ state: 'visible', timeout: 5000 });
    await page.getByTestId('hidden-widgets').waitFor({ state: 'detached', timeout: 5000 });

    // The reset persists across a reload (it writes the cleared layout to localStorage).
    await page.getByTestId('customise-dashboard').click(); // Done
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByTestId('widget-projects').waitFor({ state: 'visible', timeout: 8000 });
  });

  await step('shows an offline indicator and announces reconnection (§2 offline-first)', async () => {
    // Emulate losing connectivity: navigator.onLine flips false and the offline event
    // fires, so the root-layout OfflineIndicator reveals its reassurance pill.
    const context = page.context();
    await context.setOffline(true);
    const pill = page.getByTestId('offline-indicator');
    await pill.waitFor({ state: 'visible', timeout: 5000 });
    const announcedOffline = await page.evaluate(() =>
      [...document.querySelectorAll('[role="status"]')].some((n) => /offline/i.test(n.textContent ?? '')),
    );
    if (!announcedOffline) throw new Error('going offline was not announced to assistive tech');

    // Back online: the pill disappears and the live region announces the recovery.
    await context.setOffline(false);
    await pill.waitFor({ state: 'hidden', timeout: 5000 });
    const announcedOnline = await page.evaluate(() =>
      [...document.querySelectorAll('[role="status"]')].some((n) => /back online/i.test(n.textContent ?? '')),
    );
    if (!announcedOnline) throw new Error('coming back online was not announced to assistive tech');
  });

  // --- Phase 10: OPFS Quota Recovery & Archiving (§7.6) ------------------------
  // The Storage Triage Dashboard is only reachable under genuine OPFS pressure, so
  // the smoke forces the critical tier via the DEV-only store seam, and advances the
  // page's Date.now so the freshly-created rows count as "old" for the pruning and
  // image-downgrade windows (everything here is exercised against the real OPFS DB).

  await step('directs the user to Storage Triage from the critical banner (§7.6.2)', async () => {
    await page.goto(`${BASE}inventory`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: 'Add item' }).waitFor({ state: 'visible', timeout: 10000 });
    // Advance time ~400 days and force the critical storage tier.
    await page.evaluate(() => {
      const realNow = Date.now.bind(Date);
      const offset = 400 * 86400000;
      Date.now = () => realNow() + offset;
      const store = /** @type {any} */ (window).__storageStore;
      if (!store) throw new Error('storage store test seam missing (not a DEV build?)');
      store.setState({
        tier: 'critical',
        ratio: 0.93,
        estimate: { usage: 9.3e8, quota: 1e9, ratio: 0.93, supported: true },
      });
    });
    await page.getByTestId('open-storage-triage').click();
    const dialog = page.getByRole('dialog', { name: 'Storage triage' });
    await dialog.waitFor({ state: 'visible', timeout: 5000 });
    // The §7.6.2 per-table breakdown renders all three rows.
    await dialog.getByTestId('triage-row-history').waitFor({ state: 'visible', timeout: 5000 });
    await dialog.getByTestId('triage-row-images').waitFor({ state: 'visible', timeout: 5000 });
    await dialog.getByTestId('triage-row-items').waitFor({ state: 'visible', timeout: 5000 });
    // Phase 15 (§7.6.2): the image figure is now the *measured* on-disk OPFS size — an
    // image was uploaded earlier (still full-res, downgrade happens in a later step).
    const source = await dialog.getByTestId('triage-images-source').innerText();
    if (!/measured/i.test(source)) {
      throw new Error(`expected measured OPFS image bytes, got: "${source}"`);
    }
  });

  await step('prunes old history after a cold-storage JSON download (§7.6.3 A)', async () => {
    const dialog = page.getByRole('dialog', { name: 'Storage triage' });
    // Wait for the candidate count to load so the button enables (avoids arming the
    // download listener against a still-disabled control).
    const pruneBtn = dialog.getByTestId('prune-history');
    for (let i = 0; i < 40 && (await pruneBtn.isDisabled()); i += 1) await page.waitForTimeout(150);
    if (await pruneBtn.isDisabled()) throw new Error('no prunable history was detected');
    // Phase 12: a confirm-before-delete step now guards the action.
    await pruneBtn.click();
    const confirmBtn = dialog.getByTestId('prune-confirm');
    await confirmBtn.waitFor({ state: 'visible', timeout: 4000 });
    // The download must fire BEFORE the delete; assert the archive filename.
    const download = page.waitForEvent('download', { timeout: 8000 });
    await confirmBtn.click();
    const file = await download;
    if (!file.suggestedFilename().startsWith('inventory_history_archive')) {
      throw new Error(`unexpected archive filename: ${file.suggestedFilename()}`);
    }
    if (!file.suggestedFilename().endsWith('.json')) {
      throw new Error(`archive is not JSON: ${file.suggestedFilename()}`);
    }
    await page.getByText('History archived & pruned').waitFor({ state: 'visible', timeout: 5000 });
  });

  await step('downgrades old images keeping the thumbnail (§7.6.3 B)', async () => {
    const dialog = page.getByRole('dialog', { name: 'Storage triage' });
    const downgradeBtn = dialog.getByTestId('downgrade-images');
    for (let i = 0; i < 40 && (await downgradeBtn.isDisabled()); i += 1) await page.waitForTimeout(150);
    if (await downgradeBtn.isDisabled()) throw new Error('no downgradable images were detected');
    // Phase 12: confirm-before-delete guards the downgrade too.
    await downgradeBtn.click();
    const confirmBtn = dialog.getByTestId('downgrade-confirm');
    await confirmBtn.waitFor({ state: 'visible', timeout: 4000 });
    await confirmBtn.click();
    await page.getByText('Images downgraded').waitFor({ state: 'visible', timeout: 5000 });
    await page.keyboard.press('Escape');
  });

  // --- Phase 12: Settings & preferences UI (§3) -------------------------------
  // The previously-headless preferences now have a real screen, reached from the
  // dashboard gear. Theme is applied to the document; the storage windows persist;
  // and the Storage Triage dashboard has a permanent (non-banner) entry-point.

  await step('opens Settings from the dashboard gear and applies the theme (§3)', async () => {
    await page.goto(`${BASE}`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('link', { name: 'Settings' }).first().click();
    await page.getByRole('heading', { name: 'Settings' }).waitFor({ state: 'visible', timeout: 6000 });
    const isDark = () => page.evaluate(() => document.documentElement.classList.contains('dark'));
    // The default theme is dark and is now actually projected onto <html>.
    if (!(await isDark())) throw new Error('expected the dark theme to be applied by default');
    await page.getByTestId('theme-light').click();
    await page.waitForFunction(() => !document.documentElement.classList.contains('dark'), null, {
      timeout: 4000,
    });
    // Switch back so the persisted choice (and later screenshots) stay dark.
    await page.getByTestId('theme-dark').click();
    await page.waitForFunction(() => document.documentElement.classList.contains('dark'), null, {
      timeout: 4000,
    });
  });

  await step('changes and persists preference controls (§3, §4 expiry, §7.6.3 windows)', async () => {
    const expiry = page.getByLabel('Expiring soon window (days)');
    await expiry.fill('45');
    await expiry.blur();
    const pruneWindow = page.getByLabel('Default purge window');
    await pruneWindow.selectOption('12');
    await expectSelectValue(pruneWindow, '12', 'Default purge window');
    // Tier-2 preferences persist to localStorage.
    const stored = await page.evaluate(() =>
      JSON.parse(localStorage.getItem('gubbins:preferences') || '{}'),
    );
    if (stored?.state?.expirySoonWindowDays !== 45) {
      throw new Error(`expiry window not persisted (got ${stored?.state?.expirySoonWindowDays})`);
    }
    if (stored?.state?.pruneWindowMonths !== 12) {
      throw new Error(`prune window not persisted (got ${stored?.state?.pruneWindowMonths})`);
    }
  });

  await step('tunes and persists the low-stock thresholds (§3 Low Stock Alerts, Phase 46)', async () => {
    // The §3 "Low Stock" widget shipped fixed thresholds in Phase 45; Phase 46 surfaces
    // them as Tier-2 preferences (clamped, mirroring the expiry window). Set both,
    // assert they persist to localStorage, and that an out-of-range value is clamped.
    const qty = page.getByLabel('Low-stock quantity threshold');
    await qty.fill('8');
    await qty.blur();
    const gauge = page.getByLabel('Low-stock gauge threshold');
    await gauge.fill('25');
    await gauge.blur();
    let stored = await page.evaluate(() =>
      JSON.parse(localStorage.getItem('gubbins:preferences') || '{}'),
    );
    if (stored?.state?.lowStockQtyThreshold !== 8) {
      throw new Error(`low-stock qty not persisted (got ${stored?.state?.lowStockQtyThreshold})`);
    }
    if (stored?.state?.lowStockGaugePercent !== 25) {
      throw new Error(`low-stock gauge not persisted (got ${stored?.state?.lowStockGaugePercent})`);
    }
    // Out-of-range gauge clamps to the max bound (99), never reaching the read layer.
    await gauge.fill('500');
    await gauge.blur();
    stored = await page.evaluate(() =>
      JSON.parse(localStorage.getItem('gubbins:preferences') || '{}'),
    );
    if (stored?.state?.lowStockGaugePercent !== 99) {
      throw new Error(`low-stock gauge not clamped (got ${stored?.state?.lowStockGaugePercent})`);
    }
    // Restore the default so later steps and screenshots are unaffected.
    await gauge.fill('15');
    await gauge.blur();
  });

  await step('reaches Storage Triage from the permanent Settings entry-point (§7.6.2)', async () => {
    await page.getByTestId('open-storage-triage-settings').click();
    const dialog = page.getByRole('dialog', { name: 'Storage triage' });
    await dialog.waitFor({ state: 'visible', timeout: 5000 });
    // The chosen default window flows through to the triage control.
    await expectSelectValue(dialog.getByTestId('prune-months'), '12', 'Triage prune window');
    await dialog.getByTestId('triage-row-items').waitFor({ state: 'visible', timeout: 5000 });
    await page.keyboard.press('Escape');
  });

  // --- Phase 16: currency/locale propagation (§3) + System theme (§2.1) --------
  // The Settings controls already *set* the base currency / locale; Phase 16 routed
  // every Intl/currency call site through them via `useFormatters`. Prove a live
  // formatter (the project BOM total) honours a non-default currency, and that the
  // new "System" theme tracks the OS colour scheme reactively.

  await step('honours the chosen base currency end-to-end (§3 currency propagation)', async () => {
    // Still on Settings: switch to USD / en-US and confirm the choice persists.
    await page.getByTestId('setting-currency').selectOption('USD');
    await page.getByTestId('setting-locale').selectOption('en-US');
    const stored = await page.evaluate(() =>
      JSON.parse(localStorage.getItem('gubbins:preferences') || '{}'),
    );
    if (stored?.state?.baseCurrency !== 'USD' || stored?.state?.locale !== 'en-US') {
      throw new Error(
        `currency/locale not persisted (got ${stored?.state?.baseCurrency}/${stored?.state?.locale})`,
      );
    }
    // The project BOM total is rendered by the live formatter — it must now be USD.
    await page.goto(`${BASE}projects`, { waitUntil: 'domcontentloaded' });
    await page.getByTestId('project-total-cost').waitFor({ state: 'visible', timeout: 8000 });
    await page.waitForFunction(
      () => document.querySelector('[data-testid="project-total-cost"]')?.textContent?.includes('$'),
      null,
      { timeout: 5000 },
    );
    // Restore the locked GBP / en-GB defaults so later steps + the screenshot stay clean.
    await page.goto(`${BASE}settings`, { waitUntil: 'domcontentloaded' });
    await page.getByTestId('setting-currency').selectOption('GBP');
    await page.getByTestId('setting-locale').selectOption('en-GB');
  });

  await step('the System theme follows prefers-color-scheme live (§2.1)', async () => {
    await page.getByTestId('theme-system').click();
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.waitForFunction(() => document.documentElement.classList.contains('dark'), null, {
      timeout: 4000,
    });
    // Flipping the emulated OS scheme must re-apply live (the §2.1 media listener).
    await page.emulateMedia({ colorScheme: 'light' });
    await page.waitForFunction(() => !document.documentElement.classList.contains('dark'), null, {
      timeout: 4000,
    });
    // Restore an explicit dark theme + default media for later steps/screenshot.
    await page.getByTestId('theme-dark').click();
    await page.emulateMedia({ colorScheme: null });
    await page.waitForFunction(() => document.documentElement.classList.contains('dark'), null, {
      timeout: 4000,
    });
  });

  await step('honours prefers-reduced-motion: drops decorative entrance motion (§3 a11y, Phase 43)', async () => {
    await page.goto(`${BASE}inventory`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: 'Add item' }).waitFor({ state: 'visible', timeout: 10000 });

    // 1) Emulate the OS reduced-motion preference and confirm the app's seam sees it.
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const reducedSeen = await page.evaluate(
      () => matchMedia('(prefers-reduced-motion: reduce)').matches,
    );
    if (!reducedSeen) throw new Error('app did not observe prefers-reduced-motion: reduce');

    // The Foundry Modal must NOT apply its `animate-zoom-in` entrance class at source.
    await page.getByRole('button', { name: 'Add item' }).click();
    let dialog = page.getByRole('dialog', { name: 'Add item' });
    await dialog.waitFor({ state: 'visible', timeout: 5000 });
    const animatedUnderReduce = await page.evaluate(
      () => !!document.querySelector('[role="dialog"] .animate-zoom-in'),
    );
    if (animatedUnderReduce) {
      throw new Error('modal kept its entrance animation under reduced motion');
    }
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'hidden', timeout: 5000 });

    // 2) With motion permitted again, the entrance animation returns (proves the gate
    //    is preference-driven, not unconditionally disabled).
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.getByRole('button', { name: 'Add item' }).click();
    dialog = page.getByRole('dialog', { name: 'Add item' });
    await dialog.waitFor({ state: 'visible', timeout: 5000 });
    const animatedWithMotion = await page.evaluate(
      () => !!document.querySelector('[role="dialog"] .animate-zoom-in'),
    );
    if (!animatedWithMotion) {
      throw new Error('modal lost its entrance animation even with motion permitted');
    }
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'hidden', timeout: 5000 });
    // Restore the system default for later steps / the screenshot.
    await page.emulateMedia({ reducedMotion: null });
  });

  await step('captures beforeinstallprompt and offers a one-tap PWA install (§2 installation, Phase 44)', async () => {
    await page.goto(`${BASE}settings`, { waitUntil: 'domcontentloaded' });
    // Before any install event, the affordance falls back to manual guidance.
    await page.getByTestId('install-state').waitFor({ state: 'visible', timeout: 10000 });

    // Simulate the platform firing the (non-standard) beforeinstallprompt event —
    // Playwright/automation never fires it for real, so dispatch a faithful stub.
    await page.evaluate(() => {
      const event = new Event('beforeinstallprompt');
      event.prompt = async () => {
        window.__gubbinsInstallPrompted = true;
      };
      window.dispatchEvent(event);
    });

    // The one-tap install control now appears (the event was captured + held)...
    const installButton = page.getByTestId('install-app-settings');
    await installButton.waitFor({ state: 'visible', timeout: 5000 });

    // ...and clicking it triggers the native install dialog (our stubbed prompt()).
    await installButton.click();
    const prompted = await page.evaluate(() => window.__gubbinsInstallPrompted === true);
    if (!prompted) throw new Error('install button did not trigger the native install prompt');

    // The captured event is single-use, so the control retracts to the manual fallback.
    await page.getByTestId('install-state').waitFor({ state: 'visible', timeout: 5000 });
  });

  // --- Phase 34: single-format scanner symbology (§6.6) ------------------------
  // The scanner can be narrowed to one symbology so the off-thread zxing worker hints a
  // single format (~4× cheaper per frame). Prove the Settings control persists the choice,
  // then restore the default so the live-scan steps keep scanning everything.
  await step('persists the single-format scanner symbology preference (§6.6)', async () => {
    await page.goto(`${BASE}settings`, { waitUntil: 'domcontentloaded' });
    await page.getByTestId('setting-scanner-symbology').selectOption('qr_code');
    const stored = await page.evaluate(() =>
      JSON.parse(localStorage.getItem('gubbins:preferences') || '{}'),
    );
    if (stored?.state?.scannerSymbology !== 'qr_code') {
      throw new Error(`scanner symbology not persisted (got ${stored?.state?.scannerSymbology})`);
    }
    // Restore the default (scan all codes) so later/mobile scan steps are unaffected.
    await page.getByTestId('setting-scanner-symbology').selectOption('all');
    await expectSelectValue(
      page.getByTestId('setting-scanner-symbology'),
      'all',
      'Scanner symbology',
    );
  });

  // --- Phase 57: mutable scanner feedback (§6.5) -------------------------------
  // The beep + haptic confirmation fires on every scan and is now user-mutable.
  // Prove the Settings controls persist both flags, then restore the defaults.
  await step('persists the mutable scanner beep/haptic preferences (§6.5)', async () => {
    await page.goto(`${BASE}settings`, { waitUntil: 'domcontentloaded' });
    await page.getByTestId('setting-scanner-beep').selectOption('off');
    await page.getByTestId('setting-scanner-haptics').selectOption('off');
    const stored = await page.evaluate(() =>
      JSON.parse(localStorage.getItem('gubbins:preferences') || '{}'),
    );
    if (stored?.state?.scannerBeep !== false || stored?.state?.scannerHaptics !== false) {
      throw new Error(
        `scanner feedback not persisted (beep=${stored?.state?.scannerBeep}, haptics=${stored?.state?.scannerHaptics})`,
      );
    }
    // Restore the defaults (both on) so later/mobile scan steps are unaffected.
    await page.getByTestId('setting-scanner-beep').selectOption('on');
    await page.getByTestId('setting-scanner-haptics').selectOption('on');
    await expectSelectValue(page.getByTestId('setting-scanner-beep'), 'on', 'Beep on scan');
    await expectSelectValue(page.getByTestId('setting-scanner-haptics'), 'on', 'Vibrate on scan');
  });

  await step('bounds the virtualised list memory: a deep scroll trims then refills pages (§2.1, Phase 37)', async () => {
    await page.goto(`${BASE}inventory`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: 'Add item' }).waitFor({ state: 'visible', timeout: 10000 });

    // Seed past MAX_LIST_PAGES × DEFAULT_PAGE_SIZE (6 × 50 = 300) so a deep scroll
    // forces the infinite query to trim a leading page — the memory bound under test.
    // Zero-padded names sort lexically = numerically, so paging order is deterministic
    // (the list orders by name even when an FTS search filter is applied).
    const seedPrefix = `ZzList${stamp}`;
    const SEED = 305;
    const seeded = await page.evaluate(
      async ({ base, prefix, total }) => {
        const repos = await import(`${base}src/db/repositories/index.ts`);
        const repo = repos.getItemRepository();
        const pad = (n) => String(n).padStart(3, '0');
        // Chunk the creates so request latency doesn't stack 305 round-trips deep.
        for (let start = 0; start < total; start += 20) {
          const batch = [];
          for (let i = start; i < Math.min(start + 20, total); i += 1) {
            batch.push(repo.create({ name: `${prefix} ${pad(i)}`, trackingMode: 'DISCRETE', quantity: 1 }));
          }
          await Promise.all(batch);
        }
        return repo.count({ search: prefix });
      },
      { base: BASE, prefix: seedPrefix, total: SEED },
    );
    if (seeded < SEED) throw new Error(`seed incomplete: ${seeded}/${SEED}`);

    // Filter to exactly the seeded items (a fresh query key → includes the new rows).
    const search = page.getByRole('textbox', { name: 'Search items' });
    await search.fill(seedPrefix);
    const firstItem = page.getByText(`${seedPrefix} 000`, { exact: true });
    await firstItem.first().waitFor({ state: 'visible', timeout: 6000 });

    const container = page.getByTestId('item-list-scroll');
    const lastName = `${seedPrefix} ${String(SEED - 1).padStart(3, '0')}`;
    const lastItem = page.getByText(lastName, { exact: true });

    // Scroll to the tail: loads all 7 pages, trimming the leading page once the 7th
    // arrives. If absolute indexing were broken the rows would misalign and the tail
    // would never resolve into view.
    for (let i = 0; i < 50; i += 1) {
      if (await lastItem.count()) break;
      await container.evaluate((el) => {
        el.scrollTop = el.scrollHeight;
      });
      await page.waitForTimeout(120);
    }
    await lastItem.first().waitFor({ state: 'visible', timeout: 5000 });

    // Scroll back to the head: the trimmed-off prefix must refill (fetchPreviousPage),
    // proving the bounded window slides both ways without losing the start of the list.
    for (let i = 0; i < 50; i += 1) {
      if (await firstItem.count()) {
        if (await firstItem.first().isVisible()) break;
      }
      await container.evaluate((el) => {
        el.scrollTop = 0;
      });
      await page.waitForTimeout(120);
    }
    await firstItem.first().waitFor({ state: 'visible', timeout: 5000 });

    // Clear the filter so the screenshot / any later desktop assertion is unaffected.
    await search.fill('');
  });

  await page.screenshot({ path: 'scripts/.smoke-screenshot.png', fullPage: true });

  // --- Phase 15: mobile-emulation context (§2.7 auto-archive + §6.6 WASM scanner) ---
  // A separate mobile context so two desktop-Edge-unreachable paths can be driven:
  //  • the §2.7 weekly Full-Archive banner is mobile-gated (isLikelyMobile() + no Cloud
  //    Sync), so the desktop page never shows it (carried-over Phase-14 residual);
  //  • forcing the native BarcodeDetector absent exercises the §6.6 WASM fallback that
  //    Firefox/Safari would take — now an **off-thread** decode in a Web Worker (Phase 31:
  //    capture frame → ImageBitmap → transfer → zxing core decode on an OffscreenCanvas)
  //    driven on an **adaptive frame-skip cadence** (Phase 32: the idle camera in this step
  //    naturally backs the worker decode off, then re-acquires fast on a hit).
  const mobile = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  });
  // Force the mobile signal (deterministic isLikelyMobile) and remove the native
  // Barcode Detection API so the scanner must resolve the WASM fallback engine.
  await mobile.addInitScript(() => {
    Object.defineProperty(navigator, 'userAgentData', {
      configurable: true,
      get: () => ({ mobile: true }),
    });
    try {
      Object.defineProperty(window, 'BarcodeDetector', { configurable: true, value: undefined });
    } catch {
      /* already gone */
    }
  });
  const mpage = await mobile.newPage();
  mpage.setDefaultTimeout(5000);
  mpage.setDefaultNavigationTimeout(10000);
  mpage.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(`[mobile] ${msg.text()}`);
  });
  mpage.on('pageerror', (err) => pageErrors.push(`[mobile] ${String(err)}`));

  await step('mobile: the §2.7 weekly Full-Archive banner appears and downloads (§2.7)', async () => {
    await mpage.goto(`${BASE}inventory`, { waitUntil: 'domcontentloaded' });
    await mpage.getByRole('button', { name: 'Add item' }).waitFor({ state: 'visible', timeout: 10000 });
    const archiveBtn = mpage.getByTestId('run-archive');
    await archiveBtn.waitFor({ state: 'visible', timeout: 6000 });
    const download = mpage.waitForEvent('download', { timeout: 10000 });
    await archiveBtn.click();
    const file = await download;
    if (!file.suggestedFilename().endsWith('.zip')) {
      throw new Error(`unexpected archive filename: ${file.suggestedFilename()}`);
    }
  });

  await step('mobile: the scanner resolves the §6.6 off-thread WASM worker engine', async () => {
    await mpage.getByRole('button', { name: 'Scan' }).click();
    const overlay = mpage.locator('[data-testid="scanner-overlay"]');
    await overlay.waitFor({ state: 'visible', timeout: 5000 });
    // With BarcodeDetector absent, useScanner spawns the Phase-31 decode Worker (zxing
    // core on an OffscreenCanvas). 'wasm' is now produced *only* by that worker decoder,
    // so the engine badge appearing proves the off-thread path resolved — and the global
    // console/page-error guards prove createImageBitmap + transfer + worker decode run
    // cleanly per frame in a real browser. Holding the overlay open with no code in view
    // also drives the Phase-32 adaptive frame-skip cadence through its idle backoff.
    await mpage
      .locator('[data-testid="scanner-engine-wasm"]')
      .waitFor({ state: 'visible', timeout: 8000 });
    // Manual entry still works on the fallback path (feed a non-item code: just a notice).
    await mpage.locator('[data-testid="scanner-manual-input"]').fill('not-a-gubbins-code');
    await mpage.locator('[data-testid="scanner-manual-submit"]').click();
    await mpage.getByRole('button', { name: 'Close scanner' }).click();
  });

  await mobile.close();

  // --- Phase 33: no-OffscreenCanvas context (§6.6 'wasm-canvas' main-thread-capture) ---
  // A second mobile context that additionally removes OffscreenCanvas, emulating Safari < 16.4
  // (which has Worker + a 2-D canvas but no OffscreenCanvas). The 'wasm' tier (worker +
  // OffscreenCanvas) is therefore unavailable, so the scanner must resolve the Phase-33
  // 'wasm-canvas' engine: the main thread reads each frame off a regular 2-D <canvas> and
  // transfers the RGBA pixels to the SAME decode worker (no OffscreenCanvas used). The global
  // console/page-error guards prove the canvas capture + transfer + worker decode run cleanly.
  const safari = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 16_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.3 Mobile/15E148 Safari/604.1',
  });
  await safari.addInitScript(() => {
    Object.defineProperty(navigator, 'userAgentData', {
      configurable: true,
      get: () => ({ mobile: true }),
    });
    for (const name of ['BarcodeDetector', 'OffscreenCanvas']) {
      try {
        Object.defineProperty(window, name, { configurable: true, value: undefined });
      } catch {
        /* already gone */
      }
    }
  });
  const spage = await safari.newPage();
  spage.setDefaultTimeout(5000);
  spage.setDefaultNavigationTimeout(10000);
  spage.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(`[safari] ${msg.text()}`);
  });
  spage.on('pageerror', (err) => pageErrors.push(`[safari] ${String(err)}`));

  await step('safari<16.4: the scanner resolves the §6.6 main-thread-capture worker engine', async () => {
    await spage.goto(`${BASE}inventory`, { waitUntil: 'domcontentloaded' });
    await spage.getByRole('button', { name: 'Add item' }).waitFor({ state: 'visible', timeout: 10000 });
    await spage.getByRole('button', { name: 'Scan' }).click();
    const overlay = spage.locator('[data-testid="scanner-overlay"]');
    await overlay.waitFor({ state: 'visible', timeout: 5000 });
    // With BarcodeDetector AND OffscreenCanvas absent, useScanner falls through to the
    // 'wasm-canvas' tier; its engine badge appearing proves the main-thread 2-D-canvas
    // capture → worker pixel-decode path resolved (and ran without console/page errors).
    await spage
      .locator('[data-testid="scanner-engine-wasm-canvas"]')
      .waitFor({ state: 'visible', timeout: 8000 });
    // Manual entry still works on the fallback path (feed a non-item code: just a notice).
    await spage.locator('[data-testid="scanner-manual-input"]').fill('not-a-gubbins-code');
    await spage.locator('[data-testid="scanner-manual-submit"]').click();
    await spage.getByRole('button', { name: 'Close scanner' }).click();
  });

  await safari.close();
  } // end if (!PWA_ONLY)

  // --- §2 PWA update handshake (production build, own server + own context) --------
  // Verifies the user-facing update *contract* end-to-end: a waiting service worker →
  // the real "A new version is ready" banner (data-testid="pwa-update-prompt") appears →
  // clicking the real "Reload now" (data-testid="pwa-reload-now") activates the new
  // worker and reloads the page onto it (via controllerchange).
  //
  // MECHANISM: real two-build, against the PRODUCTION bundle. The service worker is
  // disabled in dev (vite-plugin-pwa `devOptions.enabled:false`), so this contract can
  // ONLY be exercised against the built app in `dist/`. This block:
  //   1. Spins up its OWN tiny Node `http` static server over `dist/`, sending the
  //      cross-origin-isolation headers (COOP/COEP + CORP) `vite preview` sets — so the
  //      app boots cross-origin-isolated, SharedArrayBuffer works, and the REAL service
  //      worker (sw.js, scope /Gubbins/) registers and controls the page. The server
  //      keeps the CURRENTLY-served sw.js bytes in memory so the update (step 2 below)
  //      is a genuine byte change the browser's SW byte-comparison detects.
  //   2. Loads the app in a FRESH browser context (own console/page-error capture) and
  //      waits for the real worker to install, activate, and control the page.
  //   3. Produces a GENUINE waiting worker by mutating the SERVED sw.js bytes (appending a
  //      harmless comment) and calling `registration.update()` from the page — exactly the
  //      check usePwaUpdate performs on its timer/visibility. The browser byte-compares,
  //      installs the new worker, and — because src/sw.ts deliberately does NOT
  //      skipWaiting() on install (the `prompt` flow) — it parks in WAITING. The real
  //      workbox-window `registerSW` fires its `waiting`→`onNeedRefresh` callback →
  //      usePwaUpdate flips `needRefresh` → React renders the REAL PwaUpdatePrompt banner.
  //   4. Asserts the real banner DOM, clicks the real "Reload now", and asserts the
  //      handshake completes: usePwaUpdate.update(true) → workbox messageSkipWaiting()
  //      posts {type:'SKIP_WAITING'} → the waiting worker activates + clients.claim() →
  //      `controllerchange` fires → workbox reloads the page onto a now-controlling worker
  //      whose scriptURL byte-differs from the one in charge before the click.
  //
  // Nothing is faked at the React layer: the real production bundle, the real workbox-window
  // registration, the real usePwaUpdate hook and the real banner component all run — and the
  // served sw.js is the genuine shipped worker, byte-for-byte off disk (the only mutation is
  // the appended comment in step 3 that makes the *update* a real byte change).
  //
  // (History: writing this E2E surfaced a real product bug — vite-plugin-pwa's injectManifest
  //  emitted the PWA-manifest icons TWICE in `self.__WB_MANIFEST`, so `cache.addAll` rejected
  //  with "duplicate requests" and the worker failed to install (`redundant`) under
  //  `vite preview` and on GitHub Pages. That is now fixed at source: src/sw.ts de-duplicates
  //  the precache URLs by `Set` before `addAll`, so this test exercises the real worker with
  //  no server-side rewriting.)
  //
  // BUILD PRECONDITION: needs `dist/index.html` (a production build, `npm run build`).
  // When absent it logs a prominent SKIPPED notice rather than silently passing — the
  // existing smoke also runs against dev, and the integrator runs this after a build.
  {
    const __pwaDir = path.dirname(fileURLToPath(import.meta.url));
    const distDir = path.resolve(__pwaDir, '..', 'dist');
    const distIndex = path.join(distDir, 'index.html');

    if (!existsSync(distIndex)) {
      console.log(
        '  ⚠ PWA update handshake SKIPPED — requires a production build (run `npm run build` to emit dist/), then re-run. The service worker is disabled in dev, so the update contract is only exercisable against the built app.',
      );
    } else {
      const BASE_PREFIX = '/Gubbins/';
      const swPath = path.join(distDir, 'sw.js');

      // The bytes the server currently serves for sw.js. Starts as the real on-disk worker;
      // the update step swaps in a byte-different variant to trigger the waiting worker.
      // The on-disk dist/sw.js is NEVER mutated — this all lives in memory.
      let servedSw = readFileSync(swPath);

      const CONTENT_TYPES = {
        '.html': 'text/html; charset=utf-8',
        '.js': 'text/javascript; charset=utf-8',
        '.mjs': 'text/javascript; charset=utf-8',
        '.css': 'text/css; charset=utf-8',
        '.json': 'application/json; charset=utf-8',
        '.webmanifest': 'application/manifest+json; charset=utf-8',
        '.svg': 'image/svg+xml',
        '.png': 'image/png',
        '.ico': 'image/x-icon',
        '.woff2': 'font/woff2',
        '.wasm': 'application/wasm',
        '.map': 'application/json; charset=utf-8',
      };

      // A tiny static server for dist/, mounted under the Vite `base` (/Gubbins/). It sends
      // the cross-origin-isolation headers `vite preview` sets (so the app is COI-capable)
      // and falls back to index.html for SPA navigations. sw.js is served from the in-memory
      // `servedSw` buffer (the real on-disk worker, swapped for a byte-different one mid-test).
      const server = createServer((req, res) => {
        try {
          let urlPath = decodeURIComponent((req.url ?? '/').split('?')[0]);
          if (urlPath.startsWith(BASE_PREFIX)) urlPath = urlPath.slice(BASE_PREFIX.length - 1);
          else if (urlPath === '/Gubbins') urlPath = '/';
          if (urlPath === '/' || urlPath === '') urlPath = '/index.html';

          let filePath = path.join(distDir, path.normalize(urlPath).replace(/^([/\\])+/, ''));
          // Keep traversal inside dist/.
          if (!filePath.startsWith(distDir)) {
            res.writeHead(403).end('forbidden');
            return;
          }
          const isSw = filePath === swPath;
          // SPA fallback: a navigation to a route with no file on disk serves the shell.
          if (!isSw && (!existsSync(filePath) || statSync(filePath).isDirectory())) {
            filePath = distIndex;
          }
          const ext = path.extname(filePath).toLowerCase();
          const body = isSw ? servedSw : readFileSync(filePath);
          res.writeHead(200, {
            'Content-Type': CONTENT_TYPES[ext] ?? 'application/octet-stream',
            'Content-Length': body.length,
            // Cross-origin isolation (spec §2.2.6) — mirrors vite.config.ts preview.headers.
            'Cross-Origin-Opener-Policy': 'same-origin',
            'Cross-Origin-Embedder-Policy': 'require-corp',
            'Cross-Origin-Resource-Policy': 'cross-origin',
            // The SW script must never be cached by the browser between update() calls, or
            // the byte-comparison that triggers the waiting worker could read a stale copy.
            'Cache-Control': 'no-store',
            // vite-plugin-pwa registers sw.js with scope /Gubbins/; the default
            // Service-Worker-Allowed scope is the script's directory, which already
            // satisfies that, but set it explicitly for robustness.
            ...(isSw ? { 'Service-Worker-Allowed': BASE_PREFIX } : {}),
          });
          res.end(req.method === 'HEAD' ? undefined : body);
        } catch {
          res.writeHead(500).end('error');
        }
      });

      let pwaContext;
      try {
        // Bring the server up on an ephemeral port and wait until it accepts connections.
        const origin = await new Promise((resolve, reject) => {
          server.once('error', reject);
          server.listen(0, '127.0.0.1', () => {
            const addr = server.address();
            resolve(`http://127.0.0.1:${addr.port}`);
          });
        });
        const pwaBase = `${origin}${BASE_PREFIX}`;

        // A fresh, isolated context with its own error capture, so a production-boot issue
        // here is attributed to the PWA block and doesn't bleed into the dev-server run.
        pwaContext = await browser.newContext();
        const ppage = await pwaContext.newPage();
        ppage.setDefaultTimeout(5000);
        ppage.setDefaultNavigationTimeout(10000);
        ppage.on('console', (msg) => {
          if (msg.type() === 'error') consoleErrors.push(`[pwa] ${msg.text()}`);
        });
        ppage.on('pageerror', (err) => pageErrors.push(`[pwa] ${String(err)}`));

        /** Poll (in-page) for the real worker to install, activate, and control the page. */
        const waitForController = async (label) => {
          const diag = await ppage.evaluate(async () => {
            const out = { active: null, controller: null, err: null };
            try {
              // Precaching the full app shell (incl. the SQLite WASM blob) can take a while
              // headlessly, so allow generous headroom for install→activate→claim.
              for (let i = 0; i < 250; i += 1) {
                const reg = await navigator.serviceWorker.getRegistration();
                if (reg) {
                  out.active =
                    reg.active?.state ?? (reg.installing ? 'installing' : reg.waiting ? 'waiting' : null);
                }
                out.controller = navigator.serviceWorker.controller?.scriptURL ?? null;
                if (out.controller && out.active === 'activated') break;
                await new Promise((r) => setTimeout(r, 100));
              }
            } catch (e) {
              out.err = String(e);
            }
            return out;
          });
          if (!diag.controller || diag.active !== 'activated') {
            throw new Error(`${label}: service worker did not take control (state=${JSON.stringify(diag)})`);
          }
          return diag.controller;
        };

        let controllerBefore = '';
        await step('PWA: the production build boots, cross-origin isolated, and the SW takes control', async () => {
          await ppage.goto(`${pwaBase}inventory`, { waitUntil: 'domcontentloaded' });
          await ppage.getByRole('button', { name: 'Add item' }).waitFor({ state: 'visible', timeout: 10000 });
          const isolated = await ppage.evaluate(() => self.crossOriginIsolated === true);
          if (!isolated) throw new Error('production context is not cross-origin isolated');
          controllerBefore = await waitForController('initial boot');
        });

        await step('PWA: a waiting worker surfaces the real "A new version is ready" banner (§2 prompt)', async () => {
          // Swap the served sw.js for a byte-different variant so the browser's SW byte-
          // comparison sees a NEW worker on the next update() check. A trailing comment
          // suffices; install does NOT skipWaiting (src/sw.ts) so the new worker parks in
          // WAITING → workbox `waiting` → onNeedRefresh.
          servedSw = Buffer.concat([servedSw, Buffer.from(`\n// smoke update ${Date.now()}\n`, 'utf8')]);

          // Ask the active registration to re-fetch the worker — exactly what usePwaUpdate's
          // periodic / visibility check does. This drives the real workbox onNeedRefresh path.
          await ppage.evaluate(async () => {
            const reg = await navigator.serviceWorker.getRegistration();
            if (!reg) throw new Error('no registration to update');
            await reg.update();
          });

          // The REAL PwaUpdatePrompt banner appears (workbox waiting → onNeedRefresh →
          // usePwaUpdate.needRefresh → React render). Give the install a little headroom.
          await ppage.getByTestId('pwa-update-prompt').waitFor({ state: 'visible', timeout: 12000 });
          await ppage.getByText('A new version is ready').waitFor({ state: 'visible', timeout: 5000 });
          await ppage.getByTestId('pwa-reload-now').waitFor({ state: 'visible', timeout: 5000 });
        });

        await step('PWA: "Reload now" activates the waiting worker and reloads onto it (§2 controllerchange)', async () => {
          // Instrument the live page BEFORE the click so we can observe the real handshake:
          //  • a window sentinel a genuine reload wipes (proves the page navigated);
          //  • a controllerchange flag recorded in sessionStorage (survives the reload), so
          //    we can prove the waiting worker took over.
          // We also attach the SAME controllerchange→reload listener production ships in
          // public/coi-bootstrap.js. In production that bootstrap reloads the page when the
          // new worker takes control; here it was skipped only because this context was
          // ALREADY cross-origin-isolated (the static server sends COOP/COEP), so its
          // listener never registered. Re-attaching its exact behaviour makes the reload —
          // the user-visible effect — actually happen, so the assertions below verify a real
          // reload onto the new version, not just the under-the-hood worker swap.
          await ppage.evaluate(() => {
            window.__smokeNoReload = true;
            navigator.serviceWorker.addEventListener('controllerchange', () => {
              try {
                sessionStorage.setItem('__smokeControllerChanged', '1');
              } catch {
                /* ignore */
              }
              // Mirrors public/coi-bootstrap.js: reload once when the new worker controls us.
              if (!sessionStorage.getItem('__smokeReloaded')) {
                sessionStorage.setItem('__smokeReloaded', '1');
                window.location.reload();
              }
            });
          });

          // Sanity-check the waiting worker is parked before we accept the prompt.
          const pre = await ppage.evaluate(async () => {
            const reg = await navigator.serviceWorker.getRegistration();
            return { waiting: !!reg?.waiting, controller: navigator.serviceWorker.controller?.scriptURL ?? null };
          });
          if (!pre.waiting) throw new Error('no waiting worker before clicking "Reload now"');

          // Click the REAL "Reload now": usePwaUpdate.update(true) → workbox
          // messageSkipWaiting() posts {type:'SKIP_WAITING'} → src/sw.ts skipWaiting() →
          // activate + clients.claim() → controllerchange. workbox's `controlling` handler
          // (and, in production, coi-bootstrap.js) then reloads the page onto the new worker.
          await ppage.getByTestId('pwa-reload-now').click();

          // Wait for the page to RELOAD onto the new version: the in-memory sentinel is gone
          // after the controllerchange→reload navigation.
          await ppage.waitForFunction(() => window.__smokeNoReload !== true, undefined, {
            timeout: 12000,
          });

          // Prove the under-the-hood handshake completed (independent of the reload):
          // controllerchange fired, the previously-WAITING worker activated, and a worker
          // controls the freshly-reloaded page. sessionStorage survives the reload.
          await ppage.getByRole('button', { name: 'Add item' }).waitFor({ state: 'visible', timeout: 10000 });
          const result = await ppage.evaluate(async () => {
            const reg = await navigator.serviceWorker.getRegistration();
            return {
              changed: sessionStorage.getItem('__smokeControllerChanged') === '1',
              reloaded: sessionStorage.getItem('__smokeReloaded') === '1',
              waiting: !!reg?.waiting,
              active: reg?.active?.state ?? null,
              controller: navigator.serviceWorker.controller?.scriptURL ?? null,
            };
          });
          if (!result.changed) throw new Error('controllerchange never fired — the waiting worker did not take over');
          if (!result.reloaded) throw new Error('the page did not reload onto the new version');
          if (!result.controller || result.active !== 'activated') {
            throw new Error(`no active controlling worker after reload (state=${JSON.stringify(result)})`);
          }
          void controllerBefore; // captured for context; the hashed sw.js URL is stable across the byte mutation.

          // The reload onto the new version clears needRefresh, so the prompt is gone.
          const stillVisible = await ppage
            .getByTestId('pwa-update-prompt')
            .isVisible()
            .catch(() => false);
          if (stillVisible) throw new Error('the update banner is still visible after the reload');
        });
      } finally {
        // Tear the context + server down so this block never leaks a port/process. The
        // on-disk dist/ is untouched (the served-sw byte mutation lived only in memory), so
        // there is nothing to restore.
        if (pwaContext) await pwaContext.close().catch(() => {});
        await new Promise((resolve) => server.close(() => resolve()));
      }
    }
  }
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
