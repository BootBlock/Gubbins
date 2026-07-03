import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { Surface } from '@/components/foundry';
import { CheckIcon, CopyIcon, ErrorIcon, type LucideIcon } from '@/components/icons';

/**
 * Shared, guide-local building blocks for the Home Assistant setup walkthrough.
 *
 * These are the two interactive primitives every step reuses: {@link ChoiceCards} (the
 * branching "which path applies to you?" selector) and {@link CommandBlock} (a copy-to-
 * clipboard command / config snippet). Keeping them here — rather than promoting them to the
 * Foundry — scopes them to this seldom-used, lazily-loaded feature so they add nothing to the
 * app's core bundle.
 */

// --- Branching choice selector --------------------------------------------------

export interface Choice<T extends string> {
  readonly id: T;
  readonly title: string;
  readonly description?: string;
  readonly Icon?: LucideIcon;
}

/**
 * An accessible single-select card group (WAI-ARIA radiogroup) used to branch the guide on a
 * user's situation or the outcome they got. Follows the app's roving-`tabindex` radiogroup
 * pattern: the group is a single tab stop; arrow keys move *and* select; Home/End jump to the
 * ends. Selecting a card reveals that branch's tailored guidance below (the caller renders it).
 */
export function ChoiceCards<T extends string>({
  legend,
  options,
  value,
  onChange,
  columns = 2,
}: {
  /** Visible question naming the group (rendered as the fieldset legend). */
  readonly legend: ReactNode;
  readonly options: readonly Choice<T>[];
  readonly value: T | null;
  readonly onChange: (id: T) => void;
  /** Preferred column count at wide widths (collapses to one column on narrow screens). */
  readonly columns?: 2 | 3;
}) {
  const legendId = useId();
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const selectedIndex = options.findIndex((o) => o.id === value);

  const selectAt = (index: number) => {
    const next = ((index % options.length) + options.length) % options.length;
    onChange(options[next]!.id);
    refs.current[next]?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        event.preventDefault();
        selectAt(index + 1);
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        event.preventDefault();
        selectAt(index - 1);
        break;
      case 'Home':
        event.preventDefault();
        selectAt(0);
        break;
      case 'End':
        event.preventDefault();
        selectAt(options.length - 1);
        break;
      case ' ':
      case 'Enter':
        event.preventDefault();
        selectAt(index);
        break;
    }
  };

  return (
    <div>
      <p id={legendId} className="mb-2 text-sm font-medium text-foreground">
        {legend}
      </p>
      <div
        role="radiogroup"
        aria-labelledby={legendId}
        className={cn('grid gap-3', columns === 3 ? 'sm:grid-cols-3' : 'sm:grid-cols-2')}
      >
        {options.map((option, index) => {
          const checked = option.id === value;
          // Before any selection, the first card is the roving-tabindex entry point.
          const tabIndex = checked || (selectedIndex < 0 && index === 0) ? 0 : -1;
          return (
            <button
              key={option.id}
              ref={(el) => {
                refs.current[index] = el;
              }}
              type="button"
              role="radio"
              aria-checked={checked}
              tabIndex={tabIndex}
              onClick={() => selectAt(index)}
              onKeyDown={(e) => onKeyDown(e, index)}
              className={cn(
                'flex h-full items-start gap-3 rounded-xl border p-3 text-left outline-none transition-colors ease-emphasized',
                'focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
                checked
                  ? 'border-primary bg-primary/10'
                  : 'border-border bg-card/30 hover:border-border hover:bg-secondary/50',
              )}
            >
              {option.Icon ? (
                <span
                  className={cn(
                    'mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg [&_svg]:size-4',
                    checked ? 'bg-primary/20 text-primary' : 'bg-secondary/70 text-muted-foreground',
                  )}
                >
                  <option.Icon aria-hidden />
                </span>
              ) : null}
              <span className="min-w-0 flex-1">
                <span
                  className={cn(
                    'block text-sm font-medium',
                    checked ? 'text-foreground' : 'text-foreground/90',
                  )}
                >
                  {option.title}
                </span>
                {option.description ? (
                  <span className="mt-0.5 block text-xs text-muted-foreground">{option.description}</span>
                ) : null}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// --- Copy-to-clipboard command / config block -----------------------------------

/** Copy `text` to the clipboard, resolving to whether it succeeded (never throws). */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * A monospace command / configuration snippet with a copy button. Used for shell commands,
 * `.env` lines and YAML the user must paste into Home Assistant. `label` names what the block
 * is (announced to assistive tech and shown as a small caption); `language` is a hint shown in
 * the caption only. The copy button reports success/failure inline and politely.
 */
export function CommandBlock({
  code,
  label,
  caption,
}: {
  readonly code: string;
  /** Accessible name for the copy button, e.g. "shell command" or "configuration.yaml snippet". */
  readonly label: string;
  /** Optional small caption above the block (e.g. a filename or where it goes). */
  readonly caption?: ReactNode;
}) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');

  const onCopy = async () => {
    const ok = await copyText(code);
    setState(ok ? 'copied' : 'failed');
    window.setTimeout(() => setState('idle'), 2000);
  };

  return (
    <figure className="space-y-1">
      {caption ? <figcaption className="text-xs text-muted-foreground">{caption}</figcaption> : null}
      <div className="relative">
        <pre className="overflow-x-auto rounded-lg border border-border bg-secondary/40 py-3 pl-3 pr-14 font-mono text-xs leading-relaxed text-foreground">
          <code>{code}</code>
        </pre>
        <button
          type="button"
          onClick={onCopy}
          aria-label={state === 'copied' ? `Copied ${label}` : `Copy ${label}`}
          className={cn(
            'absolute right-2 top-2 grid size-8 place-items-center rounded-md border border-border bg-card/80 outline-none transition-colors ease-emphasized [&_svg]:size-4',
            'hover:bg-secondary focus-visible:ring-2 focus-visible:ring-ring',
            state === 'copied' && 'text-glyph-success',
            state === 'failed' && 'text-glyph-danger',
          )}
        >
          {state === 'copied' ? (
            <CheckIcon aria-hidden />
          ) : state === 'failed' ? (
            <ErrorIcon aria-hidden />
          ) : (
            <CopyIcon aria-hidden />
          )}
        </button>
      </div>
      {/* Politely announce the copy outcome without stealing focus. */}
      <span aria-live="polite" className="sr-only">
        {state === 'copied'
          ? `${label} copied to the clipboard.`
          : state === 'failed'
            ? `Could not copy ${label}.`
            : ''}
      </span>
    </figure>
  );
}

// --- Small layout helpers -------------------------------------------------------

/**
 * A revealed branch panel: the tailored guidance shown once a {@link ChoiceCards} selection is
 * made. Indented and rule-marked so it reads as "because you chose X, do this".
 */
export function BranchPanel({ children }: { readonly children: ReactNode }) {
  return <div className="animate-rise space-y-4 border-l-2 border-primary/40 pl-4">{children}</div>;
}

/** A titled content card for a step's body sections. */
export function StepCard({
  title,
  icon,
  children,
}: {
  readonly title?: ReactNode;
  readonly icon?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <Surface className="space-y-4 bg-card/20 p-5">
      {title ? (
        <div className="flex items-center gap-2.5 text-muted-foreground [&_svg]:size-4">
          {icon}
          <h3 className="text-sm font-semibold text-foreground">{title}</h3>
        </div>
      ) : null}
      {children}
    </Surface>
  );
}
