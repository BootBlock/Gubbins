/**
 * Guided stock-take / audit-day workflow (spec §4.4). Where {@link CycleCountDialog}
 * counts a *single* location, this walks **many** in turn: pick a scope, then step through
 * each location — count → reconcile (or skip) → advance — with a progress header and a
 * final summary. The walk's cross-location progress is resumable (persisted in the Tier-3
 * {@link useAuditSessionStore}), so a half-done audit survives a reload; the per-location
 * count itself reuses the very same engine as the standalone dialog
 * ({@link useLocationCycleCount} + {@link CycleCountLines}) rather than forking it.
 *
 * All the progress/scope/summary arithmetic lives in the pure, unit-tested
 * `audit-session` seam; this component is only the glue and the accessible presentation.
 */
import { useEffect, useMemo, useRef, useState } from 'react';

import { plural } from '@/lib/plural';
import {
  Button,
  LiveRegion,
  Modal,
  SelectField,
  Spinner,
  Tooltip,
  type SelectOption,
} from '@/components/foundry';
import { CheckIcon, ChevronRightIcon, CycleCountIcon, SuccessIcon, WarningIcon } from '@/components/icons';
import type { LocationTreeNode } from '@/db/repositories';
import { useLocationTree } from '@/features/inventory/queries';
import { CycleCountProvider } from '../CycleCountContext';
import { useLocationCycleCount } from '../useLocationCycleCount';
import { CycleCountLines } from './CycleCountLines';
import { useAuditSessionStore } from '../useAuditSessionStore';
import {
  buildScope,
  progress,
  summarise,
  type AuditLocationStatus,
  type AuditScopeLocation,
  type AuditScopeMode,
  type AuditTotals,
} from '../audit-session';
import type { AuthoriseResult } from '../useLocationCycleCount';

/** A walkable location plus its tree depth, for indented pickers. */
interface WalkableLocation extends AuditScopeLocation {
  readonly depth: number;
}

/** Flatten the tree to its walkable locations (pre-order) carrying depth, for the pickers. */
function walkableWithDepth(tree: readonly LocationTreeNode[]): WalkableLocation[] {
  const out: WalkableLocation[] = [];
  const walk = (nodes: readonly LocationTreeNode[], depth: number) => {
    for (const node of nodes) {
      if (node.archivedAt) continue;
      if (!node.isSystem) out.push({ id: node.id, name: node.name, depth });
      walk(node.children, depth + 1);
    }
  };
  walk(tree, 0);
  return out;
}

export function AuditDayDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const session = useAuditSessionStore((s) => s.session);
  const resume = useAuditSessionStore((s) => s.resume);
  const abandon = useAuditSessionStore((s) => s.abandon);

  // On (re)open, land an in-progress walk on the first location still needing work so a
  // resumed audit picks up where it left off rather than wherever the index was persisted.
  useEffect(() => {
    if (open) resume();
  }, [open, resume]);

  const prog = session ? progress(session) : null;
  const stage: 'scope' | 'stepper' | 'summary' = !session
    ? 'scope'
    : prog!.isComplete
      ? 'summary'
      : 'stepper';

  const title =
    stage === 'summary'
      ? 'Stock-take complete'
      : stage === 'stepper'
        ? 'Stock-take in progress'
        : 'Start a stock-take';
  const description =
    stage === 'scope'
      ? 'Walk a set of locations in turn, counting and reconciling each. Your progress is saved, so you can pause and resume.'
      : undefined;

  return (
    <Modal open={open} onClose={onClose} title={title} description={description} className="max-w-xl">
      {stage === 'scope' ? (
        <ScopePicker onClose={onClose} />
      ) : stage === 'summary' ? (
        <AuditSummaryView
          onDone={() => {
            abandon();
            onClose();
          }}
        />
      ) : (
        <AuditStepper onClose={onClose} onAbandon={abandon} />
      )}
    </Modal>
  );
}

// --- Scope picker ---------------------------------------------------------------

function ScopePicker({ onClose }: { onClose: () => void }) {
  const tree = useLocationTree();
  const start = useAuditSessionStore((s) => s.start);

  const [mode, setMode] = useState<AuditScopeMode>('all');
  const [anchorId, setAnchorId] = useState<string>('');
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set());

  // Memoised so `nodes` keeps a stable identity across renders (the `?? []` fallback would
  // otherwise be a fresh array each time, churning the downstream memos).
  const nodes = useMemo(() => tree.data ?? [], [tree.data]);
  const walkable = useMemo(() => walkableWithDepth(nodes), [nodes]);

  // Default the sub-tree anchor to the first walkable location once loaded.
  useEffect(() => {
    if (mode === 'subtree' && !anchorId && walkable.length > 0) setAnchorId(walkable[0]!.id);
  }, [mode, anchorId, walkable]);

  const scope = useMemo(
    () => buildScope(nodes, mode, { anchorId, selectedIds }),
    [nodes, mode, anchorId, selectedIds],
  );

  const modeOptions: SelectOption[] = [
    { value: 'all', label: 'All locations', meta: `${walkable.length}` },
    { value: 'subtree', label: 'A location and everything inside it' },
    { value: 'selected', label: 'Choose specific locations' },
  ];
  const anchorOptions: SelectOption[] = walkable.map((l) => ({
    value: l.id,
    // Indent by depth so the hierarchy reads in the flat listbox.
    label: `${' '.repeat(l.depth)}${l.name}`,
  }));

  const toggleSelected = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  if (tree.isLoading) {
    return (
      <div className="flex justify-center py-8">
        <Spinner />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <SelectField
        label="What should this stock-take cover?"
        value={mode}
        onChange={(v) => setMode(v as AuditScopeMode)}
        options={modeOptions}
        data-testid="audit-scope-mode"
      />

      {mode === 'subtree' ? (
        <SelectField
          label="Starting location"
          value={anchorId}
          onChange={setAnchorId}
          options={anchorOptions}
          placeholder="Choose a location…"
          data-testid="audit-anchor"
        />
      ) : null}

      {mode === 'selected' ? (
        <fieldset className="space-y-field-gap-compact">
          <legend className="mb-field-gap text-sm font-medium">Locations to walk</legend>
          <div className="max-h-56 space-y-0.5 overflow-y-auto rounded-lg border border-border p-2">
            {walkable.length === 0 ? (
              <p className="p-2 text-sm text-muted-foreground">No walkable locations.</p>
            ) : (
              walkable.map((l) => (
                <label
                  key={l.id}
                  className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-sm hover:bg-secondary/40"
                  style={{ paddingLeft: `${0.5 + l.depth * 1}rem` }}
                >
                  <input
                    type="checkbox"
                    className="size-4 accent-primary"
                    checked={selectedIds.has(l.id)}
                    onChange={() => toggleSelected(l.id)}
                    data-testid={`audit-pick-${l.id}`}
                  />
                  {l.name}
                </label>
              ))
            )}
          </div>
        </fieldset>
      ) : null}

      <div className="flex items-center justify-between pt-1">
        <p className="text-sm text-muted-foreground" data-testid="audit-scope-count">
          {scope.length > 0
            ? `${scope.length} ${plural(scope.length, 'location')} to walk`
            : 'No locations selected'}
        </p>
        <div className="flex gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => start(scope)} disabled={scope.length === 0} data-testid="audit-start">
            <CycleCountIcon />
            Start stock-take
          </Button>
        </div>
      </div>
    </div>
  );
}

// --- Stepper (progress header + current-location panel) -------------------------

function AuditProgressBar({ done, total }: { done: number; total: number }) {
  const pct = total === 0 ? 0 : Math.round((done / total) * 100);
  return (
    <div
      className="h-2 w-full overflow-hidden rounded-full bg-secondary"
      role="progressbar"
      aria-valuenow={done}
      aria-valuemin={0}
      aria-valuemax={total}
      aria-label={`${done} of ${total} locations done`}
    >
      <div
        className="h-full rounded-full bg-primary transition-all duration-500 ease-emphasized"
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

function AuditStepper({ onClose, onAbandon }: { onClose: () => void; onAbandon: () => void }) {
  const session = useAuditSessionStore((s) => s.session)!;
  const recordCurrent = useAuditSessionStore((s) => s.recordCurrent);
  const skipCurrent = useAuditSessionStore((s) => s.skipCurrent);

  const prog = progress(session);
  const tally = summarise(session);
  const current = prog.current!;

  // Announce each step change and reconciliation outcome (WCAG 4.1.3). Seeded with the
  // current step so a screen reader hears where the walk is on open/resume.
  const [announcement, setAnnouncement] = useState('');
  const stepMessage = `Now counting ${current.name}. Location ${prog.position} of ${prog.total}.`;
  // Re-announce the step whenever the current location changes.
  const lastAnnouncedId = useRef<string | null>(null);
  useEffect(() => {
    if (lastAnnouncedId.current !== current.id) {
      lastAnnouncedId.current = current.id;
      setAnnouncement(stepMessage);
    }
  }, [current.id, stepMessage]);

  const finish = (status: AuditLocationStatus, totals: AuditTotals, outcomeMessage: string) => {
    setAnnouncement(outcomeMessage);
    recordCurrent(status, totals);
  };

  const skip = () => {
    setAnnouncement(`Skipped ${current.name}.`);
    skipCurrent();
  };

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <div className="flex items-baseline justify-between gap-3">
          <p className="text-sm font-medium" data-testid="audit-step-heading">
            <span className="text-muted-foreground">
              Location {prog.position} of {prog.total} —{' '}
            </span>
            {current.name}
          </p>
          <p className="shrink-0 text-xs text-muted-foreground" data-testid="audit-variance-tally">
            {tally.locationsWithVariances > 0
              ? `${tally.locationsWithVariances} with ${plural(tally.locationsWithVariances, 'variance')}`
              : 'No variances yet'}
          </p>
        </div>
        <AuditProgressBar done={prog.done} total={prog.total} />
      </div>

      {/* Each location gets a fresh provider (keyed by id) so its blind count starts empty. */}
      <CycleCountProvider key={current.id}>
        <AuditLocationPanel location={current} onFinish={finish} onSkip={skip} />
      </CycleCountProvider>

      <div className="flex items-center justify-between border-t border-border pt-3">
        <Tooltip
          content="Abandon the whole stock-take and discard its progress. Already-authorised reconciliations stay applied."
          triggerTabIndex={-1}
        >
          <span>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                onAbandon();
                onClose();
              }}
              data-testid="audit-abandon"
            >
              Abandon
            </Button>
          </span>
        </Tooltip>
        <Button variant="ghost" size="sm" onClick={onClose} data-testid="audit-pause">
          Pause &amp; close
        </Button>
      </div>

      {/* Polite live region announcing step changes and reconciliation outcomes. */}
      <LiveRegion visuallyHidden data-testid="audit-live-region">
        {announcement ? <p>{announcement}</p> : null}
      </LiveRegion>
    </div>
  );
}

function AuditLocationPanel({
  location,
  onFinish,
  onSkip,
}: {
  location: AuditScopeLocation;
  onFinish: (status: AuditLocationStatus, totals: AuditTotals, message: string) => void;
  onSkip: () => void;
}) {
  const count = useLocationCycleCount(location);
  const { isLoading, isEmpty, missing, totalToApply, pending } = count;

  const authoriseAndContinue = async () => {
    const result: AuthoriseResult = await count.authorise();
    onFinish(
      'reconciled',
      result,
      `Reconciled ${result.adjustmentsMade} ${plural(result.adjustmentsMade, 'adjustment')} at ${location.name}. Moving on.`,
    );
  };

  const markCountedAndContinue = () => {
    onFinish('counted', { variancesFound: 0, adjustmentsMade: 0 }, `Counted ${location.name}. Moving on.`);
  };

  if (isLoading) {
    return <p className="py-6 text-center text-sm text-muted-foreground">Loading items…</p>;
  }

  if (isEmpty) {
    return (
      <div className="space-y-4 py-2">
        <p className="text-sm text-muted-foreground">Nothing to count in this location.</p>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onSkip} data-testid="audit-skip">
            Skip
          </Button>
          <Button onClick={markCountedAndContinue} data-testid="audit-continue">
            <ChevronRightIcon />
            Continue
          </Button>
        </div>
      </div>
    );
  }

  const hasVariances = totalToApply > 0;

  return (
    <div className="space-y-4">
      <CycleCountLines count={count} />

      <div className="flex items-center justify-between pt-1">
        <p className="text-xs text-muted-foreground">
          {totalToApply} {plural(totalToApply, 'adjustment')} to authorise
          {missing.length > 0 ? ` (${missing.length} missing)` : ''}
        </p>
        <div className="flex gap-2">
          <Button variant="ghost" onClick={onSkip} data-testid="audit-skip">
            Skip
          </Button>
          {hasVariances ? (
            <Tooltip
              content="Authorise this location's variances (writing the reconciliation adjustments), then move to the next location."
              triggerTabIndex={-1}
            >
              <span>
                <Button
                  onClick={() => void authoriseAndContinue()}
                  disabled={pending}
                  data-testid="audit-authorise-continue"
                >
                  <CheckIcon />
                  Authorise &amp; continue ({totalToApply})
                </Button>
              </span>
            </Tooltip>
          ) : (
            <Button onClick={markCountedAndContinue} data-testid="audit-continue">
              <ChevronRightIcon />
              Mark counted &amp; continue
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

// --- Summary --------------------------------------------------------------------

function StatTile({ label, value, tone }: { label: string; value: number; tone?: 'warning' | 'success' }) {
  return (
    <div className="rounded-lg bg-secondary/30 px-3 py-3 text-center">
      <p
        className={
          tone === 'warning'
            ? 'text-2xl font-semibold text-warning'
            : tone === 'success'
              ? 'text-2xl font-semibold text-success'
              : 'text-2xl font-semibold'
        }
        data-testid={`audit-stat-${label.toLowerCase().replace(/\s+/g, '-')}`}
      >
        {value}
      </p>
      <p className="text-xs text-muted-foreground">{label}</p>
    </div>
  );
}

function AuditSummaryView({ onDone }: { onDone: () => void }) {
  const session = useAuditSessionStore((s) => s.session)!;
  const summary = summarise(session);

  return (
    <div className="space-y-5" data-testid="audit-summary">
      <div className="flex flex-col items-center gap-2 py-2 text-center">
        <SuccessIcon className="size-10 text-success" aria-hidden />
        <p className="text-sm text-muted-foreground">
          Walked {session.scope.length} {plural(session.scope.length, 'location')}.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <StatTile label="Audited" value={summary.locationsAudited} />
        <StatTile label="Variances" value={summary.totalVariancesFound} tone="warning" />
        <StatTile label="Adjustments" value={summary.totalAdjustmentsMade} tone="success" />
        <StatTile label="Skipped" value={summary.locationsSkipped} />
      </div>

      {summary.withVariances.length > 0 ? (
        <div className="space-y-1.5">
          <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            <WarningIcon className="size-3.5 text-warning" aria-hidden />
            Locations with variances
          </p>
          <ul className="space-y-0.5 text-sm" data-testid="audit-summary-variances">
            {summary.withVariances.map((l) => (
              <li key={l.id} className="rounded bg-secondary/30 px-3 py-1.5">
                {l.name}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {summary.skipped.length > 0 ? (
        <div className="space-y-1.5">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Skipped</p>
          <ul className="space-y-0.5 text-sm" data-testid="audit-summary-skipped">
            {summary.skipped.map((l) => (
              <li key={l.id} className="rounded bg-secondary/30 px-3 py-1.5 text-muted-foreground">
                {l.name}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="flex justify-end">
        <Button onClick={onDone} data-testid="audit-done">
          Done
        </Button>
      </div>
    </div>
  );
}
