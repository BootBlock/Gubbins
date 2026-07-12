import { describe, it, expect } from 'vitest';
import {
  formatBytes,
  formatFieldValue,
  formatDiagnosticsText,
  buildIssueUrl,
  gatherEnvironment,
  ENGLISH_DIAGNOSTIC_VOCAB,
  DIAGNOSTIC_FIELD_ORDER,
  type Diagnostics,
} from './diagnostics';

const SAMPLE: Diagnostics = {
  version: '2026.07.11',
  buildDate: '2026-07-11',
  userAgent: 'Mozilla/5.0 (Test) ExampleBrowser/1.0',
  platform: 'TestPlatform',
  language: 'en-GB',
  timeZone: 'Europe/London',
  utcOffset: 'UTC+01:00',
  viewportWidth: 1280,
  viewportHeight: 720,
  screenWidth: 1920,
  screenHeight: 1080,
  devicePixelRatio: 2,
  colorScheme: 'dark',
  reducedMotion: true,
  online: false,
  displayMode: 'standalone',
  storageUsage: 45_200_000,
  storageQuota: 2_000_000_000,
  backgroundEffect: 'rain',
  databaseBytes: 3_500_000,
  counts: { items: 42, locations: 7, projects: 3, contacts: 5, categories: 9, tags: 12 },
};

describe('formatBytes', () => {
  it('scales through the base-1000 units', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(45_200_000)).toBe('45.2 MB');
    expect(formatBytes(2_000_000_000)).toBe('2.0 GB');
  });

  it('guards against non-finite / negative input', () => {
    expect(formatBytes(-1)).toBe('—');
    expect(formatBytes(Number.NaN)).toBe('—');
  });
});

describe('formatFieldValue', () => {
  const v = ENGLISH_DIAGNOSTIC_VOCAB;

  it('formats composite values', () => {
    expect(formatFieldValue('viewport', SAMPLE, v, false)).toBe('1280 × 720');
    expect(formatFieldValue('screen', SAMPLE, v, false)).toBe('1920 × 1080 @2×');
    expect(formatFieldValue('storage', SAMPLE, v, false)).toBe('45.2 MB / 2.0 GB');
  });

  it('maps enumerated values through the vocabulary', () => {
    expect(formatFieldValue('colorScheme', SAMPLE, v, false)).toBe('Dark');
    expect(formatFieldValue('reducedMotion', SAMPLE, v, false)).toBe('On');
    expect(formatFieldValue('online', SAMPLE, v, false)).toBe('Offline');
    expect(formatFieldValue('displayMode', SAMPLE, v, false)).toBe('Installed (PWA)');
  });

  it('resolves the background-effect preference to its setting label', () => {
    expect(formatFieldValue('background', SAMPLE, v, false)).toBe('Rain');
  });

  it('renders entity counts and the database size', () => {
    expect(formatFieldValue('items', SAMPLE, v, false)).toBe('42');
    expect(formatFieldValue('projects', SAMPLE, v, false)).toBe('3');
    expect(formatFieldValue('tags', SAMPLE, v, false)).toBe('12');
    expect(formatFieldValue('database', SAMPLE, v, false)).toBe('3.5 MB');
  });

  it('reports unavailable counts / database size rather than throwing', () => {
    const bare = { ...SAMPLE, counts: undefined, databaseBytes: undefined };
    expect(formatFieldValue('items', bare, v, false)).toBe('Unavailable');
    expect(formatFieldValue('database', bare, v, false)).toBe('Unavailable');
  });

  it('shows the named time zone unredacted, and only the UTC offset when redacted', () => {
    expect(formatFieldValue('timezone', SAMPLE, v, false)).toBe('Europe/London (UTC+01:00)');
    expect(formatFieldValue('timezone', SAMPLE, v, true)).toBe('UTC+01:00');
  });

  it('reports unavailable storage rather than throwing', () => {
    const noStorage = { ...SAMPLE, storageUsage: undefined, storageQuota: undefined };
    expect(formatFieldValue('storage', noStorage, v, false)).toBe('Unavailable');
  });
});

describe('formatDiagnosticsText', () => {
  it('emits one Markdown line per field in order', () => {
    const text = formatDiagnosticsText(SAMPLE, { redact: false });
    const lines = text.split('\n');
    expect(lines).toHaveLength(DIAGNOSTIC_FIELD_ORDER.length);
    expect(lines[0]).toBe('- **App version:** 2026.07.11');
    expect(text).toContain('- **Time zone:** Europe/London (UTC+01:00)');
  });

  it('redacts the region-identifying time zone when asked', () => {
    const text = formatDiagnosticsText(SAMPLE, { redact: true });
    expect(text).not.toContain('Europe/London');
    expect(text).toContain('- **Time zone:** UTC+01:00');
  });
});

describe('buildIssueUrl', () => {
  it('targets the bug-report form and pre-fills environment + redacted diagnostics', () => {
    const url = new URL(buildIssueUrl(SAMPLE));
    expect(url.origin + url.pathname).toBe('https://github.com/BootBlock/Gubbins/issues/new');
    expect(url.searchParams.get('template')).toBe('bug_report.yml');
    expect(url.searchParams.get('environment')).toContain('ExampleBrowser/1.0');
    expect(url.searchParams.get('environment')).toContain('app 2026.07.11');
    const extra = url.searchParams.get('extra') ?? '';
    expect(extra).toContain('App version');
    // The public issue must not carry the region-identifying zone name.
    expect(extra).not.toContain('Europe/London');
    expect(extra).toContain('UTC+01:00');
  });
});

describe('gatherEnvironment', () => {
  it('captures the running environment without throwing', async () => {
    const d = await gatherEnvironment();
    expect(typeof d.version).toBe('string');
    expect(typeof d.userAgent).toBe('string');
    expect(d.utcOffset).toMatch(/^UTC[+-]\d{2}:\d{2}$/);
    expect(d.colorScheme === 'light' || d.colorScheme === 'dark').toBe(true);
    expect(d.displayMode === 'browser' || d.displayMode === 'standalone').toBe(true);
  });
});
