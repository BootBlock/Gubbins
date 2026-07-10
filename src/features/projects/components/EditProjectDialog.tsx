import { useEffect, useRef } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Button, Modal, Spinner, useToast } from '@/components/foundry';
import { EditIcon } from '@/components/icons';
import type { Project } from '@/db/repositories';
import { useUpdateProject } from '../projects';
import { ProjectFormFields } from './ProjectFormFields';
import { projectFormSchema, type ProjectFormValues } from './project-form';

/** Map a stored project onto the form's shape (nullable fields become editable defaults). */
function toFormValues(project: Project): ProjectFormValues {
  return {
    name: project.name,
    description: project.description ?? '',
    icon: project.icon,
    status: project.status,
    costingMode: project.costingMode,
  };
}

/**
 * Edit an existing project's core fields (spec §4) — name, description, icon, lifecycle
 * status and BOM costing mode. Budget and the BOM itself have their own richer editors, so
 * they stay out of this dialog. React Hook Form + Zod, seeded from the current project and
 * re-seeded whenever the dialog is (re)opened so it never shows a stale draft.
 */
export function EditProjectDialog({
  open,
  onClose,
  project,
}: {
  open: boolean;
  onClose: () => void;
  project: Project;
}) {
  const updateProject = useUpdateProject();
  const { show } = useToast();
  const nameRef = useRef<HTMLInputElement>(null);
  const {
    control,
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<ProjectFormValues>({
    resolver: zodResolver(projectFormSchema),
    defaultValues: toFormValues(project),
  });

  // Re-seed from the current project only on the closed→open transition, so reopening after
  // a cancel (or on a different project) shows the live values. It deliberately does NOT
  // re-seed while already open: a background refetch (e.g. on reconnect) hands us a new
  // `project` reference, and resetting on that would discard the user's in-progress edits.
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open && !wasOpen.current) reset(toFormValues(project));
    wasOpen.current = open;
  }, [open, project, reset]);

  const onSubmit = (values: ProjectFormValues) => {
    const name = values.name.trim();
    updateProject.mutate(
      {
        id: project.id,
        input: {
          name,
          description: values.description?.trim() ? values.description.trim() : null,
          icon: values.icon ?? null,
          status: values.status,
          costingMode: values.costingMode,
        },
      },
      {
        onSuccess: () => {
          onClose();
          show({
            tone: 'success',
            icon: <EditIcon />,
            heading: 'Project updated',
            message: `"${name}" was saved.`,
          });
        },
        onError: () =>
          show({ tone: 'danger', heading: 'Update failed', message: 'The project was not updated.' }),
      },
    );
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Edit project"
      description="Update this project's details."
      initialFocusRef={nameRef}
    >
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
        <ProjectFormFields
          control={control}
          register={register}
          errors={errors}
          nameRef={nameRef}
          showStatus
        />

        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={onClose} disabled={updateProject.isPending}>
            Cancel
          </Button>
          <Button type="submit" disabled={updateProject.isPending}>
            {updateProject.isPending ? <Spinner /> : null}
            Save changes
          </Button>
        </div>
      </form>
    </Modal>
  );
}
