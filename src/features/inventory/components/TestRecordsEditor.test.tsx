/**
 * Component tests for the TestRecordsEditor (feature-gap G7). Mocked at the query/mutation boundary
 * so no DB or QueryClient is needed — the point is the affordance: the list renders records (name,
 * toned result badge, reading + unit), the empty state shows, recording calls the mutation with the
 * drafted content, a blank name blocks submit with a field error, and a row's remove calls the
 * remove mutation with the record + item ids.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import type { Item, TestRecord } from '@/db/repositories';

let rows: TestRecord[];
let recordSpy: ReturnType<typeof vi.fn>;
let removeSpy: ReturnType<typeof vi.fn>;

vi.mock('../queries', () => ({
  useItemTestRecords: () => ({ data: rows }),
}));

vi.mock('../mutations', () => ({
  useRecordTestResult: () => ({ mutate: recordSpy, isPending: false, isSuccess: false }),
  useRemoveTestRecord: () => ({ mutate: removeSpy, isPending: false, isSuccess: false }),
}));

vi.mock('@/lib/useFormatters', () => ({
  useFormatters: () => ({ date: () => '1 Jan 2026', calendarDate: () => '1 Jan 2026' }),
}));

// Imported after the mocks are registered.
import { TestRecordsEditor } from './TestRecordsEditor';

const item = { id: 'i1', trackingMode: 'SERIALISED' } as Item;

const rec = (over: Partial<TestRecord>): TestRecord => ({
  id: 'r1',
  itemId: 'i1',
  kind: 'TEST',
  name: 'Insulation resistance',
  result: 'PASS',
  reading: null,
  unit: null,
  note: null,
  performedAt: 0,
  createdAt: 0,
  updatedAt: 0,
  ...over,
});

describe('TestRecordsEditor (feature-gap G7)', () => {
  beforeEach(() => {
    rows = [];
    recordSpy = vi.fn();
    removeSpy = vi.fn();
  });

  afterEach(cleanup);

  it('shows the empty state when there are no records', () => {
    render(<TestRecordsEditor item={item} />);
    expect(screen.getByTestId('test-records-empty')).toBeInTheDocument();
  });

  it('renders a record with its name, result badge and reading', () => {
    rows = [
      rec({ name: 'Annual calibration', result: 'FAIL', reading: 0.4, unit: '%', kind: 'CALIBRATION' }),
    ];
    render(<TestRecordsEditor item={item} />);

    expect(screen.getByText('Annual calibration')).toBeInTheDocument();
    expect(screen.getByTestId('test-record-result-badge')).toHaveTextContent('Fail');
    expect(screen.getByTestId('test-record-row')).toHaveTextContent('0.4 %');
    // The summary reflects the single failing record.
    expect(screen.getByTestId('test-records-summary')).toHaveTextContent('1 failed');
  });

  it('records a result with the drafted content', () => {
    render(<TestRecordsEditor item={item} />);
    fireEvent.change(screen.getByTestId('test-record-name'), { target: { value: 'Earth bond' } });
    fireEvent.change(screen.getByTestId('test-record-reading'), { target: { value: '0.1' } });
    fireEvent.click(screen.getByTestId('record-test-result'));

    expect(recordSpy).toHaveBeenCalledTimes(1);
    expect(recordSpy.mock.calls[0][0]).toMatchObject({
      id: 'i1',
      input: { name: 'Earth bond', reading: 0.1, kind: 'TEST', result: 'PASS' },
    });
  });

  it('blocks submit and shows a field error when the name is blank', () => {
    render(<TestRecordsEditor item={item} />);
    fireEvent.click(screen.getByTestId('record-test-result'));

    expect(recordSpy).not.toHaveBeenCalled();
    expect(screen.getByText('A test name is required.')).toBeInTheDocument();
  });

  it('removes a record from its row with the record + item ids', () => {
    rows = [rec({ id: 'r-del', name: 'Mistake' })];
    render(<TestRecordsEditor item={item} />);
    fireEvent.click(screen.getByTestId('remove-test-record'));
    expect(removeSpy).toHaveBeenCalledWith({ recordId: 'r-del', itemId: 'i1' });
  });
});
