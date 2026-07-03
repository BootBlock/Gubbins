/**
 * Dependency-cascade confirmation dialog (modular-ui-plan §2.3, §4).
 *
 * Shared by the Modules manager screen and the "module hidden" route interstitial so both
 * present the same honest "this will also show/hide …" copy from the pure closure maths.
 * The staged {@link PendingCascade} carries the toggled feature, the direction, and the full
 * closure to apply on confirm (computed by `closureToEnable` / `closureToDisable`); this
 * component only renders it and reports the user's choice — it never touches the store.
 */
import { Button, Modal } from '@/components/foundry';
import { getFeature, type FeatureId } from './feature-registry';

/** A pending dependency-cascade the user must confirm before it is applied. */
export interface PendingCascade {
  readonly action: 'enable' | 'disable';
  /** The feature the user toggled. */
  readonly id: FeatureId;
  /** The full closure to apply on confirm (includes `id`). */
  readonly closure: readonly FeatureId[];
}

/** The dependency-cascade confirmation dialog (§4 dependency UX). */
export function ConfirmCascadeModal({
  pending,
  onCancel,
  onConfirm,
}: {
  readonly pending: PendingCascade;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}) {
  const isEnable = pending.action === 'enable';
  const subject = getFeature(pending.id)?.label ?? pending.id;
  const extras = pending.closure.filter((id) => id !== pending.id);

  return (
    <Modal open onClose={onCancel} title={isEnable ? `Show ${subject}?` : `Hide ${subject}?`}>
      <p className="text-sm text-muted-foreground">
        {isEnable
          ? 'This feature needs others that are currently off. Turning it on will also show:'
          : 'Other features depend on this one. Hiding it will also hide:'}
      </p>
      <ul className="mt-3 flex flex-col gap-2">
        {extras.map((id) => {
          const feature = getFeature(id);
          if (!feature) return null;
          return (
            <li key={id} className="flex items-center gap-2 text-sm text-foreground">
              <feature.Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
              {feature.label}
            </li>
          );
        })}
      </ul>
      <p className="mt-4 text-xs text-muted-foreground">
        Your data stays intact — this only changes what’s shown.
      </p>
      <div className="mt-6 flex justify-end gap-2">
        <Button variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button data-testid="confirm-cascade" onClick={onConfirm}>
          {isEnable ? 'Show all' : 'Hide them'}
        </Button>
      </div>
    </Modal>
  );
}
