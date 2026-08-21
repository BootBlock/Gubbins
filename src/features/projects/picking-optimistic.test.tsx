/**
 * The picking tick is optimistic (issue #670).
 *
 * Walking the worksheet is a rapid, sequential interaction — gather a part, tick it, move on —
 * so `useSetPicked` patches both cached slices in `onMutate` rather than waiting on the OPFS
 * write queue, inverts that patch when the write is rejected, and reconciles only once the burst
 * is over. These pin all three, plus the rollback's report, against the real hook.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { ToastProvider } from '@/components/foundry';
import type { AllPages } from '@/lib/read-all-pages';
import type { PickLine, ProjectBomLine } from '@/db/repositories';
import { DbError } from '@/db/errors';

const repo = { setPicked: vi.fn() };
vi.mock('@/db/repositories', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/db/repositories')>()),
  getProjectRepository: () => repo,
}));

import { projectKeys, useSetPicked } from './projects';

const PROJECT = 'p1';

function makeLine(id: string, picked = false): ProjectBomLine {
  return {
    id,
    projectId: PROJECT,
    itemId: null,
    designator: null,
    mpn: null,
    manufacturer: null,
    description: `Line ${id}`,
    requiredQty: 1,
    reservedQty: 0,
    receivedQty: 0,
    picked,
    reservationStatus: 'NONE',
    procurementStatus: 'NONE',
    unitCostSnapshot: null,
    position: 0,
    createdAt: 0,
    updatedAt: 0,
  };
}

/** A client seeded with the two slices the hook patches: the worksheet and the BOM lines. */
function seededClient(): QueryClient {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const lines = [makeLine('l1'), makeLine('l2')];
  client.setQueryData<readonly PickLine[]>(
    projectKeys.pickList(PROJECT),
    lines.map((line) => ({ line, placements: [] })),
  );
  client.setQueryData<AllPages<ProjectBomLine>>(projectKeys.lines(PROJECT), {
    rows: lines,
    truncated: false,
  });
  return client;
}

function pickedIn(client: QueryClient, lineId: string): { worksheet?: boolean; bom?: boolean } {
  const rows = client.getQueryData<readonly PickLine[]>(projectKeys.pickList(PROJECT));
  const bom = client.getQueryData<AllPages<ProjectBomLine>>(projectKeys.lines(PROJECT));
  return {
    worksheet: rows?.find((r) => r.line.id === lineId)?.line.picked,
    bom: bom?.rows.find((l) => l.id === lineId)?.picked,
  };
}

function renderSetPicked(client: QueryClient) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>
      <ToastProvider>{children}</ToastProvider>
    </QueryClientProvider>
  );
  return renderHook(() => useSetPicked(PROJECT), { wrapper });
}

beforeEach(() => {
  repo.setPicked.mockReset();
});

describe('useSetPicked (issue #670 optimistic picking tick)', () => {
  it('flips the line in both cached slices before the write resolves', async () => {
    const client = seededClient();
    // A write that never settles: the assertion is what the user sees *during* the round trip.
    repo.setPicked.mockReturnValue(new Promise<void>(() => {}));
    const { result } = renderSetPicked(client);

    act(() => result.current.mutate({ lineId: 'l1', picked: true }));

    await waitFor(() => expect(pickedIn(client, 'l1')).toEqual({ worksheet: true, bom: true }));
    // Only the ticked line moves.
    expect(pickedIn(client, 'l2')).toEqual({ worksheet: false, bom: false });
  });

  it('leaves a second tick’s patch in place when the first is rejected', async () => {
    const client = seededClient();
    // The first tick is held open so the optimistic patch is *observed* before the write is
    // rejected — asserting the revert against the seeded value alone would pass without one.
    let rejectFirst: ((error: unknown) => void) | undefined;
    repo.setPicked.mockImplementation((lineId: string) =>
      lineId === 'l1'
        ? new Promise<void>((_resolve, reject) => (rejectFirst = reject))
        : new Promise<void>(() => {}),
    );
    const { result } = renderSetPicked(client);

    act(() => {
      result.current.mutate({ lineId: 'l1', picked: true });
      result.current.mutate({ lineId: 'l2', picked: true });
    });
    await waitFor(() => expect(pickedIn(client, 'l1')).toEqual({ worksheet: true, bom: true }));

    // A rejection carrying no human-authored message is what reaches the fallback copy.
    await act(async () => {
      rejectFirst?.({ reason: 'rejected' });
    });

    // The rejected tick reverts itself and says so; the one beside it keeps its patch.
    await waitFor(() => expect(pickedIn(client, 'l1')).toEqual({ worksheet: false, bom: false }));
    expect(pickedIn(client, 'l2')).toEqual({ worksheet: true, bom: true });
    expect(await screen.findByText('Couldn’t update the pick')).toBeInTheDocument();
    expect(screen.getByText('The tick has been undone.')).toBeInTheDocument();
  });

  it('keeps the tick when the write times out, because the outcome is unknown', async () => {
    // A timeout does not establish that the write failed (issue #554), so reverting would show a
    // tick the very next read contradicts. The patch stays and the reconciliation settles it.
    const client = seededClient();
    let rejectWrite: ((error: unknown) => void) | undefined;
    repo.setPicked.mockImplementation(() => new Promise<void>((_resolve, reject) => (rejectWrite = reject)));
    const { result } = renderSetPicked(client);

    act(() => result.current.mutate({ lineId: 'l1', picked: true }));
    await waitFor(() => expect(pickedIn(client, 'l1')).toEqual({ worksheet: true, bom: true }));

    await act(async () => {
      rejectWrite?.(new DbError('WORKER_TIMEOUT', 'The database did not respond in time.'));
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(pickedIn(client, 'l1')).toEqual({ worksheet: true, bom: true });
  });

  it('reconciles once, after the last tick of a burst has settled', async () => {
    const client = seededClient();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    let releaseFirst: (() => void) | undefined;
    repo.setPicked.mockImplementationOnce(
      () => new Promise<void>((resolve) => (releaseFirst = () => resolve())),
    );
    repo.setPicked.mockImplementationOnce(() => Promise.resolve());
    const { result } = renderSetPicked(client);

    act(() => {
      result.current.mutate({ lineId: 'l1', picked: true });
      result.current.mutate({ lineId: 'l2', picked: true });
    });

    // The second tick settles while the first is still in flight, so it must not refetch —
    // its refetch would land before the first write and snap that box back.
    await waitFor(() => expect(repo.setPicked).toHaveBeenCalledTimes(2));
    expect(invalidate).not.toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: projectKeys.pickList(PROJECT) }),
    );

    await act(async () => {
      releaseFirst?.();
    });
    await waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith(
        expect.objectContaining({ queryKey: projectKeys.pickList(PROJECT) }),
      ),
    );
  });

  it('still reconciles when both ticks of a burst settle together', async () => {
    // Two writes resolving in the same microtask each see the other as pending, so a count read
    // back from the query client would have both of them skip and the burst reconcile never.
    const client = seededClient();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    repo.setPicked.mockResolvedValue(undefined);
    const { result } = renderSetPicked(client);

    await act(async () => {
      result.current.mutate({ lineId: 'l1', picked: true });
      result.current.mutate({ lineId: 'l2', picked: true });
    });

    await waitFor(() => expect(repo.setPicked).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith(
        expect.objectContaining({ queryKey: projectKeys.pickList(PROJECT) }),
      ),
    );
  });
});
