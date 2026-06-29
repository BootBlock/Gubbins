/**
 * Throwaway parity CLI (Phase HA-1 acceptance).
 *
 * Hydrates a real exported `gubbins-sync.json` and prints the active-item count plus
 * one sample item with its location name, to confirm the headless database matches
 * what the app would show. Driven through the app's own repositories — no bespoke
 * SQL here — so a green run is genuine evidence of parity.
 *
 *   node bridge/cli.mjs <path-to-gubbins-sync.json>
 *
 * Superseded by the HTTP server in later phases; intentionally minimal.
 */
import { ItemRepository } from '@/db/repositories/ItemRepository.ts';
import { LocationRepository } from '@/db/repositories/LocationRepository.ts';
import { emptyAst } from '@/db/search/ast.ts';
import { hydrateFromFile } from './hydrate.ts';

async function main(): Promise<void> {
  const snapshotPath = process.argv[2];
  if (!snapshotPath) {
    console.error('Usage: node bridge/cli.mjs <path-to-gubbins-sync.json>');
    process.exitCode = 1;
    return;
  }

  const { driver, snapshot, migration } = await hydrateFromFile(snapshotPath);
  try {
    const items = new ItemRepository(driver);
    const locations = new LocationRepository(driver);

    const generatedAt = new Date(snapshot.generatedAt).toISOString();
    console.log(`Snapshot: ${snapshotPath}`);
    console.log(`  format version : ${snapshot.formatVersion}`);
    console.log(`  generated at   : ${generatedAt}`);
    console.log(`  schema migrated: v${migration.from} → v${migration.to}`);

    // `emptyAst()` translates to "match everything", so this counts/lists all active
    // items through the exact search path the app uses (parseASTtoSQL → FTS).
    const all = emptyAst('AND');
    const total = await items.countByAst(all);
    console.log(`\nActive items: ${total}`);

    const firstPage = await items.searchByAst(all, { limit: 1 });
    const sample = firstPage.rows[0];
    if (!sample) {
      console.log('(no items in this snapshot)');
      return;
    }

    const location = await locations.getById(sample.locationId);
    const locationName = location?.name ?? '(unknown location)';
    console.log('\nSample item:');
    console.log(`  name     : ${sample.name}`);
    console.log(`  quantity : ${sample.quantity}`);
    console.log(`  location : ${locationName}`);
    if (sample.mpn) console.log(`  mpn      : ${sample.mpn}`);
    if (sample.manufacturer) console.log(`  maker    : ${sample.manufacturer}`);
  } finally {
    await driver.close();
  }
}

main().catch((err: unknown) => {
  console.error(`\nBridge CLI failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
