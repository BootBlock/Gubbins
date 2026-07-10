import { z } from 'zod';
import { COSTING_MODES, PROJECT_STATUSES } from '@/db/repositories';

/**
 * Shared project form schema for the create and edit dialogs (spec §4).
 *
 * One schema drives both: creation ignores `status` (a new project always starts PLANNING),
 * while editing surfaces it. Keeping the schema and its {@link ProjectFormValues} type here —
 * separate from the {@link ProjectFormFields} component — lets both dialogs reuse them without
 * tripping Fast Refresh's component-only-export rule.
 */
export const projectFormSchema = z.object({
  name: z.string().trim().min(1, 'Please enter a project name.'),
  description: z.string().optional(),
  icon: z.string().nullable().optional(),
  status: z.enum(PROJECT_STATUSES),
  costingMode: z.enum(COSTING_MODES),
});

export type ProjectFormValues = z.infer<typeof projectFormSchema>;
