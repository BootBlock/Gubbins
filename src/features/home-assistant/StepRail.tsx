import { cn } from '@/lib/utils';
import { CheckIcon } from '@/components/icons';
import { GUIDE_STEPS, indexOfStep, type GuideStepId } from './guide';

/**
 * The step progress rail — a horizontal, jump-anywhere list of the guide's steps with the
 * current one highlighted and earlier ones marked done. It's a reference guide, not a locked
 * wizard, so every step is reachable at any time (the user may have done some already). A slim
 * progress bar underneath gives an at-a-glance sense of position.
 */
export function StepRail({
  currentId,
  onSelect,
}: {
  readonly currentId: GuideStepId;
  readonly onSelect: (id: GuideStepId) => void;
}) {
  const currentIndex = indexOfStep(currentId);
  const percent = Math.round(((currentIndex + 1) / GUIDE_STEPS.length) * 100);

  return (
    <nav aria-label="Setup steps" className="space-y-3">
      <ol className="flex gap-2 overflow-x-auto pb-1">
        {GUIDE_STEPS.map((step, index) => {
          const isCurrent = step.id === currentId;
          const isDone = index < currentIndex;
          return (
            <li key={step.id} className="min-w-0">
              <button
                type="button"
                onClick={() => onSelect(step.id)}
                aria-current={isCurrent ? 'step' : undefined}
                className={cn(
                  'flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-xs outline-none transition-colors ease-emphasized',
                  'focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
                  isCurrent
                    ? 'border-primary bg-primary/10 text-foreground'
                    : isDone
                      ? 'border-border bg-card/40 text-muted-foreground hover:bg-secondary/60'
                      : 'border-border/70 bg-transparent text-muted-foreground hover:bg-secondary/50',
                )}
              >
                <span
                  className={cn(
                    'grid size-5 shrink-0 place-items-center rounded-full text-[0.65rem] font-semibold [&_svg]:size-3',
                    isCurrent
                      ? 'bg-primary text-primary-foreground'
                      : isDone
                        ? 'bg-primary/20 text-primary'
                        : 'bg-secondary text-muted-foreground',
                  )}
                >
                  {isDone ? <CheckIcon aria-hidden /> : index + 1}
                </span>
                <span className="whitespace-nowrap font-medium">{step.label}</span>
              </button>
            </li>
          );
        })}
      </ol>
      <div
        className="h-1 w-full overflow-hidden rounded-full bg-secondary"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-label="Overall progress"
      >
        <div
          className="h-full rounded-full bg-primary transition-[width] duration-300 ease-emphasized"
          style={{ width: `${percent}%` }}
        />
      </div>
    </nav>
  );
}
