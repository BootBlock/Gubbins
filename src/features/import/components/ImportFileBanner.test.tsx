/**
 * ImportFileBanner — what the user is told about the file they picked (issue #347).
 *
 * The point of the seam is that a refusal is *visible* and specific: a spreadsheet says "save it
 * as CSV", an oversized file quotes both figures, and a Latin-1 file warns that its accented
 * characters were guessed at. A silent refusal would be no better than the junk rows it replaced.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { ImportFileBanner } from './ImportFileBanner';

afterEach(cleanup);

describe('ImportFileBanner', () => {
  it('renders nothing before a file has been chosen', () => {
    render(<ImportFileBanner read={null} data-testid="notice" />);
    expect(screen.queryByTestId('notice')).toBeNull();
  });

  it('renders nothing for a file that decoded cleanly', () => {
    render(
      <ImportFileBanner read={{ ok: true, text: 'Name,Qty', encoding: 'utf-8' }} data-testid="notice" />,
    );
    expect(screen.queryByTestId('notice')).toBeNull();
  });

  it('warns when a file had to be read as Windows-1252', () => {
    render(
      <ImportFileBanner read={{ ok: true, text: 'Café', encoding: 'windows-1252' }} data-testid="notice" />,
    );
    expect(screen.getByTestId('notice').textContent).toContain('Windows-1252');
    // A fallback encoding is a caution, not a failure — the text did load.
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('names both figures when a file is over the size cap', () => {
    render(
      <ImportFileBanner
        read={{ ok: false, rejection: { reason: 'tooLarge', bytes: 24_000_000, limitBytes: 16_000_000 } }}
        data-testid="notice"
      />,
    );
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('24 MB');
    expect(alert.textContent).toContain('16 MB');
  });

  it('tells the user how to get a spreadsheet workbook in', () => {
    render(
      <ImportFileBanner
        read={{ ok: false, rejection: { reason: 'binary', kind: 'package' } }}
        data-testid="notice"
      />,
    );
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('.xlsx');
    expect(alert.textContent).toContain('CSV');
  });

  it('reports an unrecognised binary file as an alert', () => {
    render(
      <ImportFileBanner
        read={{ ok: false, rejection: { reason: 'binary', kind: 'unknown' } }}
        data-testid="notice"
      />,
    );
    expect(screen.getByRole('alert').textContent).toContain('doesn’t look like text');
  });

  it('explains an empty file', () => {
    render(<ImportFileBanner read={{ ok: false, rejection: { reason: 'empty' } }} data-testid="notice" />);
    expect(screen.getByRole('alert').textContent).toContain('empty');
  });
});
