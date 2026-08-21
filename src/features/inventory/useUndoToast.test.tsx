import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { ToastProvider } from '@/components/foundry/toast';

/**
 * Behaviour tests for {@link useUndoToast} — the affordance that makes a bulk edit, a remove or a
 * move reversible (issue #131). The plan maths is covered in `undo.test.ts`; this pins the glue:
 * when an Undo is offered at all, what pressing it replays, and what it says afterwards.
 */

const mutate = vi.fn();
vi.mock('./mutations', () => ({ useUndoItemChanges: () => ({ mutate }) }));

import { useUndoToast } from './useUndoToast';
import { EMPTY_UNDO_PLAN, type UndoPlan } from './undo';

const PLAN: UndoPlan = { steps: [{ id: 'item-1', locationId: 'loc-bench' }] };

function Harness({ plan }: { plan: UndoPlan }) {
  const undoToast = useUndoToast();
  return (
    <button type="button" onClick={() => undoToast('Moved NE555 timer to Workshop.', plan)}>
      fire
    </button>
  );
}

/** The hook reads the provider above it, and the same provider renders the toast it queues. */
function renderHarness(plan: UndoPlan) {
  return render(
    <ToastProvider>
      <Harness plan={plan} />
    </ToastProvider>,
  );
}

beforeEach(() => mutate.mockReset());
afterEach(cleanup);

describe('useUndoToast', () => {
  it('confirms the write and offers an Undo when the plan can restore something', () => {
    renderHarness(PLAN);
    fireEvent.click(screen.getByText('fire'));

    expect(screen.getByTestId('toast')).toHaveTextContent('Moved NE555 timer to Workshop.');
    expect(screen.getByRole('button', { name: 'Undo' })).toBeInTheDocument();
  });

  it('replays exactly the plan it was handed when the Undo is pressed', () => {
    renderHarness(PLAN);
    fireEvent.click(screen.getByText('fire'));
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));

    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate.mock.calls[0][0]).toEqual(PLAN);
  });

  it('stays silent under a harness with no ToastProvider, rather than crashing the write', () => {
    // The confirmation reports the outcome of a write; it is not UI in its own right, so a
    // missing provider must not turn a successful remove into a crash (`useOptionalToast`).
    expect(() => {
      render(<Harness plan={PLAN} />);
      fireEvent.click(screen.getByText('fire'));
    }).not.toThrow();
    expect(screen.queryByTestId('toast')).not.toBeInTheDocument();
  });

  it('shows the confirmation with no Undo when there is nothing to restore', () => {
    renderHarness(EMPTY_UNDO_PLAN);
    fireEvent.click(screen.getByText('fire'));

    expect(screen.getByTestId('toast')).toHaveTextContent('Moved NE555 timer to Workshop.');
    expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument();
  });

  it('downgrades the confirmation to a warning when the caller asks for one', () => {
    function WarningHarness() {
      const undoToast = useUndoToast();
      return (
        <button type="button" onClick={() => undoToast('Updated 2 items; 1 failed.', PLAN, 'warning')}>
          fire
        </button>
      );
    }
    render(
      <ToastProvider>
        <WarningHarness />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByText('fire'));

    // The part that landed is still reversible, so the Undo stays — only the tone changes.
    expect(screen.getByRole('button', { name: 'Undo' })).toBeInTheDocument();
    expect(screen.getByTestId('toast').className).toContain('warning');
  });

  it('leaves the reversal to report its own outcome, so an unmounted caller still hears it', () => {
    // The confirmation moved onto the mutation's options (`undo-outcome.ts`): by the time an Undo
    // is pressed the dialog or card that offered it has usually gone, and React Query drops
    // per-call callbacks for an unmounted observer. Passing none is the point.
    renderHarness(PLAN);
    fireEvent.click(screen.getByText('fire'));
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));

    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate.mock.calls[0][1]).toBeUndefined();
  });
});
