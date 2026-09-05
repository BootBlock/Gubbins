/**
 * Mint and revoke a user's Bridge API tokens (issue #79, plan §1.3).
 *
 * A token lets something outside the app — Home Assistant, a script, a dashboard — talk to the
 * Bridge **as this user**, with exactly their permissions and nothing more. That is the whole
 * point of the dialog living on an account rather than in a settings page: the credential and the
 * identity it speaks for are the same decision, made in one place.
 *
 * Two properties the UI has to get right:
 *
 * - **The token is shown once.** Only a hash is stored, so there is no "show it again" and the
 *   copy says so before the user closes the panel rather than after. Minting a replacement is
 *   the recovery path, which is why revoking sits beside minting rather than on another screen.
 * - **Revocation is immediate and total.** The row is deleted, not flagged, so a revoked token
 *   stops working everywhere the change reaches, and the hash is all that was ever stored — the
 *   same secret can never be re-minted. So the row's button asks rather than acts: it hands the
 *   token to `onRequestRevoke`, and `RevokeApiTokenDialog` says all of that plainly instead of
 *   implying it can be undone (issue #1272). What that dialog's copy must say is held up by
 *   `UsersScreen.test` → "names the token it is about to destroy, and says the loss is permanent",
 *   not by this sentence — an earlier version of it asserted confirm wording nobody had written.
 */
import { useState } from 'react';
import { Banner, Button, FormField, Input, Modal, Surface } from '@/components/foundry';
import { CommandBlock } from '@/features/home-assistant/components';
import { useT } from '@/features/i18n';
import { useFormatters } from '@/lib/useFormatters';
import type { ApiToken, User } from '@/db/repositories/types';

export interface ApiTokensDialogProps {
  readonly user: User;
  readonly tokens: readonly ApiToken[];
  readonly loading: boolean;
  readonly busy: boolean;
  readonly error: string | null;
  /**
   * The plaintext of a token minted in this session, or `null`. Held by the caller rather than
   * here so it is cleared deliberately (on close) instead of surviving as component state.
   */
  readonly mintedToken: string | null;
  readonly onMint: (name: string) => void;
  /** Asks for a revoke; the caller confirms it (`RevokeApiTokenDialog`) before anything is written. */
  readonly onRequestRevoke: (token: ApiToken) => void;
  readonly onClose: () => void;
}

export function ApiTokensDialog({
  user,
  tokens,
  loading,
  busy,
  error,
  mintedToken,
  onMint,
  onRequestRevoke,
  onClose,
}: ApiTokensDialogProps) {
  const t = useT();
  const formatters = useFormatters();
  const [name, setName] = useState('');

  const canSubmit = name.trim().length > 0 && !busy;

  return (
    <Modal
      open
      onClose={onClose}
      scrollBody
      title={t('users.tokens.title', { vars: { name: user.displayName } })}
      description={t('users.tokens.description')}
      // Dismissing mid-mint would take down the only copy of the new token's plaintext, which is
      // shown here once and never stored.
      busy={busy}
    >
      <div className="flex flex-col gap-4">
        {error ? (
          <Banner tone="danger" role="alert">
            {error}
          </Banner>
        ) : null}

        {/* Said up front, not as a footnote: a token carries this account's permissions, so who
            it belongs to is the security decision — not what it is called. */}
        <Banner tone="info">
          {t('users.tokens.carriesPermissions', { vars: { name: user.displayName } })}
        </Banner>

        {mintedToken ? (
          <Surface className="flex flex-col gap-2 p-3">
            <Banner tone="warning">{t('users.tokens.shownOnce')}</Banner>
            <CommandBlock code={mintedToken} label={t('users.tokens.copyLabel')} />
          </Surface>
        ) : null}

        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (canSubmit) {
              onMint(name.trim());
              setName('');
            }
          }}
        >
          <FormField className="min-w-48 flex-1" label={t('users.tokens.name.label')}>
            <Input
              value={name}
              disabled={busy}
              placeholder={t('users.tokens.name.placeholder')}
              onChange={(event) => setName(event.target.value)}
            />
          </FormField>
          <Button type="submit" disabled={!canSubmit}>
            {t('users.tokens.mint')}
          </Button>
        </form>

        {loading ? (
          <p className="text-sm text-muted-foreground">{t('users.tokens.loading')}</p>
        ) : tokens.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('users.tokens.empty')}</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {tokens.map((token) => (
              <li key={token.id}>
                <Surface className="flex flex-wrap items-center gap-3 p-3">
                  <div className="flex min-w-0 flex-1 flex-col gap-field-gap-compact">
                    <span className="text-sm font-medium text-foreground">{token.name}</span>
                    <p className="truncate font-mono text-xs text-muted-foreground">
                      {t('users.tokens.prefix', {
                        vars: { prefix: token.tokenPrefix, created: formatters.date(token.createdAt) },
                      })}
                    </p>
                  </div>
                  <Button
                    variant="destructive"
                    size="sm"
                    disabled={busy}
                    onClick={() => onRequestRevoke(token)}
                  >
                    {t('users.tokens.revoke')}
                  </Button>
                </Surface>
              </li>
            ))}
          </ul>
        )}

        <div className="flex justify-end">
          <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
            {t('users.tokens.close')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
