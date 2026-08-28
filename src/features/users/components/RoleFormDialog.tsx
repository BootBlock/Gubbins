/**
 * Create or edit a role — a named bundle of permissions (issue #79, plan §2.3, phase 4;
 * relaid out and documented for issue #429).
 *
 * The grid is generated from `PERMISSION_SUBJECTS`, never hand-listed, so a subject or action
 * added to the registry appears here with no edit to this file — the same SSOT discipline the
 * registry itself was built for.
 *
 * All of the grant semantics (the global wildcard, subject wildcards, and grants this build does
 * not recognise) live in the pure `role-grants.ts` seam. This component only renders the model
 * and reports clicks, which is what keeps the awkward cases testable without a DOM.
 *
 * **Why the grid is laid out in slots rather than in declaration order.** Subjects do not share
 * an action set: the audit trail is `view`/`delete`, an account is `read`/`manage`, an import is
 * `run`. Rendering each row's actions in order therefore put the audit trail's *Delete* box
 * directly beneath Items' *Change* box — every column carried a different meaning at every row,
 * which is the one mistake a permission grid must never invite. Each action is now placed in the
 * fixed column `actionSlot` gives it, and a subject with nothing in a slot leaves that cell
 * genuinely empty. Where a subject's action is not the column's own word — Manage, Run, Print —
 * the cell captions itself, so the grid never claims an action is something it is not.
 */
import { useId, useState } from 'react';
import {
  Banner,
  Button,
  Checkbox,
  FormField,
  GlyphPickerButton,
  InfoHint,
  Input,
  Modal,
  Surface,
} from '@/components/foundry';
import { RoleIcon } from '@/components/icons';
import { useT, type TypedTranslator } from '@/features/i18n';
import type { Role } from '@/db/repositories/types';
import {
  PERMISSION_ACTION_SLOT_IDS,
  PERMISSION_SUBJECT_IDS,
  permissionKeyInSlot,
  permissionKeysFor,
  splitGrant,
  type PermissionAction,
  type PermissionActionSlot,
  type PermissionSubject,
} from '../permission-registry';
import { builtinRoleDescription, builtinRoleName } from '../builtin-role-labels';
import {
  actionLabelKey,
  slotHelpKey,
  slotLabelKey,
  subjectHelpKey,
  subjectLabelKey,
} from '../permission-labels';
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
  readonly icon: string | null;
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

/**
 * One row of the grid: the subject's own column, then one cell per slot.
 *
 * The template is shared by the header and every row, which is what makes the columns line up —
 * a per-row `flex` layout cannot, because the rows hold different numbers of boxes.
 */
const GRID_TEMPLATE = 'grid grid-cols-[minmax(0,1fr)_repeat(3,4.5rem)] items-center gap-x-3';

export function RoleFormDialog({ role, busy, error, onSubmit, onClose }: RoleFormDialogProps) {
  const t = useT();
  const everythingHintId = useId();
  const iconFieldId = useId();
  // Seeded with the *translated* text for a still-default built-in role: an operator should edit
  // the wording they can actually read. Saving it back untouched is folded to the shipped English
  // by `toStoredRoleText` at the call site, so an unchanged save leaves the row translatable.
  const [name, setName] = useState(role ? builtinRoleName(role, t) : '');
  const [description, setDescription] = useState(role ? (builtinRoleDescription(role, t) ?? '') : '');
  const [icon, setIcon] = useState<string | null>(role?.icon ?? null);
  const [model, setModel] = useState<RoleGrantModel>(() => toGrantModel(role?.permissions ?? []));

  const trimmedName = name.trim();
  const canSubmit = trimmedName.length > 0 && !busy;

  const submit = (): void => {
    if (!canSubmit) return;
    onSubmit({
      name: trimmedName,
      description: description.trim() || null,
      icon,
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
      busy={busy}
      // Widened from the Modal's default `max-w-lg` (issue #429): the permission grid is four
      // columns of its own, and at the default width the action columns crowded the subject
      // names badly enough that a row read as one run-on line.
      className="max-w-3xl"
    >
      <form
        className="flex flex-col gap-5"
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

        {/* Name and description sit side by side at this width; they stack again below `sm`. */}
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label={t('roles.form.name.label')} hint={t('roles.form.name.hint')}>
            <Input
              value={name}
              autoComplete="off"
              disabled={busy}
              onChange={(event) => setName(event.target.value)}
            />
          </FormField>

          <FormField label={t('roles.form.description.label')} hint={t('roles.form.description.hint')}>
            <Input
              value={description}
              autoComplete="off"
              disabled={busy}
              onChange={(event) => setDescription(event.target.value)}
            />
          </FormField>
        </div>

        {/* An explicit <label htmlFor> (a <button> is a labelable element) rather than
            FormField's implicit-label wrap, which is meant for a single input — the same
            shape the project and location icon fields use. */}
        <div>
          <label htmlFor={iconFieldId} className="mb-field-gap block text-sm font-medium">
            {t('roles.form.icon.label')}
          </label>
          <GlyphPickerButton
            id={iconFieldId}
            value={icon}
            onChange={setIcon}
            fallback={RoleIcon}
            placeholder={t('roles.form.icon.placeholder')}
            title={t('roles.form.icon.title')}
            disabled={busy}
            clearable
          />
        </div>

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
          className="flex flex-col gap-3 disabled:opacity-50"
        >
          <legend className="text-sm font-semibold text-foreground">{t('roles.form.grid.legend')}</legend>
          <p className="text-xs text-muted-foreground">{t('roles.form.grid.hint')}</p>

          <SlotHeader t={t} />

          <ul className="flex flex-col divide-y divide-border border-t border-border">
            {PERMISSION_SUBJECT_IDS.map((subject) => (
              <SubjectRow key={subject} subject={subject} model={model} onChange={setModel} t={t} />
            ))}
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

/**
 * The column headings, each carrying the help that explains what that action means app-wide.
 *
 * The row is **not** `aria-hidden`, though every checkbox below already names its own subject and
 * action in full. Hiding it would take the three help badges with it, and a badge is focusable —
 * so a screen-reader user could Tab onto a node assistive technology had been told did not exist,
 * and the explanation of what View, Change and Delete actually mean would be announced to nobody.
 * Three words of duplication ahead of the grid is the smaller cost.
 */
function SlotHeader({ t }: { readonly t: TypedTranslator }) {
  return (
    <div className={`${GRID_TEMPLATE} pb-1`}>
      <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {t('roles.form.grid.subjectColumn')}
      </span>
      {PERMISSION_ACTION_SLOT_IDS.map((slot) => (
        <span key={slot} className="flex items-center justify-center gap-1">
          <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {t(slotLabelKey(slot))}
          </span>
          <InfoHint content={t(slotHelpKey(slot))} size="md" />
        </span>
      ))}
    </div>
  );
}

/** One subject's row: its select-all box and name, then one cell per slot. */
function SubjectRow({
  subject,
  model,
  onChange,
  t,
}: {
  readonly subject: PermissionSubject;
  readonly model: RoleGrantModel;
  readonly onChange: (next: RoleGrantModel) => void;
  readonly t: TypedTranslator;
}) {
  const keys = permissionKeysFor(subject);
  const row = model.subjects.get(subject);
  const allTicked = keys.every((key) => isKeyTicked(model, key));
  const subjectLabel = t(subjectLabelKey(subject));

  return (
    <li className={`${GRID_TEMPLATE} py-2.5`}>
      <div className="flex min-w-0 items-center gap-2">
        <Checkbox
          checked={allTicked}
          aria-label={t('roles.form.grid.allActions', { vars: { subject: subjectLabel } })}
          onChange={(event) => onChange(toggleSubject(model, subject, event.target.checked))}
        />
        <span className="truncate text-sm font-medium text-foreground">{subjectLabel}</span>
        <InfoHint content={t(subjectHelpKey(subject))} size="lg" />
        {row?.mode === 'wildcard' && !model.grantsEverything ? (
          <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
            {t('roles.form.grid.wildcard')}
          </span>
        ) : null}
      </div>

      {PERMISSION_ACTION_SLOT_IDS.map((slot) => (
        <SlotCell
          key={slot}
          subject={subject}
          subjectLabel={subjectLabel}
          slot={slot}
          model={model}
          onChange={onChange}
          t={t}
        />
      ))}
    </li>
  );
}

/**
 * One cell of the grid — a checkbox, or nothing at all where the subject has no action in this
 * column. An empty cell is what keeps a column meaning one thing all the way down.
 */
function SlotCell({
  subject,
  subjectLabel,
  slot,
  model,
  onChange,
  t,
}: {
  readonly subject: PermissionSubject;
  readonly subjectLabel: string;
  readonly slot: PermissionActionSlot;
  readonly model: RoleGrantModel;
  readonly onChange: (next: RoleGrantModel) => void;
  readonly t: TypedTranslator;
}) {
  const key = permissionKeyInSlot(subject, slot);
  if (!key) return <span />;

  const [, action] = splitGrant(key);
  const actionLabel = t(actionLabelKey(action as PermissionAction));
  const slotLabel = t(slotLabelKey(slot));
  // Most actions *are* their column — Items' `write` is simply "Change". The few that are not
  // (Manage, Run, Print) caption themselves, so the grid never lets a column's heading stand in
  // for an action that means something narrower.
  const captioned = actionLabel !== slotLabel;

  return (
    <span className="flex flex-col items-center justify-center gap-0.5">
      <Checkbox
        checked={isKeyTicked(model, key)}
        data-testid={`role-permission-${key}`}
        aria-label={t('roles.form.grid.actionBox', { vars: { subject: subjectLabel, action: actionLabel } })}
        onChange={(event) => onChange(toggleKey(model, key, event.target.checked))}
      />
      {captioned ? <span className="text-xs leading-none text-muted-foreground">{actionLabel}</span> : null}
    </span>
  );
}
