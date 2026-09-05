/**
 * Tests for the payload template engine (webhooks plan `W3`, §5.3).
 *
 * The security property gets the most attention: a template must never be able to surface
 * something the event did not already contain, so the containment tests below are the ones that
 * matter most if this file is ever edited.
 */
import { describe, expect, it } from 'vitest';
import type { WebhookEventView } from './event-view';
import {
  genericWebhookPayload,
  isWebhookPreset,
  renderWebhookTemplate,
  resolveWebhookPayload,
  unknownTemplatePaths,
  WEBHOOK_PAYLOAD_ENVELOPE,
  WEBHOOK_PRESETS,
  WEBHOOK_TEMPLATE_PATH_NAMES,
  webhookQueryParams,
} from './template';

function view(overrides: Partial<WebhookEventView> = {}): WebhookEventView {
  return {
    id: 'hist-1',
    type: 'stock.adjusted',
    occurredAt: '2026-07-18T10:00:00.000Z',
    item: {
      id: 'item-1',
      name: 'M3 screws',
      quantity: 4,
      locationId: 'loc-drawer',
      locationName: 'Drawer 2',
      locationPath: ['loc-workshop', 'loc-drawer'],
      categoryId: 'cat-fasteners',
      categoryName: 'Fasteners',
      tagIds: ['tag-metric'],
    },
    change: {
      action: 'QUANTITY_CHANGE',
      kind: 'stock',
      label: 'Quantity changed',
      detail: 'Used two on the bracket',
      delta: '−2',
      quantityDelta: -2,
      netValueDelta: null,
      actorUserId: 'user-ada',
      actorDisplayName: 'Ada Okafor',
    },
    ...overrides,
  };
}

/** An event with no item and no change — `lookup.resolved` / `events.truncated`. */
function itemlessView(): WebhookEventView {
  return {
    id: 'lookup:abc:1',
    type: 'lookup.resolved',
    occurredAt: '2026-07-18T10:00:00.000Z',
    item: null,
    change: null,
  };
}

describe('renderWebhookTemplate', () => {
  it('substitutes allow-listed paths', () => {
    expect(renderWebhookTemplate('{{item.name}} → {{item.quantity}}', view())).toBe('M3 screws → 4');
    expect(renderWebhookTemplate('{{event.type}} at {{event.occurredAt}}', view())).toBe(
      'stock.adjusted at 2026-07-18T10:00:00.000Z',
    );
  });

  it('tolerates whitespace inside the braces', () => {
    expect(renderWebhookTemplate('{{  item.name  }}', view())).toBe('M3 screws');
  });

  it('renders a null value as empty rather than the string "null"', () => {
    expect(renderWebhookTemplate('[{{change.netValueDelta}}]', view())).toBe('[]');
    expect(renderWebhookTemplate('[{{item.name}}]', itemlessView())).toBe('[]');
  });

  it('renders numbers, including a genuine zero', () => {
    const zero = view({ item: { ...view().item!, quantity: 0 } });
    expect(renderWebhookTemplate('{{item.quantity}}', zero)).toBe('0');
    expect(renderWebhookTemplate('{{change.quantityDelta}}', view())).toBe('-2');
  });

  it('substitutes every occurrence, not just the first', () => {
    expect(renderWebhookTemplate('{{item.id}}/{{item.id}}', view())).toBe('item-1/item-1');
  });

  it('leaves surrounding text, including JSON the user wrote, untouched', () => {
    expect(renderWebhookTemplate('{"name": "{{item.name}}", "n": {{item.quantity}}}', view())).toBe(
      '{"name": "M3 screws", "n": 4}',
    );
  });

  it('is not order-dependent across repeated renders', () => {
    // A shared global regex would carry `lastIndex` between calls and drop matches.
    const template = '{{item.name}} {{item.id}}';
    expect(renderWebhookTemplate(template, view())).toBe(renderWebhookTemplate(template, view()));
  });

  describe('containment — a template cannot surface what the event does not carry', () => {
    it.each([
      ['an unknown path', '{{item.secret}}'],
      ['a prototype key', '{{constructor}}'],
      ['a prototype path', '{{item.constructor}}'],
      ['__proto__', '{{__proto__}}'],
      ['toString', '{{toString}}'],
      ['a subscription field', '{{subscription.secret}}'],
      ['a bare object', '{{item}}'],
    ])('renders %s as empty', (_label, template) => {
      expect(renderWebhookTemplate(template, view())).toBe('');
    });

    it('does not treat anything with a non-path character as a placeholder at all', () => {
      // Brackets, quotes and braces cannot appear in a path, so indexing is not even expressible.
      for (const template of ['{{item["name"]}}', "{{item['name']}}", '{{ item.name | upper }}']) {
        expect(renderWebhookTemplate(template, view())).toBe(template);
      }
    });

    it('exposes only the documented paths, and every one of them resolves', () => {
      // Every optional field populated, so a path rendering empty here means the accessor is
      // broken rather than the fixture being thin.
      const populated = view({ change: { ...view().change!, netValueDelta: -1.5 } });
      expect(WEBHOOK_TEMPLATE_PATH_NAMES.length).toBeGreaterThan(0);
      for (const path of WEBHOOK_TEMPLATE_PATH_NAMES) {
        expect(unknownTemplatePaths(`{{${path}}}`)).toEqual([]);
        expect(renderWebhookTemplate(`{{${path}}}`, populated)).not.toBe('');
      }
    });

    it('resolves every path to empty on an itemless event rather than throwing', () => {
      for (const path of WEBHOOK_TEMPLATE_PATH_NAMES) {
        expect(() => renderWebhookTemplate(`{{${path}}}`, itemlessView())).not.toThrow();
      }
    });
  });
});

describe('unknownTemplatePaths', () => {
  it('names the unknown paths, de-duplicated in encounter order', () => {
    expect(unknownTemplatePaths('{{item.nmae}} {{event.type}} {{item.nmae}} {{bogus}}')).toEqual([
      'item.nmae',
      'bogus',
    ]);
  });

  it('returns nothing for a clean template', () => {
    expect(unknownTemplatePaths('{{item.name}} is at {{item.locationName}}')).toEqual([]);
    expect(unknownTemplatePaths('no placeholders here')).toEqual([]);
  });

  it('treats inherited object keys as unknown', () => {
    expect(unknownTemplatePaths('{{constructor}}')).toEqual(['constructor']);
  });
});

describe('resolveWebhookPayload', () => {
  it('falls back to the untouched envelope when there is no template', () => {
    for (const template of [null, undefined, '', '   ']) {
      expect(resolveWebhookPayload(template, view())).toEqual(WEBHOOK_PAYLOAD_ENVELOPE);
    }
  });

  it('renders a custom template as text', () => {
    expect(resolveWebhookPayload('{{item.name}} changed', view())).toEqual({
      kind: 'text',
      body: 'M3 screws changed',
    });
  });

  it.each(WEBHOOK_PRESETS)('builds the %s preset as JSON', (preset) => {
    const payload = resolveWebhookPayload(`preset:${preset}`, view());
    expect(payload.kind).toBe('json');
  });

  it('shapes the chat presets around the label the app already uses', () => {
    expect(resolveWebhookPayload('preset:discord', view())).toEqual({
      kind: 'json',
      body: { content: 'Quantity changed: M3 screws (−2)' },
    });
    expect(resolveWebhookPayload('preset:slack', view())).toEqual({
      kind: 'json',
      body: { text: 'Quantity changed: M3 screws (−2)' },
    });
  });

  it('does not leave a dangling separator when the item name or delta is blank', () => {
    const blank = view({
      item: { ...view().item!, name: '' },
      change: { ...view().change!, delta: '' },
    });
    expect(resolveWebhookPayload('preset:discord', blank)).toEqual({
      kind: 'json',
      body: { content: 'Quantity changed' },
    });
  });

  it('falls back to the dotted type for an event with no label', () => {
    expect(resolveWebhookPayload('preset:discord', itemlessView())).toEqual({
      kind: 'json',
      body: { content: 'lookup.resolved' },
    });
  });

  it('uses snake_case for the Home Assistant preset', () => {
    expect(resolveWebhookPayload('preset:homeAssistant', view())).toEqual({
      kind: 'json',
      body: {
        event_type: 'stock.adjusted',
        occurred_at: '2026-07-18T10:00:00.000Z',
        item_id: 'item-1',
        item_name: 'M3 screws',
        quantity: 4,
        location_id: 'loc-drawer',
        location_name: 'Drawer 2',
        action: 'QUANTITY_CHANGE',
        quantity_delta: -2,
      },
    });
  });

  it('falls back to the envelope for a preset this build does not know', () => {
    // Almost certainly a newer peer; the standard envelope beats an empty body to a live endpoint.
    expect(resolveWebhookPayload('preset:teams', view())).toEqual(WEBHOOK_PAYLOAD_ENVELOPE);
    expect(resolveWebhookPayload('preset:', view())).toEqual(WEBHOOK_PAYLOAD_ENVELOPE);
  });

  it('does not mistake a template that merely mentions a preset for one', () => {
    expect(resolveWebhookPayload('the preset:discord format', view())).toMatchObject({ kind: 'text' });
  });

  it('recognises exactly the documented preset names', () => {
    expect(isWebhookPreset('discord')).toBe(true);
    expect(isWebhookPreset('Discord')).toBe(false);
    expect(isWebhookPreset('teams')).toBe(false);
    expect(isWebhookPreset(null)).toBe(false);
  });
});

describe('genericWebhookPayload', () => {
  it('carries every allow-listed path under its own name', () => {
    expect(Object.keys(genericWebhookPayload(view())).sort()).toEqual([...WEBHOOK_TEMPLATE_PATH_NAMES]);
    expect(genericWebhookPayload(view())['item.name']).toBe('M3 screws');
  });

  it('keeps nulls, which JSON can express', () => {
    expect(genericWebhookPayload(itemlessView())['item.name']).toBeNull();
  });

  it('is JSON-serialisable', () => {
    expect(() => JSON.stringify(genericWebhookPayload(view()))).not.toThrow();
  });
});

describe('webhookQueryParams', () => {
  it('flattens the default envelope to the generic projection', () => {
    const params = webhookQueryParams(WEBHOOK_PAYLOAD_ENVELOPE, view());
    expect(Object.fromEntries(params)).toMatchObject({
      'event.type': 'stock.adjusted',
      'item.name': 'M3 screws',
      'item.quantity': '4',
    });
  });

  it('omits nulls rather than sending the string "null"', () => {
    const params = webhookQueryParams(WEBHOOK_PAYLOAD_ENVELOPE, itemlessView());
    const keys = params.map(([key]) => key);
    expect(keys).toContain('event.type');
    expect(keys).not.toContain('item.name');
    expect(params.every(([, value]) => value !== 'null')).toBe(true);
  });

  it('keeps a genuine zero and a false, which are values rather than absences', () => {
    // Only `null` is an absence; a falsy skip here would silently drop real data.
    const zero = view({ item: { ...view().item!, quantity: 0 } });
    expect(Object.fromEntries(webhookQueryParams(WEBHOOK_PAYLOAD_ENVELOPE, zero))['item.quantity']).toBe('0');
    expect(webhookQueryParams({ kind: 'json', body: { flag: false, count: 0 } }, view())).toEqual([
      ['flag', 'false'],
      ['count', '0'],
    ]);
  });

  it('flattens a preset payload to its own keys', () => {
    const payload = resolveWebhookPayload('preset:homeAssistant', view());
    expect(Object.fromEntries(webhookQueryParams(payload, view()))).toMatchObject({
      event_type: 'stock.adjusted',
      item_name: 'M3 screws',
      quantity_delta: '-2',
    });
  });

  it('sends a text template as a single payload parameter', () => {
    const payload = resolveWebhookPayload('{{item.name}} changed', view());
    expect(webhookQueryParams(payload, view())).toEqual([['payload', 'M3 screws changed']]);
  });

  it('JSON-encodes a nested value rather than dropping it', () => {
    const params = webhookQueryParams({ kind: 'json', body: { list: ['a', 'b'] } }, view());
    expect(params).toEqual([['list', '["a","b"]']]);
  });

  it('produces pairs that survive URL encoding', () => {
    const params = webhookQueryParams(resolveWebhookPayload('preset:discord', view()), view());
    const search = new URLSearchParams(params.map(([k, v]) => [k, v]));
    expect(search.get('content')).toBe('Quantity changed: M3 screws (−2)');
  });
});
