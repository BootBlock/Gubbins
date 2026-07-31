/**
 * The acknowledgement that stands in for a save the platform will not report (issue #502).
 *
 * What matters is that every way out answers: yes, no, dismissal and unmount. A caller blocked
 * on this promise is holding a destructive operation half-begun, so one that never settles is
 * as bad as one that answers wrongly.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import { useConfirmSaved } from './useConfirmSaved';

/** A harness that asks the question on mount and records the answer when it arrives. */
function Harness({
  answers,
  filename = 'gubbins-restore-point.sqlite',
}: {
  answers: boolean[];
  filename?: string;
}) {
  const { confirmSaved, confirmSavedDialog } = useConfirmSaved();
  return (
    <div>
      <button onClick={() => void confirmSaved(filename).then((answer) => answers.push(answer))}>Ask</button>
      {confirmSavedDialog}
    </div>
  );
}

/** Click "Ask" and let the dialog mount. */
async function ask(answers: boolean[]) {
  render(<Harness answers={answers} />);
  await act(async () => {
    fireEvent.click(screen.getByText('Ask'));
  });
}

afterEach(cleanup);

describe('useConfirmSaved', () => {
  it('names the file the user has to go and look for', async () => {
    await ask([]);
    expect(screen.getByText('gubbins-restore-point.sqlite')).toBeTruthy();
  });

  it('answers yes when the user confirms they have the file', async () => {
    const answers: boolean[] = [];
    await ask(answers);

    await act(async () => {
      fireEvent.click(screen.getByTestId('confirm-saved-continue'));
    });

    expect(answers).toEqual([true]);
    expect(screen.queryByTestId('confirm-saved-continue')).toBeNull();
  });

  it('answers no when the user cancels', async () => {
    const answers: boolean[] = [];
    await ask(answers);

    await act(async () => {
      fireEvent.click(screen.getByTestId('confirm-saved-cancel'));
    });

    expect(answers).toEqual([false]);
  });

  it('answers no when the dialog is dismissed with Escape', async () => {
    // Dismissal is not "carry on" — the destructive half must read a closed dialog as a refusal.
    const answers: boolean[] = [];
    await ask(answers);

    await act(async () => {
      fireEvent.keyDown(document, { key: 'Escape' });
    });

    expect(answers).toEqual([false]);
  });

  it('answers no if the screen goes away while the question is open', async () => {
    // Otherwise the caller waits forever, holding a spinner over an operation it never finishes.
    const answers: boolean[] = [];
    await ask(answers);

    await act(async () => {
      cleanup();
    });

    expect(answers).toEqual([false]);
  });
});
