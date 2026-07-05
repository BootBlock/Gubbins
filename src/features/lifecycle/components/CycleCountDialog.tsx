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
import { useState } from 'react';

import { plural } from '@/lib/plural';
import { Button, LiveRegion, Modal, Tooltip } from '@/components/foundry';
import { CycleCountProvider } from '../CycleCountContext';
import { useLocationCycleCount } from '../useLocationCycleCount';
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
  const { isLoading, isEmpty, drift, missing, totalToApply, pending } = count;
  const [applied, setApplied] = useState<number | null>(null);

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
      : applied > 0
        ? `Reconciliation complete — ${applied} ${plural(applied, 'adjustment')} applied to the ledger.`
        : 'No variances found — recorded as counted.';

  // Always callable, even with nothing to apply: a clean count is still a completed audit.
  const authorise = async () => {
    const result = await count.authorise();
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
            <Button variant="ghost" onClick={onClose}>
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

          <div className="flex items-center justify-between pt-1">
            <p className="text-xs text-muted-foreground">
              {drift.length + missing.length} {plural(drift.length + missing.length, 'adjustment')} to
              authorise
              {missing.length > 0 ? ` (${missing.length} missing)` : ''}
            </p>
            <div className="flex gap-2">
              <Button variant="ghost" onClick={onClose}>
                Cancel
              </Button>
              <Tooltip
                content={
                  totalToApply > 0
                    ? 'Commit the counted variances: each drifted line writes a Reconciliation Adjustment (new quantity + a `RECONCILED` history entry), and each missing instance is soft-deleted.'
                    : 'Confirm this count. With nothing drifted, this just records the location as counted.'
                }
                triggerTabIndex={-1}
              >
                <span>
                  <Button
                    onClick={() => void authorise()}
                    disabled={pending}
                    data-testid="authorise-reconciliation"
                  >
                    {totalToApply > 0 ? `Authorise (${totalToApply})` : 'Mark counted'}
                  </Button>
                </span>
              </Tooltip>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
