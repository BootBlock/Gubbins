import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { ToastProvider } from '@/components/foundry/toast';
import { useReportUndoOutcome, type UndoOutcome } from './undo-outcome';

/**
 * The message an undo leaves behind once the reversal lands (issue #131). It lives apart from
 * {@link useUndoToast} so it can be reported from the mutation's own options — see the module's
 * header for why a per-call callback would go unheard.
 */

function Harness({ outcome }: { outcome: UndoOutcome }) {
  const report = useReportUndoOutcome();
  return (
    <button type="button" onClick={() => report(outcome)}>
      fire
    </button>
  );
}

function renderAndFire(outcome: UndoOutcome, withProvider = true) {
  const tree = <Harness outcome={outcome} />;
  render(withProvider ? <ToastProvider>{tree}</ToastProvider> : tree);
  fireEvent.click(screen.getByText('fire'));
}

afterEach(cleanup);

describe('useReportUndoOutcome', () => {
  it('counts the items it put back, pluralised', () => {
    renderAndFire({ succeeded: 3, failed: 0 });
    expect(screen.getByText('3 items put back.')).toBeInTheDocument();
  });

  it('uses the singular for one item', () => {
    renderAndFire({ succeeded: 1, failed: 0 });
    expect(screen.getByText('1 item put back.')).toBeInTheDocument();
  });

  it('says how much did not go back when the reversal only partly landed', () => {
    renderAndFire({ succeeded: 2, failed: 1 });
    expect(screen.getByText('Put 2 back; 1 could not be undone.')).toBeInTheDocument();
    // A partial reversal is a warning, not a success — some of the change is still in place.
    expect(screen.getByTestId('toast').className).toContain('warning');
  });

  it('stays silent with no ToastProvider above it, rather than crashing a landed write', () => {
    expect(() => renderAndFire({ succeeded: 1, failed: 0 }, false)).not.toThrow();
    expect(screen.queryByTestId('toast')).not.toBeInTheDocument();
  });
});
