import { useRef } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Button, Modal } from '@/components/foundry';
import { useCreateProject } from '../projects';
import { ProjectFormFields } from './ProjectFormFields';
import { projectFormSchema, type ProjectFormValues } from './project-form';

/**
 * Project creation form (spec §2.4.4, §4) — React Hook Form bound to Zod. Captures the
 * name, an optional description, an optional icon and the initial BOM costing mode (§4);
 * a new project always starts in the PLANNING status, so that control is edit-only.
 */
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
    control,
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<ProjectFormValues>({
    resolver: zodResolver(projectFormSchema),
    defaultValues: {
      name: '',
      description: '',
      icon: null,
      status: 'PLANNING',
      costingMode: 'CURRENT_REPLACEMENT',
    },
  });

  const close = () => {
    reset();
    onClose();
  };

  const onSubmit = (values: ProjectFormValues) => {
    createProject.mutate(
      {
        name: values.name.trim(),
        description: values.description?.trim() ? values.description.trim() : null,
        icon: values.icon ?? null,
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
        <ProjectFormFields control={control} register={register} errors={errors} nameRef={nameRef} />

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
