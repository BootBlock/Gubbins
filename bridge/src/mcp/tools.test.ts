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
import { ALL_TOOLS, findTool, ToolInputError, type McpTool } from './tools.ts';

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
  it('returns full detail with placements and capabilities for a known id', async () => {
    const result = (await run('gubbins_get_item', { id: 'item-esp32' })) as {
      found: boolean;
      item: { id: string; placements: unknown[]; capabilities: unknown[] };
    };
    expect(result.found).toBe(true);
    expect(result.item.id).toBe('item-esp32');
    expect(result.item.placements.length).toBeGreaterThan(0);
    expect(result.item.capabilities.length).toBeGreaterThan(0);
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
