/**
 * §4 no-overwrite scrape merge — the CRITICAL data-integrity guarantee.
 *
 * The merge must never silently clobber a user-populated field; only empty fields
 * fill automatically, and a populated field changes solely on explicit opt-in.
 */
import { describe, expect, it } from 'vitest';
import { applyScrapeMerge, buildScrapeMergePlan, type ExistingItemFields } from './merge';
import type { ScrapeResultPayload } from './protocol';

const payload: ScrapeResultPayload = {
  mpn: 'NE555P',
  manufacturer: 'Texas Instruments',
  description: 'Precision 555 timer IC, DIP-8',
  distributor_url: 'https://www.digikey.com/product/NE555P',
  scraped_pricing: { currency: 'GBP', value: 0.42 },
};

const emptyItem: ExistingItemFields = {
  mpn: null,
  manufacturer: null,
  description: null,
  unitCost: null,
  aliases: [],
};

function statusOf(plan: ReturnType<typeof buildScrapeMergePlan>, field: string) {
  return plan.proposals.find((p) => p.field === field)?.status;
}

describe('buildScrapeMergePlan — classification', () => {
  it('marks every empty field FILL on a fresh item', () => {
    const plan = buildScrapeMergePlan(emptyItem, payload);
    expect(statusOf(plan, 'mpn')).toBe('FILL');
    expect(statusOf(plan, 'manufacturer')).toBe('FILL');
    expect(statusOf(plan, 'description')).toBe('FILL');
    expect(statusOf(plan, 'unitCost')).toBe('FILL');
  });

  it('marks a populated, differing field CONFLICT (user data at risk)', () => {
    const plan = buildScrapeMergePlan(
      { ...emptyItem, manufacturer: 'STMicroelectronics', unitCost: 0.99 },
      payload,
    );
    expect(statusOf(plan, 'manufacturer')).toBe('CONFLICT');
    expect(statusOf(plan, 'unitCost')).toBe('CONFLICT');
  });

  it('marks an equal field UNCHANGED (case-insensitive for strings)', () => {
    const plan = buildScrapeMergePlan({ ...emptyItem, mpn: 'ne555p', unitCost: 0.42 }, payload);
    expect(statusOf(plan, 'mpn')).toBe('UNCHANGED');
    expect(statusOf(plan, 'unitCost')).toBe('UNCHANGED');
  });

  it('marks a field SKIP when the scrape offers nothing', () => {
    const plan = buildScrapeMergePlan(emptyItem, {
      ...payload,
      manufacturer: '   ',
      scraped_pricing: null,
    });
    expect(statusOf(plan, 'manufacturer')).toBe('SKIP');
    expect(statusOf(plan, 'unitCost')).toBe('SKIP');
  });

  it('treats a whitespace-only existing field as empty (FILL)', () => {
    const plan = buildScrapeMergePlan({ ...emptyItem, description: '   ' }, payload);
    expect(statusOf(plan, 'description')).toBe('FILL');
  });
});

describe('buildScrapeMergePlan — Universal Alias Mapping (§4)', () => {
  it('proposes the supplier MPN as a new alias', () => {
    const plan = buildScrapeMergePlan(emptyItem, payload);
    expect(plan.aliasAdditions).toEqual(['NE555P']);
  });

  it('does not duplicate an alias already mapped (case-insensitive)', () => {
    const plan = buildScrapeMergePlan({ ...emptyItem, aliases: ['ne555p'] }, payload);
    expect(plan.aliasAdditions).toEqual([]);
  });

  it('exposes the scraped currency for display', () => {
    expect(buildScrapeMergePlan(emptyItem, payload).currency).toBe('GBP');
  });
});

describe('applyScrapeMerge — the no-overwrite safeguard', () => {
  it('writes all FILL fields on a fresh item', () => {
    const plan = buildScrapeMergePlan(emptyItem, payload);
    const write = applyScrapeMerge(plan);
    expect(write.fields).toEqual({
      mpn: 'NE555P',
      manufacturer: 'Texas Instruments',
      description: 'Precision 555 timer IC, DIP-8',
      unitCost: 0.42,
    });
    expect(write.aliasAdditions).toEqual(['NE555P']);
  });

  it('NEVER overwrites a populated field without explicit opt-in', () => {
    const existing = { ...emptyItem, manufacturer: 'STMicroelectronics', unitCost: 0.99 };
    const plan = buildScrapeMergePlan(existing, payload);
    const write = applyScrapeMerge(plan); // no opt-ins
    expect(write.fields.manufacturer).toBeUndefined();
    expect(write.fields.unitCost).toBeUndefined();
    // …but still fills the genuinely-empty fields.
    expect(write.fields.mpn).toBe('NE555P');
    expect(write.fields.description).toBe('Precision 555 timer IC, DIP-8');
  });

  it('overwrites only the specific fields the user opted into', () => {
    const existing = { ...emptyItem, manufacturer: 'STMicroelectronics', unitCost: 0.99 };
    const plan = buildScrapeMergePlan(existing, payload);
    const write = applyScrapeMerge(plan, new Set(['manufacturer']));
    expect(write.fields.manufacturer).toBe('Texas Instruments');
    expect(write.fields.unitCost).toBeUndefined(); // not opted in → preserved
  });

  it('ignores an opt-in for a field that is not actually a conflict', () => {
    // mpn is empty → FILL; opting into "overwriting" it cannot introduce surprises.
    const plan = buildScrapeMergePlan(emptyItem, payload);
    const write = applyScrapeMerge(plan, new Set(['mpn', 'manufacturer', 'description', 'unitCost']));
    expect(write.fields).toEqual({
      mpn: 'NE555P',
      manufacturer: 'Texas Instruments',
      description: 'Precision 555 timer IC, DIP-8',
      unitCost: 0.42,
    });
  });

  it('writes nothing for an all-unchanged scrape', () => {
    const existing = {
      mpn: 'NE555P',
      manufacturer: 'Texas Instruments',
      description: 'Precision 555 timer IC, DIP-8',
      unitCost: 0.42,
      aliases: ['NE555P'],
    };
    const plan = buildScrapeMergePlan(existing, payload);
    const write = applyScrapeMerge(plan, new Set(['mpn', 'manufacturer', 'description', 'unitCost']));
    expect(write.fields).toEqual({});
    expect(write.aliasAdditions).toEqual([]);
  });
});
