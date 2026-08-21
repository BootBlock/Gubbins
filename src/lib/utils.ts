import { clsx, type ClassValue } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

/**
 * The safe-area spacing scale (`styles/index.css`), declared to tailwind-merge.
 *
 * tailwind-merge resolves a conflict by recognising the *value* half of a utility, so a class
 * built from a project token — `max-h-safe-dialog`, `px-safe-gutter-x` — looks like a foreign
 * class to it and no longer conflicts with the caller's `max-h-[80vh]` or `px-6`. Both then
 * survive `cn`, and the one the stylesheet happens to emit later wins: an override that is
 * silently ignored rather than applied. Naming the scale here restores the ordinary
 * last-one-wins behaviour every Foundry primitive documents for its `className` prop.
 */
const SAFE_AREA_SPACING = [
  // Kept in step with the stylesheet by `src/lib/safe-area-token.test.ts`.
  'safe-top',
  'safe-bottom',
  'safe-left',
  'safe-right',
  'safe-gutter-top',
  'safe-gutter-bottom',
  'safe-gutter-left',
  'safe-gutter-right',
  'safe-gutter-x',
  'safe-gutter-x-lg',
  'safe-page-top',
  'safe-page-bottom',
  'safe-dialog',
];

const twMerge = extendTailwindMerge({ extend: { theme: { spacing: SAFE_AREA_SPACING } } });

/**
 * Merge conditional class lists and resolve Tailwind utility conflicts.
 *
 * The canonical shadcn/ui helper — kept at `@/lib/utils` so primitives added via
 * the shadcn CLI into components/foundry resolve their `cn` import unchanged
 * (spec §2.4.1).
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
