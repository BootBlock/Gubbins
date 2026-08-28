/**
 * BoardSizeButtons — the size picker on a dashboard tile while the board is being customised
 * (issue #441).
 *
 * A card can span one or two cells in each direction, and the sizes are offered as explicit
 * buttons rather than a corner drag grip: a grip needs a pointer and a steady hand, and this
 * app's primary hardware is a touchscreen. Each button is a real button carrying a translated
 * `aria-label` and `aria-pressed`, and a size the card cannot take (it would overlap a
 * neighbour) renders disabled rather than absent, so the affordance stays
 * discoverable — the same rules {@link BoardMoveButtons} follows for moving. Shift with the
 * arrow keys on the focused tile does the same thing from a physical keyboard.
 */
import { cn } from '@/lib/utils';
import { MAX_WIDGET_HEIGHT, MAX_WIDGET_WIDTH, WIDGET_SIZE_OPTIONS } from './dashboard-layout';
import { BOARD_CONTROL_BUTTON, BOARD_CONTROL_CLUSTER } from './board-control-button';

/** `${w}x${h}` — the key a caller uses for this size's label and disabled flag. */
export function sizeKey(w: number, h: number): string {
  return `${w}x${h}`;
}

/**
 * A miniature of the board showing which cells this size covers: a `MAX_WIDGET_WIDTH ×
 * MAX_WIDGET_HEIGHT` grid with the covered cells filled. Purely decorative — the button's
 * `aria-label` carries the meaning.
 */
function SizeGlyph({ w, h }: { readonly w: number; readonly h: number }) {
  return (
    <span
      aria-hidden
      className="grid size-3.5 gap-px"
      style={{
        gridTemplateColumns: `repeat(${MAX_WIDGET_WIDTH}, 1fr)`,
        gridTemplateRows: `repeat(${MAX_WIDGET_HEIGHT}, 1fr)`,
      }}
    >
      {Array.from({ length: MAX_WIDGET_WIDTH * MAX_WIDGET_HEIGHT }, (_, i) => {
        const covered = i % MAX_WIDGET_WIDTH < w && Math.floor(i / MAX_WIDGET_WIDTH) < h;
        return (
          <span key={i} className={cn('rounded-[1px] bg-current', covered ? 'opacity-100' : 'opacity-25')} />
        );
      })}
    </span>
  );
}

export function BoardSizeButtons({
  size,
  onResize,
  disabled,
  labels,
  testIdPrefix,
  className,
}: {
  /** The card's current span — its button reads as pressed. */
  readonly size: { readonly w: number; readonly h: number };
  readonly onResize: (w: number, h: number) => void;
  /** Which sizes are refused (they would overlap a neighbour), keyed by {@link sizeKey}. */
  readonly disabled: Readonly<Record<string, boolean>>;
  /** Translated accessible name for each size's button, keyed by {@link sizeKey}. */
  readonly labels: Readonly<Record<string, string>>;
  /** `data-testid` stem — each button is `${testIdPrefix}-${w}x${h}`. */
  readonly testIdPrefix: string;
  readonly className?: string;
}) {
  return (
    <div className={cn(BOARD_CONTROL_CLUSTER, className)}>
      {WIDGET_SIZE_OPTIONS.map(({ w, h }) => {
        const key = sizeKey(w, h);
        const current = size.w === w && size.h === h;
        return (
          <button
            key={key}
            type="button"
            onClick={() => onResize(w, h)}
            disabled={disabled[key] ?? false}
            aria-pressed={current}
            aria-label={labels[key]}
            data-testid={`${testIdPrefix}-${key}`}
            className={cn(BOARD_CONTROL_BUTTON, current && 'bg-muted text-primary')}
          >
            <SizeGlyph w={w} h={h} />
          </button>
        );
      })}
    </div>
  );
}
