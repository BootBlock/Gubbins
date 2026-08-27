/**
 * MCP tool-registry tests over the SYNTHETIC fixture (made-up parts, no real or personal
 * data). Each tool is driven directly against a real hydrated driver — asserting its result
 * shape, the not-found path, the bounds/clamps, and that invalid arguments raise a
 * {@link ToolInputError} (which the dispatcher turns into a model-visible error result).
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hydrateFromJson, type HydrateResult } from '../hydrate.ts';
import { createWriteExecutor, MAX_NOTE_LENGTH } from '../write.ts';
import { createVirtualSnapshot } from '../fixtures/virtual-snapshot.ts';
import { SYSTEM_USER_ID } from '@/db/repositories/constants';
import { ALL_TOOLS, createWriteTools, findTool, ToolInputError, type McpTool } from './tools.ts';

const FIXTURE_URL = new URL('../fixtures/synthetic-snapshot.json', import.meta.url);

let hydrated: HydrateResult;

beforeEach(async () => {
  hydrated = await hydrateFromJson(await readFile(fileURLToPath(FIXTURE_URL), 'utf8'));
});

afterEach(async () => {
  await hydrated.driver.close();
});

/** Run a tool by name against the hydrated fixture. */
function run(name: string, args: Record<string, unknown>): Promise<unknown> {
  const tool = findTool(name);
  if (tool === undefined) throw new Error(`No such tool: ${name}`);
  return tool.run(hydrated.driver, args);
}

describe('the registry', () => {
  it('exposes exactly the six read-only gubbins_* tools', () => {
    expect(ALL_TOOLS.map((t: McpTool) => t.name)).toEqual([
      'gubbins_search',
      'gubbins_where_is',
      'gubbins_get_item',
      'gubbins_list_locations',
      'gubbins_list_categories',
      'gubbins_list_capabilities',
    ]);
  });

  it('gives every tool a description and an object input schema', () => {
    for (const tool of ALL_TOOLS) {
      expect(tool.description.length).toBeGreaterThan(0);
      expect(tool.inputSchema.type).toBe('object');
    }
  });
});

describe('gubbins_search', () => {
  it('returns compact matches for a hit', async () => {
    const result = (await run('gubbins_search', { q: 'ESP32 Dev Board' })) as {
      query: string;
      matches: { id: string }[];
    };
    expect(result.query).toBe('ESP32 Dev Board');
    expect(result.matches).toEqual([
      {
        id: 'item-esp32',
        name: 'ESP32 Dev Board',
        quantity: 7,
        locationId: 'loc-shelf-2',
        locationName: 'Shelf 2',
        mpn: 'DEV-ESP32',
        manufacturer: 'Synthetic Silicon Co',
      },
    ]);
  });

  it('passes the power-user grammar through unchanged', async () => {
    const result = (await run('gubbins_search', { q: 'cap:voltage>3' })) as { matches: { id: string }[] };
    expect(result.matches.map((m) => m.id)).toEqual(['item-esp32']);
  });

  it('clamps the limit', async () => {
    const result = (await run('gubbins_search', { q: 'M3', limit: 1 })) as { matches: unknown[] };
    expect(result.matches).toHaveLength(1);
  });

  it('rejects a missing q', async () => {
    await expect(run('gubbins_search', {})).rejects.toBeInstanceOf(ToolInputError);
  });

  it('projects to a sparse fieldset with "fields"', async () => {
    const result = (await run('gubbins_search', { q: 'ESP32 Dev Board', fields: 'name,quantity' })) as {
      matches: Record<string, unknown>[];
    };
    expect(Object.keys(result.matches[0]!).sort()).toEqual(['name', 'quantity']);
  });

  it('adds an extended field with "include" (also accepts an array)', async () => {
    const result = (await run('gubbins_search', { q: 'ESP32', include: ['capabilities'] })) as {
      matches: { id: string; capabilities: { key: string }[] }[];
    };
    expect(result.matches[0]!.id).toBe('item-esp32');
    expect(result.matches[0]!.capabilities.some((c) => c.key === 'voltage')).toBe(true);
  });

  it('rejects an unknown field with a ToolInputError', async () => {
    await expect(run('gubbins_search', { q: 'ESP32', fields: 'bogus' })).rejects.toBeInstanceOf(
      ToolInputError,
    );
  });
});

describe('gubbins_where_is', () => {
  it('returns the per-location breakdown and a spoken sentence', async () => {
    const result = (await run('gubbins_where_is', { q: 'ESP32' })) as {
      matches: { placements: { locationName: string; quantity: number }[] }[];
      spoken: string;
    };
    expect(result.matches).toHaveLength(1);
    const byLocation = new Map(result.matches[0]!.placements.map((p) => [p.locationName, p.quantity]));
    expect(byLocation.get('Shelf 2')).toBe(5);
    expect(byLocation.get('Bin 4')).toBe(2);
    expect(result.spoken).toContain('ESP32 Dev Board');
  });
});

describe('gubbins_get_item', () => {
  it('returns full detail with placements, capabilities and tags for a known id', async () => {
    const result = (await run('gubbins_get_item', { id: 'item-esp32' })) as {
      found: boolean;
      item: { id: string; placements: unknown[]; capabilities: unknown[]; tags: string[] };
    };
    expect(result.found).toBe(true);
    expect(result.item.id).toBe('item-esp32');
    expect(result.item.placements.length).toBeGreaterThan(0);
    expect(result.item.capabilities.length).toBeGreaterThan(0);
    // An assistant asked "is this fragile?" can only answer from the tags (issue #143).
    expect(result.item.tags).toEqual(['fragile', 'workshop']);
  });

  it('reports found:false for an unknown id (not an error)', async () => {
    expect(await run('gubbins_get_item', { id: 'no-such-item' })).toEqual({
      found: false,
      id: 'no-such-item',
    });
  });

  it('rejects a missing id', async () => {
    await expect(run('gubbins_get_item', {})).rejects.toBeInstanceOf(ToolInputError);
  });

  it('projects a sparse fieldset and still reports found:false for an unknown id', async () => {
    const found = (await run('gubbins_get_item', { id: 'item-esp32', fields: 'name,unitCost' })) as {
      found: boolean;
      item: Record<string, unknown>;
    };
    expect(found.found).toBe(true);
    expect(Object.keys(found.item).sort()).toEqual(['name', 'unitCost']);

    expect(await run('gubbins_get_item', { id: 'no-such-item', fields: 'name' })).toEqual({
      found: false,
      id: 'no-such-item',
    });
  });
});

describe('gubbins_list_locations', () => {
  it('returns a paginated envelope of locations with item counts', async () => {
    const result = (await run('gubbins_list_locations', {})) as {
      data: { id: string; name: string; itemCount: number }[];
      pagination: { limit: number; offset: number; count: number; hasMore: boolean };
    };
    expect(result.data.length).toBeGreaterThan(0);
    expect(result.pagination.count).toBe(result.data.length);
    expect(typeof result.data[0]!.itemCount).toBe('number');
  });

  it('honours limit/offset and clamps the page size', async () => {
    const page1 = (await run('gubbins_list_locations', { limit: 1, offset: 0 })) as {
      data: { id: string }[];
      pagination: { limit: number; hasMore: boolean };
    };
    expect(page1.data).toHaveLength(1);
    expect(page1.pagination.limit).toBe(1);

    const page2 = (await run('gubbins_list_locations', { limit: 1, offset: 1 })) as {
      data: { id: string }[];
    };
    expect(page2.data[0]!.id).not.toBe(page1.data[0]!.id);

    // A wildly large limit is clamped to the API ceiling (100), not honoured verbatim.
    const big = (await run('gubbins_list_locations', { limit: 9999 })) as {
      pagination: { limit: number };
    };
    expect(big.pagination.limit).toBe(100);
  });
});

describe('gubbins_list_categories', () => {
  it('returns categories with a field count', async () => {
    const result = (await run('gubbins_list_categories', {})) as {
      data: { id: string; name: string; fieldCount: number }[];
    };
    expect(result.data.length).toBeGreaterThan(0);
    expect(typeof result.data[0]!.fieldCount).toBe('number');
  });
});

describe('gubbins_list_capabilities', () => {
  it('returns the queryable cap: vocabulary', async () => {
    const result = (await run('gubbins_list_capabilities', {})) as {
      data: { key: string; itemCount: number; hasNumericValues: boolean }[];
    };
    expect(result.data.length).toBeGreaterThan(0);
    // The fixture's ESP32 carries a numeric `voltage` capability.
    const voltage = result.data.find((c) => c.key === 'voltage');
    expect(voltage).toBeDefined();
    expect(voltage!.hasNumericValues).toBe(true);
  });
});

// --- the opt-in write tools -------------------------------------------------------

/**
 * The write tools are driven end-to-end through the *real* {@link createWriteExecutor}, with the
 * snapshot file replaced by an in-memory string — so these exercise the actual mutation path
 * (hydrate → the app's own repository → merged snapshot written back), not a stub of it.
 */
describe('the write tools', () => {
  /** Build the write tools over an in-memory snapshot, exposing the stored JSON for assertions. */
  function withInMemorySnapshot(initial: string): {
    tools: readonly McpTool[];
    stored: () => string;
  } {
    const file = createVirtualSnapshot(initial);
    // MCP has no credential and therefore no identity, so its writes are System's — the same
    // binding `mcp/serve.ts` makes at the composition root (issue #79).
    const execute = createWriteExecutor('/virtual/gubbins-sync.json', file.io);
    const tools = createWriteTools((op) => execute(op, SYSTEM_USER_ID));
    return { tools, stored: file.read };
  }

  /** Run one write tool by name against the in-memory snapshot. */
  function runWriteTool(
    tools: readonly McpTool[],
    name: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    const tool = tools.find((t) => t.name === name);
    if (tool === undefined) throw new Error(`No such write tool: ${name}`);
    return tool.run(hydrated.driver, args);
  }

  let fixture: string;

  beforeEach(async () => {
    fixture = await readFile(fileURLToPath(FIXTURE_URL), 'utf8');
  });

  it('builds exactly the five write tools, each with an object input schema', () => {
    const tools = createWriteTools(async () => {
      throw new Error('not called');
    });
    expect(tools.map((t) => t.name)).toEqual([
      'gubbins_adjust_quantity',
      'gubbins_adjust_gauge',
      'gubbins_check_out',
      'gubbins_check_in',
      'gubbins_transfer_stock',
    ]);
    for (const tool of tools) {
      expect(tool.description.length).toBeGreaterThan(0);
      expect(tool.inputSchema.type).toBe('object');
      // Every one of them acts on an item, so the item id is always required.
      expect(tool.inputSchema.required).toContain('id');
    }
  });

  it('keeps the write tools out of the read-only registry', () => {
    // They must only ever reach a caller via createWriteTools (i.e. under the opt-in), so a
    // global lookup must not find them even by name.
    for (const name of [
      'gubbins_adjust_quantity',
      'gubbins_adjust_gauge',
      'gubbins_check_out',
      'gubbins_check_in',
      'gubbins_transfer_stock',
    ]) {
      expect(findTool(name)).toBeUndefined();
    }
  });

  it('adjusts a DISCRETE quantity and writes the merged snapshot back', async () => {
    const { tools, stored } = withInMemorySnapshot(fixture);
    const result = (await runWriteTool(tools, 'gubbins_adjust_quantity', {
      id: 'item-m3-bolt',
      delta: -2,
      note: 'Taken to the workshop',
    })) as { updated: boolean; item: { id: string; quantity: number } };

    expect(result.updated).toBe(true);
    expect(result.item.quantity).toBe(40); // the fixture's 42, less two

    // The change landed in the snapshot the PWA will sync, with the history entry alongside it.
    const after = await hydrateFromJson(stored());
    const rows = await after.driver.query("SELECT quantity FROM items WHERE id = 'item-m3-bolt';");
    expect((rows[0] as { quantity: number }).quantity).toBe(40);
    await after.driver.close();
  });

  it('surfaces a domain rejection as a model-visible ToolInputError', async () => {
    const { tools } = withInMemorySnapshot(fixture);
    // The fixture is all-DISCRETE, so a gauge adjustment is a wrong-tracking-mode rejection
    // (a 422 WriteError) — the model should see the reason, not a generic failure.
    await expect(
      runWriteTool(tools, 'gubbins_adjust_gauge', { id: 'item-m3-bolt', delta: -10 }),
    ).rejects.toThrow(ToolInputError);
  });

  it('reports an unknown item as a model-visible ToolInputError', async () => {
    const { tools } = withInMemorySnapshot(fixture);
    await expect(
      runWriteTool(tools, 'gubbins_adjust_quantity', { id: 'item-does-not-exist', delta: 1 }),
    ).rejects.toThrow(ToolInputError);
  });

  it.each([
    ['a missing id', { delta: 1 }],
    ['an empty id', { id: '   ', delta: 1 }],
    ['a missing delta', { id: 'item-m3-bolt' }],
    ['a non-numeric delta', { id: 'item-m3-bolt', delta: 'two' }],
    ['a zero delta', { id: 'item-m3-bolt', delta: 0 }],
    ['a fractional delta', { id: 'item-m3-bolt', delta: 1.5 }],
    ['a non-string note', { id: 'item-m3-bolt', delta: 1, note: 42 }],
    ['an over-long note', { id: 'item-m3-bolt', delta: 1, note: 'x'.repeat(MAX_NOTE_LENGTH + 1) }],
  ])('rejects %s without touching the snapshot', async (_label, args) => {
    const { tools, stored } = withInMemorySnapshot(fixture);
    await expect(runWriteTool(tools, 'gubbins_adjust_quantity', args)).rejects.toThrow(ToolInputError);
    expect(stored()).toBe(fixture); // nothing was written
  });

  it('lends an item out and reports the loan back to the model (issue #142)', async () => {
    const { tools, stored } = withInMemorySnapshot(fixture);
    const result = (await runWriteTool(tools, 'gubbins_check_out', {
      id: 'item-m3-bolt',
      contactName: 'Sam Okafor',
      quantity: 2,
      dueDate: '2026-08-14',
    })) as { updated: boolean; item: { quantity: number }; checkout: { id: string; status: string } };

    expect(result.updated).toBe(true);
    expect(result.item.quantity).toBe(40);
    // The id is what a later gubbins_check_in names, so the model has to be able to read it.
    expect(result.checkout.id.length).toBeGreaterThan(0);
    expect(result.checkout.status).toBe('OPEN');

    const after = await hydrateFromJson(stored());
    const rows = await after.driver.query('SELECT quantity FROM checkouts WHERE returned_at IS NULL;');
    expect(rows).toEqual([{ quantity: 2 }]);
    await after.driver.close();
  });

  it('returns a lent item without being told which loan, when there is only one', async () => {
    const { tools } = withInMemorySnapshot(fixture);
    await runWriteTool(tools, 'gubbins_check_out', { id: 'item-m3-bolt', contactName: 'Sam Okafor' });
    const result = (await runWriteTool(tools, 'gubbins_check_in', { id: 'item-m3-bolt' })) as {
      item: { quantity: number };
      checkout: { status: string };
    };
    expect(result.item.quantity).toBe(42); // back on the shelf
    expect(result.checkout.status).toBe('RETURNED');
  });

  it('moves stock between locations, leaving the total alone', async () => {
    const { tools } = withInMemorySnapshot(fixture);
    // item-esp32 is split 5 at Shelf 2 and 2 at Bin 4 in the fixture.
    const result = (await runWriteTool(tools, 'gubbins_transfer_stock', {
      id: 'item-esp32',
      fromLocationId: 'loc-shelf-2',
      toLocationId: 'loc-bin-4',
      quantity: 3,
    })) as { item: { quantity: number; placements: { locationId: string; quantity: number }[] } };
    expect(result.item.quantity).toBe(7);
    const at = (id: string) => result.item.placements.find((p) => p.locationId === id)?.quantity ?? 0;
    expect(at('loc-shelf-2')).toBe(2);
    expect(at('loc-bin-4')).toBe(5);
  });

  it('reports a transfer bigger than the source holds as a model-visible error', async () => {
    const { tools, stored } = withInMemorySnapshot(fixture);
    await expect(
      runWriteTool(tools, 'gubbins_transfer_stock', {
        id: 'item-esp32',
        fromLocationId: 'loc-bin-4',
        toLocationId: 'loc-shelf-2',
        quantity: 10,
      }),
    ).rejects.toThrow(ToolInputError);
    expect(stored()).toBe(fixture); // nothing moved — no silent partial transfer
  });

  it.each([
    ['a non-string borrower name', 'gubbins_check_out', { id: 'item-m3-bolt', contactName: 7 }],
    [
      'a non-string due date',
      'gubbins_check_out',
      { id: 'item-m3-bolt', contactName: 'Sam', dueDate: 20260814 },
    ],
    ['no borrower at all', 'gubbins_check_out', { id: 'item-m3-bolt' }],
    ['an item that is not on loan', 'gubbins_check_in', { id: 'item-m3-bolt' }],
    [
      'a missing destination',
      'gubbins_transfer_stock',
      { id: 'item-esp32', fromLocationId: 'loc-bin-4', quantity: 1 },
    ],
  ])('rejects %s without touching the snapshot', async (_label, tool, args) => {
    const { tools, stored } = withInMemorySnapshot(fixture);
    await expect(runWriteTool(tools, tool, args)).rejects.toThrow(ToolInputError);
    expect(stored()).toBe(fixture);
  });

  it('accepts a fractional delta on the gauge tool (a gauge is not whole-numbered)', async () => {
    const { tools } = withInMemorySnapshot(fixture);
    // It still fails on tracking mode against this all-DISCRETE fixture — but as a domain
    // rejection, proving the fractional value cleared argument validation.
    const err = await runWriteTool(tools, 'gubbins_adjust_gauge', {
      id: 'item-m3-bolt',
      delta: -1.5,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ToolInputError);
    expect((err as Error).message).toMatch(/CONSUMABLE_GAUGE/);
  });
});
