import { cn } from '@/lib/utils';
import { useFormatters } from '@/lib/useFormatters';
import type { Fullness } from '../location-fullness';
import { describeVolumetricFullness } from './volumetric-fullness-text';

/**
 * The caption under a volumetric fullness bar: the used-of-capacity volume, plus a muted "based
 * on N of M items measured" note whenever coverage is incomplete — so a half-measured location's
 * bar is never read as exact. Renders nothing for count-mode fullness.
 */
export function LocationFullnessCaption({ fullness, className }: { fullness: Fullness; className?: string }) {
  const fmt = useFormatters();
  const text = describeVolumetricFullness(fullness, fmt);
  if (text === null) return null;
  return (
    <p className={cn('text-xs text-muted-foreground', className)} data-testid="location-fullness-caption">
      {text}
    </p>
  );
}
