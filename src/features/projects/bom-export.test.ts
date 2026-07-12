import { describe, it, expect } from 'vitest';
import type { ProjectBomLine } from '@/db/repositories';
import { buildBomExport, bomExportColumns, bomExportFilename } from './bom-export';

function makeLine(overrides: Partial<ProjectBomLine> = {}): ProjectBomLine {
  return {
    id: 'l1',
    projectId: 'p1',
    itemId: 'i1',
    designator: 'R1',
    mpn: 'RC0805',
    manufacturer: 'Yageo',
    description: '10k resistor',
    requiredQty: 4,
    reservedQty: 2,
    receivedQty: 1,
    reservationStatus: 'TENTATIVE',
    procurementStatus: 'ORDERED',
    unitCostSnapshot: 0.1,
    position: 0,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

describe('bomExportColumns', () => {
  it('maps a line onto readable, label-resolved column values', () => {
    const cols = bomExportColumns();
    const line = makeLine();
    const byHeader = Object.fromEntries(cols.map((c) => [c.header, c.value(line)]));
    expect(byHeader['Part']).toBe('10k resistor');
    expect(byHeader['Designator']).toBe('R1');
    expect(byHeader['Required']).toBe(4);
    expect(byHeader['Reservation']).toBe('Tentative');
    expect(byHeader['Procurement']).toBe('Ordered');
    expect(byHeader['Matched']).toBe('Yes');
    // Line cost = required × unit cost, with binary-float noise stripped (0.1 × 4).
    expect(byHeader['Line cost']).toBe(0.4);
  });

  it('falls back through the part-name chain and flags an unmatched line', () => {
    const cols = bomExportColumns();
    const line = makeLine({ itemId: null, description: null, mpn: null, designator: 'C3' });
    const byHeader = Object.fromEntries(cols.map((c) => [c.header, c.value(line)]));
    expect(byHeader['Part']).toBe('C3');
    expect(byHeader['Matched']).toBe('No');
  });

  it('leaves cost columns blank when there is no snapshot', () => {
    const cols = bomExportColumns();
    const line = makeLine({ unitCostSnapshot: null });
    const byHeader = Object.fromEntries(cols.map((c) => [c.header, c.value(line)]));
    expect(byHeader['Unit cost']).toBeNull();
    expect(byHeader['Line cost']).toBeNull();
  });
});

describe('buildBomExport', () => {
  const lines = [makeLine(), makeLine({ id: 'l2', description: 'Cap, 10µF', designator: 'C1' })];

  it('builds a CSV with a header and one row per line', () => {
    const { content, mimeType, extension } = buildBomExport('Bench PSU', lines, 'csv');
    expect(mimeType).toContain('text/csv');
    expect(extension).toBe('csv');
    const rowsOut = content.split('\r\n');
    expect(rowsOut[0]).toContain('Designator');
    expect(rowsOut).toHaveLength(3); // header + 2 lines
    // The comma-bearing part name is RFC-4180 quoted.
    expect(content).toContain('"Cap, 10µF"');
  });

  it('builds a TSV', () => {
    const { content, extension } = buildBomExport('Bench PSU', lines, 'tsv');
    expect(extension).toBe('tsv');
    expect(content.split('\r\n')[0]).toContain('\t');
  });

  it('builds a Markdown document with a project heading and table', () => {
    const { content, extension } = buildBomExport('Bench PSU', lines, 'markdown');
    expect(extension).toBe('md');
    expect(content).toContain('# Bench PSU — Bill of materials');
    expect(content).toContain('| Designator | Part |');
  });

  it('builds a standalone HTML document with the project title and a line count', () => {
    const { content, mimeType, extension } = buildBomExport('Bench PSU', lines, 'html');
    expect(mimeType).toContain('text/html');
    expect(extension).toBe('html');
    expect(content).toContain('<!doctype html>');
    expect(content).toContain('<title>Bench PSU — Bill of materials</title>');
    expect(content).toContain('2 lines');
  });

  it('singularises the HTML caption for a one-line BOM', () => {
    const { content } = buildBomExport('Bench PSU', [makeLine()], 'html');
    expect(content).toContain('1 line');
    expect(content).not.toContain('1 lines');
  });
});

describe('bomExportFilename', () => {
  it('slugs the project name and stamps the date', () => {
    const name = bomExportFilename('Robot Arm!', 'csv', new Date('2026-07-12T10:00:00Z'));
    expect(name).toBe('gubbins-bom-Robot_Arm-2026-07-12.csv');
  });

  it('falls back to a generic slug when the name empties out', () => {
    const name = bomExportFilename('!!!', 'md', new Date('2026-07-12T10:00:00Z'));
    expect(name).toBe('gubbins-bom-project-2026-07-12.md');
  });
});
