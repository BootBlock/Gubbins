import { describe, expect, it } from 'vitest';
import { buildProductLookupUrl, OPEN_FOOD_FACTS_HOST, parseOpenFoodFactsProduct } from './product-lookup';

describe('buildProductLookupUrl', () => {
  it('builds an https Open Food Facts v2 URL for the barcode', () => {
    const url = buildProductLookupUrl('4006381333931');
    expect(url).toContain(`https://${OPEN_FOOD_FACTS_HOST}/api/v2/product/4006381333931.json`);
    expect(url).toContain('fields=');
  });

  it('percent-encodes the barcode', () => {
    expect(buildProductLookupUrl('a/b')).toContain('/product/a%2Fb.json');
  });
});

describe('parseOpenFoodFactsProduct', () => {
  const gtin = '4006381333931';

  it('maps a found product to a typed payload', () => {
    const body = JSON.stringify({
      status: 1,
      product: {
        product_name: 'Sticky Notes',
        brands: 'Acme, Acme Office',
        generic_name: 'Repositionable notes',
        quantity: '100 sheets',
      },
    });
    const parsed = parseOpenFoodFactsProduct(body, gtin);
    expect(parsed).toEqual({
      ok: true,
      payload: {
        gtin,
        name: 'Sticky Notes',
        brand: 'Acme', // first brand only
        description: 'Repositionable notes',
        quantity: '100 sheets',
      },
    });
  });

  it('falls back to net quantity when there is no distinct generic name', () => {
    const body = JSON.stringify({
      status: 1,
      product: { product_name: 'Widget', quantity: '500 g' },
    });
    const parsed = parseOpenFoodFactsProduct(body, gtin);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.payload.description).toBe('Net quantity: 500 g');
      expect(parsed.payload.brand).toBeNull();
    }
  });

  it('treats status 0 (unknown barcode) as not found', () => {
    const parsed = parseOpenFoodFactsProduct(JSON.stringify({ status: 0, product: {} }), gtin);
    expect(parsed).toMatchObject({ ok: false });
  });

  it('treats a product with no usable name as not found', () => {
    const parsed = parseOpenFoodFactsProduct(
      JSON.stringify({ status: 1, product: { brands: 'Acme' } }),
      gtin,
    );
    expect(parsed).toMatchObject({ ok: false });
  });

  it('never throws on malformed JSON', () => {
    const parsed = parseOpenFoodFactsProduct('<html>not json</html>', gtin);
    expect(parsed).toMatchObject({ ok: false });
  });
});
