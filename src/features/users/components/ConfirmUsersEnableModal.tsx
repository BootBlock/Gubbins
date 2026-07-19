/**
 * The confirmation shown before the users module is switched on (issue #79, plan §3).
 *
 * Switching this module on is unlike any other toggle in the Modules manager: it puts a sign-in
 * in front of the whole app. If nobody present knows a password for an account that can still
 * sign in, the operator has locked themselves out of their own data — so the state is checked
 * and described *before* the change, not discovered after it.
 *
 * The check is a real gate, not just copy. With no account able to sign in the confirm button is
 * refused outright; that state should be unreachable (the built-in Admin can be neither deleted
 * nor disabled), but "should be unreachable" is not a reason to let the one irreversible-feeling
 * action through unguarded.
 */
import { Banner, Button, Modal, Spinner } from '@/components/foundry';
import { useT } from '@/features/i18n';
import type { User } from '@/db/repositories/types';
import { useUsers } from '../queries';

export interface ConfirmUsersEnableModalProps {
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}

/**
 * The accounts that could actually sign in once the module is on: everyone bar **System**, which
 * is the actor the app writes as rather than a person, and anyone disabled.
 */
export function signInCapableAccounts(users: readonly User[]): readonly User[] {
  return users.filter((user) => user.kind !== 'system' && user.isEnabled);
}

export function ConfirmUsersEnableModal({ onConfirm, onCancel }: ConfirmUsersEnableModalProps) {
  const t = useT();
  const usersQuery = useUsers();

  const loading = usersQuery.isPending;
  const failed = usersQuery.isError;
  const capable = signInCapableAccounts(usersQuery.data?.rows ?? []);
  const withoutPassword = capable.filter((user) => !user.hasPassword);
  // Refuse while the accounts are unknown as well as when there are none: enabling on the back of
  // a failed read would be deciding this is safe without having checked.
  const blocked = loading || failed || capable.length === 0;

  return (
    <Modal
      open
      onClose={onCancel}
      title={t('users.enable.title')}
      description={t('users.enable.description')}
    >
      <div className="flex flex-col gap-4">
        {loading ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner />
            {t('users.enable.checking')}
          </p>
        ) : failed ? (
          <Banner tone="danger" role="alert">
            {t('users.enable.checkFailed')}
          </Banner>
        ) : capable.length === 0 ? (
          <Banner tone="danger" role="alert">
            {t('users.enable.noAccounts')}
          </Banner>
        ) : withoutPassword.length > 0 ? (
          // At least one account needs no password, so getting back in is guaranteed. Named, so
          // the reassurance is checkable rather than a promise.
          <Banner tone="info">
            {t('users.enable.passwordlessAccount', {
              vars: { name: withoutPassword.map((user) => user.displayName).join(', ') },
            })}
          </Banner>
        ) : (
          <Banner tone="warning">
            {t('users.enable.allProtected', {
              vars: { names: capable.map((user) => user.displayName).join(', ') },
            })}
          </Banner>
        )}

        <ul className="flex list-disc flex-col gap-1.5 pl-5 text-sm text-muted-foreground">
          <li>{t('users.enable.point.signIn')}</li>
          <li>{t('users.enable.point.attribution')}</li>
          <li>{t('users.enable.point.reversible')}</li>
          <li>{t('users.enable.point.notEncrypted')}</li>
        </ul>

        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onCancel}>
            {t('users.enable.cancel')}
          </Button>
          <Button onClick={onConfirm} disabled={blocked} data-testid="confirm-users-enable">
            {t('users.enable.confirm')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
