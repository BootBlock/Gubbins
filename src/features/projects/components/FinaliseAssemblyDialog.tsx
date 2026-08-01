import { useMemo, useState } from 'react';
import { Button, Input, Modal, Radio, SelectField, Spinner } from '@/components/foundry';
import {
  ASSEMBLY_OUTCOMES,
  UNASSIGNED_LOCATION_ID,
  type AssemblyOutcome,
  type LocationWithCount,
} from '@/db/repositories';
import { useT, type MessageKey } from '@/features/i18n';
import { planAssemblyDraw, type AssemblyDraw } from '../assembly';
import { useAssemblyParts, useFinaliseAssembly } from '../projects';
import { ASSEMBLY_OUTCOME_DESCRIPTIONS, ASSEMBLY_OUTCOME_LABELS } from './projects-ui';

/**
 * Finalise a project's assembly into one of the three terminal outcomes (spec §4
 * Composite Items & Assemblies): Container, Singular Object or Permanent Consumption.
 *
 * Finalising is destructive and not undoable, so the dialog leads with **what it will take**:
 * one line per matched part naming the quantity drawn, out of how much is on hand, and which
 * parts the draw empties (issue #647). The summary is the very plan the write runs on, so it
 * cannot promise something different from what lands; a part short of its requirement blocks the
 * button rather than being discovered afterwards.
 */
export function FinaliseAssemblyDialog({
  open,
  onClose,
  projectId,
  projectName,
  locations,
}: {
  open: boolean;
  onClose: () => void;
  projectId: string;
  projectName: string;
  locations: readonly LocationWithCount[];
}) {
  const t = useT();
  const finalise = useFinaliseAssembly(projectId);
  const [outcome, setOutcome] = useState<AssemblyOutcome>('CONTAINER');
  const [resultName, setResultName] = useState('');
  const [resultLocationId, setResultLocationId] = useState(UNASSIGNED_LOCATION_ID);
  // Only read while the dialog is open: it reflects live stock, which anything else in the app
  // can move, so it is fetched fresh each time rather than held warm and shown stale.
  const preview = useAssemblyParts(projectId, open);
  // Planned here rather than in the repository because the chosen outcome is an input to the plan
  // (a gauge is decanted by a consuming outcome and carried whole into a container), so switching
  // the radio re-plans instantly off the one read — through the very function the write runs.
  const parts = preview.data;
  const plan = useMemo(() => (parts ? planAssemblyDraw(parts, outcome) : undefined), [parts, outcome]);

  const close = () => {
    setOutcome('CONTAINER');
    setResultName('');
    setResultLocationId(UNASSIGNED_LOCATION_ID);
    onClose();
  };

  const namesAResult = outcome === 'CONTAINER' || outcome === 'SINGULAR_OBJECT';
  const shortfalls = plan?.shortfalls ?? [];
  const isShort = shortfalls.length > 0;
  // Held back until the summary has settled, so an un-undoable button is never pressed with
  // nothing yet on screen to read. Then blocked only on a *known* shortfall: a preview that
  // failed to load leaves the button live, since the write re-validates by the same rule — the
  // worst case is the same rejection said a moment later, where refusing outright is a dead end.
  const blocked = preview.isPending || isShort;

  const handleFinalise = () => {
    finalise.mutate(
      {
        outcome,
        ...(namesAResult && resultName.trim() ? { resultName: resultName.trim() } : {}),
        ...(outcome === 'SINGULAR_OBJECT' ? { resultLocationId } : {}),
      },
      { onSuccess: close },
    );
  };

  return (
    <Modal
      open={open}
      onClose={close}
      title="Finalise assembly"
      description={`Assemble the parts of "${projectName}".`}
      busy={finalise.isPending}
    >
      <div className="space-y-4">
        <div className="space-y-2">
          {ASSEMBLY_OUTCOMES.map((value) => (
            // eslint-disable-next-line jsx-a11y/label-has-associated-control -- the nested radio input is correctly associated; the label's text is the dynamic per-outcome content, which the linter cannot resolve to a static string.
            <label
              key={value}
              className="flex cursor-pointer items-start gap-3 rounded-xl border border-border p-3 transition-colors hover:bg-secondary/40 has-[:checked]:border-primary has-[:checked]:bg-primary/5"
            >
              <Radio
                name="assembly-outcome"
                value={value}
                checked={outcome === value}
                onChange={() => setOutcome(value)}
                className="mt-1"
              />
              <span>
                <span className="block text-sm font-medium">{ASSEMBLY_OUTCOME_LABELS[value]}</span>
                <span className="block text-xs text-muted-foreground">
                  {ASSEMBLY_OUTCOME_DESCRIPTIONS[value]}
                </span>
              </span>
            </label>
          ))}
        </div>

        {namesAResult ? (
          <label className="block">
            <span className="mb-field-gap block text-sm font-medium">
              {outcome === 'CONTAINER' ? 'New location name' : 'New item name'}
            </span>
            <Input
              value={resultName}
              onChange={(e) => setResultName(e.target.value)}
              placeholder={outcome === 'CONTAINER' ? projectName : `${projectName} Assembly`}
            />
          </label>
        ) : null}

        {outcome === 'SINGULAR_OBJECT' ? (
          <SelectField
            label="Place the new item in"
            value={resultLocationId}
            onChange={setResultLocationId}
            options={locations.map((loc) => ({ value: loc.id, label: loc.name }))}
          />
        ) : null}

        <section aria-labelledby="finalise-draw-heading">
          <h3 id="finalise-draw-heading" className="mb-field-gap-compact text-sm font-medium">
            {t('projects.finalise.summary.heading')}
          </h3>
          {preview.isPending ? (
            <div className="flex justify-center py-3">
              <Spinner />
            </div>
          ) : preview.isError ? (
            <p className="text-xs text-muted-foreground">{t('projects.finalise.summary.error')}</p>
          ) : plan && plan.draws.length > 0 ? (
            <ul className="divide-y divide-border rounded-xl border border-border">
              {plan.draws.map((draw) => (
                <li key={draw.itemId} className="flex items-baseline justify-between gap-3 px-3 py-2">
                  <span className="min-w-0 flex-1 truncate text-sm">{draw.name}</span>
                  <span
                    className={`shrink-0 text-xs ${
                      draw.shortfallQty > 0 ? 'font-medium text-destructive' : 'text-muted-foreground'
                    }`}
                  >
                    {t(drawMessageKey(draw, outcome), {
                      vars: { qty: draw.takeQty, onHand: draw.onHand, required: draw.requiredQty },
                    })}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-muted-foreground">{t('projects.finalise.summary.none')}</p>
          )}
          {isShort ? (
            <p role="alert" className="mt-field-gap-compact text-xs font-medium text-destructive">
              {t('projects.finalise.summary.blocked', { vars: { count: shortfalls.length } })}
            </p>
          ) : null}
        </section>

        <p className="text-xs text-muted-foreground">
          This marks the project as completed and cannot be undone automatically.
        </p>

        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={close} disabled={finalise.isPending}>
            Cancel
          </Button>
          <Button type="button" onClick={handleFinalise} disabled={finalise.isPending || blocked}>
            {finalise.isPending ? <Spinner /> : null}
            Finalise
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/**
 * The catalog key describing what happens to one part. A shortfall outranks everything (nothing
 * happens at all until it is resolved); otherwise a container *moves* where the two consuming
 * outcomes *take*, and a part the plan resolved to a whole-item draw — a serialised instance, a
 * presence-only item, a gauge vessel going into a container — reads as what it actually does
 * rather than borrowing the counted wording.
 */
function drawMessageKey(draw: AssemblyDraw, outcome: AssemblyOutcome): MessageKey {
  const moving = outcome === 'CONTAINER';
  if (draw.shortfallQty > 0) return 'projects.finalise.part.short';
  if (draw.mode === 'UNLIMITED') return 'projects.finalise.part.unlimited';
  if (draw.mode === 'WHOLE') {
    return moving ? 'projects.finalise.part.moveWhole' : 'projects.finalise.part.takeWhole';
  }
  if (draw.takeQty <= 0) return 'projects.finalise.part.nothing';
  if (draw.takesAll) return moving ? 'projects.finalise.part.moveAll' : 'projects.finalise.part.takeAll';
  return moving ? 'projects.finalise.part.move' : 'projects.finalise.part.take';
}
