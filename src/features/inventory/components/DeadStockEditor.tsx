import { useEffect, useId, useState } from 'react';
import { Button, InfoHint, SegmentedRadioGroup, useReportUnsavedChanges } from '@/components/foundry';
import type { Item } from '@/db/repositories';
import type { DeadStockMode } from '@/db/repositories/constants';
import { useDeadStockPolicy } from '@/features/reports/queries';
import { DEAD_STOCK_MODE_OPTIONS } from '../dead-stock-options';
import { useUpdateItem } from '../mutations';

/**
 * Per-item **dead-stock reporting** editor (issue #92). Dead stock is stock that has not
 * moved for a long time; flagging it is opt-in, so each item chooses one of:
 *
 * - **Inherit** — follow the location it sits in (the default). Nothing is reported until
 *   some location in the chain opts in, so an untouched inventory stays quiet.
 * - **Report** — always reported, whatever the locations above say.
 * - **Ignore** — never reported, even when its location opts everything in.
 *
 * The note below the picker resolves what the setting actually *means* for this item right
 * now — which location decided it, and the idle threshold in play — because "Inherit" on
 * its own tells the user nothing about whether the item is being watched.
 */
const HINT =
  'Whether this item is flagged on the **Dead stock** report when it sits unused.\n\n' +
  '- **Inherit** — follow the location it’s stored in. If no location above it opts in, ' +
  'it isn’t reported.\n' +
  '- **Report** — always flag it once it’s gone unmoved for the idle threshold, whatever ' +
  'its location says.\n' +
  '- **Ignore** — never flag it, even if its location reports everything stored there.\n\n' +
  'The idle threshold comes from **Settings → Inventory → Stock alerts & lifecycle**, unless a ' +
  'location sets its own.';

/** Plain-language summary of what the item's *resolved* policy currently does. */
function PolicyNote({ item }: { item: Item }) {
  const policy = useDeadStockPolicy(item.id);

  if (policy.isLoading || !policy.data) {
    return <p className="text-xs text-muted-foreground">Checking where this item stands…</p>;
  }

  const { reported, thresholdDays, reportedFrom, thresholdFrom } = policy.data;
  const threshold = thresholdFrom
    ? `${thresholdDays} days (set on ${thresholdFrom.name})`
    : `${thresholdDays} days`;

  if (!reported) {
    return (
      <p className="text-xs text-muted-foreground" data-testid="dead-stock-note">
        Not reported as dead stock. Switch this to <strong>Report</strong>, or turn reporting on for a
        location it sits in.
      </p>
    );
  }

  return (
    <p className="text-xs text-muted-foreground" data-testid="dead-stock-note">
      Reported once it has gone unmoved for {threshold}
      {reportedFrom ? (
        <>
          {' '}
          — inherited from <strong>{reportedFrom.name}</strong>
        </>
      ) : null}
      .
    </p>
  );
}

export function DeadStockEditor({ item }: { item: Item }) {
  const update = useUpdateItem();
  const labelId = useId();
  const [mode, setMode] = useState<DeadStockMode>(item.deadStockMode);

  // Re-sync the draft when the persisted value changes (open, after a save, or sync).
  useEffect(() => {
    setMode(item.deadStockMode);
  }, [item.deadStockMode]);

  const dirty = mode !== item.deadStockMode;
  // Let the dialog frame ask before discarding the draft on a dismissal (issue #576).
  useReportUnsavedChanges(dirty);

  return (
    <div className="space-y-3">
      <div className="space-y-field-gap-compact">
        <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <span id={labelId}>Dead-stock reporting</span>
          <InfoHint content={HINT} />
        </div>
        <SegmentedRadioGroup
          options={DEAD_STOCK_MODE_OPTIONS}
          value={mode}
          onChange={setMode}
          labelledBy={labelId}
          testIdPrefix="dead-stock-mode"
        />
      </div>

      <PolicyNote item={item} />

      <div className="flex justify-end">
        <Button
          size="sm"
          onClick={() => update.mutate({ id: item.id, input: { deadStockMode: mode } })}
          disabled={!dirty || update.isPending}
          data-testid="dead-stock-save"
        >
          {dirty ? 'Save' : 'Saved'}
        </Button>
      </div>
    </div>
  );
}
