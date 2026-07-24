import { Banner } from '@/components/foundry';
import { useT } from '@/features/i18n';
import type { ImportRowProblem } from '../columns';

/**
 * The shared "these rows weren't imported" notice for an importer's review step (issue #350).
 *
 * A parser reports the rows it could not honour rather than substituting a number for them, and
 * this is where the user is told: one line per row, naming the row, what it called itself, and
 * the cell exactly as the file wrote it. Shared by the BOM and purchase-list previews so both
 * explain a rejected quantity in the same words — an importer that renders its own list would
 * drift from the other the first time the wording changed.
 *
 * Renders nothing when there is nothing to report, so a call site can mount it unconditionally.
 */
export function ImportProblemsBanner({
  problems,
  'data-testid': testId,
}: {
  readonly problems: readonly ImportRowProblem[];
  readonly 'data-testid'?: string;
}) {
  const t = useT();
  if (problems.length === 0) return null;

  return (
    <Banner
      tone="warning"
      heading={t('import.problem.heading', { vars: { count: problems.length } })}
      data-testid={testId}
    >
      <ul className="list-disc space-y-1 pl-4">
        {problems.map((problem) => (
          <li key={`${problem.sourceRow}-${problem.reason}`}>
            {t(`import.problem.${problem.reason}`, {
              vars: { row: problem.sourceRow, label: problem.label, value: problem.value },
            })}
          </li>
        ))}
      </ul>
    </Banner>
  );
}
