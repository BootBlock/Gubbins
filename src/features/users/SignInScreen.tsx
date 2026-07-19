/**
 * The sign-in screen (issue #79, plan §3).
 *
 * Deliberately **not** built on `PageContainer`/`PageHeader`: those render the app's nav and
 * search, and a gate that lets you navigate past it or search the inventory is not a gate. It
 * uses the boot-screen shell instead — one centred card, no chrome, no way onward.
 *
 * Two steps rather than a username box: pick an account, then prove it. A local household app
 * knows exactly who its users are, so making somebody *type* a username they can see on screen
 * is friction with no benefit. It also lets each tile carry its own state — a disabled account
 * says why, an unprotected one says that plainly (plan §1.1) — which a single text field
 * cannot.
 */
import { useEffect, useRef, useState } from 'react';
import {
  Banner,
  Button,
  FormField,
  Input,
  MAIN_CONTENT_ID,
  Modal,
  Spinner,
  Surface,
  optionCardClassName,
} from '@/components/foundry';
import { AccountIcon, PasswordIcon, WarningIcon } from '@/components/icons';
import { useT } from '@/features/i18n';
import { useErrorMessage } from '@/features/errors';
import { useModulesStore } from '@/state/stores/useModulesStore';
import { cn } from '@/lib/utils';
import type { User } from '@/db/repositories/types';
import type { SignInOutcome } from '@/db/repositories/UserRepository';

export interface SignInScreenProps {
  /** The accounts to offer, already filtered and ordered by the repository. */
  readonly users: readonly User[];
  /** True while the account list is still loading. */
  readonly loading: boolean;
  /** Attempt a sign-in. Resolves with the outcome; never throws for a wrong password. */
  readonly onSignIn: (userId: string, password: string) => Promise<SignInOutcome>;
}

export function SignInScreen({ users, loading, onSignIn }: SignInScreenProps) {
  const t = useT();
  const errorMessage = useErrorMessage();
  const [selected, setSelected] = useState<User | null>(null);
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const passwordRef = useRef<HTMLInputElement>(null);

  // Focus the password box the moment it appears, so choosing an account leads straight into
  // typing rather than requiring a second, unprompted click.
  useEffect(() => {
    if (selected?.hasPassword) passwordRef.current?.focus();
  }, [selected]);

  async function attempt(user: User, candidate: string): Promise<void> {
    setPending(true);
    setError(null);
    try {
      const outcome = await onSignIn(user.id, candidate);
      if (outcome.ok) return;
      if (outcome.reason === 'disabled') {
        setError(outcome.disabledMessage?.trim() || t('signIn.error.disabled'));
      } else if (outcome.reason === 'wrong-password') {
        setError(t('signIn.error.wrongPassword'));
      } else {
        setError(t('signIn.error.unknownUser'));
      }
      setPassword('');
    } catch (caught) {
      // A wrong password comes back as an outcome, but the attempt still reaches the database
      // and can fail outright — a dead worker, a locked table. Without this the button simply
      // re-enables and the screen looks untouched, which reads as "nothing happened".
      setError(errorMessage(caught, t('signIn.error.failed')));
      setPassword('');
    } finally {
      setPending(false);
    }
  }

  function chooseAccount(user: User): void {
    setError(null);
    setPassword('');
    if (!user.isEnabled) {
      setError(user.disabledMessage?.trim() || t('signIn.error.disabled'));
      return;
    }
    setSelected(user);
    // An account with no password has nothing to ask for, so choosing it *is* signing in.
    if (!user.hasPassword) void attempt(user, '');
  }

  return (
    <div className="relative grid min-h-dvh place-items-center overflow-hidden bg-background p-6">
      {/* Ambient gradient glow for depth, matching the boot screens. */}
      <div className="pointer-events-none absolute top-[-30%] left-1/2 size-[55rem] -translate-x-1/2 rounded-full bg-primary/10 blur-3xl" />
      <Surface className="relative w-full max-w-md p-8">
        <main id={MAIN_CONTENT_ID} tabIndex={-1} className="outline-none">
          <div className="flex flex-col items-center text-center">
            <span
              aria-hidden="true"
              className="grid size-14 place-items-center rounded-2xl bg-primary/15 text-primary [&_svg]:size-7"
            >
              <AccountIcon />
            </span>
            <h1 className="mt-4 text-xl font-semibold tracking-tight">{t('signIn.title')}</h1>
            <p className="mt-1.5 text-sm text-muted-foreground">
              {selected?.hasPassword ? t('signIn.subtitle.password') : t('signIn.subtitle.choose')}
            </p>
          </div>

          <div className="mt-6">
            {loading ? (
              <p className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
                <Spinner />
                {t('signIn.loading')}
              </p>
            ) : selected?.hasPassword ? (
              <PasswordStep
                user={selected}
                password={password}
                pending={pending}
                error={error}
                inputRef={passwordRef}
                onPasswordChange={setPassword}
                onSubmit={() => void attempt(selected, password)}
                onBack={() => {
                  setSelected(null);
                  setPassword('');
                  setError(null);
                }}
              />
            ) : (
              <AccountList users={users} error={error} pending={pending} onChoose={chooseAccount} />
            )}
          </div>

          <LockedOutEscape />
        </main>
      </Surface>
    </div>
  );
}

/**
 * The way back in when nobody can sign in (issue #79, plan §3).
 *
 * Without this the Modules manager — the only place the users module can be switched off — sits
 * behind the very gate a forgotten password closes, leaving an operator permanently locked out
 * of their own local database. The plan is explicit that turning the module off must never
 * strand anyone, and a warning at enable time is not a guarantee.
 *
 * This does not weaken anything real: §1.1 already states that sign-in is a soft boundary and
 * that the database on this device is readable by whoever holds the device. The honest move is
 * to say so here rather than to imply a protection the app cannot provide — so the confirmation
 * spells out both what this does and why it is possible.
 */
function LockedOutEscape() {
  const t = useT();
  const setFeatureIntent = useModulesStore((state) => state.setFeatureIntent);
  const [confirming, setConfirming] = useState(false);

  return (
    <>
      <div className="mt-6 flex justify-center border-t border-border pt-4">
        <Button variant="link" size="sm" onClick={() => setConfirming(true)}>
          {t('signIn.lockedOut.trigger')}
        </Button>
      </div>

      {confirming ? (
        <Modal
          open
          onClose={() => setConfirming(false)}
          title={t('signIn.lockedOut.title')}
          description={t('signIn.lockedOut.description')}
        >
          <div className="flex flex-col gap-4">
            <Banner tone="warning">{t('signIn.lockedOut.warning')}</Banner>
            <p className="text-sm text-muted-foreground">{t('signIn.lockedOut.dataSafe')}</p>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setConfirming(false)}>
                {t('signIn.lockedOut.cancel')}
              </Button>
              <Button
                variant="destructive"
                data-testid="sign-in-turn-off-users"
                // Records intent only. The accounts, their roles and every past attribution stay
                // exactly as they are — turning the module back on restores all of it (plan §3).
                onClick={() => setFeatureIntent('users', false)}
              >
                {t('signIn.lockedOut.confirm')}
              </Button>
            </div>
          </div>
        </Modal>
      ) : null}
    </>
  );
}

function AccountList({
  users,
  error,
  pending,
  onChoose,
}: {
  users: readonly User[];
  error: string | null;
  pending: boolean;
  onChoose: (user: User) => void;
}) {
  const t = useT();

  if (users.length === 0) {
    return (
      <Banner tone="warning" role="alert">
        {t('signIn.noAccounts')}
      </Banner>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {error ? (
        <Banner tone="danger" role="alert">
          {error}
        </Banner>
      ) : null}

      <div className="flex flex-col gap-2">
        {users.map((user) => (
          <button
            key={user.id}
            type="button"
            disabled={pending}
            onClick={() => onChoose(user)}
            // Left clickable on purpose so it can explain itself, but announced as unavailable
            // rather than letting a screen-reader user discover the refusal by activating it.
            aria-disabled={!user.isEnabled || undefined}
            // Must name whichever sub-line is actually rendered below: the disabled note wins
            // over the unprotected one, so pointing at the latter would dangle.
            aria-describedby={`signin-note-${user.id}`}
            className={cn(
              'flex items-center gap-3 disabled:opacity-60',
              optionCardClassName(false),
              !user.isEnabled && 'opacity-60',
            )}
          >
            <span aria-hidden="true" className="text-muted-foreground [&_svg]:size-5">
              {user.hasPassword ? <PasswordIcon /> : <AccountIcon />}
            </span>
            <span className="flex min-w-0 flex-col">
              <span className="truncate font-medium">{user.displayName}</span>
              {!user.isEnabled ? (
                <span id={`signin-note-${user.id}`} className="text-xs text-muted-foreground">
                  {t('signIn.tile.disabled')}
                </span>
              ) : !user.hasPassword ? (
                <span
                  id={`signin-note-${user.id}`}
                  className="flex items-center gap-1 text-xs text-warning [&_svg]:size-3.5"
                >
                  <WarningIcon aria-hidden="true" />
                  {t('signIn.tile.noPassword')}
                </span>
              ) : null}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

function PasswordStep({
  user,
  password,
  pending,
  error,
  inputRef,
  onPasswordChange,
  onSubmit,
  onBack,
}: {
  user: User;
  password: string;
  pending: boolean;
  error: string | null;
  inputRef: React.RefObject<HTMLInputElement | null>;
  onPasswordChange: (value: string) => void;
  onSubmit: () => void;
  onBack: () => void;
}) {
  const t = useT();

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <p className="text-center text-sm font-medium">{user.displayName}</p>

      {/* FormField owns the label association, `aria-invalid`, the `role="alert"` error text
          and the field gap — all of it wiring that must not be hand-rolled here. */}
      <FormField label={t('signIn.password.label')} error={error ?? undefined}>
        <Input
          ref={inputRef}
          type="password"
          autoComplete="current-password"
          value={password}
          disabled={pending}
          onChange={(event) => onPasswordChange(event.target.value)}
        />
      </FormField>

      <div className="flex justify-between gap-2">
        <Button type="button" variant="ghost" onClick={onBack} disabled={pending}>
          {t('signIn.back')}
        </Button>
        <Button type="submit" disabled={pending || password.length === 0}>
          {pending ? <Spinner /> : null}
          {t('signIn.submit')}
        </Button>
      </div>
    </form>
  );
}
