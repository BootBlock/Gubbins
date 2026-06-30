import { describe, it, expect } from 'vitest';
import {
  buildSupplierPartPlan,
  resolveSupplierPartWrite,
  supplierNameFromUrl,
  type ExistingSupplierPart,
} from './supplier-part-plan';
import type { ScrapeResultPayload } from './protocol';

const payload = (over: Partial<ScrapeResultPayload> = {}): ScrapeResultPayload => ({
  mpn: 'RES-1',
  manufacturer: 'Vishay',
  description: '10k resistor',
  distributor_url: 'https://www.digikey.com/p/123',
  scraped_pricing: { currency: 'USD', value: 0.42 },
  ...over,
});

const existing = (over: Partial<ExistingSupplierPart> = {}): ExistingSupplierPart => ({
  id: 'sp-1',
  supplierName: 'Digikey',
  orderCode: null,
  unitCost: null,
  currency: null,
  url: 'https://www.digikey.com/p/123',
  ...over,
});

describe('supplierNameFromUrl', () => {
  it('derives a title-cased supplier name from the host', () => {
    expect(supplierNameFromUrl('https://www.digikey.com/p/1')).toBe('Digikey');
    expect(supplierNameFromUrl('https://uk.rs-online.com/x')).toBe('Rs-online');
  });

  it('falls back gracefully for an unparseable url', () => {
    expect(supplierNameFromUrl('not a url')).toBe('Supplier');
  });
});

describe('buildSupplierPartPlan', () => {
  it('proposes a new row (matchedId null) when no supplier matches the host', () => {
    const plan = buildSupplierPartPlan(payload(), []);
    expect(plan.matchedId).toBeNull();
    expect(plan.supplierName).toBe('Digikey');
    expect(plan.proposals.map((p) => p.status)).toEqual(['FILL', 'FILL', 'FILL', 'FILL']);
  });

  it('matches an existing supplier part by distributor host', () => {
    const plan = buildSupplierPartPlan(payload(), [existing()]);
    expect(plan.matchedId).toBe('sp-1');
    // All fields empty on the match → every scraped field is a FILL.
    expect(plan.proposals.find((p) => p.field === 'unitCost')?.status).toBe('FILL');
  });

  it('flags a CONFLICT where a user-populated supplier field differs from the scrape', () => {
    const plan = buildSupplierPartPlan(payload(), [existing({ unitCost: 0.99, orderCode: 'OLD' })]);
    expect(plan.proposals.find((p) => p.field === 'unitCost')?.status).toBe('CONFLICT');
    expect(plan.proposals.find((p) => p.field === 'orderCode')?.status).toBe('CONFLICT');
  });

  it('reports UNCHANGED where values already match', () => {
    const plan = buildSupplierPartPlan(payload(), [existing({ unitCost: 0.42, currency: 'USD' })]);
    expect(plan.proposals.find((p) => p.field === 'unitCost')?.status).toBe('UNCHANGED');
    expect(plan.proposals.find((p) => p.field === 'currency')?.status).toBe('UNCHANGED');
  });

  it('SKIPs fields the scrape does not provide (no pricing)', () => {
    const plan = buildSupplierPartPlan(payload({ scraped_pricing: null }), []);
    expect(plan.proposals.find((p) => p.field === 'unitCost')?.status).toBe('SKIP');
    expect(plan.proposals.find((p) => p.field === 'currency')?.status).toBe('SKIP');
  });
});

describe('resolveSupplierPartWrite (§4 no-overwrite)', () => {
  it('creates a new supplier part from a no-match plan', () => {
    const plan = buildSupplierPartPlan(payload(), []);
    const write = resolveSupplierPartWrite(plan);
    expect(write.kind).toBe('create');
    if (write.kind === 'create') {
      expect(write.input.supplierName).toBe('Digikey');
      expect(write.input.unitCost).toBe(0.42);
      expect(write.input.orderCode).toBe('RES-1');
      expect(write.input.url).toBe('https://www.digikey.com/p/123');
    }
  });

  it('fills only blanks on a match by default (never overwrites a user value)', () => {
    const plan = buildSupplierPartPlan(payload(), [existing({ unitCost: 0.99 })]);
    const write = resolveSupplierPartWrite(plan);
    expect(write.kind).toBe('update');
    if (write.kind === 'update') {
      // unitCost is a CONFLICT and was NOT opted in → not written.
      expect(write.input.unitCost).toBeUndefined();
      // orderCode/currency were blank → filled.
      expect(write.input.orderCode).toBe('RES-1');
      expect(write.input.currency).toBe('USD');
    }
  });

  it('writes a CONFLICT field only when explicitly opted in', () => {
    const plan = buildSupplierPartPlan(payload(), [existing({ unitCost: 0.99 })]);
    const write = resolveSupplierPartWrite(plan, new Set(['unitCost']));
    expect(write.kind).toBe('update');
    if (write.kind === 'update') {
      expect(write.input.unitCost).toBe(0.42);
    }
  });

  it('is a noop when a matched plan would change nothing', () => {
    const plan = buildSupplierPartPlan(payload({ scraped_pricing: null, mpn: '' }), [
      existing({ url: 'https://www.digikey.com/p/123' }),
    ]);
    // Only url is a FILL? No — existing url equals scraped url → UNCHANGED; mpn blank → SKIP.
    const write = resolveSupplierPartWrite(plan);
    expect(write.kind).toBe('noop');
  });

  it('ignores an opt-in for a field that is not a conflict', () => {
    const plan = buildSupplierPartPlan(payload(), [existing()]); // all blank → FILLs
    const write = resolveSupplierPartWrite(plan, new Set(['unitCost']));
    expect(write.kind).toBe('update');
    if (write.kind === 'update') {
      expect(write.input.unitCost).toBe(0.42); // still applied (it was a FILL anyway)
    }
  });
});
