/**
 * "Did that file actually save?" — the acknowledgement that stands in for a completion signal
 * the platform will not give (issue #502).
 *
 * Three paths destroy data immediately after saving a copy of it: the storage triage history
 * prune, a Replace restore, and the restore point behind every rescue restore. Where the File
 * System Access API is available the save reports itself and none of this appears. Where it is
 * not — Firefox, Safari, iOS standalone PWAs, in-app browsers — an `<a download>` is the only
 * route and it cannot report, so the user is the only thing that knows whether the file arrived.
 * Asking them is what turns "we clicked a link" into "the copy exists".
 *
 * Copy here stays a literal rather than going through `t()`, deliberately and for the same
 * reason `RescueActions` does: one of its callers is the crash screen, which renders after the
 * app below it has already failed, so this must not depend on the i18n catalog being in a state
 * to answer.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Modal } from '@/components/foundry';

/** A question waiting on the user, holding the promise the caller is blocked on. */
interface PendingConfirm {
  readonly filename: string;
  readonly settle: (confirmed: boolean) => void;
}

export interface ConfirmSaved {
  /**
   * Ask whether `filename` reached the user, resolving `true` only if they say so. Suitable as
   * a {@link import('@/lib/save-file').SafeSave.confirmUnverified}.
   */
  readonly confirmSaved: (filename: string) => Promise<boolean>;
  /** Render this somewhere in the caller's tree; it is nothing until a question is asked. */
  readonly confirmSavedDialog: React.ReactNode;
}

/**
 * Wire the acknowledgement into a screen: `confirmSaved` is the promise-returning question,
 * `confirmSavedDialog` the element that asks it.
 *
 * Dismissing the dialog — Escape, the close button, the backdrop — answers **no**, as does the
 * component unmounting, so a caller waiting on the answer is never left hanging with the
 * destructive half half-begun.
 */
export function useConfirmSaved(): ConfirmSaved {
  const [pending, setPending] = useState<PendingConfirm | null>(null);
  // Mirrored so unmount can answer for a question still on screen; state itself is stale by then.
  const pendingRef = useRef<PendingConfirm | null>(null);
  useEffect(() => {
    pendingRef.current = pending;
  }, [pending]);
  useEffect(
    () => () => {
      pendingRef.current?.settle(false);
    },
    [],
  );

  const confirmSaved = useCallback(
    (filename: string) =>
      new Promise<boolean>((resolve) => {
        setPending({ filename, settle: resolve });
      }),
    [],
  );

  const settle = (confirmed: boolean) => {
    pending?.settle(confirmed);
    setPending(null);
  };

  const confirmSavedDialog = (
    <Modal
      open={pending !== null}
      onClose={() => settle(false)}
      title="Check the copy saved"
      description="This browser cannot tell Gubbins whether the file was written, so please confirm before anything is changed."
    >
      <div className="flex flex-col gap-4">
        <p className="text-sm text-muted-foreground">
          Gubbins asked your browser to save{' '}
          <span className="font-medium text-foreground">{pending?.filename}</span>, but this browser gives no
          way to check that it arrived. Find the file — usually in your Downloads folder — before you
          continue, because what happens next cannot be undone.
        </p>
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="ghost" data-testid="confirm-saved-cancel" onClick={() => settle(false)}>
            Cancel — change nothing
          </Button>
          <Button variant="destructive" data-testid="confirm-saved-continue" onClick={() => settle(true)}>
            I have the file — continue
          </Button>
        </div>
      </div>
    </Modal>
  );

  return { confirmSaved, confirmSavedDialog };
}
