import { describe, expect, it } from 'vitest';
import { previewWebhookPayload, WEBHOOK_PREVIEW_ENVELOPE } from './preview';
import { WEBHOOK_PREVIEW_EVENT } from './preview-event';

describe('previewWebhookPayload', () => {
  it('reports the envelope as a marker rather than fabricating a body', () => {
    // The default payload is assembled by the bridge from its own event; rendering a
    // plausible-looking body here would be a fabricated contract, not a preview.
    const preview = previewWebhookPayload(null, 'POST');
    expect(preview.kind).toBe(WEBHOOK_PREVIEW_ENVELOPE);
    expect(preview.unknownPaths).toEqual([]);
  });

  it('treats a blank template as the envelope', () => {
    expect(previewWebhookPayload('   ', 'POST').kind).toBe(WEBHOOK_PREVIEW_ENVELOPE);
  });

  it('renders a custom template through the real interpolator', () => {
    const preview = previewWebhookPayload('{{item.name}} is now {{item.quantity}}', 'POST');
    expect(preview.kind).toBe('body');
    expect(preview.kind !== WEBHOOK_PREVIEW_ENVELOPE && preview.text).toBe(
      `${WEBHOOK_PREVIEW_EVENT.item!.name} is now 12`,
    );
  });

  it('renders a preset as formatted JSON', () => {
    const preview = previewWebhookPayload('preset:generic', 'POST');
    expect(preview.kind).toBe('body');
    if (preview.kind === WEBHOOK_PREVIEW_ENVELOPE) throw new Error('expected a body');
    expect(() => JSON.parse(preview.text) as unknown).not.toThrow();
    expect(preview.text).toContain('\n'); // pretty-printed, not a single line
  });

  it('falls back to the envelope for a preset this build does not know', () => {
    expect(previewWebhookPayload('preset:not-a-real-preset', 'POST').kind).toBe(WEBHOOK_PREVIEW_ENVELOPE);
  });

  it('surfaces placeholders outside the allow-list, which would render empty', () => {
    const preview = previewWebhookPayload('{{item.name}} {{secret.value}}', 'POST');
    expect(preview.unknownPaths).toContain('secret.value');
  });

  it('reports no unknown paths for a preset, which has no placeholders', () => {
    expect(previewWebhookPayload('preset:discord', 'POST').unknownPaths).toEqual([]);
  });

  describe('GET', () => {
    it('flattens to query parameters instead of a body', () => {
      const preview = previewWebhookPayload(null, 'GET');
      expect(preview.kind).toBe('query');
      if (preview.kind === WEBHOOK_PREVIEW_ENVELOPE) throw new Error('expected a query');
      expect(preview.text).toContain('=');
      expect(preview.text.split('\n').length).toBeGreaterThan(1);
    });

    it('sends a free-text template as a single payload parameter', () => {
      const preview = previewWebhookPayload('hello {{item.name}}', 'GET');
      if (preview.kind === WEBHOOK_PREVIEW_ENVELOPE) throw new Error('expected a query');
      expect(preview.text.startsWith('payload=')).toBe(true);
    });

    it('percent-encodes values so the preview matches what is actually sent', () => {
      const preview = previewWebhookPayload('a b&c', 'GET');
      if (preview.kind === WEBHOOK_PREVIEW_ENVELOPE) throw new Error('expected a query');
      expect(preview.text).toBe('payload=a%20b%26c');
    });
  });
});
