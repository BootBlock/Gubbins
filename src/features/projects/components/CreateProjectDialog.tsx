import { useRef } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Button, FormField, Input, Modal, Select } from '@/components/foundry';
import { COSTING_MODES } from '@/db/repositories';
import { useCreateProject } from '../projects';
import { COSTING_MODE_LABELS } from './projects-ui';

/**
 * Project creation form (spec §2.4.4, §4) — React Hook Form bound to Zod. Captures
 * the name, an optional description and the initial BOM costing mode (§4).
 */
const schema = z.object({
  name: z.string().trim().min(1, 'Please enter a project name.'),
  description: z.string().optional(),
  costingMode: z.enum(COSTING_MODES),
});

type FormValues = z.infer<typeof schema>;

export function CreateProjectDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated?: (id: string) => void;
}) {
  const createProject = useCreateProject();
  const nameRef = useRef<HTMLInputElement>(null);
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { name: '', description: '', costingMode: 'CURRENT_REPLACEMENT' },
  });

  const close = () => {
    reset();
    onClose();
  };

  const onSubmit = (values: FormValues) => {
    createProject.mutate(
      {
        name: values.name.trim(),
        description: values.description?.trim() ? values.description.trim() : null,
        costingMode: values.costingMode,
      },
      {
        onSuccess: (project) => {
          onCreated?.(project.id);
          close();
        },
      },
    );
  };

  return (
    <Modal
      open={open}
      onClose={close}
      title="New project"
      description="Plan a build and its bill of materials."
      initialFocusRef={nameRef}
    >
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
        <FormField label="Name" error={errors.name?.message}>
          <Input
            placeholder="e.g. Bench power supply"
            {...(() => {
              const { ref, ...rest } = register('name');
              return {
                ...rest,
                ref: (el: HTMLInputElement | null) => {
                  ref(el);
                  nameRef.current = el;
                },
              };
            })()}
          />
        </FormField>

        <FormField label="Description (optional)">
          <Input placeholder="A short summary" {...register('description')} />
        </FormField>

        <FormField label="Costing">
          <Select {...register('costingMode')}>
            {COSTING_MODES.map((mode) => (
              <option key={mode} value={mode}>
                {COSTING_MODE_LABELS[mode]}
              </option>
            ))}
          </Select>
        </FormField>

        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button type="submit" disabled={createProject.isPending}>
            Create project
          </Button>
        </div>
      </form>
    </Modal>
  );
}
