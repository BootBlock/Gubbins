import { useState } from 'react';
import { Button, InfoHint, Input, Tooltip, INFO_OPEN_DELAY_MS } from '@/components/foundry';
import { CapabilityIcon, CloseIcon } from '@/components/icons';
import { useItemCapabilities, useRemoveCapability, useSetCapability } from '../capabilities';

/**
 * Weighted-capability editor (spec §4). Each capability is a `key = value` spec
 * with an optional relevance weight (default 1). Numeric values are stored as a
 * magnitude so the Visual Builder can compare them (capability:voltage > 3.3);
 * non-numeric values back categorical matches. One value per key — re-adding a key
 * overwrites it.
 */
export function CapabilityEditor({ itemId }: { itemId: string }) {
  const { data: capabilities } = useItemCapabilities(itemId);
  const setCapability = useSetCapability(itemId);
  const removeCapability = useRemoveCapability(itemId);

  const [key, setKey] = useState('');
  const [value, setValue] = useState('');
  const [weight, setWeight] = useState('');

  const add = () => {
    const k = key.trim();
    const v = value.trim();
    if (!k || !v) return;
    const w = weight.trim() === '' ? undefined : Number(weight);
    setCapability.mutate({ key: k, value: v, weight: Number.isFinite(w) ? w : undefined });
    setKey('');
    setValue('');
    setWeight('');
  };

  const display = (cap: { valueNum: number | null; valueText: string | null }) =>
    cap.valueNum !== null ? String(cap.valueNum) : (cap.valueText ?? '');

  return (
    <div className="space-y-2.5">
      <div className="flex flex-wrap gap-1.5">
        {capabilities && capabilities.length > 0 ? (
          capabilities.map((cap) => (
            <Tooltip
              key={cap.key}
              content={`**${cap.key}** = ${display(cap)}\n\nWeight: ${cap.weight}`}
              openDelayMs={INFO_OPEN_DELAY_MS}
            >
              <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/15 px-2.5 py-1 text-xs font-medium text-amber-600 dark:text-amber-400">
                <CapabilityIcon className="size-3" />
                <span className="font-semibold">{cap.key}</span>
                <span className="opacity-70">= {display(cap)}</span>
                {cap.weight !== 1 ? <span className="opacity-50">×{cap.weight}</span> : null}
                <button
                  type="button"
                  aria-label={`Remove capability ${cap.key}`}
                  onClick={() => removeCapability.mutate(cap.key)}
                  className="ml-0.5 rounded-full p-0.5 transition-colors hover:bg-amber-500/25 [&_svg]:size-3"
                >
                  <CloseIcon />
                </button>
              </span>
            </Tooltip>
          ))
        ) : (
          <span className="text-xs text-muted-foreground">No capabilities yet.</span>
        )}
      </div>

      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-field-gap-compact text-xs text-muted-foreground">
          <span className="flex items-center gap-1">
            Key
            <InfoHint
              content={
                'A searchable **spec** of the item as a `key = value` pair — e.g. `voltage = 5`, ' +
                '`material = PLA`.\n\n' +
                'Numeric values are stored as magnitudes so the search builder can compare them ' +
                '(`capability:voltage > 3.3`); text values back **categorical** matches. One value ' +
                'per key — re-adding a key overwrites it.'
              }
            />
          </span>
          <Input
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder="voltage"
            aria-label="Capability key"
            className="h-9 w-28"
          />
        </label>
        <label className="flex flex-col gap-field-gap-compact text-xs text-muted-foreground">
          Value
          <Input
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                add();
              }
            }}
            placeholder="5"
            aria-label="Capability value"
            className="h-9 w-28"
          />
        </label>
        <label className="flex flex-col gap-field-gap-compact text-xs text-muted-foreground">
          <span className="flex items-center gap-1">
            Weight
            <InfoHint
              content={
                'How strongly this capability counts when **ranking best-match** search results. ' +
                'Default `1`; raise it to make a spec dominate the match score, lower it to make it ' +
                'a tie-breaker.'
              }
            />
          </span>
          <Input
            value={weight}
            onChange={(e) => setWeight(e.target.value)}
            placeholder="1"
            inputMode="decimal"
            aria-label="Capability weight"
            className="h-9 w-20"
          />
        </label>
        <Button type="button" variant="outline" onClick={add} className="h-9">
          Add capability
        </Button>
      </div>
    </div>
  );
}
