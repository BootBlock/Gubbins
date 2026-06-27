import { useState } from 'react';
import { Button, Input, Modal, Select } from '@/components/foundry';
import { ASSEMBLY_OUTCOMES, UNASSIGNED_LOCATION_ID, type AssemblyOutcome, type LocationWithCount } from '@/db/repositories';
import { useFinaliseAssembly } from '../projects';
import { ASSEMBLY_OUTCOME_DESCRIPTIONS, ASSEMBLY_OUTCOME_LABELS } from './projects-ui';

/**
 * Finalise a project's assembly into one of the three terminal outcomes (spec §4
 * Composite Items & Assemblies): Container, Singular Object or Permanent Consumption.
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
  const finalise = useFinaliseAssembly(projectId);
  const [outcome, setOutcome] = useState<AssemblyOutcome>('CONTAINER');
  const [resultName, setResultName] = useState('');
  const [resultLocationId, setResultLocationId] = useState(UNASSIGNED_LOCATION_ID);

  const close = () => {
    setOutcome('CONTAINER');
    setResultName('');
    setResultLocationId(UNASSIGNED_LOCATION_ID);
    onClose();
  };

  const namesAResult = outcome === 'CONTAINER' || outcome === 'SINGULAR_OBJECT';

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
    >
      <div className="space-y-4">
        <div className="space-y-2">
          {ASSEMBLY_OUTCOMES.map((value) => (
            <label
              key={value}
              className="flex cursor-pointer items-start gap-3 rounded-xl border border-border p-3 transition-colors hover:bg-secondary/40 has-[:checked]:border-primary has-[:checked]:bg-primary/5"
            >
              <input
                type="radio"
                name="assembly-outcome"
                value={value}
                checked={outcome === value}
                onChange={() => setOutcome(value)}
                className="mt-1 size-4 accent-primary"
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
            <span className="mb-1.5 block text-sm font-medium">
              {outcome === 'CONTAINER' ? 'New location name' : 'New item name'}
            </span>
            <Input
              value={resultName}
              onChange={(e) => setResultName(e.target.value)}
              placeholder={
                outcome === 'CONTAINER' ? projectName : `${projectName} Assembly`
              }
            />
          </label>
        ) : null}

        {outcome === 'SINGULAR_OBJECT' ? (
          <label className="block">
            <span className="mb-1.5 block text-sm font-medium">Place the new item in</span>
            <Select value={resultLocationId} onChange={(e) => setResultLocationId(e.target.value)}>
              {locations.map((loc) => (
                <option key={loc.id} value={loc.id}>
                  {loc.name}
                </option>
              ))}
            </Select>
          </label>
        ) : null}

        <p className="text-xs text-muted-foreground">
          This marks the project as completed and cannot be undone automatically.
        </p>

        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button type="button" onClick={handleFinalise} disabled={finalise.isPending}>
            Finalise
          </Button>
        </div>
      </div>
    </Modal>
  );
}
