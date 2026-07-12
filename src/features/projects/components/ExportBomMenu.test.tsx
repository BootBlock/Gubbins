import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ToastProvider } from '@/components/foundry';
import type { ProjectBomLine } from '@/db/repositories';
import { ExportBomMenu } from './ExportBomMenu';

// The download side-effect is mocked so the test asserts the wiring (a Blob + filename)
// without touching the DOM download machinery.
const download = vi.hoisted(() => vi.fn());
vi.mock('@/features/export/download', () => ({ download }));

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
    reservedQty: 0,
    receivedQty: 0,
    reservationStatus: 'NONE',
    procurementStatus: 'NONE',
    unitCostSnapshot: 0.1,
    position: 0,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

function renderMenu(lines: readonly ProjectBomLine[]) {
  const user = userEvent.setup();
  render(
    <ToastProvider>
      <ExportBomMenu projectName="Bench PSU" lines={lines} />
    </ToastProvider>,
  );
  return { user };
}

beforeEach(() => download.mockClear());

describe('ExportBomMenu', () => {
  it('exports the BOM as CSV when the CSV row is chosen', async () => {
    const { user } = renderMenu([makeLine()]);
    await user.click(screen.getByTestId('export-bom'));
    await user.click(screen.getByTestId('export-bom-csv'));

    expect(download).toHaveBeenCalledTimes(1);
    const [blob, filename] = download.mock.calls[0]!;
    expect(blob).toBeInstanceOf(Blob);
    expect((blob as Blob).type).toContain('text/csv');
    expect(filename).toMatch(/^gubbins-bom-Bench_PSU-\d{4}-\d{2}-\d{2}\.csv$/);
  });

  it('offers every format and downloads a Markdown file with the right extension', async () => {
    const { user } = renderMenu([makeLine()]);
    await user.click(screen.getByTestId('export-bom'));
    expect(screen.getByTestId('export-bom-tsv')).toBeInTheDocument();
    expect(screen.getByTestId('export-bom-html')).toBeInTheDocument();
    await user.click(screen.getByTestId('export-bom-markdown'));

    const [, filename] = download.mock.calls[0]!;
    expect(filename).toMatch(/\.md$/);
  });

  it('disables the trigger when the BOM is empty', () => {
    renderMenu([]);
    expect(screen.getByTestId('export-bom')).toBeDisabled();
  });
});
