import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

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
