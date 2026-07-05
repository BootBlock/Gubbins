import { cn } from '@/lib/utils';
import type { Fullness } from '../location-fullness';

/**
 * The capacity fill bar shared by the Edit-location dialog's metadata block and the
 * inventory {@link LocationInfoCard}. A slim track with a primary (or destructive, when
 * over capacity) fill, trailed by the rounded percentage. All colours are tokens so the
 * bar is dark-mode-correct and themable in one place.
 */
export function LocationFullnessBar({ fullness, className }: { fullness: Fullness; className?: string }) {
  return (
    <div className={cn('flex items-center gap-2', className)}>
      <div className="h-2 flex-1 overflow-hidden rounded-full bg-secondary">
        <div
          className={fullness.over ? 'h-full rounded-full bg-destructive' : 'h-full rounded-full bg-primary'}
          style={{ width: `${fullness.percent}%` }}
        />
      </div>
      <span className="tabular-nums text-xs text-muted-foreground">{fullness.percent}%</span>
    </div>
  );
}
