/**
 * The shared visual language for a Foundry text control (spec §2.4.1) — border, surface,
 * typography, focus ring and disabled treatment, all from design tokens.
 *
 * It lives in its own module because more than one control wears it: the one-line
 * {@link Input}/{@link Checkbox} family in `input.tsx` and the multi-line {@link Textarea}
 * in `textarea.tsx`. Keeping it here means neither file has to import the other just to
 * borrow a class string.
 *
 * The `h-10` is the one-liner height; a control that sizes itself differently (the textarea)
 * overrides it, which `cn`'s Tailwind merge resolves in favour of the later class.
 */
export const fieldClasses =
  'h-10 w-full rounded-lg border border-border bg-input/40 px-3 text-sm text-foreground shadow-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-50';
