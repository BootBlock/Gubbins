import { describe, it, expect } from 'vitest';
import type { TagWithCount } from '@/db/repositories';
import { buildTagsExport, tagsExportColumns, tagsExportFilename } from './tags-export';

function tag(overrides: Partial<TagWithCount> = {}): TagWithCount {
  return { id: 't1', name: 'fasteners', updatedAt: 0, itemCount: 12, locationCount: 2, ...overrides };
}

const cells = (row: TagWithCount): Record<string, unknown> =>
  Object.fromEntries(tagsExportColumns().map((c) => [c.header, c.value(row)]));

describe('tagsExportColumns', () => {
  it('carries the dictionary row: the name and both usage counts', () => {
    expect(cells(tag())).toEqual({ Tag: 'fasteners', Items: 12, Locations: 2 });
  });

  it('keeps the counts raw numbers so the file sorts and totals', () => {
    const row = cells(tag({ itemCount: 0, locationCount: 0 }));
    expect(row.Items).toBe(0);
    expect(row.Locations).toBe(0);
  });

  it('omits the internal id, which means nothing outside the app', () => {
    expect(tagsExportColumns().map((c) => c.header)).toEqual(['Tag', 'Items', 'Locations']);
  });
});

describe('buildTagsExport', () => {
  it('serialises through the shared exporter, in the order given', async () => {
    const { content } = await buildTagsExport('csv', [tag(), tag({ id: 't2', name: 'adhesives' })]);
    const lines = String(content).split('\r\n');
    expect(lines[0]).toBe('Tag,Items,Locations');
    expect(lines[1]).toBe('fasteners,12,2');
    expect(lines[2]).toBe('adhesives,12,2');
  });

  it('quotes a tag name carrying the delimiter, so it round-trips intact', async () => {
    const { content } = await buildTagsExport('csv', [tag({ name: 'nuts, bolts' })]);
    expect(String(content)).toContain('"nuts, bolts"');
  });

  it('captions a single tag in the singular', async () => {
    const { content } = await buildTagsExport('txt', [tag()]);
    expect(String(content)).toContain('1 tag\n');
  });
});

describe('tagsExportFilename', () => {
  it('is date-stamped and carries the chosen extension', () => {
    expect(tagsExportFilename('md', new Date('2026-07-25T00:00:00Z'))).toBe('gubbins-tags-2026-07-25.md');
  });
});
