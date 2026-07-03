/**
 * Generation + pipeline tests (EI-1) over a hydrated SYNTHETIC snapshot (no real data).
 *
 * Two snapshots are hydrated to model consecutive generations: a baseline (which must emit
 * nothing) and a follow-up carrying one extra ledger row that drops an item below its low-stock
 * floor (which must emit `stock.adjusted` + `item.low_stock`).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { hydrateFromJson, type HydrateResult } from '../hydrate.ts';
import { computeGenerationEvents } from './generation.ts';
import { createEventPipeline } from './pipeline.ts';
import type { BridgeEvent } from './model.ts';

interface HistoryRow {
  id: string;
  item_id: string;
  action: string;
  quantity_delta: number | null;
  net_value_delta: number | null;
  note: string | null;
  metadata: string | null;
  created_at: number;
}

/** Build a one-item synthetic snapshot at a given on-hand quantity + ledger. */
function snapshot(quantity: number, history: HistoryRow[]): string {
  return JSON.stringify({
    formatVersion: 1,
    generatedAt: 1_751_000_000_000,
    tables: {
      locations: [
        { id: 'loc-1', name: 'Shelf 2', parent_id: null, is_system: 0, updated_at: 1_751_000_000_000 },
      ],
      categories: [],
      items: [
        {
          id: 'item-1',
          name: 'Widget',
          description: null,
          location_id: 'loc-1',
          category_id: null,
          tracking_mode: 'DISCRETE',
          quantity,
          mpn: null,
          manufacturer: null,
          is_active: 1,
          created_at: 1_750_000_000_000,
          updated_at: 1_751_000_000_000,
        },
      ],
      item_stock: [
        {
          id: 'item-1|loc-1',
          item_id: 'item-1',
          location_id: 'loc-1',
          quantity,
          created_at: 1_750_000_000_000,
          updated_at: 1_751_000_000_000,
        },
      ],
      stock_batches: [
        {
          id: 'item-1|loc-1|',
          item_id: 'item-1',
          location_id: 'loc-1',
          batch_key: '',
          batch_number: null,
          lot_number: null,
          expiry_date: null,
          quantity,
          created_at: 1_750_000_000_000,
          updated_at: 1_751_000_000_000,
        },
      ],
      capabilities: [],
    },
    tombstones: [],
    gaugeHistory: [],
    itemTags: [],
    itemHistory: history,
  });
}

function created(at: number): HistoryRow {
  return {
    id: `h-created`,
    item_id: 'item-1',
    action: 'CREATED',
    quantity_delta: 1,
    net_value_delta: null,
    note: 'Created.',
    metadata: null,
    created_at: at,
  };
}
function quantityChange(id: string, delta: number, at: number): HistoryRow {
  return {
    id,
    item_id: 'item-1',
    action: 'QUANTITY_CHANGE',
    quantity_delta: delta,
    net_value_delta: null,
    note: `Adjusted ${delta}.`,
    metadata: null,
    created_at: at,
  };
}

const hydrated: HydrateResult[] = [];
async function hydrate(json: string): Promise<HydrateResult> {
  const result = await hydrateFromJson(json);
  hydrated.push(result);
  return result;
}

afterEach(async () => {
  while (hydrated.length > 0) await hydrated.pop()!.driver.close();
});

describe('computeGenerationEvents', () => {
  it('emits nothing on the baseline generation (no history replay)', async () => {
    const { driver } = await hydrate(snapshot(7, [created(100)]));
    const { events, cursor } = await computeGenerationEvents(driver, null);
    expect(events).toEqual([]);
    expect(cursor).toEqual({ seenIds: ['h-created'] });
  });

  it('emits stock.adjusted + item.low_stock for a new drop below the low-stock floor', async () => {
    const baseline = await hydrate(snapshot(7, [created(100)]));
    const first = await computeGenerationEvents(baseline.driver, null);

    const next = await hydrate(snapshot(3, [created(100), quantityChange('h-adjust', -4, 200)]));
    const { events } = await computeGenerationEvents(next.driver, first.cursor);

    expect(events.map((e) => e.type)).toEqual(['stock.adjusted', 'item.low_stock']);
    expect(events[0]!.data.item).toMatchObject({
      id: 'item-1',
      name: 'Widget',
      quantity: 3,
      locationName: 'Shelf 2',
    });
    expect(events[1]!.id).toBe('h-adjust:low_stock');
  });

  it('applies the fan-out cap over a burst of new ledger rows', async () => {
    const baseline = await hydrate(snapshot(50, [created(100)]));
    const first = await computeGenerationEvents(baseline.driver, null);

    const burst = Array.from({ length: 8 }, (_, i) => quantityChange(`h-${i}`, 1, 200 + i));
    const next = await hydrate(snapshot(50, [created(100), ...burst]));
    const { events } = await computeGenerationEvents(next.driver, first.cursor, { fanOutCap: 3 });

    expect(events).toHaveLength(4); // 3 kept + 1 truncation summary
    expect(events[events.length - 1]!.type).toBe('events.truncated');
  });
});

describe('createEventPipeline', () => {
  it('holds the cursor across generations and fans new events to every sink', async () => {
    const captured: BridgeEvent[] = [];
    const pipeline = createEventPipeline({ sinks: [{ deliver: (evts) => captured.push(...evts) }] });

    const baseline = await hydrate(snapshot(7, [created(100)]));
    await pipeline.onGeneration(baseline.driver);
    expect(captured).toEqual([]); // baseline emits nothing

    const next = await hydrate(snapshot(3, [created(100), quantityChange('h-adjust', -4, 200)]));
    await pipeline.onGeneration(next.driver);
    expect(captured.map((e) => e.type)).toEqual(['stock.adjusted', 'item.low_stock']);
  });

  it('swallows a sink error so one bad sink cannot break delivery or the watcher', async () => {
    const captured: BridgeEvent[] = [];
    const pipeline = createEventPipeline({
      onError: () => {},
      sinks: [
        {
          deliver() {
            throw new Error('sink boom');
          },
        },
        { deliver: (evts) => captured.push(...evts) },
      ],
    });
    await pipeline.onGeneration((await hydrate(snapshot(7, [created(100)]))).driver); // baseline
    const next = await hydrate(snapshot(2, [created(100), quantityChange('h-adjust', -5, 200)]));
    await expect(pipeline.onGeneration(next.driver)).resolves.toBeUndefined();
    expect(captured.length).toBeGreaterThan(0); // the good sink still received the events
  });
});
