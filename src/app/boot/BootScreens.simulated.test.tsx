/**
 * The staged boot failure must never be able to destroy real data.
 *
 * The `schema-too-new` lab flag shows the "your database is from a newer build" screen without
 * opening the database at all — but that screen's whole design urges the reader towards a reset,
 * and its rescue panel wires a genuinely irreversible purge. Simulating a fault that can wipe a
 * healthy database on one confirmed click would be worse than not simulating it, so the purge is
 * withheld and the screen says the failure is staged. These tests hold that in place.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

vi.mock('@/components/BrandMark', () => ({ BrandMark: () => <span data-testid="brand-mark" /> }));
vi.mock('@/components/icons', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/icons')>();
  return Object.fromEntries(Object.keys(actual).map((k) => [k, () => <span />]));
});

import { BootErrorScreen } from './BootScreens';
import { DbError } from '@/db/errors';
import { useLabStore } from '@/state/stores/useLabStore';

const CLEAN = { dateOverride: null, occasionModes: {}, flags: {} } as const;
const PURGE = /hard reset|purge/i;

beforeEach(() => useLabStore.setState(CLEAN));
afterEach(() => {
  cleanup();
  useLabStore.setState(CLEAN);
});

describe('BootErrorScreen with a staged schema-too-new failure', () => {
  it('offers the real purge for a genuine failure', () => {
    render(<BootErrorScreen error={new DbError('SCHEMA_TOO_NEW', 'real failure')} />);
    expect(screen.getByRole('button', { name: PURGE })).toBeInTheDocument();
    expect(screen.queryByTestId('boot-error-simulated')).not.toBeInTheDocument();
  });

  it('withholds the purge entirely when the failure was staged by the lab flag', () => {
    useLabStore.setState({ flags: { 'schema-too-new': true } });
    render(<BootErrorScreen error={new DbError('SCHEMA_TOO_NEW', 'staged')} />);
    expect(screen.queryByRole('button', { name: PURGE })).not.toBeInTheDocument();
  });

  it('says plainly that the failure is simulated and the database untouched', () => {
    useLabStore.setState({ flags: { 'schema-too-new': true } });
    render(<BootErrorScreen error={new DbError('SCHEMA_TOO_NEW', 'staged')} />);
    const notice = screen.getByTestId('boot-error-simulated');
    expect(notice).toHaveTextContent(/simulated/i);
    expect(notice).toHaveTextContent(/unaffected/i);
  });

  it('drops the "why is Gubbins asking to reset your data?" explanation when staged', () => {
    // That copy exists to talk a user through a real reset; beside a staged fault it is a lie.
    useLabStore.setState({ flags: { 'schema-too-new': true } });
    render(<BootErrorScreen error={new DbError('SCHEMA_TOO_NEW', 'staged')} />);
    expect(screen.queryByText(/Why is Gubbins asking to reset your data\?/i)).not.toBeInTheDocument();
  });

  it('keeps the non-destructive rescues available while staged', () => {
    useLabStore.setState({ flags: { 'schema-too-new': true } });
    render(<BootErrorScreen error={new DbError('SCHEMA_TOO_NEW', 'staged')} />);
    // Both a download and a restore mention .sqlite — the point is simply that the
    // non-destructive rescues survive, so assert at least one remains.
    expect(screen.getAllByRole('button', { name: /sqlite/i }).length).toBeGreaterThan(0);
  });
});
