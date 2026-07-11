import { useMemo } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Button, FormField, Input, Modal, SelectField, Spinner, useToast } from '@/components/foundry';
import { ProjectIcon } from '@/components/icons';
import type { Item } from '@/db/repositories';
import { useT } from '@/features/i18n';
import { useAddItemToProject, useProjects } from '../projects';
import { PROJECT_STATUS_LABELS } from './projects-ui';

/**
 * Item-centric "Add to project" — reached from the item card's actions menu. Where
 * {@link AddBomLineDialog} is project-scoped (the project is fixed, you pick the item),
 * this fixes the item and lets the user pick an existing project plus a required quantity,
 * adding the item as a BOM line via the shared `addLine` write path ({@link useAddItemToProject}).
 * No new project is created here — a project must already exist.
 */
type FormValues = { projectId: string; requiredQty?: string };

export function AddItemToProjectDialog({
  item,
  open,
  onClose,
}: {
  item: Item;
  open: boolean;
  onClose: () => void;
}) {
  const t = useT();
  const projectsQuery = useProjects();
  const addToProject = useAddItemToProject();
  const { show } = useToast();
  const projects = projectsQuery.data?.rows ?? [];

  // Built through the translator so the "choose a project" validation message is localised
  // like every other string here; `t` is a stable reference per language, so the memo only
  // rebuilds when the language changes.
  const schema = useMemo(
    () =>
      z.object({
        projectId: z.string().min(1, t('inventory.addToProject.projectError')),
        requiredQty: z.string().optional(),
      }),
    [t],
  );

  const {
    control,
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { projectId: '', requiredQty: '1' },
  });

  const close = () => {
    reset();
    onClose();
  };

  const onSubmit = (values: FormValues) => {
    const project = projects.find((p) => p.id === values.projectId);
    if (!project) return;
    addToProject.mutate(
      {
        projectId: values.projectId,
        input: {
          itemId: item.id,
          requiredQty: Math.max(1, Math.floor(Number(values.requiredQty) || 1)),
        },
      },
      {
        onSuccess: () => {
          show({
            tone: 'success',
            icon: <ProjectIcon />,
            heading: t('inventory.addToProject.successHeading'),
            message: t('inventory.addToProject.successMessage', {
              vars: { item: item.name, project: project.name },
            }),
          });
          close();
        },
        onError: () =>
          show({
            tone: 'danger',
            heading: t('inventory.addToProject.errorHeading'),
            message: t('inventory.addToProject.errorMessage', { vars: { item: item.name } }),
          }),
      },
    );
  };

  return (
    <Modal
      open={open}
      onClose={close}
      title={t('inventory.addToProject.title')}
      description={t('inventory.addToProject.description', { vars: { name: item.name } })}
    >
      {projectsQuery.isLoading ? (
        <div className="flex justify-center py-6">
          <Spinner />
        </div>
      ) : projects.length === 0 ? (
        <div className="space-y-4">
          <p className="rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
            {t('inventory.addToProject.empty')}
          </p>
          <div className="flex justify-end">
            <Button type="button" variant="ghost" onClick={close}>
              {t('inventory.addToProject.close')}
            </Button>
          </div>
        </div>
      ) : (
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <Controller
            control={control}
            name="projectId"
            render={({ field }) => (
              <SelectField
                label={t('inventory.addToProject.projectLabel')}
                value={field.value ?? ''}
                onChange={field.onChange}
                error={errors.projectId?.message}
                options={[
                  { value: '', label: t('inventory.addToProject.projectPlaceholder') },
                  ...projects.map((project) => ({
                    value: project.id,
                    label: `${project.name} · ${PROJECT_STATUS_LABELS[project.status]}`,
                  })),
                ]}
              />
            )}
          />

          <FormField label={t('inventory.addToProject.quantityLabel')} error={errors.requiredQty?.message}>
            <Input type="number" min={1} step={1} {...register('requiredQty')} />
          </FormField>

          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="ghost" onClick={close}>
              {t('inventory.addToProject.cancel')}
            </Button>
            <Button type="submit" disabled={addToProject.isPending}>
              {addToProject.isPending ? <Spinner /> : null}
              {t('inventory.addToProject.submit')}
            </Button>
          </div>
        </form>
      )}
    </Modal>
  );
}
