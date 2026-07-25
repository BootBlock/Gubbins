import { describe, it, expect } from 'vitest';
import type { SupplierWithCounts } from '@/db/repositories';
import { NO_SUPPLIER_CHOICE, resolveSupplier } from './supplier-choice';

function supplier(id: string, name: string): SupplierWithCounts {
  return {
    id,
    name,
    url: null,
    currency: null,
    note: null,
    createdAt: 0,
    updatedAt: 0,
    partCount: 0,
    orderCount: 0,
  };
}

const MATCHES = [supplier('a', 'RS Components'), supplier('b', 'Farnell')];

describe('resolveSupplier (issue #386)', () => {
  it('selects the supplier a differently-spelled name folds onto', () => {
    for (const typed of ['RS Components', 'rs components', 'RS-Components', 'R.S. Components']) {
      expect(resolveSupplier(MATCHES, typed)?.id).toBe('a');
    }
  });

  it('selects nothing for a partial name', () => {
    // Merging is destructive, so a prefix must not be read as "you meant this one".
    expect(resolveSupplier(MATCHES, 'RS Comp')).toBeNull();
    expect(resolveSupplier(MATCHES, 'Farn')).toBeNull();
  });

  it('selects nothing for a name that is not in the results', () => {
    expect(resolveSupplier(MATCHES, 'Mouser')).toBeNull();
    expect(resolveSupplier([], 'RS Components')).toBeNull();
  });

  it('treats blank and punctuation-only text as no choice at all', () => {
    expect(resolveSupplier(MATCHES, '')).toBeNull();
    expect(resolveSupplier(MATCHES, '   ')).toBeNull();
    expect(resolveSupplier(MATCHES, '---')).toBeNull();
  });

  it('starts empty', () => {
    expect(NO_SUPPLIER_CHOICE).toEqual({ text: '', supplier: null });
  });
});
