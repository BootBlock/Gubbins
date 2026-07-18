import { describe, expect, it } from 'vitest';
import { modeForTemplate } from './template-mode';

/**
 * These pin the seeding half of the mode bug: the editor now *holds* its mode, and this function is
 * only consulted when the dialog opens. The bug it replaced re-derived the mode on every render, so
 * choosing "Custom" — which starts as an empty template — snapped straight back to the envelope and
 * the custom editor could never be reached.
 */
describe('modeForTemplate', () => {
  it('seeds the envelope for no template', () => {
    expect(modeForTemplate(null)).toBe('envelope');
    expect(modeForTemplate(undefined)).toBe('envelope');
  });

  it('seeds the envelope for a blank template', () => {
    // The important case: blank and absent are indistinguishable once stored, so both open on the
    // envelope. The *held* mode is what keeps a freshly-chosen empty custom template on screen.
    expect(modeForTemplate('')).toBe('envelope');
    expect(modeForTemplate('   ')).toBe('envelope');
  });

  it('seeds the named preset', () => {
    expect(modeForTemplate('preset:discord')).toBe('discord');
    expect(modeForTemplate('preset:homeAssistant')).toBe('homeAssistant');
    expect(modeForTemplate('  preset:slack  ')).toBe('slack');
  });

  it('falls back to the envelope for a preset this build does not know', () => {
    // Matches what the deliverer does with it, so the editor never presents a newer peer's preset
    // as a custom template the user could overwrite by accident.
    expect(modeForTemplate('preset:not-a-real-preset')).toBe('envelope');
  });

  it('seeds custom for free text', () => {
    expect(modeForTemplate('{{item.name}}')).toBe('custom');
    expect(modeForTemplate('hello')).toBe('custom');
  });
});
