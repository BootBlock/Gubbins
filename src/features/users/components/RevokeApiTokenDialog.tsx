/**
 * The API-token revoke confirmation (issue #1272).
 *
 * Revoking is a hard delete plus a tombstone, so it propagates by sync: anything authenticating
 * with the token — a Home Assistant install, a dashboard, a script — is refused on every device
 * from the moment the change reaches it. Only a hash of the secret was ever stored, so the same
 * token can never be minted again; recovery means a new token, set up afresh wherever the old one
 * was used.
 *
 * None of that was said before this dialog existed, and the control that did it was the single
 * word "Revoke" at the end of a row. Rows are told apart by a name and the short prefix kept in
 * the clear (`API_TOKEN_DISPLAY_CHARS`), so the dialog repeats both — the point is not the pause,
 * it is being sure it is *this* token. Initial focus lands on Cancel, so a reflex Enter keeps the
 * token — the same choice the location delete confirmation makes.
 *
 * What the copy has to say is held up by a test rather than by this paragraph: `UsersScreen.test`
 * → "names the token it is about to destroy, and says the loss is permanent". The claim that came
 * before it — a docstring asserting confirm wording nobody had written — is what issue #1272 was.
 */
import { useRef } from 'react';
import { Banner, Button, Modal } from '@/components/foundry';
import { useT } from '@/features/i18n';
import type { ApiToken } from '@/db/repositories/types';

export interface RevokeApiTokenDialogProps {
  readonly token: ApiToken;
  /** The revoke write is in flight — every button locks and the frame refuses dismissal. */
  readonly busy: boolean;
  /**
   * A refused revoke, shown here rather than only in the tokens dialog underneath: this dialog
   * stays open until the write succeeds, so an error rendered below it would be invisible.
   */
  readonly error: string | null;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}

export function RevokeApiTokenDialog({ token, busy, error, onCancel, onConfirm }: RevokeApiTokenDialogProps) {
  const t = useT();
  const cancelRef = useRef<HTMLButtonElement>(null);

  return (
    <Modal
      open
      onClose={onCancel}
      title={t('users.tokens.revokeConfirm.title')}
      description={t('users.tokens.revokeConfirm.body', {
        vars: { name: token.name, prefix: token.tokenPrefix },
      })}
      initialFocusRef={cancelRef}
      busy={busy}
    >
      <div className="flex flex-col gap-4">
        {error ? (
          <Banner tone="danger" role="alert">
            {error}
          </Banner>
        ) : null}
        {/* The half a user cannot see coming: the plaintext was never kept, so there is no
            re-issuing the same secret — only replacing it everywhere. */}
        <Banner tone="warning">{t('users.tokens.revokeConfirm.note')}</Banner>
        <div className="flex justify-end gap-2">
          <Button ref={cancelRef} variant="outline" onClick={onCancel} disabled={busy}>
            {t('users.tokens.revokeConfirm.cancel')}
          </Button>
          <Button variant="destructive" disabled={busy} onClick={onConfirm}>
            {t('users.tokens.revokeConfirm.confirm')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
