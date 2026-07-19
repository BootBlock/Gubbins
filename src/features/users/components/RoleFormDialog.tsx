/**
 * Create or edit a role — a named bundle of permissions (issue #79, plan §2.3, phase 4).
 *
 * The grid is generated from `PERMISSION_SUBJECTS`, never hand-listed, so a subject or action
 * added to the registry appears here with no edit to this file — the same SSOT discipline the
 * registry itself was built for.
 *
 * All of the grant semantics (the global wildcard, subject wildcards, and grants this build does
 * not recognise) live in the pure `role-grants.ts` seam. This component only renders the model
 * and reports clicks, which is what keeps the awkward cases testable without a DOM.
 */
import { useId, useState } from 'react';
import { Banner, Button, Checkbox, FormField, Input, Modal, Surface } from '@/components/foundry';
import { useT, type MessageKey } from '@/features/i18n';
import type { Role } from '@/db/repositories/types';
import {
  PERMISSION_SUBJECT_IDS,
  permissionKeysFor,
  splitGrant,
  type PermissionSubject,
} from '../permission-registry';
import { builtinRoleDescription, builtinRoleName } from '../builtin-role-labels';
import {
  fromGrantModel,
  isKeyTicked,
  setGrantsEverything,
  toGrantModel,
  toggleKey,
  toggleSubject,
  type RoleGrantModel,
} from '../role-grants';

export interface RoleFormValues {
  readonly name: string;
  readonly description: string | null;
  readonly permissions: readonly string[];
}

export interface RoleFormDialogProps {
  /** The role being edited, or `null` to create a new one. */
  readonly role: Role | null;
  readonly busy: boolean;
  readonly error: string | null;
  readonly onSubmit: (values: RoleFormValues) => void;
  readonly onClose: () => void;
}

/** A subject's display label key. Generated per subject so the grid needs no hand-written list. */
function subjectLabelKey(subject: PermissionSubject): MessageKey {
  return `users.subject.${subject}` as MessageKey;
}

/** An action's display label key, shared across every subject that supports that action. */
function actionLabelKey(action: string): MessageKey {
  return `users.action.${action}` as MessageKey;
}

export function RoleFormDialog({ role, busy, error, onSubmit, onClose }: RoleFormDialogProps) {
  const t = useT();
  const everythingHintId = useId();
  // Seeded with the *translated* text for a still-default built-in role: an operator should edit
  // the wording they can actually read. Saving it back untouched is folded to the shipped English
  // by `toStoredRoleText` at the call site, so an unchanged save leaves the row translatable.
  const [name, setName] = useState(role ? builtinRoleName(role, t) : '');
  const [description, setDescription] = useState(role ? (builtinRoleDescription(role, t) ?? '') : '');
  const [model, setModel] = useState<RoleGrantModel>(() => toGrantModel(role?.permissions ?? []));

  const trimmedName = name.trim();
  const canSubmit = trimmedName.length > 0 && !busy;

  const submit = (): void => {
    if (!canSubmit) return;
    onSubmit({
      name: trimmedName,
      description: description.trim() || null,
      permissions: fromGrantModel(model),
    });
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={role ? t('roles.form.title.edit') : t('roles.form.title.create')}
      description={t('roles.form.description')}
      scrollBody
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

        {role?.isBuiltin ? <Banner tone="info">{t('roles.form.builtinNote')}</Banner> : null}

        <FormField label={t('roles.form.name.label')}>
          <Input
            value={name}
            autoComplete="off"
            disabled={busy}
            onChange={(event) => setName(event.target.value)}
          />
        </FormField>

        <FormField label={t('roles.form.description.label')}>
          <Input
            value={description}
            autoComplete="off"
            disabled={busy}
            onChange={(event) => setDescription(event.target.value)}
          />
        </FormField>

        <Surface className="flex flex-col gap-field-gap-compact p-4">
          {/* The label wraps only the control and its name; the hint sits outside it and is
           *described* to the control instead, so it never folds into the accessible name. */}
          <label className="flex items-center gap-2 text-sm font-medium">
            <Checkbox
              checked={model.grantsEverything}
              disabled={busy}
              data-testid="role-grants-everything"
              aria-describedby={everythingHintId}
              onChange={(event) => setModel(setGrantsEverything(model, event.target.checked))}
            />
            {t('roles.form.everything.label')}
          </label>
          <p id={everythingHintId} className="text-xs text-muted-foreground">
            {t('roles.form.everything.hint')}
          </p>
        </Surface>

        <fieldset
          disabled={busy || model.grantsEverything}
          className="flex flex-col gap-2 disabled:opacity-50"
        >
          <legend className="text-sm font-semibold text-foreground">{t('roles.form.grid.legend')}</legend>
          <p className="text-xs text-muted-foreground">{t('roles.form.grid.hint')}</p>

          <ul className="flex flex-col divide-y divide-border">
            {PERMISSION_SUBJECT_IDS.map((subject) => {
              const keys = permissionKeysFor(subject);
              const row = model.subjects.get(subject);
              const allTicked = keys.every((key) => isKeyTicked(model, key));
              return (
                <li key={subject} className="flex flex-wrap items-center gap-x-4 gap-y-2 py-2.5">
                  <div className="flex min-w-40 flex-1 items-center gap-2">
                    <Checkbox
                      checked={allTicked}
                      aria-label={t('roles.form.grid.allActions', {
                        vars: { subject: t(subjectLabelKey(subject)) },
                      })}
                      onChange={(event) => setModel(toggleSubject(model, subject, event.target.checked))}
                    />
                    <span className="text-sm font-medium text-foreground">{t(subjectLabelKey(subject))}</span>
                    {row?.mode === 'wildcard' && !model.grantsEverything ? (
                      <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                        {t('roles.form.grid.wildcard')}
                      </span>
                    ) : null}
                  </div>
                  <div className="flex flex-wrap items-center gap-3">
                    {keys.map((key) => {
                      const [, action] = splitGrant(key);
                      return (
                        <label key={key} className="flex items-center gap-1.5 text-sm">
                          <Checkbox
                            checked={isKeyTicked(model, key)}
                            data-testid={`role-permission-${key}`}
                            onChange={(event) => setModel(toggleKey(model, key, event.target.checked))}
                          />
                          {t(actionLabelKey(action))}
                        </label>
                      );
                    })}
                  </div>
                </li>
              );
            })}
          </ul>
        </fieldset>

        {model.unknown.length > 0 ? (
          <Banner tone="info">
            {t('roles.form.unknownGrants', { vars: { count: model.unknown.length } })}
          </Banner>
        ) : null}

        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
            {t('roles.form.cancel')}
          </Button>
          <Button type="submit" disabled={!canSubmit}>
            {t('roles.form.save')}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
