import { describe, expect, it } from 'vitest';
import { generateWebhookSecret, WEBHOOK_SECRET_BYTES } from './secret';

describe('generateWebhookSecret', () => {
  it('returns lower-case hex covering the full entropy', () => {
    const secret = generateWebhookSecret();
    expect(secret).toHaveLength(WEBHOOK_SECRET_BYTES * 2);
    expect(secret).toMatch(/^[0-9a-f]+$/);
  });

  it('zero-pads each byte so a low byte does not shorten the secret', () => {
    // Without the pad, 0x00 would render as "0" and the secret would be a nibble short — a subtle
    // entropy loss that only shows up on some values.
    const secret = generateWebhookSecret(() => new Uint8Array([0x00, 0x0f, 0xff]));
    expect(secret).toBe('000fff');
  });

  it('does not repeat itself across calls', () => {
    const secrets = new Set(Array.from({ length: 10 }, () => generateWebhookSecret()));
    expect(secrets.size).toBe(10);
  });

  it('asks for exactly the documented number of bytes', () => {
    let requested = -1;
    generateWebhookSecret((length) => {
      requested = length;
      return new Uint8Array(length);
    });
    expect(requested).toBe(WEBHOOK_SECRET_BYTES);
  });
});
