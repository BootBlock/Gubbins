/**
 * Set, replace or remove an account's password (issue #79, plan §1.1).
 *
 * Separate from the account form because it is a different kind of act: the other fields are
 * details about a person, this one changes whether they are challenged at all. Keeping it apart
 * also means the account form never holds a plaintext password in its state.
 *
 * The dialog states plainly, every time, what a password here does and does not do — it gates
 * the app and attributes actions, it does **not** encrypt the database (plan §1.1). Overstating
 * that would be worse than offering nothing.
 */
import { useState } from 'react';
import { Banner, Button, FormField, Input, Modal } from '@/components/foundry';
import { useT } from '@/features/i18n';
import type { User } from '@/db/repositories/types';

export interface PasswordDialogProps {
  readonly user: User;
  readonly busy: boolean;
  readonly error: string | null;
  readonly onSetPassword: (password: string) => void;
  readonly onClearPassword: () => void;
  readonly onClose: () => void;
}

export function PasswordDialog({
  user,
  busy,
  error,
  onSetPassword,
  onClearPassword,
  onClose,
}: PasswordDialogProps) {
  const t = useT();
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');

  const mismatch = confirmation.length > 0 && password !== confirmation;
  const canSubmit = password.length > 0 && password === confirmation && !busy;

  return (
    <Modal
      open
      onClose={onClose}
      title={t('users.password.title', { vars: { name: user.displayName } })}
      description={t('users.password.description')}
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (canSubmit) onSetPassword(password);
        }}
      >
        {error ? (
          <Banner tone="danger" role="alert">
            {error}
          </Banner>
        ) : null}

        {/* Said on every visit, not once at setup: this is the moment somebody forms a belief
            about what the password protects, and the honest answer is "not the data". */}
        <Banner tone="info">{t('users.password.notEncrypted')}</Banner>

        <FormField label={t('users.password.new.label')}>
          <Input
            type="password"
            autoComplete="new-password"
            value={password}
            disabled={busy}
            onChange={(event) => setPassword(event.target.value)}
          />
        </FormField>

        <FormField
          label={t('users.password.confirm.label')}
          error={mismatch ? t('users.password.mismatch') : undefined}
        >
          <Input
            type="password"
            autoComplete="new-password"
            value={confirmation}
            disabled={busy}
            onChange={(event) => setConfirmation(event.target.value)}
          />
        </FormField>

        <div className="flex flex-wrap items-center justify-between gap-2">
          {/* Only offered when there is something to remove, so the control never implies the
              account is protected when it is not. */}
          {user.hasPassword ? (
            <Button type="button" variant="destructive" onClick={onClearPassword} disabled={busy}>
              {t('users.password.clear')}
            </Button>
          ) : (
            <span className="text-xs text-muted-foreground">{t('users.password.noneSet')}</span>
          )}
          <div className="flex gap-2">
            <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
              {t('users.password.cancel')}
            </Button>
            <Button type="submit" disabled={!canSubmit}>
              {t('users.password.save')}
            </Button>
          </div>
        </div>
      </form>
    </Modal>
  );
}
