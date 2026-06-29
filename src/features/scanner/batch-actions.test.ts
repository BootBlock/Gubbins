import { describe, expect, it } from 'vitest';
import { runBatch, summariseBatch } from './batch-actions';

describe('runBatch', () => {
  it('returns an empty partition for no ids', async () => {
    const outcome = await runBatch([], async () => undefined);
    expect(outcome).toEqual({ succeeded: [], failed: [] });
  });

  it('marks every id succeeded when the action resolves', async () => {
    const seen: string[] = [];
    const outcome = await runBatch(['a', 'b', 'c'], async (id) => {
      seen.push(id);
    });
    expect(seen).toEqual(['a', 'b', 'c']); // applied in input order
    expect(outcome).toEqual({ succeeded: ['a', 'b', 'c'], failed: [] });
  });

  it('partitions failures without aborting the rest, preserving order', async () => {
    const outcome = await runBatch(['a', 'b', 'c', 'd'], async (id) => {
      if (id === 'b' || id === 'd') throw new Error('nope');
    });
    expect(outcome).toEqual({ succeeded: ['a', 'c'], failed: ['b', 'd'] });
  });

  it('treats a synchronous throw inside the action as a failure', async () => {
    const outcome = await runBatch(['x'], () => {
      throw new Error('sync boom');
    });
    expect(outcome).toEqual({ succeeded: [], failed: ['x'] });
  });
});

describe('summariseBatch', () => {
  it('summarises a fully successful move', () => {
    const outcome = { succeeded: ['a', 'b', 'c'], failed: [] };
    expect(summariseBatch('MOVE', outcome, 'Drawer A2')).toBe('Moved 3 items to Drawer A2');
  });

  it('uses the singular noun for one item', () => {
    const outcome = { succeeded: ['a'], failed: [] };
    expect(summariseBatch('MOVE', outcome, 'Drawer A2')).toBe('Moved 1 item to Drawer A2');
  });

  it('summarises a fully successful checkout to a contact', () => {
    const outcome = { succeeded: ['a', 'b'], failed: [] };
    expect(summariseBatch('CHECKOUT', outcome, 'Alice')).toBe('Checked out 2 items to Alice');
  });

  it('appends a failure count when some items failed', () => {
    const outcome = { succeeded: ['a', 'b'], failed: ['c'] };
    expect(summariseBatch('MOVE', outcome, 'Bin 4')).toBe('Moved 2 items to Bin 4 · 1 failed');
  });

  it('reports nothing-done when every item failed', () => {
    expect(summariseBatch('MOVE', { succeeded: [], failed: ['a'] }, 'Bin 4')).toBe(
      'No items moved · 1 failed',
    );
    expect(summariseBatch('CHECKOUT', { succeeded: [], failed: ['a', 'b'] }, 'Alice')).toBe(
      'No items checked out · 2 failed',
    );
  });
});
