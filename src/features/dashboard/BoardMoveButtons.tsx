/**
 * BoardMoveButtons — the touch-and-click move controls for a dashboard board's edit mode.
 *
 * Native drag works for a mouse but not a finger, and the arrow-key path needs a keyboard — so on
 * a touchscreen (the app's primary hardware) neither reaches a tile. This is the explicit,
 * always-tappable counterpart: a compact ▲▼◀▶ cluster that nudges a tile one step, reusing the
 * board's existing pure move op (issue #11). It's the accessible sibling of the pointer drag —
 * fully keyboard- and screen-reader-operable, each button carrying a translated `aria-label`, and
 * disabled (never just absent) at the edges so the affordance stays discoverable.
 */
import { cn } from '@/lib/utils';
import { ChevronDownIcon, ChevronLeftIcon, ChevronRightIcon, ChevronUpIcon } from '@/components/icons';

export type MoveDir = 'up' | 'down' | 'left' | 'right';

const ICONS: Record<MoveDir, typeof ChevronUpIcon> = {
  up: ChevronUpIcon,
  down: ChevronDownIcon,
  left: ChevronLeftIcon,
  right: ChevronRightIcon,
};

const ORDER: readonly MoveDir[] = ['up', 'down', 'left', 'right'];

export function BoardMoveButtons({
  onMove,
  disabled,
  labels,
  testIdPrefix,
  className,
}: {
  readonly onMove: (dir: MoveDir) => void;
  /** Whether each direction is at an edge (a no-op) and should render disabled. */
  readonly disabled: Record<MoveDir, boolean>;
  /** Translated accessible name for each direction's button. */
  readonly labels: Record<MoveDir, string>;
  /** `data-testid` stem — each button is `${testIdPrefix}-${dir}`. */
  readonly testIdPrefix: string;
  readonly className?: string;
}) {
  return (
    <div className={cn('flex items-center gap-0.5', className)}>
      {ORDER.map((dir) => {
        const Icon = ICONS[dir];
        return (
          <button
            key={dir}
            type="button"
            onClick={() => onMove(dir)}
            disabled={disabled[dir]}
            aria-label={labels[dir]}
            data-testid={`${testIdPrefix}-${dir}`}
            className={cn(
              'rounded-md p-1 text-muted-foreground transition-colors [&_svg]:size-4',
              'hover:bg-muted hover:text-foreground',
              'focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
              'disabled:pointer-events-none disabled:opacity-40',
            )}
          >
            <Icon aria-hidden />
          </button>
        );
      })}
    </div>
  );
}
