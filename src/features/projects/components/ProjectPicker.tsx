/**
 * ProjectPicker — the control for choosing **one project** (issue #484).
 *
 * The item pickers' problem in a smaller set: a picker that reads a fixed first page offers the
 * alphabetically first hundred projects and nothing else, so a long-running workshop's older
 * projects fall off the end of it with nothing on screen to say so. Projects are a far smaller
 * set than items, so this bites much later — but the shape of the failure is identical, and the
 * remedy is the same one {@link ItemPicker} applies: the typed text drives the read.
 *
 * `list({ search })` resolves the filter in the database, so typing reaches projects that sort
 * past the offered page; {@link useProjectCount} over the same filter is what lets the control
 * say how many matches it is *not* showing rather than presenting a capped read as the whole set.
 */
import { useMemo, useState, type ReactNode, type Ref } from 'react';
import { Autocomplete, AutocompleteField, LiveRegion, usePickerSelection } from '@/components/foundry';
import type { Project } from '@/db/repositories';
import { useT } from '@/features/i18n';
import { useProject, useProjectCount, useProjects } from '../projects';

/** How many projects the picker offers at once — the same short list the item picker offers. */
export const PROJECT_PICKER_LIMIT = 20;

const projectLabel = (project: Project): string => project.name;
const projectId = (project: Project): string => project.id;

export interface ProjectPickerProps {
  /** The chosen project's id, or `null` / `''` for "nothing chosen". */
  readonly value: string | null;
  /** Fires with the chosen project's id, or `null` when the box no longer names one. */
  readonly onChange: (projectId: string | null, project?: Project) => void;
  /** Visible field label. Omit it *only* where the field is named by `aria-label` instead. */
  readonly label?: ReactNode;
  /** Accessible name for the unlabelled case; ignored when `label` is given. */
  readonly 'aria-label'?: string;
  readonly hint?: string;
  readonly placeholder?: string;
  readonly disabled?: boolean;
  readonly id?: string;
  readonly className?: string;
  readonly inputRef?: Ref<HTMLInputElement>;
  readonly 'data-testid'?: string;
}

export function ProjectPicker({
  value,
  onChange,
  label,
  'aria-label': ariaLabel,
  hint,
  placeholder,
  disabled,
  id,
  className,
  inputRef,
  'data-testid': testId,
}: ProjectPickerProps) {
  const t = useT();
  const [text, setText] = useState('');
  const query = text.trim();
  const browse = useMemo(() => (query.length > 0 ? { search: query } : {}), [query]);

  const page = useProjects(1, PROJECT_PICKER_LIMIT, browse);
  const total = useProjectCount(browse);
  const rows = useMemo<readonly Project[]>(() => page.data?.rows ?? [], [page.data]);

  const chosen = useProject(value === null || value === '' ? undefined : value);

  const { suggestions, onText } = usePickerSelection<Project>({
    value,
    onChange,
    rows,
    setText,
    resolved: chosen.data,
    labelFor: projectLabel,
    idFor: projectId,
  });

  const matched = total.data ?? 0;
  let status: string | null = null;
  if (total.data !== undefined && matched === 0 && query.length > 0) {
    status = t('projectPicker.noMatches', { vars: { query } });
  } else if (matched > rows.length) {
    status = t('projectPicker.truncated', { vars: { shown: rows.length, total: matched } });
  }

  const shared = {
    value: text,
    onChange: onText,
    suggestions,
    // Narrowed by the database against what was typed — see {@link ItemPicker}.
    prefiltered: true,
    maxOptions: PROJECT_PICKER_LIMIT,
    placeholder: placeholder ?? t('projectPicker.placeholder'),
    disabled,
    id,
    'data-testid': testId,
  } as const;

  return (
    <div className={className}>
      {label !== undefined ? (
        <AutocompleteField {...shared} label={label} hint={hint} inputRef={inputRef} />
      ) : (
        <Autocomplete {...shared} aria-label={ariaLabel} ref={inputRef} />
      )}
      {/* Always mounted, so the message is announced when it appears rather than inserted with it. */}
      <LiveRegion className="text-xs text-muted-foreground">
        {/* The gap hangs off the message, not the region: an always-mounted region with a margin
            would otherwise push the control out of line with the button beside it. */}
        {status !== null ? (
          <span className="mt-1 block" data-testid="project-picker-status">
            {status}
          </span>
        ) : null}
      </LiveRegion>
    </div>
  );
}
