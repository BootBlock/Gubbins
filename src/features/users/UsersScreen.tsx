/**
 * The Users screen — accounts and roles (issue #79, plan §4 phase 4).
 *
 * Two sections, because they are two different questions: **who** may use this copy of Gubbins,
 * and **what** each of them may do. Roles are edited here rather than on their own screen since
 * a role is meaningless without the accounts holding it.
 *
 * The screen is readable with the module switched off, and says so. That is deliberate: the
 * accounts and roles still exist while the feature is off (nothing is deleted — plan §3), and
 * hiding the screen would make the data look lost. It also means an operator can set an account
 * up *before* turning enforcement on, rather than being asked to enable a gate first and
 * discover afterwards that they had nobody to sign in as.
 */
import { useState } from 'react';
import {
  Banner,
  Button,
  LiveRegion,
  MAIN_CONTENT_ID,
  Modal,
  PageContainer,
  PageHeader,
  Surface,
} from '@/components/foundry';
import {
  AccountIcon,
  AddIcon,
  DeleteIcon,
  EditIcon,
  PasswordIcon,
  RoleIcon,
  UsersIcon,
  WarningIcon,
} from '@/components/icons';
import { useT } from '@/features/i18n';
import { useErrorMessage } from '@/features/errors';
import { useFeature } from '@/features/modules/useFeature';
import { useSessionStore } from '@/state/stores/useSessionStore';
import { BUILTIN_USER_IDS } from '@/db/repositories/constants';
import type { Role, User } from '@/db/repositories/types';
import { useRoles, useUsers } from './queries';
import {
  useClearUserPassword,
  useCreateRole,
  useCreateUser,
  useDeleteRole,
  useDeleteUser,
  useSetUserPassword,
  useUpdateRole,
  useUpdateUser,
} from './mutations';
import { UserFormDialog, type UserFormValues } from './components/UserFormDialog';
import { PasswordDialog } from './components/PasswordDialog';
import { RoleFormDialog, type RoleFormValues } from './components/RoleFormDialog';

/** Whether a row is one of the two seeded principals, which the schema protects from edits. */
function isBuiltin(user: User): boolean {
  return BUILTIN_USER_IDS.includes(user.id as (typeof BUILTIN_USER_IDS)[number]);
}

export function UsersScreen() {
  const t = useT();
  const errorMessage = useErrorMessage();
  const moduleEnabled = useFeature('users');
  const signedInUserId = useSessionStore((state) => state.session?.userId ?? null);

  const usersQuery = useUsers();
  const rolesQuery = useRoles();
  const createUser = useCreateUser();
  const updateUser = useUpdateUser();
  const deleteUser = useDeleteUser();
  const setPassword = useSetUserPassword();
  const clearPassword = useClearUserPassword();
  const createRole = useCreateRole();
  const updateRole = useUpdateRole();
  const deleteRole = useDeleteRole();

  const [userDialog, setUserDialog] = useState<{ readonly user: User | null } | null>(null);
  const [passwordFor, setPasswordFor] = useState<User | null>(null);
  const [deletingUser, setDeletingUser] = useState<User | null>(null);
  const [roleDialog, setRoleDialog] = useState<{ readonly role: Role | null } | null>(null);
  const [deletingRole, setDeletingRole] = useState<Role | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');

  const users = usersQuery.data?.rows ?? [];
  const roles = rolesQuery.data?.rows ?? [];
  const roleName = (id: string | null): string | null => roles.find((role) => role.id === id)?.name ?? null;

  const onError = (error: unknown): void => setFormError(errorMessage(error, t('users.error.generic')));

  // Every dialog opener goes through one of these. `formError` is shared by all of them, so an
  // opener that forgets to clear it shows the *previous* dialog's failure in a fresh, unsubmitted
  // form — which is why opening is a named function rather than a bare `setState` at each site.
  const openUserDialog = (user: User | null): void => {
    setFormError(null);
    setUserDialog({ user });
  };
  const openRoleDialog = (role: Role | null): void => {
    setFormError(null);
    setRoleDialog({ role });
  };
  const openPasswordDialog = (user: User): void => {
    setFormError(null);
    setPasswordFor(user);
  };

  const submitUser = (values: UserFormValues): void => {
    setFormError(null);
    const editing = userDialog?.user ?? null;
    const done = (message: string) => () => {
      setAnnouncement(message);
      setUserDialog(null);
    };

    if (editing) {
      updateUser.mutate(
        { id: editing.id, input: values },
        { onSuccess: done(t('users.announce.saved', { vars: { name: values.displayName } })), onError },
      );
      return;
    }
    createUser.mutate(values, {
      onSuccess: done(t('users.announce.created', { vars: { name: values.displayName } })),
      onError,
    });
  };

  const submitRole = (values: RoleFormValues): void => {
    setFormError(null);
    const editing = roleDialog?.role ?? null;
    const done = (message: string) => () => {
      setAnnouncement(message);
      setRoleDialog(null);
    };

    if (editing) {
      updateRole.mutate(
        { id: editing.id, input: values },
        { onSuccess: done(t('roles.announce.saved', { vars: { name: values.name } })), onError },
      );
      return;
    }
    createRole.mutate(values, {
      onSuccess: done(t('roles.announce.created', { vars: { name: values.name } })),
      onError,
    });
  };

  const passwordBusy = setPassword.isPending || clearPassword.isPending;

  return (
    <PageContainer>
      <PageHeader
        icon={<UsersIcon />}
        title={t('users.title')}
        actions={
          <Button onClick={() => openUserDialog(null)}>
            <AddIcon aria-hidden />
            {t('users.add')}
          </Button>
        }
      />

      <main
        id={MAIN_CONTENT_ID}
        tabIndex={-1}
        className="flex flex-1 animate-rise flex-col gap-6 outline-none"
      >
        {/* Says which of the two worlds the reader is in. Without it the screen looks the same
            whether permissions are being enforced or entirely ignored, which is the single most
            confusing thing this feature could do. */}
        <Banner tone={moduleEnabled ? 'info' : 'warning'} heading={t('users.status.heading')}>
          {moduleEnabled ? t('users.status.on') : t('users.status.off')}
        </Banner>

        <section aria-labelledby="users-accounts-heading" className="flex flex-col gap-3">
          <h2 id="users-accounts-heading" className="text-sm font-semibold text-foreground">
            {t('users.accounts.heading')}
          </h2>

          {usersQuery.isPending ? (
            <p className="text-sm text-muted-foreground">{t('users.accounts.loading')}</p>
          ) : usersQuery.isError ? (
            // Never fall through to an empty state on failure — "no accounts" would be a lie
            // that hides a real error behind copy reading like success.
            <Surface className="flex flex-col items-center gap-3 p-8 text-center">
              <p role="alert" className="text-sm text-destructive">
                {t('users.accounts.error')}
              </p>
              <Button variant="outline" onClick={() => void usersQuery.refetch()}>
                {t('users.accounts.retry')}
              </Button>
            </Surface>
          ) : (
            <ul className="flex flex-col gap-2">
              {users.map((user) => (
                <li key={user.id}>
                  <UserRow
                    user={user}
                    roleName={roleName(user.roleId)}
                    isSelf={user.id === signedInUserId}
                    onEdit={() => openUserDialog(user)}
                    onPassword={() => openPasswordDialog(user)}
                    onDelete={() => {
                      setFormError(null);
                      setDeletingUser(user);
                    }}
                  />
                </li>
              ))}
            </ul>
          )}
        </section>

        <section aria-labelledby="users-roles-heading" className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 id="users-roles-heading" className="text-sm font-semibold text-foreground">
              {t('roles.heading')}
            </h2>
            <Button variant="outline" size="sm" onClick={() => openRoleDialog(null)}>
              <AddIcon aria-hidden />
              {t('roles.add')}
            </Button>
          </div>
          <p className="text-sm text-muted-foreground">{t('roles.intro')}</p>

          {rolesQuery.isPending ? (
            <p className="text-sm text-muted-foreground">{t('roles.loading')}</p>
          ) : rolesQuery.isError ? (
            <Surface className="flex flex-col items-center gap-3 p-8 text-center">
              <p role="alert" className="text-sm text-destructive">
                {t('roles.error')}
              </p>
              <Button variant="outline" onClick={() => void rolesQuery.refetch()}>
                {t('roles.retry')}
              </Button>
            </Surface>
          ) : (
            <ul className="flex flex-col gap-2">
              {roles.map((role) => (
                <li key={role.id}>
                  <RoleRow
                    role={role}
                    memberCount={users.filter((user) => user.roleId === role.id).length}
                    onEdit={() => openRoleDialog(role)}
                    onDelete={() => {
                      setFormError(null);
                      setDeletingRole(role);
                    }}
                  />
                </li>
              ))}
            </ul>
          )}
        </section>
      </main>

      <LiveRegion visuallyHidden>{announcement}</LiveRegion>

      {userDialog ? (
        <UserFormDialog
          // Remount when the target changes: the dialog seeds its fields from props with
          // `useState`, so reusing the instance would edit one account with another's values.
          key={userDialog.user?.id ?? 'new'}
          user={userDialog.user}
          roles={roles}
          busy={createUser.isPending || updateUser.isPending}
          error={formError}
          onSubmit={submitUser}
          onClose={() => setUserDialog(null)}
        />
      ) : null}

      {passwordFor ? (
        <PasswordDialog
          key={passwordFor.id}
          user={passwordFor}
          busy={passwordBusy}
          error={formError}
          onSetPassword={(password) =>
            setPassword.mutate(
              { id: passwordFor.id, password },
              {
                onSuccess: () => {
                  setAnnouncement(
                    t('users.announce.passwordSet', { vars: { name: passwordFor.displayName } }),
                  );
                  setPasswordFor(null);
                },
                onError,
              },
            )
          }
          onClearPassword={() =>
            clearPassword.mutate(passwordFor.id, {
              onSuccess: () => {
                setAnnouncement(
                  t('users.announce.passwordCleared', { vars: { name: passwordFor.displayName } }),
                );
                setPasswordFor(null);
              },
              onError,
            })
          }
          onClose={() => setPasswordFor(null)}
        />
      ) : null}

      {roleDialog ? (
        <RoleFormDialog
          key={roleDialog.role?.id ?? 'new'}
          role={roleDialog.role}
          busy={createRole.isPending || updateRole.isPending}
          error={formError}
          onSubmit={submitRole}
          onClose={() => setRoleDialog(null)}
        />
      ) : null}

      {deletingUser ? (
        <Modal
          open
          onClose={() => setDeletingUser(null)}
          title={t('users.delete.title')}
          description={t('users.delete.body', { vars: { name: deletingUser.displayName } })}
        >
          <div className="flex flex-col gap-4">
            {formError ? (
              <Banner tone="danger" role="alert">
                {formError}
              </Banner>
            ) : null}
            {/* The one part of a deletion that is *not* obvious: their past changes stay, and
                stay readable, re-attributed to the built-in System user. */}
            <Banner tone="info">{t('users.delete.historyNote')}</Banner>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setDeletingUser(null)} disabled={deleteUser.isPending}>
                {t('users.delete.cancel')}
              </Button>
              <Button
                variant="destructive"
                disabled={deleteUser.isPending}
                onClick={() =>
                  deleteUser.mutate(deletingUser.id, {
                    onSuccess: () => {
                      setAnnouncement(
                        t('users.announce.deleted', { vars: { name: deletingUser.displayName } }),
                      );
                      setDeletingUser(null);
                    },
                    // Without this a refused delete — no `users:manage`, or a built-in guard —
                    // leaves the dialog sitting there unchanged, which reads as a dead button.
                    onError,
                  })
                }
              >
                {t('users.delete.confirm')}
              </Button>
            </div>
          </div>
        </Modal>
      ) : null}

      {deletingRole ? (
        <Modal
          open
          onClose={() => setDeletingRole(null)}
          title={t('roles.delete.title')}
          description={t('roles.delete.body', { vars: { name: deletingRole.name } })}
        >
          <div className="flex flex-col gap-4">
            {formError ? (
              <Banner tone="danger" role="alert">
                {formError}
              </Banner>
            ) : null}
            <Banner tone="info">{t('roles.delete.membersNote')}</Banner>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setDeletingRole(null)} disabled={deleteRole.isPending}>
                {t('roles.delete.cancel')}
              </Button>
              <Button
                variant="destructive"
                disabled={deleteRole.isPending}
                onClick={() =>
                  deleteRole.mutate(deletingRole.id, {
                    onSuccess: () => {
                      setAnnouncement(t('roles.announce.deleted', { vars: { name: deletingRole.name } }));
                      setDeletingRole(null);
                    },
                    // A built-in role refuses deletion; saying nothing would read as a dead button.
                    onError,
                  })
                }
              >
                {t('roles.delete.confirm')}
              </Button>
            </div>
          </div>
        </Modal>
      ) : null}
    </PageContainer>
  );
}

/** One account's row: who they are, what they hold, and what may be done to them. */
function UserRow({
  user,
  roleName,
  isSelf,
  onEdit,
  onPassword,
  onDelete,
}: {
  readonly user: User;
  readonly roleName: string | null;
  readonly isSelf: boolean;
  readonly onEdit: () => void;
  readonly onPassword: () => void;
  readonly onDelete: () => void;
}) {
  const t = useT();
  const builtin = isBuiltin(user);
  // System is an actor rather than a person: it never signs in, so a password control on its row
  // would offer something the repository and the schema trigger both refuse.
  const isSystem = user.kind === 'system';

  return (
    <Surface className="flex flex-wrap items-center gap-3 p-3">
      <span aria-hidden className="text-muted-foreground [&_svg]:size-5">
        {user.hasPassword ? <PasswordIcon /> : <AccountIcon />}
      </span>

      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium text-foreground">{user.displayName}</span>
          {isSelf ? (
            <span className="rounded-full bg-primary/15 px-2 py-0.5 text-xs font-medium text-primary">
              {t('users.row.you')}
            </span>
          ) : null}
          {builtin ? (
            <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
              {t('users.row.builtin')}
            </span>
          ) : null}
          {/* System is stored disabled because it must never sign in, but badging it
              "Sign-in turned off" would read as an administrative decision somebody could undo.
              Its "Built-in" badge and its lack of any controls already say what it is. */}
          {!user.isEnabled && !isSystem ? (
            <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
              {t('users.row.disabled')}
            </span>
          ) : null}
        </div>

        <p className="truncate text-xs text-muted-foreground">
          {user.username}
          {roleName ? ` · ${roleName}` : ''}
        </p>

        {/* The no-password warning the plan (§1.1) requires on this list, worded exactly as the
            sign-in tile words it so the two surfaces cannot drift apart. System is exempt: it has
            no password by design and is not a sign-in. */}
        {!user.hasPassword && !isSystem ? (
          <p className="flex items-center gap-1 text-xs text-warning [&_svg]:size-3.5">
            <WarningIcon aria-hidden />
            {t('signIn.tile.noPassword')}
          </p>
        ) : null}
      </div>

      <div className="flex items-center gap-2">
        {!isSystem ? (
          <Button variant="outline" size="sm" onClick={onPassword}>
            {t('users.row.passwordAction')}
          </Button>
        ) : null}
        {!builtin ? (
          <>
            <Button variant="ghost" size="icon" onClick={onEdit} aria-label={t('users.row.edit')}>
              <EditIcon aria-hidden />
            </Button>
            <Button variant="ghost" size="icon" onClick={onDelete} aria-label={t('users.row.delete')}>
              <DeleteIcon aria-hidden />
            </Button>
          </>
        ) : null}
      </div>
    </Surface>
  );
}

/** One role's row: its name, how many hold it, and what may be done to it. */
function RoleRow({
  role,
  memberCount,
  onEdit,
  onDelete,
}: {
  readonly role: Role;
  readonly memberCount: number;
  readonly onEdit: () => void;
  readonly onDelete: () => void;
}) {
  const t = useT();

  return (
    <Surface className="flex flex-wrap items-center gap-3 p-3">
      <span aria-hidden className="text-muted-foreground [&_svg]:size-5">
        <RoleIcon />
      </span>

      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium text-foreground">{role.name}</span>
          {role.isBuiltin ? (
            <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
              {t('roles.row.builtin')}
            </span>
          ) : null}
        </div>
        {role.description ? (
          <p className="truncate text-xs text-muted-foreground">{role.description}</p>
        ) : null}
        <p className="text-xs text-muted-foreground">
          {t('roles.row.members', { vars: { count: memberCount } })}
        </p>
      </div>

      <div className="flex items-center gap-2">
        <Button variant="ghost" size="icon" onClick={onEdit} aria-label={t('roles.row.edit')}>
          <EditIcon aria-hidden />
        </Button>
        {/* A built-in role is editable but never deletable — removing it would strand everyone
            assigned to it (plan §2.3). The repository and a schema trigger both refuse it too. */}
        {!role.isBuiltin ? (
          <Button variant="ghost" size="icon" onClick={onDelete} aria-label={t('roles.row.delete')}>
            <DeleteIcon aria-hidden />
          </Button>
        ) : null}
      </div>
    </Surface>
  );
}
