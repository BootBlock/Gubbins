/**
 * Item-detail facet for Kits (v1 definition + availability, v2 assemble/disassemble, v3
 * nested-kit roll-up / cascade / multi-location). A kit is an item composed of fixed per-kit
 * quantities of *other* items (a first-aid kit = 2 bandages + 1 scissors + 5 plasters). This
 * editor defines that composition — list, add, re-quantify and remove component lines — surfaces
 * how many whole kits the current stock can build (the pure `buildableCount`, plus the nested
 * **roll-up** where a component is itself a kit), and drives the stock-moving build:
 *
 *   - **Assemble / disassemble** move stock atomically through the ledger. Assembly is capped by
 *     the buildable count (or, with "assemble sub-kits as needed" on, the roll-up count); the
 *     produced kit lands at a chosen destination location (default: the kit's home).
 *   - A component may itself be a kit; when so, an "includes N buildable sub-kits" line and the
 *     opt-in cascade toggle appear.
 *
 * Distinct from variants (child SKUs of one identity) and a project BOM (transient work): a kit is
 * a reusable many-to-many item→component relationship.
 */
import { useMemo, useState } from 'react';
import { Button, Checkbox, InfoHint, Input, SelectField, useToast } from '@/components/foundry';
import { AddIcon, AssemblyIcon, DeleteIcon } from '@/components/icons';
import type { Item, KitComponent } from '@/db/repositories';
import { buildableCount } from '@/features/inventory/kit-availability';
import { useInventoryItems, useLocations } from '@/features/inventory/queries';
import { plural } from '@/lib/plural';
import { useErrorMessage } from '@/features/errors';
import {
  useAddKitComponent,
  useAssembleKit,
  useDisassembleKit,
  useItemKit,
  useKitAvailability,
  useRemoveKitComponent,
  useUpdateKitComponentQty,
} from '../hooks';

export function KitEditor({ item }: { item: Item }) {
  const { data: components } = useItemKit(item.id);
  const addComponent = useAddKitComponent();
  const [componentId, setComponentId] = useState('');
  const [qty, setQty] = useState('1');
  const [error, setError] = useState<string | null>(null);
  const describeError = useErrorMessage();

  // Candidate components: active items other than this kit and the ones already added. The
  // repository rejects deeper cycles/self-containment too; excluding these here keeps the
  // common case out of the picker. A modest page is loaded — a fuller search picker is a
  // later refinement, matching the project BOM's item Select.
  const { data: itemsPage } = useInventoryItems({}, 100);
  const alreadyAdded = useMemo(() => new Set((components ?? []).map((c) => c.componentItemId)), [components]);
  const candidates = useMemo(
    () =>
      (itemsPage?.pages.flatMap((p) => p.rows) ?? []).filter(
        (i) => i.id !== item.id && !alreadyAdded.has(i.id),
      ),
    [itemsPage, item.id, alreadyAdded],
  );

  const rows = components ?? [];
  const { count, limiting } = buildableCount(rows);

  // Nested-kit roll-up (Kits v3): how many kits are buildable once sub-kits are assembled on
  // demand, and the deepest limiting leaves. Only surfaced when the kit actually nests.
  const { data: rollUp } = useKitAvailability(item.id);
  const nests = (rollUp?.subKitCount ?? 0) > 0;

  // Assemble / disassemble (Kits v2/v3): one count drives both actions. Assembly is bounded by the
  // buildable count — or, with cascade on, the roll-up count; disassembly by the kit's on-hand
  // quantity. The produced kit can land at a chosen destination location.
  const assemble = useAssembleKit();
  const disassemble = useDisassembleKit();
  const toast = useToast();
  const { data: locationsPage } = useLocations();
  const locations = locationsPage?.rows ?? [];
  const [buildQty, setBuildQty] = useState('1');
  const [cascade, setCascade] = useState(false);
  const [destinationId, setDestinationId] = useState('');
  const buildN = Math.max(0, Math.floor(Number(buildQty) || 0));
  const busy = assemble.isPending || disassemble.isPending;
  const assembleCeiling = cascade && nests && rollUp ? rollUp.count : count;
  const canAssemble = buildN >= 1 && buildN <= assembleCeiling && !busy;
  const canDisassemble = buildN >= 1 && buildN <= item.quantity && !busy;

  const buildCallbacks = (verb: 'Assembled' | 'Disassembled', fallback: string) => ({
    onSuccess: () => {
      toast.show({ tone: 'success' as const, message: `${verb} ${buildN} ${plural(buildN, 'kit')}.` });
      setBuildQty('1');
    },
    // Through the error-copy seam, exactly as the add-component handler below: a build most often
    // fails on stock or storage, and "Storage is full (Hard Stop)" says nothing a user can act on.
    onError: (e: unknown) => toast.show({ tone: 'danger' as const, message: describeError(e, fallback) }),
  });

  const add = () => {
    if (componentId === '') return;
    setError(null);
    addComponent.mutate(
      { kitId: item.id, componentItemId: componentId, quantity: Math.max(1, Math.floor(Number(qty) || 1)) },
      {
        onSuccess: () => {
          setComponentId('');
          setQty('1');
        },
        onError: (e) => setError(describeError(e, 'Could not add the component.')),
      },
    );
  };

  return (
    <div className="space-y-4">
      {/* The headline availability — how many whole kits the current stock can build. */}
      <div
        className="flex items-center gap-2.5 rounded-xl border border-border bg-secondary/30 px-4 py-3 [&_svg]:size-5"
        data-testid="kit-buildable"
      >
        <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
          <AssemblyIcon />
        </span>
        <div>
          {rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Add components below to see how many kits you can build.
            </p>
          ) : (
            <>
              <p className="text-sm font-semibold">
                You can build <span data-testid="kit-buildable-count">{count}</span> {plural(count, 'kit')}
              </p>
              {count === 0 && limiting.length > 0 ? (
                <p className="text-xs text-muted-foreground" data-testid="kit-limiting">
                  Short on {limiting.map((c) => c.name).join(', ')}.
                </p>
              ) : limiting.length > 0 && limiting.length < rows.length ? (
                <p className="text-xs text-muted-foreground" data-testid="kit-limiting">
                  Limited by {limiting.map((c) => c.name).join(', ')}.
                </p>
              ) : null}
              {/* Roll-up: sub-kits built on demand can raise the ceiling beyond the on-hand count. */}
              {nests && rollUp ? (
                <p className="mt-0.5 text-xs text-muted-foreground" data-testid="kit-rollup">
                  Up to <span className="font-medium text-foreground">{rollUp.count}</span> with sub-kits
                  assembled on demand — includes {rollUp.subKitCount} buildable{' '}
                  {plural(rollUp.subKitCount, 'sub-kit')}
                  {rollUp.count > 0 && rollUp.limiting.length > 0
                    ? ` (deepest constraint: ${rollUp.limiting.map((l) => l.name).join(', ')})`
                    : ''}
                  .
                </p>
              ) : null}
            </>
          )}
        </div>
      </div>

      {rows.length > 0 ? (
        <ul className="space-y-1.5" data-testid="kit-list">
          {rows.map((c) => (
            <KitComponentRow key={c.id} kitId={item.id} component={c} />
          ))}
        </ul>
      ) : null}

      {/* Assemble / disassemble the kit (Kits v2/v3) — moves stock atomically through the ledger. */}
      {rows.length > 0 ? (
        <div className="rounded-xl border border-border p-3" data-testid="kit-assemble">
          <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground [&_svg]:size-3.5">
            <AssemblyIcon />
            Assemble / disassemble
            <InfoHint
              content={
                'Build whole kits from stock (consuming each component) or break them back ' +
                'down (returning components to stock). Assembly is capped by how many you can ' +
                'build; disassembly by how many kits you have on hand. Components are drawn from ' +
                'every location they sit in, soonest-expiry first.'
              }
            />
          </p>
          <div className="flex flex-wrap items-end gap-2">
            <label className="w-24">
              <span className="mb-field-gap-compact block text-xs text-muted-foreground">Number of kits</span>
              <Input
                type="number"
                min={1}
                step={1}
                value={buildQty}
                onChange={(e) => setBuildQty(e.target.value)}
                data-testid="kit-build-qty"
              />
            </label>
            <div className="w-44">
              <SelectField
                label="Destination"
                value={destinationId}
                onChange={setDestinationId}
                options={[
                  { value: '', label: 'Kit’s home location' },
                  ...locations.map((l) => ({ value: l.id, label: l.name })),
                ]}
                data-testid="kit-destination"
              />
            </div>
            <Button
              onClick={() =>
                assemble.mutate(
                  {
                    kitId: item.id,
                    count: buildN,
                    destinationLocationId: destinationId || undefined,
                    cascade: cascade && nests ? true : undefined,
                  },
                  buildCallbacks('Assembled', 'Could not assemble the kit.'),
                )
              }
              disabled={!canAssemble}
              data-testid="assemble-kit"
            >
              <AssemblyIcon />
              Assemble
            </Button>
            <Button
              variant="outline"
              onClick={() =>
                disassemble.mutate(
                  { kitId: item.id, count: buildN },
                  buildCallbacks('Disassembled', 'Could not disassemble the kit.'),
                )
              }
              disabled={!canDisassemble}
              data-testid="disassemble-kit"
            >
              Disassemble
            </Button>
          </div>
          {nests ? (
            <label
              className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground"
              data-testid="kit-cascade-toggle"
            >
              <Checkbox checked={cascade} onChange={(e) => setCascade(e.target.checked)} />
              Assemble sub-kits as needed
              <InfoHint
                content={
                  'When on, assembling this kit also assembles any sub-kit you are short of — ' +
                  'consuming their components down the chain, all in one transaction.'
                }
              />
            </label>
          ) : null}
          <p className="mt-1.5 text-xs text-muted-foreground" data-testid="kit-build-bounds">
            Up to {assembleCeiling} buildable · {item.quantity} on hand
          </p>
        </div>
      ) : null}

      <div className="rounded-xl border border-border p-3">
        <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground [&_svg]:size-3.5">
          <AddIcon />
          Add a component
          <InfoHint
            content={
              'Pick an item and set how many of it **one** kit needs. The buildable count above is ' +
              'the minimum, across every component, of how many kits its on-hand stock can cover. ' +
              'A consumable-gauge component contributes a per-kit net-value draw.\n\n' +
              'A kit cannot contain itself (directly or transitively) — circular references are rejected.'
            }
          />
        </p>
        <div className="flex items-end gap-2">
          <div className="flex-1">
            <SelectField
              label="Component item"
              value={componentId}
              onChange={setComponentId}
              options={[
                { value: '', label: '— Choose an item —' },
                ...candidates.map((i) => ({ value: i.id, label: i.name })),
              ]}
              data-testid="kit-component-picker"
            />
          </div>
          <label className="w-20">
            <span className="mb-field-gap-compact block text-xs text-muted-foreground">Qty / kit</span>
            <Input
              type="number"
              min={1}
              step={1}
              value={qty}
              onChange={(e) => setQty(e.target.value)}
              data-testid="kit-qty"
            />
          </label>
          <Button
            onClick={add}
            disabled={addComponent.isPending || componentId === ''}
            data-testid="add-kit-component"
          >
            <AddIcon />
            Add
          </Button>
        </div>
        {error ? (
          <p role="alert" className="mt-1.5 text-xs text-destructive">
            {error}
          </p>
        ) : null}
      </div>
    </div>
  );
}

/**
 * One component line: the component name, its on-hand supply (a gauge shows its net value), an
 * inline per-kit quantity (committed on blur when changed) and a remove button.
 */
function KitComponentRow({ kitId, component }: { kitId: string; component: KitComponent }) {
  const updateQty = useUpdateKitComponentQty();
  const removeComponent = useRemoveKitComponent();
  const [qty, setQty] = useState(String(component.quantity));
  const isGauge = component.trackingMode === 'CONSUMABLE_GAUGE';

  const commit = () => {
    const next = Math.max(1, Math.floor(Number(qty) || 1));
    if (next === component.quantity) {
      setQty(String(component.quantity));
      return;
    }
    updateQty.mutate({ id: component.id, kitId, quantity: next });
  };

  return (
    <li
      className="flex items-center gap-2 rounded-lg bg-secondary/30 px-2.5 py-1.5 text-sm"
      data-testid="kit-component"
    >
      <span className="flex-1 truncate font-medium">{component.name}</span>
      <span className="text-xs text-muted-foreground">
        {component.stock} {isGauge ? 'remaining' : 'in stock'}
      </span>
      <label className="flex items-center gap-1">
        <span className="text-xs text-muted-foreground">×</span>
        <Input
          type="number"
          min={1}
          step={1}
          value={qty}
          onChange={(e) => setQty(e.target.value)}
          onBlur={commit}
          className="w-16"
          aria-label={`Quantity of ${component.name} per kit`}
          data-testid="kit-component-qty"
        />
      </label>
      <Button
        size="sm"
        variant="ghost"
        onClick={() => removeComponent.mutate({ id: component.id, kitId })}
        disabled={removeComponent.isPending}
        aria-label={`Remove ${component.name}`}
        data-testid="remove-kit-component"
      >
        <DeleteIcon />
      </Button>
    </li>
  );
}
