import { Link } from '@tanstack/react-router';
import { SuccessIcon, WarningIcon } from '@/components/icons';
import type { Formatters } from '@/lib/format';
import { requestHighlight } from '@/lib/highlight';
import { useInventoryEntry } from '@/features/inventory/useInventoryEntry';
import type { HygieneReport, HygieneSample, HygieneSection } from '../data-hygiene';

/**
 * The §3 data-hygiene checklist (Phase 77): one row per quality check. A passing check (count 0)
 * reads as a green tick with a plain-English "healthy state" line (so "Possible duplicates" beside
 * a tick no longer reads as a contradiction); a failing one is an expandable `<details>` revealing a
 * sample of the offending items, each a jump-to-fix link that opens the item's detail card in the
 * inventory directly. Design tokens only.
 */
/**
 * Hand the Inventory screen the intent to open this item's detail card, seed its search with the
 * item name (so the item is in the list behind the dialog once closed) and flag it for the
 * call-to-attention flash. Runs as the `<Link to="/inventory">` navigates, mirroring the command
 * palette / scanner jump-to-item path.
 */
function openInInventory(sample: HygieneSample): void {
  const entry = useInventoryEntry.getState();
  entry.requestSearch(sample.name);
  entry.requestOpenItem(sample.id);
  requestHighlight(sample.id);
}

export function HygieneChecklist({ report, formatters }: { report: HygieneReport; formatters: Formatters }) {
  return (
    <div className="flex flex-col divide-y divide-border" data-testid="hygiene-checklist">
      {report.sections.map((section) => (
        <HygieneRow key={section.kind} section={section} formatters={formatters} />
      ))}
    </div>
  );
}

function HygieneRow({ section, formatters }: { section: HygieneSection; formatters: Formatters }) {
  const clean = section.count === 0;

  if (clean) {
    return (
      <div className="flex items-center gap-3 py-2.5 text-sm" data-testid={`hygiene-row-${section.kind}`}>
        <SuccessIcon className="size-4 shrink-0 text-success" aria-hidden />
        <span className="font-medium">{section.label}</span>
        <span className="text-muted-foreground">{section.passDescription}</span>
        <span className="ml-auto text-xs font-medium text-success">All good</span>
      </div>
    );
  }

  return (
    <details className="group py-1" data-testid={`hygiene-row-${section.kind}`}>
      <summary className="flex cursor-pointer list-none items-center gap-3 py-1.5 text-sm">
        <WarningIcon className="size-4 shrink-0 text-warning" aria-hidden />
        <span className="font-medium">{section.label}</span>
        <span className="hidden text-muted-foreground sm:inline">{section.description}</span>
        <span className="ml-auto rounded-full bg-warning/10 px-2 py-0.5 text-xs font-medium text-warning-foreground tabular-nums">
          {formatters.quantity(section.count)}
        </span>
      </summary>
      <ul className="ml-7 flex flex-col gap-1 pb-2 pt-1" data-testid={`hygiene-samples-${section.kind}`}>
        {section.samples.map((sample) => (
          <li key={sample.id} className="flex flex-wrap items-baseline gap-x-2 text-xs">
            <Link
              to="/inventory"
              onClick={() => openInInventory(sample)}
              className="font-medium text-primary underline-offset-2 hover:underline"
            >
              {sample.name}
            </Link>
            {sample.detail ? <span className="text-muted-foreground">{sample.detail}</span> : null}
          </li>
        ))}
        {section.count > section.samples.length ? (
          <li className="text-xs italic text-muted-foreground">
            …and {formatters.quantity(section.count - section.samples.length)} more.
          </li>
        ) : null}
      </ul>
    </details>
  );
}
