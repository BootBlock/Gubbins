/**
 * Create or edit an account (issue #79, plan §2.1, phase 4).
 *
 * The same dialog serves both, because the fields are identical and a separate "edit" copy is
 * how the two drift. `user === null` means create.
 *
 * Disabling is edited here rather than from a row menu so it sits beside the message shown to
 * whoever is refused — the two are one decision, and a disable with no explanation is the state
 * the issue specifically asked to avoid.
 */
import { useState } from 'react';
import { Banner, Button, Checkbox, FormField, Input, Modal, SelectField } from '@/components/foundry';
import { useT } from '@/features/i18n';
import type { Role, User } from '@/db/repositories/types';
import { builtinRoleName } from '../builtin-role-labels';

export interface UserFormValues {
  readonly username: string;
  readonly displayName: string;
  readonly email: string | null;
  readonly roleId: string | null;
  readonly isEnabled: boolean;
  readonly disabledMessage: string | null;
}

export interface UserFormDialogProps {
  /** The account being edited, or `null` to create a new one. */
  readonly user: User | null;
  readonly roles: readonly Role[];
  readonly busy: boolean;
  readonly error: string | null;
  readonly onSubmit: (values: UserFormValues) => void;
  readonly onClose: () => void;
}

export function UserFormDialog({ user, roles, busy, error, onSubmit, onClose }: UserFormDialogProps) {
  const t = useT();
  const [username, setUsername] = useState(user?.username ?? '');
  const [displayName, setDisplayName] = useState(user?.displayName ?? '');
  const [email, setEmail] = useState(user?.email ?? '');
  const [roleId, setRoleId] = useState(user?.roleId ?? '');
  const [isEnabled, setIsEnabled] = useState(user?.isEnabled ?? true);
  const [disabledMessage, setDisabledMessage] = useState(user?.disabledMessage ?? '');

  const trimmedUsername = username.trim();
  const canSubmit = trimmedUsername.length > 0 && !busy;

  const submit = (): void => {
    if (!canSubmit) return;
    onSubmit({
      username: trimmedUsername,
      // An empty display name falls back to the username, matching the repository's own rule
      // rather than storing a blank that renders as an empty row.
      displayName: displayName.trim() || trimmedUsername,
      email: email.trim() || null,
      roleId: roleId || null,
      isEnabled,
      disabledMessage: disabledMessage.trim() || null,
    });
  };

  const roleOptions = [
    { value: '', label: t('users.form.role.none') },
    ...roles.map((role) => ({ value: role.id, label: builtinRoleName(role, t) })),
  ];

  return (
    <Modal
      open
      onClose={onClose}
      title={user ? t('users.form.title.edit') : t('users.form.title.create')}
      description={t('users.form.description')}
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        {error ? (
          <Banner tone="danger" role="alert">
            {error}
          </Banner>
        ) : null}

        <FormField label={t('users.form.username.label')} hint={t('users.form.username.hint')}>
          <Input
            value={username}
            autoComplete="off"
            disabled={busy}
            onChange={(event) => setUsername(event.target.value)}
          />
        </FormField>

        <FormField label={t('users.form.displayName.label')} hint={t('users.form.displayName.hint')}>
          <Input
            value={displayName}
            autoComplete="off"
            disabled={busy}
            onChange={(event) => setDisplayName(event.target.value)}
          />
        </FormField>

        <FormField label={t('users.form.email.label')}>
          <Input
            type="email"
            value={email}
            autoComplete="off"
            disabled={busy}
            onChange={(event) => setEmail(event.target.value)}
          />
        </FormField>

        <SelectField
          label={t('users.form.role.label')}
          hint={t('users.form.role.hint')}
          value={roleId}
          disabled={busy}
          onChange={setRoleId}
          options={roleOptions}
        />

        <label className="flex items-center gap-2 text-sm">
          <Checkbox
            checked={isEnabled}
            disabled={busy}
            onChange={(event) => setIsEnabled(event.target.checked)}
          />
          {t('users.form.enabled.label')}
        </label>

        {!isEnabled ? (
          <FormField
            label={t('users.form.disabledMessage.label')}
            hint={t('users.form.disabledMessage.hint')}
          >
            <Input
              value={disabledMessage}
              disabled={busy}
              onChange={(event) => setDisabledMessage(event.target.value)}
            />
          </FormField>
        ) : null}

        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
            {t('users.form.cancel')}
          </Button>
          <Button type="submit" disabled={!canSubmit}>
            {t('users.form.save')}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
