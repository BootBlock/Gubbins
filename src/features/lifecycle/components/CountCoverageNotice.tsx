/**
 * The "you have not counted everything here" notice (issue #637), shared by the standalone
 * cycle-count dialog and the guided stock-take's per-location panel.
 *
 * A blind count skips a line left blank rather than reading it as zero, which is the safe
 * arithmetic but leaves nothing on screen to separate "counted the shelf, found it perfect"
 * from "typed nothing at all" — both end with no variance and no adjustment. This strip is
 * that separation, sitting directly above the footer that offers to finish, and it says what
 * finishing now will and will not do: the counted lines are applied, the location is not
 * recorded as counted.
 *
 * Deliberately **not** a live region. Its wording changes on every keystroke as lines fill in,
 * so announcing it politely would talk over the auditor as they type. The accessible signal is
 * the primary button's own label, which says "partial" in as many words while the sheet is
 * incomplete.
 */
import { WarningIcon } from '@/components/icons';
import { plural } from '@/lib/plural';
import type { CountCoverage } from '../cycle-count';

export function CountCoverageNotice({ coverage }: { coverage: CountCoverage }) {
  if (coverage.isComplete) return null;
  return (
    <div
      className="flex items-start gap-3 rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm text-muted-foreground"
      data-testid="count-coverage-notice"
    >
      <WarningIcon className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
      <p className="min-w-0 flex-1">
        <span className="font-medium text-foreground">
          {coverage.blank} of {coverage.total} {plural(coverage.total, 'line')} not counted yet.
        </span>{' '}
        Finishing now applies only the lines you counted. This location keeps its old last-counted date, so it
        still shows as needing a count.
      </p>
    </div>
  );
}

/**
 * The footer's one-line coverage tally ("12 of 40 lines counted"), rendered beside the
 * adjustment count so the two questions a finished sheet raises — how much did I cover, and
 * what will authorising change — are answered in the same place.
 */
export function coverageSummary(coverage: CountCoverage): string {
  return `${coverage.counted} of ${coverage.total} ${plural(coverage.total, 'line')} counted`;
}
