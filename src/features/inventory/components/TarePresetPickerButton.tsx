import { Suspense, lazy, useState } from 'react';
import { Button } from '@/components/foundry';
import { ScaleIcon } from '@/components/icons';
import { useT } from '@/features/i18n';

// The picker carries the whole container catalogue and a save form, and most users never
// open it, so it is code-split behind a dynamic import and fetched only on first open.
const TarePresetPicker = lazy(() =>
  import('./TarePresetPicker').then((m) => ({ default: m.TarePresetPicker })),
);

/**
 * The drop-in "pick a container" trigger that sits beside a tare field (issue #94), so a
 * tare is chosen from the library rather than typed from memory. Every tare entry point uses
 * this rather than wiring the dialog itself, which is what keeps the three of them — the
 * gauge editor, the create-item gauge section and the weigh-in dialog — behaving identically.
 *
 * It deals purely in canonical **grams**: the caller converts to whatever unit its field is
 * displayed in, exactly as it already does for a hand-typed value.
 */
export function TarePresetPickerButton({
  onSelect,
  currentTareGrams,
  disabled = false,
  'data-testid': testId,
}: {
  /** Receives the chosen container's tare in canonical grams. */
  onSelect: (tareGrams: number) => void;
  /** The tare currently in the field, in grams, to pre-fill the "save this container" form. */
  currentTareGrams?: number | null;
  disabled?: boolean;
  'data-testid'?: string;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        disabled={disabled}
        onClick={() => setOpen(true)}
        data-testid={testId}
      >
        <ScaleIcon className="size-4" aria-hidden="true" />
        {t('inventory.tarePresets.open')}
      </Button>

      {open ? (
        <Suspense fallback={null}>
          <TarePresetPicker
            open
            onClose={() => setOpen(false)}
            onSelect={onSelect}
            currentTareGrams={currentTareGrams}
          />
        </Suspense>
      ) : null}
    </>
  );
}
