/**
 * The shared look of a dashboard board's on-tile control buttons (issue #441).
 *
 * The board carries two clusters of small icon buttons while it is being customised — the
 * `BoardMoveButtons` arrows and the `BoardSizeButtons` size picker. They sit side by side, so
 * they have to look like one control; keeping the class string in one place is what makes that
 * true by construction rather than by two lists staying in step.
 */

/** Wrapper for a cluster of board control buttons. */
export const BOARD_CONTROL_CLUSTER = 'flex items-center gap-0.5';

/** One board control button: quiet by default, with the app's focus ring and disabled treatment. */
export const BOARD_CONTROL_BUTTON = [
  'rounded-md p-1 text-muted-foreground transition-colors',
  'hover:bg-muted hover:text-foreground',
  'focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
  'disabled:pointer-events-none disabled:opacity-40',
].join(' ');
