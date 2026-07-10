import { useId, type MutableRefObject } from 'react';
import { Controller, type Control, type FieldErrors, type UseFormRegister } from 'react-hook-form';
import { FormField, GlyphPickerButton, Input, SelectField } from '@/components/foundry';
import { ProjectIcon } from '@/components/icons';
import { COSTING_MODES, PROJECT_STATUSES } from '@/db/repositories';
import { COSTING_MODE_LABELS, PROJECT_STATUS_LABELS } from './projects-ui';
import type { ProjectFormValues } from './project-form';

/**
 * Shared project form fields for the create and edit dialogs (spec §4). Creation always
 * starts a project in PLANNING, so the status control is edit-only (`showStatus`). Keeping
 * the name/description/icon/costing controls in one place means their tokens and ARIA never
 * drift between the two dialogs. The schema and value type live in {@link ./project-form}.
 */
export interface ProjectFormFieldsProps {
  readonly control: Control<ProjectFormValues>;
  readonly register: UseFormRegister<ProjectFormValues>;
  readonly errors: FieldErrors<ProjectFormValues>;
  /** Receives the name input so the dialog can focus it on open (type-first). */
  readonly nameRef: MutableRefObject<HTMLInputElement | null>;
  /** Show the lifecycle status control (edit only — creation always starts PLANNING). */
  readonly showStatus?: boolean;
}

export function ProjectFormFields({
  control,
  register,
  errors,
  nameRef,
  showStatus = false,
}: ProjectFormFieldsProps) {
  const iconFieldId = useId();
  const { ref: nameFormRef, ...nameField } = register('name');

  return (
    <>
      <FormField label="Name" error={errors.name?.message}>
        <Input
          placeholder="e.g. Bench power supply"
          {...nameField}
          ref={(el) => {
            nameFormRef(el);
            nameRef.current = el;
          }}
        />
      </FormField>

      <FormField label="Description (optional)">
        <Input placeholder="A short summary" {...register('description')} />
      </FormField>

      {/* Explicit <label htmlFor> (a <button> is a labelable element) rather than
          FormField's implicit-label wrap, which is meant for a single input — mirrors
          AutocompleteField. */}
      <div>
        <label htmlFor={iconFieldId} className="mb-field-gap block text-sm font-medium">
          Icon (optional)
        </label>
        <Controller
          control={control}
          name="icon"
          render={({ field }) => (
            <GlyphPickerButton
              id={iconFieldId}
              value={field.value ?? null}
              onChange={field.onChange}
              fallback={ProjectIcon}
              placeholder="Choose an icon"
              title="Choose a project icon"
              clearable
            />
          )}
        />
      </div>

      {showStatus ? (
        <Controller
          control={control}
          name="status"
          render={({ field }) => (
            <SelectField
              label="Status"
              value={field.value}
              onChange={field.onChange}
              options={PROJECT_STATUSES.map((status) => ({
                value: status,
                label: PROJECT_STATUS_LABELS[status],
              }))}
            />
          )}
        />
      ) : null}

      <Controller
        control={control}
        name="costingMode"
        render={({ field }) => (
          <SelectField
            label="Costing"
            value={field.value}
            onChange={field.onChange}
            options={COSTING_MODES.map((mode) => ({ value: mode, label: COSTING_MODE_LABELS[mode] }))}
          />
        )}
      />
    </>
  );
}
