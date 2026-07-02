import { cn } from '@/lib/utils';
import { Tooltip } from '@/components/foundry';
import { DataDensityIcon, VisualDensityIcon } from '@/components/icons';
import { useLayoutStore, type LayoutDensity } from '@/state/stores/useLayoutStore';

/**
 * The Data-Heavy ↔ Visual-Heavy density toggle (spec §3 "Adaptive Density").
 * A sliding segmented control with a fluid animated thumb — engaging visual
 * feedback per the Phase 2 brief — backed by the persisted `useLayoutStore`.
 */
const OPTIONS: ReadonlyArray<{
  value: LayoutDensity;
  label: string;
  hint: string;
  icon: typeof DataDensityIcon;
}> = [
  {
    value: 'visual',
    label: 'Visual',
    hint: 'Large image-led cards — best for browsing and scanning by sight.',
    icon: VisualDensityIcon,
  },
  {
    value: 'data',
    label: 'Data',
    hint: 'Dense tabular rows — best for managing many items at once.',
    icon: DataDensityIcon,
  },
];

export function LayoutToggle() {
  const density = useLayoutStore((s) => s.density);
  const setDensity = useLayoutStore((s) => s.setDensity);
  const activeIndex = OPTIONS.findIndex((o) => o.value === density);

  return (
    <div
      role="radiogroup"
      aria-label="Layout density"
      className="relative inline-flex rounded-xl border border-border bg-secondary/40 p-1"
    >
      {/* Sliding thumb */}
      <span
        aria-hidden
        className="absolute inset-y-1 w-[calc(50%-0.25rem)] rounded-lg bg-card-elevated shadow-sm shadow-black/20 ring-1 ring-border transition-transform duration-300 ease-emphasized"
        style={{ transform: `translateX(${activeIndex * 100}%)` }}
      />
      {OPTIONS.map((option) => {
        const Icon = option.icon;
        const active = option.value === density;
        return (
          <Tooltip key={option.value} content={option.hint} triggerTabIndex={-1}>
            <button
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => setDensity(option.value)}
              className={cn(
                'relative z-10 inline-flex w-24 items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors [&_svg]:size-4',
                active ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              <Icon />
              {option.label}
            </button>
          </Tooltip>
        );
      })}
    </div>
  );
}
