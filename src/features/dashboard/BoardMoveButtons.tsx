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
import { BOARD_CONTROL_BUTTON, BOARD_CONTROL_CLUSTER } from './board-control-button';

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
    <div className={cn(BOARD_CONTROL_CLUSTER, className)}>
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
            className={cn(BOARD_CONTROL_BUTTON, '[&_svg]:size-4')}
          >
            <Icon aria-hidden />
          </button>
        );
      })}
    </div>
  );
}
