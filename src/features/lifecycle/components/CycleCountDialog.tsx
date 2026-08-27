/**
 * Cycle Counting & Reconciliation workflow (spec §4.4). The user blind-counts the
 * DISCRETE items in a location; the dialog highlights variances against the expected
 * database quantities and, on authorisation, persists a Reconciliation Adjustment
 * per drifted line (item quantity + a `RECONCILED` ledger entry). The same dialog
 * audits SERIALISED instances by **presence** — each qty-1 unit is flagged present
 * or missing, and a missing instance is reconciled by a reversible soft-delete.
 *
 * This is the standalone "count just this location" entry. The count → variance →
 * reconcile engine itself lives in {@link useLocationCycleCount} and the count sheet in
 * {@link CycleCountLines}, both shared with the guided audit-day stepper so the two never
 * fork; the transient count lives in the Tier-3 {@link CycleCountProvider}.
 */
import { useEffect, useRef, useState } from 'react';

import { plural } from '@/lib/plural';
import { Button, LiveRegion, Modal, Tooltip, useBurst, useReportDialogBusy } from '@/components/foundry';
import { CycleCountProvider } from '../CycleCountContext';
import { useLocationCycleCount } from '../useLocationCycleCount';
import { CountCoverageNotice, coverageSummary } from './CountCoverageNotice';
import { CountDraftNotice } from './CountDraftNotice';
import { CycleCountLines } from './CycleCountLines';

export function CycleCountDialog({
  open,
  onClose,
  location,
}: {
  open: boolean;
  onClose: () => void;
  location: { id: string; name: string };
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Cycle count — ${location.name}`}
      description="Blind-count the items in this location, then authorise any variances."
      className="max-w-xl"
    >
      <CycleCountProvider>
        <CycleCountBody location={location} onClose={onClose} />
      </CycleCountProvider>
    </Modal>
  );
}

function CycleCountBody({
  location,
  onClose,
}: {
  location: { id: string; name: string };
  onClose: () => void;
}) {
  const count = useLocationCycleCount(location);
  const { isLoading, isEmpty, drift, missing, totalToApply, coverage, pending, restored, clearSheet } = count;
  const [applied, setApplied] = useState<number | null>(null);
  // The coverage the finished count actually achieved, captured at authorisation. `coverage`
  // itself is reset by the `clearSheet()` inside `authorise()`, so the result view has to read
  // this rather than the live value, or a partial count would report itself as complete.
  const [appliedCoverage, setAppliedCoverage] = useState<string | null>(null);

  // Authorising writes the adjustments, the presence audit and the location's counted-at stamp in
  // one transaction, and the count of what it applied is reported here and nowhere else. A
  // dismissal mid-write would still alter the ledger, only silently — so the frame holds until it
  // is done (issue #654).
  useReportDialogBusy(pending);

  // Celebrate a completed count with a one-shot milestone burst (visual-flair F4) as the result
  // view appears. Edge-detected on the `null → confirmed` transition via a ref so it fires exactly
  // once — not on every render of the result view — and resets if the body is reused for a fresh
  // count. The result text is announced separately by the LiveRegion below, and the burst is a
  // no-op under reduced motion. Every finish path (clean / variance / empty) sets `applied`.
  const { burst } = useBurst();
  const celebrated = useRef(false);
  useEffect(() => {
    if (applied !== null) {
      if (!celebrated.current) {
        celebrated.current = true;
        burst();
      }
    } else {
      celebrated.current = false;
    }
  }, [applied, burst]);

  // The completion message — null until the count is confirmed. Kept as a derived string so a
  // single always-mounted LiveRegion (below) receives it as mutating children (WCAG 4.1.3).
  // Using a string rather than JSX lets the region stay stable across view transitions: the
  // same DOM node watches for changes in the form view and then receives content once applied
  // is set, guaranteeing assistive tech will announce the update. A clean count (nothing to
  // apply) still confirms via `authorise()` so the location's durable "last counted" stamp
  // lands — see {@link useLocationCycleCount.authorise}.
  const resultMessage =
    applied === null
      ? null
      : appliedCoverage !== null
        ? // A partial count says so, and says what it did *not* do. Reporting it as "recorded as
          // counted" is the untruth this whole path exists to avoid (issue #637).
          `Partial count recorded — ${appliedCoverage}${applied > 0 ? `, ${applied} ${plural(applied, 'adjustment')} applied` : ''}. This location has not been marked as counted.`
        : applied > 0
          ? `Reconciliation complete — ${applied} ${plural(applied, 'adjustment')} applied to the ledger.`
          : 'No variances found — recorded as counted.';

  // Always callable, even with nothing to apply: a clean count is still a completed audit.
  const authorise = async () => {
    const covered = coverageSummary(coverage);
    const result = await count.authorise();
    setAppliedCoverage(result.coverageComplete ? null : covered);
    setApplied(result.adjustmentsMade);
  };

  // Single return with one stable LiveRegion across ALL view states (form / result / loading).
  // This satisfies the WCAG 4.1.3 / screen-reader contract: the region is always mounted, so
  // when `resultMessage` changes from null → string the SR announces the mutation. If the
  // LiveRegion only appeared inside the result view it would mount together with its content
  // and many SRs would not announce it.
  return (
    <>
      {/*
        Always-mounted polite live region — present in the form view (empty) and in the result
        view (populated). The result message IS the visible feedback, so visuallyHidden is
        omitted; the region renders in place as a styled paragraph. Class and testid are stable
        across transitions so tests can assert the region before and after reconciliation.
      */}
      <LiveRegion className="text-sm text-center" data-testid="cycle-count-result">
        {resultMessage ? <p>{resultMessage}</p> : null}
      </LiveRegion>

      {/*
        Sits outside the `space-y-5` wrapper for the same reason as the region above — its own
        live region is `sr-only`, so inside the stack it would push the primer down by a
        phantom gap on every fresh count. Dropped once the count is applied: the sheet has been
        committed, and the result view says so.
      */}
      <CountDraftNotice restored={applied === null ? restored : null} onDiscard={clearSheet} />

      {/*
        The intro primer and the state below it (loading / empty / counting / result) are stacked
        with a `space-y-5` gap so the bordered primer card never crowds the section beneath it —
        e.g. the "Serialised instances" heading, which otherwise sat flush against the card's
        bottom edge. The LiveRegion stays *outside* this wrapper: it is empty in the form view, so
        including it here would let `space-y` push the primer down by a phantom gap. The intro is
        the wrapper's first child (no top margin), so it stays snug under the dialog header.
      */}
      <div className="space-y-5">
        {/*
          Plain-language explanation of the workflow — shown in every "before you finish"
          state (loading / empty / counting) and dropped once the count is applied so the
          result view stays uncluttered. Cycle counting is unfamiliar to most users, so the
          dialog says what it is and why it's worth doing rather than assuming the term.
        */}
        {applied === null ? <CycleCountIntro /> : null}

        {applied !== null ? (
          // Result view — shown after a successful reconciliation.
          <div className="space-y-4 py-2 text-center">
            <Button onClick={onClose}>Done</Button>
          </div>
        ) : isLoading ? (
          <p className="py-6 text-center text-sm text-muted-foreground">Loading items…</p>
        ) : isEmpty ? (
          <div className="space-y-4 py-2">
            <p className="text-sm text-muted-foreground">No countable items in this location to audit.</p>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={onClose} disabled={pending}>
                Close
              </Button>
              <Button
                onClick={() => void authorise()}
                disabled={pending}
                data-testid="authorise-reconciliation"
              >
                Mark counted
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <CycleCountLines count={count} />

            <CountCoverageNotice coverage={coverage} />

            <div className="flex items-center justify-between pt-1">
              <p className="text-xs text-muted-foreground">
                {/*
                  Coverage first: with nothing typed the adjustment count is 0, which reads
                  exactly like a shelf counted and found perfect. The line above it is what
                  tells the two apart (issue #637). Omitted when there is no discrete sheet to
                  cover, where "0 of 0 lines counted" would be noise.
                */}
                {coverage.total > 0 ? (
                  <span className="block" data-testid="cycle-count-coverage">
                    {coverageSummary(coverage)}
                  </span>
                ) : null}
                {drift.length + missing.length} {plural(drift.length + missing.length, 'adjustment')} to
                authorise
                {missing.length > 0 ? ` (${missing.length} missing)` : ''}
              </p>
              <div className="flex gap-2">
                {/*
                  "Close", not "Cancel": the sheet is saved as it is typed (issue #587), so
                  leaving no longer throws the count away and a button promising to cancel it
                  would now be the lie in the other direction. The tooltip says what is kept,
                  and the notice at the top offers to discard it on the way back in.

                  Held while an authorise is in flight, like the frame's own routes: this calls
                  the host's `onClose` directly, so it would take the dialog down mid-transaction
                  without the guard ever seeing it (issue #654).
                */}
                <Tooltip
                  content="Leave without authorising. The counts entered here are kept, so reopening this location picks them back up."
                  triggerTabIndex={-1}
                >
                  <span>
                    <Button
                      variant="ghost"
                      onClick={onClose}
                      disabled={pending}
                      data-testid="cycle-count-close"
                    >
                      Close
                    </Button>
                  </span>
                </Tooltip>
                <Tooltip
                  content={
                    !coverage.isComplete
                      ? 'Commit the lines you did count and leave the rest alone. The location keeps its old last-counted date, so it stays on the list of places still to check.'
                      : totalToApply > 0
                        ? 'Commit the counted variances: each drifted line writes a Reconciliation Adjustment (new quantity + a `RECONCILED` history entry), and each missing instance is soft-deleted.'
                        : 'Confirm this count. With nothing drifted, this just records the location as counted.'
                  }
                  triggerTabIndex={-1}
                >
                  <span>
                    {/*
                      Three labels for three genuinely different outcomes. "Mark counted" is a
                      claim about the whole location, so a sheet with blank lines must not offer
                      it — it says "partial" instead, and the count in brackets is coverage
                      rather than adjustments (issue #637).
                    */}
                    <Button
                      onClick={() => void authorise()}
                      disabled={pending}
                      data-testid="authorise-reconciliation"
                    >
                      {!coverage.isComplete
                        ? `Record partial count (${coverage.counted}/${coverage.total})`
                        : totalToApply > 0
                          ? `Authorise (${totalToApply})`
                          : 'Mark counted'}
                    </Button>
                  </span>
                </Tooltip>
              </div>
            </div>
          </div>
        )}
      </div>
    </>
  );
}

/**
 * A short, jargon-free primer on cycle counting shown at the top of the dialog.
 * Most users won't know the term, so this explains what the workflow does and why
 * it's worth doing before asking them to count anything.
 */
function CycleCountIntro() {
  return (
    <div className="space-y-2 rounded-lg border border-border bg-muted/30 p-3 text-sm text-muted-foreground">
      <p>
        <span className="font-medium text-foreground">Cycle counting</span> is a spot-check of a single
        location: you physically count what&rsquo;s actually here, and Gubbins compares it against the
        quantities it expects to find.
      </p>
      <p>
        Doing this regularly — a location at a time — catches drift such as miscounts, breakages, or movements
        that were never logged, and corrects it without ever shutting everything down for a full stock-take,
        so your numbers stay trustworthy.
      </p>
    </div>
  );
}
